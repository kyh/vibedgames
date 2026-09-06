# Cozy kart sound bank

32 original clips: 30 generated with ElevenLabs Sound Effects v2 through
`vg generate`, plus two continuous synthesized driving loops.
Prompts, request IDs, generation settings and delivered-file measurements are in
[manifest.json](./manifest.json). No reference recordings or existing game audio
were used. The direction is warm toy-kart foley, rounded marimba/bell rewards and
quiet coastal ambience.

| Game action                                          | Clip                                                   |
| ---------------------------------------------------- | ------------------------------------------------------ |
| Idle / acceleration / reverse / airborne motor       | engine-loop (smooth speed/load pitch)                  |
| Rolling / braking / drifting / wall contact          | road-loop, drift-loop, scrape-loop                     |
| Boost sustain / ignition / release / recharge        | boost-loop, boost, near-miss (lower), boost-ready      |
| Drift tiers / mini-turbo tiers                       | drift-ready, boost (rising tier pitch)                 |
| Curb / cone / light collision / heavy collision      | impact-soft, impact-hard                               |
| Jump / landing                                       | jump, landing                                          |
| Water entry / floating wake                          | splash, water-loop                                     |
| Traffic horn / near miss                             | horn, near-miss (panned)                               |
| Passenger pickup / delivery / combo                  | pickup, dropoff (rising combo pitch)                   |
| Passenger patience warning / bailout                 | warning, fare-lost                                     |
| Countdown / GO / restart                             | countdown (rising pitch), go, reset                    |
| Menus / garage browsing / equip / chat / mute toggle | ui-move, ui-select, ui-back                            |
| Pause / resume                                       | ui-back, ui-select; gameplay, music and ambience gated |
| Unavailable boost / unaffordable car / car unlock    | denied, record                                         |
| Waterfront / cable car                               | ambient-gulls, ambient-foghorn, ambient-bell           |
| Reserved end-of-round / high score API               | finish, record (normal driving is endless)             |

`src/fx/sfx.ts` owns mix levels and cue cooldowns. Music is a quiet original
108 BPM sine-pluck pattern, mixed below the motor. The old saw/square engine, gearbox clunks, harsh
screech, glass crash stack and announcer voices are gone.

## Processing

For the two driving loops, generate steady WAV originals and process only those files:

```sh
node tools/generate-driving-audio.mjs /tmp/driving-originals
node tools/prepare-sfx.mjs /tmp/driving-originals engine-loop road-loop
```

The motor uses phase-locked 140/280/420 Hz harmonics with faint filtered air. Road
sound is steady filtered noise. Both run for 8 seconds before seam processing.
The motor crossfade is 100 ms (exactly 14 cycles); road uses an equal-power
100 ms crossfade. No detuning, ticking, amplitude gating, or rhythmic modulation.
Speed and load change pitch/gain smoothly in the game.

For the remaining 30 clips, download each completed request with `vg generate status <endpoint> <request_id>
--download /tmp/originals/<name>.mp3 --json`, then process the named clip from the game directory:

```sh
node tools/prepare-sfx.mjs /tmp/originals <clip-name>
```

Requires Node and ffmpeg with libopus. Trims only outer silence on one-shots,
adds 5 ms attacks / 20 ms releases, crossfades loop seams over 80 ms, targets
-19.6 dBFS RMS for loops and -16.5 dBFS RMS for cues with a -2.5 dBFS pre-encode
peak ceiling. Transient headroom takes priority over RMS. Delivered Ogg Opus
files are decoded again and checked for finite PCM and clipping headroom.
The runtime adds another gain stage; these are asset levels, not speaker SPL.

All six loops have quiet procedural fallbacks. One-shots use short sine plucks
if an asset fails; failed files appear in `sfx.diagnostics().bank.failed`.
Late downloads adopt current loop state, never replay missed cues. Cooldowns
and a 12-voice cap bound overlap. Hidden tabs suspend the AudioContext;
returning to a paused game preserves pause. Sound still defaults to off.

## Verify

```sh
pnpm typecheck
node tools/verify-sfx.mjs 'http://localhost:5193/?time=noon&offline=1' /tmp/waymo-sfx
```

The browser harness exercises real controls plus staged passenger/garage states.
Headroom checks verify signal levels; final tone preference still needs listening.
