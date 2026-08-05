"use strict";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Valentyn Pavliuchenko

// Key images are generated as SVG data URIs at render time so they can show
// live state (level ring, percentage, mute slash) without shipping a sprite
// sheet for every combination.
//
// The artwork is drawn in a 144-unit box but is designed for what the hardware
// actually receives, which is considerably coarser. OpenDeck rasterises the SVG
// into a 144x144 canvas, JPEGs it (rendererHelper.ts), and hands it to
// elgato-streamdeck, which does
//
//     image.resize_exact(w, h, FilterType::Nearest)   // images.rs
//
// down to the device's key size -- 120x120 on a Stream Deck +, 72x72 on an
// MK.2 -- then re-encodes at JPEG quality 90. A nearest-neighbour 144->120 is a
// 6:5 decimation: it drops every sixth row and column and point-samples the
// antialiased edges rather than averaging them, so soft edges turn into hard
// stair-steps and thin strokes come out uneven.
//
// Hence the rules this file follows:
//   * no stroke thinner than 8 units (~6.7px on a Plus, ~4px on an MK.2);
//   * no text below 20 units, and captions get a width clamp instead of
//     overflowing the tile;
//   * significant edges land on multiples of 6, which map to whole pixels at
//     120 and stay put under the decimation;
//   * detail budget is small -- at most three speaker arcs, and the level gauge
//     leaves a gap at the bottom so the caption never has to cross it.
// tools/gen-showcase.js renders both the source and the post-pipeline result.

const SIZE = 144;

const COLORS = {
	bg: "#17181c",
	fg: "#f2f4f8",
	dim: "#6b7280",
	ring: "#3a3f4b", // lifted from the old #2a2d35: the darker track disappeared on the panel
	on: "#3ba55d",
	warn: "#e5484d",
	accent: "#5b9dff",
};

const FONT = "Inter, DejaVu Sans, Helvetica, sans-serif";

const esc = (s) =>
	String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Must be base64, not URL-encoded. Keys are drawn by the webview, which accepts
