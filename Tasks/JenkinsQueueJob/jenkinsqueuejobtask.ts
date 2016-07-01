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

// capturePipeline is only possible if captureConsole mode is enabled
var capturePipeline = captureConsole ? tl.getBoolInput('capturePipeline', true) : false;

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

class Job {
    state: string;
    executableUrl: string;
    executableNumber: number;
    name: string;
    jobConsole: string;
    jobConsoleOffset : number;
    resultCode: string;
    constructor(executableUrl: string, executableNumber: number, name: string){
        this.executableUrl = executableUrl;
        this.executableNumber = executableNumber;
        this.name = name;
        this.jobConsoleOffset = 0;
        this.state = 'running';
    }

    consoleLog(message : string){
        console.log(message);
        this.jobConsole += message;
    }

    setResult(resultCode: string){
        this.state = 'done';
        this.resultCode = resultCode.toUpperCase();
    }

    getCompletionMessage() : string{
        return 'Jenkins job: ' + this.getResultString() + ' ' + this.name + ' ' + this.executableUrl;
    }

    getSummaryTitle(){
        return 'Jenkins ' + this.name + ' - ' + this.executableNumber + ' - ' + this.getResultString();
    }

    getResultString(): string {
        if(this.state == 'running'){
            return 'Queued'; 
        }

        // codes map to fields in http://hudson-ci.org/javadoc/hudson/model/Result.html
        if (this.resultCode == 'SUCCESS') {
            return 'Success';
        } else if (this.resultCode == 'UNSTABLE') {
            return 'Unstable';
        } else if (this.resultCode == 'FAILURE') {
            return 'Failure';
        } else if (this.resultCode == 'NOT_BUILT') {
            return 'Not built';
        } else if (this.resultCode == 'ABORTED') {
            return 'Aborted';
        } else {
            return this.resultCode;
        }
    }

    getTaskResult() : number{
        if(this.state == 'running'){
            return tl.TaskResult.Succeeded;
        } else if (this.resultCode == "SUCCESS" || this.resultCode == 'UNSTABLE') {
            return tl.TaskResult.Succeeded;
        } else {
            return tl.TaskResult.Failed;
        }
    }
}

var activeJobs : Job[] = [];

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
                var job: Job = new Job(parsedBody.executable.url, parsedBody.executable.number,  parsedBody.task.name);
                activeJobs.push(job);
                console.log('Jenkins job started: ' + job.executableUrl);

                if (captureConsole) {
                    // start capturing console
                    captureJenkinsConsole(job);
                } else {
                    // no console option, just create link and finish
                    createLinkAndFinish(job);
                }
            }
        }
    });
}

function createLinkAndFinish(job : Job) {
    var tempDir = shell.tempdir();
    var linkMarkdownFile = path.join(tempDir, 'JenkinsJob_' + job.name + '_' + job.executableNumber + '.md');
    tl.debug('jenkinsLink: ' + linkMarkdownFile);
    var summaryTitle = job.getSummaryTitle()
    tl.debug('summaryTitle: ' + summaryTitle);
    var markdownContents = '[' + job.executableUrl + '](' + job.executableUrl + ')';
    fs.writeFile(linkMarkdownFile, markdownContents, function callBack(err) {
        if (err) {
            //don't fail the build -- there just won't be a link
            console.log('Error creating link to Jenkins job: ' + err);
        } else {
            console.log('##vso[task.addattachment type=Distributedtask.Core.Summary;name=' + summaryTitle + ';]' + linkMarkdownFile);
        }
        tl.setResult(job.getTaskResult(), job.getCompletionMessage());
    });
}

function captureJenkinsConsole(job: Job) {
    var fullUrl = job.executableUrl + '/logText/progressiveText/?start=' + job.jobConsoleOffset;
    tl.debug('Tracking progress of job URL: ' + fullUrl);
    request.get({ url: fullUrl }, function callBack(err, httpResponse, body) {
        if (err) {
            tl.setResult(tl.TaskResult.Failed, err);
        } else if (httpResponse.statusCode != 200) {
            failReturnCode(httpResponse, 'Job progress tracking failed to read job progress');
        } else {
            job.consoleLog(body); // redirect Jenkins console to task console
            var xMoreData = httpResponse.headers['x-more-data'];
            if (xMoreData && xMoreData == 'true') {
                var offset = httpResponse.headers['x-text-size'];
                job.jobConsoleOffset = offset;
                // job still running so keep logging console
                setTimeout(function () {
                    captureJenkinsConsole(job);
                }, captureConsolePollInterval);
            } else { // job is done -- did it succeed or not?
                checkSuccess(job);
            }
        }
    });
}

function checkSuccess(job: Job) {
    var resultUrl = job.executableUrl + 'api/json';
    tl.debug('Tracking completion status of job: ' + resultUrl);
    request.get({ url: resultUrl }, function callBack(err, httpResponse, body) {
        if (err) {
            tl.setResult(tl.TaskResult.Failed, err);
        } else if (httpResponse.statusCode != 200) {
            failReturnCode(httpResponse, 'Job progress tracking failed to read job result');
        } else {
            var parsedBody = JSON.parse(body);
            tl.debug("parsedBody for: "+resultUrl+ "\n" +JSON.stringify(parsedBody));
            var resultCode = parsedBody.result;
            if (resultCode) {
                job.setResult(resultCode);
                createLinkAndFinish(job);
            } else {
                // result not updated yet -- keep trying
                setTimeout(function () {
                    checkSuccess(job);
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