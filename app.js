var RaspiCam = require("raspicam");
var Bleno = require("bleno");
var Crypto = require("crypto");
var Encryptor = require("file-encryptor");
var Led = require("sense-hat-led");
var Path = require("path");
var Fs = require("fs");
var Url = require("url");
var Uuid = require("uuid/v1");
var Aws = require("aws-sdk");

var PrimaryService = Bleno.PrimaryService;
var Characteristic = Bleno.Characteristic;

Led.setRotation(270);

var Config = {
	baseUrl: "https://s3-eu-west-1.amazonaws.com/cryptocam/",
	awsProfile: "CryptoCam",
	encryption: "aes256",
	recordingDir: "recordings",
	videoLength: 30,
	major: 0,
	minor: 0,
	measuredPower: -59,
	deviceName: "CryptoCam",
	serviceUuid: "cc92cc92-ca19-0000-0000-000000000001",
	keyCharacUuid: "cc92cc92-ca19-0000-0000-000000000002",
	connectionTimeout: 5,
	readTimeout: 5
};

var U = [0,255,0];
var D = [255,0,0];
var Y = [255,255,0];
var O = [0,0,0];

var ledUp = [
O, O, O, U, U, O, O, O,
O, O, U, U, U, U, O, O,
O, U, U, U, U, U, U, O,
U, U, O, U, U, O, U, U,
U, O, O, U, U, O, O, U,
O, O, O, U, U, O, O, O,
O, O, O, U, U, O, O, O,
O, O, O, U, U, O, O, O
];

var ledDown = [
O, O, O, D, D, O, O, O,
O, O, O, D, D, O, O, O,
O, O, O, D, D, O, O, O,
O, O, O, D, D, O, O, D,
D, O, O, D, D, O, D, D,
D, D, O, D, D, D, D, O,
O, D, D, D, D, D, O, O,
O, O, D, D, D, O, O, O
];

var ledKey = [
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
	Bleno.startAdvertising(serviceName, serviceUuids, (error) => {
		console.log(error);
	});
}

function setupAws(profile) {
	var credentials = new Aws.SharedIniFileCredentials({ profile: profile });
	Aws.config.credentials = credentials;

	s3 = new Aws.S3({
		params: { Bucket: Config.bucketName }
	});
}

function setupWorkspace() {
	if (!Fs.existsSync(Config.recordingDir)) {
		Fs.mkdirSync(Config.recordingDir);
	}
}

function updateKeyCharac(json) {
	var data = Buffer.from(json, "utf8");
	console.log("Updated Key Characteristic: " + json);
	currentKeyBytes = data;
}

function generateKey(callback) {
	Crypto.randomBytes(31, function(err, buffer) {
		callback(buffer);
	});
}

function encryptRecording(key, video, output, callback) {
	var options = { algorithm: Config.encryption };
	Encryptor.encryptFile(video, output, key, options, callback);
}

function deleteFile(file) {
	Fs.unlinkSync(file);
}

function uploadFile(path, key, callback) {
	Fs.readFile(path, function (err, data) {
		if (err) throw err;
		s3.upload({
			Key: key,
			Body: data,
			ACL: "public-read"
		}, function (err, data) {
			callback();
		});
	});
}

function newCamera(outputFile) {
	console.log(outputFile);
	var camera = new RaspiCam({
		mode: "video",
		output: outputFile,
		timeout: 0,
		nopreview: true
	});
	
	return camera;
}

function newRecording() {
	console.log("New recording...");

	currentOutputFile = Path.join(__dirname, (new Date().toISOString()).replace(/[:TZ\.]/g, '-') + ".h264");
	currentCamera = newCamera(currentOutputFile);
	
	generateKey(function (key) {
		currentKey = key;
		currentUrl = Url.resolve(Config.baseUrl, Uuid());
		currentSubjects = 0;
		
		currentCamera.start();
		console.log("Started recording: " + currentOutputFile);
		updateKeyCharac(JSON.stringify({
			key: currentKey.toString('hex'),
			encryption: Config.encryption,
			url: currentUrl,
			reconnectIn: Config.videoLength * 1000
		}));
		console.log("Using key: " + currentKey.toString("hex"));	
	});
}

function onReadRequest(offset, callback) {
	console.log("KEY READ!!!");
	Led.setPixels(ledKey);
	if (readTimeout === null) {
		clearTimeout(connectionTimeout);
		currentSubjects++;
		callback(Characteristic.RESULT_SUCCESS, currentKeyBytes);
		readTimeout = setTimeout(function() {
			Bleno.disconnect();
		}, Config.readTimeout * 1000);
	} else {
		console.log("KEY ALREADY READ, TIMEING OUT CONNECTION!!!");
		callback(Characteristic.RESULT_SUCCESS, currentKeyBytes);
	}
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

Bleno.setServices([primaryService]);

Bleno.on("accept", function(clientAddress) {
	connectionTimeout = setTimeout(function() {
		Bleno.disconnect();
	}, Config.connectionTimeout * 1000);
});

Bleno.on("stateChange", function(state) {
	console.log("STATE: " + state);
	if (state != "poweredOn") { return; }
	
	startAdvertising(Config.deviceName, [keyCharacteristic.uuid]);

	// Countdown
	countdown(Config.videoLength - 1);

	function countdown(count) {
		if (count > 0) {
			setTimeout(function() {
				Led.showMessage(count.toString(), 0.1, [0,0,255]);
				countdown(--count);
			}, 1000);
		}
	}
	
	newRecording();

	setInterval(function() {
		console.log("Stopping video...");
		currentCamera.stop();

		setTimeout(function() {
			console.log("Video 'read'...");
			var lastKey = currentKey;
			var lastOutput = currentOutputFile;
			var lastUrl = currentUrl;
			var lastSubjectCount = currentSubjects;
			
			countdown(Config.videoLength - 1);
			newRecording();
			
			if (lastSubjectCount > 0) {
				console.log("Encrypting previous recording...");
				var encryptedPath = Path.join(__dirname, Config.recordingDir, Path.basename(lastOutput));	
				encryptRecording(lastKey, lastOutput, encryptedPath, function() {
					console.log("Uploading previous recording...");
					deleteFile(lastOutput);
					uploadFile(encryptedPath, Url.parse(lastUrl).pathname.split('/')[2], function() {
						deleteFile(encryptedPath);
						console.log("Uploaded and Removed...");
					});
				});
			} else {
				deleteFile(lastOutput);
				console.log("Key not read so deleted recording without uploading.");
			}
		}, 100);
	}, Config.videoLength * 1000);
});

