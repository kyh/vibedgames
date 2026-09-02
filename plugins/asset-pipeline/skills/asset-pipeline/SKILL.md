---
name: asset-pipeline
description: "Asset pipeline utilities for 2D game projects: validate an asset manifest against PNGs on disk, probe sprite sheets/tilesets to find non-empty grid frames, and report PNG dimensions. Use when adding/updating art, debugging missing/unused assets, auditing sprite sheets, or generating frame/size metadata for import pipelines (especially for Love2D projects with Lua asset indexes)."
---

# Gamedev Assets

Bundled `scripts/` keep a game's art pipeline consistent and debuggable. Run from repo root.

Scripts are plain Node — `node <script.mjs>`. No Python, no `uv`, no `pip install`, and nothing to install beyond Node itself: each script imports a bundled, dependency-free `scripts/_lib/asset-tools.mjs`.

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

1. **Inventory** — `asset-sizes.mjs` for all PNG dimensions.
2. **Probe sheets** — `asset-sheet-probe.mjs --frame WxH --list` for non-empty cells.
3. **Categorize** — background / tileset / static image / spritesheet.
4. **Define animations** — frame sequences + fps for spritesheets.
5. **Write manifest** — JSON (or Lua for Love2D).
6. **Validate** — `asset-manifest-check.mjs` for manifest ↔ disk sync.

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

### Manifest Coverage Check (`asset-manifest-check.mjs`)

Verify every PNG on disk appears in the manifest and vice versa.

`missing` is art on disk the manifest never declares (it will never load);
`extra` is art the manifest promises that nobody shipped (it 404s at runtime).
Relative paths resolve through `meta.root`, in both Lua and JSON manifests.

```bash
# Skills root: wherever `skills add` put asset-pipeline (project or global, any agent).
for d in .agents/skills .claude/skills ~/.agents/skills ~/.claude/skills; do
  [ -d "$d/asset-pipeline" ] && SKILLS=$d && break
done
```

```bash
node $SKILLS/asset-pipeline/scripts/asset-manifest-check.mjs
node $SKILLS/asset-pipeline/scripts/asset-manifest-check.mjs --manifest path/to/assets_index.lua --root assets
node $SKILLS/asset-pipeline/scripts/asset-manifest-check.mjs --json tmp/coverage.json
node $SKILLS/asset-pipeline/scripts/asset-manifest-check.mjs --strict   # exit 1 on any mismatch
```

Pass `--strict` from a script or CI: without it the command reports the
mismatch and still exits 0, which reads as a pass.

### Manifest Export (`asset-manifest-export-json.mjs`)

Export `assets_index.lua` (Love2D-style) to a portable `assets_index.json`. By default it folds `meta.root` into every `path`, rewrites them relative to `--out`'s folder, and sets `meta.root` to `"."` — so the JSON works from wherever it lands. Write it next to the assets it describes if you want the result copyable/zippable; exporting to a `tmp/` sibling gives correct-but-`../`-prefixed paths. `--keep-paths` leaves the manifest's own paths and root untouched.

```bash
node $SKILLS/asset-pipeline/scripts/asset-manifest-export-json.mjs --manifest path/to/assets_index.lua --out path/to/assets_index.json
```

### Sprite-Sheet Probe (`asset-sheet-probe.mjs`)

Find non-empty cells in a sheet grid. Essential for building `frames` arrays.

```bash
node $SKILLS/asset-pipeline/scripts/asset-sheet-probe.mjs image.png --frame 32x32
node $SKILLS/asset-pipeline/scripts/asset-sheet-probe.mjs folder/ --frame 16x16 --list --json tmp/probe.json
```

### Sprite Baseline Audit/Fix (`asset-sprite-baseline.mjs`)

Audit visible alpha bounds inside a sheet grid and optionally write baseline-corrected copies. Use when a character floats above its shadow in one direction, a directional idle was made from an attack frame, AI sheets have inconsistent transparent padding under the feet, or engine origins are correct but visual foot placement differs. It's a runtime export guardrail — it verifies final PNG frames agree with engine sprite-origin/shadow assumptions, not animation quality.

