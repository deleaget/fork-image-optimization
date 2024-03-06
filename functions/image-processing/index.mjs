// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetObjectCommand, PutObjectCommand, S3Client, ObjectCannedACL } from "@aws-sdk/client-s3";
import Sharp from 'sharp';

const s3Client = new S3Client();
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const SECRET_KEY = process.env.secretKey;
const MAX_IMAGE_SIZE = parseInt(process.env.maxImageSize);

export const handler = async (event) => {
    // First validate if the request is coming from CloudFront
    if (!event.headers['x-origin-secret-header'] || !(event.headers['x-origin-secret-header'] === SECRET_KEY)) return sendError(403, 'Request unauthorized', null);
    // Validate if this is a GET request
    if (!event.requestContext || !event.requestContext.http || !(event.requestContext.http.method === 'GET')) return sendError(400, 'Bad Request', null);
    // An example of expected path is /images/rio/1.jpeg/format=auto,width=100 or /images/rio/1.jpeg/original where /images/rio/1.jpeg is the path of the original image
    var imagePathArray = event.requestContext.http.path.split('/');
    // get the requested image operations
    var operationsPrefix = imagePathArray.pop();
    // get the original image path images/rio/1.jpg
    imagePathArray.shift();
    var originalImagePath = imagePathArray.join('/');
    // execute the requested operations 
    const operationsJSON = Object.fromEntries(operationsPrefix.split(',').map(operation => operation.split('=')));
    // get the original image bucket
    var originalBucket = operationsJSON['fromBucket']
    var transformedBucket = operationsJSON['toBucket']
    var transformedBucketRegion = operationsJSON['toBucketRegion']
    // initialize default response object (original image)
    var response = { bucket: originalBucket, key: originalImagePath, transformed: false };

    var timingLog = '';
    var startTime = performance.now();
    // Downloading original image
    let originalImageBody;
    let contentType;

    if (!transformedBucket) {
        var error_message = 'Transformed bucket not found !';
        response['error'] = error_message;

        logError(error_message, null);
        return sendError(500, response, timingLog);
    }

    try {
        const getOriginalImageCommand = new GetObjectCommand({ Bucket: originalBucket, Key: originalImagePath });
        const getOriginalImageCommandOutput = await s3Client.send(getOriginalImageCommand);
        console.log(`Got response from S3 for ${originalImagePath}`);

        originalImageBody = getOriginalImageCommandOutput.Body.transformToByteArray();
        contentType = getOriginalImageCommandOutput.ContentType;
    } catch (error) {
        var error_message = 'Unexpected error during original image downloading';
        response['error'] = error_message;
        timingLog = 'img-download;dur=' + parseInt(performance.now() - startTime);
        
        logError(error_message, error);
        return sendError(500, response, timingLog);
    }
    let transformedImage = Sharp(await originalImageBody, { failOn: 'none', animated: true });
    // Get image orientation to rotate if needed
    const imageMetadata = await transformedImage.metadata();
    // variable holding the server timing header value
    timingLog = 'img-download;dur=' + parseInt(performance.now() - startTime);
    startTime = performance.now();

    try {
        // check if resizing is requested
        var resizingOptions = {};
        if (operationsJSON['width']) resizingOptions.width = parseInt(operationsJSON['width']);
        if (operationsJSON['height']) resizingOptions.height = parseInt(operationsJSON['height']);
        if (resizingOptions) transformedImage = transformedImage.resize(resizingOptions);
        // check if rotation is needed
        if (imageMetadata.orientation) transformedImage = transformedImage.rotate();
        // check if formatting is requested
        if (operationsJSON['format']) {
            var isLossy = false;
            switch (operationsJSON['format']) {
                case 'jpeg': contentType = 'image/jpeg'; isLossy = true; break;
                case 'gif': contentType = 'image/gif'; break;
                case 'webp': contentType = 'image/webp'; isLossy = true; break;
                case 'png': contentType = 'image/png'; break;
                case 'avif': contentType = 'image/avif'; isLossy = true; break;
                default: contentType = 'image/jpeg'; isLossy = true;
            }
            if (operationsJSON['quality'] && isLossy) {
                transformedImage = transformedImage.toFormat(operationsJSON['format'], {
                    quality: parseInt(operationsJSON['quality']),
                });
            } else transformedImage = transformedImage.toFormat(operationsJSON['format']);
        }
        transformedImage = await transformedImage.toBuffer();
        timingLog = timingLog + ',img-transform;dur=' + parseInt(performance.now() - startTime);
    } catch (error) {
        var error_message = 'Unexpected error during image transformation';
        response['error'] = error_message;
        timingLog = timingLog + ',img-transform;dur=' + parseInt(performance.now() - startTime);
        
        logError(error_message, error);
        return sendError(500, response, timingLog);
    }

    // handle gracefully generated images bigger than a specified limit (e.g. Lambda output object limit)
    var transformedImageByteLength = Buffer.byteLength(transformedImage);
    const imageTooBig = transformedImageByteLength > MAX_IMAGE_SIZE;

    // upload transformed image back to S3 if required in the architecture
    if (transformedBucket && !imageTooBig) {
        startTime = performance.now();
        var picturePath = operationsJSON;
        delete picturePath["fromBucket"];
        delete picturePath["toBucket"];
        delete picturePath["toBucketRegion"];
        var key = originalImagePath + '/' + picturePath
        try {
            const putImageCommand = new PutObjectCommand({
                Body: transformedImage,
                Bucket: transformedBucket,
                Key: key,
                ContentType: contentType,
                Metadata: {
                    'cache-control': TRANSFORMED_IMAGE_CACHE_TTL,
                },
                ACL: ObjectCannedACL.public_read,
            })
            var regionalS3Client = s3Client;
            if (transformedBucketRegion) {
                regionalS3Client = new S3Client({ region: transformedBucketRegion });
            }
            await regionalS3Client.send(putImageCommand);
            timingLog = timingLog + ',img-upload;dur=' + parseInt(performance.now() - startTime);
            response = { bucket: transformedBucket, key: key, transformed: true }
        } catch (error) {
            var error_message = 'Could not upload transformed image in S3 bucket : ' + transformedBucket + ', region : ' + (transformedBucketRegion == null ? "default" : transformedBucketRegion.toString()) + ', key :' + key;
            response['error'] = error_message;
            timingLog = timingLog + ',img-upload;dur=' + parseInt(performance.now() - startTime);
            
            logError(error_message, error);
            return sendError(500, response, timingLog);
        }
    }

    // Return a 413 Content Too Large error if the transformed image is too big with the original image as response, else return transformed image
    if (imageTooBig) {
        var error_message = 'Requested transformed image is too big. (max: ' + MAX_IMAGE_SIZE + ' bytes, actual: ' + transformedImageByteLength + ' bytes)';
        response['error'] = error_message;

        logError(error_message, null);
        return sendError(413, response, timingLog);
    } else return {
        statusCode: 200,
        body: response,
        headers: {
            'Content-Type': 'application/json',
            'Server-Timing': timingLog
        }
    };
};

function sendError(statusCode, body, timingLog) {
    var json_body = {};
    if (typeof body === 'object') json_body = body;
    else json_body = { error: body };

    return { 
        statusCode: statusCode, 
        body: json_body,
        headers: {
            'Content-Type': 'application/json',
            'Server-Timing': timingLog
        } 
    };
}

function logError(error_message, error) {
    console.log('APPLICATION ERROR', error_message);
    if (error !== null) console.log(error);
}