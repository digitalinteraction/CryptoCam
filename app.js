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
	var advertisementData = new Buffer(key);
	bleno.startAdvertisingWithEIRData(advertisementData);
}

function generateKey(callback) {
	crypto.randomBytes(31, function(err, buffer) {
		callback(buffer.toString('hex'));
	});
}

function encryptRecording(key, video, callback) {
	var options = { algorithm: 'aes256' };
	encryptor.encryptFile('video', path.join(__dirname, config.recordingDir, path.basename(video)), key, options, callback);
}

function deleteRecording(lastOutput) {
	fs.unlinkSync(lastOutput);
}

function newCamera(outputFile) {
	console.log(outputFile);
	var camera = new raspicam({
		mode: "video",
		output: outputFile,
		timeout: 0
	});
	
	return camera;
}

function newRecording() {
	currentOutputFile = path.join(__dirname, (new Date().toISOString()).replace(/[:TZ\.]/g, '-') + '.mp4');
	currentCamera = newCamera(currentOutputFile);
	
	generateKey(function (key) {
		currentKey = key;
		
		currentCamera.start();
		console.log('Started recording: ' + currentOutputFile);
		advertiseKey(currentKey);
		console.log('Using key: ' + currentKey);	
	});
}

console.log('Starting CryptoCam...');

console.log('Starting Bluetooth...');

bleno.on('stateChange', function(state) {
	console.log('STATE: ' + state);
	if (state != 'poweredOn') { return; }

	newRecording();

	setInterval(function() {
		currentCamera.stop();
	
		var lastKey = currentKey;
		var lastOutput = currentOutputFile;
	
		newRecording();
		
		encryptRecording(lastKey, lastOutput);
		deleteRecording(lastOutput);
	}, config.videoLength * 1000);
});
