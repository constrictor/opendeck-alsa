"use strict";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Valentyn Pavliuchenko

// Event-driven change notification via `alsactl monitor <device>`.
//
// alsactl emits one line per control change, e.g.
//   node hw:2, #21 (2,0,0,Master Playback Switch,0) VALUE
// which lets us refresh only the actions bound to the control that moved,
// with no polling. It works for hardware cards and for the `default` device
// (PipeWire/PulseAudio) alike.
//
// One subprocess is spawned per target and reference-counted: it starts when
// the first action on that target appears and is killed when the last one goes
// away.

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

const ENV = { ...process.env, LC_ALL: "C", LANG: "C", LANGUAGE: "C" };
const RESTART_DELAY_MS = 2000;

class CardMonitor extends EventEmitter {
	constructor(log) {
		super();
		this.log = log || (() => {});
		this.targets = new Map(); // target key -> { refs, proc, buf, restart, stopped, device }
		this.available = null; // lazily probed
	}

	/**
	 * Start watching a target (idempotent, reference counted).
	 * @param {{key: string, monitor: string}} target from alsa.resolveTarget()
	 */
	acquire(target) {
		let entry = this.targets.get(target.key);
		if (!entry) {
			entry = { refs: 0, proc: null, buf: "", restart: null, stopped: false, device: target.monitor };
			this.targets.set(target.key, entry);
		}
		entry.refs++;
		if (!entry.proc) this._spawn(target.key, entry);
		return entry;
	}

	/** Stop watching a target once nothing needs it. */
	release(target) {
		const key = typeof target === "string" ? target : target.key;
		const entry = this.targets.get(key);
		if (!entry) return;
		entry.refs = Math.max(0, entry.refs - 1);
		if (entry.refs === 0) this._kill(key, entry);
	}

	_kill(key, entry) {
		entry.stopped = true;
		if (entry.restart) {
			clearTimeout(entry.restart);
			entry.restart = null;
		}
		if (entry.proc) {
			try {
				entry.proc.kill("SIGTERM");
			} catch {
				/* already gone */
			}
			entry.proc = null;
		}
		this.targets.delete(key);
	}

	_spawn(key, entry) {
		if (entry.stopped) return;
		let proc;
		try {
			proc = spawn("alsactl", ["monitor", entry.device], {
				env: ENV,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			this.log(`alsactl monitor unavailable for ${entry.device}: ${err.message}`);
			this.available = false;
			this.emit("unavailable", key, err);
			return;
		}

		entry.proc = proc;
		entry.buf = "";

		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk) => {
			entry.buf += chunk;
			const lines = entry.buf.split("\n");
			entry.buf = lines.pop();
			for (const line of lines) this._handleLine(key, line.trim());
		});

		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (d) => {
			const msg = d.trim();
			if (msg) this.log(`alsactl monitor ${entry.device} stderr: ${msg}`);
		});

		proc.on("error", (err) => {
			this.log(`alsactl monitor ${entry.device} failed to start: ${err.message}`);
			this.available = false;
			entry.proc = null;
			this.emit("unavailable", key, err);
		});

		proc.on("exit", (code, signal) => {
			entry.proc = null;
			if (entry.stopped) return;
			this.log(`alsactl monitor ${entry.device} exited (code=${code} signal=${signal}); restarting`);
			// The card may have been unplugged; retry rather than give up, so a
			// reconnected USB interface starts reporting again on its own.
			entry.restart = setTimeout(() => {
				entry.restart = null;
				if (!entry.stopped) this._spawn(key, entry);
			}, RESTART_DELAY_MS);
		});

		if (this.available === null) this.available = true;
	}

	// "node hw:2, #21 (2,0,0,Master Playback Switch,0) VALUE"
	_handleLine(key, line) {
		if (!line) return;
		const m = line.match(/\(([^)]*)\)/);
		if (!m) return;
		const fields = m[1].split(",");
		// The element name sits between the numeric ifc/dev/subdev prefix and the
		// trailing element index.
		const elemName = fields.length >= 5 ? fields.slice(3, fields.length - 1).join(",").trim() : "";
		// "Master Playback Switch" -> "Master"; the simple-mixer name is the
		// element name minus its Playback/Capture + Volume/Switch suffix.
		const simple = elemName.replace(/\s+(Playback|Capture)\s+(Volume|Switch)$/i, "").replace(/\s+(Volume|Switch)$/i, "").trim();
		this.emit("change", { target: key, element: elemName, control: simple, raw: line });
	}

	/** Tear everything down (called on plugin shutdown). */
	stopAll() {
		for (const [key, entry] of [...this.targets]) this._kill(key, entry);
	}
}

module.exports = { CardMonitor };
