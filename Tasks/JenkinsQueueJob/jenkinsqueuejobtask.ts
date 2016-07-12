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
    var resultUrl = null;
    if (baseUrl.endsWith('/') && segment.startsWith('/')) {
        resultUrl = baseUrl + segment.slice(1);
    } else if (baseUrl.endsWith('/') || segment.startsWith('/')) {
        resultUrl = baseUrl + segment;
    } else {
        resultUrl = baseUrl + '/' + segment;
    }
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
    tl.debug('fail');
    tl.debug(message);
    tl.setResult(tl.TaskResult.Failed, message);
    tl.exit(1);
}

enum JobState {
    New,       // 0
    Locating,  // 1
    Streaming, // 2
    Finishing, // 3
    Done,      // 4
    Joined,    // 5
    Queued,    // 6
    Cut        // 7
}

class Job {
    parent: Job; // if this job is a pipelined job, its parent that started it.
    children: Job[] = []; // any pipelined jobs
    joined: Job // if this job is joined, the main job that is running
    search: JobSearch;

    taskUrl: string; // URL for the job definition

    state: JobState = JobState.New;
    executableUrl: string; // URL for the executing job instance
    executableNumber: number;
    name: string;
    jobConsole: string = "";
    jobConsoleOffset: number = 0;
    jobConsoleEnabled: boolean = false;

    working: boolean = false;
    workDelay: number = 0;

    parsedExecutionResult; // set during state Finishing

    constructor(parent: Job, taskUrl: string, executableUrl: string, executableNumber: number, name: string) {
        this.parent = parent;
        this.taskUrl = taskUrl;
        this.executableUrl = executableUrl;
        this.executableNumber = executableNumber;
        this.name = name;
        if (this.parent != null) {
            this.parent.children.push(this);
        }
        jobQueue.addJob(this);

        this.debug('created');
        this.initialize();
    }

    /**
     * All changes to the job state should be routed through here.  
     * This defines all and validates all state transitions.
     */
    changeState(newState: JobState) {
        var oldState = this.state;
        this.state = newState;
        if (oldState != newState) {
            this.debug('state changed from: ' + oldState);
            var validStateChange = false;
            if (oldState == JobState.New) {
                validStateChange = (newState == JobState.Locating || newState == JobState.Streaming || newState == JobState.Joined || newState == JobState.Cut);
            } else if (oldState == JobState.Locating) {
                validStateChange = (newState == JobState.Streaming || newState == JobState.Joined || newState == JobState.Cut);
            } else if (oldState == JobState.Streaming) {
                validStateChange = (newState == JobState.Finishing);
            } else if (oldState == JobState.Finishing) {
                validStateChange = (newState == JobState.Done);
            } else if (oldState == JobState.Done || oldState == JobState.Joined || oldState == JobState.Cut) {
                validStateChange = false; // these are terminal states
            }
            if (!validStateChange) {
                fail('Invalid state change from: ' + oldState + ' ' + this);
            }
        }
    }

    doWork() {
        if (this.working) { // return if already working
            return;
        } else {
            this.working = true;
            setTimeout(() => {
                if (this.state == JobState.Streaming) {
                    streamConsole(this);
                } else if (this.state == JobState.Finishing) {
                    finish(this);
                } else {
                    // usually do not get here, but this can happen if another callback caused this job to be joined
                    this.stopWork(pollInterval, null);
                }
            }, this.workDelay);
        }
    }

    stopWork(delay: number, jobState: JobState) {
        if (jobState && jobState != this.state) {
            this.changeState(jobState);
            if (!this.isActive()) {
                jobQueue.flushJobConsolesSafely();
            }
        }
        this.workDelay = delay;
        this.working = false;
    }

    isActive(): boolean {
        return this.state == JobState.New ||
            this.state == JobState.Locating ||
            this.state == JobState.Streaming ||
            this.state == JobState.Finishing
    }

    setStreaming(executableNumber: number): void {
        if (this.state == JobState.New || this.state == JobState.Locating) {
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
        } else if (this.state == JobState.Joined || this.state == JobState.Cut) {
            fail('Can not be set to streaming: ' + this);
        }
        this.joinOthersToMe();
    }

    joinOthersToMe() {
        //join all other siblings to this same job (as long as it's not root)
        var thisJob: Job = this;
        if (thisJob.parent != null) {
            thisJob.search.determineMainJob(thisJob.executableNumber, function (mainJob: Job, secondaryJobs: Job[]) {
                if (mainJob != thisJob) {
                    fail('Illegal call in joinOthersToMe(), job:' + thisJob);
                }
                for (var i in secondaryJobs) {
                    var secondaryJob = secondaryJobs[i];
                    if (secondaryJob.state != JobState.Cut) {
                        secondaryJob.setJoined(thisJob);
                    }
                }
            });
        }
    }

