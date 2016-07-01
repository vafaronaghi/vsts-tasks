// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

/// <reference path="../../definitions/node.d.ts"/>
/// <reference path="../../definitions/vsts-task-lib.d.ts" />
/// <reference path="../../definitions/shelljs.d.ts"/>

import tl = require('vsts-task-lib/task');
import fs = require('fs');
import path = require('path');
import shell = require('shelljs');

// node js modules
var request = require('request');

var serverEndpoint = tl.getInput('serverEndpoint', true);
var serverEndpointUrl = tl.getEndpointUrl(serverEndpoint, false);
tl.debug('serverEndpointUrl=' + serverEndpointUrl);

var serverEndpointAuth = tl.getEndpointAuthorization(serverEndpoint, false);
var username = serverEndpointAuth['parameters']['username'];
var password = serverEndpointAuth['parameters']['password'];

var jobName = tl.getInput('jobName', true);

var captureConsole = tl.getBoolInput('captureConsole', true);
var captureConsolePollInterval = 5000; // five seconds is what the Jenkins Web UI uses

var parameterizedJob = tl.getBoolInput('parameterizedJob', true);

var jobQueueUrl = serverEndpointUrl + '/job/' + jobName
jobQueueUrl += (parameterizedJob) ? '/buildWithParameters?delay=0sec' : '/build?delay=0sec';
tl.debug('jobQueueUrl=' + jobQueueUrl);

function failReturnCode(httpResponse, message: string): void {
    var fullMessage = message +
        '\nHttpResponse.statusCode=' + httpResponse.statusCode +
        '\nHttpResponse.statusMessage=' + httpResponse.statusMessage +
        '\nHttpResponse=\n' + JSON.stringify(httpResponse);
    fail(fullMessage);
}

function fail(message: string): void {
    tl.debug(message);
    tl.setResult(tl.TaskResult.Failed, message);
}

// These are set once the job is successfully queued and don't change afterwards
var jenkinsTaskName;
var jenkinsExecutableNumber
var jenkinsExecutableUrl;

function trackJobQueued(queueUri: string) {
    tl.debug('Tracking progress of job queue: ' + queueUri);
    request.get({ url: queueUri }, function callBack(err, httpResponse, body) {
        if (err) {
            tl.setResult(tl.TaskResult.Failed, err);
        } else if (httpResponse.statusCode != 200) {
            failReturnCode(httpResponse, 'Job progress tracking failed to read job queue');
        } else {
            var parsedBody = JSON.parse(body);
            // canceled is spelled wrong in the body with 2 Ls (checking correct spelling also in case they fix it)
            if (parsedBody.cancelled || parsedBody.canceled) {
                tl.setResult(tl.TaskResult.Failed, 'Jenkins job canceled.');
            }
            var executable = parsedBody.executable;
            if (!executable) {
                // job has not actually been queued yet, keep checking
                setTimeout(function () {
                    trackJobQueued(queueUri);
                }, captureConsolePollInterval);
            } else {
                jenkinsTaskName = parsedBody.task.name;
                jenkinsExecutableNumber = parsedBody.executable.number;
                jenkinsExecutableUrl = parsedBody.executable.url;
                console.log('Jenkins job started: ' + jenkinsExecutableUrl);

                if (captureConsole) {
                    // start capturing console
                    captureJenkinsConsole(0);
                } else {
                    // no console option, just create link and finish
                    createLinkAndFinish(tl.TaskResult.Succeeded, 'Queued', 'Jenkins job successfully queued: ' + jenkinsExecutableUrl);
                }
            }
        }
    });
}

function createLinkAndFinish(result, jobStatus: string, resultMessage: string) {
    var tempDir = shell.tempdir();
    var linkMarkdownFile = path.join(tempDir, 'JenkinsJob_' + jenkinsTaskName + '_' + jenkinsExecutableNumber + '.md');
    tl.debug('jenkinsLink: ' + linkMarkdownFile);
    var summaryTitle = 'Jenkins ' + jenkinsTaskName + ' - ' + jenkinsExecutableNumber + ' - ' + jobStatus;
    tl.debug('summaryTitle: ' + summaryTitle);
    var markdownContents = '[' + jenkinsExecutableUrl + '](' + jenkinsExecutableUrl + ')';
    fs.writeFile(linkMarkdownFile, markdownContents, function callBack(err) {
        if (err) {
            //don't fail the build -- there just won't be a link
            console.log('Error creating link to Jenkins job: ' + err);
        } else {
            console.log('##vso[task.addattachment type=Distributedtask.Core.Summary;name=' + summaryTitle + ';]' + linkMarkdownFile);
        }
        tl.setResult(result, resultMessage);
    });
}

