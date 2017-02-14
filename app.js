const raspicam = require("raspicam");
const bleno = require("bleno");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const url = require("url");
const uuid = require("uuid/v1");
const aws = require("aws-sdk");
const glob = require("glob");
const shredfile = require("shredfile")();
const exec = require("child_process").exec;
const os = require("os");

const PrimaryService = bleno.PrimaryService;
const Characteristic = bleno.Characteristic;

const Config = {
	baseUrl: "https://s3-eu-west-1.amazonaws.com/cryptocam/",
	awsProfile: "CryptoCam",
	bucketName: "cryptocam",
	encryption: "aes256",
	videoLength: 30,
	deviceName: os.hostname(),
	serviceUuid: "cc92cc92-ca19-0000-0000-000000000001",
	keyCharacUuid: "cc92cc92-ca19-0000-0000-000000000002",
	connectionTimeout: 5,
	readTimeout: 5
};

let s3;

let currentKey;
let currentIv;
let currentCamera;
let currentOutputFile;
let currentUrl;

let currentSubjects = 0;
let currentKeyBytes;
let connectionTimeout = null;
let readTimeout = null;

let primaryService;
let keyCharacteristic;

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
	var oldRecordings =  glob.sync("*.{h264,mp4,enc}", {});
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
	crypto.randomBytes(32, function(err, key) {
		crypto.randomBytes(16, function(err, iv) {
			callback(key, iv);
		});
	});
}

function encryptRecording(key, iv, video, output, callback) {
	let cipher = crypto.createCipheriv(Config.encryption, key, iv);
	let i = fs.createReadStream(video);
	let o = fs.createWriteStream(output);
	
	i.pipe(cipher).pipe(o);
	callback();
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
	
	generateKey(function (key, iv) {
		currentKey = key;
		currentIv = iv;
		currentUrl = url.resolve(Config.baseUrl, uuid());
		currentSubjects = 0;
		
		currentCamera.start();
		console.log("Started recording: " + currentOutputFile);
		updateKeyCharac(JSON.stringify({
			key: currentKey.toString('hex'),
			iv: currentIv.toString('hex'),
			encryption: Config.encryption,
			url: currentUrl,
			reconnectIn: Config.videoLength * 1000
		}));
	});
}

function onReadRequest(offset, callback) {
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
	console.log("Bleno State: " + state);
	if (state != "poweredOn") { return; }
	
	startAdvertising(Config.deviceName, [keyCharacteristic.uuid]);
	newRecording();

	setInterval(function() {
		console.log("Stopping video...");
		currentCamera.stop();

		setTimeout(function() {
			console.log("Processing last recording...");
			let lastKey = currentKey;
			let lastIv = currentIv;
			let lastOutput = currentOutputFile;
			let lastUrl = currentUrl;
			let lastSubjectCount = currentSubjects;
			
			newRecording();
			
			if (lastSubjectCount > 0) {
				console.log("Wrapping previous recording: " + lastOutput);
				let mp4Path = path.join(__dirname, path.basename(lastOutput, ".h264")) + ".mp4";
				exec("MP4Box -fps 30 -add '" + lastOutput + "' '" + mp4Path + "'", function (error, stdout, stderr) {
					shredfile.shred(lastOutput);
					if (!error) {
						let encryptedPath = path.join(__dirname, path.basename(mp4Path, ".mp4") + ".enc");
						console.log("Encrypting previous recording: " + mp4Path);
						encryptRecording(lastKey, lastIv, mp4Path, encryptedPath, function() {
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

console.log("Waiting for Bleno to start...");
