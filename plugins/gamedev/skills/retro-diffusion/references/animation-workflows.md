# Retro Diffusion Animation Workflows

## Which Style To Use

### Use `rd_advanced_animation__walking` when:

- you already have a single approved starting frame
- you want a same-character walk cycle from that frame
- you want to preserve a specific side-view or pose family
- you want to compare the result against other model families starting from the same anchor

This is the best first choice for reference-driven walk cycles.

Operational notes:

- works well from compact prepared anchors (`32x32` to `64x64`)
- can be unstable or unusable from larger references
- keep prompts very short or the backend can fail with an action-length validation error

### Use `rd_advanced_animation__idle` when:

- you have a starting frame and want a subtle breathing/idle loop
- the character should stay mostly still with minor motion

### Use `rd_advanced_animation__attack` when:

- you have a starting frame and want an attack animation
- pair with short `frames_duration` (4-6) for snappy attacks

### Use `rd_advanced_animation__jump` when:

- you have a starting frame and want a jump arc animation
- works best from a neutral standing pose

### Use `animation__four_angle_walking` when:

- you want Retro Diffusion's built-in multi-direction walking format
- you are willing to work in `48x48`
- you want a broad "how does RD solve walking by itself?" comparison

Do not treat it as a direct apples-to-apples comparison against an anchor workflow at a different frame size.

### Use `animation__walking_and_idle` when:

- you want both walk and idle in one style family
- you are exploring a compact `48x48` character set

### Use `animation__8_dir_rotation` when:

- you want a built-in eight-direction rotation sheet
- your target is `80x80`
- you are exploring turnaround quality rather than strict adherence to an existing gameplay anchor

Operational notes:

- treat this as a probe, not the main workflow
- it can return server-side `500` errors even at `80x80`
- if that happens, switch to staged `rd_pro__edit` immediately

### Use staged `rd_pro__edit` when:

- the built-in 8-direction mode fails or collapses directions
- you need a more dependable isometric turnaround path
- you already have one approved isometric anchor

Recommended staged path:

- generate isometric cardinals from the anchor
- then generate isometric diagonals using the same anchor plus the cardinal output as a reference image

## Prompting For Side Walks

Good prompt structure:

- identify the character
- restate the reference
- describe the action as in-place
- lock the camera/facing
- request readable limbs
- exclude camera rotation and background drift

Example direction:

`[Character description]. Create a clean side-facing walk cycle in place, facing right, with readable alternating arm swing and leg stride. Keep the character identity, profile view, costume, and silhouette stable across frames. No camera rotation, no turn toward the viewer, no extra props, no background.`

Practical shorter version (preferred for advanced animation):

`[Character] side walk in place, facing right. Keep [key visual features] and stable side profile. No travel, no camera move, no background.`

## Prompting For Other Actions

### Idle loops

`[Character] idle breathing loop. Subtle chest rise, slight arm sway. Keep pose and facing stable. No drift, no background.`

### Attack animations

`[Character] slash attack, facing right. Quick swing arc, return to neutral. Keep silhouette consistent. No travel.`

### Jump animations

`[Character] jump arc. Crouch, rise, hang, land. Keep facing and identity stable. No horizontal drift.`

## Common Failure Modes

- **Perspective drift**: the character rotates toward 3/4 view during the cycle
- **Travel instead of loop**: the whole character moves sideways instead of animating in place
- **Identity softening**: distinguishing features lose fidelity across frames
- **Unreadable limb overlap**: arms or legs merge into a muddy cluster
- **Wrong artifact format**: GIF returned when you needed a spritesheet
- **Action-length validation failure**: advanced animation requests fail because the backend-expanded action string exceeds the service limit
- **Large-anchor instability**: a bigger reference behaves worse than a compact prepared one
- **One-shot turnaround server failure**: `animation__8_dir_rotation` errors before producing anything useful

## Practical Defaults

For side-view walk-cycle studies from a reference:

- style: `rd_advanced_animation__walking`
- width/height: match the prepared reference (e.g. `64x64`)
- frames_duration: `8`
- return_spritesheet: `true`
- num_images: `1`
- prompt: very short, literal, and action-focused

For isometric turnaround studies:

- probe: `animation__8_dir_rotation` at `80x80`
- dependable fallback: staged `rd_pro__edit`

For idle loops:

- style: `rd_advanced_animation__idle`
- frames_duration: `6` or `8`
- return_spritesheet: `true`
- prompt: emphasize subtlety

For attack animations:

- style: `rd_advanced_animation__attack`
- frames_duration: `4` or `6`
- return_spritesheet: `true`
- prompt: describe the action arc
