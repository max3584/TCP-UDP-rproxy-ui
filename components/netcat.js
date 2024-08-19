const NetcatClient = require('netcat/client');

function validatePort(port) {
	port = parseInt(port);
	if (!Number.isInteger(port) || port < 0) {
		throw new Error('Invalid port number');
	}
	return port;
}

function sendToServer(addr, port, data) {
	port = validatePort(port);
	const client = new NetcatClient();
	console.log(`Sending data to ${addr}:${port}`);
	console.log(data);
	client.addr(addr).port(port).connect().send(data);
}

module.exports = { sendToServer };