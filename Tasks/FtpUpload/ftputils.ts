/// <reference path="../../definitions/vsts-task-lib.d.ts" />
/// <reference path="../../definitions/node.d.ts" />
/// <reference path="../../definitions/Q.d.ts" />

import tl = require('vsts-task-lib/task');
import Q = require('q');
import path = require('path');

export class FtpHelper {
    ftpClient: any = null;
    constructor(ftpClient: any) {
        this.ftpClient = ftpClient;
    }

    createRemoteDirectory(remoteDirectory: string): Q.Promise<void> {
        var defer: Q.Deferred<void> = Q.defer<void>();

        tl.debug('creating remote directory: ' + remoteDirectory);

        this.ftpClient.mkdir(remoteDirectory, true, function (err) {
            if (err) {
                defer.reject('Unable to create remote directory: ' + remoteDirectory + ' due to error: ' + err);
            } else {
                defer.resolve(null);
            }
        });

        return defer.promise;
    }

    uploadFile(file: string, remoteFile: string): Q.Promise<void> {
        var defer: Q.Deferred<void> = Q.defer<void>();

        tl.debug('uploading file: ' + file + ' remote: ' + remoteFile);

        this.ftpClient.put(file, remoteFile, function (err) {
            if (err) {
                defer.reject('upload failed: ' + remoteFile + ' due to error: ' + err);
            } else {
                defer.resolve(null);
            }
        });

        return defer.promise;
    }

    remoteExists(remoteFile: string): Q.Promise<boolean> {
        var defer: Q.Deferred<boolean> = Q.defer<boolean>();

        tl.debug('checking if remote exists: ' + remoteFile);

        var remoteDirname = path.normalize(path.dirname(remoteFile));
        var remoteBasename = path.basename(remoteFile);

        this.ftpClient.list(remoteDirname, function (err, list) {
            if (err) {
                //err.code == 550  is the standard not found error
                //but just resolve false for all errors
                defer.resolve(false);
            } else {
                for (var remote of list) {
                    if (remote.name == remoteBasename) {
                        defer.resolve(true);
                        return;
                    }
                }
                defer.resolve(false);
            }
        });

        return defer.promise;
    }

    rmdir(remotePath): Q.Promise<void> {
        var defer: Q.Deferred<void> = Q.defer<void>();

        tl.debug('removing remote directory: ' + remotePath);

        this.ftpClient.rmdir(remotePath, true, function (err) {
            if (err) {
                defer.reject('Unable to clean remote folder: ' + remotePath + ' error: ' + err);
            } else {
                defer.resolve(null);
            }
        });

        return defer.promise;
    }
}