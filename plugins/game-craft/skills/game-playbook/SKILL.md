---
name: game-playbook
description: "The end-to-end recipe for building a GREAT browser game from a one-line idea, plus the craft checklist that separates a tech demo from something fun. Use when the user says 'make a game', 'build a <genre> game' ('make a pixel art top-down slasher', 'build a platformer', 'make a shooter'), 'create a game', or asks to make a game better: 'it feels flat/static/boring', 'add polish/craft', 'screen shake', 'hit stop', 'make it feel good', 'why does my game feel cheap'. Build order it sequences: scaffold (`phaser`/`threejs`) → art (`pixel-art`) → core loop (`phaser`/`threejs`) → craft (`game-feel`/`vfx`/`animation`) → verify (`playwright`) → ship (`deploy`)."
---

# Crafting a great game

The platform promise is "studio-grade games from a prompt." The gap between a
tech demo and that is two things: **the right build order** and **craft**. This
skill is the playbook. The engine/asset/deploy skills own the pieces; this owns
how they fit together and how to make the result _fun_.

## The recipe (a complete game from "make a <genre> game")

Do these in order — don't write the game loop before you have art, and don't
ship before the craft pass.

1. **Scaffold.** `vg new <slug> --engine phaser` for 2D, `--engine threejs` for
   3D. (See the `phaser` / `threejs` skills.) The template is a skeleton, not a
   game — you will replace its placeholder scene and logo.
2. **Generate the art FIRST** (see `pixel-art`). Order matters:
   - hero character → directional walk sheets (`walk-down/up/side`, left =
     mirror) → background-remove (Bria) → normalize to exact power-of-two frames.
   - enemies / pickups / projectiles.
   - **impact + ability VFX on PURE BLACK** (slash arcs, explosions, muzzle
     flashes) — render them with `BlendModes.ADD` so black is free transparency,
     no alpha pass needed. A generated video → ffmpeg frame strip makes great
     fire/explosion (see `pixel-art` Recipe 5).
   - ground/tiles or a parallax/arena backdrop.
     Replace the template's logo/bg — never ship placeholder art.
3. **Core loop with the proven shell** (see `phaser`): full-screen
   `Scale.RESIZE`, a **zoom-aware follow camera** (clamp the centre yourself —
   Phaser's `setBounds` reveals void), directional `applyAnim(dir, moving)`,
   Arcade physics for movement + `overlap` hit detection, `load.spritesheet`
   with the EXACT frame dims you normalized to.
4. **Craft pass** — the checklist below. This is what makes it great.
5. **Verify it's actually fun.** Run it (see `playwright` / `run`), play it —
   move, attack, take a hit, die, restart. A game that only "looks done" in a
   static screenshot usually feels dead in motion. Tune speeds/cooldowns/spawn
   rates until the core loop is satisfying in the first 10 seconds.
6. **Ship.** `vg deploy ./dist` (see `deploy`); `add multiplayer` / `add touch
controls` / `make it forkable` are one prompt each (see `multiplayer`,
`gamepad`, `fork`). Link-shared games get opened on phones — if the game is
mouse/keyboard-only, add on-screen touch controls so it's playable there.

## The craft checklist

Apply most of these to every interactive moment (hit, kill, pickup, jump, land,
damage). Each is a few lines; together they're the whole difference.

- **Screen shake** on impact: `this.cameras.main.shake(80, 0.005)` (bigger for
  player damage, smaller for a hit landed).
- **Hit-stop** on meaningful hits — freeze for a beat so blows land:
  `this.physics.world.pause(); this.time.delayedCall(45, () => this.physics.world.resume());`
- **Knockback**: shove the target away from the source on hit
  (`body.setVelocity(cos*K, sin*K)`), and ignore AI steering for ~150ms so the
  knockback reads.
- **Particles** on hit/kill/pickup — a soft additive burst:
  ```ts
  const e = this.add.particles(x, y, "spark", {
    speed: { min: 50, max: 220 },
    lifespan: { min: 240, max: 520 },
    scale: { start: 1, end: 0 },
    alpha: { start: 1, end: 0 },
    tint,
    blendMode: Phaser.BlendModes.ADD,
    emitting: false,
  });
  e.explode(14);
  this.time.delayedCall(650, () => e.destroy());
  ```
  (Generate a soft white dot texture procedurally in the preloader.)
- **Hit flash**: `sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL)` for
  ~80ms (Phaser 4 — `setTintFill` is gone).
- **Squash & stretch / pop-in**: spawn enemies/pickups with a `Back.Out` scale
  tween from ~0.4; a brief non-uniform scale on attack/land sells weight.
- **Ability VFX**: the additive-on-black slash/explosion sprite, swung via a
  `scale↑ + alpha→0` tween in the facing direction.
- **Screen flash** on player damage: `this.cameras.main.flash(120, 120, 20, 30)`.
- **Camera**: follow the player (zoom-aware clamp) and zoom in enough that the
  hero and enemies read BIG — a too-wide camera makes everything feel small and
  floaty. Show ~9–12 character-heights tall.
- **Easing everywhere**: tween with `Sine/Quad/Back/Cubic`, never linear pops.
- **Sound** (optional but huge): generate SFX/music with `vg generate` (audio
  models) — a hit thwack, a death pop, a loop — and play on the same events.
- **Readable HUD**: monospace/tabular numbers, hearts for HP, a clear
  win/lose banner. Surface connection state for multiplayer.

## Anti-patterns (what makes a game feel cheap)

- Shipping the template's placeholder scene/logo instead of generated art.
- Movement with **no feedback** — no shake, no particles, no knockback, no
  flash. Functionally correct, feels dead.
- A **fixed tiny canvas** or a too-wide camera — the action feels small. Go
  full-screen with a tight follow camera.
- Loading AI sprite sheets **without exact frame dims** (jitter/garbage frames)
  — normalize to power-of-two cells first (`pixel-art`, `asset-pipeline`).
- Linear tweens and instant state changes — no anticipation or follow-through.
- Judging "done" from a static screenshot. **Play it in motion** before shipping.

## Deep modules

This playbook is the index; when a step needs real depth, load the module:

- `ask-me` — the idea is fuzzy; interview the user into a build-ready spec.
- `game-feel` — tuning numbers for input forgiveness, movement, hit stop,
  trauma shake, audio feel. The craft checklist above is the summary; that's
  the reference.
- `animation` — sprite animation craft: frame budgets, attack timing, cancel
  windows, smears, silhouette readability.
- `vfx` — particle recipes (explosions, sparks, trails, weather), color
  rules, mobile performance budgets.
- `level-design` — level/wave/arena structure: kishōtenketsu beats, weenies,
  experiential density, wave grammar, difficulty sawtooth.
- `onboarding` — the first 30 seconds, teaching without tutorials, difficulty
  curves, failure/retry loops, assist modes.
- `game-balance` — loops, economies, cost curves, loot tables, prestige math,
  dominant-strategy audits.
- `design-lenses` — structured critique when the game exists but isn't fun;
  severity-ranked findings mapped to the modules above.
- `finish-it` — the project is sprawling or stalled; cut to a shippable core
  and ship it.

## Remember

A great first game = generated art (not placeholders) + a tight full-screen
follow camera + a core loop where every hit shakes, flashes, knocks back, and
sprays particles. Build the art, build the loop, then spend real time on the
craft pass — it's 10% of the code and 90% of the difference.
