// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

function handler(event) {
    var request = event.request;
    var originalImagePath = request.uri;
    //  validate, process and normalize the requested operations in query parameters
    var normalizedOperations = {};
    if (request.querystring) {
        Object.keys(request.querystring).forEach(operation => {
            switch (operation.toLowerCase()) {
                case 'from_bucket':
                    var fromBucket = request.querystring[operation]['value'];
                    normalizedOperations['fromBucket'] = fromBucket;
                    break;
                case 'to_bucket':
                    var toBucket = request.querystring[operation]['value'];
                    normalizedOperations['toBucket'] = toBucket;
                    break;
                case 'to_bucket_path':
                    var toBucketPath = encodeURIComponent(request.querystring[operation]['value']);
                    normalizedOperations['toBucketPath'] = toBucketPath;
                    break;
                case 'to_bucket_region':
                    var toBucketRegion = request.querystring[operation]['value'];
                    normalizedOperations['toBucketRegion'] = toBucketRegion;
                    break;
                case 'ratio':
                    var ratio = request.querystring[operation]['value'].toLowerCase();
                    normalizedOperations['ratio'] = ratio;
                    break;
                case 'format': 
                    var SUPPORTED_FORMATS = ['auto', 'jpeg', 'webp', 'avif', 'png', 'svg', 'gif'];
                    if (request.querystring[operation]['value'] && SUPPORTED_FORMATS.includes(request.querystring[operation]['value'].toLowerCase())) {
                        var format = request.querystring[operation]['value'].toLowerCase(); // normalize to lowercase
                        if (format === 'auto') {
                            if (originalImagePath.split('.').pop().toLowerCase() === 'png') {
                                format = 'png';
                            } else {
                                format = 'jpeg';
                            }
                            if (request.headers['accept']) {
                                if (request.headers['accept'].value.includes("webp")) { // for now prefere use webp over avif - really faster !
                                    format = 'webp';
                                } else if (request.headers['accept'].value.includes("avif")) {
                                    format = 'avif';
                                } 
                            }
                        }
                        normalizedOperations['format'] = format;
                    }
                    break;
                case 'width':
                    if (request.querystring[operation]['value']) {
                        var width = parseInt(request.querystring[operation]['value']);
                        if (!isNaN(width) && (width > 0)) {
                            // you can protect the Lambda function by setting a max value, e.g. if (width > 4000) width = 4000;
                            normalizedOperations['width'] = width.toString();
                        }
                    }
                    break;
                case 'height':
                    if (request.querystring[operation]['value']) {
                        var height = parseInt(request.querystring[operation]['value']);
                        if (!isNaN(height) && (height > 0)) {
                            // you can protect the Lambda function by setting a max value, e.g. if (height > 4000) height = 4000;
                            normalizedOperations['height'] = height.toString();
                        }
                    }
                    break;
                case 'quality':
                    if (request.querystring[operation]['value']) {
                        var quality = parseInt(request.querystring[operation]['value']);
                        if (!isNaN(quality) && (quality > 0)) {
                            if (quality > 100) quality = 100;
                            normalizedOperations['quality'] = quality.toString();
                        }
                    }
                    break;
                default: break;
            }
        });
        //rewrite the path to normalized version if valid operations are found
        if (Object.keys(normalizedOperations).length > 0) {
            // put them in order
            var normalizedOperationsArray = [];
            if (normalizedOperations.fromBucket) normalizedOperationsArray.push('fromBucket='+normalizedOperations.fromBucket);
            if (normalizedOperations.toBucket) normalizedOperationsArray.push('toBucket='+normalizedOperations.toBucket);
            if (normalizedOperations.toBucketRegion) normalizedOperationsArray.push('toBucketRegion='+normalizedOperations.toBucketRegion);
            if (normalizedOperations.ratio) normalizedOperationsArray.push('ratio='+normalizedOperations.ratio);
            if (normalizedOperations.format) normalizedOperationsArray.push('format='+normalizedOperations.format);
            if (normalizedOperations.quality) normalizedOperationsArray.push('quality='+normalizedOperations.quality);
            if (normalizedOperations.width) normalizedOperationsArray.push('width='+normalizedOperations.width);
            if (normalizedOperations.height) normalizedOperationsArray.push('height='+normalizedOperations.height);
            if (normalizedOperations.toBucketPath) normalizedOperationsArray.push('toBucketPath='+normalizedOperations.toBucketPath);

            if (normalizedOperations.ratio || normalizedOperations.format || normalizedOperations.quality || normalizedOperations.width || normalizedOperations.height) {
                request.uri = originalImagePath + '/' + normalizedOperationsArray.join(',');   
            } else {
                request.uri = originalImagePath + '/original,' + normalizedOperationsArray.join(',');     
            }
        } else {
            // If no valid operation is found, flag the request with /original path suffix
            request.uri = originalImagePath + '/original';     
        }

    } else {
        // If no query strings are found, flag the request with /original path suffix
        request.uri = originalImagePath + '/original'; 
    }
    // remove query strings
    request['querystring'] = {};
    return request;
}
