---
name: level-design
description: "Level, wave, and arena design patterns from the canon (Nintendo's kishōtenketsu, Scott Rogers' Disneyland weenies, Celeste's room design, Valve's experiential density) — structure, pacing, teaching through geometry, guiding the eye, wave grammar for endless games. Use when designing or generating levels, waves, arenas, or difficulty progression: 'design levels for my platformer', 'the level feels empty/confusing', 'players don't know where to go', 'make better waves', 'how should difficulty ramp', 'add more levels'. Routing: craft phase; pairs with `game-balance` and `onboarding`; orchestrated by `game-playbook`."
---

# Level design

Levels are authored arguments: each one teaches an idea, tests it, twists it,
and concludes. These patterns apply equally to hand-built tilemaps and
code-generated levels — generators should emit the same grammar.

## Core rules

- **Four beats per level (kishōtenketsu** — Hayashida, Super Mario 3D World):
  introduce the mechanic safely → develop with real stakes → twist (one
  variable flipped) → conclude with a capstone. One mechanic per level.
- **The level is the tutorial.** First exposure to anything new cannot kill:
  show the crusher cycling over a pit you can't fall into. Never explain in
  text what geometry can teach (Hayashida; Thorson).
- **Pull with eyes, not arrows (the weenie** — Rogers, via Disneyland): the
  goal or its marker visible from afar; leading lines (platform edges, coin
  trails) aimed along the critical path; one saturated accent color reserved
  for interactables; motion for anything that must not be missed.
- **Experiential density** (Valve's Half-Life cabal): a stimulus — enemy,
  pickup, set piece — every few seconds of _distance traveled_, never timers.
  Audit generated levels for dead stretches >3–4s of travel.
- **Deaths are the player's fault**: telegraph every threat (wind-up, audio
  cue, flash) and leave a readable escape. Surprise kills make players blame
  the game and quit (Valve).
- **Sawtooth difficulty**: rise ~4–5 levels/waves, drop deliberately, rise
  from a higher floor. Every 4th–5th level is a victory lap remixing known
  elements. Rest stops (hazard-free screen, checkpoint, secret) after peaks.
- **Short rooms, instant retry** for execution challenges: death costs <2s,
  respawn at room entry, no fade (Celeste).
- **Two routes per room** where possible: safe-slow vs risky-fast with a
  reward on the risky one (Thorson). Asymmetric layouts — mirror-symmetric
  rooms read artificial.
- **Secrets reward attention, not pixel-hunting**: signal with an anomaly —
  off-pattern tile, coin pointing into a wall.
- **Cut, don't patch**: a room that's still broken after 2 iterations gets
  deleted (Thorson; Valve).

## Build procedure (level set)

1. List verbs (jump, dash, shoot) and hazard primitives. Each verb × hazard
   twist = a level seed. Order easy → hard.
2. Level N teaches seed N using only seeds 1..N-1 as support. Plan the
   sawtooth.
3. Build each level in the four beats: (a) safe demo, can't kill; (b) first
   real test; (c) twist — same mechanic, one variable flipped (bounce pads on
   walls; the chaser now phases through walls); (d) capstone: seed + 1–2 old
   mechanics, densest moment, right before the exit.
4. Place the weenie first, decorate second. Breadcrumb pickups along the
   critical path.
5. Add the risky/safe fork and one signaled secret per level.
6. Audit density (no dead stretches) and failure attribution (every kill
   source telegraphed + escapable).
7. Playtest mechanically: log time-per-room and death positions (a death
   heatmap spike = a telegraphing failure, not "players are bad"). Self-test
   at max speed and min skill.
8. Optional difficulty last, Celeste-style layers: collectible on the risky
   route per level, then a "B-side" hard remix reusing the same tilemap with
   extra hazards — big replay value, near-zero new assets.

## Waves & arenas (endless / horde / score-attack)

- **Wave grammar: build → peak → breather.** 3–5 escalating waves, a spike
  (ambush/boss), then a breather (shop, low pressure). Repeat from higher.
- **Debut enemies kishōtenketsu-style**: new type appears alone in a quiet
  wave → paired with basics → in a surprising configuration → folded into
  the standard mix.
- **Spawn timing is the knob**: the same 10 enemies are a wall (all at once —
  demands AoE/prioritization) or a stream (staggered — demands stamina). Vary
  the pattern per wave (wall / stream / pincer), not just the count.
- **Endless ramp**: `difficulty = sqrt(frames * 0.0001) + 1` is a proven
  starting curve for ~3-minute runs (Kenta Cho / ABA Games) — gentle early,
  ~doubled by 3 min. Scale "tension" parameters (speed, count) linearly with
  it; scale "fairness" parameters (reaction windows, hitboxes) much more
  gently.
- **Arena geometry creates the tactics**: an empty rectangle has one strategy
  (circle-kite). Each feature adds one: pillar → line-of-sight play, choke →
  funneling, hazard zone → area denial, open ground → breathing room. Give an
  arena 3–4 such features.
- **Risk/reward in waves**: bonus points/drops for risky play early — fights
  early-game boredom in score chasers (ABA Games).

## Sources

- Hayashida on Mario's kishōtenketsu — gamedeveloper.com/design/the-secret-to-i-mario-i-level-design
- GMTK, "Super Mario 3D World's 4 Step Level Design" — youtube.com/watch?v=dBmIkEvEBtA
- Rogers, "Everything I Learned About Level Design I Learned from Disneyland" (GDC 2009) — youtube.com/watch?v=P4uPwhSqW8Q
- Thorson, "Level Design Workshop: Designing Celeste" (GDC 2017) — youtube.com/watch?v=4RlpMhBKNr0
- Valve's cabal process — gamedeveloper.com/design/the-cabal-valve-s-design-process-for-creating-i-half-life-i-
- ABA Games, difficulty curves for small games — abagames.github.io/joys-of-small-game-development-en/difficulty/curve.html

Related skills: `game-playbook` (build order), `onboarding` (the first 30
seconds), `game-balance` (wave economy/scaling math), `phaser` (tilemaps).
