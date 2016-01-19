/// <reference path="../../definitions/vsts-task-lib.d.ts" />

import path = require('path');
import tl = require('vsts-task-lib/task');
import fs = require('fs');
tl.setResourcePath(path.join( __dirname, 'task.json'));

var bash = tl.createToolRunner(tl.which('bash', true));

var cwd = tl.getPathInput('cwd', false);
var script = tl.getInput('script', false);
var failOnStdErr = tl.getBoolInput('failOnStandardError', false);
var scriptPath = tl.getPathInput('scriptPath', false);
var type = tl.getInput('type');

if(type == 'InlineScript'){
	if (cwd == null || cwd == "") {
		cwd = "/tmp";
	}
			
	tl.debug('using cwd: ' + cwd);
	tl.cd(cwd);
	
	scriptPath = cwd + "/user_script.sh"; 
	fs.writeFileSync(scriptPath,script,'utf8');
	
	bash.arg(scriptPath);
	bash.exec(<any>{ failOnStdErr: failOnStdErr})
	.then(function(code) {
		// TODO: switch to setResult in the next couple of sprints
		tl.exit(code);
	})
	.fail(function(err) {
		console.error(err.message);
		tl.debug('taskRunner fail');
		tl.exit(1);
	});
}else {
    // type == 'FilePath' or not mentioned so by default Filepath
	if(!scriptPath){
		tl.warning("No script to execute");
		tl.exit(1);
	}
    
	if (!cwd) {
		cwd = path.dirname(scriptPath);
	}
    
	tl.debug('using cwd: ' + cwd);
	tl.cd(cwd);
    
	bash.arg(scriptPath);
	bash.arg(tl.getInput('args', false));
	bash.exec(<any>{ failOnStdErr: failOnStdErr})
	.then(function(code) {
		// TODO: switch to setResult in the next couple of sprints
		tl.setResult(tl.TaskResult.Succeeded, tl.loc('BashReturnCode', code));
	})
	.fail(function(err) {
		tl.debug('taskRunner fail');
	    tl.setResult(tl.TaskResult.Failed, tl.loc('BashFailed', err.message));
	});
}