    setParsedExecutionResult(parsedExecutionResult) {
        this.parsedExecutionResult = parsedExecutionResult;
        this.consoleLog('******************************************************************************\n');
        this.consoleLog('Jenkins job finished: ' + this.name + '\n');
        this.consoleLog(this.executableUrl + '\n');
        this.consoleLog('******************************************************************************\n');
    }

    setJoined(joinedJob: Job): void {
        tl.debug(this + '.setJoined(' + joinedJob + ')');
        this.joined = joinedJob;
        this.changeState(JobState.Joined);
        if (joinedJob.state == JobState.Joined || joinedJob.state == JobState.Cut) {
            fail('Invalid join: ' + this);
        }

        // recursively cut all children
        for (var i in this.children) {
            this.children[i].cut();
        }
    }

    cut(): void {
        this.changeState(JobState.Cut);
        for (var i in this.children) {
            this.children[i].cut();
        }
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

    getTaskResult(finalJobState: JobState): number {
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
        var apiTaskUrl = addUrlSegment(this.taskUrl, "/api/json");
        this.debug('getting job task URL:' + apiTaskUrl);
        return request.get({ url: apiTaskUrl }, function requestCallBack(err, httpResponse, body) {
            if (err) {
                failError(err);
            } else if (httpResponse.statusCode != 200) {
                failReturnCode(httpResponse, 'Unable to retrieve job: ' + this.name);
            } else {
                job.parsedTaskBody = JSON.parse(body);
                job.debug("parsedBody for: " + apiTaskUrl + ": " + JSON.stringify(job.parsedTaskBody));
                callback();
            }
        }).auth(username, password, true);
    }

    initialize() {
        var thisJob = this;
        if (thisJob.search.parsedTaskBody) {
            addPipelineJobs(thisJob);
        } else {
            var apiTaskUrl = addUrlSegment(thisJob.taskUrl, "/api/json");
            thisJob.debug('getting job task URL:' + apiTaskUrl);
            request.get({ url: apiTaskUrl }, function requestCallBack(err, httpResponse, body) {
                if (!thisJob.search.parsedTaskBody) { // another callback could have updated thisJob
                    if (err) {
                        failError(err);
                    } else if (httpResponse.statusCode != 200) {
                        failReturnCode(httpResponse, 'Unable to retrieve job: ' + thisJob.name);
                    } else {
                        var parsedTaskBody = JSON.parse(body);
                        tl.debug("parsedBody for: " + apiTaskUrl + ": " + JSON.stringify(parsedTaskBody));
                        thisJob.search.initialize(parsedTaskBody);
                    }
                }
                addPipelineJobs(thisJob);
            }).auth(username, password, true);
        }

        function addPipelineJobs(job: Job) {
            if (capturePipeline) {
                var downstreamProjects = jobQueue.searches[job.name].parsedTaskBody.downstreamProjects;
                downstreamProjects.forEach((project) => {
                    new Job(job, project.url, null, -1, project.name); // will add a new child to the tree
                });
            }
            jobQueue.searches[job.name].resolveIfKnown(job); // could change state
            var newState = (job.state == JobState.New) ? JobState.Locating : job.state; // another call back could also change state 
            var nextWorkDelay = (newState == JobState.Locating) ? pollInterval : job.workDelay;
            return job.stopWork(nextWorkDelay, newState);
        };
    }

    enableConsole() {
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
        var fullMessage = '(' + this.state + ':' + this.name + ':' + this.executableNumber;
        if (this.parent != null) {
            fullMessage += ', p:' + this.parent;
        }
        if (this.joined != null) {
            fullMessage += ', j:' + this.joined;
        }
        fullMessage += ')';
        return fullMessage;
    }
}

class JobSearch {
    taskUrl: string; // URL for the job definition
    name: string; // name of the job this search is for
    searchingFor: Job[] = [];

    constructor(taskUrl: string, name: string) {
        this.taskUrl = taskUrl;
        this.name = name;
    }

    foundCauses = []; // all found causes indexed by executableNumber

    parsedTaskBody; // the parsed task body of the job definition
    initialSearchBuildNumber: number = -1; // the intial, most likely build number for child jobs
    nextSearchBuildNumber: number = -1; // the next build number to check

