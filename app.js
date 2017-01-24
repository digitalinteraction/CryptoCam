var RaspiCam = require("raspicam");
var Bleno = require("bleno");
var Crypto = require("crypto");
var Encryptor = require("file-encryptor");
var Led = require("sense-hat-led");
var Path = require("path");
var FS = require("fs");
var AWS = require("aws-sdk");

var PrimaryService = Bleno.PrimaryService;
var Characteristic = Bleno.Characteristic;

var Config = {
	baseUrl: "https://s3-eu-west-1.amazonaws.com/cryptocam",
	recordingDir: "recordings",
	videoLength: 10,
	proxUuid: "crypto92-cam1-0000-0000-000000000000",
	major: 0,
	minor: 0,
	measuredPower: -59,
	deviceName: "CryptoCam",
	serviceUuid: "crypto92-cam1-0000-0000-000000000001",
	keyCharacUuid: "crypto92-cam1-0000-0000-000000000002"
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

var activeClients = 0;

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
	var credentials = new AWS.SharedIniFileCredentials({ profile: profile });
	AWS.config.credentials = credentials;
}

function setupWorkspace() {
	if (!FS.existsSync(Config.recordingDir)) {
		FS.mkdirSync(Config.recordingDir);
	}
}

function updateKeyCharac(json) {
	keyCharacteristic.value = new Buffer(json);
}

function generateKey(callback) {
	Crypto.randomBytes(31, function(err, buffer) {
		callback(buffer);
	});
}

function encryptRecording(key, video, callback) {
	var options = { algorithm: "aes256" };
	debugger;
	Encryptor.encryptFile(video, Path.join(__dirname, Config.recordingDir, Path.basename(video)), key, options, callback);
}

function deleteRecording(lastOutput) {
	FS.unlinkSync(lastOutput);
}

function uploadFileAndDelete(file, callback) {
	
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
		
		currentCamera.start();
		console.log("Started recording: " + currentOutputFile);
		updateKeyCharac(JSON.stringify({
			key: currentKey,
			url: Config.baseUrl
		}));
		console.log("Using key: " + currentKey.toString("hex"));	
	});
}

function subscribed(maxValueSize, updateValueCallback) {
	activeClients++;
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

Bleno.on("stateChange", function(state) {
	console.log("STATE: " + state);
	if (state != "poweredOn") { return; }
	
	startAdvertising(Config.deviceName, [keyCharacteristic.uuid]);
	startBeacon(Config.proxUuid, Config.major, Config.minor, Config.measuredPower);	
	
	newRecording();

	setInterval(function() {
		console.log("Stopping video...");
		currentCamera.stop();

		setTimeout(function() {
			console.log("Video 'read'...");
			var lastKey = currentKey;
			var lastOutput = currentOutputFile; 
	
			newRecording();
			counter(--Config.videoLength);

			console.log("Encrypting previous recording...");		
			encryptRecording(lastKey, lastOutput, function() {
				console.log("Removing previous recording...");
				deleteRecording(lastOutput);
			});
		}, 100);
	}, Config.videoLength * 1000);
	
	// Countdown
	counter(--Config.videoLength);

	function counter(count) {
		if (count > 0) {
			setTimeout(function() {
				Led.showMessage(count.toString(), 0.1, [0,0,255]);
				counter(--count);
			}, 1000);
		}
	}
});

