"use strict";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Valentyn Pavliuchenko

// Minimal WebSocket server standing in for OpenDeck, for integration testing.
// Node ships a WebSocket *client* but no server, and this plugin has no npm
// dependencies, so the few dozen lines of RFC 6455 framing live here instead.

const http = require("node:http");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(payload) {
	const data = Buffer.from(payload, "utf8");
	const len = data.length;
	let header;
	if (len < 126) {
		header = Buffer.alloc(2);
		header[1] = len;
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	header[0] = 0x81; // FIN + text
	return Buffer.concat([header, data]);
}

class MockOpenDeck extends EventEmitter {
	constructor() {
		super();
		this.sockets = new Set();
		this.server = http.createServer((_, res) => res.end("mock"));
		this.server.on("upgrade", (req, socket) => this._upgrade(req, socket));
	}

	listen() {
		return new Promise((resolve) => {
			this.server.listen(0, "127.0.0.1", () => resolve(this.server.address().port));
		});
	}

	_upgrade(req, socket) {
		const key = req.headers["sec-websocket-key"];
		const accept = crypto
			.createHash("sha1")
			.update(key + GUID)
			.digest("base64");
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		this.sockets.add(socket);
		socket.on("close", () => this.sockets.delete(socket));
		socket.on("error", () => this.sockets.delete(socket));

		let buf = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			for (;;) {
				const frame = this._decode(buf);
				if (!frame) break;
				buf = buf.subarray(frame.size);
				if (frame.opcode === 0x8) {
					socket.end();
					return;
				}
				if (frame.opcode === 0x1) {
					try {
						this.emit("message", JSON.parse(frame.payload), socket);
					} catch {
						/* ignore malformed */
					}
				}
			}
		});
		this.emit("connection", socket);
	}

	_decode(buf) {
		if (buf.length < 2) return null;
		const opcode = buf[0] & 0x0f;
		const masked = (buf[1] & 0x80) !== 0;
		let len = buf[1] & 0x7f;
		let offset = 2;
		if (len === 126) {
			if (buf.length < 4) return null;
			len = buf.readUInt16BE(2);
			offset = 4;
		} else if (len === 127) {
			if (buf.length < 10) return null;
			len = Number(buf.readBigUInt64BE(2));
			offset = 10;
		}
		let mask = null;
		if (masked) {
			if (buf.length < offset + 4) return null;
			mask = buf.subarray(offset, offset + 4);
			offset += 4;
		}
		if (buf.length < offset + len) return null;
		const data = Buffer.from(buf.subarray(offset, offset + len));
		if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
		return { opcode, payload: data.toString("utf8"), size: offset + len };
	}

	send(obj) {
		const frame = encodeFrame(JSON.stringify(obj));
		for (const s of this.sockets) s.write(frame);
	}

	close() {
		for (const s of this.sockets) s.destroy();
		this.server.close();
	}
}

module.exports = { MockOpenDeck };