// either, but the dial strip is rendered natively by streamdeck-strip-render,
// and its data-URL parser rejects any header without "base64" — a URL-encoded
// SVG silently becomes an empty pixmap (the checkerboard placeholder).
function dataUri(svg) {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

// ------------------------------------------------------------------- text

// Rough per-em advance widths. The webview resolves the font stack against
// whatever is installed, so exact metrics are unknowable; these deliberately
// run wide, because over-estimating costs a slightly tighter label while
// under-estimating lets a long control name run off the edge of the key.
function advance(ch) {
	if (ch === " ") return 0.32;
	if ("iljItf.,:;!|'".includes(ch)) return 0.38;
	if ("mwMW%@".includes(ch)) return 0.98;
	if (ch >= "0" && ch <= "9") return 0.66;
	if (ch >= "A" && ch <= "Z") return 0.76;
	return 0.64;
}

function textWidth(text, size) {
	let w = 0;
	for (const ch of String(text)) w += advance(ch);
	return w * size;
}

/**
 * Centred text that is guaranteed to stay inside `maxWidth`. Mild overflow is
 * absorbed by condensing the glyphs; anything wildly too long is truncated
 * first, since condensing "Pre Mixer Deepbuffer" to fit would just produce an
 * illegible smear.
 */
function label(text, y, size, color, maxWidth = 126) {
	if (!text) return "";
	let str = String(text);
	if (textWidth(str, size) > maxWidth * 1.3) {
		while (str.length > 1 && textWidth(`${str}…`, size) > maxWidth * 1.3) str = str.slice(0, -1);
		str += "…";
	}
	const clamp =
		textWidth(str, size) > maxWidth ? ` textLength="${maxWidth}" lengthAdjust="spacingAndGlyphs"` : "";
	return (
		`<text x="${SIZE / 2}" y="${y}" text-anchor="middle" font-family="${FONT}"` +
		` font-size="${size}" font-weight="700" fill="${color}"${clamp}>${esc(str)}</text>`
	);
}

// ----------------------------------------------------------------- glyphs

// Both glyphs are drawn in a 96x96 box so callers can place and scale them by
// one transform. They are centred on the box at their *widest* state, so the
// artwork does not shift around as the level (and hence the arc count) changes.

const GLYPH = 96;

function arc(cx, cy, r, from, to, width, color) {
	const rad = (d) => (d * Math.PI) / 180;
	const p = (d) => `${(cx + r * Math.cos(rad(d))).toFixed(2)} ${(cy + r * Math.sin(rad(d))).toFixed(2)}`;
	const large = Math.abs(to - from) > 180 ? 1 : 0;
	return (
		`<path d="M${p(from)} A${r} ${r} 0 ${large} 1 ${p(to)}" fill="none" stroke="${color}"` +
		` stroke-width="${width}" stroke-linecap="round"/>`
	);
}

// Speaker cone plus 0-3 arcs depending on level; a strike-through when muted.
function speakerGlyph(color, waves, muted) {
	const cone = `<path d="M6 34 L24 34 L46 14 L46 82 L24 62 L6 62 Z" fill="${color}"/>`;
	const arcs = [14, 26, 38].map((r) => arc(46, 48, r, -52, 52, 8, color));
	const shown = muted ? "" : arcs.slice(0, waves).join("");
	const slash = muted
		? `<line x1="12" y1="12" x2="84" y2="84" stroke="${COLORS.warn}" stroke-width="10" stroke-linecap="round"/>`
		: "";
	return `${cone}${shown}${slash}`;
}

// Capsule mic with a cradle arc; struck through when muted.
function micGlyph(color, muted) {
	const capsule = `<rect x="34" y="8" width="28" height="48" rx="14" fill="${color}"/>`;
	const cradle = `<path d="M18 46 A30 30 0 0 0 78 46" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"/>`;
	const stem = `<line x1="48" y1="72" x2="48" y2="84" stroke="${color}" stroke-width="9" stroke-linecap="round"/>`;
	const base = `<line x1="30" y1="86" x2="66" y2="86" stroke="${color}" stroke-width="9" stroke-linecap="round"/>`;
	const slash = muted
		? `<line x1="12" y1="10" x2="84" y2="86" stroke="${COLORS.warn}" stroke-width="10" stroke-linecap="round"/>`
		: "";
	return `${capsule}${cradle}${stem}${base}${slash}`;
}

/**
 * Place a 96-box glyph so that its centre lands on (cx, cy) at the given scale.
 * Like data-dir on the step badge, data-glyph does not render — it is a stable
 * handle for the tests, which would otherwise have to match on path geometry
 * and break every time the artwork is retouched.
 */
function glyphFor(kind, color, waves, muted, cx, cy, scale) {
	const mic = kind === "capture";
	const g = mic ? micGlyph(color, muted) : speakerGlyph(color, waves, muted);
	const x = cx - (GLYPH * scale) / 2;
	const y = cy - (GLYPH * scale) / 2;
	return (
		`<g data-glyph="${mic ? "mic" : "speaker"}"` +
		` transform="translate(${x.toFixed(2)},${y.toFixed(2)}) scale(${scale})">${g}</g>`
	);
}

// ------------------------------------------------------------------ gauge

// Level gauge: a 250-degree arc with the gap at the bottom, so the caption sits
// in clear space instead of crossing the ring. Runs clockwise from roughly
// 7 o'clock round to 5 o'clock.
const GAUGE = { r: 56, width: 12, from: 145, to: 395 };
const GAUGE_LEN = ((GAUGE.to - GAUGE.from) / 360) * 2 * Math.PI * GAUGE.r;

function gauge(percent) {
	const cx = SIZE / 2;
	const cy = SIZE / 2;
	const track = arc(cx, cy, GAUGE.r, GAUGE.from, GAUGE.to, GAUGE.width, COLORS.ring);
	const p = Math.max(0, Math.min(100, percent));
	// A zero-length dash with a round cap still paints a dot at the start of the
	// arc, which reads as a few percent of level. Draw nothing at all instead.
	if (p <= 0) return track;
	const filled = (p / 100) * GAUGE_LEN;
	const fill = arc(cx, cy, GAUGE.r, GAUGE.from, GAUGE.to, GAUGE.width, COLORS.accent).replace(
		"/>",
		` stroke-dasharray="${filled.toFixed(2)} ${(GAUGE_LEN - filled + 1).toFixed(2)}"/>`,
	);
	return track + fill;
}

function wrap(inner) {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
		`<rect width="${SIZE}" height="${SIZE}" rx="18" fill="${COLORS.bg}"/>${inner}</svg>`
	);
}

// Value line inside the gauge. "MUTED" is set smaller than a percentage because
// it is twice as wide and would otherwise have to be condensed to fit.
function value(muted, percent) {
	return muted
		? label("MUTED", 100, 26, COLORS.warn, 98)
		: label(`${percent}%`, 102, 32, COLORS.fg, 98);
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
	const glyph = glyphFor(state.kind, color, waves, muted, 72, 58, 1);
	const caption = state.text ? label(state.text, 132, 22, muted ? COLORS.warn : COLORS.dim) : "";
	return dataUri(wrap(`${glyph}${caption}`));
}

/**
 * Key image for a volume control: level gauge, percentage and caption.
 */
function volumeIcon(state) {
	if (state.missing) return unavailableIcon(state.text);
	const muted = !!state.muted;
	const percent = state.percent === null ? 0 : state.percent;
	const color = muted ? COLORS.dim : COLORS.fg;
	const glyph = glyphFor(state.kind, color, muted ? 0 : 2, muted, 72, 44, 0.54);
	const caption = state.text ? label(state.text, 132, 21, COLORS.dim) : "";
	return dataUri(wrap(`${gauge(muted ? 0 : percent)}${glyph}${value(muted, percent)}${caption}`));
}

