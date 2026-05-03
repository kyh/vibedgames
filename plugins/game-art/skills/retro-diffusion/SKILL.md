---
name: retro-diffusion
description: "Use Retro Diffusion for pixel-art image generation, img2img edits, spritesheets, and animation workflows such as platformer walk cycles, turnarounds, idle loops, and attack sheets from reference images."
---

# Retro Diffusion

Use this skill when the user wants to generate pixel-art images or animation sheets through Retro Diffusion, especially when the task involves reference-image-driven character work like side-view platformer walks, turnarounds, or action cycles.

## Philosophy: Match The Style To The Asset Contract

Retro Diffusion does not expose a provider-agnostic model marketplace. The important control is the `prompt_style`, and each style implies a specific asset contract:

- some styles are general image models
- some are spritesheet-oriented
- some are fixed-size animation generators
- some require an input frame and work best only from neutral poses

The right way to use Retro Diffusion is:

- choose the style that matches the asset shape you want
- respect the style's size contract
- pass a clean RGB reference when using `input_image`
- treat cost checks and output capture as first-class workflow steps

**Before generating, ask:**
- Are we making a single image, a spritesheet, or an animation?
- Is this a freeform prompt, a reference-driven edit, or a starting-frame animation?
- Does the selected `prompt_style` impose a fixed frame size?
- Do we want a GIF preview, a PNG spritesheet, or both?

**Core principles**:
1. **Style first, prompt second**: in Retro Diffusion, `prompt_style` is the mode selector, not just a flavor tweak.
2. **Respect size contracts**: `animation__four_angle_walking` is a `48x48` workflow, `animation__8_dir_rotation` is `80x80`, and advanced animations should match the starting frame size.
3. **Reference cleanliness matters**: `input_image` should be RGB with no transparency, and the prompt should describe the reference rather than assume the API will infer everything.
4. **Capture the sheet, not just the preview**: for sprite work, prefer `return_spritesheet: true` so downstream analysis stays deterministic.
5. **Prompt shorter than you think**: for advanced animations, keep prompts extremely terse. The service expands action text internally, and long prompts can fail server-side even when your raw prompt looks reasonable.

## What This Skill Provides

- A Retro Diffusion workflow that runs through `vg image generate
  --provider retro-diffusion` for:
  - text-to-image
  - img2img-style runs via `input_image`
  - multi-reference runs via `reference_images`
  - fixed-style animation and spritesheet generation
- PIL utilities for reference prep and spritesheet inspection
- Model/style presets for the main Retro Diffusion modes:
  - `rd_pro__platformer`
  - `rd_pro__edit`
  - `rd_pro__spritesheet`
  - `rd_pro__pixelate`
  - `rd_fast__character_turnaround`
  - `rd_plus__character_turnaround`
  - `rd_plus__isometric`
  - `rd_plus__isometric_asset`
  - `animation__four_angle_walking`
  - `animation__8_dir_rotation`
  - `animation__walking_and_idle`
  - `animation__any_animation`
  - `animation__battle_sprites`
  - `rd_advanced_animation__walking`
  - `rd_advanced_animation__idle`
  - `rd_advanced_animation__attack`
  - `rd_advanced_animation__jump`
  - `rd_advanced_animation__crouch`
  - `rd_advanced_animation__custom_action`
  - `rd_advanced_animation__subtle_motion`

## Working With Retro Diffusion

### How Inferences Reach Retro Diffusion

This skill never calls the Retro Diffusion API directly. All generation
goes through the vibedgames CLI (`vg image generate --provider
retro-diffusion`), which proxies to `POST
https://api.retrodiffusion.ai/v1/inferences` server-side. The Retro
Diffusion API key lives on the platform — users authenticate once with
`vg login` and never handle a key locally.

Prerequisites:

- `vg` CLI installed (`npm i -g vibedgames`)
- `vg login` to authenticate

Outputs include:

- decoded image files written to `--output`
- `balance_cost` and `remaining_balance` returned in the run metadata
  (visible via `vg image ... --json`)

Animations normally come back as transparent GIFs. Add
`return_spritesheet: true` to `--params` when you want a PNG sheet
instead.

### Model Aliases

The CLI ships short aliases for the three most common Pro styles:

- `rd-pro-platformer` → `rd_pro__platformer`
- `rd-pro-edit` → `rd_pro__edit`
- `rd-pro-spritesheet` → `rd_pro__spritesheet`

