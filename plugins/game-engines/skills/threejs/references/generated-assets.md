# Generated Assets in a Running Game

Generation and integration are separate concerns. **Generate to disk, then load like any other asset.** This reference closes the loop the generate skills stop at: a GLB or a sound effect that's actually loaded, placed, collidable, and triggered by gameplay.

For choosing endpoints and writing prompts, use the generate skills (`model-catalog`, `character-design`, `regenerate-3d`, `media-workflow`). This file is only about getting the output *into the scene*.

---

## Generated GLB → playable entity

### 1. Generate to disk

3D generation is slow (1–5 min) — always async, then poll. Endpoint selection lives in the `model-catalog` skill (`text-to-3d` / `image-to-3d`); IDs are passed through verbatim.

```bash
SUBMIT=$(vg generate run fal-ai/meshy/v6/text-to-3d \
  --prompt "a low-poly treasure chest, game asset, clean topology" \
  --async --json)
REQ=$(echo "$SUBMIT" | jq -r '.request_id')

vg generate status fal-ai/meshy/v6/text-to-3d "$REQ" \
  --download "./public/models/chest.{ext}" --json
```

### 2. Load + normalize + collide

A generated mesh arrives at an arbitrary scale and origin. Normalize it to a target world height and recenter before placing — otherwise it's a kilometer wide or buried in the floor. (Full loader/cache patterns: [`gltf-loading-guide.md`](gltf-loading-guide.md).)

> **Static props only.** On a rigged/skinned model, `Box3.setFromObject` measures the **bind-pose** bounds (the geometry's rest-pose box, transformed by the mesh's world matrix), which don't match the animated pose — so `box.min.y` often sits below the visible feet and the character **floats**. (Bones themselves have no geometry and don't contribute.) For rigged/animated GLTFs, use the mesh-only normalization (Pattern 6) in [`gltf-loading-guide.md`](gltf-loading-guide.md) instead.

```javascript
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const loader = new GLTFLoader();

function loadNormalized(url, targetHeight = 2) {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        const model = gltf.scene;

        // measure, then scale to target height
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        // guard a flat/degenerate mesh (size.y === 0) → no Infinity/NaN scale
        const scale = size.y > 1e-6 ? targetHeight / size.y : 1;
        model.scale.setScalar(scale);

        // recenter so the model sits on y=0 at its own origin
        box.setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.position.x -= center.x;
        model.position.z -= center.z;
        model.position.y -= box.min.y;

        // re-measure AFTER the offsets so the returned box reflects final bounds
        box.setFromObject(model);
        resolve({ model, animations: gltf.animations, box });
      },
      undefined,
      reject,
    );
  });
}
```

### 3. Attach a collider sized to the model — not the model mesh

Use the measured bounds to build a *primitive* collider. A capsule/box collider is far cheaper and more stable than colliding against the GLB's triangle mesh, and players can't feel the difference.

```javascript
const { model } = await loadNormalized("/models/chest.glb", 1.2);
// keep loadNormalized's y (it grounds the mesh bottom on y=0); only pick x/z
model.position.x = spawnX;
model.position.z = spawnZ;
scene.add(model);

// Re-measure the WORLD AABB at the final position, then place the collider at
// its center. Don't reuse model.position — loadNormalized offsets it to recenter
// the mesh, so it isn't the model's visible center.
const worldBox = new THREE.Box3().setFromObject(model);
const half = worldBox.getSize(new THREE.Vector3()).multiplyScalar(0.5);
const center = worldBox.getCenter(new THREE.Vector3());
// Rapier static collider sized to bounds (see physics.md)
world.createCollider(
  RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(
    center.x,
    center.y,
    center.z,
  ),
);
```

For animated characters, **don't normalize with `loadNormalized`** (its `setFromObject` bounds include the skeleton — see the note above); use the mesh-only normalization in `gltf-loading-guide.md` (Pattern 6), then keep `gltf.animations` and drive them with the mixer/crossfade patterns in `game-patterns.md`. For a full rigged-character generation pipeline, use the `regenerate-3d` skill.

### 4. Validate rigged GLBs before wiring them in

Auto-rigged models come back **silently degenerate** more often than broken: the file loads, the mesh renders, but the rig has one arm and no legs, or a clip has 3 tracks and holds the bind pose forever. Check before spending an hour debugging "the animation doesn't play":

```javascript
// Log clip names + track counts — a walk cycle on a humanoid has dozens of
// tracks; a clip with a handful of tracks is frozen at bind pose. Reject it.
console.log(gltf.animations.map((c) => `${c.name}: ${c.tracks.length} tracks, ${c.duration.toFixed(2)}s`));

// Log the skeleton — a humanoid rig missing leg/arm bones animates as a lump.
gltf.scene.traverse((o) => {
  if (o.isSkinnedMesh) console.log(o.name, o.skeleton.bones.map((b) => b.name));
});
```

