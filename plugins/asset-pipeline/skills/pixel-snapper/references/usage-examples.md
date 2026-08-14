# Usage Examples

Concrete invocation patterns. All paths assume project root.

## Single Image — Default (k=16)

Quick and dirty for a small retro-style input:

```bash
node .claude/skills/pixel-snapper/scripts/pixel_snapper.mjs \
  input.png \
  output.png
```

## Single Image — High Color Count (recommended for AI renders)

```bash
node .claude/skills/pixel-snapper/scripts/pixel_snapper.mjs \
  concepts/sprites/characters/cass-cowboy-south-1.png \
  experiments/<timestamp>-pixel-snap-cass/cass-snapped.png \
  --k-colors 256
```

## Direct invocation (after `chmod +x`)

The script's shebang is `#!/usr/bin/env node`, so once executable you can call it like any CLI:

```bash
chmod +x .claude/skills/pixel-snapper/scripts/pixel_snapper.mjs

.claude/skills/pixel-snapper/scripts/pixel_snapper.mjs \
  input.png output.png --k-colors 256
```

## Batch — All Files in a Directory

```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUT_DIR=experiments/${TIMESTAMP}-pixel-snap-batch
mkdir -p "$OUT_DIR"
for f in concepts/sprites/characters/*.png; do
  name=$(basename "$f" .png)
  node .claude/skills/pixel-snapper/scripts/pixel_snapper.mjs \
    "$f" "$OUT_DIR/${name}-snapped.png" --k-colors 256
done
```

## Inspection — Nearest-Neighbour x8 Upscale

After snapping, view the output at a usable size without browser resampling artifacts:

```bash
for f in "$OUT_DIR"/*-snapped.png; do
  name=$(basename "$f" .png)
  node .claude/skills/pixel-snapper/scripts/image_util.mjs upscale \
    "$f" "$OUT_DIR/${name}-x8.png" --factor 8
done
```

x8 is the sweet spot for inspection. Use x16 if you need to debug specific pixels.

## Sweep `k_colors` to Pick the Right Value

When you don't know which `k_colors` is right for a given input, sweep:

```bash
for k in 16 32 64 128 256; do
  node .claude/skills/pixel-snapper/scripts/pixel_snapper.mjs \
    input.png "out-k${k}.png" --k-colors "$k"
  node .claude/skills/pixel-snapper/scripts/image_util.mjs upscale \
    "out-k${k}.png" "out-k${k}-x8.png" --factor 8
done
```

Then visually compare. Smaller `k` = blockier, more "vintage". Larger `k` = closer to source. Pick the smallest `k` where the design still reads correctly.

## Known-Layout Spritesheet

Use `pixel_snapper_sheet.mjs` when the input is already a sheet with known rows and columns. It crops the frames out of the sheet (removing the frame-grid scale that would otherwise confuse step detection), snaps them together as one strip so every frame lands on the same pixel grid and stays the same size, then reassembles the sheet.

```bash
node .claude/skills/pixel-snapper/scripts/pixel_snapper_sheet.mjs \
  concepts/sprites/characters/walk-south.png \
  experiments/<timestamp>-pixel-snap-walk/walk-south-snapped.png \
  --cols 6 --rows 1 --k-colors 256
```

## Quick Sanity Checks

- **Input dims**: `node scripts/image_util.mjs size input.png`.
- **Output dims**: same. The script also prints them on completion.
- **Was the fallback triggered?** If output is exactly 64×64 and input is large, step-detection failed. Either change `k_colors` significantly, or this image isn't a pixel-snapping candidate.
- **Did colors collapse to nothing?** If output is mostly one color, `k_colors` is too low; double it.

## Reproducing the Reference Test

The character concepts in `concepts/sprites/characters/` were the original test set. Verifying the port:

```bash
mkdir -p experiments/pixel-snapper-verification
for f in concepts/sprites/characters/*.png; do
  name=$(basename "$f" .png)
  node .claude/skills/pixel-snapper/scripts/pixel_snapper.mjs \
    "$f" "experiments/pixel-snapper-verification/${name}-snapped.png" --k-colors 256
done
```

Expected dimensions:

| Character                | Expected Output |
| ------------------------ | --------------- |
| `cass-cowboy-south-1`    | 94×96           |
| `kaede-ninja-south-1`    | 115×114         |
| `thorne-brawler-south-1` | 129×129         |
| `wren-wizard-south-1`    | 103×101         |

If you get different numbers on these inputs, something has changed in the port. One caveat: the k-means seeding differs from upstream's (see `credits.md`), so on an input whose pitch is genuinely ambiguous a small deviation is a seeding difference rather than a regression. On dense pixel art like these characters it is not.

## When NOT to Use This

- Input is a photograph or continuous-tone illustration → use `node scripts/image_util.mjs resize in.png out.png --size WxH` (Lanczos).
- You need to infer unknown rows/columns or extract arbitrary frames from a spritesheet → use an asset-probing workflow first.
- The image is already at native pixel-art resolution → just leave it alone, or use a palette-only quantizer like `pngquant` if you specifically want fewer colors.