```bash
# Report per-frame alpha bounds, visible bottom pixel, required shift.
node $SKILLS/asset-pipeline/scripts/asset-sprite-baseline.mjs public/assets/kaede --frame 256x256 --json tmp/kaede-baselines.json

# Write fixed copies whose visible feet land on y=255.
node $SKILLS/asset-pipeline/scripts/asset-sprite-baseline.mjs public/assets/kaede --frame 256x256 --target-bottom 255 --out-dir tmp/kaede-baseline-fixed

# Also normalize horizontal center (for idle/standing sources).
node $SKILLS/asset-pipeline/scripts/asset-sprite-baseline.mjs public/assets/kaede/idle-n.png --frame 256x256 --target-bottom 255 --target-center-x 128 --out tmp/idle-n-fixed.png
```

### PNG Dimension Listing (`asset-sizes.mjs`)

```bash
node $SKILLS/asset-pipeline/scripts/asset-sizes.mjs
node $SKILLS/asset-pipeline/scripts/asset-sizes.mjs --root assets/ --json tmp/sizes.json
```

### Tileset/Tilemap Exports and Editor (`asset-tilemap-editor.mjs`)

Manifest-driven checks that `tileWidth`/`tileHeight` grid math and `columns`/`rows` are what you think they are. A wrong `margin` or `spacing` is invisible in the manifest and shows up in-game as tiles sheared by a pixel — these exports make it obvious before that happens.

Start with the self-test map: it places every non-empty tile at its own coordinate, so rendering it should reproduce the tileset exactly. If the render doesn't match the sheet, the grid metadata is wrong.

```bash
# Grid-overlay PNG for a tileset
node $SKILLS/asset-pipeline/scripts/asset-tilemap-editor.mjs \
  --manifest path/to/assets_index.json --tileset <tileset_name> \
  --export-tileset-grid tmp/tileset_grid.png --label-ids --scale 6 --trim

# Self-test tilemap (all non-empty tiles in-place) and render it
node $SKILLS/asset-pipeline/scripts/asset-tilemap-editor.mjs \
  --manifest path/to/assets_index.json --tileset <tileset_name> \
  --make-selftest-map tmp/selftest.json
node $SKILLS/asset-pipeline/scripts/asset-tilemap-editor.mjs \
  --manifest path/to/assets_index.json --map tmp/selftest.json \
  --export-map-render tmp/selftest.png --scale 6 --trim

# Background color + fill rectangles behind tiles (concept mockups)
node $SKILLS/asset-pipeline/scripts/asset-tilemap-editor.mjs \
  --manifest path/to/assets_index.json --map tmp/selftest.json \
  --export-map-render tmp/selftest_bg.png --scale 6 --bg '#77cfd8' --fill-rect '0,40,24,6,#12a7d5'
```

#### Painting a map by hand (`--edit`)

`--edit` serves a painting editor over loopback and prints a URL — nothing to
install, and the map format is the same one the exports read. Left-click paints
the selected tile, right-click erases, dragging strokes; arrows move the cursor,
WASD moves the palette selection, `[`/`]` switch tileset, `+`/`-` zoom, `G`
toggles the grid, `Ctrl-S`/`F5` saves and `Ctrl-L`/`F9` reloads.

```bash
node $SKILLS/asset-pipeline/scripts/asset-tilemap-editor.mjs \
  --manifest path/to/assets_index.json --map maps/level1.json --edit
```

The URL includes a per-run token that every request must repeat, and saves are
refused outside the working directory (`--write-root` moves that boundary).
`--port` pins the port; without it the OS picks a free one.

An agent generally does not need this — generating a map JSON directly is
faster, and `--export-map-render` is how you check it. Reach for `--edit` when a
human wants to lay out a level by eye.
