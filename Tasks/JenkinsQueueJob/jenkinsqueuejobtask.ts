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
var pollInterval = 5000; // five seconds is what the Jenkins Web UI uses

// capturePipeline is only possible if captureConsole mode is enabled
var capturePipeline = captureConsole ? tl.getBoolInput('capturePipeline', true) : false;

var parameterizedJob = tl.getBoolInput('parameterizedJob', true);

var jobQueueUrl = addUrlSegment(serverEndpointUrl, '/job/' + jobName);
jobQueueUrl += (parameterizedJob) ? '/buildWithParameters?delay=0sec' : '/build?delay=0sec';
tl.debug('jobQueueUrl=' + jobQueueUrl);

function addUrlSegment(baseUrl: string, segment: string): string {
    tl.debug('addUrlSegment');
    var resultUrl = null;
    if (baseUrl.endsWith('/') && segment.startsWith('/')) {
        resultUrl = baseUrl + segment.slice(1);
    } else if (baseUrl.endsWith('/') || segment.startsWith('/')) {
        resultUrl = baseUrl + segment;
    } else {
        resultUrl = baseUrl + '/' + segment;
    }
    //tl.debug('addUrlSegment baseUrl: ' + baseUrl + ' segment: ' + segment + ' resultUrl: ' + resultUrl);
    return resultUrl;
}

function failError(err): void {
    tl.debug('failError');
    fail(err);
}

function failReturnCode(httpResponse, message: string): void {
    tl.debug('failReturnCode');
    var fullMessage = message +
        '\nHttpResponse.statusCode=' + httpResponse.statusCode +
        '\nHttpResponse.statusMessage=' + httpResponse.statusMessage +
        '\nHttpResponse=\n' + JSON.stringify(httpResponse);
    fail(fullMessage);
}

function fail(message: string): void {
    tl.debug('fail');
    tl.debug(message);
    tl.setResult(tl.TaskResult.Failed, message);
    tl.exit(1);
}

enum JobState {
    New,
    Locating,
    LocatingNotFound,
    Streaming,
    Finishing,
    Done,
    Joined,
    Queued,
    Lost
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
        tl.debug('new job');
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
            setTimeout(() => {
                tl.debug('doWork().setTimeout()');
                if (this.state == JobState.New) {
                    if (this.parentJob == null) { // root job, can skip Locating
                        if (captureConsole) {
                            this.enableConsole();
                            this.setStreaming(this.executableNumber); // jump to Streaming
                        } else {
                            this.changeState(JobState.Finishing); // also skip Streaming and jump to Finishing
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
                    finish(this);
                } else {
                    // non active states, should not be in here
                    tl.debug(this + 'should not be in doWork()');
                    this.stopWork(0, null);
                }
            }, this.workDelay);
        }
    }

    stopWork(delay: number, jobState: JobState) {
        tl.debug('job.stopWork()');
        if (jobState && jobState != this.state) {
            this.changeState(jobState);
        }
        this.workDelay = delay;
        this.working = false;
    }

    changeState(newState: JobState) {
        tl.debug('job.changeState()');
        this.state = newState;
        this.debug('state changed');
    }

    getState(): JobState {
        tl.debug('job.getState()');
        return this.state;
    }

    isActive(): boolean {
        tl.debug('job.isActive()');
        return this.state == JobState.New ||
            this.state == JobState.Locating ||
            this.state == JobState.LocatingNotFound ||
            this.state == JobState.Streaming ||
            this.state == JobState.Finishing
    }

    setStreaming(executableNumber: number): void {
        tl.debug('job.setStreaming()');
        this.executableNumber = executableNumber;
        this.executableUrl = addUrlSegment(this.taskUrl, this.executableNumber.toString());
        this.changeState(JobState.Streaming);

        this.consoleLog('******************************************************************************\n');
        this.consoleLog('Jenkins job started: ' + this.name + '\n');
        this.consoleLog(this.executableUrl + '\n');
        this.consoleLog('******************************************************************************\n');

        if (jobQueue.findActiveConsoleJob() == null) {
            console.log('Jenkins job pending: ' + this.executableUrl);
        }
    }

