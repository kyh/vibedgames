---
name: asset-pipeline
description: "Asset pipeline utilities for 2D game projects: validate an asset manifest against PNGs on disk, probe sprite sheets/tilesets to find non-empty grid frames, and report PNG dimensions. Use when adding/updating art, debugging missing/unused assets, auditing sprite sheets, or generating frame/size metadata for import pipelines (especially for Love2D projects with Lua asset indexes)."
---

# Gamedev Assets

Use the bundled scripts in `scripts/` to keep your game's art pipeline consistent and debuggable.

## Asset Index Learnings (from Rocky Roads)

Keep a short “worked example” doc in your own repo whenever you establish an asset-index convention.

In this repo, the practical “what worked / what didn’t” notes from building a Love2D asset index live at:
- `docs/asset-index-learnings.md`

Key takeaways to apply when building/managing an asset index:
- Prefer a **native** manifest format (Lua table for Love2D), but keep it **JSON-shaped** for export.
- Categorize by **how you use the asset** (`backgrounds`, `tilesets`, `images`, `spritesheets`), not by size alone.
- Pick a **tile size** first for tilesets (this pack is consistently **16×16**), then derive `columns/rows`.
- Treat many sprite sheets as **sparse**: compute and store **non-empty** `{col,row}` frames (alpha-based) instead of assuming a full grid.
- Use **stable, sanitized keys**; keep `path` as the on-disk truth (case + spaces preserved).
- Always run a **coverage check** after asset changes so the manifest stays trustworthy.

## Animation Normalization Learnings

When importing AI-generated sprite strips or extracted video frames into game-sized animation frames:

- Use one **approved in-game frame** as the target size reference.
- Use one **shared runtime anchor** from metadata for placement.
- Use one **shared scale** for the whole sequence. Do not scale each frame independently unless the source is genuinely inconsistent.
- Choose the shared-scale reference deliberately:
  - use a **baseline / median-lower** pose height for states like attack or hurt, where some frames are taller but the character should not be rescaled per pose
  - use the **first frame** for crouch-like states, where frame `01` should match idle height and later frames should remain visibly shorter
- For video-frame imports, compute one **union crop** across the full frame set and crop every frame with that same box.
- Align frames with a stable rule such as **fixed center + fixed bottom** or your known runtime anchor. Do not re-center each frame from its own local silhouette unless the source frames were hand-authored as isolated cells.

Why this matters:

- per-frame cropping/alignment often creates fake sideways drift or "skateboarding"
- per-frame scaling often shrinks tall poses like raised weapons or hurt reactions
- many apparent animation problems are actually registration problems introduced during import
- keeping every extracted frame from a source video often gives you repeated cycles rather than one usable game loop

Practical rule:

- preserve sequence framing first
- normalize second
- derive collision/body bounds only after the normalized export exists

For strip importers that support explicit scaling modes, prefer:

- `median-lower` for attack, hurt, or other states with upward pose variation
- `first-frame` for crouch or other enter-and-lower states that begin from an idle-like standing pose

For video-derived animation specifically:

1. Use a dense extraction first if you need to inspect the motion clearly.
2. Normalize that dense sequence with one shared crop, one shared scale, and one shared anchor.
3. Treat that result as analysis material.
4. Curate one clean loop cycle for the runtime asset.

This repo's run-animation experiments established an important distinction:

- dense import is good for diagnosis
- curated single-cycle export is better for the actual game asset

If an animation looks like it is "skating" or sliding sideways, check these in order:

1. whether frames were cropped independently
2. whether frames were centered independently
3. whether tall poses were scaled differently from short poses
4. whether the source motion itself contains true root-motion drift

Nearest-neighbor import preserves pixels. If the in-between poses still look soft after correct normalization, the softness is usually already present in the source frames.

## Asset Index Theory

An asset index (manifest) is a structured metadata file that serves as the single source of truth for all game art. It enables:
- **Centralized loading** - One place to reference all assets by logical name
- **Frame metadata** - Grid dimensions, animation sequences, timing
- **Validation** - Ensure disk files match what code expects

### Output Formats

- **JSON** (preferred) - Universal, works with any engine
- **Lua table** - For Love2D or other Lua-based projects

