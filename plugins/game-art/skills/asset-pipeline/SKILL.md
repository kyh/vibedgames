---
name: asset-pipeline
description: "Use Vibedgames asset tooling for 2D game assets. Use `vg asset sprite` for animated spritesheets; use tilemap/manifest utilities for level/world tile assets."
---

# Asset Pipeline

Spritesheets and tilemaps are different asset lanes.

- Spritesheets: animated character/prop frames.
- Tilemaps: level/world layouts built from tilesets.

Use `vg asset sprite` for sprite animation cleanup. Do not create project-local
sprite cleanup scripts.

## Sprite Animation Flow

1. Create an animation-safe first pose on exact `#00FF00`.
2. Animate that pose with locked camera and flat `#00FF00` background.
3. Run `vg asset sprite` without `--indices`.
4. Inspect the contact sheet.
5. Rerun with the same `--run-dir` and explicit `--indices`.
6. Wire the promoted sheet and frames into the game.

```bash
vg asset sprite \
  --video "<source-video>" \
  --character "<character>" \
  --animation "<animation>"

vg asset sprite \
  --video "<source-video>" \
  --character "<character>" \
  --animation "<animation>" \
  --run-dir "<printed-run-dir>" \
  --indices "1,6,11,17,22,27,32,38,43,49,54,60" \
  --notes "ready,anticipation,windup,contact,impact,follow-through,recoil,recover,recover,recover,settle,settle"
```

## Defaults

- Output cells are `256 x 256`.
- Output sheets are horizontal strips.
- Default background mode is chroma key `#00FF00`.
- `--background alpha` preserves existing transparency.
- `--background light` is only for off-white/gray rescue work.
- Preserve-canvas is always used. Do not crop, recenter, bottom-align, or ground-align video-derived frames.

## Game Wiring

Use one pivot/origin per character across all animations. The transparent space
inside each `256 x 256` cell is intentional. It preserves apparent scale across
idle, run, attack, jump, and effect-heavy animations.

Before shipping, check:

- report status is `pass`
- preview order reads correctly
- warnings have been visually reviewed
- no important limb, weapon, cloth, hair, cape, or effect is clipped
- frame count and FPS in game code match the promoted sheet

## Tilemaps

Do not route tilemap work through `vg asset sprite`.

Use the scripts in `scripts/` when an agent needs to inspect or wire tile assets:

- `asset_sizes.py`: list PNG dimensions
- `asset_sheet_probe.py`: inspect a tileset or spritesheet grid
- `asset_manifest_check.py`: validate manifest paths against disk
- `asset_manifest_export_json.py`: convert Lua-style asset indexes to JSON
- `asset_tilemap_editor.py`: inspect tilesets, export tile grids, render test maps

Keep tilemap metadata focused on tileset dimensions, tile size, columns, rows,
map layers, and collision semantics. Keep sprite metadata focused on frame
size, frame count, FPS, and animation names.
