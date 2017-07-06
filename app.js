const raspicam = require("raspicam");
const bleno = require("bleno");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const url = require("url");
const uuid = require("uuid/v1");
const aws = require("aws-sdk");
const glob = require("glob");
const ramdisk = require("node-ramdisk");
const exec = require("child_process").exec;
const os = require("os");
const argv = require('minimist')(process.argv.slice(2));

/**
 * Author: Gerard Wilkinson, Dan Jackson
 * Description: CryptoCam
 * */

// Camera Configuration
const Config = {
	baseUrl: "https://s3-eu-west-1.amazonaws.com/cryptocam/", // Upload location for all data
	awsProfile: "CryptoCam", // Used to authenticate with AWS
	bucketName: "cryptocam", // Destination S3 bucket
	encryption: "aes256", // OpenSSL encryption function
	videoLength: 30, // Length in seconds of recording cycles
	deviceName: os.hostname(), // Use device hostname as Bleno device name
	ramdiskName: "CryptoCam", // RAM disk name
	ramdiskSize: 200, // RAM disk size in MB
	serviceUuid: "cc92cc92-ca19-0000-0000-000000000001", // Key service UUID
	keyCharacUuid: "cc92cc92-ca19-0000-0000-000000000002", // Key characteristc UUID
	connectionTimeout: 5, // Time in seconds before forced disconnect after bonding
	readTimeout: 5 // Time in seconds before forced disconnect after key read
};

const PrimaryService = bleno.PrimaryService;
const Characteristic = bleno.Characteristic;

const DEBUG = argv.debug;

// Static configuration and setup
let s3;
let disk;
let volumePoint;

let currentKey;
let currentIv;
let currentCamera;
let currentOutputFile;
let currentUrl;

let currentClient;
let currentSubjects = 0;
let currentKeyBytes;
let connectionTimeout = null;
let readTimeout = null;

let keyCharacteristic = new Characteristic({
	uuid: Config.keyCharacUuid,
	properties: ["read"],
	onReadRequest: onReadRequest
});

let primaryService = new PrimaryService({
	uuid: Config.serviceUuid,
	characteristics: [keyCharacteristic]
});

/**
 * Clear up from previous sessions.
 * @returns
 */
function setupWorkspace() {
	return new Promise((resolve, reject) => {
		disk = ramdisk(Config.ramdiskName);

		console.log(`Creating new RAM disk ${Config.ramdiskSize}MB.`);
		disk.create(Config.ramdiskSize, (err, mount) => {
			if (err) {
				reject(`Unable to create RAM disk: ${err}`);
			} else {
				volumePoint = mount;
				resolve();
			}
		});
	});
}

/**
 * Authenticate with AWS and setup S3 bucket connection.
 * @param profile
 */
function setupAws(profile) {
	var credentials = new aws.SharedIniFileCredentials({ profile: profile });
	aws.config.credentials = credentials;

	s3 = new aws.S3({
		params: { Bucket: Config.bucketName }
	});
}

/**
 * Upload file to AWS.
 * @param path
 * @param key
 */
function uploadFile(path, key) {
	return new Promise((resolve, reject) => {
		fs.readFile(path, (ferr, data) => {
			if (!ferr) {
				s3.upload({
					Key: key,
					Body: data,
					ACL: "public-read"
				}, (uerr, data) => {
					if (!uerr) {
						resolve(data);
					} else {
						reject(`Unable to upload file: ${uerr}`);
						if (DEBUG) console.error(uerr);
					}
				});
			} else {
				reject(`Unable to read file (${path}) for upload: ${ferr}`);
				if (DEBUG) console.error(ferr);
			}
		});
	});
}

/**
 * Create new camera to record.
 * @param outputFile
 * @returns
 */
function newCamera(outputFile) {
	var camera = new raspicam({
		mode: "video",
		output: outputFile,
		timeout: 0,
		nopreview: true
	});
		
	return camera;
}

/**
 * Generate new key, paths and start new recording.
 */
