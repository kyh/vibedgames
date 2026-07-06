#!/usr/bin/env bash
# Export the Luneblade Aseprite sources → packed atlases (PNG + json-array) that
# Phaser's load.aseprite consumes. The JSON carries the authoritative per-frame
# durations and frame tags, so animations play at the exact timing the artist
# authored (no hand-guessed FPS). No --trim: frames stay full-canvas so the
# feet-anchored origins in config.ts remain valid across every clip.
#
# Re-run after the source pack changes. Requires the Aseprite app (CLI mode).
set -euo pipefail

ASE="${ASEPRITE:-/Applications/Aseprite.app/Contents/MacOS/aseprite}"
SRC="${LUNEBLADE_SRC:-/Users/kyh/Desktop/vg/platformer}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/public/sprites/ase"
mkdir -p "$OUT"

# Hide the editor-only layers (grey backdrop / labels / reflection) before export.
HIDE="$(cd "$(dirname "$0")" && pwd)/ase-hide-layers.lua"

exp() { # <relative-aseprite-path> <out-name>
  "$ASE" -b "$SRC/$1" --script "$HIDE" \
    --sheet "$OUT/$2.png" --sheet-type packed \
    --data "$OUT/$2.json" --format json-array --list-tags >/dev/null
  echo "  ✓ $2"
}

echo "Exporting Luneblade atlases → $OUT"
exp "Luneblade - Little Axion (Premium)/Aseprite - Axion.aseprite"        axion
exp "Luneblade - Little Reaper v1.1/Aseprite - Little Reaper.aseprite"    reaper
exp "Luneblade - Little Riven/Aseprite - Riven.aseprite"                  riven
exp "Luneblace - Little Mooni v2.0/Aseprite - Mooni.aseprite"             mooni
exp "Luneblade - Salamander/Aseprite/Salamander.aseprite"                salamander
exp "Luneblade - Minions 1/Warrior/Warrior Aseprite.aseprite"            warrior
exp "Luneblade - Minions 1/Bomber/Bomber Aseprite.aseprite"              bomber
exp "Luneblade - Minions 2/Archer/Archer Aseprite.aseprite"              archer
exp "Luneblade - Minions 2/Spearman/Spearman Aseprite.aseprite"          spearman
echo "Done."