For other styles, pass the full `prompt_style` as the model id with the
`retro-diffusion` provider:

```bash
--provider retro-diffusion --model rd_advanced_animation__walking
# or equivalently
--model retro-diffusion:rd_advanced_animation__walking
```

### Reference And Animation Guidance

For `input_image`:

- convert to RGB first (use `scripts/prepare_reference_image.py`)
- remove transparency
- pass it with `--image`; `vg image` uploads it as a presigned input ref
- pass extra references with `--reference`
- pass `input_palette` with `--palette`
- mention what the reference is in the prompt
- prefer an explicit prepared RGB reference image over silent RGBA-to-black conversion

For side-view platformer walks:

- prefer `rd_advanced_animation__walking` first when you already have a neutral starting frame
- keep `width` and `height` equal to that starting frame
- use `frames_duration` deliberately instead of taking the default
- ask for in-place locomotion if you want extractable frames instead of a traveling character
- compact frame sizes (`32x32` to `64x64`) tend to behave more reliably than large ones

For multi-direction walking presets:

- `animation__four_angle_walking` and `animation__walking_and_idle` are `48x48` workflows
- they are useful for broad exploration but may not match an existing anchor's frame size

For eight-direction turnaround experiments:

- try `animation__8_dir_rotation` first when you want a one-shot directional sheet
- it is fixed at `80x80`
- treat it as an initial experiment, not guaranteed directional truth
- if it returns server errors or weak directions, fall back to a staged `rd_pro__edit` workflow:
  - generate cardinals first from an anchor image
  - generate diagonals second using the same anchor plus the cardinal sheet as `reference_images`

### Prompting Guidance

Prompt like animation direction, not concept art copy:

- who the character is
- facing direction
- intended motion
- what must remain stable
- what should not happen

Good Retro Diffusion prompt components for character animation:

- identity: describe distinguishing visual features (clothing, colors, proportions)
- facing: side-facing, profile view, facing right, etc.
- motion: walk cycle in place, readable step rhythm, alternating arm swing
- stability: keep silhouette and costume consistent frame to frame
- exclusions: no camera movement, no perspective rotation, no extra props, no background

For advanced animation prompts in particular:

- prefer one or two short sentences
- avoid long descriptive prose
- avoid repeating identity details more than necessary
- keep the full prompt comfortably below `300` characters when possible

## Calling vg image

### Text-to-image

```bash
vg image generate \
  --model rd-pro-platformer \
  --prompt "A warrior character in pixel art style" \
  --output tmp/rd \
  --filename-prefix warrior \
  --params '{"width":256,"height":256}'
```

### Reference-driven edit (img2img)

Use `--image` for the primary reference and `--reference` for extra
references; `vg image` handles upload refs and provider wiring:

```bash
# 1. prepare the reference (RGB, optionally resized)
uv run plugins/game-art/skills/retro-diffusion/scripts/prepare_reference_image.py \
  --input sprite.png \
  --output prepared.png \
  --matte-color "#808080" \
  --target-size 64 \
  --trim-alpha

# 2. run
vg image generate \
  --model rd-pro-edit \
  --image prepared.png \
  --prompt "Same character, idle pose facing right" \
  --output tmp/rd-edit \
  --filename-prefix idle \
  --params '{"width":64,"height":64}'
```

Palette-guided runs use `--palette`, not inline `input_palette` params:

```bash
vg image generate \
  --model rd-pro-platformer \
  --palette palette.png \
  --prompt "A warrior character in pixel art style" \
  --output tmp/rd \
  --params '{"width":64,"height":64}'
```

### Animation / spritesheet

```bash
vg image generate \
  --provider retro-diffusion \
  --model rd_advanced_animation__walking \
  --prompt "Character side walk in place, facing right. Stable profile, no background." \
  --output tmp/walk \
  --filename-prefix walk \
  --params '{"width":64,"height":64,"frames_duration":8,"return_spritesheet":true}'
```

### Cross-style comparison

`--model` accepts a comma-separated list. The CLI fans jobs out in
parallel and emits a structured JSON result with per-run `runId` and
`metadata` (including `balance_cost`):

```bash
vg image generate \
  --model retro-diffusion:rd_pro__platformer,retro-diffusion:rd_pro__spritesheet \
  --prompt "A warrior character in pixel art style" \
  --output experiments/retro-diffusion/warrior-compare \
  -n 2 -p 4 \
  --json > experiments/retro-diffusion/warrior-compare/runs.json
```

