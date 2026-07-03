# Prebuilt 3D game modules

A deliberately small set of TypeScript modules for the parts of a 3D browser game that are **hard to get right and the same across games**. Copy them into the project (they're TS, matching our Vite games) instead of re-deriving the math.

Everything else — camera rigs, enemy waves, pathfinding, steering, minimaps, input schemes — is intentionally **not** here. Those differ per game and are cheap to write; generate them live against the `references/`, tailored to what you're building. Don't reach for a generic module where a 20-line game-specific version is clearer.

> Approach inspired by [GameBlocks](https://github.com/xt4d/GameBlocks). These are fresh TypeScript reimplementations, not a port.

## What's here

| File                    | What it owns                                                                                                                                                                                                                                       | Why it's prebuilt                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `math.ts`               | `clamp`/`lerp`/`toRadians`, framerate-independent smoothing (`smoothingAlpha`, `smoothToward`), and a deterministic seedable PRNG (`Random`).                                                                                                      | A constant per-frame `lerp` alpha is secretly framerate-dependent; `Math.random()` can't seed. Both bite you late.     |
| `character-movement.ts` | Y-up orientation-frame helpers (`yawPitchToForward`, `yawToRight`, `orientationFrame`, `forwardToYaw`) + a `CharacterController` for grounded locomotion (accel/decel smoothing, sprint/crouch, gravity, jump, ceiling/landing velocity handling). | Axis conventions get inverted when re-derived from prose; the jump/land velocity-cancel edge cases get forgotten.      |
| `kinematic-resolver.ts` | `KinematicResolver` — wraps Rapier's `KinematicCharacterController` (collider offset, autostep, snap-to-ground, grounded shapecast probe, kinematic translation) and resolves many actors per step.                                                | This is the single fiddliest thing to wire up in a 3D game, and getting it subtly wrong looks like "physics is janky". |

All three are Y-up / -Z-forward (Three.js canonical). No coordinate-basis abstraction — if you genuinely need Z-up, adapt the frame helpers in `character-movement.ts`.

## How they fit together

```ts
import { CharacterController } from "./modules/character-movement";
import { KinematicResolver } from "./modules/kinematic-resolver";

const resolver = new KinematicResolver(world, RAPIER); // world + rapier are yours, already initialized
const actor = resolver.createActor({
  position: new Vector3(0, 1, 0),
  colliderShape: { type: "capsule", halfHeight: 0.5, radius: 0.4 },
  controllerOptions: { snapToGround: 0.2 },
  groundedProbeDistance: 0.1,
});
const controller = new CharacterController();
controller.setState({ position: new Vector3(0, 1, 0) });

// per fixed-timestep tick:
resolver.beginFrame();
const intent = controller.plan({ moveDirection, deltaSeconds }); // moveDirection: world-space, from your input
resolver.queueMove(actor, intent);
resolver.resolveQueuedMoves(deltaSeconds);
const state = controller.commit(intent, resolver.getResult(actor) ?? undefined);
// state.position / state.frame drive the mesh + camera
```

Without physics, skip the resolver and `controller.commit(controller.plan({ ... }))` — the controller integrates gravity and jumps ballistically on its own.

Rapier is never imported here; you pass the initialized module and world in (see `references/physics.md`). In a Vite project `three` resolves from npm; imports are extensionless by design.

## When you DON'T need these

Showcases, product viewers, and anything without a character that walks and collides don't need the resolver or controller. `math.ts` is useful almost anywhere (smoothing, deterministic rolls). Reach for only what the game actually uses.
