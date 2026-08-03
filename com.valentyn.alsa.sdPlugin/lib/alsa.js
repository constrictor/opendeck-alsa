"use strict";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Valentyn Pavliuchenko

// ALSA mixer access via the `amixer` CLI.
//
// Everything is parsed from `amixer <target> scontents`, which dumps every
// simple control in one call. All child processes run with LC_ALL=C so parsing
// is immune to the user's locale.
//
// A "target" is either a hardware card (`-c N`, what alsamixer's F6 dialog
// lists) or the ALSA `default` device (`-D default`), which on a typical desktop
// is PipeWire or PulseAudio and carries the system-wide Master/Capture. Both are
// selectable, and both can be watched with `alsactl monitor`.

const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");

const ENV = { ...process.env, LC_ALL: "C", LANG: "C", LANGUAGE: "C" };
const TIMEOUT = 5000;

function run(args) {
	return new Promise((resolve, reject) => {
		execFile("amixer", args, { env: ENV, timeout: TIMEOUT }, (err, stdout, stderr) => {
			if (err) {
				err.message = `amixer ${args.join(" ")}: ${stderr.trim() || err.message}`;
				reject(err);
			} else resolve(stdout);
		});
	});
}

/**
 * Sound cards, in the order alsamixer's F6 dialog lists them.
 * Read from /proc/asound/cards rather than shelling out, so this is cheap
 * enough to call on every property inspector load.
 * @returns {{index: number, id: string, name: string, hw: string}[]}
 */
function listCards() {
	let raw;
	try {
		raw = fs.readFileSync("/proc/asound/cards", "utf8");
	} catch {
		return [];
	}
	const cards = [];
	// " 0 [NVidia         ]: HDA-Intel - HDA NVidia"
	for (const line of raw.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+\[([^\]]+)\]:\s*(.*)$/);
		if (!m) continue;
		const index = Number(m[1]);
		const id = m[2].trim();
		// The long name after the dash is what alsamixer shows; fall back to the
		// driver name when there is no dash.
		const rest = m[3].trim();
		const dash = rest.indexOf(" - ");
		cards.push({
			index,
			id,
			name: dash >= 0 ? rest.slice(dash + 3).trim() : rest,
			hw: `hw:${index}`,
		});
	}
	return cards;
}

/**
 * Human-readable name of the ALSA `default` device, e.g. "PipeWire" or
 * "PulseAudio". Probed once; falls back to a generic label.
 */
let defaultNameCache;
function defaultDeviceName() {
	if (defaultNameCache !== undefined) return defaultNameCache;
	try {
		const out = execFileSync("amixer", ["-D", "default", "info"], { env: ENV, encoding: "utf8", timeout: TIMEOUT });
		// "Card default 'pipewire'/'PipeWire'"
		const m = out.match(/^Card default '[^']*'\/'([^']*)'/m) || out.match(/Mixer name\s*:\s*'([^']*)'/);
		defaultNameCache = m ? m[1] : null;
	} catch {
		defaultNameCache = null;
	}
	return defaultNameCache;
}

/**
 * Resolve a settings value to a mixer target.
 *
 * "" / "default" -> the ALSA default device; "2" or "Generic_1" -> that card.
 * @returns {{key: string, args: string[], monitor: string, isDefault: boolean, index: number|null}}
 */
function resolveTarget(value) {
	const v = value === undefined || value === null ? "" : String(value);
	if (v === "" || v === "default") {
		return { key: "default", args: ["-D", "default"], monitor: "default", isDefault: true, index: null };
	}
	let index;
	if (/^\d+$/.test(v)) index = Number(v);
	else {
		const byId = listCards().find((c) => c.id === v);
		if (!byId) {
			// Unknown card id: fall back to the default device rather than
			// silently driving whichever card happens to be index 0.
			return { key: "default", args: ["-D", "default"], monitor: "default", isDefault: true, index: null };
		}
		index = byId.index;
	}
	return { key: `hw:${index}`, args: ["-c", String(index)], monitor: `hw:${index}`, isDefault: false, index };
}

/**
 * Everything selectable in the card dropdown: the default device first (as
 * alsamixer's F6 dialog does), then each hardware card.
 */
function listTargets() {
	const name = defaultDeviceName();
	const targets = [
		{
			value: "default",
			label: name ? `Default (${name})` : "Default",
			isDefault: true,
		},
	];
	for (const c of listCards()) {
		targets.push({ value: String(c.index), label: `${c.index}: ${c.id} — ${c.name}`, isDefault: false });
	}
	return targets;
}