### Cost-only check

Pass `check_cost: true` in `--params` to ask Retro Diffusion how many
credits a run would consume without generating it. The cost lands in the
`--json` metadata:

```bash
vg image generate \
  --model rd-pro-platformer \
  --prompt "A warrior character in pixel art style" \
  --output tmp/cost-check \
  --params '{"check_cost":true}' --json
```

## PIL Utilities

These are pure-PIL helpers that don't talk to any provider. Run them
with `uv run` (PEP 723 inline metadata).

### Preparing a reference image

```bash
uv run plugins/game-art/skills/retro-diffusion/scripts/prepare_reference_image.py \
  --input sprite.png \
  --output prepared.png \
  --matte-color "#808080" \
  --target-size 64 \
  --trim-alpha
```

### Extracting spritesheet frames

```bash
uv run plugins/game-art/skills/retro-diffusion/scripts/extract_rd_sheet_frames.py \
  spritesheet.png \
  --frame 64x64 \
  --out-dir frames/ \
  --prefix walk
```

## Anti-Patterns To Avoid

❌ **Anti-pattern: comparing incompatible animation styles as if they were the same task**
Why bad: a fixed `48x48` four-angle walker and a reference-driven advanced walking sheet are not equivalent outputs.
Better: compare them as different Retro Diffusion strategies, not as the same contract.

❌ **Anti-pattern: feeding transparent RGBA sprites directly into `input_image`**
Why bad: the docs say `input_image` should be RGB with no transparency.
Better: use `scripts/prepare_reference_image.py` to convert the input to RGB first.

❌ **Anti-pattern: asking for "walk animation" without saying whether you want a GIF or spritesheet**
Why bad: you may get a preview format that is harder to analyze downstream.
Better: request `return_spritesheet: true` when the goal is extraction or frame comparison.

❌ **Anti-pattern: using verbose prompts with advanced animation modes**
Why bad: the backend may internally expand the action text and hit a hidden `500`-character validation limit.
Better: keep advanced-animation prompts minimal and literal.

❌ **Anti-pattern: using oversized reference images with advanced animation styles**
Why bad: larger references can cause instability or failures where compact ones succeed.
Better: downscale the reference to a compact square (e.g. `64x64`) first, then try advanced animation.

❌ **Anti-pattern: trusting `animation__8_dir_rotation` as the canonical turnaround path**
Why bad: it can return server-side `500` errors even at the documented `80x80` size.
Better: keep it as a cheap first probe only, and rely on staged `rd_pro__edit` when you need a dependable turnaround workflow.

❌ **Anti-pattern: ignoring the built-in frame-size contracts**
Why bad: some styles silently clamp or ignore your requested size.
Better: choose the style because its size/output format fits the task.

❌ **Anti-pattern: treating Retro Diffusion as a general-purpose video model**
Why bad: this API is about pixel-art image and animation sheet generation, not free-camera video.
Better: use it for sprite-native outputs and compare those against video-derived workflows later.

❌ **Anti-pattern: skipping cost checks on unfamiliar styles**
Why bad: different styles have very different credit costs.
Better: always pass `--params '{"check_cost":true}'` first on a new style before committing to generation.

## Variation Guidance

**IMPORTANT**: Do not converge on one Retro Diffusion mode for every sprite task.

- vary between `RD_PRO`, `RD_FAST`, `RD_PLUS`, and advanced animation styles based on the asset contract
- vary `frames_duration` deliberately for short attack vs longer walk tests
- vary whether a run returns GIF preview or spritesheet based on the downstream need
- do not assume the best prompt for platformer walking is also the best prompt for turnarounds or idles
- try multiple frame sizes within a style's supported range to find the sweet spot for a given character

## References

- API and style notes: `references/api-and-styles.md`
- Animation strategy notes: `references/animation-workflows.md`
- Presets: `assets/model-presets.json`
- CLI command reference: `vg image --help`, `vg models`

## Remember

Retro Diffusion is strongest when you meet it on its own terms:

- pick the correct built-in style
- feed it a clean reference
- ask for the exact sprite artifact you need
- keep advanced-animation prompts brutally short
- prefer staged `rd_pro__edit` for dependable isometric turnaround work
- always cost-check unfamiliar styles before generation
- and track the result like an experiment, not a one-off prompt
