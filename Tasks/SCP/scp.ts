/// <reference path="../../definitions/vsts-task-lib.d.ts" />

import path = require('path');
import tl = require('vsts-task-lib/task');
import fs = require('fs');
import Q = require('q');

var scp2Client = require('scp2');

function findMatchingFiles(pattern: string) : string[] {
    // Resolve files for the specified value or pattern
    var filesList : string [];
    if (pattern.indexOf('*') == -1 && pattern.indexOf('?') == -1) {
        // No pattern found, check literal path to a single file
        tl.checkPath(pattern, 'files');

        // Use the specified single file
        filesList = [pattern];

    } else {
        var firstWildcardIndex = function(str) {
            var idx = str.indexOf('*');

            var idxOfWildcard = str.indexOf('?');
            if (idxOfWildcard > -1) {
                return (idx > -1) ?
                    Math.min(idx, idxOfWildcard) : idxOfWildcard;
            }

            return idx;
        }

        // Find files matching the specified pattern
        tl.debug('Matching glob pattern: ' + pattern);

        // First find the most complete path without any matching patterns
        var idx = firstWildcardIndex(pattern);
        tl.debug('Index of first wildcard: ' + idx);
        var findPathRoot = path.dirname(pattern.slice(0, idx));

        tl.debug('find root dir: ' + findPathRoot);

        // Now we get a list of all files under this root
        var allFiles = tl.find(findPathRoot);

        // Now matching the pattern against all files
        filesList = tl.match(allFiles, pattern, {matchBase: true});

        return filesList;
    }
}

var sshEndpoint = tl.getInput('sshEndpoint', true);
var username:string = tl.getEndpointAuthorizationParameter(sshEndpoint, 'username', false);
var password:string = tl.getEndpointAuthorizationParameter(sshEndpoint, 'password', true); //passphrase is optional

var privateKey:string = tl.getEndpointDataParameter(sshEndpoint, 'privateKey', true); //private key is optional, password can be used for connecting
var hostname:string = tl.getEndpointDataParameter(sshEndpoint, 'host', false);
var port:string = tl.getEndpointDataParameter(sshEndpoint, 'port', true); //port is optional, will use 22 as default port if not specified
if(!port || port === '') {
    tl._writeLine('Using port 22 which is the default for SSH since no port was specified.');
    port = '22';
}

var sourceFiles = tl.getInput('sourceFiles');
var destPath = tl.getInput('destinationPath');

var scpConfig;
if (privateKey && privateKey !== '') {
    tl.debug('Using private key and passphrase for connecting.');
    scpConfig = {
        host: hostname,
        port: port,
        username: username,
        privateKey: privateKey,
        passphrase: password,
        path: destPath
    }
} else {
    tl.debug('Using password for connecting.');
    scpConfig = {
        host: hostname,
        port: port,
        username: username,
        password: password,
        path: destPath
    }
}

if(sourceFiles.indexOf('*') > 0 || sourceFiles.indexOf('?') > 0) {
    var filesList = findMatchingFiles(sourceFiles);
    tl.debug('filesList = ' + filesList);
    var result = Q(<any>{});
    filesList.forEach((file) => {
        result = result.then(() => {
            scp2Client.scp(file, scpConfig, function (err) {
                if (err) {
                    return Q(err);
                }
                tl.debug('Copied ' + file + ' successfully to ' + destPath + ' on remote machine.');
                return Q(0);
            })
        })
    })
    result.then(() => {
        //success
        tl.debug('Copied ' + sourceFiles + ' successfully to ' + destPath + ' on remote machine.');
    })
    .fail((err) => {
        tl.setResult(tl.TaskResult.Failed, err);
    });
} else {
    scp2Client.scp(sourceFiles, scpConfig, function (err) {
        if (err) {
            tl.setResult(tl.TaskResult.Failed, err);
        }
        tl.debug('Copied ' + sourceFiles + ' successfully to ' + destPath + ' on remote machine.')
    })
}




