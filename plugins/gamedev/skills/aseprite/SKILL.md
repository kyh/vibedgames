---
name: aseprite
description: "Infer structure/metadata from Aseprite files (.ase/.aseprite; common typo .aes): parse headers/frames/chunks (layers, cels, tags, slices, palettes, tilesets), compute durations/bounds, and generate JSON for engines/tools."
---

# Aseprite Inference

Understand `.ase`/`.aseprite` files as *structured timelines of layered pixel (or tilemap) cels*. This skill helps you **infer useful metadata** (animation timing, per-frame bounds, layer hierarchy, tags, slices, tilesets, palettes) and produce **engine-ready JSON** without guessing.

## Philosophy: Inference Over Assumption

An Aseprite file is "truth"; your code is the hypothesis. Prefer **reading and verifying** over hard-coding expectations.

**Before inferring, ask:**
- Am I after **authoring intent** (tags/slices/user data) or **render intent** (visible pixels/bounds/ordering)?
- Do I need **pixels** (decompress cel images), or is **structure-only** (layers/timing/tags) enough?
- Is the sprite **RGBA / Grayscale / Indexed / Tilemap** and does that change transparency/bounds logic?

**Core principles**
1. **Be chunk-driven:** unknown chunks are fine—skip by `chunk_size`, don't crash.
2. **Treat timing as per-frame:** `header.speed` is deprecated; each frame has its own duration (with compatibility fallback).
3. **Separate decode modes:** "fast metadata pass" first; pixel/tile decode only when needed.
4. **Make inference explicit:** output what you know *and* what you assumed (e.g., indexed transparency).

## Quick Start (Recommended)

Use the bundled inspector to turn a file into JSON you can reason about:

```bash
python3 .claude/skills/aseprite-inference/scripts/aseprite_inspect.py path/to/sprite.aseprite --json
```

If you need pixel-derived inference (e.g., tight bounds), opt in:

```bash
python3 .claude/skills/aseprite-inference/scripts/aseprite_inspect.py path/to/sprite.aseprite --json --decode-cels
```

## What You Can Infer Reliably

- **Animation structure:** frame count + per-frame durations + total timeline.
- **Layer model:** hierarchy (child levels), blend modes, opacities, background/reference flags, optional UUIDs.
- **Cel placement:** per-frame per-layer cels, linked cels, z-index adjustments, opacity.
- **Tags:** named animation ranges and playback direction/repeat behavior.
- **Slices:** frame-keyed rectangles; optional 9-slice centers and pivots (excellent for hitboxes/anchors).
- **Tilesets/tilemaps:** tile dimensions, tile count, tilemap masks (ID + flips).
- **Palettes:** indexed-color palette changes; transparency index from main header.
- **User data:** attached text/color/properties to layers/cels/tags/tilesets (when present).

When you **decode cel pixels**, you can additionally infer:
- **Tight bounds** per cel/frame (non-transparent extents).
- **Sparsity/empty frames** detection.
- **Heuristic sprite-sheet packing hints** (frame bounds sizes/variability).

## Common Workflows

### 1) Build engine metadata (JSON)
- Inspect (structure-only), then add decode if you need tight bounds.
- Prefer emitting: `frames[]`, `layers[]`, `tags[]`, `slices[]`, and a normalized `frameMs[]`.
- If you need deterministic render ordering, incorporate **z-index rules** (cel header) + layer ordering.
- For character grounding, emit authoring anchors (slice/pivot/user-data when present), but validate final foot placement against exported PNG alpha bounds (for example via `gamedev-assets`) before locking runtime offsets.

### 2) Debug "why is this invisible?"
- Verify layer visibility flags + opacity.
- Check if a cel is **linked** to another frame.
- For indexed sprites: verify transparent index + background layer semantics.

### 3) Convert slices to hitboxes/anchors
- Use slice keys per frame to generate runtime hitboxes.
- Use pivot when present; otherwise infer pivot (e.g., slice center) as a fallback.

## Anti-Patterns to Avoid

❌ **Anti-pattern: Assuming "speed" is authoritative**
Why bad: it's deprecated; frame duration is the real timeline.
Better: apply compatibility fallback only when a frame duration is zero.

❌ **Anti-pattern: Assuming palette always exists / always 256 entries**
Better: parse palette chunks when present; indexed sprites may still need transparency index handling.

❌ **Anti-pattern: Hard-failing on unknown chunks**
Better: skip by chunk size and keep going; store unknown chunk summaries for debugging.

❌ **Anti-pattern: Decompressing everything by default**
Better: decode only what you need; add safety limits for large sprites.

❌ **Anti-pattern: Treating indexed pixels as RGBA**
Why bad: indexed cel pixels are palette indices; transparency is usually by transparent index (header).
Better: keep "indexed" as its own path; only map to RGBA if you've actually parsed a palette (and record missing palette cases).

❌ **Anti-pattern: Ignoring linked cels**
Why bad: you'll "lose" frames or infer empty bounds incorrectly.
Better: do a post-pass that resolves links when you need pixel/bounds inference.

❌ **Anti-pattern: Assuming a layer's UI grouping equals render grouping**
Why bad: group compositing behavior depends on header flags and blend/opacity validity rules.
Better: treat groups as structural by default; only implement group compositing if you're building a renderer/exporter.

❌ **Anti-pattern: Conflating authoring intent with render intent**
Why bad: tags/slices/user data describe intent; pixels describe appearance. These can disagree.
Better: output both kinds of facts, and don't "correct" one with the other unless explicitly requested.

## Variation Guidance (Don't Converge)

- For game engines, vary output schema by need: minimal timing+tags vs full per-layer/per-cel metadata.
- For debugging, prefer "chunk dump" style outputs; for runtime, prefer compact normalized JSON.
- For tilemaps, vary between "tile usage summaries" and "full per-cell tile streams" based on target.

## References & Scripts

- Script: `scripts/aseprite_inspect.py` (binary parser + JSON; optional cel/tile decode)
- Reference: `references/aseprite-format-cheatsheet.md` (chunk map + gotchas)
- Reference: `references/inference-recipes.md` (how to compute bounds/timing/order safely)

## Remember

This domain rewards *precision*.
- Prefer outputs that are **explicit about assumptions** (e.g., indexed transparency handling, bounds derived from pixels vs dimensions).
- Claude Code is capable of building production-grade Aseprite tooling here: chunk-driven parsing + strict bounds checks + optional decode passes.

## Expectations

- Aim for parsers that are **robust to new chunk types** and **safe under malformed input**.
- Prefer "tell the truth" JSON over clever inference that can't be justified from file data.
