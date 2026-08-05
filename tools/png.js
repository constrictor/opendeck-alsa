"use strict";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Valentyn Pavliuchenko

// Minimal PNG encoder/decoder, so the build tools stay dependency-free on a
// machine with no ImageMagick or librsvg. Handles exactly what we produce and
// consume: 8-bit non-interlaced RGB or RGBA.

const zlib = require("node:zlib");

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

const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @param {Buffer} rgba straight RGBA, 4 bytes per pixel */
function encode(rgba, width, height) {
	// One filter byte (0 = none) per scanline.
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type RGBA
	return Buffer.concat([
		MAGIC,
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const paeth = (a, b, c) => {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** @returns {{width: number, height: number, data: Buffer}} data is RGBA */
function decode(buf) {
	if (!buf.subarray(0, 8).equals(MAGIC)) throw new Error("not a PNG");
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat = [];
	let off = 8;
	while (off < buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.toString("ascii", off + 4, off + 8);
		const data = buf.subarray(off + 8, off + 8 + len);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			const depth = data[8];
			const colour = data[9];
			if (depth !== 8 || (colour !== 2 && colour !== 6)) {
				throw new Error(`unsupported PNG: depth ${depth}, colour type ${colour}`);
			}
			if (data[12] !== 0) throw new Error("interlaced PNG not supported");
			channels = colour === 6 ? 4 : 3;
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}
		off += 12 + len;
	}

	const raw = zlib.inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const lines = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const src = y * (stride + 1) + 1;
		const dst = y * stride;
		const prev = dst - stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? lines[dst + x - channels] : 0;
			const b = y > 0 ? lines[prev + x] : 0;
			const c = x >= channels && y > 0 ? lines[prev + x - channels] : 0;
			const v = raw[src + x];
			let out;
			switch (filter) {
				case 0: out = v; break;
				case 1: out = v + a; break;
				case 2: out = v + b; break;
				case 3: out = v + ((a + b) >> 1); break;
				case 4: out = v + paeth(a, b, c); break;
				default: throw new Error(`bad PNG filter ${filter}`);
			}
			lines[dst + x] = out & 0xff;
		}
	}

	if (channels === 4) return { width, height, data: lines };
	const data = Buffer.alloc(width * height * 4);
	for (let i = 0, j = 0; i < width * height; i++, j += 3) {
		data[i * 4] = lines[j];
		data[i * 4 + 1] = lines[j + 1];
		data[i * 4 + 2] = lines[j + 2];
		data[i * 4 + 3] = 255;
	}
	return { width, height, data };
}

/**
 * Nearest-neighbour resample, reproducing what elgato-streamdeck does to every
 * key image on its way to the hardware (`resize_exact(.., FilterType::Nearest)`).
 * This is the step that turns antialiased edges into stair-steps, so the
 * showcase has to apply it to be honest about what the panel shows.
 */
function resizeNearest(img, width, height) {
	const data = Buffer.alloc(width * height * 4);
	for (let y = 0; y < height; y++) {
		const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / height));
		for (let x = 0; x < width; x++) {
			const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / width));
			img.data.copy(data, (y * width + x) * 4, (sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4);
		}
	}
	return { width, height, data };
}

/** Cut a sub-rectangle out of a decoded image. */
function crop(img, x, y, width, height) {
	const data = Buffer.alloc(width * height * 4);
	for (let row = 0; row < height; row++) {
		const src = ((y + row) * img.width + x) * 4;
		img.data.copy(data, row * width * 4, src, src + width * 4);
	}
	return { width, height, data };
}

module.exports = { encode, decode, resizeNearest, crop, crc32 };
