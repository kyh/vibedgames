---
name: animated-spritesheets
description: "Turn a single character reference image into an animated spritesheet with model prompting, full-sheet frame recovery, background cleanup, normalization, contact sheets, and GIF previews. Use for AI-generated 2D character animation pipelines."
metadata:
  short-description: "Reference image to animated spritesheet pipeline."
---

# Animated Spritesheets

Use this skill when a user wants to start from one character reference image, usually a high-resolution `1024x1024` sprite-like image, and end with a usable animated spritesheet plus review artifacts such as contact sheets and GIFs.

Use it for:
- turning one approved reference sprite into directional anchors or action sheets
- salvaging AI-generated sheets whose poses drift outside implied frame cells
- producing review artifacts a game team can actually inspect

Do not use it for:
- hand-authoring final pixel art frame by frame
- tilemaps, environment sheets, or UI icon sets
- strict tiny-pixel workflows where every source pixel must already be exact

Typical inputs:
- `1` approved reference image, often `1024x1024`
- optional sheet guide such as a `512x1280` alternating-pixel contact sheet
- one prompt file describing direction, action, and frame ordering

Typical outputs:
- generated sheet or directional anchor
- recovered component crops
- optional no-background crops
- normalized runtime frames
- labeled contact sheet
- selected-sequence GIF

## Philosophy: Treat Spritesheets As Two Problems

Most AI sprite workflows fail because they treat the whole task as “generate some frames”.

In practice, this is **two different problems**:

1. **Generation**: getting the model to produce the right character, direction, and action.
2. **Registration**: turning that output into stable engine-style frames.

The second problem is usually the harder one.

**Before acting, ask**:
- Is the user asking for strict tiny-pixel art, or “high-resolution pixelated” art?
- Is the reference image already the approved in-game identity, or just concept art?
- Is the deliverable a single anchor frame, a full spritesheet, or a finished GIF preview?
- If the model spills across invisible cell boundaries, what is the source of truth: the cells or the full sheet?

**Core principles**:
1. **Identity anchor first**: use the approved in-game sprite when possible, not upstream concept art.
2. **Recover before polishing**: fix missing silhouette and framing before palette or edge cleanup.
3. **One anchor per sequence**: normalize all frames to one shared center/bottom rule unless the source genuinely requires otherwise.
4. **Review artifacts matter**: contact sheets and GIFs are part of the pipeline, not optional extras.

## Workflow

### 1. Choose the right input reference

Prefer:
- a single approved sprite-like reference, often `1024x1024`
- one clear identity image, not multiple conflicting art sources

Use concept art only when no approved gameplay-facing sprite exists.

### 2. Create a sheet guide

For multi-frame generation, create a sheet-sized guide image first.

Use `scripts/make_alternating_sheet.py` for:
- a neutral alternating-pixel background
- arbitrary sizes such as `512x1280`
- a guide that pushes pixel texture without adding visible grid lines

This guide is a **style/composition hint**, not a guarantee that the model will obey strict frame cells.

### 2b. Use neutral plates for video-derived walk cycles

When using image-to-video models to create walk-cycle source motion, do **not** use checkerboards, alternating-pixel sheets, or visible grids as the start image background.

Those guides work for still-image spritesheet generation, but video models often interpret them as floors, rooms, horizons, or perspective grids. This causes camera drift, character turning, and scene motion instead of a clean in-place walk.

For walk-cycle video passes, create a direction-specific neutral plate:
- `1280x720` canvas
- flat neutral gray background
- one approved direction anchor centered with feet visible
- no checker/grid/floor/horizon/arrows/labels
- enough padding for bobbing and cloth sway

Prompt the video model to lock:
- facing direction
- camera and framing
- flat background
- in-place walk motion
- no scene, no props, no effects

Use the image-to-video walk-cycle template in `references/prompt-patterns.md`.

Treat the video as motion reference only. Extract raw frames, build contact sheets and GIFs, let the team curate frames, then remove/mask the background and normalize only the selected frames.

### 3. Prompt for the whole sheet

Structure the prompt like a production brief:
- intended use
- image roles
- subject and direction
- ordered frame sequence
- look/rendering constraints
- composition constraints
- explicit avoid list

Keep the frame list concrete. For example:
- `Frame 1: ready idle`
- `Frame 5: first shot muzzle flash`
- `Frame 10: return to idle`

Use the prompt patterns in `references/prompt-patterns.md`.

### 4. Do not trust naive cell crops blindly

Even when the output size is exactly correct, the model may let hats, coats, feet, or muzzle flashes spill outside the implied cell boundaries.

Use `scripts/recover_component_frames.py` on the **full sheet** first:
- detect the dominant foreground components
- bucket them back onto the intended grid
- save tight recovered frame crops

This is often the real source of truth.

### 5. Remove background after silhouette recovery

If you need cleaner edges, run background removal on the recovered component crops, not on the original rigid cell crops.

Background removal is not bundled with this skill. Use a local tool (`rembg`, GIMP, Aseprite, Photoshop) or another service of your choice on the recovered crops in `recovered-components/` before normalizing.

Why:
- raw cell crops may already be wrong
- whole-sheet background removal often destroys the original geometry
- per-component removal preserves the recovered silhouette

### 6. Normalize every frame to one shared anchor

Use `scripts/normalize_frames.py` to place every recovered/cleaned crop onto a fixed runtime frame, such as:
- canvas `256x256`
- center `x = 128`
- bottom `y = 255`

This is what prevents sideways drift and fake “skating”.

