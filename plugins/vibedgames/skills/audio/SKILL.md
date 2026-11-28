---
name: audio
description: "Make a browser game sound finished: one master chain and buses, a mix led by the player's own action, voice limits, take pools, loudness per family, generated SFX/voice/music through `vg generate`, and audio QA when you cannot listen. Use when the game is silent, harsh, delayed, thin, repetitive, or needs sound."
---

# Audio

Sound closes more of the gap between prototype and game than any other single
pass, and it is the pass agents get wrong most confidently, because **an agent
cannot hear**. Every level you set is a meter reading. So keep two kinds of
evidence apart in every report:

- **Measured**: what a recording of the running game's output shows (levels,
  peaks, timing, clipping, gaps).
- **Heard**: what a person decided after listening. Only a person can close
  "sounds good". Until one has, say "measured, nobody has listened yet".

Count is not quality. Forty samples through a real chain, a voice budget and a
no-repeat rule beat four hundred played raw into `ctx.destination`.

Generation is `vg generate` (see `generate`, `model-catalog` →
`references/text-to-audio.md`). Loading and the gesture unlock in a three.js
scene: `threejs` → `references/generated-assets.md`. Recording and checking the
mix without ears: [references/qa-without-ears.md](references/qa-without-ears.md).
Generating a sound bank: [references/generating-sound.md](references/generating-sound.md).
Rhythm and music games: [references/rhythm.md](references/rhythm.md).

## The chain (build it first)

Everything the game plays reaches the speakers through **one** path:

```
source → voice gain → bus (music | ambience | sfx | weapons | voice | ui)
       → bus gain (player setting) × duck gain (game) → master compressor → limiter → destination
```

- **One master.** A gentle compressor (ratio ~3:1, knee soft) then a limiter
  (a `DynamicsCompressorNode` at ratio 20, threshold ≈ −1 dBFS, fast attack).
  Nothing connects to `destination` directly: grep for it.
- **Buses the player can set and the game can duck, as two separate gains.**
  The player's slider and the game's duck multiply; they never write the same
  `GainNode`, or a duck resets the setting.
- **Heavy hitters get their own limiter.** Weapons or impacts run through a bus
  limiter before the master, so rapid fire never pumps music and ambience.
- **A duck lets its cause through first.** Start the duck 20–40 ms after the
  sound that caused it, so the cause lands at full level and the rest gives way
  under its tail. Nothing ducks the player's own action.
- **Schedule on the audio clock.** Anything that must land at a time uses
  `source.start(ctx.currentTime + lead)` with a small fixed lead (~10–20 ms),
  never a `setTimeout`.
- **Guard the output.** A NaN or runaway gain is static from the speakers, and
  static counts as a crash. Clamp every computed gain/rate, and check for
  non-finite values before they reach an `AudioParam`.

## The mix

- **The player's own signature sound leads.** In a recording of play, the
  player's shot, strike or jump is clearly louder than rival shots, reloads,
  voices and every loop. Write that hierarchy down as relationships ("player
  shot ≥ 6 dB over the loudest bed") and measure it.
- **Continuous sounds sit low.** No loop or bed is as loud as a player action,
  no bed has a period you can hear, and no bed contains something the player
  will read as an event (a gunshot buried in "battle ambience").
- **Far is a different sound, not a quieter one.** Author near/far takes, or
  at least low-pass and wet them by distance; every space has its own reverb
  (`ConvolverNode` with a generated impulse response, see below).
- **Things the player needs are audible at play distance** (an enemy's steps
  in the dark, an objective cue) and also **shown on screen** for players who
  cannot hear them (`ship-ready` → accessibility).
- **One confirmation channel.** Hit, critical and kill confirms never stack: a
  stronger verdict replaces a weaker one in flight.
- **The player's body is quiet.** No breathing at rest, no groans on every
  step. Effort and pain sounds are short and rare.

## Voices and repetition

- **A voice budget with priorities.** Cap simultaneous sources (~24–32 on
  desktop, ~16 on phones). When full, steal the **quietest, lowest-priority**
  voice with a 10–20 ms fade, never the oldest and never with a click. Player
  action, hits, UI, music and announcer are never stolen; enemy vocals go first.
- **Shuffled bags, not random picks.** A frequent sound has several takes
  (footsteps 6–8, shots 3–5) drawn from a shuffled bag that never repeats the
  last take. Add ±3–5% rate and ±1 dB gain on top.
- **Play whole, end by rule.** A sound stops before its file ends only by a
  named rule (the action was interrupted, the voice was stolen). Echoes decay
  under the next shot; they are not cut by it.
- **Sound follows the animation.** A sound tied to a visible action lands on
  the frame of contact. Keep each action's beat times in one data table that
  both animation and audio read. Multi-beat effects (charge, launch, impact,
  tail) fire their cues from the effect's own clock, never `setTimeout`, and
  fire nothing on a pause, reset or scrub (`crossedCues` in
  `threejs/modules/vfx.ts`; `vfx` → `references/threejs.md` §10).

## Files

- **Loudness per family, measured after encoding.** Group files (weapons, UI,
  footsteps, voice, music, ambience), give each family a loudness target, and
  normalise to it after the final codec. Measure integrated LUFS and true peak
  with the hosted loudness meter (`references/qa-without-ears.md`).
- **Music streams.** Long tracks play through an `<audio>` element routed with
  `createMediaElementSource`, never fully decoded into an `AudioBuffer`.
- **Every file has a caller.** A file nothing plays is either wired up or
  reported; a call site whose file is missing is an error the console shows.
- **Loops are tested looping.** Play a loop twice back to back in the game
  before accepting it; a seam click fails it.

## Sound from the first press

Browsers start the `AudioContext` suspended. Resume it on the first
`pointerdown`/`keydown`/`touchend`, and make sure the loading screen, title and
every menu already have music or ambience queued so the first press is heard.
Check it **by measurement** (a tap on the master shows non-zero RMS), not by
`ctx.state`: Safari reports `running` while silent after an interruption.
Resume again on `visibilitychange` and after phone calls. A build that cannot
play sound says so to the player.

## Done means

- [ ] One master chain; `destination` is connected only from the limiter.
- [ ] Buses with separate player and duck gains; settings persist.
- [ ] A recording of real play shows the stated hierarchy, no clipping (true
      peak ≤ −1 dBTP), no gaps on rapid repeats, no NaN.
- [ ] Every frequent sound has a shuffled bag; every loop tested looping.
- [ ] Sound on the first press on desktop and on a real phone.
- [ ] A person has listened, and the report says who and when. Until then the
      report says "measured, not heard".
