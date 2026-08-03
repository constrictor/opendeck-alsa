#!/usr/bin/env node
"use strict";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Valentyn Pavliuchenko

// Generates docs/showcase.svg for the README.
//
// The key faces and dial glyph are pulled straight out of lib/icons.js and
// nested as real SVG, so the picture cannot drift from what the plugin actually
// draws. The dial strip is laid out with the exact geometry from OpenDeck's
// $B1 layout (static/encoder_layouts/B1.json).

const fs = require("node:fs");
const path = require("node:path");
const icons = require("../com.valentyn.alsa.sdPlugin/lib/icons.js");

// icons.js hands back base64 data URIs; unwrap them so they can be nested.
function raw(uri) {
	return Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64").toString("utf8");
}

// Strip the outer <svg> wrapper's attributes so it can be re-emitted at a
// chosen position, keeping its own viewBox for scaling.
function nest(uri, x, y, size) {
	const svg = raw(uri);
	const viewBox = svg.match(/viewBox="([^"]+)"/)[1];
	const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
	return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${viewBox}">${inner}</svg>`;
}

const B1 = { title: [16, 10, 136, 24], icon: [16, 40, 48, 48], value: [76, 40, 108, 32], indicator: [76, 74, 108, 12] };

const KEY = 116;
const GAP = 18;
const PAD = 16;
const CAP_H = 22;
const STRIP_W = 200;
const STRIP_H = 100;

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const CAPTION = "#8b949e"; // legible on both light and dark GitHub themes

function caption(text, x, y, w) {
	return (
		`<text x="${x + w / 2}" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${CAPTION}">` +
		`${text}</text>`
	);
}

function dialStrip(x, y, { title, value, percent, muted, kind }) {
	const [tx, ty, tw, th] = B1.title;
	const [ix, iy, iw] = B1.icon;
	const [vx, vy, vw, vh] = B1.value;
	const [bx, by, bw, bh] = B1.indicator;
	const fill = muted ? 0 : percent;
	return (
		`<g transform="translate(${x},${y})">` +
		`<rect width="${STRIP_W}" height="${STRIP_H}" rx="10" fill="#000000"/>` +
		`<text x="${tx}" y="${ty + th / 2 + 5}" font-family="${FONT}" font-size="16" font-weight="600" fill="#dfe3ea">${title}</text>` +
		nest(icons.glyphIcon({ kind, muted }), ix, iy, iw) +
		`<text x="${vx + vw}" y="${vy + vh / 2 + 8}" text-anchor="end" font-family="${FONT}" font-size="24" font-weight="600"` +
		` fill="${muted ? "#e5484d" : "#ffffff"}">${value}</text>` +
		`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="6" fill="#33363d"/>` +
		(fill > 0 ? `<rect x="${bx}" y="${by}" width="${(bw * fill) / 100}" height="${bh}" rx="6" fill="#5b9dff"/>` : "") +
		`</g>`
	);
}

const keys = [
	{ caption: "Volume", uri: icons.volumeIcon({ kind: "playback", muted: false, percent: 75, text: "Master" }) },
	{ caption: "Volume, muted", uri: icons.volumeIcon({ kind: "playback", muted: true, percent: 75, text: "Master" }) },
	{ caption: "Mic", uri: icons.muteIcon({ kind: "capture", muted: false, percent: 100, text: "Capture" }) },
	{ caption: "Mic, muted", uri: icons.muteIcon({ kind: "capture", muted: true, percent: 100, text: "Capture" }) },
	{ caption: "Speakers, muted", uri: icons.muteIcon({ kind: "playback", muted: true, percent: 80, text: "Master" }) },
];

const width = PAD * 2 + keys.length * KEY + (keys.length - 1) * GAP + GAP * 2 + STRIP_W;
const height = PAD * 2 + KEY + CAP_H;

let body = "";
let x = PAD;
for (const k of keys) {
	body += nest(k.uri, x, PAD, KEY);
	body += caption(k.caption, x, PAD + KEY + 15, KEY);
	x += KEY + GAP;
}

x += GAP;
const stripY = PAD + (KEY - STRIP_H) / 2;
body += dialStrip(x, stripY, { title: "Master", value: "75%", percent: 75, muted: false, kind: "playback" });
body += caption("Dial touchstrip ($B1)", x, PAD + KEY + 15, STRIP_W);

const out =
	`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
	`<title>OpenDeck ALSA plugin — key faces and dial touchstrip</title>` +
	`${body}</svg>\n`;

const file = path.join(__dirname, "..", "docs", "showcase.svg");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, out);
console.log(`wrote ${path.relative(process.cwd(), file)} (${width}x${height}, ${out.length} bytes)`);