    working: boolean = false;
    workDelay: number = 0;

    initialize(parsedTaskBody) {
        this.parsedTaskBody = parsedTaskBody;
        this.initialSearchBuildNumber = parsedTaskBody.lastBuild.number;
        this.nextSearchBuildNumber = this.initialSearchBuildNumber;
    }

    doWork() {
        if (this.working) { // return if already working
            return;
        } else {
            this.working = true;
            setTimeout(() => {
                this.locateExecution();
            }, this.workDelay);
        }
    }

    stopWork(delay: number) {
        this.workDelay = delay;
        this.working = false;
        this.searchingFor = [];
    }

    searchFor(job: Job): void {
        if (this.working) {
            return;
        } else {
            this.searchingFor.push(job);
        }
    }

    determineMainJob(executableNumber: number, callback) {
        var thisSearch: JobSearch = this;
        if (!thisSearch.foundCauses[executableNumber]) {
            fail('No known exeuction number: ' + executableNumber + ' for job: ' + thisSearch.name);
        } else {
            var causes = thisSearch.foundCauses[executableNumber];
            var causesThatRan: Job[] = []; // these are all the causes for this executableNumber that are running/ran
            var causesThatMayRun: Job[] = []; // these are the causes for this executableNumber that could run in the future
            var causesThatWontRun: Job[] = []; // these are the causes for this executableNumber that will never run
            for (var i in causes) {
                var job = jobQueue.findJob(causes[i].upstreamProject, causes[i].upstreamBuild);
                if (job) { // we know about it
                    if (job.state == JobState.Streaming || job.state == JobState.Finishing || job.state == JobState.Done) {
                        causesThatRan.push(job);
                    } else if (job.state == JobState.New || job.state == JobState.Locating) {
                        causesThatMayRun.push(job);
                    } else if (job.state == JobState.Joined || job.state == JobState.Cut) {
                        causesThatWontRun.push(job);
                    } else {
                        fail('Illegal state: ' + job);
                    }
                }
            }

            var masterJob: Job = null; // there can be only one
            var potentialMasterJobs: Job[] = []; // the list of all potential jobs that could be master
            for (var i in causesThatRan) {
                var causeThatRan: Job = causesThatRan[i];
                var child = findChild(causeThatRan);
                if (child != null) {
                    if (child.state == JobState.Streaming || child.state == JobState.Finishing || child.state == JobState.Done) {
                        if (masterJob == null) {
                            masterJob = child;
                        } else {
                            fail('Can not have more than one master: ' + child);
                        }
                    } else {
                        potentialMasterJobs.push(child);
                    }
                }
            }

            if (masterJob == null && potentialMasterJobs.length > 0) {
                masterJob = potentialMasterJobs[0]; // simply assign the first one to master
                potentialMasterJobs = potentialMasterJobs.slice(1); // and remove it from here
            }

            var secondaryJobs: Job[] = [];
            if (masterJob != null) { // secondaryJobs are only possible once a master is assigned
                secondaryJobs = potentialMasterJobs;
                for (var i in causesThatWontRun) {
                    var causeThatWontRun = causesThatWontRun[i];
                    var child = findChild(causeThatWontRun);
                    if (child != null) {
                        secondaryJobs.push(child);
                    }
                }
            }

            callback(masterJob, secondaryJobs)

            function findChild(parent: Job): Job {
                for (var i in parent.children) {
                    var child: Job = parent.children[i];
                    if (thisSearch.name == child.name) {
                        return child
                    }
                }
                return null;
            }
        }
    }

