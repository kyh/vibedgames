# Characters, rigs and motion in 3D

Generating the mesh and clips: `model-catalog` → `references/3d.md`
(`meshy/v7.1/image-to-3d`, then `meshy/rigging/multi-animation`). Identity
and reference sheets: `character-design`. Loading and skinning:
`threejs` → `references/gltf-loading-guide.md`.

## Prepare before you rig

- **Generate from a clean, rig-ready image**: A-pose or T-pose, arms clear of
  the body, simple hands, no props in hand, the outfit the game uses.
- **Reduce before rigging, on the mesh you ship.** A rig binds to the mesh it
  was given; decimate or remesh first (`tripo3d/tripo/remesh` to a target
  polycount, e.g. ~20k triangles for a hero), keeping face and hands intact.
  Keep that exact mesh beside its paid rig.
- **One canon sheet per character** (turnarounds, proportions, colours), and
  every round compares the build against it.
- **Prove the pipeline on two different bodies** (say a slight human and a
  bulky creature) before running it for the rest.
- **Inspect each stage before paying for the next**: reference → mesh →
  remesh → rig → skin check → clips → sockets → in-game.

## Rigs and clips

- **No pinching, tearing or bending wrong** at waist, hips, shoulders or neck
  in any clip at any LOD. Check on import and again in motion.
- **Each clip plays on the rig it was made for.** Retargeting between
  skeletons is checked joint by joint; a clip for a slight body on a hunched
  creature reads wrong.
- **Joints stay inside human limits** on every frame (wrists, elbows,
  shoulders, knees), and inside a narrower natural band at rest. Log an error
  in dev builds when a frame leaves the band.
- **Every character has idle, locomotion and its signature action** before it
  appears. Never seen in bind pose.

## Locomotion

- **Authored or captured clips blended by speed** (a 1D blend of idle, walk,
  run), with feet planted and legs still at idle. Procedural layers add small
  corrections, never replace a limb's pose.
- **Ease gait and layer weights** over 0.15–0.3 s, so the body never pops,
  flips or jitters while starting, strafing or stopping.
- **Feet don't slide**: stride phase follows ground covered, a new gait starts
  where the old one's feet were, and foot IK only closes the last few
  centimetres onto slopes and steps.
- **The controller moves the root; animation never does.** Strip root motion
  (or read it as a velocity hint) so body, capsule and equipment stay
  together.

## Held items and first-person bodies

- A held item follows the animated hand socket, both hands sit on its real
  grips through movement, aim, recoil and reload, and shots leave from its
  real muzzle.
- When an IK target can't be reached inside joint limits, move the item,
  never the anatomy.
- How a character holds and aims a weapon or tool comes from footage of
  trained people doing it, one grip per hold.
- A first-person body is opaque and whole at every view angle; mitten or
  simple closed hands rig and pose more reliably than generated fingers.

## Accept in play

A character is accepted on how it looks in play, from the player's camera and
every side another player sees. Hitboxes stay fair across characters, and each
fits the frame budget. Customisation choices show on the next frame, never a
half-built character while loading.
