#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Valentyn Pavliuchenko

# Launch wrapper for OpenDeck installs running Node.js 18 or 19.
#
# OpenDeck picks how to run a plugin from its CodePath extension. Anything
# ending in .js/.mjs/.cjs is gated behind a hardcoded
#
#     node --version >= "v20.0.0"
#
# (src-tauri/src/plugins/mod.rs) which no manifest field can influence, so the
# plugin is rejected before any of its own code runs. Every other CodePath is
# chmod +x'd and executed directly with the same argv.
#
# The plugin itself is fine on Node 18, so install.sh points CodePathLin here
# when it finds an older Node. exec keeps the PID OpenDeck spawned, so its
# kill-on-deactivate and the Linux parent-death signal still land on Node.

exec node "$(dirname "$0")/plugin.js" "$@"
