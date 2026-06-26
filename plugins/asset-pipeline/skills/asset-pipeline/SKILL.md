---
name: asset-pipeline
description: "Asset pipeline utilities for 2D game projects: validate an asset manifest against PNGs on disk, probe sprite sheets/tilesets to find non-empty grid frames, and report PNG dimensions. Use when adding/updating art, debugging missing/unused assets, auditing sprite sheets, or generating frame/size metadata for import pipelines (especially for Love2D projects with Lua asset indexes)."
---

# Gamedev Assets

Bundled `scripts/` keep a game's art pipeline consistent and debuggable. Run from repo root.

`uv` is recommended: every script ships PEP 723 metadata (`# /// script ...`) so `uv run <script.py>` installs deps automatically (no `pip install`). Without `uv`: Python 3.11+ with Pillow.

## Asset Index Theory

An asset index (manifest) is the single source of truth for game art — centralized loading by logical name, frame metadata (grid dims, sequences, timing), and validation that disk matches code.

Conventions that worked (Love2D / Rocky Roads; keep your own "what worked" notes at `docs/asset-index-learnings.md`):

- Prefer a **native** manifest format (Lua table for Love2D) but keep it **JSON-shaped** for export.
- Categorize by **how the asset is used**, not by size.
- Pick a **tile size** first for tilesets (this pack: **16×16**), then derive `columns/rows`.
- Treat sprite sheets as **sparse**: store **non-empty** `{col,row}` frames (alpha-based), don't assume a full grid.
- Use **stable, sanitized keys**; keep `path` as on-disk truth (case + spaces preserved).
- Always run a **coverage check** after asset changes.

### Output Formats

- **JSON** (preferred) — universal, any engine.
- **Lua table** — Love2D / Lua projects.

### Asset Categories

| Category       | Purpose                                     | Key metadata                                                              |
| -------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| `backgrounds`  | Parallax/scrolling layers, static backdrops | `path`, `width`, `height`                                                 |
| `tilesets`     | Grid-based level tiles                      | `path`, `tileWidth`, `tileHeight`, `columns`, `rows`, `margin`, `spacing` |
| `images`       | Static sprites (no animation)               | `path`, `width`, `height`                                                 |
| `spritesheets` | Animated sprites                            | `path`, `frameWidth`, `frameHeight`, `fps`, `frames` or `animations`      |

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
      "width": 192,
      "height": 96,
      "tileWidth": 16,
      "tileHeight": 16,
      "columns": 12,
      "rows": 6
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
        "width": 224,
        "height": 64,
        "frameWidth": 32,
        "frameHeight": 32,
        "columns": 7,
        "rows": 2,
        "animations": {
          "idle": {
            "fps": 6,
            "frames": [
              [0, 0],
              [1, 0]
            ]
          },
          "run": {
            "fps": 10,
            "frames": [
              [0, 1],
              [1, 1],
              [2, 1],
              [3, 1]
            ]
          }
        }
      }
    }
  }
}
```

Frames are `[column, row]` pairs, zero-based (`[0,0]` = first cell). Grid is `frameWidth × frameHeight`. Use explicit `frames` for sparse sheets; group sequences + timing under `animations`.

### Workflow: Building an Asset Index

1. **Inventory** — `asset_sizes.py` for all PNG dimensions.
2. **Probe sheets** — `asset_sheet_probe.py --frame WxH --list` for non-empty cells.
3. **Categorize** — background / tileset / static image / spritesheet.
4. **Define animations** — frame sequences + fps for spritesheets.
5. **Write manifest** — JSON (or Lua for Love2D).
6. **Validate** — `asset_manifest_check.py` for manifest ↔ disk sync.

## Animation Normalization

When importing AI-generated sprite strips or extracted video frames into game-sized frames, **preserve sequence framing first, normalize second, derive collision/body bounds only after the normalized export exists.**

- Use one **approved in-game frame** as the size reference, one **shared runtime anchor** for placement, one **shared scale** for the whole sequence (don't scale frames independently unless the source is genuinely inconsistent).
- Pick the shared-scale reference deliberately:
  - **`median-lower`** for attack/hurt — taller frames shouldn't rescale the character.
  - **`first-frame`** for crouch-like states — frame `01` matches idle height, later frames stay shorter.
- For video-frame imports, compute one **union crop** across the full set and crop every frame with that box.
- Align with a stable rule (**fixed center + fixed bottom**, or your runtime anchor). Don't re-center each frame from its own silhouette unless frames were hand-authored as isolated cells.

Why: per-frame cropping/alignment creates fake drift ("skateboarding"); per-frame scaling shrinks tall poses; many "animation" problems are registration problems from import; keeping every video frame gives repeated cycles, not one usable loop. For video specifically: dense extraction is good for diagnosis, a curated single-cycle export is the actual game asset.

If a character looks like it's **floating above its shadow** or stands at different heights by direction, check visible alpha bounds: measure the lowest non-transparent pixel per frame, compare the bottom baseline across directions/states, normalize PNG frames so feet land on a shared baseline (commonly `bottomY = frameHeight - 1`), then tune engine sprite origin / shadow offsets. Don't use the manifest as the first fix for bad foot placement — it describes size/atlas/frame/fps/pivot but can't repair transparent padding inside the PNG. Nearest-neighbor import preserves pixels; if in-betweens still look soft, the softness is in the source frames.

## Tools

### Manifest Coverage Check (`asset_manifest_check.py`)

Verify every PNG on disk appears in the manifest and vice versa.

```bash
uv run .claude/skills/asset-pipeline/scripts/asset_manifest_check.py
uv run .claude/skills/asset-pipeline/scripts/asset_manifest_check.py --manifest path/to/assets_index.lua --root assets
uv run .claude/skills/asset-pipeline/scripts/asset_manifest_check.py --json tmp/coverage.json
```

### Manifest Export (`asset_manifest_export_json.py`)

Export `assets_index.lua` (Love2D-style) to a portable `assets_index.json`. By default it rewrites all `path` entries relative to the output folder and sets `meta.root` to `"."`, so the result can be copied/zipped and still work.

```bash
uv run .claude/skills/asset-pipeline/scripts/asset_manifest_export_json.py --manifest path/to/assets_index.lua --out path/to/assets_index.json
```

### Sprite-Sheet Probe (`asset_sheet_probe.py`)

Find non-empty cells in a sheet grid. Essential for building `frames` arrays.

```bash
uv run .claude/skills/asset-pipeline/scripts/asset_sheet_probe.py image.png --frame 32x32
uv run .claude/skills/asset-pipeline/scripts/asset_sheet_probe.py folder/ --frame 16x16 --list --json tmp/probe.json
```

### Sprite Baseline Audit/Fix (`asset_sprite_baseline.py`)

Audit visible alpha bounds inside a sheet grid and optionally write baseline-corrected copies. Use when a character floats above its shadow in one direction, a directional idle was made from an attack frame, AI sheets have inconsistent transparent padding under the feet, or engine origins are correct but visual foot placement differs. It's a runtime export guardrail — it verifies final PNG frames agree with engine sprite-origin/shadow assumptions, not animation quality.

```bash
# Report per-frame alpha bounds, visible bottom pixel, required shift.
uv run .claude/skills/asset-pipeline/scripts/asset_sprite_baseline.py public/assets/kaede --frame 256x256 --json tmp/kaede-baselines.json