function captureJenkinsConsole(consoleOffset: number) {
    var fullUrl = jenkinsExecutableUrl + '/logText/progressiveText/?start=' + consoleOffset;
    tl.debug('Tracking progress of job URL: ' + fullUrl);
    request.get({ url: fullUrl }, function callBack(err, httpResponse, body) {
        if (err) {
            tl.setResult(tl.TaskResult.Failed, err);
        } else if (httpResponse.statusCode != 200) {
            failReturnCode(httpResponse, 'Job progress tracking failed to read job progress');
        } else {
            console.log(body); // redirect Jenkins console to task console
            var xMoreData = httpResponse.headers['x-more-data'];
            if (xMoreData && xMoreData == 'true') {
                var offset = httpResponse.headers['x-text-size'];
                // job still running so keep logging console
                setTimeout(function () {
                    captureJenkinsConsole(offset);
                }, captureConsolePollInterval);
            } else { // job is done -- did it succeed or not?
                checkSuccess();
            }
        }
    });
}

function getResultString(resultCode: string): string {
    // codes map to fields in http://hudson-ci.org/javadoc/hudson/model/Result.html
    resultCode = resultCode.toUpperCase();
    if (resultCode == 'SUCCESS') {
        return 'Success';
    } else if (resultCode == 'UNSTABLE') {
        return 'Unstable';
    } else if (resultCode == 'FAILURE') {
        return 'Failure';
    } else if (resultCode == 'NOT_BUILT') {
        return 'Not built';
    } else if (resultCode == 'ABORTED') {
        return 'Aborted';
    } else {
        return resultCode;
    }
}

function checkSuccess() {
    var resultUrl = jenkinsExecutableUrl + 'api/json';
    tl.debug('Tracking completion status of job: ' + resultUrl);
    request.get({ url: resultUrl }, function callBack(err, httpResponse, body) {
        if (err) {
            tl.setResult(tl.TaskResult.Failed, err);
        } else if (httpResponse.statusCode != 200) {
            failReturnCode(httpResponse, 'Job progress tracking failed to read job result');
        } else {
            var parsedBody = JSON.parse(body);
            var resultCode = parsedBody.result;
            if (resultCode) {
                resultCode = resultCode.toUpperCase();
                var resultStr = getResultString(resultCode);
                tl.debug(resultUrl + ' resultCode: ' + resultCode + ' resultStr: ' + resultStr);
                tl.debug("parsedBody for: "+resultUrl+ "\n" +JSON.stringify(parsedBody));
                var completionMessage = 'Jenkins job: ' + resultCode + ' ' + jobName + ' ' + jenkinsExecutableUrl;
                if (resultCode == "SUCCESS" || resultCode == 'UNSTABLE') {
                    createLinkAndFinish(tl.TaskResult.Succeeded, resultStr, completionMessage);
                } else {
                    createLinkAndFinish(tl.TaskResult.Failed, resultStr, completionMessage);
                }
            } else {
                // result not updated yet -- keep trying
                setTimeout(function () {
                    checkSuccess();
                }, captureConsolePollInterval);
            }
        }
    });
}

/**
 * Supported parameter types: boolean, string, choice, password
 * 
 * - If a parameter is not defined by Jenkins it is fine to pass it anyway
 * - Anything passed to a boolean parameter other than 'true' (case insenstive) becomes false.
 * - Invalid choice parameters result in a 500 response.
 * 
 */
function parseJobParameters() {
    var formData = {};
    var jobParameters: string[] = tl.getDelimitedInput('jobParameters', '\n', false);
    for(var i =0; i< jobParameters.length; i++){
        var paramLine = jobParameters[i];
        var splitIndex = paramLine.indexOf('=');
        if(splitIndex <= 0){ // either no paramValue (-1), or no paramName (0)
            fail('Job parameters should be specified as "parameterName=parameterValue" with one name, value pair per line. Invalid parameter line: '+paramLine);
        }
        var paramName = paramLine.substr(0, splitIndex);
        var paramValue = paramLine.slice(splitIndex+1);
        formData[paramName] = paramValue;
    }
    return formData;
}

var initialPostData = parameterizedJob ?
    { url: jobQueueUrl, formData: parseJobParameters() } :
    { url: jobQueueUrl };

tl.debug('initialPostData = ' + JSON.stringify(initialPostData));

/**
 * This post starts the process by kicking off the job and then: 
 *    |
 *    |---------------            
 *    V              | not queued yet            
 * trackJobQueued() --  
 *    |
 * captureConsole --no--> createLinkAndFinish()   
 *    |
 *    |----------------------
 *    V                     | more stuff in console  
 * captureJenkinsConsole() --    
 *    |
 *    |-------------
 *    V            | keep checking until something
 * checkSuccess() -- 
 *    |
 *    V
 * createLinkAndFinish()
 */
request.post(initialPostData, function optionalCallback(err, httpResponse, body) {
    if (err) {
        tl.setResult(tl.TaskResult.Failed, err);
    } else if (httpResponse.statusCode != 201) {
        failReturnCode(httpResponse, 'Job creation failed.');
    } else {
        console.log('Jenkins job queued');
        var queueUri = httpResponse.headers.location + 'api/json';
        trackJobQueued(queueUri);
    }
}).auth(username, password, true);