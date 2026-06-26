---
name: vfx
description: "Real-time 2D VFX cookbook — layered explosions, hit sparks, muzzle flashes, trails, smoke, pickups, heals, shockwaves, weather — with particle parameter recipes, color/readability rules, and mobile-browser performance budgets, from Diablo's VFX talk, Riot's style guide, saint11, and the GDC VFX bootcamps. Use when: 'add effects', 'make the explosion better', 'hits need more impact' (visual side), 'add a trail/aura/sparkle', 'the effects look muddy/noisy', 'particles tank the framerate', or any Phaser particle emitter / blend mode / post-FX work."
---

# Real-time VFX

Effects spell out the mechanics first: before pretty, decide what the player
must learn (hit confirmed? danger radius?). Then the timing model:
**anticipation → overload → processing** — brief windup, violent fast core,
slow lingering decay. Fast in, slow out: peak size in the first ~20% of an
effect's life, the rest is decay.

Two more laws: **scale of importance** — a basic attack must never outshine
an ultimate — and **if it feels long, it's way too long**: effects live in a
busy scene, default shorter than feels right alone.

## Anatomy of an explosion (layered)

Build as independent layers — flash → blast → fire → smoke — each with its
own timing. Medium explosion ≈ 600–900ms total:

1. **Contrast dip** (~1 frame, optional): a dark flicker right before the
   flash multiplies perceived brightness.
2. **White flash** (50–80ms): near-white core at almost-max radius
   immediately. Hit-stop and screen shake land here (see `game-feel`).
3. **Sharp blast** (100–200ms): hot angular core — sharp shapes for energy,
   no noise. Debris and sparks launch at max speed now.
4. **Fire fade** (~25% of total): shrink and cool white→yellow→orange→red.
5. **Smoke + afterglow** (~40%): smoke rises and fades slowly — it must
   outlive the fire ~2×. Leave a scorch mark (permanence — Vlambeer).

Minimum 4 frames for a readable sprite explosion. For barrages, chain small
explosions offset in time/position, never one long one.

## Recipe book

Base textures: a soft white dot, a 4–6px spark streak, a blurry smoke blob —
tint does the rest. Parameter ranges are tuned conventions; adjust to scale.
Phaser: create emitters once, fire with `explode(n, x, y)`.

- **Hit spark**: 6–12 particles, life 150–300ms, speed 150–400 radial (cone
  away from the surface), scale 1→0, ADD. Plus a 1-frame white flash sprite
  and the victim's tint flash.
- **Explosion**: 4 layers — flash sprite (scale 0.5→2 in 60ms, ADD); fire
  10–20 particles (life 300–500ms, speed 50–200, scale 0.8→0.1, tint
  white→orange→dark red, ADD); debris 5–10 chunky sprites (life 600–1000ms,
  speed 200–500, gravityY 600–900, rotation, NORMAL, leave a few on the
  ground); smoke 5–8 (life 800–1500ms, drift up 20–60, scale 0.5→1.5, alpha
  0.6→0, NORMAL, dark grey).
- **Dust puff** (land/dash): 4–8 particles, life 300–600ms, speed 30–100 out
  - up, scale 0.4→1, NORMAL, grey. Few coherent particles beat a noisy
    swarm — don't break the smoke's shape.
- **Muzzle flash**: star/cross sprite 1–2 frames (~30–60ms, ADD) + 3–5
  forward-cone sparks (life 100–200ms, speed 200–400) + a small smoke wisp.
  Camera kicks 1–2px opposite the shot.
