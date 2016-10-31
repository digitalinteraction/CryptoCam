var raspicam = require('raspicam');
var bleno = require('bleno');
var crypto = require('crypto');
var encryptor = require('file-encryptor');
var path = require('path');
var fs = require('fs');

var config = {
	recordingDir: "recordings",
	videoLength: 30
};

var currentKey;
var currentCamera;
var currentOutputFile;

function advertiseKey(key) {
	var advertisementData = key; // new Buffer(key);
	bleno.startAdvertisingWithEIRData(advertisementData);
}

function generateKey(callback) {
	crypto.randomBytes(31, function(err, buffer) {
		callback(buffer);
	});
}

function encryptRecording(key, video, callback) {
	var options = { algorithm: 'aes256' };
	encryptor.encryptFile(video, path.join(__dirname, config.recordingDir, path.basename(video)), key, options, callback);
}

function deleteRecording(lastOutput) {
	fs.unlinkSync(lastOutput);
}

function newCamera(outputFile) {
	console.log(outputFile);
	var camera = new raspicam({
		mode: "video",
		output: outputFile,
		timeout: 0, //config.videoLength * 1000,
		nopreview: true
	});
	
	return camera;
}

function newRecording() {
	console.log("New recording...");

	currentOutputFile = path.join(__dirname, (new Date().toISOString()).replace(/[:TZ\.]/g, '-') + '.h264');
	currentCamera = newCamera(currentOutputFile);
	
	generateKey(function (key) {
		currentKey = key;
		
		currentCamera.start();
		console.log('Started recording: ' + currentOutputFile);
		advertiseKey(currentKey);
		console.log('Using key: ' + currentKey.toString('hex'));	
	});
}

console.log('Starting CryptoCam...');

console.log('Starting Bluetooth...');

bleno.on('stateChange', function(state) {
	console.log('STATE: ' + state);
	if (state != 'poweredOn') { return; }

	newRecording();

	setInterval(function() {
		
		console.log('Stopping video...');
		currentCamera.stop();

		setTimeout(function() {
			console.log("Video 'read'...");
			var lastKey = currentKey;
			var lastOutput = currentOutputFile; 
	
			newRecording();

			console.log("Encrypting previous recording...");		
			encryptRecording(lastKey, lastOutput, function() {
				console.log("Removing previous recording...");
				deleteRecording(lastOutput);
			});
		}, 100);	
	}, config.videoLength * 1000);
});

