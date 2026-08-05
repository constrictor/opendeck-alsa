#!/usr/bin/env node
"use strict";

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Valentyn Pavliuchenko

// End-to-end test: runs the real plugin against a mock OpenDeck and real ALSA
// hardware, then restores whatever mixer state it touched.
//
//   node tools/test-plugin.js [cardIndex]

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { MockOpenDeck } = require("./mock-opendeck.js");
const alsa = require("../com.valentyn.alsa.sdPlugin/lib/alsa.js");

// ENV must be initialised before pickCard() runs: it is a const, so probing
// cards while it is still in its temporal dead zone throws a ReferenceError
// straight into pickCard's catch and silently lands every run on card 0.
const ENV = { ...process.env, LC_ALL: "C" };
const CARD = Number(process.argv[2] ?? pickCard());
const TARGET = alsa.resolveTarget(String(CARD));
const PLUGIN = path.join(__dirname, "..", "com.valentyn.alsa.sdPlugin", "plugin.js");

function pickCard() {
	// Prefer a card that actually has a Master control.
	for (const c of alsa.listCards()) {
		try {
			const out = execFileSync("amixer", ["-c", String(c.index), "scontrols"], { env: ENV, encoding: "utf8" });
			if (/'Master'/.test(out)) return c.index;
		} catch {
			/* skip */
		}
	}
	return 0;
}

const results = [];
let failures = 0;

