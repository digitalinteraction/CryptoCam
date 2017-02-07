const raspicam = require("raspicam");
const bleno = require("bleno");
const crypto = require("crypto");
const encryptor = require("file-encryptor");
const led = require("sense-hat-led");
const path = require("path");
const fs = require("fs");
const url = require("url");
const uuid = require("uuid/v1");
const aws = require("aws-sdk");
const glob = require("glob");
const shredfile = require("shredfile")();
const exec = require("child_process").exec;

const PrimaryService = bleno.PrimaryService;
const Characteristic = bleno.Characteristic;

const Config = {
	baseUrl: "https://s3-eu-west-1.amazonaws.com/cryptocam/",
	awsProfile: "CryptoCam",
	bucketName: "cryptocam",
	encryption: "aes256",
	videoLength: 30,
	deviceName: "CryptoCam",
	serviceUuid: "cc92cc92-ca19-0000-0000-000000000001",
	keyCharacUuid: "cc92cc92-ca19-0000-0000-000000000002",
	connectionTimeout: 5,
	readTimeout: 5
};

const U = [0,255,0];
const D = [255,0,0];
const Y = [255,255,0];
const O = [0,0,0];

const ledUp = [
O, O, O, U, U, O, O, O,
O, O, U, U, U, U, O, O,
O, U, U, U, U, U, U, O,
U, U, O, U, U, O, U, U,
U, O, O, U, U, O, O, U,
O, O, O, U, U, O, O, O,
O, O, O, U, U, O, O, O,
O, O, O, U, U, O, O, O
];

const ledDown = [
O, O, O, D, D, O, O, O,
O, O, O, D, D, O, O, O,
O, O, O, D, D, O, O, O,
O, O, O, D, D, O, O, D,
D, O, O, D, D, O, D, D,
D, D, O, D, D, D, D, O,
O, D, D, D, D, D, O, O,
O, O, D, D, D, O, O, O
];

const ledKey = [
O, O, O, O, O, O, O, O,
O, O, O, O, O, O, O, O,
O, O, O, O, O, Y, Y, O,
Y, Y, Y, Y, Y, O, O, Y,
Y, Y, Y, Y, Y, O, O, Y,
Y, Y, O, O, O, Y, Y, O,
O, O, O, O, O, O, O, O,
O, O, O, O, O, O, O, O
];

var s3;

var currentKey;
var currentCamera;
var currentOutputFile;
var currentUrl;

var currentSubjects = 0;
var currentKeyBytes;
var connectionTimeout = null;
var readTimeout = null;

var primaryService;
var keyCharacteristic;

function startAdvertising(serviceName, serviceUuids) {
	bleno.startAdvertising(serviceName, serviceUuids, (error) => {
		if (error) {
			console.error("Bleno Advertisement Error: " + error);
		}
	});
}

function setupAws(profile) {
	var credentials = new aws.SharedIniFileCredentials({ profile: profile });
	aws.config.credentials = credentials;

	s3 = new aws.S3({
		params: { Bucket: Config.bucketName }
	});
}

function setupWorkspace() {
	var oldRecordings =  glob.sync("*.{h264,mp4}", {});
	console.log("Clearing old recordings...");
	for (i in oldRecordings) {
		shredfile.shred(oldRecordings[i]);
	}
}

function updateKeyCharac(json) {
	var data = Buffer.from(json, "utf8");
	console.log("Updated Key Characteristic: " + json);
	currentKeyBytes = data;
}

function generateKey(callback) {
	crypto.randomBytes(32, function(err, buffer) {
		callback(buffer);
	});
}

function encryptRecording(key, video, output, callback) {
	var options = { algorithm: Config.encryption };
	encryptor.encryptFile(video, output, key, options, callback);
}

function uploadFile(path, key, callback) {
	fs.readFile(path, function (err, data) {
		if (err) throw err;
		s3.upload({
			Key: key,
			Body: data,
			ACL: "public-read"
		}, function (err, data) {
			callback(err);
		});
	});
}

function newCamera(outputFile) {
	console.log("Recording to: " + outputFile);
	var camera = new raspicam({
		mode: "video",
		output: outputFile,
		timeout: 0,
		nopreview: true
	});
	
	return camera;
}

