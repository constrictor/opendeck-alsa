#!/usr/bin/env node
"use strict";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Valentyn Pavliuchenko

// OpenDeck ALSA plugin.
//
// Launched by OpenDeck as:
//   plugin.js -port <n> -pluginUUID <uuid> -registerEvent <event> -info <json>
// and speaks the Stream Deck plugin WebSocket protocol. Node 22 ships a global
// WebSocket, so this has no npm dependencies.

const alsa = require("./lib/alsa.js");
const icons = require("./lib/icons.js");
const { CardMonitor } = require("./lib/monitor.js");

const ACTION_VOLUME = "com.valentyn.alsa.volume";
const ACTION_MUTE = "com.valentyn.alsa.mute";

const REFRESH_DEBOUNCE_MS = 60;

function log(...args) {
	process.stderr.write(`[alsa] ${args.join(" ")}\n`);
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("-") && i + 1 < argv.length) {
			out[a.replace(/^-+/, "")] = argv[++i];
		}
	}
	return out;
}

class Plugin {
	constructor(args) {
		this.args = args;
		this.ws = null;
		this.contexts = new Map(); // context -> instance
		this.monitor = new CardMonitor(log);
		this.refreshTimers = new Map(); // target key -> timeout
		this.dirtyControls = new Map(); // target key -> Set<control name>
		this.monitorWarned = false;

		this.monitor.on("change", (e) => this.onCardChange(e));
		this.monitor.on("unavailable", () => {
			if (this.monitorWarned) return;
			this.monitorWarned = true;
			log("alsactl monitor is unavailable; falling back to polling every 2s");
			this.startPollingFallback();
		});
	}

	connect() {
		const url = `ws://127.0.0.1:${this.args.port}`;
		const ws = new WebSocket(url);
		this.ws = ws;

		ws.addEventListener("open", () => {
			log(`connected to ${url}`);
			this.send({ event: this.args.registerEvent, uuid: this.args.pluginUUID });
		});
		ws.addEventListener("message", (ev) => {
			let msg;
			try {
				msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
			} catch (err) {
				log(`bad message: ${err.message}`);
				return;
			}
			this.onMessage(msg).catch((err) => log(`handler error: ${err.stack || err.message}`));
		});
		ws.addEventListener("close", () => {
			log("socket closed; shutting down");
			this.shutdown();
			process.exit(0);
		});
		ws.addEventListener("error", (err) => log(`socket error: ${err.message || err}`));
	}

	send(obj) {
		if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
	}

	shutdown() {
		this.monitor.stopAll();
		if (this.pollTimer) clearInterval(this.pollTimer);
	}

	// ---------------------------------------------------------------- events

	async onMessage(msg) {
		switch (msg.event) {
			case "willAppear":
				return this.onWillAppear(msg);
			case "willDisappear":
				return this.onWillDisappear(msg);
			case "didReceiveSettings":
				return this.onDidReceiveSettings(msg);
			case "keyDown":
				return this.onKeyDown(msg);
			case "keyUp":
				return; // acted on keyDown for responsiveness
			case "dialRotate":
				return this.onDialRotate(msg);
			case "dialDown":
				return this.onDialPress(msg);
			case "dialUp":
				return;
			case "touchTap":
				return this.onDialPress(msg);
			case "sendToPlugin":
				return this.onSendToPlugin(msg);
			case "systemDidWakeUp":
				alsa.invalidate();
				return this.refreshAll();
			case "deviceDidConnect":
				return this.refreshAll();
			default:
				return;
		}
	}

	async onWillAppear(msg) {
		const inst = {
			context: msg.context,
			action: msg.action,
			controller: (msg.payload && msg.payload.controller) || "Keypad",
			settings: (msg.payload && msg.payload.settings) || {},
			target: null,
			queue: Promise.resolve(),
			pendingDelta: 0,
		};
		this.contexts.set(msg.context, inst);
		this.bindMonitor(inst);
		if (inst.controller === "Encoder") {
			this.send({ event: "setFeedbackLayout", context: inst.context, payload: { layout: "$B1" } });
		}
		await this.render(inst);
	}

