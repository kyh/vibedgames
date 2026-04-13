# Retro Diffusion API And Styles

Primary source: `https://github.com/Retro-Diffusion/api-examples`

## Core Inference Endpoint

- `POST https://api.retrodiffusion.ai/v1/inferences`
- auth header: `X-RD-Token: YOUR_API_KEY`

Typical response fields:

- `created_at`
- `balance_cost`
- `base64_images`
- `output_urls`
- `model`
- `remaining_balance`

Use `check_cost: true` to estimate cost without generating.

## Important Input Fields

- `prompt`
- `prompt_style`
- `width`
- `height`
- `num_images`
- `seed`
- `check_cost`
- `input_image`
- `reference_images`
- `strength`
- `return_spritesheet`
- `frames_duration`
- `remove_bg`
- `input_palette`

## Reference Image Rules

For `input_image` and related image inputs:

- base64-encode the image bytes only
- do not include a `data:image/png;base64,` prefix
- use RGB with no transparency

For `reference_images` on RD Pro:

- up to 9 base64 reference images

## Styles

### RD Pro

- `rd_pro__platformer`
  - side-scroller/platformer perspective
- `rd_pro__edit`
  - reference-driven edit mode
- `rd_pro__spritesheet`
  - asset or sheet generation on a simple background
- `rd_pro__pixelate`
  - convert an input image into pixel art

Default documented RD Pro size range:

- `96x96` to `256x256`, unless otherwise specified

### RD Fast

- `rd_fast__character_turnaround`
  - character viewed from different angles

Default documented RD Fast size range:

- `64x64` to `384x384`, unless otherwise specified

### RD Plus

- `rd_plus__character_turnaround`
- `rd_plus__isometric`
- `rd_plus__isometric_asset`

## Animation Styles

### Fixed-format animation styles

- `animation__8_dir_rotation`
  - `80x80` only
- `animation__four_angle_walking`
  - `48x48` only
- `animation__walking_and_idle`
  - `48x48` only
- `animation__small_sprites`
  - `32x32` only
- `animation__vfx`
  - `24x24` to `96x96`, square only
- `animation__any_animation`
  - `64x64` only
- `animation__battle_sprites`
  - `64x64` only

Animations return transparent GIFs by default.

Set:

- `return_spritesheet: true`

to request a transparent PNG spritesheet instead.

### Advanced animation styles

These are starting-frame-driven styles:

- `rd_advanced_animation__walking`
- `rd_advanced_animation__idle`
- `rd_advanced_animation__attack`
- `rd_advanced_animation__jump`
- `rd_advanced_animation__crouch`
- `rd_advanced_animation__custom_action`
- `rd_advanced_animation__subtle_motion`

Important notes from the API examples:

- `input_image` is required
- `width` and `height` should match the starting frame
- supported frame sizes are `32x32` to `256x256`
- `frames_duration` supports `4`, `6`, `8`, `10`, `12`, or `16`
- neutral starting poses work best for character actions

Known behavioral notes:

- successful advanced-walking runs have returned transparent spritesheet PNGs when `return_spritesheet: true` was set
- compact prepared references (`32x32` to `64x64`) tend to be more reliable than larger ones for advanced animation
- advanced-animation requests appear to be sensitive to a hidden action-length limit; keep prompts extremely short

## Practical Notes

- Prepare explicit RGB reference inputs for clean experiments.
- If the source sprite is RGBA, prepare a flat RGB reference image first instead of relying on implicit black flattening.
- If the source reference is larger than `256x256`, prepare a nearest-neighbor downscaled square reference before using an advanced animation style.
- `animation__8_dir_rotation` should not be treated as reliable until it produces a successful run; staged `rd_pro__edit` is the proven turnaround fallback.

## User Styles

Retro Diffusion also supports user-created styles via:

- `POST /v1/styles`
- `PATCH /v1/styles/{style_id}`
- `DELETE /v1/styles/{style_id}`

The API exists for user-style CRUD and could be integrated if repeated house-style work becomes important.
