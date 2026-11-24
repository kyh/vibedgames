---
name: regenerate-3d
description: "Build a 3D character-selector scene entirely from `vg generate` output: stylised characters, rigged GLBs, companions, floor textures, looped video backgrounds, palette swaps."
---

# regenerate-3d Skill

> **Runtime:** Asset generation steps use the `vg generate` CLI (image, 3D, video and material models); the final deliverable is a static HTML page with Three.js and the generated assets bundled in. The generation credentials live on the vibedgames server, so the only setup is a signed-in `vg`. If `vg` isn't on PATH or says you're not logged in, follow the `vg-setup` skill (no global install needed: `npx -y vibedgames@latest` stands in for `vg`). See the `generate` skill for the command reference — including its async-job recovery rule (keep the `request_id`, resume with `status`, never re-`run` after an ambiguous failure).

End-to-end recipe to ship a polished, multi-character 3D web experience using generative models.
It is a scene recipe, not the way to make a character: generating, rigging and animating one is the `3d.md` reference of the `model-catalog` skill, and this recipe runs exactly that path once per character.
This is the recipe that powers a cyberpunk character selector with 10 unique operatives, each with a matching companion creature, environment-themed floor texture, animated background and color palette.

## What it builds

For each character you get:

- A **stylized 3D character GLB** (rigged + animated, baked into the file)
- A **companion creature GLB** (small static, themed to match the character)
- A **per-character PBR floor** (basecolor / normal / roughness / metalness, all generated)
- A **looped video background** keyed to the biome
- A **3-color palette** that drives the whole UI (CSS custom properties)
- A **portrait crop** for the roster card

All packaged into a single static HTML page with a Three.js scene. ~25–35 MB of GLBs total after compression.

## Pipeline

```
1. Character image → full-body A-pose, per the riggable-character rules in
   model-catalog's 3d.md (default image model)
2. generate_3d (meshy/v7.1/image-to-3d, pose_mode: a-pose) → character mesh
3. generate_animate_3d (meshy/rigging/multi-animation) → rigged GLB + one GLB per clip
   (idle, alert, a dance, ...) on one skeleton
4. Image edit → companion creature, color-locked to the character palette
5. generate_3d → static companion GLB (not rigged)
6. fal-ai/patina/material/extract on the character image
   → basecolor + normal + roughness + metalness for the floor
7. Video from an image → 8 s background loop (default image-to-video model)
8. gltf-transform → resize 1024 → webp q80 → draco
   (typically 95–96% size reduction, ~400–800 KB final)
9. Three.js scene → MeshStandardMaterial floor with alphaMap circular cutout,
   mirrored reflection (refl.y = root.y, scale.y = -1),
   breathing animation on companions,
   per-character palette via CSS custom properties (--c1/--c2/--c3),
   per-character floor texture swap on character click,
   transition lines + radial flash on swap
```

Steps 1–3 and 5 are the same `vg generate` / MCP calls the `3d.md` reference shows; endpoints not named here are the model-catalog defaults.

## Generate at build time, never from the deployed page

Every generation step runs on your machine through `vg generate`, and the page ships the results as static files. A deployed game is untrusted code on its own subdomain: it gets no vibedgames session, and a `VG_TOKEN` (or any provider key) embedded in the page is a key every visitor can copy and spend.

For a create-your-own mode, pre-generate a pool of extra characters with the same pipeline (the same steps 1–3; check cost with `vg generate pricing <endpoint_id>`) and let visitors pick or shuffle through it.

## Endpoints only this recipe uses

| Step                    | Endpoint                         |
| ----------------------- | -------------------------------- |
| Per-character floor PBR | `fal-ai/patina/material/extract` |

Everything else (character image, 3D, rig and clips, companion edit, background video) runs on the model-catalog defaults, and its clip ids are in the `3d.md` reference.

## Three.js scene notes

- **Floor**: `PlaneGeometry(7, 7, 220, 220)` cut into a disc via radial-gradient `alphaMap`. High tessellation enables real `displacementMap` (uses basecolor as height).
- **Reflection**: clone of the root with `scale.y = -1`, `BackSide`, `depthWrite = false`, `renderOrder = -1`. For characters whose origin is at the feet, `refl.position.y = root.position.y` produces a visible mirror; the floor's `transparent = true; opacity ≈ 0.5` lets it bleed through.
- **Breathing**: per-frame `scale.setScalar(base * (1 + sin(t*1.3)*0.025))` + a small Y bob on companions. The reflection mirrors the bob so the mirror stays consistent.
- **Palette swap**: `:root.style.setProperty('--c1', hex)` etc. Every UI element (sparklines, pulses, bars, model pills, edge map dots) derives its color from `var(--c1)` / `var(--c2)`.
- **Normalisation**: Meshy vehicles/props come back facing ±X — yaw −π/2, scale by the length axis (not height), ground at y=0. Do it as a runtime `fit` per skin, not a bake, so a regenerated model drops in unchanged. Compress with `gltf-transform optimize in.glb out.glb --texture-compress webp --texture-size 1024`.
- **Floor swap**: `texLoader.load()` 4 PBR maps from `assets/floor/{charId}/`, dispose old textures, set `floorMat.color` back to white (since the basecolor is already char-themed).
- **Transition**: 9 diagonal lines sweep across the viewport (`@keyframes tfx-sweep`) on character click + a radial flash; bg video crossfades between two `<video>` elements; character GLB slides out and the new one slides in.

## Cost

Price a character before batching ten: `vg generate pricing <endpoint_id> --json` for each step. 3D and rigging dominate; the images, floor and video are cents. Runtime parallelizes well: the original 10-character set was generated in ~10 minutes wall-clock with 9 concurrent jobs per stage.