### Asset Categories

| Category | Purpose | Key metadata |
|----------|---------|--------------|
| `backgrounds` | Parallax/scrolling layers, static backdrops | `path`, `width`, `height` |
| `tilesets` | Grid-based level tiles | `path`, `tileWidth`, `tileHeight`, `columns`, `rows`, `margin`, `spacing` |
| `images` | Static sprites (no animation) | `path`, `width`, `height` |
| `spritesheets` | Animated sprites | `path`, `frameWidth`, `frameHeight`, `fps`, `frames` or `animations` |

### Manifest Structure

```json
{
  "meta": {
    "version": 1,
    "root": "assets/game",
    "defaultFps": 10
  },
  "backgrounds": {
    "clouds": { "path": "Backgrounds/clouds.png", "width": 256, "height": 128 }
  },
  "tilesets": {
    "desert": {
      "path": "Tilesets/desert.png",
      "width": 192, "height": 96,
      "tileWidth": 16, "tileHeight": 16,
      "columns": 12, "rows": 6
    }
  },
  "images": {
    "deco": {
      "bush": { "path": "Deco/bush.png", "width": 32, "height": 16 }
    }
  },
  "spritesheets": {
    "enemies": {
      "chicken": {
        "path": "Enemies/chicken.png",
        "width": 224, "height": 64,
        "frameWidth": 32, "frameHeight": 32,
        "columns": 7, "rows": 2,
        "animations": {
          "idle": { "fps": 6, "frames": [[0,0], [1,0]] },
          "run": { "fps": 10, "frames": [[0,1], [1,1], [2,1], [3,1]] }
        }
      }
    }
  }
}
```

### Frame Coordinates

Frames are referenced as `[column, row]` pairs within the sprite sheet grid:
- **Zero-based indexing** - First cell is `[0, 0]`
- **Grid defined by frame dimensions** - `frameWidth × frameHeight` subdivides the image
- **Sparse sheets** - When not all cells contain content, use explicit `frames` array
- **Named animations** - Group frame sequences with timing under `animations` object

### Workflow: Building an Asset Index

1. **Inventory** - Run `asset_sizes.py` to get dimensions of all PNGs
2. **Probe sheets** - Run `asset_sheet_probe.py --frame WxH --list` to find non-empty cells
3. **Categorize** - Determine if each asset is background, tileset, static image, or spritesheet
4. **Define animations** - For spritesheets, identify frame sequences and fps
5. **Write manifest** - Create JSON (or Lua for Love2D projects)
6. **Validate** - Run `asset_manifest_check.py` to ensure manifest ↔ disk sync

## Quick Start (recommended: `uv`)

Run from repo root:

```bash
# 1) Check manifest coverage (manifest ↔ disk)
uv run .claude/skills/gamedev-assets/scripts/asset_manifest_check.py --manifest path/to/assets_index.lua --root assets

# 1b) Export Lua manifest to portable JSON (recommended for non-Lua engines/tools)
uv run .claude/skills/gamedev-assets/scripts/asset_manifest_export_json.py --manifest path/to/assets_index.lua --out path/to/assets_index.json

# 2) List PNG sizes
uv run .claude/skills/gamedev-assets/scripts/asset_sizes.py --root assets --json tmp/asset_sizes.json

# 3) Probe sprite sheet for non-empty frames
uv run .claude/skills/gamedev-assets/scripts/asset_sheet_probe.py path/to/sheet.png --frame 32x32 --list --json tmp/probe.json

# 4) Debug tilesets / tilemaps with a manifest-driven GUI editor
uv run .claude/skills/gamedev-assets/scripts/asset_tilemap_editor.py --manifest path/to/assets_index.json
```

Without `uv`: Python 3.11+ with Pillow installed.

All Python scripts shipped with this skill include PEP 723 metadata (`# /// script ...`) so `uv run <script.py>` installs dependencies automatically (no manual `pip install` steps).

## Asset Index Export (Lua → JSON)

If you have an existing `assets_index.lua` (Love2D-style), export it to a portable `assets_index.json`:

```bash
uv run .claude/skills/gamedev-assets/scripts/asset_manifest_export_json.py \
  --manifest path/to/assets_index.lua \
  --out path/to/assets_index.json
```

