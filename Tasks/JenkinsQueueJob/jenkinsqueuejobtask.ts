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

function failError(err): void {
    fail(err);
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
    tl.exit(1);
}

enum JobState {
    New = 0,
    Locating = 1,
    LocatingNotFound = 2,
    Streaming = 3,
    Finishing = 4,
    Done = 5,
    Joined = 6,
    Queued = 7
}

class Job {
    parentJob: Job; // if this job is a pipelined job, its parent that started it.
    joinedJob: Job // if this job is joined, the main job that is running
    initialSearchBuildNumber: number; // the intial, most likely build number for child jobs
    nextSearchBuildNumber: number; // the next build number to check
    searchDirection: number = -1; // negative means search backwards, positive means search forwards

    /**
     * running -> done              :normal path for root level job
     * unknown -> running -> done   :normal path for pipelined job
     * unknown -> joined            :alternate path for pipelined job (when several jobs kick off the same job that has not yet been queued)
     * unknown -> lost              :when a pipelined job can not be found after searching.
     */
    state: JobState = JobState.New;
    taskUrl: string; // URL for the job definition
    executableUrl: string; // URL for the executing job instance
    executableNumber: number;
    name: string;
    jobConsole: string = "";
    jobConsoleOffset: number = 0;
    jobConsoleEnabled: boolean = false;

    working: boolean = false;
    workDelay: number = 0;

    parsedTaskBody; // set during state New
    parsedExecutionResult; // set during state Finishing

    constructor(parent: Job, taskUrl: string, executableUrl: string, executableNumber: number, name: string) {
        this.parentJob = parent;
        this.taskUrl = taskUrl;
        this.executableUrl = executableUrl;
        this.executableNumber = executableNumber;
        this.name = name;
        this.debug('created');
    }

    doWork() {
        if (this.working) { // return if already working
            this.debug('already working');
            return;
        } else {
            this.debug('starting work');
            this.working = true;
            if (this.state == JobState.New) {
                if (this.parentJob == null) { // root job, can skip Locating
                    if (captureConsole) {
                        this.enableConsoleLog();
                        this.setStreaming(this.executableNumber); // jump to Streaming
                    } else {
                        this.changeState(JobState.Queued); // also skip Streaming and jump to Queued
                    }
                } else {
                    this.changeState(JobState.Locating); // pipeline jobs
                }
                this.initializeNewJob();
            } else if (this.state == JobState.Locating || this.state == JobState.LocatingNotFound) {
                locateChildExecutionBuildNumber(this);
            } else if (JobState.Streaming == this.state) {
                streamConsole(this);
            } else if (JobState.Finishing == this.state) {
                checkSuccess(this);
            } else if (this.state == JobState.Done || this.state == JobState.Joined || this.state == JobState.Queued) {
                //should not be in here
                console.log(this + 'should not be in doWork()');
                this.working = false;
            }
        }
    }

    changeState(newState: JobState) {
        this.state = newState;
        this.debug('state changed');
    }

    getState(): JobState {
        return this.state;
    }

    isActive(): boolean {
        return this.state == JobState.New ||
            this.state == JobState.Locating ||
            this.state == JobState.Streaming ||
            this.state == JobState.Finishing
    }

    setStreaming(executableNumber: number): void {
        this.executableNumber = executableNumber;
        this.executableUrl = addUrlSegment(this.taskUrl, this.executableNumber.toString());
        this.changeState(JobState.Streaming);

        this.consoleLog('******************************************************************************\n');
        this.consoleLog('Jenkins job started: ' + this.name + '\n');
        this.consoleLog(this.executableUrl + '\n');
        this.consoleLog('******************************************************************************\n');
    }

    setParsedExecutionResult(parsedExecutionResult) {
        this.parsedExecutionResult = parsedExecutionResult;
        this.consoleLog('******************************************************************************\n');
        this.consoleLog('Jenkins job finished: ' + this.name + '\n');
        this.consoleLog(this.executableUrl + '\n');
        this.consoleLog('******************************************************************************\n');
    }