	onWillDisappear(msg) {
		const inst = this.contexts.get(msg.context);
		if (!inst) return;
		if (inst.target) this.monitor.release(inst.target);
		this.contexts.delete(msg.context);
	}

	async onDidReceiveSettings(msg) {
		const inst = this.contexts.get(msg.context);
		if (!inst) return;
		inst.settings = (msg.payload && msg.payload.settings) || {};
		if (msg.payload && msg.payload.controller) inst.controller = msg.payload.controller;
		this.bindMonitor(inst);
		alsa.invalidate();
		await this.render(inst);
	}

	// Keep the per-target alsactl subprocess reference count in step with the
	// card or device this instance currently points at.
	bindMonitor(inst) {
		const target = alsa.resolveTarget(inst.settings.card);
		if (inst.target && inst.target.key === target.key) return;
		if (inst.target) this.monitor.release(inst.target);
		inst.target = target;
		this.monitor.acquire(target);
	}

	// ---------------------------------------------------------------- input

	async onKeyDown(msg) {
		const inst = this.contexts.get(msg.context);
		if (!inst) return;
		if (inst.action === ACTION_MUTE) return this.doMute(inst);

		const mode = inst.settings.keyAction || "toggleMute";
		if (mode === "toggleMute") return this.doMute(inst);
		if (mode === "set") return this.doSetVolume(inst, Number(inst.settings.setTo ?? 50));
		const step = this.stepOf(inst);
		return this.doAdjust(inst, mode === "down" ? -step : step);
	}

	async onDialRotate(msg) {
		const inst = this.contexts.get(msg.context);
		if (!inst) return;
		const ticks = Number((msg.payload && msg.payload.ticks) || 0);
		if (!ticks) return;
		if (inst.action === ACTION_MUTE) {
			// A mute dial has nothing to scrub; treat rotation as an explicit
			// mute/unmute so the direction is predictable.
			return this.doSetMute(inst, ticks < 0);
		}
		return this.doAdjust(inst, ticks * this.stepOf(inst));
	}

	async onDialPress(msg) {
		const inst = this.contexts.get(msg.context);
		if (!inst) return;
		if (inst.action === ACTION_MUTE) return this.doMute(inst);
		if ((inst.settings.pressAction || "toggleMute") === "none") return;
		return this.doMute(inst);
	}

	stepOf(inst) {
		const n = Number(inst.settings.step);
		return Number.isFinite(n) && n > 0 ? n : 5;
	}

	// Serialise writes per instance and coalesce rotation bursts, so spinning a
	// dial fast issues a steady trickle of amixer calls instead of dozens.
	enqueue(inst, fn) {
		inst.queue = inst.queue.then(fn).catch((err) => {
			log(`${inst.action} ${inst.context}: ${err.message}`);
			this.send({ event: "showAlert", context: inst.context });
		});
		return inst.queue;
	}

	async resolve(inst, kindHint) {
		const target = alsa.resolveTarget(inst.settings.card);
		let control = null;
		if (inst.settings.control) control = await alsa.getControl(target, inst.settings.control);
		if (!control && !inst.settings.control) control = await alsa.defaultControl(target, kindHint);
		return { target, control };
	}

	kindHint(inst) {
		if (inst.settings.kind === "capture" || inst.settings.kind === "playback") return inst.settings.kind;
		if (inst.action !== ACTION_MUTE) return "playback";
		// A freshly dropped Mute Toggle has no settings at all, and its property
		// inspector shows "Microphone" as the pre-selected target — so an unset
		// preset has to mean the mic here, or the two agree on screen and
		// disagree in behaviour.
		return (inst.settings.preset ?? "mic") === "mic" ? "capture" : "playback";
	}