By default the exporter rewrites all `path` entries to be relative to the output manifest folder and sets `meta.root` to `"."`, so the resulting folder can be copied/zip'd and still work.

## Tilemap Debugging (Python tileset/tilemap editor)

Use the manifest-driven editor to verify:
- `tileWidth`/`tileHeight` grid math and `columns`/`rows`
- that cursor movement is exactly 1 cell per keypress
- that saving/loading a JSON tilemap preserves the same layout

Run:

```bash
uv run .claude/skills/gamedev-assets/scripts/asset_tilemap_editor.py --manifest path/to/assets_index.json
```

Note: this GUI uses `tkinter`, which is provided by your Python distribution/OS (it’s not installed via `uv`/pip).

Headless exports (no `tkinter` required):

```bash
# Export a grid-overlay PNG for a tileset
uv run .claude/skills/gamedev-assets/scripts/asset_tilemap_editor.py \
  --manifest path/to/assets_index.json --tileset <tileset_name> \
  --export-tileset-grid tmp/tileset_grid.png --label-ids --scale 6 --trim

# Generate a self-test tilemap (all non-empty tiles in-place) and render it
uv run .claude/skills/gamedev-assets/scripts/asset_tilemap_editor.py \
  --manifest path/to/assets_index.json --tileset <tileset_name> \
  --make-selftest-map tmp/selftest.json
uv run .claude/skills/gamedev-assets/scripts/asset_tilemap_editor.py \
  --manifest path/to/assets_index.json --map tmp/selftest.json \
  --export-map-render tmp/selftest.png --scale 6 --trim

# Optional: set a background color and fill rectangles behind tiles (useful for concept mockups)
uv run .claude/skills/gamedev-assets/scripts/asset_tilemap_editor.py \
  --manifest path/to/assets_index.json --map tmp/selftest.json \
  --export-map-render tmp/selftest_bg.png --scale 6 --bg '#77cfd8' --fill-rect '0,40,24,6,#12a7d5'
```

Controls:
- Arrows: move cursor cell-by-cell
- `WASD`: move palette selection on the tileset
- `Space/Enter`: paint, `X/Backspace`: erase
- `[` / `]`: switch tileset, `+/-`: zoom map
- `F5`: quick-save (`tilemap.json` by default), `F9`: quick-load (requires `--map`)
- `G`: grid, `H`: help

## Tools

### 1) Manifest Coverage Check (`asset_manifest_check.py`)

Verify every PNG on disk appears in manifest and vice versa.

```bash
uv run .claude/skills/gamedev-assets/scripts/asset_manifest_check.py
uv run .claude/skills/gamedev-assets/scripts/asset_manifest_check.py --json tmp/coverage.json
```

### 1b) Manifest Export (`asset_manifest_export_json.py`)

Export `assets_index.lua` to `assets_index.json` (portable across engines/tooling):

```bash
uv run .claude/skills/gamedev-assets/scripts/asset_manifest_export_json.py --manifest path/to/assets_index.lua --out path/to/assets_index.json
```

### 2) Sprite-Sheet Probe (`asset_sheet_probe.py`)

Find non-empty cells in a sprite sheet grid. Essential for building `frames` arrays.

```bash
uv run .claude/skills/gamedev-assets/scripts/asset_sheet_probe.py image.png --frame 32x32
uv run .claude/skills/gamedev-assets/scripts/asset_sheet_probe.py folder/ --frame 16x16 --list --json tmp/probe.json
```

### 3) PNG Dimension Listing (`asset_sizes.py`)

Get dimensions for all PNGs under a folder.

```bash
uv run .claude/skills/gamedev-assets/scripts/asset_sizes.py
uv run .claude/skills/gamedev-assets/scripts/asset_sizes.py --root assets/ --json tmp/sizes.json
```

### 4) Tileset/Tilemap Editor (`asset_tilemap_editor.py`)

GUI tool for selecting tiles and painting a grid to validate tileset assumptions.

```bash
uv run .claude/skills/gamedev-assets/scripts/asset_tilemap_editor.py --manifest path/to/assets_index.json
```
