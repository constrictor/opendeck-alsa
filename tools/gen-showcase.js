#!/usr/bin/env node
"use strict";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Valentyn Pavliuchenko

// Generates the README artwork.
//
//   docs/showcase.svg  — the vector source, always written.
//   docs/showcase.png  — what the hardware actually displays, written when a
//                        headless Chrome/Chromium is on PATH.
//
// The second one exists because the first one flatters us. OpenDeck rasterises
// a key image into a 144x144 canvas and hands it to elgato-streamdeck, which
// does `resize_exact(120, 120, FilterType::Nearest)` before sending it to a
// Stream Deck +. Nearest-neighbour at 6:5 drops every sixth row and column and
// point-samples the antialiased edges away, so a pristine vector render is not
// what anyone sees on the panel. The PNG applies that decimation so the README
// shows the real thing.
//
// The key faces and dial glyph are pulled straight out of lib/icons.js and
// nested as real SVG, so the picture cannot drift from what the plugin actually
// draws. The dial strip is laid out with the exact geometry from OpenDeck's
// $B1 layout (static/encoder_layouts/B1.json); it is written to the LCD at its
// native 200x100 and so escapes the decimation the keys get.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const icons = require("../com.valentyn.alsa.sdPlugin/lib/icons.js");
const png = require("./png.js");

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
	{ caption: "Volume up", uri: icons.volumeStepIcon({ kind: "playback", muted: false, percent: 75, text: "Master" }, 1) },
	{ caption: "Volume down", uri: icons.volumeStepIcon({ kind: "playback", muted: false, percent: 75, text: "Master" }, -1) },
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

const docs = path.join(__dirname, "..", "docs");
fs.mkdirSync(docs, { recursive: true });
const svgFile = path.join(docs, "showcase.svg");
fs.writeFileSync(svgFile, out);
console.log(`wrote ${path.relative(process.cwd(), svgFile)} (${width}x${height}, ${out.length} bytes)`);

// ------------------------------------------------- device-accurate rendering

const CANVAS = 144; // OpenDeck's key canvas, from rendererHelper.ts
const DEVICE = 120; // Stream Deck + key, from elgato-streamdeck's Kind::Plus
const ZOOM = 2; // integer, so the decimated pixels stay crisp when enlarged

function findBrowser() {
	for (const bin of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "brave-browser"]) {
		try {
			execFileSync("command", ["-v", bin], { shell: "/bin/sh", stdio: "ignore" });
			return bin;
		} catch {
			// keep looking
		}
	}
	return null;
}

function shoot(browser, dir, htmlFile, outFile, w, h) {
	execFileSync(
		browser,
		[
			"--headless",
			"--disable-gpu",
			"--no-sandbox",
			"--hide-scrollbars",
			`--screenshot=${outFile}`,
			`--window-size=${w},${h}`,
			"--force-device-scale-factor=1",
			htmlFile,
		],
		{ cwd: dir, stdio: "ignore" },
	);
	if (!fs.existsSync(path.join(dir, outFile))) throw new Error(`${browser} wrote no screenshot`);
	return png.decode(fs.readFileSync(path.join(dir, outFile)));
}

const browser = findBrowser();
if (!browser) {
	console.log("no headless Chrome/Chromium on PATH — skipping docs/showcase.png");
	process.exit(0);
}

