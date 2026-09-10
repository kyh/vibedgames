# Phaser 4 Spritesheets and Textures

Most "rendering bugs" in 2D games are asset metadata bugs. Measure first — never infer from appearance.

## Before Loading

Confirm from the source asset: full image width/height, frame width/height, spacing, margin, atlas frame bounds, pixel-art vs smooth, and whether the texture is compressed.

- **No dimension over ~4096 px.** Many mobile GPUs report `MAX_TEXTURE_SIZE` 4096; a wider strip uploads as an empty texture, the spritesheet parser yields 0 frames, and the first `play()` throws (`reading 'duration'` in `getFirstTick`) — desktop is fine, phones die. Reshape long strips into grids: the loader tiles row-major by frame size, so a 40×1 strip and a 8×5 grid give identical frame indices.

## Spritesheets

- compute the frame grid from exact dimensions
- verify spacing and margin numerically
- confirm whether frames are square or rectangular
- test the final frame index and row count, not just the first frame

Verification formula: `imageWidth = (frameWidth × cols) + (spacing × (cols - 1)) + (margin × 2)`

## Atlases

- trust the atlas data, not visual intuition
- confirm the frame names the code expects actually exist
- inspect trimmed frames carefully when using tight collision or origin assumptions

## Texture Orientation

Phaser 4 uses GL-style texture orientation internally (Y=0 at bottom). This matters most for custom shaders, framebuffer outputs, and compressed textures. Ordinary PNG/JPG loading is handled for you.

**If a shader effect looks upside down, mirrored, or vertically offset:**

1. Verify the shader's UV assumptions (Y=0 is now at the bottom)
2. Verify the source texture orientation
3. Verify whether the source came from a framebuffer or compressed texture path

Do not immediately blame the math if the asset pipeline may be wrong.

## `TileSprite` in Phaser 4

Phaser 4 `TileSprite` is more capable, but it is not the old object internally.

Key implications:

- texture cropping support is gone — if old code used crop-based repetition, redesign the approach
- repeating atlas or spritesheet frames is now viable (v3 could only repeat the entire texture file)
- `tileRotation` property is available
- **a 0 width or height kills the WebGL context — the whole tab dies** ("Target crashed" in DevTools, no JS error, nothing to catch). Any TileSprite sized from layout math (`(bottom - top)`, `cols * tileW`) needs `Math.max(1, …)` on both axes before construction and before `setSize`.

## Animations from Per-Frame Durations

Authored sheets (Aseprite exports, `animated-spritesheets` manifests) carry a duration per frame. Wire them as-is:

```ts
this.anims.create({
  key: "hero-attack",
  frames: frameMs.map((duration, i) => ({ key: "hero", frame: i, duration })), // no frameRate
  repeat: 0,
});
sprite.play("hero-attack");
sprite.anims.timeScale = authoredMs / targetMs; // retime here, never via play({ duration })
```

- `play(key, { duration })` **freezes the clip on frame 1**: the override changes `state.frameRate`, and `getFirstTick` only reads `currentFrame.duration` when `state.frameRate === anim.frameRate`. `timeScale` is the only safe retime.
- Verify with `sprite.anims.currentFrame.index` advancing (1-based) — not by eye.

## Anti-Patterns

- `play(key, { startFrame: seed % 8 })` with a hardcoded frame count — clamp to `this.anims.get(key)?.frames.length`; a missing or 0-frame anim throws `reading 'duration'` in `getFirstTick`
- Passing `duration` to `play()` for a per-frame-duration anim (see above)

## Texture Wrap Modes

```ts
import { WrapMode } from "phaser/textures";

texture.setWrap(WrapMode.CLAMP_TO_EDGE); // Always available
texture.setWrap(WrapMode.REPEAT); // Power-of-two textures only
texture.setWrap(WrapMode.MIRRORED_REPEAT); // Power-of-two textures only
```

Use `TextureManager#addFlatColor(key, color, alpha, width, height)` to create a placeholder flat-color texture while waiting for real assets.

## Compressed Textures

Compressed textures have a fixed orientation that cannot be flipped by Phaser. The Y-axis must be set correctly during compression.

If the old compression pipeline assumed Phaser 3 orientation (top-left origin), regenerate the compressed textures with Y-axis starting at bottom.

## Texture Anti-Patterns

- Eyeballing frame dimensions
- Assuming all texture sources share the same orientation rules
- Debugging animation timing before verifying frame metadata
- Treating compressed textures like ordinary PNGs during migration
- Assuming old compression pipeline assets work in Phaser 4 without checking Y-axis orientation
