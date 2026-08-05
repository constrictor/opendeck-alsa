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
// librsvg; it is a tiny supersampled scanline rasteriser, plus the PNG encoder
// in ./png.js.

const fs = require("node:fs");
const path = require("node:path");
const png = require("./png.js");

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

// Glyph geometry mirrors lib/icons.js: both draw into a nominal 96x96 box that
// is then placed by centre point and scale. Keep the two in step — the static
// PNGs are what OpenDeck shows in the action list and before the plugin has
// rendered its first live image.
const GLYPH = 96;

/** Map 96-box coordinates onto the canvas for a glyph centred at (cx, cy). */
function box(cx, cy, scale) {
	const ox = cx - (GLYPH * scale) / 2;
	const oy = cy - (GLYPH * scale) / 2;
	return {
		x: (v) => ox + v * scale,
		y: (v) => oy + v * scale,
		w: (v) => v * scale,
	};
}

const DEG = Math.PI / 180;

function speaker(cv, color, waves, muted, cx = 72, cy = 60, scale = 1) {
	const b = box(cx, cy, scale);
	cv.fillPolygon(
		[
			[b.x(6), b.y(34)],
			[b.x(24), b.y(34)],
			[b.x(46), b.y(14)],
			[b.x(46), b.y(82)],
			[b.x(24), b.y(62)],
			[b.x(6), b.y(62)],
		],
		color,
		1,
	);
	if (muted) {
		cv.strokeLine(b.x(12), b.y(12), b.x(84), b.y(84), b.w(10), C.warn, 1);
		return;
	}
	for (const r of [14, 26, 38].slice(0, waves)) {
		cv.strokeArc(b.x(46), b.y(48), b.w(r), -52 * DEG, 52 * DEG, b.w(8), color, 1);
	}
}

function mic(cv, color, muted, cx = 72, cy = 58, scale = 1) {
	const b = box(cx, cy, scale);
	cv.fillRoundRect(b.x(34), b.y(8), b.w(28), b.w(48), b.w(14), color, 1);
	cv.strokeArc(b.x(48), b.y(46), b.w(30), 0, Math.PI, b.w(9), color, 1);
	cv.strokeLine(b.x(48), b.y(72), b.x(48), b.y(84), b.w(9), color, 1);
	cv.strokeLine(b.x(30), b.y(86), b.x(66), b.y(86), b.w(9), color, 1);
	if (muted) cv.strokeLine(b.x(12), b.y(10), b.x(84), b.y(86), b.w(10), C.warn, 1);
}

// Level gauge: a 250-degree arc with the gap at the bottom, matching GAUGE in
// lib/icons.js.
const GAUGE = { r: 56, width: 12, from: 145 * DEG, to: 395 * DEG };

function gauge(cv, percent) {
	const cx = 72;
	const cy = 72;
	cv.strokeArc(cx, cy, GAUGE.r, GAUGE.from, GAUGE.to, GAUGE.width, hex("#3a3f4b"), 1);
	const p = Math.max(0, Math.min(100, percent));
	if (p <= 0) return;
	cv.strokeArc(cx, cy, GAUGE.r, GAUGE.from, GAUGE.from + (p / 100) * (GAUGE.to - GAUGE.from), GAUGE.width, C.accent, 1);
}

// The "+" / "-" chip on the Volume Up and Volume Down tiles. Geometry matches
// stepBadge() in lib/icons.js so the static tile and the live key agree; the
// opaque halo underneath punches a hole through the gauge it sits on.
function stepBadge(cv, plus) {
	const cx = 108;
	const cy = 36;
	cv.fillCircle(cx, cy, 26, C.bg, 1);
	cv.fillCircle(cx, cy, 18, C.accent, 1);
	cv.strokeLine(cx - 9, cy, cx + 9, cy, 7, C.bg, 1);
	if (plus) cv.strokeLine(cx, cy - 9, cx, cy + 9, 7, C.bg, 1);
}

function base(size = 144) {
	const cv = new Canvas(size);
	cv.fillRoundRect(0, 0, size, size, 18, C.bg, 1);
	return cv;
}

const OUT = path.join(__dirname, "..", "com.valentyn.alsa.sdPlugin", "icons");

function write(name, cv) {
	const file = path.join(OUT, `${name}.png`);
	fs.writeFileSync(file, png.encode(cv.toRGBA8(), cv.size, cv.size));
	console.log(`wrote ${path.relative(process.cwd(), file)} (${fs.statSync(file).size} bytes)`);
}

fs.mkdirSync(OUT, { recursive: true });

// Plugin / category artwork: a gauge with a speaker at its centre.
{
	const cv = base();
	gauge(cv, 72);
	speaker(cv, C.fg, 2, false, 72, 66, 0.62);
	write("plugin", cv);
}

// Volume action, unmuted and muted. These carry no percentage or caption — the
// live key draws those, and inventing a number on the action tile would be a
// lie — so the glyph sits centred rather than pushed up.
{
	const cv = base();
	gauge(cv, 70);
	speaker(cv, C.fg, 2, false, 72, 66, 0.62);
	write("volume", cv);
}
{
	const cv = base();
	gauge(cv, 0);
	speaker(cv, C.dim, 0, true, 72, 66, 0.62);
	write("volumeMuted", cv);
}

// Volume Up / Volume Down actions: the volume face with a direction chip. One
// wave only, so the arcs stay clear of the chip.
{
	const cv = base();
	gauge(cv, 70);
	speaker(cv, C.fg, 1, false, 64, 70, 0.58);
	stepBadge(cv, true);
	write("volumeUp", cv);
}
{
	const cv = base();
	gauge(cv, 40);
	speaker(cv, C.fg, 1, false, 64, 70, 0.58);
	stepBadge(cv, false);
	write("volumeDown", cv);
}

// Mute action, unmuted and muted.
{
	const cv = base();
	mic(cv, C.fg, false, 72, 62, 1);
	write("mute", cv);
}
{
	const cv = base();
	mic(cv, C.dim, true, 72, 62, 1);
	write("muteMuted", cv);
}
