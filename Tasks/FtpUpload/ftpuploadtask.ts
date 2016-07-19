/// <reference path="../../definitions/vsts-task-lib.d.ts" />
/// <reference path="../../definitions/node.d.ts" />
/// <reference path="../../definitions/Q.d.ts" />

import path = require('path');
import tl = require('vsts-task-lib/task');
import url = require('url');
import Q = require('q');

var SortedSet = require('collections/sorted-set');
var Client = require('ftp');

import ftputils = require('./ftputils');

// server endpoint
var serverEndpoint = tl.getInput('serverEndpoint', true);
var serverEndpointUrl: url.Url = url.parse(tl.getEndpointUrl(serverEndpoint, false));

var serverEndpointAuth = tl.getEndpointAuthorization(serverEndpoint, false);
var username = serverEndpointAuth['parameters']['username'];
var password = serverEndpointAuth['parameters']['password'];

// other standard options
var rootFolder: string = tl.getPathInput('rootFolder', true);
var filePatterns: string[] = tl.getDelimitedInput('filePatterns', '\n', true);
var remotePath = tl.getInput('remotePath', true).trim();

// advanced options
var clean: boolean = tl.getBoolInput('clean', true);
var overwrite: boolean = tl.getBoolInput('overwrite', true);
var preservePaths: boolean = tl.getBoolInput('preservePaths', true);

// progress tracking
var progressFilesUploaded: number = 0;
var progressFilesSkipped: number = 0; // already exists and overwrite mode off
var progressDirectoriesProcessed: number = 0;

var files = findFiles();
tl.debug('number of files to upload: ' + files.length);
tl.debug('files to upload: ' + JSON.stringify(files));

var ftpClient = new Client();
var ftpHelper = new ftputils.FtpHelper(ftpClient);

var win = tl.osType().match(/^Win/);
tl.debug('win: ' + win);

function findFiles(): string[] {
    tl.debug('Searching for files to upload');

    var rootFolderStats = tl.stats(rootFolder);
    if (rootFolderStats.isFile()) {
        var file = rootFolder;
        tl.debug(file + ' is a file. Ignoring all file patterns');
        return [file];
    }

    var allFiles = tl.find(rootFolder);

    // filePatterns is a multiline input containing glob patterns
    tl.debug('searching for files using: ' + filePatterns.length + ' filePatterns: ' + filePatterns);

    // minimatch options
    var matchOptions = { matchBase: true, dot: true };
    if (win) {
        matchOptions["nocase"] = true;
    }

    tl.debug('Candidates found for match: ' + allFiles.length);
    for (var i = 0; i < allFiles.length; i++) {
        tl.debug('file: ' + allFiles[i]);
    }

    // use a set to avoid duplicates
    var matchingFilesSet = new SortedSet();

    for (var i = 0; i < filePatterns.length; i++) {
        var normalizedPattern: string = path.join(rootFolder, path.normalize(filePatterns[i]));

        tl.debug('searching for files, pattern: ' + normalizedPattern);

        var matched = tl.match(allFiles, normalizedPattern, matchOptions);
        tl.debug('Found total matches: ' + matched.length);
        // ensure each result is only added once
        for (var j = 0; j < matched.length; j++) {
            var match = path.normalize(matched[j]);
            var stats = tl.stats(match);
            if (!preservePaths && stats.isDirectory()) {
                // if not preserving paths, skip all directories
            } else if (matchingFilesSet.add(match)) {
                tl.debug('adding ' + (stats.isFile() ? 'file:   ' : 'folder: ') + match);
                if (stats.isFile() && preservePaths) {
                    // if preservePaths, make sure the parent directory is also included
                    var parent = path.normalize(path.dirname(match));
                    if (matchingFilesSet.add(parent)) {
                        tl.debug('adding folder: ' + parent);
                    }
                }
            }
        }
    }
    return matchingFilesSet.sorted();
}

function printProgress(message: string): void {
    var total: number = progressFilesUploaded + progressFilesSkipped + progressDirectoriesProcessed;
    var remaining: number = files.length - total + 1; // add one for the root remotePath
    console.log(
        'files uploaded: ' + progressFilesUploaded +
        ', files skipped: ' + progressFilesSkipped +
        ', directories processed: ' + progressDirectoriesProcessed +
        ', total: ' + total + ', remaining: ' + remaining +
        ', ' + message);
}

function getFinalStatusMessage(): string {
    return '\nhost: ' + serverEndpointUrl.host +
        '\npath: ' + remotePath +
        '\nfiles uploaded: ' + progressFilesUploaded +
        '\nfiles skipped: ' + progressFilesSkipped +
        '\ndirectories processed: ' + progressDirectoriesProcessed;
}

