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

var jobQueueUrl = addUrlSegment(serverEndpointUrl, '/job/' + jobName);
jobQueueUrl += (parameterizedJob) ? '/buildWithParameters?delay=0sec' : '/build?delay=0sec';
tl.debug('jobQueueUrl=' + jobQueueUrl);

function addUrlSegment(baseUrl: string, segment: string): string {
    var resultUrl = null;
    if (baseUrl.endsWith('/') && segment.startsWith('/')) {
        resultUrl = baseUrl + segment.slice(1);
    } else if (baseUrl.endsWith('/') || segment.startsWith('/')) {
        resultUrl = baseUrl + segment;
    } else {
        resultUrl = baseUrl + '/' + segment;
    }
    //console.log('addUrlSegment baseUrl: ' + baseUrl + ' segment: ' + segment + ' resultUrl: ' + resultUrl);
    return resultUrl;
}

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
    parentJob: Job; // if this job is a pipelined job, its parent that started it.
    joinedJob: Job // if this job is joined, the main job that is running
    initialSearchBuildNumber: number; // the intial, most likely build number for child jobs

    /**
     * running -> done              :normal path for root level job
     * unknown -> running -> done   :normal path for pipelined job
     * unknown -> joined            :alternate path for pipelined job (when several jobs kick off the same job that has not yet been queued)
     * unknown -> lost              :when a pipelined job can not be found after searching.
     */
    state: string;
    taskUrl: string; // URL for the job definition
    executableUrl: string; // URL for the executing job instance
    executableNumber: number;
    name: string;
    jobConsole: string = "";
    jobConsoleOffset: number = 0;
    jobConsoleEnabled: boolean = false;

    doneJson;
    resultCode: string;

    constructor(parent: Job, taskUrl: string, executableUrl: string, executableNumber: number, name: string) {
        this.parentJob = parent;
        this.taskUrl = taskUrl;
        this.executableUrl = executableUrl;
        this.executableNumber = executableNumber;
        this.name = name;
        executableUrl != null ? this.setRunning(executableNumber) : this.setUnknown();
        if (parent == null) {
            // no parent means this is the root job, so queue the console.
            this.enableConsoleLog();
        }
    }

    toString() {
        var fullMessage = 'Job: ' + this.name + ':' + this.executableNumber + ', parentJob:(';
        if (this.parentJob == null) {
            fullMessage += 'none)';
        } else {
            fullMessage += this.parentJob + ')';
        }
        if (this.joinedJob != null) {
            fullMessage += ', joinedJob:(' + this.joinedJob + ')';
        }

        fullMessage += ' state: ' + this.state;
        return fullMessage;
    }

    debug(message: string) {
        var fullMessage = toString() + ' debug: ' + message;
        tl.debug(fullMessage);
    }

    enableConsoleLog() {
        if (!this.jobConsoleEnabled) {
            if (this.jobConsole != "") { // log any queue output
                console.log(this.jobConsole);
            }
            this.jobConsoleEnabled = true;
        }
    }

    consoleLog(message: string) {
        if (this.jobConsoleEnabled) {
            //only log it if the console is enabled.
            console.log(message);
        }
        this.jobConsole += message;
    }

    setUnknown() {
        this.state = 'unknown';
    }

    isUnknown(): boolean {
        return this.state == 'unknown';
    }

    setRunning(executableNumber: number): void {
        this.executableNumber = executableNumber;
        this.executableUrl = addUrlSegment(this.taskUrl, this.executableNumber.toString());
        var debugPreviousState = this.state;
        this.state = 'running';
        this.debug(' state changed from: ' + debugPreviousState);

        captureJenkinsConsole(this);
        this.consoleLog('******************************************************************************\n');
        this.consoleLog('Jenkins job started: ' + this.name + '\n');
        this.consoleLog(this.executableUrl + '\n');
        this.consoleLog('******************************************************************************\n');
    }

    isRunning(): boolean {
        return this.state == 'running';
    }

    setDone(doneJson) {
        var debugPreviousState = this.state;
        this.state = 'done';
        this.debug(' state changed from: ' + debugPreviousState);

        this.doneJson = doneJson;
        this.consoleLog('******************************************************************************\n');
        this.consoleLog('Jenkins job finished: ' + this.name + '\n');
        this.consoleLog(this.executableUrl + '\n');
        this.consoleLog('******************************************************************************\n');
    }

    isDone(): boolean {
        return this.state == 'done';
    }

    setJoined(joinedJob: Job): void {
        this.joinedJob = joinedJob;
        var debugPreviousState = this.state;
        this.state = 'joined';
        this.debug(' state changed from: ' + debugPreviousState);
    }

    isJoined(): boolean {
        return this.state == 'joined';
    }

    isActive(): boolean {
        return this.isUnknown() || this.isRunning();
    }

    getCompletionMessage(): string {
        return 'Jenkins job: ' + this.getResultString() + ' ' + this.name + ' ' + this.executableUrl;
    }

    getSummaryTitle() {
        return 'Jenkins ' + this.name + ' - ' + this.executableNumber + ' - ' + this.getResultString();
    }

    getResultString(): string {
        if (this.state == 'running') {
            return 'Queued';
        } else if (this.state == 'done') {
            var resultCode = this.doneJson.result.toUpperCase();
            // codes map to fields in http://hudson-ci.org/javadoc/hudson/model/Result.html
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
        } else return 'Unknown';
    }

    getTaskResult(): number {
        if (this.state == 'running') {
            return tl.TaskResult.Succeeded;
        } else if (this.state == 'done') {
            var resultCode = this.doneJson.result.toUpperCase();
            //console.log('resultCode='+resultCode);
            if (resultCode == "SUCCESS" || this.resultCode == 'UNSTABLE') {
                return tl.TaskResult.Succeeded;
            } else {
                return tl.TaskResult.Failed;
            }
        }
        return tl.TaskResult.Failed;
    }

    getJobTask(getTaskCallback) {
        var apiTaskUrl = addUrlSegment(this.taskUrl, "/api/json");
        this.debug('getting job task URL:' + apiTaskUrl);
        return request.get({ url: apiTaskUrl }, function requestCallBack(err, httpResponse, body) {
            if (err) {
                tl.setResult(tl.TaskResult.Failed, err);
            } else if (httpResponse.statusCode != 200) {
                failReturnCode(httpResponse, 'Unable to retrieve job: ' + this.name);
            } else {
                var parsedBody = JSON.parse(body);
                this.debug("parsedBody for: " + apiTaskUrl + ": " + JSON.stringify(parsedBody));
                getTaskCallback(parsedBody);
            }
        });
    }
}

