# Usage Examples

Concrete invocation patterns. All paths assume project root.

## Single Image — Default (k=16)

Quick and dirty for a small retro-style input:

```bash
uv run .claude/skills/pixel-snapper/scripts/pixel_snapper.py \
  input.png \
  output.png
```

## Single Image — High Color Count (recommended for AI renders)

```bash
uv run .claude/skills/pixel-snapper/scripts/pixel_snapper.py \
  concepts/sprites/characters/cass-cowboy-south-1.png \
  experiments/<timestamp>-pixel-snap-cass/cass-snapped.png \
  --k-colors 256
```

## Direct invocation (after `chmod +x`)

The script's shebang is `#!/usr/bin/env -S uv run --script`, so once executable you can call it like any CLI:

```bash
chmod +x .claude/skills/pixel-snapper/scripts/pixel_snapper.py

.claude/skills/pixel-snapper/scripts/pixel_snapper.py \
  input.png output.png --k-colors 256
```

## Batch — All Files in a Directory

```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUT_DIR=experiments/${TIMESTAMP}-pixel-snap-batch
mkdir -p "$OUT_DIR"
for f in concepts/sprites/characters/*.png; do
  name=$(basename "$f" .png)
  uv run .claude/skills/pixel-snapper/scripts/pixel_snapper.py \
    "$f" "$OUT_DIR/${name}-snapped.png" --k-colors 256
done
```

## Inspection — Nearest-Neighbour x8 Upscale

After snapping, view the output at a usable size without browser resampling artifacts:

```bash
for f in "$OUT_DIR"/*-snapped.png; do
  name=$(basename "$f" .png)
  ffmpeg -y -loglevel error -i "$f" \
    -vf "scale=iw*8:ih*8:flags=neighbor" \
    "$OUT_DIR/${name}-x8.png"
done
```

x8 is the sweet spot for inspection. Use x16 if you need to debug specific pixels.

## Sweep `k_colors` to Pick the Right Value

When you don't know which `k_colors` is right for a given input, sweep:

```bash
for k in 16 32 64 128 256; do
  uv run .claude/skills/pixel-snapper/scripts/pixel_snapper.py \
    input.png "out-k${k}.png" --k-colors "$k"
  ffmpeg -y -loglevel error -i "out-k${k}.png" \
    -vf "scale=iw*8:ih*8:flags=neighbor" "out-k${k}-x8.png"
done
```

Then visually compare. Smaller `k` = blockier, more "vintage". Larger `k` = closer to source. Pick the smallest `k` where the design still reads correctly.

## Known-Layout Spritesheet

Use `pixel_snapper_sheet.py` when the input is already a sheet with known rows and columns. The script crops each frame before snapping so the sheet grid does not interfere with the recovered pixel grid inside each frame.

```bash
uv run .claude/skills/pixel-snapper/scripts/pixel_snapper_sheet.py \
  concepts/sprites/characters/walk-south.png \
  experiments/<timestamp>-pixel-snap-walk/walk-south-snapped.png \
  --cols 6 --rows 1 --k-colors 256
```

Use `--shared-palette` when all frames should quantize against one palette:

```bash
uv run .claude/skills/pixel-snapper/scripts/pixel_snapper_sheet.py \
  input-sheet.png output-sheet.png \
  --cols 4 --rows 4 --k-colors 128 --shared-palette
```

## Quick Sanity Checks

- **Input dims**: `sips -g pixelWidth -g pixelHeight input.png` (macOS) or `identify input.png` (ImageMagick).
- **Output dims**: same. The script also prints them on completion.
- **Was the fallback triggered?** If output is exactly 64×64 and input is large, step-detection failed. Either change `k_colors` significantly, or this image isn't a pixel-snapping candidate.
- **Did colors collapse to nothing?** If output is mostly one color, `k_colors` is too low; double it.

## Reproducing the Reference Test

The character concepts in `concepts/sprites/characters/` were the original test set. Verifying the port:

```bash
mkdir -p experiments/pixel-snapper-verification
for f in concepts/sprites/characters/*.png; do
  name=$(basename "$f" .png)
  uv run .claude/skills/pixel-snapper/scripts/pixel_snapper.py \
    "$f" "experiments/pixel-snapper-verification/${name}-snapped.png" --k-colors 256
done
```

Expected dimensions:

| Character | Expected Output |
|---|---|
| `cass-cowboy-south-1` | 94×96 |
| `kaede-ninja-south-1` | 115×114 |
| `thorne-brawler-south-1` | 129×129 |
| `wren-wizard-south-1` | 103×101 |

If you get different numbers on these inputs, something has changed in the port (or in numpy's RNG behavior between versions).

## When NOT to Use This

- Input is a photograph or continuous-tone illustration → use `ffmpeg -vf "scale=W:H:flags=lanczos"` or ImageMagick's `convert -resize`.
- You need to infer unknown rows/columns or extract arbitrary frames from a spritesheet → use an asset-probing workflow first.
- The image is already at native pixel-art resolution → just leave it alone, or use a palette-only quantizer like `pngquant` if you specifically want fewer colors.
