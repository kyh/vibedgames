# Three.js Animation Index Pattern

## Purpose

Decouple UI/logic from raw GLB clip names by using a JSON index contract.

## Contract Shape

Use a character entry with:
- `skeleton.url`
- `animationSource.url`
- `animations[]`
  - `id`
  - `displayName`
  - `sourceClipName`
  - `loop`
- `defaults.defaultAnimationId`
- `defaults.crossFadeSec`

## Runtime Pattern

1. `fetch('/assets/assets_index.json')`
2. Resolve `characters.<characterId>`
3. Load skeleton GLB with `GLTFLoader`
4. Load animation GLB with `GLTFLoader`
5. Build `AnimationMixer` from skeleton root
6. For each `animations[]` entry:
   - find `AnimationClip` by exact `sourceClipName`
   - create action and apply loop mode
   - add button that plays by `id`
7. Start default animation id

## Required Assertions

At startup, validate:
- index contains target character
- `animations[]` is non-empty
- every `sourceClipName` resolves to a clip
- default animation id exists (or safe fallback)

Fail loudly with clear error messages when contract is invalid.

## Loop Mode Mapping

Map string loop values to Three.js constants:
- `repeat` -> `THREE.LoopRepeat`
- `once` -> `THREE.LoopOnce` (+ `clampWhenFinished = true`)
- `pingpong` -> `THREE.LoopPingPong`

## UI Rule

Generate animation buttons from JSON, not hardcoded arrays.
This keeps runtime behavior aligned with asset updates.