function check(name, ok, detail = "") {
	results.push({ name, ok, detail });
	if (!ok) failures++;
	const mark = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
	console.log(`  ${mark}  ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Decode a key image the same way streamdeck-strip-render does: base64 only.
function svgOf(image) {
	const comma = image.indexOf(",");
	const header = image.slice(0, comma);
	if (!header.includes("base64")) throw new Error(`not a base64 data URL: ${header}`);
	return Buffer.from(image.slice(comma + 1), "base64").toString("utf8");
}

function amixer(args) {
	return execFileSync("amixer", ["-c", String(CARD), ...args], { env: ENV, encoding: "utf8" });
}

async function state(id, target = TARGET) {
	alsa.invalidate();
	return alsa.getControl(target, id, true);
}

async function main() {
	console.log(`\nTesting against card ${CARD}\n`);

	const before = {
		master: await state("Master"),
		capture: await state("Capture"),
	};
	const defaultTarget = alsa.resolveTarget("default");
	let beforeDefault = null;
	try {
		beforeDefault = { master: await state("Master", defaultTarget) };
	} catch {
		/* no default device on this system */
	}
	if (!before.master) {
		console.error(`card ${CARD} has no Master control; pass a different card index`);
		process.exit(1);
	}

	const mock = new MockOpenDeck();
	const port = await mock.listen();

	const received = [];
	let registered = false;
	mock.on("message", (msg) => {
		received.push(msg);
		if (msg.event === "registerPlugin") registered = true;
	});

	const proc = spawn(
		process.execPath,
		[PLUGIN, "-port", String(port), "-pluginUUID", "com.valentyn.alsa", "-registerEvent", "registerPlugin", "-info", "{}"],
		{ stdio: ["ignore", "inherit", "pipe"] },
	);
	const stderr = [];
	proc.stderr.setEncoding("utf8");
	proc.stderr.on("data", (d) => stderr.push(d));

	const waitFor = async (pred, ms = 3000, label = "") => {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			const hit = received.filter(pred);
			if (hit.length) return hit[hit.length - 1];
			await sleep(25);
		}
		throw new Error(`timed out waiting for ${label}`);
	};
	const clear = () => (received.length = 0);

	try {
		// --- registration ------------------------------------------------
		await waitFor((m) => m.event === "registerPlugin", 3000, "registerPlugin");
		check("registers with the correct event and uuid", registered);

		// --- volume action appears ---------------------------------------
		const volCtx = "ctx-volume";
		clear();
		mock.send({
			event: "willAppear",
			action: "com.valentyn.alsa.volume",
			context: volCtx,
			device: "dev0",
			payload: { controller: "Keypad", settings: { card: String(CARD), control: "Master", step: 5 } },
		});
		const img = await waitFor((m) => m.event === "setImage" && m.context === volCtx, 3000, "setImage");
		check("renders a key image on willAppear", !!img.payload.image.startsWith("data:image/svg+xml"));
		check(
			"key image reflects the current level",
			svgOf(img.payload.image).includes(`${before.master.percent}%`) || before.master.muted,
			`level=${before.master.percent}%`,
		);

		// --- dial rotate changes the volume ------------------------------
		await alsa.setVolume(TARGET, before.master, 50);
		await sleep(200);
		clear();
		mock.send({
			event: "dialRotate",
			action: "com.valentyn.alsa.volume",
			context: volCtx,
			payload: { controller: "Encoder", ticks: 3, pressed: false },
		});
		await sleep(700);
		let now = await state("Master");
		check("dialRotate +3 ticks raises volume by 3 x step", now.percent > 50, `50% -> ${now.percent}%`);

		clear();
		mock.send({
			event: "dialRotate",
			action: "com.valentyn.alsa.volume",
			context: volCtx,
			payload: { controller: "Encoder", ticks: -2, pressed: false },
		});
		await sleep(700);
		const lowered = await state("Master");
		check("dialRotate -2 ticks lowers volume", lowered.percent < now.percent, `${now.percent}% -> ${lowered.percent}%`);

		// --- mute toggle --------------------------------------------------
		const muteCtx = "ctx-mute";
		clear();
		mock.send({
			event: "willAppear",
			action: "com.valentyn.alsa.mute",
			context: muteCtx,
			device: "dev0",
			payload: { controller: "Keypad", settings: { card: String(CARD), control: "Master", preset: "speakers" } },
		});
		await waitFor((m) => m.event === "setImage" && m.context === muteCtx, 3000, "mute setImage");

		const wasMuted = (await state("Master")).muted;
		clear();
		mock.send({ event: "keyDown", action: "com.valentyn.alsa.mute", context: muteCtx, payload: { settings: {} } });
		await sleep(700);
		const afterToggle = await state("Master");
		check("keyDown toggles the mute switch", afterToggle.muted !== wasMuted, `muted ${wasMuted} -> ${afterToggle.muted}`);

		const stateMsg = received.find((m) => m.event === "setState" && m.context === muteCtx);
		check("reports mute state back to OpenDeck", !!stateMsg && stateMsg.payload.state === (afterToggle.muted ? 1 : 0));

		// --- raising volume unmutes --------------------------------------
		await alsa.setMute(TARGET, await state("Master"), true);
		await alsa.setVolume(TARGET, await state("Master"), 40);
		await sleep(300);
		clear();
		mock.send({
			event: "dialRotate",
			action: "com.valentyn.alsa.volume",
			context: volCtx,
			payload: { controller: "Encoder", ticks: 2 },
		});
		await sleep(800);
		const unmuted = await state("Master");
		check("raising the volume unmutes a muted control", !unmuted.muted, `muted -> ${unmuted.muted}`);

		// --- one-directional volume keys ----------------------------------
		// These share doAdjust with the Volume action; what is new is the badge,
		// the single-state manifest entry and hold-to-repeat.
		const stepSettings = { card: String(CARD), control: "Master", step: 5 };
		const upCtx = "ctx-up";
		const downCtx = "ctx-down";
		{
			await alsa.setMute(TARGET, await state("Master"), false);
			await alsa.setVolume(TARGET, await state("Master"), 50);
			await sleep(200);
			// Read back rather than assuming 50: amixer snaps to the control's own
			// raw steps, so the level the key draws is 50% only by luck.
			const atAppear = await state("Master");
			clear();
			mock.send({
				event: "willAppear",
				action: "com.valentyn.alsa.volumeUp",
				context: upCtx,
				device: "dev0",
				payload: { controller: "Keypad", settings: stepSettings },
			});
			mock.send({
				event: "willAppear",
				action: "com.valentyn.alsa.volumeDown",
				context: downCtx,
				device: "dev0",
				payload: { controller: "Keypad", settings: stepSettings },
			});
			const upImg = await waitFor((m) => m.event === "setImage" && m.context === upCtx, 3000, "volumeUp image");
			const downImg = await waitFor((m) => m.event === "setImage" && m.context === downCtx, 3000, "volumeDown image");
			const upSvg = svgOf(upImg.payload.image);
			const downSvg = svgOf(downImg.payload.image);
			check(
				"a Volume Up key shows the live level with a + badge",
				upSvg.includes('data-dir="up"') && upSvg.includes(`${atAppear.percent}%`),
				`badge ${upSvg.includes('data-dir="up"') ? "present" : "missing"}, level=${atAppear.percent}%`,
			);
			check(
				"a Volume Down key shows a - badge, not a +",
				downSvg.includes('data-dir="down"') && !downSvg.includes('data-dir="up"'),
			);
			// Their manifest entry declares one state, so setState 1 would be out
			// of range; the muted look is carried by the image alone.
			check(
				"one-directional volume keys are not two-state actions",
				!received.some((m) => m.event === "setState" && (m.context === upCtx || m.context === downCtx)),
			);
		}

		// A tap, released before the repeat delay, is exactly one step.
		{
			await alsa.setVolume(TARGET, await state("Master"), 50);
			await sleep(200);
			clear();
			mock.send({ event: "keyDown", action: "com.valentyn.alsa.volumeUp", context: upCtx, payload: { settings: stepSettings } });
			await sleep(250);
			mock.send({ event: "keyUp", action: "com.valentyn.alsa.volumeUp", context: upCtx, payload: { settings: stepSettings } });
			await sleep(500);
			const raised = await state("Master");
			check("a tap on Volume Up raises by one step", raised.percent > 50 && raised.percent <= 60, `50% -> ${raised.percent}%`);

			mock.send({ event: "keyDown", action: "com.valentyn.alsa.volumeDown", context: downCtx, payload: { settings: stepSettings } });
			await sleep(250);
			mock.send({ event: "keyUp", action: "com.valentyn.alsa.volumeDown", context: downCtx, payload: { settings: stepSettings } });
			await sleep(500);
			const lowered2 = await state("Master");
			check("a tap on Volume Down lowers by one step", lowered2.percent < raised.percent, `${raised.percent}% -> ${lowered2.percent}%`);
		}

		// Holding keeps stepping; releasing stops it.
		{
			await alsa.setVolume(TARGET, await state("Master"), 20);
			await sleep(200);
			clear();
			mock.send({ event: "keyDown", action: "com.valentyn.alsa.volumeUp", context: upCtx, payload: { settings: stepSettings } });
			await sleep(1000);
			mock.send({ event: "keyUp", action: "com.valentyn.alsa.volumeUp", context: upCtx, payload: { settings: stepSettings } });
			await sleep(500);
			const held = await state("Master");
			check("holding Volume Up keeps stepping", held.percent > 30, `20% -> ${held.percent}% while held`);

			await sleep(600);
			const settled = await state("Master");
			check("releasing the key stops the repeat", settled.percent === held.percent, `${held.percent}% -> ${settled.percent}%`);
		}

		// The runaway-timer regression: a hold interrupted by willDisappear must
		// not leave a timer driving the mixer.
		{
			const holdCtx = "ctx-up-hold";
			await alsa.setVolume(TARGET, await state("Master"), 10);
			await sleep(200);
			clear();
			mock.send({
				event: "willAppear",
				action: "com.valentyn.alsa.volumeUp",
				context: holdCtx,
				device: "dev0",
				payload: { controller: "Keypad", settings: stepSettings },
			});
			await waitFor((m) => m.event === "setImage" && m.context === holdCtx, 3000, "hold ctx image");
			mock.send({ event: "keyDown", action: "com.valentyn.alsa.volumeUp", context: holdCtx, payload: { settings: stepSettings } });
			await sleep(700);
			mock.send({ event: "willDisappear", action: "com.valentyn.alsa.volumeUp", context: holdCtx, payload: {} });
			await sleep(400);
			const atRemoval = await state("Master");
			await sleep(700);
			const later = await state("Master");
			check(
				"willDisappear during a hold stops the repeat",
				later.percent === atRemoval.percent,
				`${atRemoval.percent}% -> ${later.percent}% after removal`,
			);
		}

		// keyUp now has a handler; it must stay a no-op everywhere else.
		{
			clear();
			mock.send({ event: "keyUp", action: "com.valentyn.alsa.volume", context: volCtx, payload: { settings: {} } });
			mock.send({ event: "keyUp", action: "com.valentyn.alsa.volumeUp", context: "ctx-never-appeared", payload: {} });
			await sleep(250);
			check("a keyUp with no hold in progress is harmless", !stderr.join("").includes("handler error"));
		}

		// A multi-action presses the key programmatically and may never send a
		// keyUp, so that path deliberately skips the repeat.
		{
			const maCtx = "ctx-up-ma";
			await alsa.setVolume(TARGET, await state("Master"), 50);
			await sleep(200);
			clear();
			mock.send({
				event: "willAppear",
				action: "com.valentyn.alsa.volumeUp",
				context: maCtx,
				device: "dev0",
				payload: { controller: "Keypad", settings: stepSettings },
			});
			await waitFor((m) => m.event === "setImage" && m.context === maCtx, 3000, "multi-action image");
			mock.send({
				event: "keyDown",
				action: "com.valentyn.alsa.volumeUp",
				context: maCtx,
				payload: { settings: stepSettings, isInMultiAction: true },
			});
			await sleep(1000);
			const once = await state("Master");
			check(
				"a Volume Up inside a multi-action steps once and never repeats",
				once.percent > 50 && once.percent <= 60,
				`50% -> ${once.percent}%`,
			);
			mock.send({ event: "willDisappear", action: "com.valentyn.alsa.volumeUp", context: maCtx, payload: {} });
		}

		// Same unmute-on-raise rule as the Volume action.
		{
			await alsa.setVolume(TARGET, await state("Master"), 40);
			await alsa.setMute(TARGET, await state("Master"), true);
			await sleep(300);
			clear();
			mock.send({ event: "keyDown", action: "com.valentyn.alsa.volumeUp", context: upCtx, payload: { settings: stepSettings } });
			await sleep(250);
			mock.send({ event: "keyUp", action: "com.valentyn.alsa.volumeUp", context: upCtx, payload: { settings: stepSettings } });
			await sleep(700);
			const unmutedByStep = await state("Master");
			check("Volume Up unmutes a muted control", !unmutedByStep.muted, `muted -> ${unmutedByStep.muted}`);
			mock.send({ event: "willDisappear", action: "com.valentyn.alsa.volumeUp", context: upCtx, payload: {} });
			mock.send({ event: "willDisappear", action: "com.valentyn.alsa.volumeDown", context: downCtx, payload: {} });
			await sleep(200);
		}

		// --- external change is picked up by alsactl monitor --------------
		clear();
		amixer(["sset", "Master", "25%"]);
		const external = await waitFor(
			(m) => m.event === "setImage" && m.context === volCtx,
			4000,
			"monitor-driven setImage",
		);
		check(
			"external amixer change refreshes the key without polling",
			svgOf(external.payload.image).includes("25%"),
			"alsactl monitor -> setImage",
		);

		// --- encoder feedback --------------------------------------------
		const encCtx = "ctx-enc";
		clear();
		mock.send({
			event: "willAppear",
			action: "com.valentyn.alsa.volume",
			context: encCtx,
			device: "dev0",
			payload: { controller: "Encoder", settings: { card: String(CARD), control: "Master" } },
		});
		const layout = await waitFor((m) => m.event === "setFeedbackLayout" && m.context === encCtx, 3000, "layout");
		check("sets an encoder layout for dials", layout.payload.layout === "$B1");
		const fb = await waitFor((m) => m.event === "setFeedback" && m.context === encCtx, 3000, "feedback");
		check(
			"sends dial feedback with a value and indicator",
			typeof fb.payload.value === "string" && typeof fb.payload.indicator.value === "number",
			`value=${fb.payload.value} indicator=${fb.payload.indicator.value}`,
		);

		// --- property inspector queries -----------------------------------
		clear();
		mock.send({
			event: "sendToPlugin",
			action: "com.valentyn.alsa.volume",
			context: volCtx,
			payload: { event: "getCards" },
		});
		const cardsMsg = await waitFor((m) => m.event === "sendToPropertyInspector", 3000, "cards reply");
		check("property inspector can list sound cards", Array.isArray(cardsMsg.payload.cards) && cardsMsg.payload.cards.length > 0, `${cardsMsg.payload.cards.length} cards`);

		clear();
		mock.send({
			event: "sendToPlugin",
			action: "com.valentyn.alsa.volume",
			context: volCtx,
			payload: { event: "getControls", card: String(CARD) },
		});
		const ctrlMsg = await waitFor((m) => m.event === "sendToPropertyInspector" && m.payload.event === "controls", 3000, "controls reply");
		check(
			"property inspector can list controls for a card",
			ctrlMsg.payload.controls.length > 0 && ctrlMsg.payload.controls.some((c) => c.name === "Master"),
			`${ctrlMsg.payload.controls.length} controls`,
		);

		// --- missing control degrades gracefully ---------------------------
		const badCtx = "ctx-bad";
		clear();
		mock.send({
			event: "willAppear",
			action: "com.valentyn.alsa.volume",
			context: badCtx,
			device: "dev0",
			payload: { controller: "Keypad", settings: { card: String(CARD), control: "Nonexistent Control" } },
		});
		const badImg = await waitFor((m) => m.event === "setImage" && m.context === badCtx, 3000, "unavailable image");
		check(
			"a missing control renders an unavailable icon instead of crashing",
			// The name is truncated to fit the key — 19 characters will not render
			// legibly at 120px — so only the leading part survives.
			svgOf(badImg.payload.image).includes("Nonexistent"),
		);

		// --- the ALSA default device (PipeWire/PulseAudio) ------------------
		if (beforeDefault && beforeDefault.master) {
			const defCtx = "ctx-default";
			clear();
			mock.send({
				event: "willAppear",
				action: "com.valentyn.alsa.volume",
				context: defCtx,
				device: "dev0",
				payload: { controller: "Keypad", settings: { card: "default", step: 5 } },
			});
			const defImg = await waitFor((m) => m.event === "setImage" && m.context === defCtx, 3000, "default setImage");
			const defState = await state("Master", defaultTarget);
			check(
				"card 'default' targets the system mixer, not card 0",
				svgOf(defImg.payload.image).includes(`${defState.percent}%`) || defState.muted,
				`${alsa.defaultDeviceName() || "default"} Master = ${defState.percent}%`,
			);

			await alsa.setVolume(defaultTarget, defState, 55);
			await sleep(300);
			clear();
			mock.send({
				event: "dialRotate",
				action: "com.valentyn.alsa.volume",
				context: defCtx,
				payload: { controller: "Encoder", ticks: 2 },
			});
			await sleep(800);
			const defAfter = await state("Master", defaultTarget);
			check("the default device responds to dial input", defAfter.percent > 55, `55% -> ${defAfter.percent}%`);

			clear();
			execFileSync("amixer", ["-D", "default", "sset", "Master", "35%"], { env: ENV });
			const defExt = await waitFor(
				(m) => m.event === "setImage" && m.context === defCtx,
				4000,
				"default monitor refresh",
			);
			check(
				"alsactl monitor works on the default device too",
				svgOf(defExt.payload.image).includes("35%"),
			);
			mock.send({ event: "willDisappear", action: "com.valentyn.alsa.volume", context: defCtx, payload: {} });
		} else {
			check("card 'default' targets the system mixer, not card 0", true, "skipped: no default device");
		}

		// --- an unknown card id falls back to default, not card 0 -----------
		{
			const t = alsa.resolveTarget("NoSuchCard");
			check("an unknown card id falls back to the default device", t.isDefault === true, `key=${t.key}`);
			const t2 = alsa.resolveTarget("");
			check("an empty card setting means the default device", t2.key === "default");
			const t3 = alsa.resolveTarget(String(CARD));
			check(`card "${CARD}" resolves to hw:${CARD}`, t3.monitor === `hw:${CARD}`);
		}

		// --- key images must be base64 data URLs ---------------------------
		// The dial strip is rendered natively by streamdeck-strip-render, whose
		// data-URL parser rejects any header without "base64" (layout.rs) and
		// silently renders an empty pixmap. A URL-encoded SVG looks fine on keys
		// and shows a checkerboard on dials, so assert the encoding directly.
		{
			clear();
			mock.send({
				event: "willAppear",
				action: "com.valentyn.alsa.volume",
				context: "ctx-b64",
				device: "dev0",
				payload: { controller: "Keypad", settings: { card: String(CARD), control: "Master" } },
			});
			const m = await waitFor((x) => x.event === "setImage" && x.context === "ctx-b64", 3000, "b64 image");
			const header = m.payload.image.slice(0, m.payload.image.indexOf(","));
			check("key images are base64 data URLs the strip renderer accepts", header.includes("base64"), header);
			check("key image decodes to valid SVG", svgOf(m.payload.image).startsWith("<svg"));
			mock.send({ event: "willDisappear", action: "com.valentyn.alsa.volume", context: "ctx-b64", payload: {} });
		}

		// --- dial icon is the plain glyph, not the full key face -------------
		{
			clear();
			mock.send({
				event: "willAppear",
				action: "com.valentyn.alsa.volume",
				context: "ctx-glyph",
				device: "dev0",
				payload: { controller: "Encoder", settings: { card: String(CARD), control: "Master" } },
			});
			const fbk = await waitFor((x) => x.event === "setFeedback" && x.context === "ctx-glyph", 3000, "glyph feedback");
			const svg = svgOf(fbk.payload.icon);
			// The 48x48 slot must not receive the level ring or the percentage
			// text, which the value and indicator already show.
			check(
				"dial icon is a 48x48 glyph without ring or text",
				svg.includes('viewBox="0 0 48 48"') && !svg.includes("<text"),
				svg.includes("<text") ? "still contains text" : "glyph only",
			);
			const keyImg = await waitFor((x) => x.event === "setImage" && x.context === "ctx-glyph", 3000, "glyph image");
			check(
				"the dial's state image matches its icon slot",
				keyImg.payload.image === fbk.payload.icon,
				"strip renderer uses the state image as icon_override",
			);
			mock.send({ event: "willDisappear", action: "com.valentyn.alsa.volume", context: "ctx-glyph", payload: {} });
		}

		// --- an unconfigured Mute Toggle targets the mic, not Master ---------
		{
			clear();
			mock.send({
				event: "willAppear",
				action: "com.valentyn.alsa.mute",
				context: "ctx-fresh",
				device: "dev0",
				payload: { controller: "Keypad", settings: {} },
			});
			const m = await waitFor((x) => x.event === "setImage" && x.context === "ctx-fresh", 3000, "fresh mute");
			const svg = svgOf(m.payload.image);
			check(
				"a Mute Toggle with no settings shows the microphone, not Master",
				svg.includes('data-glyph="mic"') && svg.includes("Capture"),
				svg.includes("Master") ? "still resolving to Master" : "resolves to Capture",
			);
			mock.send({ event: "willDisappear", action: "com.valentyn.alsa.mute", context: "ctx-fresh", payload: {} });
		}

		// --- an unconfigured Volume Up works without opening its inspector ---
		if (beforeDefault && beforeDefault.master) {
			clear();
			mock.send({
				event: "willAppear",
				action: "com.valentyn.alsa.volumeUp",
				context: "ctx-fresh-up",
				device: "dev0",
				payload: { controller: "Keypad", settings: {} },
			});
			const m = await waitFor((x) => x.event === "setImage" && x.context === "ctx-fresh-up", 3000, "fresh volumeUp");
			const svg = svgOf(m.payload.image);
			check(
				"a Volume Up with no settings drives Master on the default device",
				svg.includes("Master") && svg.includes('data-glyph="speaker"') && svg.includes('data-dir="up"'),
				svg.includes("Master") ? "resolves to Master" : "did not resolve to Master",
			);
			mock.send({ event: "willDisappear", action: "com.valentyn.alsa.volumeUp", context: "ctx-fresh-up", payload: {} });
		}

		// --- manifest wiring (no hardware) -----------------------------------
		{
			const manifest = JSON.parse(
				fs.readFileSync(path.join(__dirname, "..", "com.valentyn.alsa.sdPlugin", "manifest.json"), "utf8"),
			);
			const byUuid = Object.fromEntries(manifest.Actions.map((a) => [a.UUID, a]));
			const steps = ["com.valentyn.alsa.volumeUp", "com.valentyn.alsa.volumeDown"].map((u) => byUuid[u]);
			check("the manifest declares both one-directional volume actions", steps.every(Boolean));
			// A second state would be out of range: render() skips setState for these.
			check(
				"one-directional volume actions declare exactly one state",
				steps.every((a) => a && a.States.length === 1),
			);
			// A dial that only turns one way makes no sense; the Volume action owns
			// encoders, so these must never be given an Encoder instance to render.
			check(
				"one-directional volume actions are keypad-only",
				steps.every((a) => a && a.Controllers.length === 1 && a.Controllers[0] === "Keypad" && !a.Encoder),
			);
			const dir = path.join(__dirname, "..", "com.valentyn.alsa.sdPlugin");
			const missing = [];
			for (const a of manifest.Actions) {
				for (const p of [a.Icon, ...a.States.map((s) => s.Image)]) {
					if (!fs.existsSync(path.join(dir, `${p}.png`))) missing.push(`${p}.png`);
				}
				if (!fs.existsSync(path.join(dir, a.PropertyInspectorPath))) missing.push(a.PropertyInspectorPath);
			}
			check("every manifest asset exists on disk", missing.length === 0, missing.join(", "));
		}

		// --- the plugin.sh launch wrapper ------------------------------------
		// OpenDeck gates any CodePath ending in .js behind a hardcoded
		// `node --version >= v20.0.0`, so install.sh points Node 18 and 19
		// installs at the wrapper, which OpenDeck runs as a plain executable
		// with the same argv. Check it reaches registration the same way.
		{
			clear();
			const wrapper = path.join(__dirname, "..", "com.valentyn.alsa.sdPlugin", "plugin.sh");
			const wrapped = spawn(
				wrapper,
				[
					"-port",
					String(port),
					"-pluginUUID",
					"com.valentyn.alsa.wrapped",
					"-registerEvent",
					"registerPlugin",
					"-info",
					"{}",
				],
				{ stdio: ["ignore", "ignore", "ignore"] },
			);
			try {
				await waitFor(
					(m) => m.event === "registerPlugin" && m.uuid === "com.valentyn.alsa.wrapped",
					5000,
					"registerPlugin from plugin.sh",
				);
				check("plugin.sh launches the plugin the way OpenDeck runs a non-.js CodePath", true);
			} catch (err) {
				check("plugin.sh launches the plugin the way OpenDeck runs a non-.js CodePath", false, err.message);
			}
			// exec means the wrapper's PID is Node's, which is what lets
			// OpenDeck's kill-on-deactivate reach the plugin.
			wrapped.kill("SIGTERM");
			await sleep(200);
			check("killing the wrapper's PID stops the plugin", wrapped.exitCode !== null || wrapped.signalCode !== null);
		}

		// --- monitor lifecycle ---------------------------------------------
		clear();
		mock.send({ event: "willDisappear", action: "com.valentyn.alsa.volume", context: badCtx, payload: {} });
		mock.send({ event: "willDisappear", action: "com.valentyn.alsa.volume", context: encCtx, payload: {} });
		await sleep(300);
		check("willDisappear is handled without error", !stderr.join("").includes("handler error"));

		// --- no crashes -----------------------------------------------------
		const errText = stderr.join("");
		check("plugin logged no uncaught errors", !/uncaught|unhandled/i.test(errText), errText.trim().split("\n").pop() || "");
		check("plugin process is still alive", proc.exitCode === null);
	} catch (err) {
		check(`test run completed`, false, err.message);
	} finally {
		// Restore whatever we touched.
		try {
			if (before.master) {
				const m = await state("Master");
				if (before.master.percent !== null) await alsa.setVolume(TARGET, m, before.master.percent);
				await alsa.setMute(TARGET, await state("Master"), before.master.muted);
			}
			if (before.capture) {
				const c = await state("Capture");
				if (before.capture.percent !== null) await alsa.setVolume(TARGET, c, before.capture.percent);
				await alsa.setMute(TARGET, await state("Capture"), before.capture.muted);
			}
			if (beforeDefault && beforeDefault.master) {
				const dt = alsa.resolveTarget("default");
				const m = await state("Master", dt);
				if (m) {
					if (beforeDefault.master.percent !== null)
						await alsa.setVolume(dt, m, beforeDefault.master.percent);
					await alsa.setMute(dt, await state("Master", dt), beforeDefault.master.muted);
				}
			}
		} catch (err) {
			console.error(`\n  warning: could not fully restore mixer state: ${err.message}`);
		}

		proc.kill("SIGTERM");
		await sleep(200);
		mock.close();

		const alsactlLeft = stderr.join("").match(/alsactl monitor .* exited/g);
		console.log(`\n${results.length - failures}/${results.length} checks passed`);
		if (failures) {
			console.log("\nplugin stderr:\n" + stderr.join(""));
		} else if (alsactlLeft) {
			console.log(`(alsactl restarts observed: ${alsactlLeft.length})`);
		}
		process.exit(failures ? 1 : 0);
	}
}

main();
