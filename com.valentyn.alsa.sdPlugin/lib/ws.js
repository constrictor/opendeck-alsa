"use strict";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Valentyn Pavliuchenko

// WebSocket client for the Stream Deck plugin protocol.
//
// Node 21+ ships a global WebSocket and we use it when it is there. Node 18 and
// 20 do not, and distributions still ship 18 as their default node, so the few
// dozen lines of RFC 6455 client framing live here rather than pulling in `ws`
// and giving this plugin its first npm dependency.
//
// Only ws:// is implemented: OpenDeck builds the URL itself and it is always a
// loopback address.
//
// The fallback deliberately mimics the slice of the WHATWG interface plugin.js
// uses — addEventListener("open"/"message"/"close"/"error"), send(), readyState
// — so the two are interchangeable and neither path is a special case.

const net = require("node:net");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// Client-to-server frames must be masked (RFC 6455 §5.3); a server is required
// to drop the connection if they are not.
function encodeFrame(opcode, payload) {
	const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
	const len = data.length;
	let header;
	if (len < 126) {
		header = Buffer.alloc(2);
		header[1] = 0x80 | len;
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[1] = 0x80 | 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	header[0] = 0x80 | opcode; // FIN + opcode
	const mask = crypto.randomBytes(4);
	const masked = Buffer.allocUnsafe(len);
	for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
	return Buffer.concat([header, mask, masked]);
}

class FallbackWebSocket extends EventEmitter {
	constructor(url) {
		super();
		this.url = url;
		this.readyState = CONNECTING;
		this._socket = null;
		this._rx = Buffer.alloc(0);
		this._handshakeDone = false;
		this._fragments = [];
		this._fragmentOpcode = 0;
		this._closeSent = false;
		// Never let a socket error crash the plugin when nothing is listening.
		this.on("error", () => {});
		queueMicrotask(() => this._connect());
	}

	// The WHATWG names, so plugin.js does not care which implementation it got.
	addEventListener(type, fn) {
		this.on(type, fn);
	}
	removeEventListener(type, fn) {
		this.off(type, fn);
	}

	_connect() {
		let u;
		try {
			u = new URL(this.url);
		} catch {
			return this._fail(new Error(`invalid WebSocket URL: ${this.url}`));
		}
		if (u.protocol !== "ws:") {
			return this._fail(new Error(`unsupported WebSocket scheme ${u.protocol} (only ws:// is implemented)`));
		}

		const key = crypto.randomBytes(16).toString("base64");
		this._expectedAccept = crypto
			.createHash("sha1")
			.update(key + GUID)
			.digest("base64");

		const socket = net.connect({ host: u.hostname, port: Number(u.port) || 80 });
		this._socket = socket;
		// Plugin traffic is small and latency-sensitive; Nagle would add delay
		// waiting to coalesce frames that are already whole messages.
		socket.setNoDelay(true);

		socket.on("connect", () => {
			socket.write(
				`GET ${u.pathname || "/"}${u.search} HTTP/1.1\r\n` +
					`Host: ${u.host}\r\n` +
					"Upgrade: websocket\r\n" +
					"Connection: Upgrade\r\n" +
					`Sec-WebSocket-Key: ${key}\r\n` +
					"Sec-WebSocket-Version: 13\r\n\r\n",
			);
		});
		socket.on("data", (chunk) => this._onData(chunk));
		socket.on("error", (err) => this._fail(err));
		socket.on("close", () => this._finish());
	}

	_fail(err) {
		this.emit("error", err);
		if (this._socket) this._socket.destroy();
		else this._finish();
	}

	_finish(code = 1006, reason = "") {
		if (this.readyState === CLOSED) return;
		this.readyState = CLOSED;
		this.emit("close", { code, reason, wasClean: code === 1000 });
	}

	_onData(chunk) {
		this._rx = this._rx.length ? Buffer.concat([this._rx, chunk]) : chunk;
		if (!this._handshakeDone && !this._readHandshake()) return;
		this._readFrames();
	}

	_readHandshake() {
		const end = this._rx.indexOf("\r\n\r\n");
		if (end < 0) return false;
		const head = this._rx.subarray(0, end).toString("latin1");
		this._rx = this._rx.subarray(end + 4);

		const [status, ...lines] = head.split("\r\n");
		if (!/^HTTP\/1\.1 101\b/.test(status)) {
			this._fail(new Error(`handshake failed: ${status}`));
			return false;
		}
		const accept = lines
			.map((l) => l.split(":"))
			.filter((p) => p[0].trim().toLowerCase() === "sec-websocket-accept")
			.map((p) => p.slice(1).join(":").trim())[0];
		if (accept !== this._expectedAccept) {
			this._fail(new Error("handshake failed: bad Sec-WebSocket-Accept"));
			return false;
		}

		this._handshakeDone = true;
		this.readyState = OPEN;
		this.emit("open", {});
		return true;
	}

	_readFrames() {
		for (;;) {
			const frame = this._decode(this._rx);
			if (!frame) return;
			this._rx = this._rx.subarray(frame.size);
			this._dispatch(frame);
			if (this.readyState === CLOSED) return;
		}
	}

	_decode(buf) {
		if (buf.length < 2) return null;
		const fin = (buf[0] & 0x80) !== 0;
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
			// A conforming server never masks, but decode it rather than desync.
			if (buf.length < offset + 4) return null;
			mask = buf.subarray(offset, offset + 4);
			offset += 4;
		}
		if (buf.length < offset + len) return null;
		const payload = Buffer.from(buf.subarray(offset, offset + len));
		if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
		return { fin, opcode, payload, size: offset + len };
	}

	_dispatch(frame) {
		switch (frame.opcode) {
			case OP_PING:
				// Control frames may interleave with a fragmented message, so this
				// must not touch the fragment buffer.
				this._write(encodeFrame(OP_PONG, frame.payload));
				return;
			case OP_PONG:
				return;
			case OP_CLOSE: {
				const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
				const reason = frame.payload.subarray(2).toString("utf8");
				this.readyState = CLOSING;
				if (!this._closeSent) {
					this._closeSent = true;
					this._write(encodeFrame(OP_CLOSE, frame.payload));
				}
				if (this._socket) this._socket.end();
				this._finish(code === 1005 ? 1000 : code, reason);
				return;
			}
			case OP_CONT:
				if (!this._fragmentOpcode) return; // continuation with nothing to continue
				this._fragments.push(frame.payload);
				if (!frame.fin) return;
				this._deliver(this._fragmentOpcode, Buffer.concat(this._fragments));
				this._fragments = [];
				this._fragmentOpcode = 0;
				return;
			case OP_TEXT:
			case OP_BINARY:
				if (!frame.fin) {
					this._fragmentOpcode = frame.opcode;
					this._fragments = [frame.payload];
					return;
				}
				this._deliver(frame.opcode, frame.payload);
				return;
			default:
				return; // reserved opcode
		}
	}

	// Match the global WebSocket: text arrives as a string, binary as a Buffer.
	_deliver(opcode, payload) {
		this.emit("message", { data: opcode === OP_TEXT ? payload.toString("utf8") : payload });
	}

	_write(buf) {
		if (this._socket && this._socket.writable) this._socket.write(buf);
	}

	send(data) {
		if (this.readyState !== OPEN) throw new Error("WebSocket is not open");
		const binary = Buffer.isBuffer(data) || ArrayBuffer.isView(data);
		this._write(encodeFrame(binary ? OP_BINARY : OP_TEXT, binary ? Buffer.from(data) : String(data)));
	}

	close(code = 1000, reason = "") {
		if (this.readyState === CLOSED || this.readyState === CLOSING) return;
		if (this.readyState === CONNECTING) {
			this.readyState = CLOSING;
			if (this._socket) this._socket.destroy();
			return;
		}
		this.readyState = CLOSING;
		const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
		payload.writeUInt16BE(code, 0);
		payload.write(reason, 2, "utf8");
		this._closeSent = true;
		this._write(encodeFrame(OP_CLOSE, payload));
		if (this._socket) this._socket.end();
	}
}

FallbackWebSocket.prototype.CONNECTING = FallbackWebSocket.CONNECTING = CONNECTING;
FallbackWebSocket.prototype.OPEN = FallbackWebSocket.OPEN = OPEN;
FallbackWebSocket.prototype.CLOSING = FallbackWebSocket.CLOSING = CLOSING;
FallbackWebSocket.prototype.CLOSED = FallbackWebSocket.CLOSED = CLOSED;

// The global is preferred where it exists. Setting OPENDECK_ALSA_WS=fallback
// forces the bundled client, which is how the test suite exercises the Node 18
// path on a newer runtime.
function pickImplementation() {
	if (process.env.OPENDECK_ALSA_WS === "fallback") return FallbackWebSocket;
	return typeof globalThis.WebSocket === "function" ? globalThis.WebSocket : FallbackWebSocket;
}

module.exports = { WebSocket: pickImplementation(), FallbackWebSocket };
