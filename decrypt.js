var argv = require('minimist')(process.argv.slice(2));
var encryptor = require('file-encryptor');

var options = { algorithm: 'aes256' };
encryptor.decryptFile(argv.input, argv.output, Buffer.from(argv.key, 'hex'), options, function(err){
	if (err) {
		console.log(err);
	} else {
		console.log('Successfully decrypted file.');
	}
	process.exit();
});