If a clip is degenerate, regenerate the asset — don't try to fix the rig in code. And don't trust vendor "in-place" flags: if a walk clip slides the root across the world, strip/ignore the root bone's translation track in-engine rather than re-generating with a different flag.

### Hero vs procedural: don't generate 40 GLBs

Generate **one hero-fidelity asset per key entity** (player, boss, signature prop) and build high-volume repeated detail — crates, rocks, debris, background silhouettes — from primitives and `InstancedMesh` (see `advanced-topics.md`). Forty unique generated GLBs blow the download size, the texture budget, and the draw-call budget at once, and background props read fine as instanced primitives with good materials.

---

## Generated SFX → Web Audio triggers

Three.js's `PositionalAudio` is fine for spatial ambience, but for gameplay SFX (jump, hit, pickup) a small Web Audio pool gives lower latency and lets you overlap the same sound.

### 0. Plan the audio pass as a matrix, not a wishlist

Before generating anything, list events by category — it surfaces what's missing (a game with hit sounds but no pickup sound feels broken) and tells you what loops:

| Category    | Events                        | Count | Loops? | Mix note                          |
| ----------- | ----------------------------- | ----- | ------ | --------------------------------- |
| UI          | click, confirm, back          | 1 ea  | no     | quieter + shorter than gameplay SFX |
| Movement    | jump, land, dash, footstep    | 1–2 ea| no     | footsteps need a cooldown         |
| Interaction | pickup, door, switch          | 1 ea  | no     | —                                 |
| Threat      | enemy hit, player hit, explosion | 2–3 variants ea | no | the sounds that must land hardest |
| Ambience    | wind/room tone, music         | 1 ea  | YES    | low volume, ducks under SFX       |

Rules that keep it from sounding cheap:

- **High-frequency events get a variant pool + cooldown.** For footsteps/rapid fire, generate 2–3 variants and round-robin them, and rate-limit (~80ms) so overlaps don't comb-filter. ±5% rate variation (below) is the floor, not the fix.
- **Test loops looping.** A generated "loop" usually has a click at the seam. Play it twice back-to-back in-engine before accepting it.
- **Don't stack loops on restart.** Ambience/music started in `init()` plays twice after a restart. Keep a handle to the looping source and stop it (or guard with an `isPlaying` flag) before starting again.

### 1. Generate

```bash
vg generate run fal-ai/elevenlabs/sound-effects \
  --prompt "short metallic coin pickup chime, retro game" \
  --download "./public/sfx/pickup.mp3" --json
```

### 2. Load + decode once, trigger many

```javascript
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const buffers = new Map();

async function loadSfx(name, url) {
  const data = await fetch(url).then((r) => r.arrayBuffer());
  buffers.set(name, await audioCtx.decodeAudioData(data));
}

function playSfx(name, { volume = 1, rate = 1 } = {}) {
  const buffer = buffers.get(name);
  if (!buffer) return;
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate; // vary ±5% per hit to avoid machine-gun sameness
  const gain = audioCtx.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(audioCtx.destination);
  src.start(); // AudioBufferSourceNodes are one-shot; create a new one each call
}

// wire to gameplay (in fixedUpdate / collision handler):
if (collected) playSfx("pickup", { rate: 0.95 + Math.random() * 0.1 });
```

### 3. The mobile gesture-unlock dance (required)

Browsers start the `AudioContext` **suspended** until a user gesture. Resume on the first input or nothing plays on mobile and you'll waste an hour debugging silence:

```javascript
function unlockAudio() {
  if (audioCtx.state === "suspended") audioCtx.resume();
  window.removeEventListener("pointerdown", unlockAudio);
  window.removeEventListener("keydown", unlockAudio);
}
window.addEventListener("pointerdown", unlockAudio);
window.addEventListener("keydown", unlockAudio);
```

Randomizing `playbackRate` ±5% per trigger is the cheapest way to stop repeated SFX from sounding robotic. For music and ambience loops, `model-catalog` (`text-to-audio`) and `media-workflow` cover generation; loop them with a separate looping `BufferSource` (`src.loop = true`).

---

## Checklist

- [ ] Models generated `--async`, polled, downloaded to `public/` (not generated at runtime).
- [ ] Every loaded model normalized to a target height and recentered onto y=0.
- [ ] Rigged GLBs validated before wiring: clip track counts logged, degenerate clips rejected.
- [ ] One hero GLB per key entity; repeated props are primitives/instances, not more GLBs.
- [ ] Colliders are primitives sized to bounds, not the GLB triangle mesh.
- [ ] SFX decoded once, played via fresh `BufferSource` per trigger.
- [ ] `AudioContext` resumed on first gesture (mobile silence guard).
- [ ] Repeated SFX get ±5% rate variation; high-frequency SFX get variant pools + cooldowns.
- [ ] Loops tested at the seam; no duplicate ambience loops after restart.
