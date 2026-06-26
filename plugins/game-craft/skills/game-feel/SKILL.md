---
name: game-feel
description: "Deep game-feel and juice reference — input forgiveness windows, movement curves, hit stop, trauma-based screen shake, squash & stretch, camera kick, audio feel — with concrete numbers from the canonical sources (Swink, Vlambeer, Celeste, Smash). Use when tuning how a game FEELS: 'the controls feel floaty/sluggish/slippery', 'jumping feels bad', 'hits don't land', 'make combat feel weighty', 'add juice', 'coyote time', 'input buffering', 'screen shake feels wrong', or any movement/impact tuning pass. The game-playbook craft checklist covers the basics; this is the deep module with the tuning values."
---

# Game feel: the numbers

Game feel = real-time control + simulated space + polish (Swink). The polish
amplifies the simulation but never lies about it: if the screen shakes,
something must have hit. Small tweaks compound — Vlambeer's flat shooter
becomes Nuclear Throne via ~30 individually-invisible tricks. Apply them in
passes, then **play it**: feel is tuned in motion, never designed on paper.

All frame counts assume 60fps — which means **physics must be
delta-time-based**. Per-frame integration (`x += vx`) runs 2× fast on a 120Hz
display; this is the single most common feel bug in browser games. Multiply
all motion by `dt`, and convert the frame windows below to ms when your loop
isn't fixed-step.

## Input forgiveness (the invisible half of "tight controls")

Fudge everything slightly in the player's favor — players read forgiveness as
their own skill (Celeste).

- **Input buffer 4–10 frames**: a jump/attack pressed slightly early fires on
  the first legal frame. Celeste ~4, Smash 10. Start at 5 for precise games,
  8–10 for forgiving ones. Track a `bufferedAt` timestamp per action; consume
  in `update()`.
- **Coyote time 5–8 frames**: jump still works after walking off a ledge
  (Celeste ~5–6). Track `lastGroundedAt`.
- **Corner correction**: a jump that clips a ceiling corner by a few px gets
  nudged sideways; a dash that clips a ledge pops up onto it. Celeste's
  wall-jump reaches ~2px off the wall at 320×180 — scale to your resolution.
- **Never demand frame-perfection.** Any 1-frame window gets widened.
- **Touch: enlarge hitboxes, not visuals** — tappable region > sprite.
- Respond to core verbs within ~100ms total (Swink's correction cycle);
  never add startup delay to movement inputs.
- **Continuous/tracking inputs** (pointer, analog stick, webcam/hand): the
  forgiveness knob is smoothing-vs-latency. Lerp the controlled object toward
  the input (factor ~0.1–0.3 per 60fps frame) to kill jitter, but keep total
  lag under the ~100ms cycle; add a small dead zone, and fudge the
  _interaction_ hitboxes (paddle/catch zones) larger than the visuals.

## Movement curves

- **Reach max run speed in ~6 frames, stop in ~3** (Celeste). Stopping faster
  than starting reads "responsive"; the reverse reads "slippery".
- **Variable jump height**: releasing jump early cuts upward velocity.
- **Apex float**: while jump is held, halve gravity near the arc's peak
  (Celeste) — gives air-control where players need it.
- **Fall faster than you rise**: heavier gravity on descent + a fall-speed
  cap. Symmetric arcs feel floaty.
- **Keep platform momentum** for a few frames after leaving a moving platform.
- Phaser: implement as manual velocity writes in `update()` — Arcade `drag`
  alone can't express asymmetric accel or apex gravity.

## Impact

- **Hit stop**: freeze attacker AND victim 2–5 frames on light hits, 6–12 on
  kills, hard cap ~20–30 (Smash ≈ `damage × 0.65 + 6` frames). Scale with
  importance. Pause tweens/anims for the parties, not the whole world, when
  multiple fights overlap. In non-Phaser loops (rAF/`useFrame`), implement as
  a freeze timer that skips integration for the frozen entities while
  rendering continues.
- **Knockback both ways**: victim recoils from hits; shooter kicks back 1–2px
  on fire. Suspend AI steering ~150ms so the shove reads.
- **Hit flash**: solid white tint 1–3 frames.
- **Particles at every contact** (muzzle, impact, dust on land), lifetimes
  0.2–0.5s.
- **Permanence**: corpses, craters, shell casings stay (Nijman's
  highest-leverage trick). Stamp into a texture or cheap static images, not
  live bodies.
- **Bigger projectiles, lower accuracy, higher fire rate** — perfect accuracy
  reads sterile.

## Animation principles (Disney, applied)

- **Squash & stretch, volume conserved**: scale Y 0.7 on landing → scale X
  ~1.3. Stretch along velocity at speed; squash on impact. Typical: jump
  stretch 1.1–1.25, land squash 1.2–1.4, recover over 100–200ms ease-out.
- **Anticipation on big actions only**: 2–6 frame wind-up before a boss leap
  or charged shot. Never on core movement — that's input lag.
- **Overshoot and settle**: `Back.easeOut`/`Elastic.easeOut` on everything
  that appears or changes; stagger group entrances 20–50ms apart.
- **Nothing pops**: scale-in on spawn, shrink-and-fade on death.

## Camera

- **Lerp-follow with look-ahead** in the facing/aim direction. Phaser:
  `startFollow(player, true, 0.08–0.15)` + manual look-ahead offset.
- **Trauma shake** (Eiserloh): events add 0.2–0.5 to a 0–1 trauma
  value; decay to 0 over 0.5–1s; offset = maxOffset × trauma², sampled from
  smooth noise per axis. Add rotational shake (max ~5–10°) — cheapest way to
  make 2D shake feel violent. Maxima ~5–10% of screen size. Trauma stacks
  naturally where fixed-magnitude `camera.shake()` calls fight each other.
- **Directional camera kick**: punch a few px opposite the shot / into the
  hit, ease back. Distinct from omni shake.
- **Keep shakes short** (<0.5s). Offer reduce-motion for sustained shakers.

## Audio feel

- **Every interaction sounds** — fire, hit, kill, land, pickup, UI. Audio is
  half of juice and the cheapest half.
- **Randomize pitch ±5–15%** per play: `sound.play({ rate: 0.9 + Math.random() * 0.2 })`.
- **Lower pitch = heavier.** Fatten kills/explosions with a bass layer; put a
  distinct confirm sound on kills above the routine hit sound.
- **Duck or sting music** on death/level-clear; silence after noise is itself
  an effect.
- Browser: unlock audio on first gesture; pool instances to avoid GC hitches.

## Tuning session

Numbers above are starting points, not answers. Wire the 5–6 feel constants
(accel frames, buffer, coyote, hit-stop, shake trauma) to a debug panel or
query params, play 2 minutes, adjust, repeat. If you can't decide between two
values, the larger forgiveness / smaller effect is usually right.

Related skills: `game-playbook` (build order + basic craft pass), `phaser`
(engine APIs), `onboarding` (difficulty feel), `design-lenses` (is it fun at
all).