// Direction chip for the step keys, parked in the top-right corner. A
// background-coloured halo goes under it so it punches a clean hole through
// whatever it lands on — the level gauge, or the speaker's outer arc.
// The data-dir attribute does not render; it is what the tests assert on.
function stepBadge(direction, muted) {
	const cx = 108;
	const cy = 36;
	const r = 18;
	const arm = 9;
	const disc = muted ? COLORS.ring : COLORS.accent;
	const ink = muted ? COLORS.dim : COLORS.bg;
	const bar = (x1, y1, x2, y2) =>
		`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ink}" stroke-width="7" stroke-linecap="round"/>`;
	const sign = bar(cx - arm, cy, cx + arm, cy) + (direction > 0 ? bar(cx, cy - arm, cx, cy + arm) : "");
	return (
		`<g data-dir="${direction > 0 ? "up" : "down"}">` +
		`<circle cx="${cx}" cy="${cy}" r="${r + 4}" fill="none" stroke="${COLORS.bg}" stroke-width="8"/>` +
		`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${disc}"/>${sign}</g>`
	);
}

/**
 * Key image for a Volume Up / Volume Down key: the volume face plus a +/- chip.
 * The glyph sits lower and left of the plain Volume key's, and shows a single
 * wave rather than two, to leave the top-right corner to the chip.
 * @param {{kind: string, muted: boolean, percent: number|null, text?: string, missing?: boolean}} state
 * @param {number} direction +1 to raise, -1 to lower
 */
function volumeStepIcon(state, direction) {
	if (state.missing) return unavailableIcon(state.text);
	const muted = !!state.muted;
	const percent = state.percent === null ? 0 : state.percent;
	const color = muted ? COLORS.dim : COLORS.fg;
	const glyph = glyphFor(state.kind, color, muted ? 0 : 1, muted, 64, 48, 0.5);
	const caption = state.text ? label(state.text, 132, 21, COLORS.dim) : "";
	return dataUri(
		wrap(`${gauge(muted ? 0 : percent)}${glyph}${stepBadge(direction, muted)}${value(muted, percent)}${caption}`),
	);
}

/**
 * Small glyph for the dial touchstrip, whose icon slot is only 48x48.
 * Deliberately plain: the layout already shows the title, the percentage and an
 * indicator bar, so a level gauge and a caption would just be unreadable
 * clutter. Transparent background so it sits on the strip's own backdrop.
 *
 * Unlike a key, this escapes the nearest-neighbour decimation described at the
 * top of the file: the strip is composed by streamdeck-strip-render at its
 * native 200x100 and written straight to the LCD, so it is only ever JPEGed.
 * (encoder_layouts.rs does scale an icon to 72x72 with FilterType::Nearest, but
 * only on the fallback path taken when an action has no encoder config.)
 * @param {{kind: string, muted: boolean}} state
 */
function glyphIcon(state) {
	const muted = !!state.muted;
	const color = muted ? "#8b93a1" : "#ffffff";
	const slash = (x1, y1, x2, y2) =>
		muted
			? `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${COLORS.warn}" stroke-width="5" stroke-linecap="round"/>`
			: "";

	let body;
	if (state.kind === "capture") {
		body =
			`<rect x="18" y="5" width="12" height="21" rx="6" fill="${color}"/>` +
			`<path d="M13 21 A11 11 0 0 0 35 21" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round"/>` +
			`<line x1="24" y1="33" x2="24" y2="41" stroke="${color}" stroke-width="4" stroke-linecap="round"/>` +
			`<line x1="17" y1="41" x2="31" y2="41" stroke="${color}" stroke-width="4" stroke-linecap="round"/>` +
			slash(11, 6, 37, 42);
	} else {
		const arcs = muted
			? ""
			: `<path d="M27 17 A9 9 0 0 1 27 31" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round"/>` +
				`<path d="M32.5 11 A15.5 15.5 0 0 1 32.5 37" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round"/>`;
		body = `<path d="M6 18 L13 18 L22 9 L22 39 L13 30 L6 30 Z" fill="${color}"/>${arcs}` + slash(26, 11, 42, 37);
	}
	return dataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">${body}</svg>`);
}

/** Shown when the configured card or control is not present. */
function unavailableIcon(text) {
	const glyph =
		`<g transform="translate(42,26)">` +
		`<circle cx="30" cy="30" r="27" fill="none" stroke="${COLORS.warn}" stroke-width="9"/>` +
		`<line x1="11" y1="11" x2="49" y2="49" stroke="${COLORS.warn}" stroke-width="9" stroke-linecap="round"/>` +
		`</g>`;
	return dataUri(wrap(`${glyph}${label(text || "no control", 126, 21, COLORS.dim)}`));
}

module.exports = { muteIcon, volumeIcon, volumeStepIcon, glyphIcon, unavailableIcon, COLORS, SIZE, dataUri };
