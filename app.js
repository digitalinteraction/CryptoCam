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
			console.error(`Bleno Advertisement Error: ${error}`);
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
	var oldRecordings =  glob.sync("*.{h264,mp4,jpg,enc,thumb}", {});
	console.log(`Clearing ${oldRecordings.length} old recordings.`);
	for (i in oldRecordings) {
		shredfile.shred(oldRecordings[i]);
	}
}

function updateKeyCharac(json) {
	var data = Buffer.from(json, "utf8");
	console.log(`Updated Key Characteristic: ${json}`);
	currentKeyBytes = data;
}

function generateKey(callback) {
	crypto.randomBytes(32, (err, key) => {
		crypto.randomBytes(16, (err, iv) => {
			callback(key, iv);
		});
	});
}

function encryptFile(key, iv, video, output, callback) {
	let cipher = crypto.createCipheriv(Config.encryption, key, iv);
	let i = fs.createReadStream(video);
	let o = fs.createWriteStream(output);
	
	i.pipe(cipher).pipe(o);
	callback();
}

function uploadFile(path, key, callback) {
	fs.readFile(path, (err, data) => {
		if (err) throw err;
		s3.upload({
			Key: key,
			Body: data,
			ACL: "public-read"
		}, (err, data) => {
			callback(err);
		});
	});
}

function newCamera(outputFile) {
	console.log(`Recording to: ${outputFile}`);
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
	
	let currentOutput = path.join(__dirname, (new Date().toISOString()).replace(/[:TZ\.]/g, '-'));
	currentOutputFile = currentOutput + ".h264";	
	currentCamera = newCamera(currentOutputFile);
	
	generateKey((key, iv) => {
		currentKey = key;
		currentIv = iv;
		currentUrl = url.resolve(Config.baseUrl, uuid());
		currentSubjects = 0;
		
		currentCamera.start();
		console.log(`Started recording: ${currentOutputFile}`);
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
		readTimeout = setTimeout(() => {
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

bleno.on("accept", (clientAddress) => {
	readTimeout = null;
	connectionTimeout = setTimeout(() => {
		bleno.disconnect();
	}, Config.connectionTimeout * 1000);
});

bleno.on("stateChange", (state) => {
	console.log("Bleno State: " + state);
	if (state != "poweredOn") { return; }
	
	startAdvertising(Config.deviceName, [keyCharacteristic.uuid]);
	newRecording();

	setInterval(() => {
		console.log("Stopping video...");
		currentCamera.stop();

		setTimeout(() => {
			console.log("Processing last recording...");
			let lastKey = currentKey;
			let lastIv = currentIv;
			let lastOutput = currentOutputFile;
			let lastUrl = currentUrl;
			let lastSubjectCount = currentSubjects;
			
			newRecording();
			
			if (lastSubjectCount > 0) {
				console.log(`Wrapping previous recording: ${lastOutput}`);
				let outputPath = path.join(__dirname, path.basename(lastOutput, ".h264"));
				let mp4Path = outputPath + ".mp4";
				exec(`avconv -i '${lastOutput}' -c:v copy -f mp4 '${mp4Path}'`, (error, stdout, stderr) => {
					if (!error) {
						let uploadKey = url.parse(lastUrl).pathname.split('/')[2];
						console.log(`Encrypting previous recording: ${mp4Path}`);
						let encryptedVidPath = outputPath + ".enc";
						encryptFile(lastKey, lastIv, mp4Path, encryptedVidPath, () => {
							console.log(`Uploading previous recording: ${encryptedVidPath}`);
							shredfile.shred(mp4Path);
							uploadFile(encryptedVidPath, uploadKey + ".mp4", (err) => {
								if (err) {
									console.error(`Failed to upload: ${err}`);	
								} else {
									console.log("Uploaded video and Removed.");
								}
								shredfile.shred(encryptedVidPath);
							});
						});
						let thumbPath = outputPath + ".jpg";
						exec(`avconv -ss 00:00:01 -i '${lastOutput}' -vframes 1 -q:v '${thumbPath}'`, (error, stdout, stderror) => {
							console.log(`Encrypting previous thumb: ${thumbPath}`);
							shredfile.shred(lastOutput);
							let encryptedThumbPath = outputPath + ".thumb";
							encryptFile(lastKey, lastIv, thumbPath, encryptedThumbPath, () => {
								console.log(`Uploading previous thumbnail: ${encryptedThumbPath}`);
								shredfile.shred(thumbPath);
								uploadFile(encryptedThumbPath, uploadKey + ".jpg", (err) => {
									if (err) {
										console.err(`Failed to upload: ${err}`);
									} else {
										console.log("Uploaded thumb and removed.");
									}
									shredfile.shred(encryptedThumbPath);
								});
							});
						});
					} else {
						console.error(`Failed to wrap recording: ${error}, ${stderr}`);
						shredfile.shred(lastOutput);
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
