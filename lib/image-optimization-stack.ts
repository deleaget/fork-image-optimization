// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Fn, Stack, StackProps, RemovalPolicy, aws_s3 as s3, aws_s3_deployment as s3deploy, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_lambda as lambda, aws_iam as iam, Duration, CfnOutput, aws_logs as logs } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { createHash } from 'crypto';

// Stack Parameters

// related to architecture. If set to false, transformed images are not stored in S3, and all image requests land on Lambda
var STORE_TRANSFORMED_IMAGES = 'true';
// Parameters of S3 bucket where original images are stored
var S3_IMAGE_BUCKETS_NAMES: string[];
var S3_TRANSFORMED_IMAGE_BUCKETS_NAMES: string[];
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


type ImageDeliveryCacheBehaviorConfig = {
  origin: any;
  viewerProtocolPolicy: any;
  cachePolicy: any;
  functionAssociations: any;
  responseHeadersPolicy?: any;
};

type LambdaEnv = {
  originalImageBucketName?: string,
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
    S3_IMAGE_BUCKETS_NAMES = this.node.tryGetContext('S3_IMAGE_BUCKETS_NAMES')?.valueAsList;
    S3_TRANSFORMED_IMAGE_BUCKETS_NAMES = this.node.tryGetContext('S3_TRANSFORMED_IMAGE_BUCKETS_NAMES')?.valueAsList;
    CLOUDFRONT_CORS_ENABLED = this.node.tryGetContext('CLOUDFRONT_CORS_ENABLED') || CLOUDFRONT_CORS_ENABLED;
    LAMBDA_MEMORY = this.node.tryGetContext('LAMBDA_MEMORY') || LAMBDA_MEMORY;
    LAMBDA_TIMEOUT = this.node.tryGetContext('LAMBDA_TIMEOUT') || LAMBDA_TIMEOUT;
    MAX_IMAGE_SIZE = this.node.tryGetContext('MAX_IMAGE_SIZE') || MAX_IMAGE_SIZE;
    
    // Create secret key to be used between CloudFront and Lambda URL for access control
    const SECRET_KEY = createHash('md5').update(this.node.addr).digest('hex');

    
    new CfnOutput(this, 'ListOriginalImagesS3BucketsParameter', {
      description: 'S3 buckets where original images are stored',
      value: S3_IMAGE_BUCKETS_NAMES?.toString()
    });
    new CfnOutput(this, 'ListTransformedImagesS3BucketsParameter', {
      description: 'S3 buckets where transformed images are saved',
      value: S3_TRANSFORMED_IMAGE_BUCKETS_NAMES?.toString()
    });
    
    // IAM policy to read from the S3 bucket containing the original images
    // statements of the IAM policy to attach to Lambda
    var iamPolicyStatements = Array<iam.PolicyStatement>();

    S3_IMAGE_BUCKETS_NAMES.forEach(originalBucketName => {
      iamPolicyStatements.push(
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [s3.Bucket.fromBucketName(this, 'imported-original-image-bucket', originalBucketName).arnForObjects('*')],
        })
      );
    });

    // prepare env variable for Lambda 
    var lambdaEnv: LambdaEnv = {
      transformedImageCacheTTL: S3_TRANSFORMED_IMAGE_CACHE_TTL,
      secretKey: SECRET_KEY,
      maxImageSize: MAX_IMAGE_SIZE,
    };

    // Create Lambda for image processing
    var lambdaProps = {
      functionName: 'ImgTransformationFunction',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-processing'),
      timeout: Duration.seconds(parseInt(LAMBDA_TIMEOUT)),
      memorySize: parseInt(LAMBDA_MEMORY),
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.THREE_DAYS,
    };
    var imageProcessing = new lambda.Function(this, 'image-optimization', lambdaProps);

    // write policy for Lambda on the s3 bucket for transformed images
    S3_TRANSFORMED_IMAGE_BUCKETS_NAMES.forEach(transformedBucketName => {
      iamPolicyStatements.push(
        new iam.PolicyStatement({
          actions: ['s3:PutObject'],
          resources: [s3.Bucket.fromBucketName(this, 'transformed-image-bucket', transformedBucketName).arnForObjects('*')],
        })
      );
      iamPolicyStatements.push(
        new iam.PolicyStatement({
          actions: ['s3:PutObjectAcl'],
          resources: [s3.Bucket.fromBucketName(this, 'transformed-image-bucket', transformedBucketName).arnForObjects('*')],
        })
      );
    });

    // attach iam policy to the role assumed by Lambda
    imageProcessing.role?.attachInlinePolicy(
      new iam.Policy(this, 'read-write-bucket-policy', {
        statements: iamPolicyStatements,
      }),
    );

    // Create a CloudFront Function for url rewrites
    const urlRewriteFunction = new cloudfront.Function(this, 'urlRewrite', {
      code: cloudfront.FunctionCode.fromFile({ filePath: 'functions/url-rewrite/index.js', }),
      functionName: `urlRewriteFunctionImageOptimization`,
    });

    var cloudCachePolicy = new cloudfront.CachePolicy(this, `ImageCachePolicyImageOptimization`, {
      defaultTtl: Duration.hours(24),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(0),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all()
    });

     // Enable Lambda URL
     const imageProcessingURL = imageProcessing.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // Leverage CDK Intrinsics to get the hostname of the Lambda URL 
    const imageProcessingDomainName = Fn.parseDomainName(imageProcessingURL.url);
    
    var defaultImageDeliveryCacheBehaviorConfig: ImageDeliveryCacheBehaviorConfig = {
      origin: new origins.HttpOrigin(imageProcessingDomainName, {
        customHeaders: {
          'x-origin-secret-header': SECRET_KEY,
        },
      }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudCachePolicy,
      functionAssociations: [{
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: urlRewriteFunction,
      }],
    }

    const imageDelivery = new cloudfront.Distribution(this, 'imageDeliveryDistribution', {
      comment: 'Okast image optimization - image delivery with url rewrite.',
      defaultBehavior: defaultImageDeliveryCacheBehaviorConfig
    });

    new CfnOutput(this, 'ImageDeliveryDomain', {
      description: 'Domain name of image delivery',
      value: imageDelivery.distributionDomainName
    });
  }
}