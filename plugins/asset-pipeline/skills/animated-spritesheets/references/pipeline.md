# Animated Spritesheet Pipeline

This skill is for the common case:

- the user has one reference image, often `1024x1024`
- they want a directional anchor or animated spritesheet
- they want review artifacts such as contact sheets and GIFs

## Quick Start

Use the one-shot runner when you want the whole flow in one command.

### Reference image -> generated sheet -> recovered frames -> GIF

```bash
uv run scripts/run_pipeline.py \
  --work-dir runs/my-character-attack \
  --reference refs/character-anchor-1024.png \
  --guide refs/alternating-sheet-512x1280.png \
  --prompt-file prompts/attack-sheet.txt \
  --sheet-size 512x1280 \
  --sheet-prefix attack-sheet \
  --rows 5 \
  --cols 2 \
  --frame-canvas 256x256 \
  --center-x 128 \
  --bottom-y 255 \
  --remove-bg \
  --selected-order 01,03,02,04,05,07,09 \
  --durations-ms 140,110,110,110,120,120,160 \
  --flat-bg '#f0f0f0'
```

### Existing sheet -> recovered frames -> GIF

```bash
uv run scripts/run_pipeline.py \
  --work-dir runs/my-existing-sheet \
  --skip-generation-sheet refs/generated-sheet.png \
  --rows 5 \
  --cols 2 \
  --frame-canvas 256x256 \
  --center-x 128 \
  --bottom-y 255 \
  --remove-bg \
  --selected-order 01,03,02,04,05,07,09 \
  --flat-bg '#f0f0f0'
```

### Guide generation

```bash
uv run scripts/make_alternating_sheet.py \
  --size 512x1280 \
  --out refs/alternating-sheet-512x1280.png
```

## Skill Packaging Notes

To keep this skill portable and friendly to ecosystems like `npx skills`:

- keep the entire workflow self-contained inside the skill folder
- prefer small uv-runnable scripts over long shell recipes
- use relative paths in examples where possible
- make the one-shot runner usable without project-specific assumptions or user-specific absolute paths
- keep prompts and pipeline guidance in `references/` rather than bloating `SKILL.md`

In practice that means:

- `SKILL.md` explains when and why to use the skill
- `references/` holds copy-pasteable workflow docs and prompt patterns
- `scripts/` does the deterministic work

This structure makes the skill easier to install, copy, symlink, and update across different agents and repos.

## Recommended Flow

1. Start from one approved reference image.
2. Create a sheet guide image sized to the intended output.
3. Prompt the image model for a full sheet or single directional anchor.
4. If the output is a sheet, inspect the whole sheet before splitting.
5. Recover frame silhouettes from the full sheet.
6. If needed, remove the background from recovered frame crops.
7. Normalize all frames onto one shared anchor.
8. Create contact sheets and GIFs.
9. Curate a selected-sequence GIF for the strongest motion.

## Why full-sheet recovery matters

A clean `512x1280` output can still contain poses that cross invisible `256x256` cell boundaries.

That means:
- rigid cell crops can cut off feet, hats, or muzzle flashes
- the “raw” cell crop may already be wrong
- downstream cleanup cannot restore missing silhouette

So the source of truth should often be:
- the full generated sheet
- the dominant foreground components
- a row/column bucketing pass back to the intended grid

## Recommended artifacts

For a robust run, keep:

- the original generated sheet
- recovered component crops
- cleaned no-background crops
- normalized runtime frames
- a labeled contact sheet
- one full-sequence GIF
- one selected-sequence GIF

## Typical selected-sequence workflow

The full sheet is diagnostic.

The final animation is editorial.

That means it is normal to:
- drop weak transition frames
- reorder slightly for clearer rhythm
- keep the strongest anticipation / shot / recovery moments