var jobs: Job[] = [];

function countRemainingJobs(): number {
    var count: number = 0;
    for (var i = 0; i < jobs.length; i++) {
        if (jobs[i].isActive()) {
            count++;
        }
    }
    return count;
}

function flushJobConsolesIfDone(): void {
    for (var i = 0; i < jobs.length; i++) {
        if (jobs[i].state == 'done') {
            jobs[i].enableConsoleLog();
        }
    }
}

/**
 * Finds the job associated with the name and executableNumber
 */
function findJob(name: string, executableNumber: number): Job {
    for (var j in jobs) {
        var job = jobs[j];
        if (job.name == name && job.executableNumber == executableNumber) {
            return job;
        }
    }
    return null;
}

function joinJobs(parentJob: Job, joinToJob: Job) : void {
    for (var i in jobs) {
        var job = jobs[i];
        if (job.parentJob == parentJob && job != joinToJob) {
            job.setJoined(joinToJob);
        }
    }
}

function trackJobQueued(queueUri: string) {
    tl.debug('Tracking progress of job queue: ' + queueUri);
    request.get({ url: queueUri }, function callBack(err, httpResponse, body) {
        if (err) {
            tl.setResult(tl.TaskResult.Failed, err);
        } else if (httpResponse.statusCode != 200) {
            failReturnCode(httpResponse, 'Job progress tracking failed to read job queue');
        } else {
            var parsedBody = JSON.parse(body);
            tl.debug("parsedBody for: " + queueUri + ": " + JSON.stringify(parsedBody));

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
                var job: Job = new Job(null, parsedBody.task.url, parsedBody.executable.url, parsedBody.executable.number, parsedBody.task.name);
                jobs.push(job);
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

function createLinkAndFinish(job: Job) {
    var tempDir = shell.tempdir();
    var linkMarkdownFile = path.join(tempDir, 'JenkinsJob_' + job.name + '_' + job.executableNumber + '.md');
    job.debug('jenkinsLink: ' + linkMarkdownFile);
    var summaryTitle = job.getSummaryTitle()
    job.debug('summaryTitle: ' + summaryTitle);
    var markdownContents = '[' + job.executableUrl + '](' + job.executableUrl + ')';

    fs.writeFile(linkMarkdownFile, markdownContents, function callBack(err) {
        if (err) {
            //don't fail the build -- there just won't be a link
            job.consoleLog('Error creating link to Jenkins job: ' + err);
        } else {
            job.consoleLog('##vso[task.addattachment type=Distributedtask.Core.Summary;name=' + summaryTitle + ';]' + linkMarkdownFile);
        }
        //if capturing the pipeline and this job succeeded, search for downstream jobs 
        if (capturePipeline && job.getTaskResult() == tl.TaskResult.Succeeded) {
            queueDownStreamJobs(job);
        } else {
            tl.setResult(job.getTaskResult(), job.getCompletionMessage());
        }
    });
}

function queueDownStreamJobs(job: Job) {
    job.getJobTask(function callBack(parsedBody) {
        var downstreamProjects = parsedBody.downstreamProjects;

        var enableConsole = false;
        if (countRemainingJobs() == 0) {
            flushJobConsolesIfDone();
            if (downstreamProjects.length == 1) {
                enableConsole = true;
            }
        }

        // each of these runs in parallel
        downstreamProjects.forEach((project) => {
            var child: Job = new Job(job, project.url, null, -1, project.name);
            jobs.push(child);
            if (enableConsole) {
                child.enableConsoleLog();
            }
            locateChildExecution(child);
        })
    });
}

function locateChildExecution(job: Job) {
    job.getJobTask(function callBack(parsedBody) {
        if (parsedBody.inQueue) { // if it's in the queue, start checking with the next build number
            job.initialSearchBuildNumber = parsedBody.nextBuildNumber;
            console.log(job + 'in queue');
        } else { // otherwise, check with the last build number.
            job.initialSearchBuildNumber = parsedBody.lastBuild.number;
            console.log(job + 'not in queue');
        }
        locateChildExecutionBuildNumber(job, job.initialSearchBuildNumber, -1);
    });
}

/**
 * Search for a pipelined job starting with a best guess for the build number, and a direction to search.
 * First the search is done backwards and terminates when either finding the specified job, or the job's
 * timestamp is earlier than the timestamp of the parent job that queued it.  Then the restarts from the
 * intial start point and searches forward until the job is found, or a 404 is reached and no more jobs
 * are queued.  At any point, the search also ends if the job is joined to another job.
 */
function locateChildExecutionBuildNumber(job: Job, buildNumberToCheck: number, directionToSearch: number) {
    if (job.isJoined()) {
        //some other thread found and joined it.
        return;
    }
    var url = addUrlSegment(job.taskUrl, buildNumberToCheck + "/api/json");
    job.debug('pipeline, locating child execution URL:' + url);
    request.get({ url: url }, function callBack(err, httpResponse, body) {
        if (err) {
            tl.setResult(tl.TaskResult.Failed, err);
        } else if (httpResponse.statusCode == 404) {
            // This job doesn't exist -- do we expect it to in the near future because it has been queued?
            job.debug('404 for: ' + job.name + ':' + buildNumberToCheck + ' triggered by :' + job.parentJob.name + ':' + job.parentJob.doneJson.number);
            job.debug('checking if it is in the queue');
            job.getJobTask(function callback(parsedJobTaskBody) {
                if (parsedJobTaskBody.inQueue || parsedJobTaskBody.lastCompletedBuild >= buildNumberToCheck) {
                    //see if it's in the queue, or maybe it just ran right after we first checked
                    job.debug('job has been queued, continue searching');
                    setTimeout(function () {
                        locateChildExecutionBuildNumber(job, buildNumberToCheck, directionToSearch);
                    }, captureConsolePollInterval);
                } else {
                    job.debug('job is not queued, end search');
                    console.log('Warning: Job: ' + job.name + " queued by Job: " + job.parentJob.name + ": " + job.parentJob.executableUrl + " can not be found.");
                }
            });
        } else if (httpResponse.statusCode != 200) {
            failReturnCode(httpResponse, 'Job pipeline tracking failed to read downstream project');
        } else {
            var parsedBody = JSON.parse(body);
            job.debug("parsedBody for: " + url + ": " + JSON.stringify(parsedBody));

            /**
             * This is the list of all reasons for this job execution to be running.  
             * Jenkins may 'join' several pipelined jobs so all will be listed here.
             * e.g. suppose A -> C and B -> C.  If both A & B scheduled C around the same time before C actually started, 
             * Jenkins will join these requests and only run C once.
             * So, for all jobs being tracked (within this code), the first one in the list is the one that is actually running,
             * all others are considered joined and will not be tracked further.
             */
            var causes = parsedBody.actions[0].causes;
            var cause = causes[0];
            var parentJob = findJob(cause.upstreamProject, cause.upstreamBuild);
            if (parentJob == job.parentJob) {
                // found it; mark it running, and start grabbing the console
                job.setRunning(buildNumberToCheck);
                // fall through the if, and join any other causes to this job
            }

            var joinedCauses = causes.length > 1 ? causes.slice(1) : [];
            for (var i in joinedCauses) { // iterate over all and join as many as possible.
                cause = joinedCauses[i];
                var parentJob = findJob(cause.upstreamProject, cause.upstreamBuild);
                joinJobs(parentJob, job);
            }

            if (job.isRunning() || job.isDone() || job.isJoined()) {
                //could have been started/finished above, or joined by another thread
                return;
            }

            // need to keep searching
            job.debug('Search failed for: ' + job.name + ':' + buildNumberToCheck + ' triggered by :' + job.parentJob.name + ':' + job.parentJob.doneJson.number);
            if (directionToSearch == -1) { // search backwards
                if (parsedBody.timestamp <= job.parentJob.doneJson.timestamp || buildNumberToCheck == 1) {
                    job.debug('changing search direction');
                    // we already searched backwards as far as possible, 
                    // so start searching forwards from the begining
                    locateChildExecutionBuildNumber(job, job.initialSearchBuildNumber + 1, 1);
                } else {
                    job.debug('searching back one');
                    // search backwards one
                    locateChildExecutionBuildNumber(job, buildNumberToCheck - 1, directionToSearch);
                }
            } else { // search forwards
                job.debug('searching forward one');
                locateChildExecutionBuildNumber(job, buildNumberToCheck + 1, directionToSearch);
            }
        }
    });
}

function captureJenkinsConsole(job: Job) {
    var fullUrl = addUrlSegment(job.executableUrl, '/logText/progressiveText/?start=' + job.jobConsoleOffset);
    job.debug('Tracking progress of job URL: ' + fullUrl);
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
    var resultUrl = addUrlSegment(job.executableUrl, 'api/json');
    job.debug('Tracking completion status of job: ' + resultUrl);
    request.get({ url: resultUrl }, function callBack(err, httpResponse, body) {
        if (err) {
            tl.setResult(tl.TaskResult.Failed, err);
        } else if (httpResponse.statusCode != 200) {
            failReturnCode(httpResponse, 'Job progress tracking failed to read job result');
        } else {
            var parsedBody = JSON.parse(body);
            job.debug("parsedBody for: " + resultUrl + ": " + JSON.stringify(parsedBody));
            if (parsedBody.result) {
                job.setDone(parsedBody);
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
    for (var i = 0; i < jobParameters.length; i++) {
        var paramLine = jobParameters[i];
        var splitIndex = paramLine.indexOf('=');
        if (splitIndex <= 0) { // either no paramValue (-1), or no paramName (0)
            fail('Job parameters should be specified as "parameterName=parameterValue" with one name, value pair per line. Invalid parameter line: ' + paramLine);
        }
        var paramName = paramLine.substr(0, splitIndex);
        var paramValue = paramLine.slice(splitIndex + 1);
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
        var queueUri = addUrlSegment(httpResponse.headers.location, 'api/json');
        trackJobQueued(queueUri);
    }
}).auth(username, password, true);