"use strict";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Valentyn Pavliuchenko

// Key images are generated as SVG data URIs at render time so they can show
// live state (level ring, percentage, mute slash) without shipping a sprite
// sheet for every combination.

const SIZE = 144;

const COLORS = {
	bg: "#17181c",
	fg: "#f2f4f8",
	dim: "#6b7280",
	ring: "#2a2d35",
	on: "#3ba55d",
	warn: "#e5484d",
	accent: "#5b9dff",
};

const esc = (s) =>
	String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Must be base64, not URL-encoded. Keys are drawn by the webview, which accepts
// either, but the dial strip is rendered natively by streamdeck-strip-render,
// and its data-URL parser rejects any header without "base64" — a URL-encoded
// SVG silently becomes an empty pixmap (the checkerboard placeholder).
function dataUri(svg) {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

// Speaker body plus 0-3 arcs depending on level; a strike-through when muted.
function speakerGlyph(color, waves, muted) {
	const body = `<path d="M22 30 L38 30 L58 12 L58 76 L38 58 L22 58 Z" fill="${color}"/>`;
	const arcs = [
		`<path d="M68 26 A22 22 0 0 1 68 62" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"/>`,
		`<path d="M78 16 A34 34 0 0 1 78 72" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"/>`,
		`<path d="M88 6 A46 46 0 0 1 88 82" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"/>`,
	];
	const shown = muted ? "" : arcs.slice(0, waves).join("");
	const slash = muted
		? `<line x1="66" y1="12" x2="104" y2="76" stroke="${COLORS.warn}" stroke-width="9" stroke-linecap="round"/>`
		: "";
	return `<g transform="translate(14,26)">${body}${shown}${slash}</g>`;
}

// Capsule mic with a cradle arc; struck through when muted.
function micGlyph(color, muted) {
	const capsule = `<rect x="34" y="4" width="28" height="46" rx="14" fill="${color}"/>`;
	const cradle = `<path d="M20 40 A28 28 0 0 0 76 40" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"/>`;
	const stem = `<line x1="48" y1="68" x2="48" y2="84" stroke="${color}" stroke-width="8" stroke-linecap="round"/>`;
	const base = `<line x1="30" y1="84" x2="66" y2="84" stroke="${color}" stroke-width="8" stroke-linecap="round"/>`;
	const slash = muted
		? `<line x1="16" y1="4" x2="80" y2="88" stroke="${COLORS.warn}" stroke-width="9" stroke-linecap="round"/>`
		: "";
	return `<g transform="translate(24,22)">${capsule}${cradle}${stem}${base}${slash}</g>`;
}

// Progress ring around the key edge, drawn from the top clockwise.
function ring(percent) {
	const r = 62;
	const cx = SIZE / 2;
	const cy = SIZE / 2;
	const circ = 2 * Math.PI * r;
	const filled = (Math.max(0, Math.min(100, percent)) / 100) * circ;
	return (
		`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${COLORS.ring}" stroke-width="8"/>` +
		`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${COLORS.accent}" stroke-width="8"` +
		` stroke-linecap="round" stroke-dasharray="${filled.toFixed(2)} ${(circ - filled).toFixed(2)}"` +
		` transform="rotate(-90 ${cx} ${cy})"/>`
	);
}

function wrap(inner) {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
		`<rect width="${SIZE}" height="${SIZE}" rx="18" fill="${COLORS.bg}"/>${inner}</svg>`
	);
}

function label(text, y, size = 22, color = COLORS.fg) {
	if (!text) return "";
	return (
		`<text x="${SIZE / 2}" y="${y}" text-anchor="middle" font-family="Inter, DejaVu Sans, Helvetica, sans-serif"` +
		` font-size="${size}" font-weight="600" fill="${color}">${esc(text)}</text>`
	);
}

/**
 * Key image for a mute toggle.
 * @param {{kind: string, muted: boolean, percent: number|null, text?: string, missing?: boolean}} state
 */
