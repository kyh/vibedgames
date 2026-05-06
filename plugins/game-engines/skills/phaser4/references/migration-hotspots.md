# Phaser 3 to 4 Migration Hotspots

Use this reference before touching a Phaser 3 codebase. The first pass is not implementation; it is search, classification, and scope control.

## Migration Philosophy

Do not treat migration as a flat rename exercise.

Split findings into three buckets:

1. **Usually mechanical**: straightforward API updates
2. **Behavioral review required**: code may compile but behave differently
3. **Architectural rewrite**: the underlying renderer or feature model changed

This prevents wasting time hand-editing easy cases while missing the renderer-level risks.

## First Search Pass

Run searches for these symbols early:

- `setTintFill`
- `tintFill`
- `BitmapMask`
- `GeometryMask`
- `preFX`
- `postFX`
- `ColorMatrix`
- `Phaser.Geom.Point`
- `Point.`
- `Math.TAU`
- `Math.PI2`
- `setPipeline('Light2D')`
- `setPipeline("Light2D")`
- `DynamicTexture`
- `RenderTexture`
- `TileSprite`
- `Shader`
- `gl.`
- `Pipeline`
- `WebGLRenderer`

## Mechanical Replacements

| Phaser 3 | Phaser 4 |
|----------|----------|
| `setTintFill(color)` | `setTint(color).setTintMode(Phaser.TintModes.FILL)` |
| `Math.PI2` | `Math.TAU` |
| `Math.TAU` (was PI/2) | `Math.PI_OVER_2` |
| `setPipeline('Light2D')` | `setLighting(true)` |
| `Phaser.Struct.Set` | native `Set` |
| `Phaser.Struct.Map` | native `Map` |
| `Phaser.Geom.Point` | `Phaser.Math.Vector2` |
| `BitmapMask` | `sprite.filters.internal.addMask(maskObj)` |

These are good codemod candidates, but still review call sites for behavior assumptions.

## Behavioral Review Required

### `Math.TAU`

In Phaser 3, `Math.TAU` effectively matched `PI / 2`.
In Phaser 4, `Math.TAU` is actual tau: `PI * 2`.

If old code used `TAU` for quarter turns, replace it with `Math.PI_OVER_2`.

### `ColorMatrix`

Color methods moved under the `colorMatrix` property.

```ts
// old
colorMatrix.sepia();

// new
colorMatrix.colorMatrix.sepia();
```

### `DynamicTexture` and `RenderTexture`

Buffered drawing now requires explicit `render()` execution. If a ported effect appears blank or stale, check whether the commands are queued but never rendered.

### `TileSprite`

Texture cropping support is gone. If the old implementation depended on cropped repetition, redesign it instead of trying to force the old pattern back in.

### Camera Internals

Standard camera properties usually port cleanly. Direct matrix work does not. Any code that reads or mutates camera matrices needs a focused review.

Camera matrix split:
- `Camera#matrix` = rotation + zoom + scroll (no position)
- `Camera#matrixExternal` = position only
- `Camera#matrixCombined` = both

### `roundPixels`

Phaser 4 defaults `roundPixels` to `false` (was `true` in v3). If pixel art feels off after migration, review this setting. Use `vertexRoundMode` per-object for finer control.

## Architectural Rewrite Areas

### FX and Masks

Phaser 4 unifies FX and masks into filters.

- `BitmapMask` is removed in WebGL paths.
- `preFX` and `postFX` assumptions no longer apply.
- Some old FX are now actions or new game objects:
  - `Bloom` → `Actions.AddEffectBloom()`
  - `Shine` → `Actions.AddEffectShine()`
  - `Circle` → `Actions.AddMaskShape()`
  - `Gradient` FX → `Gradient` game object

If a scene relies on layered masking, post-processing, or filter order, plan dedicated time for it.

### Custom Pipelines and Renderer Internals

Phaser 4 replaces the v3 pipeline model with render nodes. If the project touched custom pipelines, internal renderer buffers, or direct WebGL state, expect redesign work rather than patching.

Register custom render nodes at boot via `RenderConfig#renderNodes`.

### Shaders and Texture Orientation

Phaser 4 uses GL-style texture orientation (Y=0 at bottom). Custom shader work must be re-checked with that assumption. Compressed textures may need to be regenerated with the correct Y-axis orientation.

### `Shader` Game Object

Constructor signature changed: now takes a `ShaderQuadConfig` config object instead of individual parameters. Shadertoy-style uniforms (resolution, time) are no longer set automatically.

## Removed Items — No Replacement Needed

- `Mesh` and `Plane` game objects (removed; 3D support planned separately)
- Camera3D Plugin, Layer3D Plugin
- `Create.GenerateTexture`, `TextureManager.generate`
- `Math.SinCosTableGenerator`
- All legacy polyfills (Array.forEach, Array.isArray, console, Math.trunc, etc.)
- `phaser-ie9.js` entry point
- Bundled Spine 3 / Spine 4 plugins → use Esoteric Software's official plugin

## Recommended Migration Order

1. Update package version and type surfaces.
2. Fix obvious compile errors from removed APIs.
3. Audit renderer, filter, shader, lighting, and texture workflows.
4. Re-test visuals before optimizing performance.
5. Only then consider GPU-layer upgrades or visual enhancements.

## What Not to Do

- Do not rewrite everything before classifying the migration risks.
- Do not assume passing TypeScript means rendering is correct.
- Do not debug masks, shaders, and compressed textures as if Phaser 3 internals still apply.
