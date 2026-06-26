# Phaser 4 Rendering and Performance

Performance work starts with one question: what is actually expensive? Usually one of:

- too many independent objects and CPU-side updates
- too many shader or filter changes breaking batches
- too much fill-rate from large filtered or lit surfaces
- incorrect asset choices causing unnecessary work

## Choose the Right Rendering Path

### Standard Game Objects

Default. Use sprites, images, text, and tilemaps when entities are interactive, state changes frequently, gameplay logic is per-object, or debugging clarity matters more than max counts. Don't move to a specialized path just because it sounds faster.

### `SpriteGPULayer`

Huge numbers of mostly simple quads with predictable animation. Fast because it avoids per-object CPU work; the tradeoff is flexibility.

- Good fit: starfields, animated backgrounds, particle-like swarms, dense decorative motion.
- Bad fit: enemies with unique gameplay logic, objects needing constant structural edits, scenes where per-member mutation matters more than raw count.

**Populating efficiently**: Reuse a single config object when calling `addMember` in a loop. Creating millions of JS objects has significant allocation and GC cost.

```ts
const memberConfig = {};
for (let i = 0; i < 100000; i++) {
  memberConfig.x = Math.random() * 800;
  memberConfig.y = Math.random() * 600;
  layer.addMember(memberConfig); // same object reused
}
```

**"Removing" members without buffer splicing**: Set `scaleX`, `scaleY`, and `alpha` to 0 — the member still exists but fills no pixels.

### `TilemapGPULayer`

Use when the map is orthographic, one tileset suffices, very large visible tile counts matter, and smooth seamless filtering matters. Not a reflex upgrade over `TilemapLayer` — constraints are real: orthographic only (no isometric/hexagonal), single tileset per layer, max 4096×4096 tiles.

After editing layer data, call `generateLayerDataTexture()` to regenerate the GPU representation.

### `RenderTexture` and `DynamicTexture`

Use for texture capture, compositing, reuse of generated visuals, or staged multi-pass effects. Queued work is not executed work — call `render()` when the texture must update.

```ts
rt.draw(sprite, x, y);
rt.render(); // do not skip this
```

Use `preserve()` to retain commands for re-rendering across frames. Use `renderMode` on `RenderTexture` to control whether it draws itself or only updates its texture.

## Batch Breakers

Valuable but not free — each can break the current batch, forcing a new draw call: filters, lighting, shader changes, unusual blend behavior, render target switches. Use where the effect is visible and justified (a subtle glow on one hero, not on every prop).

Lighting specifically changes the shader: one lit object in a batch of 200 unlit sprites breaks the batch.

## New in Phaser 4

- **GL element drawing**: 4 vertices/quad instead of 6 — 33% less vertex data vs v3.
- **Index buffers**: Quads share an index buffer, reducing GPU upload cost.
- **Context restoration**: The renderer recovers from WebGL context loss.
- **`smoothPixelArt` config**: Antialiasing that preserves sharp texels when scaled up. Usually the right choice for retro graphics that rotate or scale.
- **`WebGLSnapshot` unpremultiplication**: Removes dark fringes from snapshot functions. On by default.

## Pixel Art Guidance

Phaser 4 no longer defaults to old `roundPixels` behavior.

For pixel art:

- start with `roundPixels: false` in game config
- enable per-object rounding only where needed via `vertexRoundMode`
- test camera movement, scaling, and rotation before committing

Available `vertexRoundMode` values:

- `"off"`: Never round
- `"safe"`: Round only when transform is position-only (no scale/rotation)
- `"safeAuto"` (default): Like safe, but only when camera has `roundPixels` enabled
- `"full"`: Always round (PS1-style wobble on rotation)
- `"fullAuto"`: Like full, but only when camera has `roundPixels` enabled

If the scene has transforms everywhere, forcing full rounding can trade shimmer for wobble. That is a stylistic choice, not a default.

## Debugging Order

When performance is poor:

1. Count object types and churn.
2. Check whether filters or lighting are everywhere.
3. Identify whether a GPU layer would simplify the scene.
4. Verify textures and tile data are not causing avoidable redraws.
5. Profile before rewriting architecture.

## Anti-Patterns

- Using shader/filter solutions for problems that tint, texture, or art direction could solve
- Moving gameplay entities into `SpriteGPULayer` too early
- Assuming the most GPU-heavy path is the fastest path
- Optimizing before validating correctness
- Applying lighting to every object "just in case"
- Forgetting that lighting breaks batches