function muteIcon(state) {
	if (state.missing) return unavailableIcon(state.text);
	const muted = !!state.muted;
	const color = muted ? COLORS.dim : COLORS.fg;
	const waves = state.percent === null ? 3 : state.percent > 66 ? 3 : state.percent > 33 ? 2 : state.percent > 0 ? 1 : 0;
	const glyph = state.kind === "capture" ? micGlyph(color, muted) : speakerGlyph(color, waves, muted);
	const caption = state.text ? label(state.text, 132, 20, muted ? COLORS.warn : COLORS.dim) : "";
	return dataUri(wrap(`${glyph}${caption}`));
}

/**
 * Key image for a volume control: level ring plus percentage.
 */
function volumeIcon(state) {
	if (state.missing) return unavailableIcon(state.text);
	const muted = !!state.muted;
	const percent = state.percent === null ? 0 : state.percent;
	const color = muted ? COLORS.dim : COLORS.fg;
	const glyph =
		state.kind === "capture"
			? `<g transform="translate(30,10) scale(0.62)">${micGlyph(color, muted)}</g>`
			: `<g transform="translate(28,6) scale(0.62)">${speakerGlyph(color, muted ? 0 : 2, muted)}</g>`;
	const value = muted ? "MUTED" : `${percent}%`;
	const valueColor = muted ? COLORS.warn : COLORS.fg;
	const caption = state.text ? label(state.text, 128, 17, COLORS.dim) : "";
	return dataUri(wrap(`${ring(muted ? 0 : percent)}${glyph}${label(value, 104, 26, valueColor)}${caption}`));
}

/**
 * Small glyph for the dial touchstrip, whose icon slot is only 48x48.
 * Deliberately plain: the layout already shows the title, the percentage and an
 * indicator bar, so a level ring and a caption would just be unreadable clutter.
 * Transparent background so it sits on the strip's own backdrop.
 * @param {{kind: string, muted: boolean}} state
 */
function glyphIcon(state) {
	const muted = !!state.muted;
	const color = muted ? "#8b93a1" : "#ffffff";
	const slash = (x1, y1, x2, y2) =>
		muted ? `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${COLORS.warn}" stroke-width="4.5" stroke-linecap="round"/>` : "";

	let body;
	if (state.kind === "capture") {
		body =
			`<rect x="18" y="5" width="12" height="21" rx="6" fill="${color}"/>` +
			`<path d="M13 21 A11 11 0 0 0 35 21" fill="none" stroke="${color}" stroke-width="3.4" stroke-linecap="round"/>` +
			`<line x1="24" y1="33" x2="24" y2="41" stroke="${color}" stroke-width="3.4" stroke-linecap="round"/>` +
			`<line x1="17" y1="41" x2="31" y2="41" stroke="${color}" stroke-width="3.4" stroke-linecap="round"/>` +
			slash(11, 6, 37, 42);
	} else {
		const arcs = muted
			? ""
			: `<path d="M27 17 A9 9 0 0 1 27 31" fill="none" stroke="${color}" stroke-width="3.4" stroke-linecap="round"/>` +
				`<path d="M32.5 11 A15.5 15.5 0 0 1 32.5 37" fill="none" stroke="${color}" stroke-width="3.4" stroke-linecap="round"/>`;
		body = `<path d="M6 18 L13 18 L22 9 L22 39 L13 30 L6 30 Z" fill="${color}"/>${arcs}` + slash(26, 11, 42, 37);
	}
	return dataUri(
		`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">${body}</svg>`,
	);
}

/** Shown when the configured card or control is not present. */
function unavailableIcon(text) {
	const glyph =
		`<g transform="translate(48,36)">` +
		`<circle cx="24" cy="24" r="23" fill="none" stroke="${COLORS.warn}" stroke-width="6"/>` +
		`<line x1="8" y1="8" x2="40" y2="40" stroke="${COLORS.warn}" stroke-width="6" stroke-linecap="round"/>` +
		`</g>`;
	return dataUri(wrap(`${glyph}${label(text || "no control", 118, 17, COLORS.dim)}`));
}

module.exports = { muteIcon, volumeIcon, glyphIcon, unavailableIcon, COLORS, SIZE, dataUri };
