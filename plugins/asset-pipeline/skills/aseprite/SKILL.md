---
name: aseprite
description: "Infer structure/metadata from Aseprite files (.ase/.aseprite; common typo .aes): parse headers/frames/chunks (layers, cels, tags, slices, palettes, tilesets), compute durations/bounds, and generate JSON for engines/tools."
---

# Aseprite Inference

An `.ase`/`.aseprite` file is a structured timeline of layered pixel (or tilemap) cels. Read and verify the file rather than hard-coding expectations; output what you know _and_ what you assumed.

**Before inferring, ask:**

- Authoring intent (tags/slices/user data) or render intent (visible pixels/bounds/ordering)?
- Do you need pixels (decompress cel images), or is structure-only (layers/timing/tags) enough?
- Is the sprite RGBA / Grayscale / Indexed / Tilemap — and does that change transparency/bounds logic?

**Core principles**

1. **Chunk-driven:** skip unknown chunks by `chunk_size`, don't crash.
2. **Per-frame timing:** `header.speed` is deprecated; each frame has its own duration (fallback to speed only when a frame duration is 0).
3. **Separate decode modes:** fast metadata pass first; pixel/tile decode only when needed.

## Quick Start

Turn a file into JSON (shebang is `#!/usr/bin/env python3`):

```bash
python3 .claude/skills/aseprite/scripts/aseprite_inspect.py path/to/sprite.aseprite --json
```

Opt into pixel-derived inference (e.g. tight bounds):

```bash
python3 .claude/skills/aseprite/scripts/aseprite_inspect.py path/to/sprite.aseprite --json --decode-cels
```

## What You Can Infer Reliably

Structure-only: frame count + per-frame durations + total timeline; layer hierarchy (child levels), blend modes, opacities, flags, optional UUIDs; per-frame/per-layer cel placement, linked cels, z-index, opacity; tags (ranges + direction/repeat); slices (frame-keyed rects, optional 9-slice + pivot); tilesets/tilemaps (tile dims, count, masks with ID + flips); palettes + transparency index; user data on layers/cels/tags/tilesets.

With `--decode-cels`: tight per-cel/frame bounds (non-transparent extents), empty-frame detection, sprite-sheet packing hints.

## Common Workflows

### 1) Build engine metadata (JSON)

Inspect structure-only, add `--decode-cels` if you need tight bounds. Emit `frames[]`, `layers[]`, `tags[]`, `slices[]`, normalized `frameMs[]`. For deterministic render order use z-index rules (cel header) + layer ordering. For character grounding, emit authoring anchors (slice/pivot/user-data) but validate final foot placement against exported PNG alpha bounds (via `asset-pipeline`) before locking runtime offsets.

### 2) Debug "why is this invisible?"

Check layer visibility + opacity; whether a cel is **linked** to another frame; for indexed sprites, the transparent index + background-layer semantics.

### 3) Convert slices to hitboxes/anchors

Use slice keys per frame for runtime hitboxes. Use pivot when present; otherwise infer (e.g. slice center) and record it as a fallback.

## Anti-Patterns

- **"speed" is authoritative** — it's deprecated; frame duration is the timeline. Apply the speed fallback only when a frame duration is 0.
- **Palette always exists / always 256 entries** — parse palette chunks when present; indexed sprites still need transparency-index handling.
- **Hard-failing on unknown chunks** — skip by chunk size; store a summary for debugging.
- **Decompressing everything by default** — decode only what you need; cap large sprites.
- **Treating indexed pixels as RGBA** — they're palette indices; transparency is by transparent index (header). Only map to RGBA once you've parsed a palette (and record missing-palette cases).
- **Ignoring linked cels** — you'll lose frames or infer empty bounds. Resolve links in a post-pass before pixel/bounds inference.
- **Assuming UI grouping equals render grouping** — group compositing depends on header flags + blend/opacity validity. Treat groups as structural unless building a renderer.
- **Conflating authoring vs render intent** — tags/slices/user data describe intent, pixels describe appearance; they can disagree. Output both, don't "correct" one with the other unless asked.

## References & Scripts

- `scripts/aseprite_inspect.py` — binary parser + JSON; optional cel/tile decode
- `references/aseprite-format-cheatsheet.md` — chunk map + gotchas
- `references/inference-recipes.md` — how to compute bounds/timing/order safely
