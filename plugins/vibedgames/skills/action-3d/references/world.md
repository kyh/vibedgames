# Collision and the world

## What is drawn is what collides

- **One source for both.** Render meshes and colliders come from the same
  placements and transforms and change together; a prop moved in one is moved
  in the other.
- **Both ways**: nothing drawn solid lets a body or a shot through, nothing
  undrawn stops either, what you can see through you can shoot through, and
  any edge or ceiling the player reaches shows what stops them.
- **Separate body and shot shapes.** A simple capsule-friendly hull for
  movement; tighter shapes for hits.
- **Pipelines fail closed.** No LOD switch, triangle budget or failed asset
  load removes a collider without a count. Report fallback colliders per map
  and gate on them.
- **Art passes leave gameplay alone.** Collision, spawns, perches, lanes and
  floor heights are identical before and after a visual pass, and dressing
  stays out of every opening, lane and landing. Diff them.

## Bodies fit the world

- The player's capsule is sized to the world: doorways, steps, ledges and
  cover all work at their drawn scale.
- Every opening meant to be passable is passable standing, at walking speed,
  by the largest body that uses it. Low clearance blocks rather than forcing
  a crouch.
- **Stairs climb holding forward only**: no jump, snag, oscillation or launch;
  step height (~0.3–0.45 m for a 1.8 m body) handled by the controller's
  step-up, and no side entry onto a staircase.
- **Step over what a person steps over**: small debris is not a wall, and no
  gap narrower than a body holds anyone.

## The solver

- **No tunnelling** at the worst frame rate the game can run: continuous
  collision detection for fast bodies and shots, or sub-stepping.
- **Depenetrate gently**, back out the side the body entered, never
  teleported across the room.
- **Ground checks at the final position**, after every clamp and constraint.
- **Coyote time and jump buffering** (`game-feel`).
- **Ray and shape queries fit a per-frame budget** however many enemies there
  are; spread line-of-sight checks across frames.

## Bodies at rest

- Ragdolls fall with weight, come to rest on real geometry soon after, and
  never spin, launch, shake or float (cap angular velocity, add damping, sleep
  thresholds).
- Every corpse and piece of debris leaves within a fixed game-time deadline,
  and the number of simulated bodies has a hard cap.