// One channel reading, e.g. "Playback 87 [100%] [0.00dB] [on]".
function parseSegment(seg) {
	const dir = seg.match(/^(Playback|Capture)\b/);
	const raw = seg.match(/(?:^|\s)(\d+)(?=\s|$)/);
	const pct = seg.match(/\[(\d+)%\]/);
	const db = seg.match(/\[(-?[\d.]+)dB\]/);
	const sw = seg.match(/\[(on|off)\]/);
	if (!raw && !pct && !sw) return null;
	return {
		direction: dir ? dir[1].toLowerCase() : null,
		raw: raw ? Number(raw[1]) : null,
		percent: pct ? Number(pct[1]) : null,
		db: db ? Number(db[1]) : null,
		on: sw ? sw[1] === "on" : null,
	};
}

/**
 * Parse `amixer scontents` output into structured controls.
 * @returns {object[]}
 */
function parseControls(text) {
	const controls = [];
	let cur = null;

	const flush = () => {
		if (!cur) return;
		summarise(cur);
		controls.push(cur);
		cur = null;
	};

	for (const line of text.split("\n")) {
		const head = line.match(/^Simple mixer control '(.*)',(\d+)\s*$/);
		if (head) {
			flush();
			const name = head[1];
			const index = Number(head[2]);
			cur = {
				name,
				index,
				// amixer's own identifier syntax, e.g. "Master" or "IEC958,1".
				id: index === 0 ? name : `${name},${index}`,
				caps: {},
				capsRaw: [],
				channels: [],
				items: null,
				item: null,
				limits: null,
			};
			continue;
		}
		if (!cur) continue;

		const caps = line.match(/^\s+Capabilities:\s*(.*)$/);
		if (caps) {
			cur.capsRaw = caps[1].trim().split(/\s+/).filter(Boolean);
			for (const c of cur.capsRaw) cur.caps[c] = true;
			continue;
		}

		const limits = line.match(/^\s+Limits:\s*(?:(Playback|Capture)\s+)?(-?\d+)\s*-\s*(-?\d+)\s*$/);
		if (limits) {
			cur.limits = { min: Number(limits[2]), max: Number(limits[3]) };
			continue;
		}

		const items = line.match(/^\s+Items:\s*(.*)$/);
		if (items) {
			cur.items = [...items[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
			continue;
		}

		const item = line.match(/^\s+Item\d+:\s*'(.*)'\s*$/);
		if (item) {
			cur.item = item[1];
			continue;
		}

		if (/^\s+(Playback|Capture) channels:/.test(line)) continue;
		if (/^\s+(Mono|Front|Rear|Side|Center|Woofer|Line|Left|Right)/.test(line) === false) continue;

		// Channel line: "  Front Left: Playback 87 [100%] [0.00dB] [on]"
		const ch = line.match(/^\s{2,}([A-Za-z][A-Za-z0-9 \-]*?):\s*(.*)$/);
		if (!ch) continue;
		const rest = ch[2].trim();
		if (!rest) continue; // e.g. a bare "Mono:" placeholder line

		// Split so a line carrying both directions is handled correctly.
		const segments = rest
			.split(/(?=\b(?:Playback|Capture)\b)/)
			.map((s) => s.trim())
			.filter(Boolean);
		for (const seg of segments) {
			const parsed = parseSegment(seg);
			if (parsed) cur.channels.push({ name: ch[1].trim(), ...parsed });
		}
	}
	flush();
	return controls;
}

// Derive the fields the plugin actually acts on.
function summarise(c) {
	const caps = c.caps;
	c.hasPlaybackVolume = !!(caps.pvolume || caps.volume);
	c.hasCaptureVolume = !!(caps.cvolume || caps.volume);
	c.hasPlaybackSwitch = !!(caps.pswitch || caps.switch);
	c.hasCaptureSwitch = !!(caps.cswitch || caps.switch);
	c.hasVolume = c.hasPlaybackVolume || c.hasCaptureVolume;
	c.hasSwitch = c.hasPlaybackSwitch || c.hasCaptureSwitch;
	c.isEnum = !!caps.enum;

	// A control is "capture" only when it has no playback side at all; that
	// matches how alsamixer sorts controls into its Playback/Capture views.
	const playback = c.hasPlaybackVolume || c.hasPlaybackSwitch;
	c.kind = playback ? "playback" : c.hasCaptureVolume || c.hasCaptureSwitch ? "capture" : "other";

	const pick = (dir) => c.channels.filter((ch) => ch.direction === dir || ch.direction === null);
	c.volumeChannels = pick(c.kind === "capture" ? "capture" : "playback").filter((ch) => ch.percent !== null);
	c.switchChannels = pick(c.kind === "capture" ? "capture" : "playback").filter((ch) => ch.on !== null);

	c.percent = c.volumeChannels.length
		? Math.round(c.volumeChannels.reduce((a, ch) => a + ch.percent, 0) / c.volumeChannels.length)
		: null;
	c.db = c.volumeChannels.length && c.volumeChannels[0].db !== null ? c.volumeChannels[0].db : null;

	// Muted when every channel with a switch is off. Controls without a switch
	// are treated as muted at 0% so a mute button still gives useful feedback.
	if (c.switchChannels.length) c.muted = c.switchChannels.every((ch) => ch.on === false);
	else if (c.percent !== null) c.muted = c.percent === 0;
	else c.muted = false;
}

const cache = new Map(); // target key -> { at, controls }
const CACHE_MS = 400;

/**
 * All simple controls on a target.
 * @param {object} target from resolveTarget()
 * @param {boolean} [force] bypass the short-lived cache
 */
async function getControls(target, force = false) {
	const hit = cache.get(target.key);
	if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.controls;
	const out = await run([...target.args, "scontents"]);
	const controls = parseControls(out);
	cache.set(target.key, { at: Date.now(), controls });
	return controls;
}

function invalidate(target) {
	if (target === undefined) cache.clear();
	else cache.delete(typeof target === "string" ? target : target.key);
}

/** Look up one control by its amixer id ("Master", "IEC958,1"), or by name. */
async function getControl(target, id, force = false) {
	const controls = await getControls(target, force);
	return controls.find((c) => c.id === id) || controls.find((c) => c.name === id) || null;
}

/**
 * Pick a sensible default control when an action has none configured.
 * @param {object} target from resolveTarget()
 * @param {"playback"|"capture"} kind
 */
async function defaultControl(target, kind) {
	const controls = await getControls(target);
	const prefer =
		kind === "capture"
			? ["Capture", "Mic", "Front Mic", "Rear Mic", "Internal Mic"]
			: ["Master", "PCM", "Speaker", "Headphone", "Line Out"];
	for (const name of prefer) {
		const found = controls.find((c) => c.name === name && (kind === "capture" ? c.kind === "capture" : true));
		if (found) return found;
	}
	return controls.find((c) => c.kind === kind && (c.hasVolume || c.hasSwitch)) || null;
}

// amixer needs the direction spelled out for capture-only switches:
// "on"/"off" drive the playback switch, "cap"/"nocap" the capture switch.
function switchWords(control) {
	const captureOnly = !control.hasPlaybackSwitch && control.hasCaptureSwitch;
	return captureOnly ? { on: "cap", off: "nocap" } : { on: "on", off: "off" };
}

function ssetArgs(target, mapped) {
	const args = [...target.args];
	if (mapped) args.push("-M");
	return args;
}

/**
 * @param {object} target from resolveTarget()
 * @param {object} control a control object from getControl()
 * @param {boolean} muted
 * @param {boolean} [mapped] use amixer's -M perceptual scale
 */
async function setMute(target, control, muted, mapped = false) {
	const w = switchWords(control);
	const args = ssetArgs(target, mapped);
	args.push("sset", control.id, muted ? w.off : w.on);
	await run(args);
	invalidate(target);
}

async function toggleMute(target, control, mapped = false) {
	// Explicit set rather than amixer's "toggle": when channels have drifted out
	// of sync, toggle would flip them independently and never fully mute.
	await setMute(target, control, !control.muted, mapped);
	return !control.muted;
}

/**
 * Nudge a volume by a relative percentage.
 * @param {number} delta signed percentage points
 */
async function adjustVolume(target, control, delta, mapped = false) {
	if (!delta) return;
	const args = ssetArgs(target, mapped);
	args.push("sset", control.id, `${Math.abs(delta)}%${delta > 0 ? "+" : "-"}`);
	await run(args);
	invalidate(target);
}

/** Set a volume to an absolute percentage (0-100). */
async function setVolume(target, control, percent, mapped = false) {
	const clamped = Math.max(0, Math.min(100, Math.round(percent)));
	const args = ssetArgs(target, mapped);
	args.push("sset", control.id, `${clamped}%`);
	await run(args);
	invalidate(target);
}

/** Cycle an enumerated control (e.g. "Auto-Mute Mode") to its next item. */
async function cycleEnum(target, control) {
	if (!control.isEnum || !control.items || !control.items.length) return;
	const at = control.items.indexOf(control.item);
	const next = control.items[(at + 1) % control.items.length];
	await run([...target.args, "sset", control.id, next]);
	invalidate(target);
	return next;
}

module.exports = {
	listCards,
	listTargets,
	defaultDeviceName,
	resolveTarget,
	getControls,
	getControl,
	defaultControl,
	parseControls,
	setMute,
	toggleMute,
	adjustVolume,
	setVolume,
	cycleEnum,
	invalidate,
};