	doAdjust(inst, delta) {
		inst.pendingDelta += delta;
		return this.enqueue(inst, async () => {
			const amount = inst.pendingDelta;
			inst.pendingDelta = 0;
			if (!amount) return;
			const { target, control } = await this.resolve(inst, this.kindHint(inst));
			if (!control) return this.render(inst);
			if (!control.hasVolume) {
				this.send({ event: "showAlert", context: inst.context });
				return this.render(inst);
			}
			// Raising the volume on a muted control should unmute it, which is
			// what every desktop volume UI does.
			if (amount > 0 && control.muted && control.hasSwitch && inst.settings.unmuteOnRaise !== false) {
				await alsa.setMute(target, control, false, !!inst.settings.mapped);
			}
			await alsa.adjustVolume(target, control, amount, !!inst.settings.mapped);
			await this.render(inst);
		});
	}

	doSetVolume(inst, percent) {
		return this.enqueue(inst, async () => {
			const { target, control } = await this.resolve(inst, this.kindHint(inst));
			if (!control || !control.hasVolume) {
				this.send({ event: "showAlert", context: inst.context });
				return this.render(inst);
			}
			await alsa.setVolume(target, control, percent, !!inst.settings.mapped);
			await this.render(inst);
		});
	}

	doMute(inst) {
		return this.enqueue(inst, async () => {
			const { target, control } = await this.resolve(inst, this.kindHint(inst));
			if (!control) {
				this.send({ event: "showAlert", context: inst.context });
				return this.render(inst);
			}
			if (control.isEnum) {
				await alsa.cycleEnum(target, control);
			} else if (control.hasSwitch) {
				await alsa.toggleMute(target, control, !!inst.settings.mapped);
			} else if (control.hasVolume) {
				// No switch: emulate mute by parking the level at 0 and restoring
				// the remembered level on unmute.
				if (control.percent > 0) {
					inst.restoreLevel = control.percent;
					await alsa.setVolume(target, control, 0, !!inst.settings.mapped);
				} else {
					await alsa.setVolume(target, control, inst.restoreLevel || 100, !!inst.settings.mapped);
				}
			} else {
				this.send({ event: "showAlert", context: inst.context });
			}
			await this.render(inst);
		});
	}

	doSetMute(inst, muted) {
		return this.enqueue(inst, async () => {
			const { target, control } = await this.resolve(inst, this.kindHint(inst));
			if (!control || !control.hasSwitch) return this.render(inst);
			await alsa.setMute(target, control, muted, !!inst.settings.mapped);
			await this.render(inst);
		});
	}

	// --------------------------------------------------------------- render

	async render(inst) {
		const target = alsa.resolveTarget(inst.settings.card);
		let control = null;
		try {
			if (inst.settings.control) control = await alsa.getControl(target, inst.settings.control);
			if (!control && !inst.settings.control) control = await alsa.defaultControl(target, this.kindHint(inst));
		} catch (err) {
			log(`render: ${err.message}`);
		}

		const isMute = inst.action === ACTION_MUTE;
		const label = this.labelFor(inst, control);

		if (!control) {
			const image = icons.unavailableIcon(inst.settings.control || "no control");
			this.send({ event: "setImage", context: inst.context, payload: { image, target: 0 } });
			if (inst.controller === "Encoder") {
				this.send({
					event: "setFeedback",
					context: inst.context,
					payload: { title: label, value: "n/a", icon: image, indicator: { value: 0 } },
				});
			}
			return;
		}

		const state = {
			kind: control.kind === "capture" ? "capture" : "playback",
			muted: control.isEnum ? control.item === (control.items && control.items[0]) : control.muted,
			percent: control.percent,
			text: inst.settings.showLabel === false ? "" : label,
		};

		// On a dial the state image is what the strip renderer drops into the
		// layout's 48x48 icon slot, so it gets the plain glyph. A key has the
		// whole face to itself and gets the level ring and percentage.
		const isEncoder = inst.controller === "Encoder";
		const image = isEncoder
			? icons.glyphIcon(state)
			: isMute
				? icons.muteIcon(state)
				: icons.volumeIcon(state);

		this.send({ event: "setImage", context: inst.context, payload: { image, target: 0 } });
		this.send({ event: "setState", context: inst.context, payload: { state: state.muted ? 1 : 0 } });

		if (isEncoder) {
			const value = control.isEnum
				? String(control.item)
				: state.muted
					? "Muted"
					: control.percent === null
						? "On"
						: `${control.percent}%`;
			this.send({
				event: "setFeedback",
				context: inst.context,
				payload: {
					title: label,
					value,
					icon: image,
					indicator: {
						value: state.muted || control.percent === null ? 0 : control.percent,
						opacity: state.muted ? 0.4 : 1,
					},
				},
			});
		}
	}