// A snap-confined Chromium cannot write into /tmp or into a dot-directory under
// $HOME, so the scratch directory has to be a plain one inside the repo.
const work = fs.mkdtempSync(path.join(docs, "showcase-build-"));
try {
	// Pass 1: rasterise each key at OpenDeck's canvas size, then decimate it to
	// the device's key size exactly as elgato-streamdeck does.
	keys.forEach((k, i) => fs.writeFileSync(path.join(work, `k${i}.svg`), raw(k.uri)));
	fs.writeFileSync(
		path.join(work, "keys.html"),
		`<style>html,body{margin:0;background:#000}div{display:flex}` +
			`img{display:block;width:${CANVAS}px;height:${CANVAS}px}</style>` +
			`<div>${keys.map((_, i) => `<img src="k${i}.svg">`).join("")}</div>`,
	);
	const sheet = shoot(browser, work, "keys.html", "keys.png", keys.length * CANVAS, CANVAS);

	const strip = Buffer.alloc(keys.length * DEVICE * DEVICE * 4);
	keys.forEach((_, i) => {
		const tile = png.resizeNearest(png.crop(sheet, i * CANVAS, 0, CANVAS, CANVAS), DEVICE, DEVICE);
		for (let y = 0; y < DEVICE; y++) {
			tile.data.copy(strip, (y * keys.length * DEVICE + i * DEVICE) * 4, y * DEVICE * 4, (y + 1) * DEVICE * 4);
		}
	});
	const stripUri = `data:image/png;base64,${png.encode(strip, keys.length * DEVICE, DEVICE).toString("base64")}`;

	// Pass 2: lay the decimated keys out with captions and the dial strip. The
	// keys are blown up by an integer factor with nearest-neighbour so the
	// hardware's actual pixels stay visible instead of being smoothed over.
	const KZ = DEVICE * ZOOM;
	const pad = PAD * ZOOM;
	const gap = GAP * ZOOM;
	const sw = STRIP_W * ZOOM;
	const sh = STRIP_H * ZOOM;
	const pw = pad * 2 + keys.length * KZ + (keys.length - 1) * gap + gap * 2 + sw;
	const ph = pad * 2 + KZ + CAP_H * ZOOM;

	const tiles = keys
		.map((k, i) => {
			const left = pad + i * (KZ + gap);
			return (
				`<div class="k" style="left:${left}px;background-position:-${i * KZ}px 0"></div>` +
				`<div class="c" style="left:${left}px;width:${KZ}px">${k.caption}</div>`
			);
		})
		.join("");

	const stripLeft = pad + keys.length * (KZ + gap) + gap - gap;
	const stripSvg =
		`<svg width="${sw}" height="${sh}" viewBox="0 0 ${STRIP_W} ${STRIP_H}" xmlns="http://www.w3.org/2000/svg">` +
		dialStrip(0, 0, { title: "Master", value: "75%", percent: 75, muted: false, kind: "playback" }) +
		`</svg>`;

	fs.writeFileSync(
		path.join(work, "sheet.html"),
		`<style>
html,body{margin:0;background:#0d1117}
body{position:relative;width:${pw}px;height:${ph}px;font-family:${FONT}}
.k{position:absolute;top:${pad}px;width:${KZ}px;height:${KZ}px;
   background-image:url('${stripUri}');background-size:${keys.length * KZ}px ${KZ}px;
   image-rendering:pixelated}
.c{position:absolute;top:${pad + KZ + 11 * ZOOM}px;text-align:center;font-size:${11 * ZOOM}px;color:${CAPTION}}
.s{position:absolute;top:${pad + (KZ - sh) / 2}px;left:${stripLeft}px}
.sc{position:absolute;top:${pad + KZ + 11 * ZOOM}px;left:${stripLeft}px;width:${sw}px;text-align:center;
    font-size:${11 * ZOOM}px;color:${CAPTION}}
</style>${tiles}<div class="s">${stripSvg}</div><div class="sc">Dial touchstrip ($B1)</div>`,
	);
	const final = shoot(browser, work, "sheet.html", "sheet.png", pw, ph);
	const pngFile = path.join(docs, "showcase.png");
	fs.writeFileSync(pngFile, png.encode(final.data, final.width, final.height));
	console.log(
		`wrote ${path.relative(process.cwd(), pngFile)} (${final.width}x${final.height}, ` +
			`keys decimated ${CANVAS}->${DEVICE} nearest, shown at ${ZOOM}x)`,
	);
} finally {
	fs.rmSync(work, { recursive: true, force: true });
}
