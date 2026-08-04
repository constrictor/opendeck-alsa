#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Valentyn Pavliuchenko
# Install the ALSA plugin into OpenDeck's plugin directory.
set -euo pipefail

PLUGIN_ID="com.valentyn.alsa.sdPlugin"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$PLUGIN_ID"
DEST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opendeck/plugins"
DEST="$DEST_DIR/$PLUGIN_ID"

red() { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }

fail=0

# --- prerequisites ---------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
	red "node is not installed. This plugin needs Node.js 18 or newer."
	fail=1
else
	major="$(node -p 'process.versions.node.split(".")[0]')"
	if [ "$major" -lt 18 ]; then
		red "Node.js $major found, but 18+ is required."
		fail=1
	elif [ "$major" -lt 21 ]; then
		# No global WebSocket before 21; the plugin ships its own client for
		# these, so this is a note rather than a problem.
		yellow "Node.js $major found; using the bundled WebSocket client (22+ uses the built-in one)."
	fi
fi

if ! command -v amixer >/dev/null 2>&1; then
	red "amixer is not installed. Install your distribution's alsa-utils package."
	fail=1
fi

if ! command -v alsactl >/dev/null 2>&1; then
	yellow "alsactl not found — the plugin will fall back to polling every 2s."
	yellow "Install alsa-utils for instant, event-driven updates."
fi

[ "$fail" -eq 0 ] || exit 1

if [ ! -d "$SRC" ]; then
	red "Plugin source not found at $SRC"
	exit 1
fi

# --- install ---------------------------------------------------------------
if pgrep -x opendeck >/dev/null 2>&1; then
	yellow "OpenDeck is running. Quit it before installing, or restart it afterwards"
	yellow "so the new plugin is picked up."
fi

mkdir -p "$DEST_DIR"

if [ -e "$DEST" ]; then
	# Backups must live outside plugins/ — OpenDeck loads every directory in
	# there, so a backup left alongside would register as a duplicate plugin
	# and fight the real one over the same actions.
	backup_dir="${XDG_STATE_HOME:-$HOME/.local/state}/opendeck-alsa/backups"
	mkdir -p "$backup_dir"
	backup="$backup_dir/$PLUGIN_ID.$(date +%Y%m%d%H%M%S)"
	yellow "Existing install found; moving it to $backup"
	mv "$DEST" "$backup"
fi

# Clean up backups from older versions of this script, which did leave them in
# plugins/ where OpenDeck would load them.
for stray in "$DEST".bak.*; do
	[ -e "$stray" ] || continue
	yellow "Removing stray backup that OpenDeck would load as a duplicate: $(basename "$stray")"
	rm -rf "$stray"
done

cp -r "$SRC" "$DEST"
chmod +x "$DEST/plugin.js" "$DEST/plugin.sh"

# OpenDeck refuses to launch any plugin whose CodePath ends in .js unless
# `node --version` is at least v20.0.0. That check is hardcoded in OpenDeck, no
# manifest field overrides it, and it fires before the plugin runs at all — so
# on an older Node point the installed manifest at the wrapper, which OpenDeck
# runs as a plain executable instead.
if [ "$major" -lt 20 ]; then
	node -e '
	  const fs = require("fs");
	  const file = process.argv[1];
	  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
	  manifest.CodePathLin = "plugin.sh";
	  fs.writeFileSync(file, JSON.stringify(manifest, null, "\t") + "\n");
	' "$DEST/manifest.json"
	yellow "OpenDeck rejects .js plugins on Node < 20; this install launches via plugin.sh instead."
fi

green "Installed to $DEST"

# --- smoke test ------------------------------------------------------------
cards="$(node -e '
  const alsa = require(process.argv[1] + "/lib/alsa.js");
  const cards = alsa.listCards();
  if (!cards.length) { console.log("none"); process.exit(0); }
  console.log(cards.map(c => `${c.index}: ${c.id} (${c.name})`).join("\n"));
' "$DEST" 2>/dev/null || echo "error")"

if [ "$cards" = "error" ] || [ "$cards" = "none" ]; then
	yellow "Warning: no ALSA sound cards were detected."
else
	echo
	echo "Sound cards detected:"
	echo "$cards" | sed 's/^/  /'
fi

echo
green "Done. Restart OpenDeck, then look for the 'ALSA' category when adding an action."