- **Trail** (projectile/dash): emitter follows the object, frequency
  10–20ms, life 200–400ms, speed 0–20 (the object's motion spreads them),
  scale 0.6→0, tint white→orange→grey, ADD; add NORMAL smoke for heavy
  rockets. Each puff starts brightest and dims as it falls behind.
- **Pickup sparkle**: ambient 1 particle per 200–400ms, life 400–700ms,
  drift up 10–30, ADD, gold — or better, a 2–4 frame cross-glint sliding
  across the sprite every 1–2s. On collect: `explode(12)` + scale-pop tween
  (1→1.3→0) + rising "+1" text.
- **Heal/buff**: 8–12 soft motes over 600ms, life 700–1000ms, speedY −40 to
  −100, fade in-then-out, ADD, green/gold (rising = positive, falling/inward
  = negative — color conventions are free information). Expanding soft ring
  at the feet anchors it.
- **Level-up / big payoff**: the full arc — 300ms of particles converging
  inward (anticipation) → flash + ring + `explode(25)` (overload) → 800ms
  rising motes (processing). Pair with hit-stop and a bass sting. The one
  effect allowed to run long.
- **Shockwave ring**: ring sprite, scale 0.2→2.5 over 300–400ms, alpha
  0.8→0, ADD, `Cubic.Out`. Reserve for big hits — on every hit it's noise.
- **Damage flash**: sprite solid white/red 1–2 frames; screen-level = a rect
  at alpha 0.2–0.35 fading over 150–250ms. One flash per event, never a
  strobe.
- **Rain/snow**: emit along a line above the camera (`emitZone` edge). Rain:
  life ~1200ms, speedY 400–700, thin streaks, alpha 0.3–0.5, NORMAL. Snow:
  speedY 30–80, sinusoidal drift, life 4–8s, far fewer particles than
  instinct says. Keep weather mid-value so gameplay FX still pop over it.
- **UI flourish**: same grammar smaller — scale 1→1.15→1 (`Back.Out`,
  200ms), 4–6 corner sparkles, brief tint-up.

## Color & readability

- **Hot core, cool edge**: map particle life to white→yellow→orange→red→grey.
  Inverted ramps read as magic — use deliberately.
- **Reserve value extremes**: build in mid values; near-white/near-black
  spend only on focal moments (Riot).
- **One dominant hue per effect**; desaturate the secondary. Two saturated
  complements = noise. Moderate saturation overall — saturate the focal
  element, mute the support.
- **Color conventions are free**: green heal, blue frost/mana, orange-red
  gunpowder, purple dark magic. Give factions/classes a hue family so
  attribution is instant (Diablo).
- **ADD for energy, NORMAL for matter**: fire/sparks/magic additive;
  smoke/dust/debris/blood alpha. Stacked additive whites out.
- **Survive busy backgrounds with value contrast**: a bright ADD core backed
  by a darker alpha rim/smoke reads everywhere; pure additive vanishes over
  bright tiles.
- **Sharp shapes = energy, soft shapes = residue.** One focal point per
  effect; everything else smaller and dimmer.
- **Stretch particles along velocity** — blurred movement reads as power.

## Performance (mobile browsers)

- **You are fillrate-bound**: cost ≈ pixels × overdraw. Cap particle _size_
  before count; many small beat few huge transparent ones.
- **Limit additive stacking to ~3–4 layers deep** at any pixel; fewer, more
  opaque smoke particles beat many faint ones.
- **Pool everything**: emitters created once at scene start, reused via
  `explode()`/`emitParticleAt()`; pooled flash/ring sprites. Never
  create/destroy emitters per hit.
- **One FX atlas**, and group ADD vs NORMAL effects on separate layers —
  both texture swaps and blend-mode changes break batches.
- **Filters cost a render-to-texture pass** (Phaser 4 internal/external
  filters): one camera bloom fine, per-sprite filters deadly. Prefer the
  ring-sprite fake over a displacement shader on low-end; gate post-FX
  behind a quality flag.
- **Kill invisible work**: stop off-screen ambient emitters; shorten
  lifespans before cutting counts — lifetime is overdraw-time.

Related skills: `game-feel` (hit stop/shake/flash that pair with these),
`animation` (sprite-frame FX timing), `pixel-art` (generating FX sprites on
black for ADD), `phaser` (particle/filter APIs).
