# Inference recipes (what to compute, and how to avoid lying)

This guide is about *deriving* useful runtime facts from `.ase`/`.aseprite` files, without pretending the file said more than it did.

## 1) Effective timeline

Goal: `frameMs[]` and `totalMs`.

Algorithm:
- Start with per-frame `durationMs`.
- If a frame duration is `0`, replace it with `header.speedDeprecatedMs` (compat fallback).
- `totalMs = sum(frameMs)`.

Output tip:
- Store both `rawDurationMs` and `effectiveDurationMs` if you’re debugging timing issues.

## 2) Layer paths (hierarchy)

Layer chunks include `childLevel`, which encodes indentation relative to previous layers.

Practical inference:
- Maintain a stack of layer names by child level.
- Create `layerPath = "Group/Subgroup/Layer"` as a stable identifier.

Don’t:
- Don’t assume groups are “folders” for rendering; group blend/opacity rules depend on header flags.

## 3) Render order (z-index)

Layer order is the order of layer chunks in the file (layer indices).

Cel z-index:
- Each cel has a `zIndex` which shifts it forward/back relative to its layer index.
- If you need deterministic ordering for a frame, sort by:
  1) `layerIndex + zIndex`
  2) `zIndex` (tie-break)

## 4) Tight bounds per frame (pixels)

When to do this:
- Packing spritesheets
- Hit-testing
- Reducing overdraw

How:
- Decode cel images (type 2) with zlib.
- For RGBA/Grayscale: a pixel is visible if `alpha > 0`.
- For Indexed: a pixel is visible if `index != transparentIndex` (header). If your pipeline historically treats index 0 as transparent too, record that as a heuristic.
- A cel’s local bounds (min/max) + its `(x,y)` becomes bounds in sprite space.
- Frame bounds are the union across visible layers/cels.

Truthfulness:
- Output a note if bounds came from pixel decode vs from widths/heights only.

## 5) Linked cels

Linked cels don’t carry their own pixels.

Post-pass:
- If cel type is linked, look up the referenced frame’s cel for the same layer index.
- Reuse decoded bounds/dimensions from the target if available.

## 6) Tags -> runtime clips

Tags chunk defines:
- `from`, `to` frame indices
- direction: forward/reverse/ping-pong variants
- repeat count

In runtime JSON:
- Emit clips like `{name, from, to, direction, repeat, frameMs[] subset }`.

## 7) Slices -> hitboxes/anchors

Slices have keys that become active “from this frame onward”.

Inference pattern:
- Convert to per-frame slice bounds by carrying forward the latest key <= frame index.
- If pivot exists, use it; otherwise choose an explicit fallback (center, bottom-center, etc.) and record that it’s a fallback.

## 8) Tilemaps

Tilemap cels decode to a tile stream, not pixels.

Useful inference:
- Count unique non-zero tile IDs used in a frame/tag.
- Track flip usage; treat flip bits separately from tile ID (`tileId = tileVal & idMask`).

Avoid:
- Don’t treat tile ID 0 as empty unless the tileset flag indicates that convention (tileset flags mention empty-tile semantics).