    setJoined(joinedJob: Job): void {
        this.joinedJob = joinedJob;
        this.changeState(JobState.Joined);
    }

    getCompletionMessage(): string {
        return 'Jenkins job: ' + this.getResultString() + ' ' + this.name + ' ' + this.executableUrl;
    }

    getSummaryTitle() {
        return 'Jenkins ' + this.name + ' - ' + this.executableNumber + ' - ' + this.getResultString();
    }

    getResultString(): string {
        if (this.state == JobState.Queued) {
            return 'Queued';
        } else if (this.state == JobState.Done) {
            var resultCode = this.parsedExecutionResult.result.toUpperCase();
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
        if (this.state == JobState.Queued) {
            return tl.TaskResult.Succeeded;
        } else if (this.state == JobState.Done) {
            var resultCode = this.parsedExecutionResult.result.toUpperCase();
            if (resultCode == "SUCCESS" || resultCode == 'UNSTABLE') {
                return tl.TaskResult.Succeeded;
            } else {
                return tl.TaskResult.Failed;
            }
        }
        return tl.TaskResult.Failed;
    }

    refreshJobTask(callback) {
        var apiTaskUrl = addUrlSegment(this.taskUrl, "/api/json");
        this.debug('getting job task URL:' + apiTaskUrl);
        return request.get({ url: apiTaskUrl }, function requestCallBack(err, httpResponse, body) {
            if (err) {
                failError(err);
            } else if (httpResponse.statusCode != 200) {
                failReturnCode(httpResponse, 'Unable to retrieve job: ' + this.name);
            } else {
                this.parsedTaskBody = JSON.parse(body);
                this.debug("parsedBody for: " + apiTaskUrl + ": " + JSON.stringify(this.parsedTaskBody));
                callback(this.parsedTaskBody);
            }
        });
    }

    initializeNewJob() {
        this.refreshJobTask(function callback(parsedTaskBody) {
            if (this.parsedTaskBody.inQueue) { // if it's in the queue, start checking with the next build number
                this.initialSearchBuildNumber = this.parsedTaskBody.nextBuildNumber;
            } else { // otherwise, check with the last build number.
                this.initialSearchBuildNumber = this.parsedBody.lastBuild.number;
            }
            this.workDelay = 0;
            this.working = false;
        });
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

    debug(message: string) {
        var fullMessage = this.toString() + ' debug: ' + message;
        tl.debug(fullMessage);
    }

    toString() {
        var fullMessage = '(Job:' + this.name + ':' + this.executableNumber;
        if (this.parentJob != null) {
            fullMessage += ', parentJob:' + this.parentJob;
        }
        if (this.joinedJob != null) {
            fullMessage += ', joinedJob:' + this.joinedJob;
        }
        fullMessage += ', state:' + this.state + ')';
        return fullMessage;
    }
}

class JobQueue {
    jobs: Job[] = [];

    constructor(rootJob: Job) {
        this.jobs.push(rootJob);
        this.start();
    }

    start(): void {
        //while (true) { // run until all jobs are finished
            for (var i in this.jobs) {
                var job = this.jobs[i];
                if (job.isActive()) {
                    job.doWork();
                }
            }
            if (this.countRemainingJobs() == 0) {
                return this.stop();
            }
        //}
    }

    stop(): void {
        var message: string = null;
        if (capturePipeline) {
            message = 'Jenkins pipeline complete';
        } else if (captureConsole) {
            message = 'Jenkins job complete';
        } else {
            message = 'Jenkins job queued';
        }
        tl.setResult(tl.TaskResult.Succeeded, message);
        tl.exit(0);
    }

    queue(job: Job): void {
        this.jobs.push(job);
    }

    countRemainingJobs(): number {
        var count: number = 0;
        for (var i in this.jobs) {
            var job = this.jobs[i];
            if (job.isActive()) {
                count++;
            }
        }
        return count;
    }

    flushJobConsolesIfDone(): void {
        for (var i in this.jobs) {
            var job = this.jobs[i];
            if (job.getState() == JobState.Done) {
                job.enableConsoleLog();
            }
        }
    }

    findJob(name: string, executableNumber: number): Job {
        for (var i in this.jobs) {
            var job = this.jobs[i];
            if (job.name == name && job.executableNumber == executableNumber) {
                return job;
            }
        }
        return null;
    }

    joinJobs(parentJob: Job, joinToJob: Job): void {
        for (var i in this.jobs) {
            var job = this.jobs[i];
            if (job.parentJob == parentJob && job != joinToJob) {
                job.setJoined(joinToJob);
            }
        }
    }
}

var jobQueue;

function trackJobQueued(queueUri: string) {
    tl.debug('Tracking progress of job queue: ' + queueUri);
    request.get({ url: queueUri }, function callBack(err, httpResponse, body) {
        if (err) {
            failError(err);
        } else if (httpResponse.statusCode != 200) {
            failReturnCode(httpResponse, 'Job progress tracking failed to read job queue');
        } else {
            var parsedBody = JSON.parse(body);
            tl.debug("parsedBody for: " + queueUri + ": " + JSON.stringify(parsedBody));

            // canceled is spelled wrong in the body with 2 Ls (checking correct spelling also in case they fix it)
            if (parsedBody.cancelled || parsedBody.canceled) {
                tl.setResult(tl.TaskResult.Failed, 'Jenkins job canceled.');
                tl.exit(1);
            }
            var executable = parsedBody.executable;
            if (!executable) {
                // job has not actually been queued yet, keep checking
                setTimeout(function () {
                    trackJobQueued(queueUri);
                }, captureConsolePollInterval);
            } else {
                var rootJob: Job = new Job(null, parsedBody.task.url, parsedBody.executable.url, parsedBody.executable.number, parsedBody.task.name);
                jobQueue = new JobQueue(rootJob);
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
            var downstreamProjects = job.parsedTaskBody.downstreamProjects;
            // each of these runs in parallel
            downstreamProjects.forEach((project) => {
                var child: Job = new Job(job, project.url, null, -1, project.name);
                jobQueue.queue(child);
            });
            job.changeState(JobState.Done);
            job.working = false;
        } else {
            tl.setResult(job.getTaskResult(), job.getCompletionMessage());
            tl.exit(1);
        }
    });
}

/**
 * Search for a pipelined job starting with a best guess for the build number, and a direction to search.
 * First the search is done backwards and terminates when either finding the specified job, or the job's
 * timestamp is earlier than the timestamp of the parent job that queued it.  Then the restarts from the
 * intial start point and searches forward until the job is found, or a 404 is reached and no more jobs
 * are queued.  At any point, the search also ends if the job is joined to another job.
 */
function locateChildExecutionBuildNumber(job: Job) {
    var url = addUrlSegment(job.taskUrl, job.nextSearchBuildNumber + "/api/json");
    job.debug('pipeline, locating child execution URL:' + url);
    request.get({ url: url }, function callBack(err, httpResponse, body) {
        if (err) {
            failError(err);
        } else if (httpResponse.statusCode == 404) {
            // This job doesn't exist -- do we expect it to in the near future because it has been queued?
            job.debug('404 for: ' + job.name + ':' + job.nextSearchBuildNumber);
            job.debug('checking if it is in the queue');
            job.refreshJobTask(function callback(parsedJobTaskBody) {
                if (parsedJobTaskBody.inQueue || parsedJobTaskBody.lastCompletedBuild >= job.nextSearchBuildNumber) {
                    //see if it's in the queue, or maybe it just ran right after we first checked
                    job.debug('job has been queued, continue searching');
                    job.workDelay = captureConsolePollInterval;
                    job.working = false;
                } else {
                    job.debug('job is not queued, end search');
                    console.log(job + ' can not be found.');
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
            var parentJob = jobQueue.findJob(cause.upstreamProject, cause.upstreamBuild);
            if (parentJob == job.parentJob) {
                // found it; mark it running, and start grabbing the console
                job.setStreaming(job.nextSearchBuildNumber);
                // fall through the if, and join any other causes to this job
            }

            var joinedCauses = causes.length > 1 ? causes.slice(1) : [];
            for (var i in joinedCauses) { // iterate over all and join as many as possible.
                cause = joinedCauses[i];
                var parentJob = jobQueue.findJob(cause.upstreamProject, cause.upstreamBuild);
                jobQueue.joinJobs(parentJob, job);
            }

            if (job.getState() == JobState.Locating) {
                // need to keep searching
                job.debug('Search failed for: ' + job.name + ':' + job.nextSearchBuildNumber + ' triggered by :' + job.parentJob.name + ':' + job.parentJob.parsedExecutionResult.number);
                if (job.searchDirection < 0) { // search backwards
                    if (parsedBody.timestamp <= job.parentJob.parsedExecutionResult.timestamp || job.nextSearchBuildNumber == 1) {
                        // we already searched backwards as far as possible, 
                        // so start searching forwards from the begining
                        job.debug('changing search direction');
                        job.nextSearchBuildNumber = job.initialSearchBuildNumber + 1;
                        job.searchDirection = 1;
                    } else { // search backwards one
                        job.debug('searching back one');
                        job.nextSearchBuildNumber--;
                    }
                } else { // search forwards one
                    job.debug('searching forward one');
                    job.nextSearchBuildNumber++;
                }
            }
            job.workDelay = 0;
            job.working = false;
        }
    });
}

/**
 * Streams the Jenkins console.
 * 
 * JobState = Streaming, transition to Finishing possible.
 */
function streamConsole(job: Job) {
    var fullUrl = addUrlSegment(job.executableUrl, '/logText/progressiveText/?start=' + job.jobConsoleOffset);
    job.debug('Tracking progress of job URL: ' + fullUrl);
    request.get({ url: fullUrl }, function callBack(err, httpResponse, body) {
        if (err) {
            failError(err);
        } else if (httpResponse.statusCode != 200) {
            failReturnCode(httpResponse, 'Job progress tracking failed to read job progress');
        } else {
            job.consoleLog(body); // redirect Jenkins console to task console
            var xMoreData = httpResponse.headers['x-more-data'];
            if (xMoreData && xMoreData == 'true') {
                var offset = httpResponse.headers['x-text-size'];
                job.jobConsoleOffset = offset;
                job.workDelay = captureConsolePollInterval;
                job.working = false;
            } else { // job is done -- did it succeed or not?
                job.workDelay = 0;
                job.changeState(JobState.Finishing);
                job.working = false;
            }
        }
    });
}
/**
 * Checks the success of the job
 * 
 * JobState = Finishing, transition to Done possible
 */
function checkSuccess(job: Job) {
    var resultUrl = addUrlSegment(job.executableUrl, 'api/json');
    job.debug('Tracking completion status of job: ' + resultUrl);
    request.get({ url: resultUrl }, function callBack(err, httpResponse, body) {
        if (err) {
            fail(err);
        } else if (httpResponse.statusCode != 200) {
            failReturnCode(httpResponse, 'Job progress tracking failed to read job result');
        } else {
            var parsedBody = JSON.parse(body);
            job.debug("parsedBody for: " + resultUrl + ": " + JSON.stringify(parsedBody));
            if (parsedBody.result) {
                job.setParsedExecutionResult(parsedBody);
                createLinkAndFinish(job);
            } else {
                // result not updated yet -- keep trying
                job.workDelay = captureConsolePollInterval;
                job.working = false;
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
        fail(err);
    } else if (httpResponse.statusCode != 201) {
        failReturnCode(httpResponse, 'Job creation failed.');
    } else {
        console.log('Jenkins job queued');
        var queueUri = addUrlSegment(httpResponse.headers.location, 'api/json');
        trackJobQueued(queueUri);
    }
}).auth(username, password, true);