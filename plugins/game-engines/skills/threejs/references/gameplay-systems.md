# Three.js Gameplay Systems

The main skill builds scenes — meshes, lights, an animation loop. This guide makes a scene **playable**: a body that moves under input, collides with the world, a camera that follows it, and a loop that updates deterministically. It's the bridge from "rotating cube" to "game."

> **Copy the hard parts:** a grounded character controller and a Rapier character-collision resolver live in `modules/` (see `modules/summary.md`). Game-specific systems — waves, pathfinding, camera rigs — aren't prebuilt; generate them live from this guide.

**Build order (don't skip ahead):**

1. **Loop & structure first** — a fixed-timestep update and a clear file layout, before any feature.
2. **Movement** — a controller the player drives (transform-based or physics-based).
3. **Collision** — pick the lightest tool that gives the feel you want (arcade < cannon-es < Rapier).
4. **Camera** — follow/third-person with frame-rate-independent smoothing.
5. **Assets & feel** — load real models, wire SFX, then tune with the game-craft skills.

Pair this with the sibling references (`gltf-loading-guide.md`, `game-patterns.md`, `advanced-topics.md`) and the `game-feel` skill for tuning values — this guide is the _systems_, those are the _craft_.

---

## Fixed-timestep loop (do this first)

Physics and gameplay must advance in fixed steps, decoupled from render rate — otherwise behavior changes with FPS and collisions tunnel at low frame rates. Accumulate real time and step a fixed amount; render interpolated.

```javascript
import * as THREE from "three";

const clock = new THREE.Clock();
const STEP = 1 / 60; // fixed physics step
let accumulator = 0;

function fixedUpdate(dt) {
  // input → movement → physics step → collisions → game rules
  updateInput();
  controller.update(dt);
  stepPhysics(dt); // advance physics ONE fixed step — engine-specific signature:
  // Rapier: world.step()  (uses world.timestep) · cannon-es: world.step(dt). See physics.md.
  syncMeshesToBodies();
  gameRules(dt);
}

function frameUpdate(dt) {
  updateCamera(dt); // camera smoothing can run per-frame
  mixers.forEach((m) => m.update(dt)); // animation
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.25); // clamp tab-away spikes
  accumulator += dt;
  while (accumulator >= STEP) {
    fixedUpdate(STEP);
    accumulator -= STEP;
  }
  frameUpdate(dt);
  renderer.render(scene, camera);
});
```

**Why `Math.min(..., 0.25)`:** when a tab is backgrounded, `getDelta()` returns seconds of wall-clock. Without the clamp you'd run hundreds of physics steps in one frame on return — a freeze or a launched player. Clamp, then accumulate.

---

## File structure for a 3D game

A scene fits in one file; a game does not. Split by responsibility so update order stays explicit and systems don't reach into each other's internals:

```
src/
  main.js          # bootstrap: renderer, scene, camera, loop
  core/
    loop.js        # fixed-timestep accumulator (above)
    input.js       # keyboard/pointer/gamepad → intent (not movement)
    assets.js      # GLTF/audio loading + cache (see gltf-loading-guide.md)
    physics.js     # world creation, step, body registry
  entities/
    player.js      # mesh + body + controller
    enemy.js
  systems/
    camera.js      # follow/third-person rig
    collision.js   # contact events → game reactions
    spawning.js    # object pools (see game-patterns.md)
  game.js          # state machine: menu/play/pause/over (see game-patterns.md)
```

**Rule that prevents the most bugs: input emits _intent_, not motion.** `input.js` sets `intent.moveX`, `intent.jump`; the controller decides what that means this step. This keeps movement testable and lets touch controls (`gamepad` skill) and AI drive the same controller.

---

## Choosing a physics approach

Don't reach for a full engine by default — match the tool to the feel you need. Full decision table and recipes in [`physics.md`](physics.md).

| Approach                                 | Use when                                                                                                                       | Cost                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| **Arcade / custom**                      | Pickups, triggers, platformers where _authored feel_ beats realism. Sphere/AABB overlap checks, manual gravity.                | Lowest — no dependency                 |
| **cannon-es**                            | Light rigid-body needs, a few dozen dynamic bodies, pure-JS simplicity.                                                        | ~Medium, JS-speed                      |
| **Rapier** (`@dimforge/rapier3d-compat`) | The default for _serious_ 3D games — stable stacking, many bodies, a real kinematic character controller, raycasts. WASM-fast. | Needs `await RAPIER.init()` before use |

A common mistake is simulating things that want authored feel (a coin you walk through, a jump height you tuned by hand) with a physics engine and fighting it. Triggers and pickups → overlap checks. Stacking crates, ragdolls, vehicles → Rapier.

---

## Controllers & camera

A responsive controller and a camera that never hides the next decision are most of "game feel" in 3D. Recipes — transform-based WASD, Rapier kinematic character controller (autostep, snap-to-ground), third-person follow with lookahead, and frame-rate-independent smoothing — in [`controllers-and-camera.md`](controllers-and-camera.md).

The one rule to internalize now — **frame-rate-independent smoothing.** `camera.position.lerp(target, 0.1)` moves faster at 144fps than 30fps. Make the factor depend on `dt`:

```javascript
// smoothing ∈ (0,1): fraction of distance REMAINING after 1 second. Lower = snappier.
const t = 1 - Math.pow(smoothing, dt);
camera.position.lerp(targetPos, t);
```

---

## Wiring in generated assets

Generated GLB models and sound effects only matter once they're _in the running game_ — loaded, scale-normalized, placed, collidable, and triggered by events. The generate skills produce the files; this closes the loop. See [`generated-assets.md`](generated-assets.md) for:

- `vg generate` → GLB → `GLTFLoader` → normalize scale → attach a collider sized to the model's bounds.
- `vg generate` → SFX/music → Web Audio buffer pool → trigger on collision/jump/pickup (with the gesture-unlock dance mobile requires).

Use the `model-catalog` skill to pick endpoints (text-to-3d / image-to-3d / text-to-audio) and `regenerate-3d` for rigged character pipelines. Keep generation and integration separate concerns: generate to disk, then load like any other asset.

---

## Anti-patterns

- **Variable-timestep physics** → behavior and jump height change with FPS; fast objects tunnel through walls. Use the fixed accumulator above.
- **`lerp` with a constant factor** → camera/movement speed scales with frame rate. Make it `dt`-dependent.
- **Reading keys directly in the controller** → can't test, can't share with touch/AI. Route through an intent object.
- **A physics engine for triggers/pickups** → fighting the simulation for authored feel. Use overlap checks.
- **Forgetting `await RAPIER.init()`** → `RAPIER.World is not a constructor`. The compat build is async; init once at boot.
- **Stepping the world per render frame, not per fixed step** → non-deterministic, FPS-dependent simulation. Step inside `fixedUpdate`.
- **Disposing a mesh but leaking its body/mixer** → physics keeps simulating ghosts; memory climbs. Remove body from the world and mixer from the update list when you remove the mesh (see `game-patterns.md`).

---

## See Also

- [`physics.md`](physics.md) — Rapier (rigid bodies, colliders, raycasts), cannon-es, arcade overlap, selection
- [`controllers-and-camera.md`](controllers-and-camera.md) — WASD & kinematic controllers, follow/third-person camera, smoothing
- [`generated-assets.md`](generated-assets.md) — generated GLB & SFX into a running scene
- [`gltf-loading-guide.md`](gltf-loading-guide.md), [`game-patterns.md`](game-patterns.md) (state machine, pooling, shake), [`advanced-topics.md`](advanced-topics.md), [`debugging-and-profiling.md`](debugging-and-profiling.md) — black-screen / frame-drop triage
- `game-feel`, `game-balance`, `level-design` skills — tuning values and design craft (engine-agnostic)
