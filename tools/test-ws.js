#!/usr/bin/env node
"use strict";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Valentyn Pavliuchenko

// Unit tests for the bundled WebSocket client (lib/ws.js), which is what runs
// on Node 18 and 20 where there is no global WebSocket. Needs no ALSA hardware.
//
//   node tools/test-ws.js

const { MockOpenDeck } = require("./mock-opendeck.js");
const { FallbackWebSocket } = require("../com.valentyn.alsa.sdPlugin/lib/ws.js");

let failures = 0;
let count = 0;

function check(name, ok, detail = "") {
	count++;
	if (!ok) failures++;
	const mark = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
	console.log(`  ${mark}  ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(emitter, event, ms = 3000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
		emitter.addEventListener(event, (e) => {
			clearTimeout(timer);
			resolve(e);
		});
	});
}

async function waitFor(pred, ms = 3000, label = "") {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const hit = pred();
		if (hit) return hit;
		await sleep(10);
	}
	throw new Error(`timed out waiting for ${label}`);
}

// Server-to-client frames are never masked, so the test can write raw frames
// onto the mock's socket to cover paths MockOpenDeck itself never produces.
function serverFrame(opcode, payload, fin = true) {
	const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
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
	header[0] = (fin ? 0x80 : 0) | opcode;
	return Buffer.concat([header, data]);
}

async function main() {
	console.log("\nTesting the bundled WebSocket client\n");

	const mock = new MockOpenDeck();
	const port = await mock.listen();
	const received = [];
	mock.on("message", (msg) => received.push(msg));

	const serverSocket = new Promise((resolve) => mock.once("connection", resolve));
	const ws = new FallbackWebSocket(`ws://127.0.0.1:${port}`);
	const errors = [];
	ws.addEventListener("error", (e) => errors.push(e));

	try {
		await once(ws, "open");
		check("completes the RFC 6455 handshake", ws.readyState === 1, `readyState=${ws.readyState}`);
		const sock = await serverSocket;

		// --- client -> server -------------------------------------------------
		ws.send(JSON.stringify({ event: "registerPlugin", uuid: "com.valentyn.alsa" }));
		const reg = await waitFor(() => received.find((m) => m.event === "registerPlugin"), 3000, "registerPlugin");
		check("sends masked text frames the server can decode", reg.uuid === "com.valentyn.alsa");

		// A base64 SVG key image is a few KB, so the 16-bit length path is the
		// one real traffic actually takes.
		const medium = "m".repeat(5000);
		ws.send(JSON.stringify({ event: "setImage", payload: { image: medium } }));
		const mediumMsg = await waitFor(() => received.find((m) => m.event === "setImage"), 3000, "5KB frame");
		check("sends payloads over 125 bytes (16-bit length)", mediumMsg.payload.image === medium, "5000 bytes");

		const large = "L".repeat(70000);
		ws.send(JSON.stringify({ event: "setFeedback", payload: { blob: large } }));
		const largeMsg = await waitFor(() => received.find((m) => m.event === "setFeedback"), 4000, "70KB frame");
		check("sends payloads over 64KB (64-bit length)", largeMsg.payload.blob === large, "70000 bytes");

		// --- server -> client -------------------------------------------------
		const inbox = [];
		ws.addEventListener("message", (e) => inbox.push(e.data));

		mock.send({ event: "willAppear", context: "ctx-1" });
		const appear = await waitFor(() => inbox.find((d) => d.includes("willAppear")), 3000, "willAppear");
		check("receives text frames as strings", typeof appear === "string" && JSON.parse(appear).context === "ctx-1");

		const big = { event: "didReceiveSettings", payload: { settings: { note: "N".repeat(200000) } } };
		mock.send(big);
		const bigIn = await waitFor(() => inbox.find((d) => d.includes("didReceiveSettings")), 4000, "200KB inbound");
		check("reassembles inbound frames split across TCP reads", JSON.parse(bigIn).payload.settings.note.length === 200000);

		// A conforming server may fragment; OpenDeck does not today, but a frame
		// arriving in pieces must not be dropped or corrupted.
		sock.write(serverFrame(0x1, '{"event":"key', false));
		sock.write(serverFrame(0x0, 'Down","context":"ctx-frag"}', true));
		const frag = await waitFor(() => inbox.find((d) => d.includes("keyDown")), 3000, "fragmented message");
		check("reassembles fragmented messages", JSON.parse(frag).context === "ctx-frag");

		// --- control frames ---------------------------------------------------
		const before = inbox.length;
		sock.write(serverFrame(0x9, "hb")); // ping
		await sleep(150);
		check("answers ping without surfacing it as a message", inbox.length === before && ws.readyState === 1);

		// The pong must come back masked, or a strict server drops the socket.
		// The mock ignores non-text frames, so assert the connection survives and
		// still carries traffic afterwards.
		mock.send({ event: "systemDidWakeUp" });
		await waitFor(() => inbox.find((d) => d.includes("systemDidWakeUp")), 3000, "post-ping message");
		check("stays usable after a ping/pong exchange", ws.readyState === 1);

		check("reported no socket errors", errors.length === 0, errors.map((e) => e.message).join("; "));

		// --- close ------------------------------------------------------------
		const closed = once(ws, "close");
		sock.write(serverFrame(0x8, Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from("bye")])));
		const ev = await closed;
		check("handles a server close frame", ev.code === 1000 && ev.reason === "bye", `code=${ev.code} reason=${ev.reason}`);
		check("ends up in the CLOSED state", ws.readyState === 3, `readyState=${ws.readyState}`);

		// --- failure modes ----------------------------------------------------
		const dead = new FallbackWebSocket("ws://127.0.0.1:1");
		const deadErr = await once(dead, "error");
		const deadClose = await once(dead, "close");
		check("emits error then close when the port is not listening", !!deadErr.message && deadClose.code === 1006);

		const bad = new FallbackWebSocket("wss://127.0.0.1:9");
		const badErr = await once(bad, "error");
		check("rejects wss:// with a clear message", /only ws:\/\/ is implemented/.test(badErr.message), badErr.message);
	} catch (err) {
		check("test run completed", false, err.message);
	} finally {
		mock.close();
		console.log(`\n${count - failures}/${count} checks passed`);
		process.exit(failures ? 1 : 0);
	}
}

main();