function failTask(message: string) {
    if (files) {
        var total: number = progressFilesUploaded + progressFilesSkipped + progressDirectoriesProcessed;
        var remaining: number = files.length - total;
        console.log('FTP upload failed: ' + message + getFinalStatusMessage() + '\nunprocessed files & directories: ' + remaining);
    }
    tl.setResult(tl.TaskResult.Failed, message);
}

function uploadFiles(): Q.Promise<void> {
    tl.debug('uploading files');

    var defer: Q.Deferred<void> = Q.defer<void>();

    var outerPromises: Q.Promise<void>[] = []; // these run first, and their then clauses add more promises to innerPromises
    var innerPromises: Q.Promise<void>[] = [];
    outerPromises.push(ftpHelper.createRemoteDirectory(remotePath).then(() => {
        progressDirectoriesProcessed++;
        printProgress('remote directory successfully created/verified: ' + remotePath);
    })); // ensure root remote location exists

    files.forEach((file) => {
        tl.debug('file: ' + file);
        var remoteFile: string = preservePaths ?
            path.join(remotePath, file.substring(rootFolder.length)) :
            path.join(remotePath, path.basename(file));

        remoteFile = remoteFile.replace(/\\/gi, "/"); // use forward slashes always
        tl.debug('remoteFile: ' + remoteFile);

        var stats = tl.stats(file);
        if (stats.isDirectory()) { // create directories if necessary
            outerPromises.push(ftpHelper.createRemoteDirectory(remoteFile).then(() => {
                progressDirectoriesProcessed++;
                printProgress('remote directory successfully created/verified: ' + remoteFile);
            }));
        } else if (stats.isFile()) { // upload files
            if (overwrite) {
                outerPromises.push(ftpHelper.uploadFile(file, remoteFile).then(() => {
                    progressFilesUploaded++;
                    printProgress('successfully uploaded: ' + file + ' to: ' + remoteFile);
                }));
            } else {
                outerPromises.push(ftpHelper.remoteExists(remoteFile).then((exists: boolean) => {
                    if (!exists) {
                        innerPromises.push(ftpHelper.uploadFile(file, remoteFile).then(() => {
                            progressFilesUploaded++;
                            printProgress('successfully uploaded: ' + file + ' to: ' + remoteFile);
                        }));
                    } else {
                        progressFilesSkipped++;
                        printProgress('skipping file: ' + file + ' remote: ' + remoteFile + ' because it already exists');
                    }
                }));
            }
        }
    });

    Q.all(outerPromises).then(() => {
        Q.all(innerPromises).then(() => {
            defer.resolve(null);
        }).fail((err) => {
            defer.reject(err);
        })
    }).fail((err) => {
        defer.reject(err);
    });

    return defer.promise;
}

function doWork() {

    var uploadSuccessful = false;

    ftpClient.on('greeting', (message: string) => {
        tl.debug('ftp client greeting');
        console.log('connected: ' + message);
    });

    ftpClient.on('ready', async () => {
        tl.debug('ftp client ready');
        try {
            if (clean) {
                console.log('cleaning remote directory: ' + remotePath);
                await ftpHelper.cleanRemote(remotePath);
            }

            console.log('uploading files to remote directory: ' + remotePath);
            await uploadFiles();
            uploadSuccessful = true;
            console.log('FTP upload successful ' + getFinalStatusMessage());

            tl.setResult(tl.TaskResult.Succeeded, 'FTP upload successful');
        } catch (err) {
            failTask(err);
        } finally {
            console.log('disconnecting from: ', serverEndpointUrl.host);
            ftpClient.end();
            ftpClient.destroy();
        }
    });

    ftpClient.on('close', (hadErr: boolean) => {
        console.log('disconnected');
        tl.debug('ftp client close, hadErr:' + hadErr);
    });

    ftpClient.on('end', () => {
        tl.debug('ftp client end');
    })

    ftpClient.on('error', (err) => {
        tl.debug('ftp client error, err: ' + err);
        if (!uploadSuccessful) {
            // once all files are successfully uploaded, a subsequent error should not fail the task
            failTask(err);
        }
    })

    var secure = serverEndpointUrl.protocol.toLowerCase() == 'ftps:' ? true : false;
    tl.debug('secure ftp=' + secure);

    console.log('connecting to: ' + serverEndpointUrl.host);
    ftpClient.connect({ 'host': serverEndpointUrl.host, 'user': username, 'password': password, 'secure': secure });
}

doWork();