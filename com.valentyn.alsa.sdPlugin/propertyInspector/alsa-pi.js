"use strict";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Valentyn Pavliuchenko

// Shared property inspector plumbing for both ALSA actions.
//
// Cards and controls are fetched live from the plugin over the websocket
// (sendToPlugin -> sendToPropertyInspector) so the dropdowns always reflect the
// hardware that is actually present.

const ALSA_PI = (() => {
	let ws = null;
	let actionInfo = null;
	let settings = {};
	let onSettings = () => {};
	let cards = [];
	let controls = [];
	let onControls = () => {};

	function sendToPlugin(payload) {
		if (!ws || ws.readyState !== 1) return;
		ws.send(
			JSON.stringify({
				event: "sendToPlugin",
				action: actionInfo.action,
				context: actionInfo.context,
				payload,
			}),
		);
	}

	function save() {
		if (!ws || ws.readyState !== 1) return;
		ws.send(
			JSON.stringify({
				event: "setSettings",
				context: actionInfo.context,
				payload: settings,
			}),
		);
	}

	function set(key, value) {
		settings[key] = value;
		save();
	}

	/**
	 * Write defaults for keys the user has never touched.
	 *
	 * Without this a freshly dropped action keeps empty settings while the form
	 * displays its own fallbacks, so the inspector and the plugin can disagree
	 * about what the action does. Persisting on first open makes what is shown
	 * and what runs the same thing.
	 */
	function applyDefaults(defaults) {
		let changed = false;
		for (const [k, v] of Object.entries(defaults)) {
			if (v === undefined) continue; // "not applicable here", not a default
			if (settings[k] === undefined) {
				settings[k] = v;
				changed = true;
			}
		}
		if (changed) save();
		return changed;
	}

	function requestControls(card) {
		sendToPlugin({ event: "getControls", card: card ?? settings.card ?? "" });
	}

	/** Fill a <select> with options, preserving the current value when possible. */
	function fill(select, options, value, placeholder) {
		select.innerHTML = "";
		if (placeholder) {
			const opt = document.createElement("option");
			opt.value = "";
			opt.textContent = placeholder;
			select.appendChild(opt);
		}
		for (const o of options) {
			const opt = document.createElement("option");
			opt.value = o.value;
			opt.textContent = o.label;
			if (o.disabled) opt.disabled = true;
			select.appendChild(opt);
		}
		// If the saved value is gone (card unplugged), keep it visible as a
		// dangling entry rather than silently retargeting the action.
		if (value && !options.some((o) => String(o.value) === String(value))) {
			const opt = document.createElement("option");
			opt.value = value;
			opt.textContent = `${value} (not present)`;
			select.appendChild(opt);
		}
		select.value = value ?? "";
	}

	function connect(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
		actionInfo = typeof inActionInfo === "string" ? JSON.parse(inActionInfo) : inActionInfo;
		settings = (actionInfo.payload && actionInfo.payload.settings) || {};

		ws = new WebSocket(`ws://localhost:${inPort}`);
		ws.onopen = () => {
			ws.send(JSON.stringify({ event: inRegisterEvent, uuid: inUUID }));
			sendToPlugin({ event: "getCards" });
			requestControls();
		};
		ws.onmessage = (ev) => {
			let msg;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				return;
			}
			const p = msg.payload || {};
			if (msg.event === "sendToPropertyInspector") {
				if (p.event === "cards") {
					cards = p.cards || [];
					renderCards();
				} else if (p.event === "controls") {
					controls = p.controls || [];
					onControls(controls);
				}
			} else if (msg.event === "didReceiveSettings") {
				settings = (msg.payload && msg.payload.settings) || {};
				onSettings(settings);
			}
		};

		onSettings(settings);
		return api;
	}

	function renderCards() {
		const select = document.getElementById("card");
		if (!select) return;
		// The plugin already labels these: the ALSA `default` device first (which
		// is PipeWire or PulseAudio on most desktops), then each hardware card,
		// in the same order alsamixer's F6 dialog lists them.
		const value = settings.card === undefined || settings.card === "" ? "default" : settings.card;
		fill(select, cards, value);
	}

	const api = {
		connect,
		get settings() {
			return settings;
		},
		get controls() {
			return controls;
		},
		get cards() {
			return cards;
		},
		/** The action's UUID, so a panel shared by several actions can tell them apart. */
		get action() {
			return (actionInfo && actionInfo.action) || "";
		},
		/** "Keypad" or "Encoder" — which physical control this instance sits on. */
		get controller() {
			return (actionInfo && actionInfo.payload && actionInfo.payload.controller) || "Keypad";
		},
		set,
		save,
		applyDefaults,
		fill,
		requestControls,
		onSettings(fn) {
			onSettings = fn;
		},
		onControls(fn) {
			onControls = fn;
		},
	};
	return api;
})();

// OpenDeck / Stream Deck entry point.
function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
	ALSA_PI.connect(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo);
	if (typeof onPropertyInspectorReady === "function") onPropertyInspectorReady(ALSA_PI);
}
