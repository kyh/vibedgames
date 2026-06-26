# Phaser 4 Spritesheets and Textures

Most "rendering bugs" in 2D games are asset metadata bugs. Measure first — never infer from appearance.

## Before Loading

Confirm from the source asset: full image width/height, frame width/height, spacing, margin, atlas frame bounds, pixel-art vs smooth, and whether the texture is compressed.

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

## Anti-Patterns

- Eyeballing frame dimensions
- Assuming all texture sources share the same orientation rules
- Debugging animation timing before verifying frame metadata
- Treating compressed textures like ordinary PNGs during migration
- Assuming old compression pipeline assets work in Phaser 4 without checking Y-axis orientation
