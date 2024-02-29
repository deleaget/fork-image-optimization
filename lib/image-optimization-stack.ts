// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Fn, Stack, StackProps, RemovalPolicy, aws_s3 as s3, aws_s3_deployment as s3deploy, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_lambda as lambda, aws_iam as iam, Duration, CfnOutput, aws_logs as logs } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { getOriginShieldRegion } from './origin-shield';
import { createHash } from 'crypto';

// Stack Parameters

// related to architecture. If set to false, transformed images are not stored in S3, and all image requests land on Lambda
var STORE_TRANSFORMED_IMAGES = 'true';
// Parameters of S3 bucket where original images are stored
var S3_IMAGE_BUCKET_NAME: string;
var S3_TRANSFORMED_IMAGE_BUCKET_NAME: string;
var S3_REUSED_TRANSFORMED_IMAGE_BUCKET_NAME: string;
// CloudFront parameters
var CLOUDFRONT_ORIGIN_SHIELD_REGION = getOriginShieldRegion(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1');
var CLOUDFRONT_CORS_ENABLED = 'true';
// Parameters of transformed images
var S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = '90';
var S3_TRANSFORMED_IMAGE_CACHE_TTL = 'max-age=31622400';
// Max image size in bytes. If generated images are stored on S3, bigger images are generated, stored on S3
// and request is redirect to the generated image. Otherwise, an application error is sent.
var MAX_IMAGE_SIZE = '4700000';
// Lambda Parameters
var LAMBDA_MEMORY = '1500';
var LAMBDA_TIMEOUT = '60';
// Whether to deploy a sample website referenced in https://aws.amazon.com/blogs/networking-and-content-delivery/image-optimization-using-amazon-cloudfront-and-aws-lambda/
var DEPLOY_SAMPLE_WEBSITE = 'false';


type ImageDeliveryCacheBehaviorConfig = {
  origin: any;
  viewerProtocolPolicy: any;
  cachePolicy: any;
  functionAssociations: any;
  responseHeadersPolicy?: any;
};

type LambdaEnv = {
  originalImageBucketName: string,
  transformedImageBucketName?: any;
  transformedImageCacheTTL: string,
  secretKey: string,
  maxImageSize: string,
}

export class ImageOptimizationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Change stack parameters based on provided context
    STORE_TRANSFORMED_IMAGES = this.node.tryGetContext('STORE_TRANSFORMED_IMAGES') || STORE_TRANSFORMED_IMAGES;
    S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION') || S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION;
    S3_TRANSFORMED_IMAGE_CACHE_TTL = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_CACHE_TTL') || S3_TRANSFORMED_IMAGE_CACHE_TTL;
    S3_IMAGE_BUCKET_NAME = this.node.tryGetContext('S3_IMAGE_BUCKET_NAME') || S3_IMAGE_BUCKET_NAME;
    S3_TRANSFORMED_IMAGE_BUCKET_NAME = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_BUCKET_NAME') || S3_TRANSFORMED_IMAGE_BUCKET_NAME;
    S3_REUSED_TRANSFORMED_IMAGE_BUCKET_NAME = this.node.tryGetContext('S3_REUSED_TRANSFORMED_IMAGE_BUCKET_NAME') || S3_REUSED_TRANSFORMED_IMAGE_BUCKET_NAME;
    CLOUDFRONT_ORIGIN_SHIELD_REGION = this.node.tryGetContext('CLOUDFRONT_ORIGIN_SHIELD_REGION') || CLOUDFRONT_ORIGIN_SHIELD_REGION;
    CLOUDFRONT_CORS_ENABLED = this.node.tryGetContext('CLOUDFRONT_CORS_ENABLED') || CLOUDFRONT_CORS_ENABLED;
    LAMBDA_MEMORY = this.node.tryGetContext('LAMBDA_MEMORY') || LAMBDA_MEMORY;
    LAMBDA_TIMEOUT = this.node.tryGetContext('LAMBDA_TIMEOUT') || LAMBDA_TIMEOUT;
    MAX_IMAGE_SIZE = this.node.tryGetContext('MAX_IMAGE_SIZE') || MAX_IMAGE_SIZE;
    DEPLOY_SAMPLE_WEBSITE = this.node.tryGetContext('DEPLOY_SAMPLE_WEBSITE') || DEPLOY_SAMPLE_WEBSITE;
    
    // Create secret key to be used between CloudFront and Lambda URL for access control
    const SECRET_KEY = createHash('md5').update(this.node.addr).digest('hex');

    // deploy a sample website for testing if required
    if (DEPLOY_SAMPLE_WEBSITE === 'true') {
      var sampleWebsiteBucket = new s3.Bucket(this, 's3-sample-website-bucket', {
        removalPolicy: RemovalPolicy.DESTROY,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        autoDeleteObjects: true,
      });

      var sampleWebsiteDelivery = new cloudfront.Distribution(this, 'websiteDeliveryDistribution', {
        comment: 'image optimization - sample website',
        defaultRootObject: 'index.html',
        defaultBehavior: {
          origin: new origins.S3Origin(sampleWebsiteBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        }
      });

      new CfnOutput(this, 'SampleWebsiteDomain', {
        description: 'Sample website domain',
        value: sampleWebsiteDelivery.distributionDomainName
      });
      new CfnOutput(this, 'SampleWebsiteS3Bucket', {
        description: 'S3 bucket use by the sample website',
        value: sampleWebsiteBucket.bucketName
      });
    }

    // For the bucket having original images, either use an external one, or create one with some samples photos.
    var originalImageBucket;
    var transformedImageBucket;
    
    if (S3_IMAGE_BUCKET_NAME) {
      originalImageBucket = s3.Bucket.fromBucketName(this, 'imported-original-image-bucket', S3_IMAGE_BUCKET_NAME);
      new CfnOutput(this, 'OriginalImagesS3Bucket', {
        description: 'S3 bucket where original images are stored',
        value: originalImageBucket.bucketName
      });
    } else {
      originalImageBucket = new s3.Bucket(this, 's3-sample-original-image-bucket', {
        removalPolicy: RemovalPolicy.DESTROY,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        autoDeleteObjects: true,
      });
      new s3deploy.BucketDeployment(this, 'DeployWebsite', {
        sources: [s3deploy.Source.asset('./image-sample')],
        destinationBucket: originalImageBucket,
        destinationKeyPrefix: 'images/rio/',
      });
      new CfnOutput(this, 'OriginalImagesS3Bucket', {
        description: 'S3 bucket where original images are stored',
        value: originalImageBucket.bucketName
      });
    }

    if (S3_TRANSFORMED_IMAGE_BUCKET_NAME) {
      // create bucket for transformed images if enabled in the architecture
      transformedImageBucket = new s3.Bucket(this, 's3-transformed-image-bucket', {
        bucketName: S3_TRANSFORMED_IMAGE_BUCKET_NAME,
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        lifecycleRules: [
          {
            expiration: Duration.days(parseInt(S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION)),
          },
        ],
        blockPublicAccess: {
          blockPublicAcls: false,
          blockPublicPolicy: false,
          ignorePublicAcls: false,
          restrictPublicBuckets: false,
        },
        accessControl: s3.BucketAccessControl.PRIVATE,
        objectOwnership: s3.ObjectOwnership.OBJECT_WRITER
      });

      // IAM policy to read from the S3 bucket containing the transformed images
      transformedImageBucket.addToResourcePolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          effect: iam.Effect.ALLOW,
          principals: [new iam.StarPrincipal()],
          resources: [transformedImageBucket.arnForObjects('*')],
        })
      )
    } else if (S3_REUSED_TRANSFORMED_IMAGE_BUCKET_NAME) {
      transformedImageBucket = s3.Bucket.fromBucketName(this, 's3-transformed-image-bucket', S3_REUSED_TRANSFORMED_IMAGE_BUCKET_NAME);
    }

    // prepare env variable for Lambda 
    var lambdaEnv: LambdaEnv = {
      originalImageBucketName: originalImageBucket.bucketName,
      transformedImageCacheTTL: S3_TRANSFORMED_IMAGE_CACHE_TTL,
      secretKey: SECRET_KEY,
      maxImageSize: MAX_IMAGE_SIZE,
    };
    if (transformedImageBucket) lambdaEnv.transformedImageBucketName = transformedImageBucket.bucketName;

    // IAM policy to read from the S3 bucket containing the original images
    const s3ReadOriginalImagesPolicy = new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [originalImageBucket.arnForObjects('*')],
    });

    // statements of the IAM policy to attach to Lambda
    var iamPolicyStatements = [s3ReadOriginalImagesPolicy];

    // Create Lambda for image processing
    var lambdaProps = {
      functionName: 'ImgTransformationFunction',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-processing'),
      timeout: Duration.seconds(parseInt(LAMBDA_TIMEOUT)),
      memorySize: parseInt(LAMBDA_MEMORY),
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_DAY,
    };
    var imageProcessing = new lambda.Function(this, 'image-optimization', lambdaProps);

    // Enable Lambda URL
    const imageProcessingURL = imageProcessing.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // Leverage CDK Intrinsics to get the hostname of the Lambda URL 
    const imageProcessingDomainName = Fn.parseDomainName(imageProcessingURL.url);

    // Create a CloudFront origin: S3 with fallback to Lambda when image needs to be transformed, otherwise with Lambda as sole origin
    var imageOrigin;

    if (transformedImageBucket) {
      imageOrigin = new origins.OriginGroup({
        primaryOrigin: new origins.S3Origin(transformedImageBucket, {
          originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
        }),
        fallbackOrigin: new origins.HttpOrigin(imageProcessingDomainName, {
          originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
          customHeaders: {
            'x-origin-secret-header': SECRET_KEY,
          },
        }),
        fallbackStatusCodes: [403, 500, 503, 504],
      });

      // write policy for Lambda on the s3 bucket for transformed images
      var s3WriteTransformedImagesPolicy = new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: ['arn:aws:s3:::' + transformedImageBucket.bucketName + '/*'],
      });
      var s3WriteTransformedImagesPolicyAcl = new iam.PolicyStatement({
        actions: ['s3:PutObjectAcl'],
        resources: ['arn:aws:s3:::' + transformedImageBucket.bucketName + '/*'],
      });
      iamPolicyStatements.push(s3WriteTransformedImagesPolicy);
      iamPolicyStatements.push(s3WriteTransformedImagesPolicyAcl);
    } else {
      console.log("else transformedImageBucket");
      imageOrigin = new origins.HttpOrigin(imageProcessingDomainName, {
        originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION,
        customHeaders: {
          'x-origin-secret-header': SECRET_KEY,
        },
      });
    }

    // attach iam policy to the role assumed by Lambda
    imageProcessing.role?.attachInlinePolicy(
      new iam.Policy(this, 'read-write-bucket-policy', {
        statements: iamPolicyStatements,
      }),
    );

    // Create a CloudFront Function for url rewrites
    const urlRewriteFunction = new cloudfront.Function(this, 'urlRewrite', {
      code: cloudfront.FunctionCode.fromFile({ filePath: 'functions/url-rewrite/index.js', }),
      functionName: `urlRewriteFunction${this.node.addr}`,
    });

    var imageDeliveryCacheBehaviorConfig: ImageDeliveryCacheBehaviorConfig = {
      origin: imageOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: new cloudfront.CachePolicy(this, `ImageCachePolicy${this.node.addr}`, {
        defaultTtl: Duration.hours(24),
        maxTtl: Duration.days(365),
        minTtl: Duration.seconds(0),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.all()
      }),
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: urlRewriteFunction,
      }],
    }

    if (CLOUDFRONT_CORS_ENABLED === 'true') {
      // Creating a custom response headers policy. CORS allowed for all origins.
      const imageResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, `ResponseHeadersPolicy${this.node.addr}`, {
        responseHeadersPolicyName: 'ImageResponsePolicy',
        corsBehavior: {
          accessControlAllowCredentials: false,
          accessControlAllowHeaders: ['*'],
          accessControlAllowMethods: ['GET'],
          accessControlAllowOrigins: ['*'],
          accessControlMaxAge: Duration.seconds(600),
          originOverride: false,
        },
        // recognizing image requests that were processed by this solution
        customHeadersBehavior: {
          customHeaders: [
            { header: 'x-aws-image-optimization', value: 'v1.0', override: true },
            { header: 'vary', value: 'accept', override: true },
          ],
        }
      });
      imageDeliveryCacheBehaviorConfig.responseHeadersPolicy = imageResponseHeadersPolicy;
    }
    const imageDelivery = new cloudfront.Distribution(this, 'imageDeliveryDistribution', {
      comment: 'Okast image optimization - image delivery with url rewrite.',
      defaultBehavior: imageDeliveryCacheBehaviorConfig
    });

    new CfnOutput(this, 'ImageDeliveryDomain', {
      description: 'Domain name of image delivery',
      value: imageDelivery.distributionDomainName
    });
  }
}