async function newRecording() {
	console.log("Starting new recording...");
	
	let currentOutput = path.join(volumePoint, (new Date().toISOString()).replace(/[:TZ\.]/g, '-'));
	currentOutputFile = currentOutput + ".h264";	
	currentCamera = newCamera(currentOutputFile);
	currentCamera.start();
	console.log(`Started recording: ${currentOutputFile}`);

	currentUrl = url.resolve(Config.baseUrl, uuid());
	currentSubjects = 0;

	let result = await generateKey();
	currentKey = result.key;
	currentIv = result.iv;
	updateKeyCharac(JSON.stringify({
		key: currentKey.toString('hex'),
		iv: currentIv.toString('hex'),
		encryption: Config.encryption,
		url: currentUrl,
		reconnectIn: Config.videoLength * 1000
	}));
}

/**
 * Process previous recording. Encrypt, upload, remove.
 * @param outputFile
 * @param key
 * @param iv
 * @param url
 */
async function processRecording(outputFile, key, iv, destinationUrl) {
	let outputPath = path.join(volumePoint, path.basename(outputFile, ".h264"));

	console.log(`Wrapping previous recording: ${outputFile}`);

	try {
		// Wrap video
		let mp4Path = outputPath + ".mp4";
		await wrapRecording(outputFile, mp4Path);
		let uploadKey = url.parse(destinationUrl).pathname.split('/')[2];

		// Grab thumb
		let thumbPath = outputPath + ".jpg";
		await grabFrame(mp4Path, thumbPath);

		// Encrypt video and thumb
		console.log(`Encrypting previous recording: ${mp4Path}`);
		let encryptedVidPath = outputPath + ".enc";
		let encryptedThumbPath = outputPath + ".thumb";
		await Promise.all([encryptFile(key, iv, mp4Path, encryptedVidPath), encryptFile(key, iv, thumbPath, encryptedThumbPath)]);

		// Upload video
		console.log(`Uploading previous recording: ${encryptedVidPath}`);
		await Promise.all([uploadFile(encryptedVidPath, uploadKey + ".mp4"), uploadFile(encryptedThumbPath, uploadKey + ".jpg")]);
		console.log("PREVIOUS RECORDING SUCCESSFULLY PROCESSED!!!");
	} catch (err) {
		console.error(`Unable to process previous recording: ${err}`);
		if (DEBUG) console.error(err);
	} finally {
		// Clean up
		try {
			await Promise.all([removeFile(outputFile), removeFile(mp4Path), removeFile(encryptedVidPath), removeFile(thumbPath), removeFile(encryptedThumbPath)]);
		} catch (err) {
			// Expected, deleted in order of creation.
		}
	}
}

/**
 * Wraps h264 recording in mp4 using avconv.
 * @param input
 * @param output
 * @returns
 */
async function wrapRecording(input, output) {
	return new Promise((resolve, reject) => {
		exec(`avconv -i '${input}' -c:v copy -f mp4 '${output}'`, (error, stdout, stderr) => {
			if (error) {
				reject(`Failed to wrap recording: ${error}, ${stderr}`);
				if (DEBUG) console.error(error);
			}
		}).on("exit", () => {
			resolve();
		});
	});
}

/**
 * Grabs frame from mp4 using avconv.
 * @param input
 * @param output
 * @returns
 */
async function grabFrame(input, output) {
	return new Promise((resolve, reject) => {
		exec(`avconv -ss 00:00:00 -i '${input}' -vframes 1 -q:v 2 '${output}'`, (error, stdout, stderr) => {
			if (error) {
				reject(`Failed grab frame: ${error}, ${stderr}`);
				if (DEBUG) console.error(error, stderr);
			}
		}).on("exit", () => {
			resolve();
		});
	});
}

/**
 * Encrypt file.
 * @param key
 * @param iv
 * @param input
 * @param output
 * @returns
 */
