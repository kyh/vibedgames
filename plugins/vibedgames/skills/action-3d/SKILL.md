---
name: action-3d
description: "Make a 3D action game hold up: enemies and bots that reach, recover and read, bosses that telegraph, first-person weapons and view models, collision that equals the picture, stairs and doors that work, ragdolls that rest, and rigged characters that don't tear or slide. Use when enemies get stuck or feel harmless, guns look like toys or clip, players walk through walls or snag, or characters T-pose, slide or bend wrong."
---

# 3D action: enemies, weapons, world and bodies

The `threejs` skill owns the engine (controllers, physics engines, GLTF
loading, skinning). This skill owns what makes a shooter, brawler or horde
game feel built rather than assembled. Each area has its rules in a reference:

| Area                     | Read                                                 |
| ------------------------ | ---------------------------------------------------- |
| Enemies, bots, bosses    | [references/enemies.md](references/enemies.md)       |
| First-person weapons     | [references/weapons.md](references/weapons.md)       |
| Collision and the world  | [references/world.md](references/world.md)           |
| Characters, rigs, motion | [references/characters.md](references/characters.md) |

Feel (hits, hitstop, recoil, shake, killcams): `game-feel`. Map layout,
spawns and sightlines: `level-design`. Wave counts, time to kill and economy:
`game-balance`. Generating models and clips: `model-catalog` →
`references/3d.md`.

## Rules that cut across all four

- **Judge from the player's camera, in motion.** A pose, gait or reload that
  looks right in an editor still often fails in play. Accept motion only from
  recorded video stepped frame by frame and then watched at full speed
  (`trailer` → `references/capture-hooks.md` gives the stepped clock).
- **Audit scripts before eyes.** Floating props, buried props, missing
  colliders, unreachable spots, stuck enemies and bind poses are found by a
  script that walks the scene, not by looking. Each script first proves it
  catches a planted defect.
- **Sweep the class.** When one gun, enemy or door is wrong, check every
  member of its class before reporting the fix.
- **The simulation runs in fixed steps** (e.g. 60 Hz) independent of render
  rate, with bounded catch-up after a hitch or a hidden tab.
- **Nothing generated is held close without a check.** Generated hard
  surfaces top out at "passable" at arm's length. Held weapons and tools come
  from authored or licensed models, or from a procedural build
  (`image-to-threejs`). Generate bodies, far props and variety.

## Scene audit (run before calling a level done)

A script over the loaded scene that reports, per map:

1. **Floating and buried props**: raycast down from each prop's base; flag a
   gap over ~2 cm or a base sunk past its footing.
2. **Overlapping solids** that are not one authored object.
3. **Coplanar faces** (z-fighting): faces facing the same way within a few
   vertex-grid steps of each other.
4. **Collision parity**: every drawn solid has a collider (or a reason not
   to), and no collider exists where nothing is drawn.
5. **Cameras inside geometry**: every gameplay, spawn, menu and capture
   camera's near plane is clear.
6. **Stairs, ramps and ladders**: a walk bot holding forward only reaches the
   top of each, without jumping; pass only if the body ends beyond it.
7. **Actor counts**: one player, one boss, no frozen duplicate.

Plant one of each defect in a test map and see the audit catch it before
trusting its clean report.
