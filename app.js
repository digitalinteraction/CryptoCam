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
	baseUrl: "https://s3-eu-west-1.amazonaws.com/cryptocam",
	recordingDir: "recordings",
	videoLength: 30,
	proxUuid: "cc92cc92-ca19-0000-0000-000000000000",
	major: 0,
	minor: 0,
	measuredPower: -59,
	deviceName: "CryptoCam",
	serviceUuid: "cc92cc92-ca19-0000-0000-000000000001",
	keyCharacUuid: "cc92cc92-ca19-0000-0000-000000000002"
};

var U = [0,255,0];
var D = [255,0,0];
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

var currentKey;
var currentCamera;
var currentOutputFile;
var currentUrl;

var activeClients = 0;
var characCallbacks = [];

var primaryService;
var keyCharacteristic;

function startBeacon(proxUuid, major, minor, measuredPower) {
	Bleno.startAdvertisingIBeacon(proxUuid, major, minor, measuredPower, (error) => {
		console.log(error);
	});
}

function startAdvertising(serviceName, serviceUuids) {
	Bleno.startAdvertising(serviceName, serviceUuids, (error) => {
		console.log(error);
	});
}

function setupAws(profile) {
	var credentials = new Aws.SharedIniFileCredentials({ profile: profile });
	Aws.config.credentials = credentials;
}

function setupWorkspace() {
	if (!Fs.existsSync(Config.recordingDir)) {
		Fs.mkdirSync(Config.recordingDir);
	}
}

function updateKeyCharac(json) {
	var data = Buffer.from(json, "utf8");
	console.log("Updated Key Characteristic: " + json);
	keyCharacteristic.value = data;

	characCallbacks.forEach(function(callback) {
		callback(data);
	});
}

function generateKey(callback) {
	Crypto.randomBytes(31, function(err, buffer) {
		callback(buffer);
	});
}

function encryptRecording(key, video, output, callback) {
	var options = { algorithm: "aes256" };
	Encryptor.encryptFile(video, output, key, options, callback);
}

function deleteFile(file) {
	Fs.unlinkSync(file);
}

function uploadFile(file, url, callback) {
	// TODO: Actually upload to that URL...
	callback();
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
		
		currentCamera.start();
		console.log("Started recording: " + currentOutputFile);
		updateKeyCharac(JSON.stringify({
			key: currentKey,
			url: currentUrl
		}));
		console.log("Using key: " + currentKey.toString("hex"));	
	});
}

function subscribed(maxValueSize, updateValueCallback) {
	activeClients++;
	characCallbacks.push(updateValueCallback);
	Led.setPixels(ledUp);
}

function unsubscribed() {
	activeClients--;
	Led.setPixels(ledDown);
}

console.log("Starting CryptoCam...");

setupWorkspace();

console.log("Starting Bluetooth...");

keyCharacteristic = 
	new Characteristic({
		uuid: Config.keyCharacUuid,
		properties: ["read", "indicate"],
		secure: ["read", "indicate"],
		value: null,
		onSubscribe: subscribed,
		onUnsubscribe: unsubscribed
	});

primaryService = new PrimaryService({
	uuid: Config.serviceUuid,
	characteristics: [keyCharacteristic]
});

Bleno.setServices([primaryService]);

Bleno.on("stateChange", function(state) {
	console.log("STATE: " + state);
	if (state != "poweredOn") { return; }
	
	startAdvertising(Config.deviceName, [keyCharacteristic.uuid]);
	startBeacon(Config.proxUuid, Config.major, Config.minor, Config.measuredPower);	

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
			
			countdown(Config.videoLength - 1);
			newRecording();

			console.log("Encrypting previous recording...");
			var encryptedPath = Path.join(__dirname, Config.recordingDir, Path.basename(lastOutput));	
			encryptRecording(lastKey, lastOutput, encryptedPath, function() {
				console.log("Uploading previous recording...");
				deleteFile(lastOutput);
				uploadFile(encryptedPath, lastUrl, function() {
					deleteFile(encryptedPath);
					console.log("Uploaded and Removed...");
				});
			});
		}, 100);
	}, Config.videoLength * 1000);
});