If the generated cells are **opaque flat-background crops** rather than transparent crops, do not build GIFs directly from those cells. First use `scripts/normalize_flat_bg_frames.py` to flood-fill the connected corner background, crop the actual foreground, and normalize every frame to the same center/bottom anchor. This fixes the common idle-sheet failure where the model places the character at different x/y offsets inside each nominal `256x256` cell.

### 6b. Audit the visible foot baseline before runtime export

After normalization, verify the **visible** alpha bounds inside the final engine frames.

This is separate from the image canvas size. A frame can be `256x256` and still be wrong if the feet end at `y = 215` with 40px of transparent padding underneath. In engines like Phaser, the sprite origin and shadow are usually applied to the full frame rectangle, not the visible pixels, so inconsistent bottom padding makes characters look like they float above their shadow.

Before exporting runtime sheets:
- inspect the alpha bounding box for every frame
- ensure the lowest non-transparent pixel lands on the intended baseline, commonly `bottomY = 255` for `256x256`
- compare all directions for the same character, not just frames within one animation
- if a review canvas is larger than runtime, rebaseline after downscaling or crop/pad into the runtime frame deliberately

If using the `gamedev-assets` skill, run `asset_sprite_baseline.py` to audit and optionally write baseline-corrected sheets.

### 7. Build review artifacts

Use:
- `scripts/build_contact_sheet.py` for labeled review sheets
- `scripts/build_sequence_gif.py` for full loops or curated sequences

Review at least:
- the generated sheet
- the recovered frame crops
- the normalized contact sheet
- the selected-sequence GIF

## Anti-Patterns To Avoid

❌ **Anti-pattern: trusting the invisible grid**
Why bad: the model may compose across cells even when the canvas size is exact.
Better: recover components from the full sheet before committing to frame boundaries.

❌ **Anti-pattern: background removal on the whole sheet**
Why bad: tools like remove.bg often crop to overall foreground bounds and destroy sheet geometry.
Better: remove backgrounds per recovered component crop.

❌ **Anti-pattern: per-frame recentering from scratch**
Why bad: it introduces drift and fake motion.
Better: normalize all frames to one shared center and bottom anchor.

❌ **Anti-pattern: treating frame size as proof of foot alignment**
Why bad: a `256x256` sheet can still contain 40px of transparent padding below the feet, causing shadow/origin bugs in-engine.
Better: audit alpha bounds and normalize the visible foot baseline before runtime export.

❌ **Anti-pattern: using checker/grid backgrounds for image-to-video walk cycles**
Why bad: video models interpret them as physical scenes and add perspective, horizons, camera drift, or character turns.
Better: use a neutral `1280x720` flat-background direction plate, then curate and normalize selected frames after extraction.

❌ **Anti-pattern: polishing before recovery**
Why bad: edge cleanup cannot restore missing feet or sliced coats.
Better: recover the full silhouette first, then clean the edges.

❌ **Anti-pattern: assuming “pixel perfect” tools always help**
Why bad: some pixel-snapping tools over-quantize and shrink high-resolution pixelated sprites.
Better: test them only after recovery and normalization, and keep them only if readability improves.

## Variation Guidance

**IMPORTANT**: Do not force every spritesheet into the same aesthetic.

Vary the pipeline based on:
- target look: strict retro pixel art vs high-resolution pixelated art
- direction set: south-only, west/east, north, 4-direction, 8-direction
- action type: walk, idle, attack, hurt, death
- sheet layout: single frame, strip, `2x5`, `4x4`, etc.

Things that should remain stable inside a sequence:
- identity source
- shared anchor rule
- frame canvas size
- visible foot baseline inside the final runtime frame
- selection logic for the final GIF

Things that may vary:
- prompt wording by action and direction
- selected frame order
- palette cleanup strategy
- whether background removal is needed at all

## Adaptation Rules

Use the workflow as a toolkit, not a rigid ceremony.

- If the model already gives isolated clean frames, skip recovery and go straight to normalization.
- If the sheet geometry is unreliable, trust full-sheet recovery over nominal cell math.
- If background removal damages important edges, keep the opaque crop and normalize that instead.
- If the output is a single directional anchor, stop after generation and review unless the user explicitly wants a sheet.
- If a one-shot runner is overkill, call the individual scripts directly and keep the artifacts that matter.
- If normalized review frames are downscaled or converted into runtime sheets, audit the final runtime PNGs again; review anchors do not automatically survive resizing.

## Resources

- Workflow reference: `references/pipeline.md`
- Prompt scaffolds: `references/prompt-patterns.md`
- Guide sheet generator: `scripts/make_alternating_sheet.py`
- One-shot pipeline runner: `scripts/run_pipeline.py`
- Full-sheet component recovery: `scripts/recover_component_frames.py`
- Frame normalization: `scripts/normalize_frames.py`
- Contact sheet builder: `scripts/build_contact_sheet.py`
- GIF builder: `scripts/build_sequence_gif.py`

## Quick Start

Use the runner when the user wants the whole pipeline, not just one script:

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
  --selected-order 01,03,02,04,05,07,09 \
  --durations-ms 140,110,110,110,120,120,160 \
  --flat-bg '#f0f0f0'
```

Generation runs through the vibedgames CLI (`vg image edit --model gpt-image-1.5`), so users authenticate once with `vg login` and never handle a provider key locally. Override the model with `--model` (any alias `vg models` exposes) or the binary with `--vg-bin`.

Background removal is not bundled. Run a local tool on `recovered-components/` between steps 4 and 6 if you need cleaner mattes.

## Remember

The hard part of AI spritesheets is rarely “make the model draw a character”.

The hard part is getting from a promising sheet to stable, readable, engine-style frames.

Recover the silhouette first. Clean the edges second. Normalize third. Curate the motion last.
