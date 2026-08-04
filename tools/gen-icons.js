#!/usr/bin/env node
"use strict";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Valentyn Pavliuchenko

// Build-time icon generator.
//
// Produces the static PNGs the manifest points at (action list entries and the
// default key images). Live key images are drawn as SVG at runtime by
// lib/icons.js — these are only the fallbacks OpenDeck shows before the plugin
// has rendered, plus the category/action artwork.
//
// Written from scratch because the target machine has no ImageMagick or
// librsvg; it is a tiny supersampled scanline rasteriser plus a PNG encoder.

const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const SS = 3; // supersampling factor, for antialiased edges

class Canvas {
	constructor(size) {
		this.size = size;
		this.w = size * SS;
		this.h = size * SS;
		this.buf = new Float32Array(this.w * this.h * 4); // straight RGBA, 0..1
	}

	blend(x, y, [r, g, b], a) {
		if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
		const i = (y * this.w + x) * 4;
		const buf = this.buf;
		const ia = 1 - a;
		buf[i] = buf[i] * ia + r * a;
		buf[i + 1] = buf[i + 1] * ia + g * a;
		buf[i + 2] = buf[i + 2] * ia + b * a;
		buf[i + 3] = buf[i + 3] * ia + a;
	}

	/** Fill any shape described by an inside-test, over its bounding box. */
	fillShape(bbox, inside, color, alpha = 1) {
		const x0 = Math.max(0, Math.floor(bbox[0] * SS));
		const y0 = Math.max(0, Math.floor(bbox[1] * SS));
		const x1 = Math.min(this.w - 1, Math.ceil(bbox[2] * SS));
		const y1 = Math.min(this.h - 1, Math.ceil(bbox[3] * SS));
		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				if (inside((x + 0.5) / SS, (y + 0.5) / SS)) this.blend(x, y, color, alpha);
			}
		}
	}

	fillRect(x, y, w, h, color, alpha) {
		this.fillShape([x, y, x + w, y + h], (px, py) => px >= x && px <= x + w && py >= y && py <= y + h, color, alpha);
	}

	fillRoundRect(x, y, w, h, r, color, alpha) {
		this.fillShape(
			[x, y, x + w, y + h],
			(px, py) => {
				if (px < x || px > x + w || py < y || py > y + h) return false;
				const cx = Math.min(Math.max(px, x + r), x + w - r);
				const cy = Math.min(Math.max(py, y + r), y + h - r);
				return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
			},
			color,
			alpha,
		);
	}

	fillCircle(cx, cy, r, color, alpha) {
		this.fillShape([cx - r, cy - r, cx + r, cy + r], (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r, color, alpha);
	}

	/** Polygon fill using the even-odd rule. */
	fillPolygon(pts, color, alpha) {
		const xs = pts.map((p) => p[0]);
		const ys = pts.map((p) => p[1]);
		const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
		this.fillShape(
			bbox,
			(px, py) => {
				let inside = false;
				for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
					const [xi, yi] = pts[i];
					const [xj, yj] = pts[j];
					if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
				}
				return inside;
			},
			color,
			alpha,
		);
	}

	/** Round-capped thick line, as a distance test against the segment. */
	strokeLine(x1, y1, x2, y2, width, color, alpha) {
		const hw = width / 2;
		const bbox = [Math.min(x1, x2) - hw, Math.min(y1, y2) - hw, Math.max(x1, x2) + hw, Math.max(y1, y2) + hw];
		const dx = x2 - x1;
		const dy = y2 - y1;
		const len2 = dx * dx + dy * dy || 1;
		this.fillShape(
			bbox,
			(px, py) => {
				let t = ((px - x1) * dx + (py - y1) * dy) / len2;
				t = Math.max(0, Math.min(1, t));
				const qx = x1 + t * dx;
				const qy = y1 + t * dy;
				return (px - qx) ** 2 + (py - qy) ** 2 <= hw * hw;
			},
			color,
			alpha,
		);
	}

	/** Arc stroke: distance to the circle, limited to an angular sweep. */
	strokeArc(cx, cy, r, a0, a1, width, color, alpha) {
		const hw = width / 2;
		const outer = r + hw;
		this.fillShape(
			[cx - outer, cy - outer, cx + outer, cy + outer],
			(px, py) => {
				const d = Math.hypot(px - cx, py - cy);
				if (Math.abs(d - r) > hw) return false;
				let ang = Math.atan2(py - cy, px - cx);
				while (ang < a0) ang += Math.PI * 2;
				return ang <= a1;
			},
			color,
			alpha,
		);
	}

	/** Downsample to 8-bit RGBA. */
	toRGBA8() {
		const out = Buffer.alloc(this.size * this.size * 4);
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				let r = 0;
				let g = 0;
				let b = 0;
				let a = 0;
				for (let sy = 0; sy < SS; sy++) {
					for (let sx = 0; sx < SS; sx++) {
						const i = ((y * SS + sy) * this.w + (x * SS + sx)) * 4;
						r += this.buf[i];
						g += this.buf[i + 1];
						b += this.buf[i + 2];
						a += this.buf[i + 3];
					}
				}
				const n = SS * SS;
				const o = (y * this.size + x) * 4;
				out[o] = Math.round((r / n) * 255);
				out[o + 1] = Math.round((g / n) * 255);
				out[o + 2] = Math.round((b / n) * 255);
				out[o + 3] = Math.round((a / n) * 255);
			}
		}
		return out;
	}
}

