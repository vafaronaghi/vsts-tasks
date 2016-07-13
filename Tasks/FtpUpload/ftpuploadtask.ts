/// <reference path="../../definitions/vsts-task-lib.d.ts" />
/// <reference path="../../definitions/node.d.ts" />
/// <reference path="../../definitions/Q.d.ts" />

import path = require('path');
import tl = require('vsts-task-lib/task');
import url = require('url');
import Q = require('q');

import ftputils = require('./ftputils');

var SortedSet = require('collections/sorted-set');
var Client = require('ftp');

var win = tl.osType().match(/^Win/);
tl.debug('win: ' + win);

var repoRoot: string = tl.getVariable('build.sourcesDirectory');
function makeAbsolute(normalizedPath: string): string {
    tl.debug('makeAbsolute:' + normalizedPath);

    var result = normalizedPath;
    if (!path.isAbsolute(normalizedPath)) {
        result = path.join(repoRoot, normalizedPath);
        tl.debug('Relative file path: ' + normalizedPath + ' resolving to: ' + result);
    }
    return result;
}

// server endpoint
var serverEndpoint = tl.getInput('serverEndpoint', true);
var serverEndpointUrl: url.Url = url.parse(tl.getEndpointUrl(serverEndpoint, false));

var serverEndpointAuth = tl.getEndpointAuthorization(serverEndpoint, false);
var username = serverEndpointAuth['parameters']['username'];
var password = serverEndpointAuth['parameters']['password'];

// the root location which will be uploaded from
var rootFolder: string = makeAbsolute(path.normalize(tl.getPathInput('rootFolder', true).trim()));
if (!tl.exist(rootFolder)) {
    failTask('The specified root folder does not exist: ' + rootFolder);
}

var clean: boolean = tl.getBoolInput('clean', true);
var overwrite: boolean = tl.getBoolInput('overwrite', true);
var preservePaths: boolean = tl.getBoolInput('preservePaths', true);

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
    var filePatterns: string[] = tl.getDelimitedInput('filePatterns', '\n', true);
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

var remotePath = tl.getInput('remotePath', true).trim();

var filesUploaded: number = 0;
var filesSkipped: number = 0; // already exists and overwrite mode off
var directoriesProcessed: number = 0;

var files = findFiles();
tl.debug('number of files to upload: ' + files.length);
tl.debug('files to upload: ' + JSON.stringify(files));

var ftpClient = new Client();
var ftpHelper = new ftputils.FtpHelper(ftpClient);

function printStatus(message: string): void {
    var total: number = filesUploaded + filesSkipped + directoriesProcessed;
    var remaining: number = files.length - total + 1; // add one for the root remotePath
    console.log(
        'files uploaded: ' + filesUploaded +
        ', files skipped: ' + filesSkipped +
        ', directories processed: ' + directoriesProcessed +
        ', total: ' + total + ', remaining: ' + remaining +
        ', ' + message);
}

function getFinalStatusMessage(): string {
    return '\nhost: ' + serverEndpointUrl.host +
        '\npath: ' + remotePath +
        '\nfiles uploaded: ' + filesUploaded +
        '\nfiles skipped: ' + filesSkipped +
        '\ndirectories processed: ' + directoriesProcessed;
}

function failTask(message: string) {
    if (files) {
        var total: number = filesUploaded + filesSkipped + directoriesProcessed;
        var remaining: number = files.length - total;
        message = message + getFinalStatusMessage() + '\nunprocessed files & directories: ' + remaining;
    }
    tl.setResult(tl.TaskResult.Failed, message);
}

function cleanRemoteIfRequired(): Q.Promise<void> {
    var defer: Q.Deferred<void> = Q.defer<void>();

    if (clean) {
        var cleanPromises = [];
        var nestedCleanPromises = [];

        tl.debug('cleaning remote: ' + remotePath);
        cleanPromises.push(ftpHelper.remoteExists(remotePath).then((exists: boolean) => {
            if (exists) {
                nestedCleanPromises.push(ftpHelper.rmdir(remotePath));
            }
        }));

        //block until the remote directory is cleaned
        Q.all(cleanPromises).then(() => {
            Q.all(nestedCleanPromises).then(() => {
                defer.resolve(null);
            }).fail(failTask);
        }).fail(failTask);
    } else {
        defer.resolve(null);
    }

    return defer.promise;
}


async function uploadFiles() {
    tl.debug('connected to ftp host:' + serverEndpointUrl.host);

    tl.debug('files to process: ' + files.length);

    var defer: Q.Deferred<void> = Q.defer<void>();

    cleanRemoteIfRequired().then(() => {
        var promises = [];
        var nestedPromises = [];
        promises.push(ftpHelper.createRemoteDirectory(remotePath).then(() => {
            directoriesProcessed++;
            printStatus('remote directory successfully created/verified: ' + remotePath);
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
                promises.push(ftpHelper.createRemoteDirectory(remoteFile).then(() => {
                    directoriesProcessed++;
                    printStatus('remote directory successfully created/verified: ' + remoteFile);
                }));
            } else if (stats.isFile()) { // upload files
                if (overwrite) {
                    promises.push(ftpHelper.uploadFile(file, remoteFile).then(() => {
                        filesUploaded++;
                        printStatus('successfully uploaded: ' + file + ' to: ' + remoteFile);
                    }));
                } else {
                    promises.push(ftpHelper.remoteExists(remoteFile).then((exists: boolean) => {
                        if (!exists) {
                            nestedPromises.push(ftpHelper.uploadFile(file, remoteFile).then(() => {
                                filesUploaded++;
                                printStatus('successfully uploaded: ' + file + ' to: ' + remoteFile);
                            }));
                        } else {
                            filesSkipped++;
                            printStatus('skipping file: ' + file + ' remote: ' + remoteFile + ' because it already exists');
                        }
                    }));
                }
            }
        });

        Q.all(promises).then(() => {
            Q.all(nestedPromises).then(() => {
                tl.setResult(tl.TaskResult.Succeeded, 'FTP upload successful' + getFinalStatusMessage());
                ftpClient.end();
                ftpClient.destroy();
                defer.resolve(null);
            }).fail(failTask);
        }).fail(failTask);
    }).fail(failTask);
}

ftpClient.on('ready', uploadFiles);

var secure = serverEndpointUrl.protocol.toLowerCase() == 'ftps:' ? true : false;
tl.debug('secure ftp=' + secure);

ftpClient.connect({ 'host': serverEndpointUrl.host, 'user': username, 'password': password, 'secure': secure });