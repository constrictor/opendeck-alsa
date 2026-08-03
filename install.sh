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
	red "node is not installed. This plugin needs Node.js 22 or newer."
	fail=1
else
	major="$(node -p 'process.versions.node.split(".")[0]')"
	if [ "$major" -lt 22 ]; then
		red "Node.js $major found, but 22+ is required (for the built-in WebSocket client)."
		fail=1
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
chmod +x "$DEST/plugin.js"

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