    resolveIfKnown(job: Job): boolean {
        var thisSearch: JobSearch = this;
        if (job.state != JobState.New && job.state != JobState.Locating) {
            return true; // some other callback found it
        } else if (job.parent == null) { // root -- move straight to streaming
            job.setStreaming(job.executableNumber);
            return true;
        } else if (job.parent.state == JobState.Joined || job.parent.state == JobState.Cut) {
            job.cut(); // the parent was joined or cut, so cut the child
            return true;
        } else {
            for (var executableNumber in thisSearch.foundCauses) {
                var resolved = false;
                thisSearch.determineMainJob(parseInt(executableNumber), function (mainJob: Job, secondaryJobs: Job[]) {
                    if (job == mainJob) { // job is the main job -- so make sure it's running
                        job.setStreaming(parseInt(executableNumber));
                        resolved = true;
                        return;
                    } else {
                        for (var i in secondaryJobs) {
                            if (job == secondaryJobs[i]) { // job is a secondary job, so join it to the main one
                                job.setJoined(mainJob);
                                resolved = true;
                                return;
                            }
                        }
                    }
                });
                if (resolved) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Search for a pipelined job starting with a best guess for the build number, and a direction to search.
     * First the search is done backwards and terminates when either finding the specified job, or the job's
     * timestamp is earlier than the timestamp of the parent job that queued it.  Then the restarts from the
     * intial start point and searches forward until the job is found, or a 404 is reached and no more jobs
     * are queued.  At any point, the search also ends if the job is joined to another job.
     */
    locateExecution() {
        var thisSearch = this;

        tl.debug('locateExecution()');
        // first see if we already know about everything we are searching for
        var foundAll: boolean = true;
        for (var i in thisSearch.searchingFor) {
            var job = thisSearch.searchingFor[i];
            var found = thisSearch.resolveIfKnown(job);
            foundAll = foundAll && found;
        }

        if (foundAll) {
            thisSearch.stopWork(0); // found everything we were looking for
            return;
        } else {
            var url = addUrlSegment(thisSearch.taskUrl, thisSearch.nextSearchBuildNumber + "/api/json");
            tl.debug('pipeline, locating child execution URL:' + url);
            request.get({ url: url }, function requestCallback(err, httpResponse, body) {
                tl.debug('locateExecution().requestCallback()');
                if (err) {
                    failError(err);
                } else if (httpResponse.statusCode == 404) {
                    // try again in the future
                    thisSearch.stopWork(pollInterval);
                } else if (httpResponse.statusCode != 200) {
                    failReturnCode(httpResponse, 'Job pipeline tracking failed to read downstream project');
                } else {
                    var parsedBody = JSON.parse(body);
                    tl.debug("parsedBody for: " + url + ": " + JSON.stringify(parsedBody));

                    /**
                     * This is the list of all reasons for this job execution to be running.  
                     * Jenkins may 'join' several pipelined jobs so all will be listed here.
                     * e.g. suppose A -> C and B -> C.  If both A & B scheduled C around the same time before C actually started, 
                     * Jenkins will join these requests and only run C once.
                     * So, for all jobs being tracked (within this code), one is consisdered the main job (which will be followed), and
                     * all others are considered joined and will not be tracked further.
                     */
                    var causes = parsedBody.actions[0].causes;
                    thisSearch.foundCauses[thisSearch.nextSearchBuildNumber] = causes;
                    thisSearch.determineMainJob(thisSearch.nextSearchBuildNumber, function (mainJob: Job, secondaryJobs: Job[]) {
                        if (mainJob != null) {
                            //found the mainJob, so make sure it's running!
                            mainJob.setStreaming(thisSearch.nextSearchBuildNumber);
                        }
                    });

                    thisSearch.nextSearchBuildNumber++;
                    return thisSearch.stopWork(0); // immediately poll again because there might be more jobs
                }
            }).auth(username, password, true);
        }
    }
}

class JobQueue {
    rootJob: Job;
    allJobs: Job[] = [];
    searches: JobSearch[] = [];

    constructor() {
    }

    intervalId: NodeJS.Timer;
    intervalMillis: number = 10;

    start(): void {
        tl.debug('jobQueue.start()');
        this.intervalId = setInterval(() => {
            var nextSearches = this.findNextJobSearches();
            for (var i in nextSearches) {
                nextSearches[i].doWork();
            }

            var running = this.findRunningJobs();
            for (var i in running) {
                running[i].doWork();
            }
            if (this.getActiveJobs().length == 0) {
                this.stop();
            } else {
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
        this.writeFinalMarkdown();
        tl.setResult(tl.TaskResult.Succeeded, message);
        tl.exit(0);
    }

    findRunningJobs(): Job[] {
        var running = [];
        for (var i in this.allJobs) {
            var job = this.allJobs[i];
            if (job.state == JobState.Streaming || job.state == JobState.Finishing) {
                running.push(job);
            }
        }
        return running;
    }

    findNextJobSearches(): JobSearch[] {
        var nextSearches: JobSearch[] = [];
        for (var i in this.allJobs) {
            var job = this.allJobs[i];
            // the parent must be finished (or null for root) in order for a job to possibly be started
            if (job.state == JobState.Locating && (job.parent == null || job.parent.state == JobState.Done)) {
                // group these together so only search is done per job name
                if (!nextSearches[job.name]) {
                    nextSearches[job.name] = this.searches[job.name];
                }
                nextSearches[job.name].searchFor(job);
            }
        }
        return nextSearches;
    }

    getActiveJobs(): Job[] {
        var active: Job[] = [];

        for (var i in this.allJobs) {
            var job = this.allJobs[i];
            if (job.isActive()) {
                active.push(job);
            }
        }

        return active;
    }

    addJob(job: Job) {
        if (this.allJobs.length == 0) {
            this.rootJob = job;
        }
        this.allJobs.push(job);
        if (this.searches[job.name] == null) {
            this.searches[job.name] = new JobSearch(job.taskUrl, job.name);
        }
        job.search = this.searches[job.name];
    }

    flushJobConsolesSafely(): void {
        if (this.findActiveConsoleJob() == null) { //nothing is currently writing to the console
            var streamingJobs: Job[] = [];
            var addedToConsole: boolean = false;
            for (var i in this.allJobs) {
                var job = this.allJobs[i];
                if (job.state == JobState.Done) {
                    if (!job.isConsoleEnabled()) {
                        job.enableConsole(); // flush the finished ones
                        addedToConsole = true;
                    }
                } else if (job.state == JobState.Streaming || job.state == JobState.Finishing) {
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
        for (var i in this.allJobs) {
            var job = this.allJobs[i];
            if (job.name == name && job.executableNumber == executableNumber) {
                return job;
            }
        }
        return null;
    }

    writeFinalMarkdown() {
        tl.debug('writing summary markdown');
        var tempDir = shell.tempdir();
        var linkMarkdownFile = path.join(tempDir, 'JenkinsJob_' + this.rootJob.name + '_' + this.rootJob.executableNumber + '.md');
        tl.debug('markdown location: ' + linkMarkdownFile);
        var tab: string = "  ";
        var paddingTab: number = 4;
        var markdownContents = walkHierarchy(this.rootJob, "", 0);

        function walkHierarchy(job: Job, indent: string, padding: number): string {
            var jobContents = indent + '<ul style="padding-left:' + padding + '">\n';

            // if this job was joined to another follow that one instead
            job = findWorkingJob(job);
            var jobState: JobState = job.state;

            if (jobState == JobState.Done || jobState == JobState.Queued) {
                jobContents += indent + '[' + job.name + ' #' + job.executableNumber + '](' + job.executableUrl + ') ' + job.getResultString() + '<br>\n';
            } else {
                console.log('Warning, still in active state: ' + job);
            }

            var childContents = "";
            for (var i in job.children) {
                var child = job.children[i];
                childContents += walkHierarchy(child, indent + tab, padding + paddingTab);
            }

            return jobContents + childContents + indent + '</ul>\n';
        }

        function findWorkingJob(job: Job) {
            if (job.state != JobState.Joined) {
                return job;
            } else {
                return findWorkingJob(job.joined);
            }
        }


        fs.writeFile(linkMarkdownFile, markdownContents, function callback(err) {
            tl.debug('writeFinalMarkdown().writeFile().callback()');

            if (err) {
                //don't fail the build -- there just won't be a link
                console.log('Error creating link to Jenkins job: ' + err);
            } else {
                console.log('##vso[task.addattachment type=Distributedtask.Core.Summary;name=Jenkins Results;]' + linkMarkdownFile);
            }

        });

    }
}

var jobQueue: JobQueue = new JobQueue();

/**
 * Streams the Jenkins console.
 * 
 * JobState = Streaming, transition to Finishing possible.
 */
function streamConsole(job: Job) {
    var fullUrl = addUrlSegment(job.executableUrl, '/logText/progressiveText/?start=' + job.jobConsoleOffset);
    job.debug('Tracking progress of job URL: ' + fullUrl);
    request.get({ url: fullUrl }, function requestCallback(err, httpResponse, body) {
        tl.debug('streamConsole().requestCallback()');
        if (err) {
            failError(err);
        } else if (httpResponse.statusCode == 404) {
            // got here too fast, stream not yet available, try again in the future
            job.stopWork(pollInterval, job.state);
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
    }).auth(username, password, true);;
}
/**
 * Checks the success of the job
 * 
 * JobState = Finishing, transition to Done or Queued possible
 */
function finish(job: Job) {
    tl.debug('finish()');
    if (!captureConsole) { // transition to Queued
        job.stopWork(0, JobState.Queued);
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
                    job.stopWork(0, JobState.Done);
                } else {
                    // result not updated yet -- keep trying
                    job.stopWork(pollInterval, job.state);
                }
            }
        }).auth(username, password, true);
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
                jobQueue.start();
            }
        }
    }).auth(username, password, true);
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