# Prebuilt 3D Game Modules

Copy-verbatim ES modules for 3D browser games. Each module is a small, self-contained implementation with unambiguous spatial semantics — **copy the file into the game project instead of re-deriving the math from prose**. Retyping motion/camera code is how inverted axes, wrong-handed rotations, and unstable smoothing sneak in.

Adapted from [GameBlocks](https://github.com/xt4d/GameBlocks) (MIT, see `LICENSE` in this directory), renamed to dash-case with imports updated.

## How to use

1. **Declare the basis once.** `math/world-basis.js` is the single source of truth for which world axes mean right/up/forward, rotation handedness, and yaw math. The default is Three.js-canonical (+x right, +y up, −z forward). Every other module takes a `basis` and defaults to `DEFAULT_WORLD_BASIS` — don't hand-roll axis math alongside it.
2. **Pick modules from the catalog below**, copy them into the project **preserving this directory layout** (e.g. `src/modules/camera/base-camera-rig.js`) so relative imports resolve. Copy a module's dependencies too — the dependency column lists them.
3. **Adopt or adapt.** If a module fits, use it unchanged. If it almost fits, copy it and make the minimal edit — don't rewrite an equivalent from scratch.
4. **Record what you used** in a `modules-usage.md` at the project root: which modules, unchanged or adapted, and what you changed. This makes later debugging ("is the camera rig broken or misused?") tractable.

**Imports:** modules import bare `'three'`. In a Vite project this resolves from npm automatically. In a no-build HTML page, add an import map before the module script:

```html
<script type="importmap">
  { "imports": { "three": "https://unpkg.com/three@0.160.0/build/three.module.js" } }
</script>
```

Rapier is never imported — `kinematic-batch-resolver.js` takes the initialized `world` and `rapier` namespace as constructor arguments (see `references/physics.md` for Rapier setup).

## Catalog

One line per module: what it owns. Dependencies are relative to this directory (`three` implied where noted).

### math/ (no dependencies on other modules)

| Module                  | Capability                                                                                                                                             | Deps               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `math/world-basis.js`   | Defines how gameplay directions map onto world axes; basis-aware planar math, yaw/pitch/roll frames, control-sign lookup, surface normals from slopes. | three              |
| `math/scalar-utils.js`  | Scalar helpers: `clamp`, `lerp`, `toRad`, and framerate-independent smoothing (`smoothingAlpha`, `smoothToward`).                                      | —                  |
| `math/vector3-utils.js` | Normalizes loose `{x,y,z}` inputs into safe `Vector3`s and basis-aware planar unit directions.                                                         | three, world-basis |
| `math/random-utils.js`  | Deterministic seedable PRNG with `uniform`, `randint`, `randrange`, `choice` — use instead of `Math.random()` for replayable/testable behavior.        | —                  |
| `math/time-utils.js`    | Clock with system or manual mode — drive it manually in tests and fixed-timestep sims.                                                                 | —                  |

### actor-motion/

| Module                                                                   | Capability                                                                                                                                                                                                                  | Deps                             |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `actor-motion/kinematic-batch-resolver.js`                               | Resolves many kinematic movement requests through Rapier collision in one pass and returns grounded/collision outcomes per actor. Actor-vs-actor modes: `ignoreActors`, `startPositions` (order-independent), `sequential`. | three, math/\*, Rapier passed in |
| `actor-motion/character/base-character-motion-controller.js`             | Shared grounded locomotion: velocity smoothing, sprint/crouch/jump, gravity, yaw/pitch clamping, resolver intent creation, and commit. Not used directly — extend or use a concrete controller below.                       | three, math/\*                   |
| `actor-motion/character/world-target-character-motion-controller.js`     | Click-to-move: converts world-space move/face target points into locomotion. Pair with `position-follow-camera-rig`.                                                                                                        | base controller                  |
| `actor-motion/character/world-cardinal-character-motion-controller.js`   | World-axis movement (left/right/forward/backward + rotateCCW/CW) — top-down and 8-way games.                                                                                                                                | base controller                  |
| `actor-motion/character/heading-relative-character-motion-controller.js` | Tank-style: forward/strafe/turn relative to the character's own heading. Pair with `pose-follow-camera-rig`.                                                                                                                | base controller                  |
| `actor-motion/character/mouse-look-character-motion-controller.js`       | FPS-style: WASD + mouse-look yaw/pitch deltas. Pair with `first-person-camera-rig` and pointer lock.                                                                                                                        | base controller                  |

Controller loop shape (with physics): `planMovement({...inputs, deltaSeconds})` → intent → `resolver.queueMove(actor, intent)` → `resolver.resolveQueuedMoves(dt)` → `controller.commitMovement(intent, resolver.getResult(actor))`. Without physics, pass `commit: true` to `planMovement`.

### behavior/

| Module                                  | Capability                                                                                                                     | Deps           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| `behavior/nearby-avoidance-steering.js` | Steers an actor away from nearby agents while preserving intended travel direction; reports blockers. For crowds/enemy swarms. | three, math/\* |
| `behavior/grid-path-planner.js`         | A\* pathfinding and flood fill on a grid board with blocked cells and wrapping or bounded edges. Standalone (no three).        | —              |

### camera/

| Module                                 | Capability                                                                                                                                          | Deps           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `camera/base-camera-rig.js`            | Base smoothing + basis-aware pose behavior for the concrete rigs; applies poses to a Three.js camera. Not used directly.                            | three, math/\* |
| `camera/position-follow-camera-rig.js` | Follows a target position with fixed world offset and viewing angle — top-down, isometric, click-to-move games.                                     | base rig       |
| `camera/pose-follow-camera-rig.js`     | Follows position _and_ orientation with pose-relative offsets — third-person chase camera that turns with the target; optional speed-based offsets. | base rig       |
| `camera/first-person-camera-rig.js`    | Actor-locked first-person view from eye height and the controller's view frame.                                                                     | base rig       |
| `camera/look-offset-camera-rig.js`     | Temporary free-look rotation around a target that recenters when look input stops — right-stick/middle-mouse orbit peek.                            | base rig       |

Rigs are stepped once per frame: `rig.step({ targetPosition, ..., deltaSeconds, camera })` — pass the camera and the rig applies the pose.

### gameplay/

| Module                            | Capability                                                                                                                                                                       | Deps    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `gameplay/wave-spawn-director.js` | Schedules and spawns enemy waves: size growth, per-wave type unlocks, weighted type selection, wave completion when spawns are exhausted and active units reach zero, and reset. | math/\* |

### user-interface/

| Module                                   | Capability                                                                                                                                     | Deps    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `user-interface/minimap-projector-2d.js` | Maps world-space positions and headings into minimap pixel coordinates from planar bounds; standalone projection math for canvas/DOM minimaps. | math/\* |

## More upstream

GameBlocks has more modules that were not vendored yet (arcade + dynamic Rapier car physics with drifting, fixed-wing flight, waypoint AI drivers, combat/race/snake game-state owners, procedural terrain samplers with matching colliders, HUD/radar renderers). If a game needs one, fetch it from the upstream repo, apply the same dash-case rename + import fixups, and add it to this catalog.
