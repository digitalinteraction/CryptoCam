var raspicam = require('raspicam');
var bleno = require('bleno');
var crypto = require('crypto');
var encryptor = require('file-encryptor');
var path = require('path');
var fs = require('fs');

var Config = {
	recordingDir: "recordings",
	videoLength: 30
};

function advertiseKey(key) {
	var advertisementData = new Buffer(key);
	bleno.startAdvertisingWithEIRData(advertisementData);
}

function generateKey() {
	return function(callback) {
		crypto.randomBytes(31, callback);
	};
}

function encryptRecording(key, video) {
	var options = { algorithm: 'aes256' };
	return function(callback) {
		encryptor.encryptFile('video', path.join(__dirname, path.basename(video)), key, options, callback);
	};
}

function deleteRecording(lastOutput) {
	fs.unlinkSync(lastOutput);
}

function newRecording(outputFile) {
	var camera = new raspicam({
		mode: "video",
		ouput: outputFile,
		timeout: 0
	});
	
	return camera;
}

console.log('Starting CryptoCam...');

var outputFile = path.join(__dirname, new Date().toISOString() + '.mp4');
var camera = newRecording(outputFile);
var key = await generateKey();

camera.start();
console.log('Started recording: ' + outputFile);
advertiseKey(key);
console.log('Using key: ' + key);

setInterval(function() {
	camera.stop();
	
	var lastKey = key;
	var lastOutput = outputFile;
	
	outputFile = path.join(__dirname, new Date().toISOString() + '.mp4');
	camera = newRecording(outputFile);
	key = await generateKey();
	
	camera.start();
	console.log('Started recording: ' + outputFile);
	advertiseKey(key);
	console.log('Using key: ' + key);
	
	await encryptRecording(lastKey, lastOutput);
	deleteRecording(lastOutput);
}, Config.videoLength * 1000);