function newRecording() {
	console.log("Starting new recording...");

	currentOutputFile = path.join(__dirname, (new Date().toISOString()).replace(/[:TZ\.]/g, '-') + ".h264");
	currentCamera = newCamera(currentOutputFile);
	
	generateKey(function (key) {
		currentKey = key;
		currentUrl = url.resolve(Config.baseUrl, uuid());
		currentSubjects = 0;
		
		currentCamera.start();
		console.log("Started recording: " + currentOutputFile);
		updateKeyCharac(JSON.stringify({
			key: currentKey.toString('hex'),
			url: currentUrl,
			reconnectIn: Config.videoLength * 1000
		}));
	});
}

function onReadRequest(offset, callback) {
	led.setPixels(ledKey);
	if (readTimeout === null) {
		console.log("KEY READ!!!");
		clearTimeout(connectionTimeout);
		currentSubjects++;
		readTimeout = setTimeout(function() {
			bleno.disconnect();
		}, Config.readTimeout * 1000);
	} else {
		console.log("KEY ALREADY READ, TIMEING OUT CONNECTION!!!");
	}
	callback(Characteristic.RESULT_SUCCESS, currentKeyBytes.slice(offset));
}

console.log("Starting CryptoCam...");

setupWorkspace();
setupAws(Config.awsProfile);
led.sync.setRotation(270);

console.log("Starting Bluetooth...");

keyCharacteristic = 
	new Characteristic({
		uuid: Config.keyCharacUuid,
		properties: ["read"],
		onReadRequest: onReadRequest
	});

primaryService = new PrimaryService({
	uuid: Config.serviceUuid,
	characteristics: [keyCharacteristic]
});

bleno.setServices([primaryService]);

bleno.on("accept", function(clientAddress) {
	readTimeout = null;
	connectionTimeout = setTimeout(function() {
		bleno.disconnect();
	}, Config.connectionTimeout * 1000);
});

bleno.on("stateChange", function(state) {
	console.log("Bluetooth State: " + state);
	if (state != "poweredOn") { return; }
	
	startAdvertising(Config.deviceName, [keyCharacteristic.uuid]);
	countdown(Config.videoLength - 1);

	function countdown(count) {
		if (count > 0) {
			setTimeout(function() {
				led.showMessage(count.toString(), 0.1, [0,0,255]);
				countdown(--count);
			}, 1000);
		}
	}
	
	newRecording();

	setInterval(function() {
		console.log("Stopping video...");
		currentCamera.stop();

		setTimeout(function() {
			console.log("Processing last recording...");
			var lastKey = currentKey;
			var lastOutput = currentOutputFile;
			var lastUrl = currentUrl;
			var lastSubjectCount = currentSubjects;
			
			countdown(Config.videoLength - 1);
			newRecording();
			
			if (lastSubjectCount > 0) {
				console.log("Wrapping previous recording: " + lastOutput);
				var mp4Path = path.join(__dirname, path.basename(lastOutput, ".h264")) + ".mp4";
				exec("MP4Box -fps 30 -add '" + lastOutput + "' '" + mp4Path + "'", function (error, stdout, stderr) {
					shredfile.shred(lastOutput);
					if (!error) {
						var encryptedPath = path.join(__dirname, path.basename(mp4Path, ".mp4") + ".enc");
						console.log("Encrypting previous recording: " + mp4Path);
						encryptRecording(lastKey, mp4Path, encryptedPath, function() {
							console.log("Uploading previous recording: " + encryptedPath);
							shredfile.shred(mp4Path);
							uploadFile(encryptedPath, url.parse(lastUrl).pathname.split('/')[2], function(err) {
								if (err) {
									console.error("Failed to upload: " + err);	
								} else {
									console.log("Uploaded and Removed.");
								}
								shredfile.shred(encryptedPath);
							});
						});
					} else {
						console.error("MP4Box failed to wrap recording: " + error + stderr);
					}
				});
			} else {
				shredfile.shred(lastOutput);
				console.log("Key not read so deleted recording without uploading.");
			}
		}, 100);
	}, Config.videoLength * 1000);
});
