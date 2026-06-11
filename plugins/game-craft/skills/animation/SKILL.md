---
name: animation
description: "2D game animation craft — timing & spacing, frame budgets per clip (idle/walk/run/attack/death), the responsiveness-vs-weight contract, cancel windows, smears, silhouette readability, secondary motion — from Williams' Survival Kit, Mariel Cartwright's Skullgirls GDC talk, saint11, and fighting-game frame practice. Use when: 'the animation looks stiff/floaty/mushy', 'how many frames for a walk cycle?', 'attacks feel laggy', 'character feels dead', 'animate this sprite sheet', wiring sprite anims in Phaser, or cleaning AI-generated frames into a usable set. For GENERATING the frames see pixel-art / animated-spritesheets; this is what makes them good."
---

# Animation craft

Timing and spacing ARE the animation (Richard Williams): per-frame durations
carry more weight than frame counts. With 4–8 frame budgets, every frame is a
key pose — if it doesn't read from keys alone, more inbetweens won't save it
(Mariel Cartwright delivered a Skullgirls punch in six). Fewer, stronger
frames beat smooth: even inbetweening reads as mush.

## Timing & spacing

- **Logic at 60fps, sprites at 8–12fps.** 12 is the pixel-art sweet spot;
  18+ reads rushed, ≤6 reads idle. Never tie hitboxes to render framerate.
- **Vary rate per clip**: idle 4–8fps, walk 8–10, run/attacks up to 15–20.
- **Uneven timing for attacks**: slow anticipation (~120–200ms/frame),
  near-instant strike (1–2 frames at ~30–60ms, one may be a smear), moderate
  recovery (~80–150ms). Even timing for cycles (walk ~80–150ms/frame, run
  ~50–80ms). In Phaser use per-frame `duration` overrides, not one global
  `frameRate`, for non-cycles.
- **Slow in, slow out**: cluster spacing at a pose's start/end, big jump
  mid-motion. Five frames = small, small, HUGE, small, small.
- **Hold the follow-through pose** a beat longer; overshoot past rest on fast
  moves, then settle.
- **Loops must not double the contact pose at the seam.** Watch every loop
  for 10 straight seconds before calling it done.

## Frame budgets (small sprites)

| Clip | Frames | Notes |
|---|---|---|
| Idle | 2–4 | 1px breathing bob; move interior pixels/hair, not the silhouette |
| Walk | 4–8 | 4 = two contacts + two passing; cut "up/recoil" frames first |
| Run | 6 (4 tiny, 3 with extreme poses) | not a fast walk: airborne moments, lean, arm swing |
| Jump | 3–5 phases | crouch → stretch ascent → apex → fall → land squash; select by velocity, not a timed clip |
| Attack | 3–8 | 1–3 anticipation, 1–2 strike, 1–3 recovery |
| Hit react | 1–3 | one strong recoil pose + white flash beats three soft poses |
| Death | 4–6 | one-shot, ends on a settled pose |
| FX (slash/smoke) | 3–6 | expand → disperse → fade; can run 15–24fps |

(Shipped reference points: Celeste runs on 4 frames, Shovel Knight walks on
6.) **AI-generated sheets: cut down to these budgets** — delete
near-duplicates first; redundancy reads as floatiness.

## The gameplay/animation contract

Responsiveness vs weight is a contract, not a contest (Jonathan Cooper,
*Game Anim*): put the weight in follow-through and recovery, which don't
delay input.

- **Player attacks: short startup** (~2–5 logic frames for light moves),
  compensating with exaggerated poses and smears. Long windups are a
  deliberate cost for heavies only.
- **Enemy attacks invert it**: long, silhouette-distinct telegraphs that show
  an attack is coming AND where it lands. The anticipation pose is gameplay
  information.
- **Fast transition into the strike reads as MORE powerful** — power is
  contrast in spacing, not duration. Slow windups convey weakness.
- **Cancel windows**: dodge/move/next-attack may interrupt startup and
  recovery; only active frames are committed (the Dead Cells trick).
