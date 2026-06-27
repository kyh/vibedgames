---
name: pixel-snapper
description: "Recover the true low-resolution pixel grid from upscaled or AI-generated fake pixel art PNGs. Use for snap-to-grid cleanup, native-resolution sprite assets, palette-quantized game art, and known-layout spritesheets. Bundles self-contained uv Python scripts."
metadata:
  short-description: "Recover native pixel grids from fake pixel art."
---

# Pixel Snapper

Recover the underlying low-resolution pixel grid from images that _look_ like pixel art but are stored at high resolution with anti-aliased/smudged edges (e.g. a 1024×1024 AI-generated character that conceptually has ~100×100 chunky pixels).

`scripts/pixel_snapper.py` is a Python port of an MIT-licensed Rust implementation (see `references/credits.md`), dimensionally identical to upstream, run as a uv self-contained script. `scripts/pixel_snapper_sheet.py` is a known-layout spritesheet helper: crops frames, snaps them together as one strip so every frame shares a single pixel grid, reassembles.

## Discover, Don't Resize

Naive downscale (Lanczos/bilinear/nearest) averages neighbors → blur or aliasing. Snapping instead _discovers_ where the conceptual pixel boundaries already exist and snaps to them. **Output resolution is a property of the input, not a parameter.**

**Before running, ask**:

- Is this genuinely upscaled/AI-faked pixel art, or a photo / continuous-tone illustration? (Snapping only fits the former.)
- Palette complexity? Bright cartoony art tolerates `--k-colors 256`; pre-quantized retro palettes may want a smaller `k` (16, 32, 64).
- Native snapped output, or a nearest-neighbour upscale for inspection? Usually you want both.
- Are the cells actually square? The snapper assumes one shared cell pitch for both axes.

**Core principles**: output resolution is discovered, not specified · `k_colors` is the only user-facing knob (other tunables live in the `Config` dataclass) · always inspect the output by eye — dimensions are a sanity check, not a quality check · keep the source PNG so you can re-snap with a different `k_colors` later · **snapping needs resolution to find the grid — feed it a large source (≥~512px across the subject; a lone character ~1024²). Undersized inputs (256²) blur the grid away or trip the 64×64 fallback; the fix is to regenerate larger, not to upscale a small source first.**

## When to Use

Use when the user has AI-generated "pixel art" (gpt-image, retro-diffusion, etc.) and wants a cleaner/smaller/palette-quantized version, needs a high-res mockup converted to a true pixel-art asset, wants to recover an upscaled retro asset's grid, or mentions "snap to pixel grid", "fake pixel art", "downsample to native res", or the Hugo-Dz repo.

Skip for: photographs / continuous-tone / vector art (no grid to recover); already-native pixel art (would just round-trip, possibly losing detail); spritesheet _layout_ recovery where rows/cols are unknown (probe first — `pixel_snapper_sheet.py` expects known `--cols`/`--rows`).

## Quick Start

Self-contained via PEP 723 (numpy + pillow); uv installs deps on first run and caches:

```bash
uv run .claude/skills/pixel-snapper/scripts/pixel_snapper.py input.png output.png --k-colors 256
```

After `chmod +x`, the shebang `#!/usr/bin/env -S uv run --script` lets you call it directly:

```bash
.claude/skills/pixel-snapper/scripts/pixel_snapper.py input.png output.png --k-colors 256
```

Output is one snapped PNG at the discovered native resolution. For inspection, follow up with an integer nearest-neighbour upscale via ffmpeg:

```bash
ffmpeg -y -i snapped.png -vf "scale=iw*8:ih*8:flags=neighbor" snapped-x8.png
```

For a known-layout spritesheet, snap every frame to one shared pixel grid:

```bash
uv run .claude/skills/pixel-snapper/scripts/pixel_snapper_sheet.py \
  sheet.png sheet-snapped.png --cols 6 --rows 1 --k-colors 256
```

See `references/usage-examples.md` for batch processing and verification recipes.

## Workflow

1. **Identify the source** — confirm a buried pixel-art design, not a photo/painting.
2. **Pick `k_colors`** — start 256 for AI renders; for quantized retro art try 16, 32, 64 ascending until detail survives without noise.
3. **Run** — sanity-check printed dims against expectation (a "32×32 sprite" snaps near 32×32, not 5×5 or 800×800).
4. **Inspect** the `iw*8` nearest-neighbour upscale.
5. **Iterate** — common fixes: different `k_colors` (halve/double); non-square cells (snapper picks the smaller pitch → may need pre-resize); exactly 64×64 output = step-detection fallback fired (input may lack detectable pixel structure).
6. **Save to `experiments/`**, never directly into `public/assets/`. Promote only after visual approval.

## Anti-Patterns

DO NOT treat snapping as a mandatory cleanup step for every asset — use it only when the input has a recoverable pixel grid.

- **Generic downscaler** — on a photo it produces a low-color mess. Use Lanczos/bicubic for continuous images.
- **Default `k_colors=16` on vibrant AI renders** — crushes detail. Default to 256 for AI sources; drop only if output looks noisy.
- **Trusting dimensions as the only quality check** — a snapped 100×100 can be missing limbs/fingers/weapon edges. Always view the nearest-neighbour upscale side-by-side with the source.
- **Trying to set output resolution** — there's no `--width`/`--height` by design. Snap first (recover native), then nearest-neighbour upscale to a multiple; don't snap-and-resize in one step.
- **Running on already-snapped outputs** — re-snapping round-trips k-means and loses data. Always snap from the original source; keep snapped outputs as terminal artifacts.
- **Dropping snapped output straight into `public/assets/`** — save to `experiments/<timestamp>-pixel-snapper-<subject>/`, promote after review.

## Variation Guidance

Don't run the same parameters on every input.

- **Match `k_colors` to palette complexity** — a 16-color NES-style file doesn't need 256; an AI render with smooth shading may lose definition at 16.
- **Inspect at multiple zooms** — native for grid sanity, x8 for review, x16 to debug specific pixels.
- **Source vs style** — logo/character/tile may all be "pixel art" but want different `k_colors` (logos low, character medium, tile high).
- **Adapt sheet handling** — single sprites, known-layout sheets, and unknown-layout sheets need different workflows.
- **Don't chain runs** — one per source PNG; if bad, change `k_colors` and re-run from source.

## References

- `references/algorithm.md` — pipeline walkthrough (quantize → profile → step-size → walk → resample)
- `references/credits.md` — MIT license + attribution
- `references/usage-examples.md` — invocation patterns + inspection recipes

The snapper does one thing well: recover a hidden pixel grid. It's not a general downscaler, asset cleaner, or palette converter for arbitrary art. When the input fits — upscaled/AI-faked pixel art — it produces what a human pixel artist would have drawn. When it doesn't, no parameter tuning will save you; use a different tool.
