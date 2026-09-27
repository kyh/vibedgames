# Three.js Animation Index Pattern

Decouple UI/logic from raw GLB clip names via a JSON index contract.

## Contract Shape

Character entry with:

- `skeleton.url`
- `animationSource.url`
- `animations[]` — each `{ id, displayName, sourceClipName, loop }`
- `defaults.defaultAnimationId`
- `defaults.crossFadeSec`

## Runtime Pattern

1. `fetch('/assets/assets_index.json')`
2. Resolve `characters.<characterId>`
3. Load skeleton GLB with `GLTFLoader`
4. Load animation GLB with `GLTFLoader`
5. Build `AnimationMixer` from skeleton root
6. For each `animations[]` entry: find `AnimationClip` by exact `sourceClipName`, create action + apply loop mode, add button that plays by `id`
7. Start default animation id

## Required Assertions

Validate at startup, failing loudly with clear messages: index contains the target character; `animations[]` is non-empty; every `sourceClipName` resolves to a clip; default animation id exists (or safe fallback).

## Loop Mode Mapping

- `repeat` → `THREE.LoopRepeat`
- `once` → `THREE.LoopOnce` (+ `clampWhenFinished = true`)
- `pingpong` → `THREE.LoopPingPong`

## UI Rule

Generate animation buttons from JSON, not hardcoded arrays — keeps runtime aligned with asset updates.
