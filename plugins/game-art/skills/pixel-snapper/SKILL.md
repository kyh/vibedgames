---
name: pixel-snapper
description: "Recover the true low-resolution pixel grid from upscaled or AI-generated fake pixel art PNGs. Use for snap-to-grid cleanup, native-resolution sprite assets, palette-quantized game art, and known-layout spritesheets. Bundles uv Python scripts ported from Hugo Duprez's spritefusion-pixel-snapper."
metadata:
  short-description: "Recover native pixel grids from fake pixel art."
---

# Pixel Snapper

Recover the underlying low-resolution pixel grid from images that *look* like pixel art but are stored at a much higher resolution with anti-aliased or smudged edges. Common case: a 1024×1024 AI-generated character that conceptually has ~100×100 chunky pixels.

This skill bundles a Python port (`scripts/pixel_snapper.py`) of [Hugo Duprez's Rust `spritefusion-pixel-snapper`](https://github.com/Hugo-Dz/spritefusion-pixel-snapper) (MIT). The port produces dimensionally identical output to the original Rust binary and runs as a uv self-contained script. No project install is required.

It also includes `scripts/pixel_snapper_sheet.py`, a known-layout spritesheet helper that crops frames first, snaps each frame independently, and reassembles the sheet.

## Philosophy: Discover, Don't Resize

A naive "downscale" (Lanczos, bilinear, nearest) just averages neighboring pixels and produces blur or aliasing. Pixel-snapping is fundamentally different: the algorithm *discovers* where the conceptual pixel boundaries already exist in the input and snaps to them. The output resolution is **a property of the input**, not a parameter you set.

**Before running, ask**:
- Is this actually pixel art that's been upscaled or AI-faked, or is it a real photograph / continuous-tone illustration? (Pixel-snapping only makes sense for the former.)
- What palette complexity does the input have? Bright cartoony art tolerates `--k-colors 256`; pre-quantized retro palettes may benefit from a much smaller `k` (16, 32, 64).
- Do you want the native snapped output, or a nearest-neighbour upscale for inspection? You almost always want both.
- Are the conceptual pixels actually square, or did the source apply non-uniform scaling? The snapper assumes one shared cell pitch for both axes.

**Core principles**:
1. **Output resolution is discovered**, not specified. The snapper detects the cell pitch from edge profiles and resamples accordingly. Don't fight this.
2. **`k_colors` is the only user-facing knob.** Twelve other internal tunables exist (peak thresholds, walker windows, fallback segments) but you should only touch them by editing the `Config` dataclass.
3. **Always inspect output visually.** Dimensions are a sanity check, not a quality check. A snapper run can produce a "correct" 50×50 output that's actually missing detail — you only see this by eye.
4. **Original concept stays the source of truth.** Snapped output is a derivative; keep the source PNG so you can re-snap with different `k_colors` later.

## When to Use

Trigger this skill when the user:
- has AI-generated "pixel art" (gpt-image, retro-diffusion, etc.) and wants a cleaner, smaller, palette-quantized version
- needs to convert a high-res mockup into a true pixel-art asset for a spritesheet or tilemap
- wants to recover the underlying grid of an upscaled retro asset
- mentions "snap to pixel grid", "fake pixel art", "downsample to native res", or links the Hugo-Dz repo

Skip this skill for:
- photographs, continuous-tone illustrations, or vector art (no underlying grid to recover)
- already-native pixel art (the snapper would just round-trip it, possibly losing detail)
- spritesheet *layout* recovery where rows/columns are unknown (use an asset-probing workflow first; `pixel_snapper_sheet.py` expects known `--cols` and `--rows`)

## Quick Start

The script is self-contained via PEP 723 inline metadata (numpy + pillow). No `pip install` needed:

```bash
uv run .claude/skills/pixel-snapper/scripts/pixel_snapper.py input.png output.png --k-colors 256
```

Or, after `chmod +x`, the shebang `#!/usr/bin/env -S uv run --script` lets you call it directly:

```bash
.claude/skills/pixel-snapper/scripts/pixel_snapper.py input.png output.png --k-colors 256
```

uv installs deps on first run and caches them. Output is one snapped PNG at the discovered native resolution.

For inspection, follow up with an integer-multiple nearest-neighbour upscale via ffmpeg:

```bash
ffmpeg -y -i snapped.png -vf "scale=iw*8:ih*8:flags=neighbor" snapped-x8.png
```

See `references/usage-examples.md` for batch processing and verification recipes.

For a known-layout spritesheet, snap frames independently:

```bash
uv run .claude/skills/pixel-snapper/scripts/pixel_snapper_sheet.py \
  sheet.png sheet-snapped.png --cols 6 --rows 1 --k-colors 256
```

## Workflow

1. **Identify the source.** Confirm the input genuinely has a pixel-art design buried in it — not a photograph or continuous painting.
2. **Pick `k_colors`.** Start with 256 for AI renders (vibrant palettes). For quantized retro art, try 16, 32, 64 in ascending order until detail is preserved without keeping noise.
3. **Run the snapper.** The script prints output dimensions; sanity-check those against your expectation (e.g. a "32×32 sprite" should snap near 32×32, not 5×5 or 800×800).
4. **Inspect the upscale.** `iw*8` nearest-neighbour gives a viewable size while preserving the recovered pixels exactly.
5. **Iterate if needed.** If the output looks wrong, the most common fixes are:
   - Different `k_colors` (try halving or doubling)
   - The input has non-square cells (snapper picks the smaller pitch — may need pre-resize)
   - Step-detection failed (output is exactly 64×64 → fallback fired; input may not have detectable pixel structure)
6. **Save outputs to `experiments/`**, never directly into `public/assets/`. Snapping is exploratory; promote to assets only after visual approval.

## Common Pitfalls and Anti-Patterns to Avoid

WARNING: DO NOT treat pixel snapping as a mandatory cleanup step for every generated asset. Use it only when the input has a recoverable pixel grid.

❌ **Anti-pattern: treating snapper as a generic downscaler**
Why bad: The algorithm assumes the input has a hidden pixel grid. On a photograph it produces a low-color, low-resolution mess that looks like neither the input nor good pixel art.
Better: Use this only for upscaled / AI-faked pixel art. For continuous images, use Lanczos or bicubic downscaling.

❌ **Anti-pattern: using default `k_colors=16` on vibrant AI renders**
Why bad: 16 colors is fine for retro-style inputs but crushes detail on AI renders that may have hundreds of meaningful colors.
Better: Default to 256 for AI sources. Drop `k_colors` only if the output looks too noisy.

❌ **Anti-pattern: trusting dimensions as the only quality check**
Why bad: A snapped 100×100 output can be missing limbs, fingers, or weapon edges and the dimensions look fine.
Better: Always view the nearest-neighbour upscale and compare side-by-side with the source.

❌ **Anti-pattern: trying to set output resolution**
Why bad: There's no `--width` or `--height` flag, by design. Output resolution is discovered.
Better: If you need a specific output size, snap first (recover native), then nearest-neighbour upscale to a multiple. Don't snap-and-resize in one step.

❌ **Anti-pattern: running on already-snapped outputs**
Why bad: Re-snapping just round-trips through k-means again and loses data.
Better: Always snap from the original source PNG. Keep snapped outputs as terminal artifacts.

❌ **Anti-pattern: dropping snapped output straight into `public/assets/`**
Why bad: Snapping is a creative process — first run is rarely the keeper. Premature promotion makes iteration harder.
Better: Save to `experiments/<timestamp>-pixel-snapper-<subject>/`. Promote only after review.

❌ **Anti-pattern: omitting attribution**
Why bad: The algorithm and parameter defaults are Hugo Duprez's design, MIT-licensed. Re-publishing without credit violates the license.
Better: Keep the credit block in `references/credits.md` whenever this skill is shared, forked, or referenced.

## Variation Guidance

**IMPORTANT**: Don't run the snapper with the same parameters on every input.

- **`k_colors` should match palette complexity.** A retro pixel art file with a 16-color NES-style palette doesn't need 256; an AI render with smooth shading might lose definition at 16. Pick by input.
- **Inspect at multiple zoom levels.** Native (e.g. 100×100) for grid sanity, x8 for visual review, x16 if you need to debug specific pixels.
- **Source vs. style.** A logo, a character sprite, and a tile may all be "pixel art" but want different `k_colors` (logos: low; character: medium; tile: high).
- **Adapt sheet handling to the input.** Single sprites, known-layout sheets, and unknown-layout sheets need different workflows; do not force them through the same command.
- **Don't chain snapper runs.** One run per source PNG. If results are bad, change `k_colors` and re-run from source.

## References

- `references/algorithm.md` — detailed pipeline walkthrough (quantize → profile → step-size → walk → resample)
- `references/credits.md` — MIT license terms and full attribution to Hugo Duprez
- `references/usage-examples.md` — concrete invocation patterns and inspection recipes

## Remember

The snapper does one thing well: it recovers a hidden pixel grid. It's not a general-purpose image downscaler, not an asset cleaner, not a palette converter for arbitrary art. When the input fits — upscaled or AI-faked pixel art — it produces output that a human pixel artist would have drawn in the first place. When the input doesn't fit, no parameter tuning will save you; reach for a different tool.

Credit where it's due: the algorithm design, the parameter defaults, and the original Rust implementation are Hugo Duprez's work, distributed under MIT. This Python port exists for portability and for use inside uv-driven workflows; it is not a replacement for the upstream project.