	labelFor(inst, control) {
		if (inst.settings.label) return inst.settings.label;
		if (control) return control.name;
		return inst.settings.control || "ALSA";
	}

	async refreshAll() {
		for (const inst of this.contexts.values()) {
			await this.render(inst).catch(() => {});
		}
	}

	// --------------------------------------------------- external change sync

	onCardChange({ target, control }) {
		let set = this.dirtyControls.get(target);
		if (!set) {
			set = new Set();
			this.dirtyControls.set(target, set);
		}
		set.add(control);

		// A single volume nudge emits several element events; debounce so one
		// burst costs one amixer read.
		if (this.refreshTimers.has(target)) return;
		this.refreshTimers.set(
			target,
			setTimeout(() => {
				this.refreshTimers.delete(target);
				const dirty = this.dirtyControls.get(target) || new Set();
				this.dirtyControls.delete(target);
				this.refreshTarget(target, dirty).catch((err) => log(`refresh: ${err.message}`));
			}, REFRESH_DEBOUNCE_MS),
		);
	}

	async refreshTarget(targetKey, dirty) {
		alsa.invalidate(targetKey);
		const affected = [];
		for (const inst of this.contexts.values()) {
			if (alsa.resolveTarget(inst.settings.card).key !== targetKey) continue;
			// Instances with no explicit control follow whatever default we pick,
			// so refresh them on any change to their card.
			if (!inst.settings.control) {
				affected.push(inst);
				continue;
			}
			const name = String(inst.settings.control).split(",")[0];
			if (dirty.size === 0 || dirty.has(name)) affected.push(inst);
		}
		for (const inst of affected) await this.render(inst).catch(() => {});
	}

	// Only used when alsactl is missing or fails to start.
	startPollingFallback() {
		if (this.pollTimer) return;
		this.pollTimer = setInterval(() => {
			if (this.contexts.size === 0) return;
			alsa.invalidate();
			this.refreshAll().catch(() => {});
		}, 2000);
	}

	// --------------------------------------------------- property inspector

	async onSendToPlugin(msg) {
		const payload = msg.payload || {};
		const reply = (data) =>
			this.send({
				event: "sendToPropertyInspector",
				context: msg.context,
				action: msg.action,
				payload: data,
			});

		if (payload.event === "getCards") {
			return reply({ event: "cards", cards: alsa.listTargets() });
		}
		if (payload.event === "getControls") {
			const target = alsa.resolveTarget(payload.card);
			try {
				const controls = await alsa.getControls(target, true);
				return reply({
					event: "controls",
					card: target.key,
					controls: controls.map((c) => ({
						id: c.id,
						name: c.name,
						kind: c.kind,
						hasVolume: c.hasVolume,
						hasSwitch: c.hasSwitch,
						isEnum: c.isEnum,
						percent: c.percent,
						muted: c.muted,
					})),
				});
			} catch (err) {
				return reply({ event: "controls", card: target.key, controls: [], error: err.message });
			}
		}
	}
}

const args = parseArgs(process.argv.slice(2));
if (!args.port || !args.pluginUUID || !args.registerEvent) {
	log("missing -port/-pluginUUID/-registerEvent; this binary is launched by OpenDeck");
	process.exit(1);
}

const plugin = new Plugin(args);
plugin.connect();

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		plugin.shutdown();
		process.exit(0);
	});
}
process.on("uncaughtException", (err) => log(`uncaught: ${err.stack || err.message}`));
process.on("unhandledRejection", (err) => log(`unhandled: ${(err && err.stack) || err}`));