// ------------------------------------------------------------------ PNG

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
	// One filter byte (0 = none) per scanline.
	const stride = size * 4;
	const raw = Buffer.alloc((stride + 1) * size);
	for (let y = 0; y < size; y++) {
		raw[y * (stride + 1)] = 0;
		rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ----------------------------------------------------------------- glyphs

const hex = (h) => [
	parseInt(h.slice(1, 3), 16) / 255,
	parseInt(h.slice(3, 5), 16) / 255,
	parseInt(h.slice(5, 7), 16) / 255,
];

const C = {
	bg: hex("#17181c"),
	fg: hex("#f2f4f8"),
	dim: hex("#6b7280"),
	warn: hex("#e5484d"),
	accent: hex("#5b9dff"),
};

function speaker(cv, color, waves, muted) {
	const ox = 26;
	const oy = 44;
	cv.fillPolygon(
		[
			[ox + 4, oy + 22],
			[ox + 18, oy + 22],
			[ox + 36, oy + 6],
			[ox + 36, oy + 62],
			[ox + 18, oy + 46],
			[ox + 4, oy + 46],
		],
		color,
		1,
	);
	if (!muted) {
		const cx = ox + 36;
		const cy = oy + 34;
		for (let i = 0; i < waves; i++) {
			cv.strokeArc(cx, cy, 16 + i * 12, -0.9, 0.9, 6, color, 1);
		}
	} else {
		cv.strokeLine(ox + 46, oy + 6, ox + 82, oy + 62, 8, C.warn, 1);
	}
}

function mic(cv, color, muted) {
	const cx = 72;
	const top = 34;
	cv.fillRoundRect(cx - 13, top, 26, 44, 13, color, 1);
	cv.strokeArc(cx, top + 30, 26, 0.15, Math.PI - 0.15, 7, color, 1);
	cv.strokeLine(cx, top + 56, cx, top + 74, 7, color, 1);
	cv.strokeLine(cx - 16, top + 74, cx + 16, top + 74, 7, color, 1);
	if (muted) cv.strokeLine(cx - 34, top - 6, cx + 34, top + 74, 8, C.warn, 1);
}

function ringGauge(cv, percent, color) {
	const cx = 72;
	const cy = 72;
	const r = 58;
	cv.strokeArc(cx, cy, r, 0, Math.PI * 2, 7, hex("#2a2d35"), 1);
	if (percent > 0) {
		const sweep = (Math.min(100, percent) / 100) * Math.PI * 2;
		// Start at 12 o'clock and go clockwise.
		cv.strokeArc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + sweep, 7, color, 1);
	}
}

// The "+" / "-" chip on the Volume Up and Volume Down tiles. Geometry matches
// stepBadge() in lib/icons.js so the static tile and the live key agree; the
// opaque disc underneath punches a hole through the ring it sits on.
function stepBadge(cv, plus) {
	const cx = 112;
	const cy = 32;
	cv.fillCircle(cx, cy, 22, C.bg, 1);
	cv.fillCircle(cx, cy, 19, C.accent, 1);
	cv.strokeLine(cx - 9, cy, cx + 9, cy, 6, C.bg, 1);
	if (plus) cv.strokeLine(cx, cy - 9, cx, cy + 9, 6, C.bg, 1);
}

function base(size = 144) {
	const cv = new Canvas(size);
	cv.fillRoundRect(0, 0, size, size, 18, C.bg, 1);
	return cv;
}

const OUT = path.join(__dirname, "..", "com.valentyn.alsa.sdPlugin", "icons");

function write(name, cv) {
	const file = path.join(OUT, `${name}.png`);
	fs.writeFileSync(file, encodePNG(cv.toRGBA8(), cv.size));
	console.log(`wrote ${path.relative(process.cwd(), file)} (${fs.statSync(file).size} bytes)`);
}

fs.mkdirSync(OUT, { recursive: true });

// Plugin / category artwork: a dial with a speaker at its centre.
{
	const cv = base();
	ringGauge(cv, 72, C.accent);
	speaker(cv, C.fg, 2, false);
	write("plugin", cv);
}

// Volume action, unmuted and muted.
{
	const cv = base();
	ringGauge(cv, 70, C.accent);
	speaker(cv, C.fg, 2, false);
	write("volume", cv);
}
{
	const cv = base();
	ringGauge(cv, 0, C.accent);
	speaker(cv, C.dim, 0, true);
	write("volumeMuted", cv);
}

// Volume Up / Volume Down actions: the volume face with a direction chip. One
// wave only, so the arcs stay clear of the chip.
{
	const cv = base();
	ringGauge(cv, 70, C.accent);
	speaker(cv, C.fg, 1, false);
	stepBadge(cv, true);
	write("volumeUp", cv);
}
{
	const cv = base();
	ringGauge(cv, 40, C.accent);
	speaker(cv, C.fg, 1, false);
	stepBadge(cv, false);
	write("volumeDown", cv);
}

// Mute action, unmuted and muted.
{
	const cv = base();
	mic(cv, C.fg, false);
	write("mute", cv);
}
{
	const cv = base();
	mic(cv, C.dim, true);
	write("muteMuted", cv);
}