    setParsedExecutionResult(parsedExecutionResult) {
        tl.debug('job.setParsedExecutionResult');
        this.parsedExecutionResult = parsedExecutionResult;
        this.consoleLog('******************************************************************************\n');
        this.consoleLog('Jenkins job finished: ' + this.name + '\n');
        this.consoleLog(this.executableUrl + '\n');
        this.consoleLog('******************************************************************************\n');
    }

    setJoined(joinedJob: Job): void {
        tl.debug('job.setJoined()');
        this.joinedJob = joinedJob;
        this.changeState(JobState.Joined);
    }

    getCompletionMessage(finalJobState: JobState): string {
        tl.debug('job.getCompletionMessage()');
        return 'Jenkins job: ' + this.getResultString(finalJobState) + ' ' + this.name + ' ' + this.executableUrl;
    }

    getSummaryTitle(finalJobState: JobState) {
        tl.debug('job.getSummaryTitle()');
        return 'Jenkins ' + this.name + ' - ' + this.executableNumber + ' - ' + this.getResultString(finalJobState);
    }

    getResultString(finalJobState: JobState): string {
        tl.debug('job.getResultString()');
        if (finalJobState == JobState.Queued) {
            return 'Queued';
        } else if (finalJobState == JobState.Done) {
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

    getTaskResult(finalJobState: JobState): number {
        tl.debug('job.getTaskResult()');
        if (finalJobState == JobState.Queued) {
            return tl.TaskResult.Succeeded;
        } else if (finalJobState == JobState.Done) {
            var resultCode = this.parsedExecutionResult.result.toUpperCase();
            if (resultCode == "SUCCESS" || resultCode == 'UNSTABLE') {
                return tl.TaskResult.Succeeded;
            } else {
                return tl.TaskResult.Failed;
            }
        }
        return tl.TaskResult.Failed;
    }

    refreshJobTask(job, callback) {
        tl.debug('job.refreshJobTask()');
        var apiTaskUrl = addUrlSegment(this.taskUrl, "/api/json");
        this.debug('getting job task URL:' + apiTaskUrl);
        return request.get({ url: apiTaskUrl }, function requestCallBack(err, httpResponse, body) {
            tl.debug('job.refreshJobTask().requestCallBack()');
            if (err) {
                failError(err);
            } else if (httpResponse.statusCode != 200) {
                failReturnCode(httpResponse, 'Unable to retrieve job: ' + this.name);
            } else {
                job.parsedTaskBody = JSON.parse(body);
                job.debug("parsedBody for: " + apiTaskUrl + ": " + JSON.stringify(job.parsedTaskBody));
                callback();
            }
        });
    }

    initializeNewJob() {
        tl.debug('job.initializeNewJob()');
        var job = this;
        this.refreshJobTask(this, function callback() {
            tl.debug('job.initializeNewJob().classback()');
            if (job.parsedTaskBody.inQueue) { // if it's in the queue, start checking with the next build number
                job.initialSearchBuildNumber = job.parsedTaskBody.nextBuildNumber;
            } else { // otherwise, check with the last build number.
                job.initialSearchBuildNumber = job.parsedTaskBody.lastBuild.number;
            }
            job.nextSearchBuildNumber = job.initialSearchBuildNumber;
            job.stopWork(0, job.state);
        });
    }

    enableConsole() {
        tl.debug('job.enableConsoleLog()');
        if (captureConsole) {
            if (!this.jobConsoleEnabled) {
                if (this.jobConsole != "") { // flush any queued output
                    console.log(this.jobConsole);
                }
                this.jobConsoleEnabled = true;
            }
        }
    }

    isConsoleEnabled() {
        return this.jobConsoleEnabled;
    }

    consoleLog(message: string) {
        tl.debug('job.console()');
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
        tl.debug('new JobQueue');
        this.jobs.push(rootJob);
        this.start();
    }

    intervalId
    intervalMillis: number = 1000;

    start(): void {
        tl.debug('jobQueue.start()');

        this.intervalId = setInterval(() => {
            tl.debug('jobQueue.setInterval()');
            var activeJobs: Job[] = this.getActiveJobs();
            if (activeJobs.length == 0) {
                this.stop();
            } else {
                activeJobs.forEach((job) => {
                    job.doWork();
                });
                this.flushJobConsolesSafely();
            }
        }, this.intervalMillis);
    }

    stop(): void {
        tl.debug('jobQueue.stop()');
        clearInterval(this.intervalId);
        this.flushJobConsolesSafely();
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
        tl.debug('jobQueue.queue()');

        this.jobs.push(job);
    }

    getActiveJobs(): Job[] {
        var activeJobs: Job[] = [];

        for (var i in this.jobs) {
            var job = this.jobs[i];
            if (job.isActive()) {
                activeJobs.push(job);
            }
        }

        return activeJobs;
    }

    flushJobConsolesSafely(): void {
        if (this.findActiveConsoleJob() == null) { //nothing is currently writing to the console
            var streamingJobs: Job[] = [];
            var addedToConsole: boolean = false;
            for (var i in this.jobs) {
                var job = this.jobs[i];
                if (job.getState() == JobState.Done) {
                    if (!job.isConsoleEnabled()) {
                        job.enableConsole(); // flush the finished ones
                        addedToConsole = true;
                    }
                } else if (job.getState() == JobState.Streaming || job.getState() == JobState.Finishing) {
                    streamingJobs.push(job); // these are the ones that could be running
                }
            }
            // finally, if there is only one remaining, it is safe to enable its console
            if (streamingJobs.length == 1) {
                streamingJobs[0].enableConsole();
            } else if (addedToConsole) {
                for (var i in streamingJobs) {
                    var job = streamingJobs[i];
                    console.log('Jenkins job pending: ' + job.executableUrl);
                }
            }
        }
    }

    /**
     * If there is a job currently writing to the console, find it.
     */
    findActiveConsoleJob(): Job {
        var activeJobs: Job[] = this.getActiveJobs();
        for (var i in activeJobs) {
            var job = activeJobs[i];
            if (job.isConsoleEnabled()) {
                return job;
            }
        }
        return null;
    }

    findJob(name: string, executableNumber: number): Job {
        tl.debug('jobQueue.findJob()');

        for (var i in this.jobs) {
            var job = this.jobs[i];
            if (job.name == name && job.executableNumber == executableNumber) {
                return job;
            }
        }
        return null;
    }

    joinJobs(parentJob: Job, joinToJob: Job): void {
        tl.debug('jobQueue.joinJobs()');

        for (var i in this.jobs) {
            var job = this.jobs[i];
            if (job.parentJob == parentJob && job != joinToJob) {
                job.setJoined(joinToJob);
            }
        }
    }
}

var jobQueue: JobQueue;

function createLinkAndFinish(job: Job, finalJobState: JobState) {
    tl.debug('createLinkAndFinish()');

    var tempDir = shell.tempdir();
    var linkMarkdownFile = path.join(tempDir, 'JenkinsJob_' + job.name + '_' + job.executableNumber + '.md');
    job.debug('jenkinsLink: ' + linkMarkdownFile);
    var summaryTitle = job.getSummaryTitle(finalJobState);
    job.debug('summaryTitle: ' + summaryTitle);
    var markdownContents = '[' + job.executableUrl + '](' + job.executableUrl + ')';

    fs.writeFile(linkMarkdownFile, markdownContents, function callBack(err) {
        tl.debug('createLinkAndFinish().writeFile().callback()');

        if (err) {
            //don't fail the build -- there just won't be a link
            job.consoleLog('Error creating link to Jenkins job: ' + err);
        } else {
            job.consoleLog('##vso[task.addattachment type=Distributedtask.Core.Summary;name=' + summaryTitle + ';]' + linkMarkdownFile);
        }

        //if capturing the pipeline and this job succeeded, search for downstream jobs 
        if (capturePipeline && job.getTaskResult(finalJobState) == tl.TaskResult.Succeeded) {
            var downstreamProjects = job.parsedTaskBody.downstreamProjects;
            // each of these runs in parallel
            downstreamProjects.forEach((project) => {
                var child: Job = new Job(job, project.url, null, -1, project.name);
                jobQueue.queue(child);
            });
        } else {
            var taskResult = job.getTaskResult(finalJobState);
            tl.setResult(taskResult, job.getCompletionMessage(finalJobState));
            tl.exit(taskResult == tl.TaskResult.Succeeded ? 0 : 1);
        }
        jobQueue.flushJobConsolesSafely();
        job.stopWork(0, finalJobState);
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
    tl.debug('locateChildExecutionBuildNumber()');

    var url = addUrlSegment(job.taskUrl, job.nextSearchBuildNumber + "/api/json");
    job.debug('pipeline, locating child execution URL:' + url);
    request.get({ url: url }, function requestCallback(err, httpResponse, body) {
        tl.debug('locateChildExecutionBuildNumber().requestCallback()');

        if (err) {
            failError(err);
        } else if (httpResponse.statusCode == 404) {
            // This job doesn't exist -- do we expect it to in the near future because it has been queued?
            job.debug('404 for: ' + job.name + ':' + job.nextSearchBuildNumber);
            job.debug('checking if it is in the queue');
            job.refreshJobTask(job, function refreshJobTaskCallback() {
                tl.debug('locateChildExecutionBuildNumber().requestCallback().refreshJobTaskCallback()');

                if (job.parsedTaskBody.inQueue || job.parsedTaskBody.lastCompletedBuild >= job.nextSearchBuildNumber) {
                    //see if it's in the queue, or maybe it just ran right after we first checked
                    job.debug('job has been queued, continue searching');
                    job.stopWork(pollInterval, JobState.LocatingNotFound);
                } else {
                    job.stopWork(pollInterval, JobState.Lost);
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
            job.stopWork(0, job.state);
        }
    });
}

/**
 * Streams the Jenkins console.
 * 
 * JobState = Streaming, transition to Finishing possible.
 */
function streamConsole(job: Job) {
    tl.debug('streamConsole()');
    var fullUrl = addUrlSegment(job.executableUrl, '/logText/progressiveText/?start=' + job.jobConsoleOffset);
    job.debug('Tracking progress of job URL: ' + fullUrl);
    request.get({ url: fullUrl }, function requestCallback(err, httpResponse, body) {
        tl.debug('streamConsole().requestCallback()');
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
                job.stopWork(pollInterval, job.state);
            } else { // no more console, move to Finishing
                job.stopWork(0, JobState.Finishing);
            }
        }
    });
}
/**
 * Checks the success of the job
 * 
 * JobState = Finishing, transition to Done or Queued possible
 */
function finish(job: Job) {
    tl.debug('finish()');
    if (!captureConsole) { // transition to Queued
        createLinkAndFinish(job, JobState.Queued);
    } else { // stay in Finishing, or eventually go to Done
        var resultUrl = addUrlSegment(job.executableUrl, 'api/json');
        job.debug('Tracking completion status of job: ' + resultUrl);
        request.get({ url: resultUrl }, function requestCallback(err, httpResponse, body) {
            tl.debug('finish().requestCallback()');
            if (err) {
                fail(err);
            } else if (httpResponse.statusCode != 200) {
                failReturnCode(httpResponse, 'Job progress tracking failed to read job result');
            } else {
                var parsedBody = JSON.parse(body);
                job.debug("parsedBody for: " + resultUrl + ": " + JSON.stringify(parsedBody));
                if (parsedBody.result) {
                    job.setParsedExecutionResult(parsedBody);
                    createLinkAndFinish(job, JobState.Done);
                } else {
                    // result not updated yet -- keep trying
                    job.stopWork(pollInterval, job.state);
                }
            }
        });
    }
}

function trackJobQueued(queueUri: string) {
    tl.debug('trackJobQueued()');
    tl.debug('Tracking progress of job queue: ' + queueUri);
    request.get({ url: queueUri }, function requestCallback(err, httpResponse, body) {
        tl.debug('trackJobQueued().requestCallback()');
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
                }, pollInterval);
            } else {
                var rootJob: Job = new Job(null, parsedBody.task.url, parsedBody.executable.url, parsedBody.executable.number, parsedBody.task.name);
                jobQueue = new JobQueue(rootJob);
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