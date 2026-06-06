---
name: make-a-game
description: "The end-to-end recipe for building a GREAT browser game from a one-line idea, plus the juice/game-feel checklist that separates a tech demo from something fun. This is about taste — making the game feel good, not just work. Use when the user says 'make a game', 'build a <genre> game' ('make a pixel art top-down slasher', 'build a platformer', 'make a shooter'), 'create a game', or asks to make a game feel better: 'it feels flat/static/boring', 'add juice/polish/game feel/vibes', 'give it vibes', 'make it tasteful', 'screen shake', 'hit stop', 'make it feel good', 'why does my game feel cheap'."
---

# Building a game that feels great

The platform promise is "studio-grade games from a prompt." The gap between a
tech demo and that is two things: **the right build order** and **juice**. This
skill is the playbook. The engine/asset/deploy skills own the pieces; this owns
how they fit together and how to make the result _fun_.

## The recipe (a complete game from "make a <genre> game")

Do these in order — don't write the game loop before you have art, and don't
ship before the juice pass.

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
4. **Juice pass** — the checklist below. This is what makes it feel great.
5. **Verify it's actually fun.** Run it (see `playwright` / `run`), play it —
   move, attack, take a hit, die, restart. A game that only "looks done" in a
   static screenshot usually feels dead in motion. Tune speeds/cooldowns/spawn
   rates until the core loop is satisfying in the first 10 seconds.
6. **Ship.** `vg deploy ./dist` (see `deploy`); `add multiplayer` / `make it
forkable` are one prompt each (see `multiplayer`, `fork`).

## The juice checklist

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

## Remember

A great first game = generated art (not placeholders) + a tight full-screen
follow camera + a core loop where every hit shakes, flashes, knocks back, and
sprays particles. Build the art, build the loop, then spend real time on the
juice pass — it's 10% of the code and 90% of the feel.