async function encryptFile(key, iv, input, output) {
	return new Promise((resolve, reject) => {
		let cipher = crypto.createCipheriv(Config.encryption, key, iv);
		let i = fs.createReadStream(input);
		let o = fs.createWriteStream(output);

		let e = i.pipe(cipher).pipe(o);

		e.on("error", (err) => {
			reject(`Unable to encrypt file: ${err}`);
			if (DEBUG) console.error(err);
		});

		e.on("finish", () => {
			resolve();
		});
	});
}

/**
 * Securely remove file.
 * @param path
 * @returns
 */
async function removeFile(path) {
	return new Promise((resolve, reject) => {
		fs.unlink(path, (err) => {
			if (err) {
				reject(`Failed to remove file ${path}: ${err}.`);
				if (DEBUG) console.error(err);
			} else {
				resolve();
			}
		});
	});
}

/**
 * Generate new key and initial vector.
 * @returns
 */
function generateKey() {
	return new Promise((resolve, reject) => {
		crypto.randomBytes(32, (kerr, key) => {
			if (kerr) {
				reject(`Unable to generate key: ${kerr}`);
				if (DEBUG) console.error(kerr);
			} else {
				crypto.randomBytes(16, (iverr, iv) => {
					if (iverr) {
						reject(`Unable to generate iv: ${iverr}`);
						if (DEBUG) console.error(iverr);
					} else {
						resolve({ key: key, iv: iv });
					}
				});
			}
		});
	});
}

/**
 * Start Bleno advertising services.
 * @param serviceName
 * @param serviceUuids
 */
function startAdvertisingService(serviceName, serviceUuids) {
	bleno.startAdvertising(serviceName, serviceUuids, (error) => {
		if (error) {
			console.error(`Bleno Advertisement Error: ${error}`);
			if (DEBUG) console.error(error);
		}
	});
}

/**
 * Update key characteristc value.
 * @param json
 */
function updateKeyCharac(json) {
	var data = Buffer.from(json, "utf8");
	if (DEBUG) console.log(`Updated Key Characteristic: ${json}`);
	currentKeyBytes = data;
}

/**
 * Bleno key characteristic read handler.
 * @param offset
 * @param callback
 */
function onReadRequest(offset, callback) {
	if (readTimeout === null) {
		if (DEBUG) console.log(`KEY READ: ${currentClient}`);
		clearTimeout(connectionTimeout);
		currentSubjects++;
		readTimeout = setTimeout(() => {
			bleno.disconnect();
		}, Config.readTimeout * 1000);
	}
	callback(Characteristic.RESULT_SUCCESS, currentKeyBytes.slice(offset));
}

/**
 * Configures and starts Bleno.
 */
function startBleno() {
	console.log("Setting up Bleno...");
	bleno.setServices([primaryService]);

	bleno.on("accept", (clientAddress) => {
		currentClient = clientAddress;
		readTimeout = null;
		connectionTimeout = setTimeout(() => {
			bleno.disconnect();
		}, Config.connectionTimeout * 1000);
	});

	bleno.on("stateChange", (state) => {
		console.log("Bleno State: " + state);
		if (state != "poweredOn") { return; }
	
		startAdvertisingService(Config.deviceName, [keyCharacteristic.uuid]);		
		newRecording();

		setInterval(() => {
			console.log("Stopping recording...");
			currentCamera.stop();

			setTimeout(() => {
				console.log("Processing last recording...");
				if (currentSubjects > 0) {
					processRecording(currentOutputFile, currentKey, currentIv, currentUrl);
				} else {
					removeFile(currentOutputFile);
					console.log("Key not read so deleted recording without uploading.");
				}
				newRecording();
			}, 100);
		}, Config.videoLength * 1000);
	});
}

/**
 * Starts CryptoCam.
 */
async function startCryptoCam() {
	process.on('exit', () => {
		disk.delete(volumePoint, (err) => {
			if (err) {
				console.log(`Failed to destroy RAM disk: ${err}`);
			} else {
				console.log("RAM disk destroyed.");
			}
		});
	});

	await setupWorkspace();
	setupAws(Config.awsProfile);
	startBleno();
}

console.log("Starting CryptoCam...");
startCryptoCam();