# Write fixed copies whose visible feet land on y=255.
uv run .claude/skills/asset-pipeline/scripts/asset_sprite_baseline.py public/assets/kaede --frame 256x256 --target-bottom 255 --out-dir tmp/kaede-baseline-fixed

# Also normalize horizontal center (for idle/standing sources).
uv run .claude/skills/asset-pipeline/scripts/asset_sprite_baseline.py public/assets/kaede/idle-n.png --frame 256x256 --target-bottom 255 --target-center-x 128 --out tmp/idle-n-fixed.png
```

### PNG Dimension Listing (`asset_sizes.py`)

```bash
uv run .claude/skills/asset-pipeline/scripts/asset_sizes.py
uv run .claude/skills/asset-pipeline/scripts/asset_sizes.py --root assets/ --json tmp/sizes.json
```

### Tileset/Tilemap Editor (`asset_tilemap_editor.py`)

Manifest-driven GUI to verify `tileWidth`/`tileHeight` grid math + `columns`/`rows`, that cursor movement is exactly 1 cell per keypress, and that save/load preserves layout. The GUI uses `tkinter` (provided by your Python distro/OS, not installed via uv/pip).

```bash
uv run .claude/skills/asset-pipeline/scripts/asset_tilemap_editor.py --manifest path/to/assets_index.json
```

Controls: arrows move cursor cell-by-cell · `WASD` move palette selection · `Space/Enter` paint, `X/Backspace` erase · `[`/`]` switch tileset, `+/-` zoom · `F5` quick-save (`tilemap.json`), `F9` quick-load (requires `--map`) · `G` grid, `H` help.

Headless exports (no `tkinter`):

```bash
# Grid-overlay PNG for a tileset
uv run .claude/skills/asset-pipeline/scripts/asset_tilemap_editor.py \
  --manifest path/to/assets_index.json --tileset <tileset_name> \
  --export-tileset-grid tmp/tileset_grid.png --label-ids --scale 6 --trim

# Self-test tilemap (all non-empty tiles in-place) and render it
uv run .claude/skills/asset-pipeline/scripts/asset_tilemap_editor.py \
  --manifest path/to/assets_index.json --tileset <tileset_name> \
  --make-selftest-map tmp/selftest.json
uv run .claude/skills/asset-pipeline/scripts/asset_tilemap_editor.py \
  --manifest path/to/assets_index.json --map tmp/selftest.json \
  --export-map-render tmp/selftest.png --scale 6 --trim

# Background color + fill rectangles behind tiles (concept mockups)
uv run .claude/skills/asset-pipeline/scripts/asset_tilemap_editor.py \
  --manifest path/to/assets_index.json --map tmp/selftest.json \
  --export-map-render tmp/selftest_bg.png --scale 6 --bg '#77cfd8' --fill-rect '0,40,24,6,#12a7d5'
```
