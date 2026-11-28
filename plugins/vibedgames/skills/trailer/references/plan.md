# Planning the film

## Pick the archetype

| Archetype         | Length      | Shape                                                        |
| ----------------- | ----------- | ------------------------------------------------------------ |
| Launch trailer    | 45–75 s     | hook, promise, escalation, turn, payoff, title, button       |
| Gameplay reveal   | 60–120 s    | one continuous-feeling run, light editing, real HUD allowed  |
| Teaser            | 15–30 s     | one question, one image, the title                           |
| Store preview     | 15–30 s     | the core loop in the first 5 s, no logos first, 30 fps (iOS) |
| Social / vertical | 15–30 s     | 9:16, hook in the first second, captions burned in           |
| Montage           | song length | skilled play cut to a song, payoffs evenly spaced, no holes  |

A **montage** inverts several trailer rules: the song is never edited, there
are no designed silences, and payoffs (kills, combos, saves) sit on an even
read-time grid (one every 2–4 bars) so each lands before the next.

## Music and the clock

- Order of preference: the person's track, the game's own score, music they
  own or licensed, then generated (`elevenlabs/music/v2.5`; give it a
  structured prompt per section: intro, build, drop, break, outro, with
  durations that match your edit).
- Measure it fully: BPM, the bar map, drops, holes, the ending. A generated
  track's tempo and sections are what its prompt asked for; for any other
  track, find onsets in the page (decode it with `decodeAudioData` and look
  for jumps in 10 ms RMS). Write `grid.json` and verify by mixing a click on
  every beat and checking it against the song.
- Edit only on downbeats at phrase boundaries. Take a ring-out from the song
  if it ends abruptly.
- Plan the 2–4 designed silences and where the loudest moment lands.

## Story

Write these six beats as one line each before any shot:

1. **Hook** (0–3 s): a question or an image.
2. **Promise**: what the player gets to do.
3. **Escalation**: more, bigger, faster.
4. **Turn**: something changes (a betrayal, the boss, the world flips).
5. **Payoff**: the biggest moment, its impact frame on screen.
6. **Button**: one beat after the title that rewards a rewatch.

Add one character moment (a look, a reaction, a line between characters) and
one signature moment only this game can do.

## The film's language

One page: allowed cuts and transitions, the ramp recipe (e.g. 1.0 → 0.25 over
6 frames into the hit, hold 24–36 frames, back to 1.0 over 8), camera rules,
HUD policy (default none), text policy, a one-sentence colour script per act,
sound rules. Ban editorial effects the game doesn't render itself (fake shake,
post blur, light leaks).

**Voice**: characters, not an announcer. About 5–8 lines a minute, each on the
shot of its speaker or the thing it names. The game's own lines first; new
lines through `elevenlabs/tts/eleven-v4`, voices chosen by the person from
samples.

## The shot list

`shots.json`, one row per shot:

```json
{
  "n": 7,
  "frames": [1440, 1560],
  "bars": "9.1–10.1",
  "view": "third",
  "action": "hero dashes through the gate as it slams",
  "payoff": [1548],
  "beat": "10.1",
  "camera": { "path": "dolly-left", "fov": 40, "speed_px_f": [6, 14] },
  "speed": [
    [1500, 1.0],
    [1506, 0.25],
    [1536, 0.25],
    [1544, 1.0]
  ],
  "sound": ["gate_slam@1548"],
  "voice": null,
  "seed": 7,
  "reason": "first turn"
}
```

- Vary shot lengths from half a beat to four beats; no more than four equal
  lengths in a row; tighten into the drop; one long breath on the hero reveal.
- A shot that introduces a mechanic holds at least 70–90 frames.
- First person 25–40% of the film if the game has it.
- Keep every version of the list; diff them when notes arrive.

## Pre-mortem

Before capturing, run the plan against every gate in `gates.md` and fix what
the plan already fails. Then give the storyboard alone to a fresh critic and
filter its notes through the rules here; log what you rejected and why. Send
the person the open decisions in one message, each with a default.