- **Never look idle before you can act**: hold the recovery pose, then pop
  to idle — the sprite is the UI for vulnerability state.
- **Movement animation never gates movement.** Velocity changes instantly;
  the run cycle starts mid-stride.
- **Drive animation FROM state**: pick jump/fall frames by velocity, trigger
  land-squash from the collision event. Never `setTimeout` gameplay to clip
  length. On interrupt (hit mid-attack), cut instantly to the hit reaction —
  never finish the old clip.
- Give control back during follow-through: the player moves while cloth/hair
  finish their arcs.

## Readability at small sizes

- **Silhouette test**: idle, walk, anticipation, attack must be
  distinguishable as pure black shapes. If not, redraw the pose — don't add
  frames.
- **One smear frame** for any fast arc: stretch the weapon/limb into a blur
  covering the path, 1 frame at ~30–60ms. The smear can visually carry the
  hitbox.
- **Exaggerate past reality**: extend limbs on the strike, squash 1–2px on
  landings/hits. At 16–32px, realistic motion reads as nothing.
- **Keep arcs**: hands/feet/weapon tips trace curves across frames — overlay
  the frames and check; zigzags only as deliberate snap accents.
- **Pixel hygiene on AI frames**: consistent palette across frames, no
  swimming outline pixels, constant volumes (head mass shouldn't pulse),
  feet pinned to one baseline.

## Secondary motion & life

- **Hair/cape/scarf lag the body by 1 frame** and settle 1–2 frames after it
  stops — the cheapest way to make a 4-frame loop feel alive.
- **Sub-pixel animation** for motion under one pixel: animate the
  anti-aliasing shades inside the sprite instead of moving the silhouette.
  Best for idles, faces, small objects.
- **Idle personality**: blinks every few seconds, hair sway — secondary
  elements, not whole-body motion.
- **Transitions last**: idle↔walk snaps fine at 8–12fps; spend frames only
  on land-squash and attack-recovery-pop. Add dedicated transitions only
  where the snap visibly jars.

## Review checklist

1. Silhouette test passes for idle/walk/anticipation/attack?
2. No player attack delays its hit >~100ms after input unless deliberately heavy?
3. Every enemy attack telegraphed by a distinct readable pose?
4. Strikes are 1–2 fast frames with a smear; anticipation/recovery hold longer?
5. Recovery cancelable; sprite never looks idle before control returns?
6. All loops seamless — no doubled seam frame, no baseline bob?
7. Hair/cloth lags one frame and settles after the body?
8. Feet planted — stride matches move speed, no moonwalking?
9. Palette/outline/volume consistent across frames (no AI shimmer)?
10. Land/hit squash triggered by the game event, not the clip timeline?
11. Hitboxes on 60Hz timers, sprites at 8–15fps — decoupled?
12. Watched each clip 10s straight — idle still alive, run still energetic?

## Sources

- saint11 (Pedro Medeiros) pixel animation tutorials — saint11.art/blog/pixel-art-tutorials/
- Cooper, "The 12 Principles of Animation in Video Games" — gameanim.com/2019/05/15/the-12-principles-of-animation-in-video-games/
- Cartwright, "Fluid and Powerful Animation within Frame Restrictions" (GDC 2014) — gdcvault.com/play/1020575
- Rivals of Aether workshop guide (anticipation/action/recovery) — rivalslib.com/workshop_guide/art/anticipation_action_recovery.html
- Schlitter, Pixelblog 8 & 9 (cycles, melee attacks) — slynyrd.com/blog/2018/8/19/pixelblog-8-intro-to-animation
- 2D Will Never Die, sub-pixel animation — 2dwillneverdie.com/tutorial/give-your-sprites-depth-with-sub-pixel-animation/

Related skills: `pixel-art` / `animated-spritesheets` (generate the frames),
`vfx` (effects animation), `game-feel` (hit stop, squash from code),
`phaser` (animation API).
