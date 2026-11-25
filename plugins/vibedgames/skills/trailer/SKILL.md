---
name: trailer
description: "Plan, capture, cut and review a game trailer or gameplay montage: make the game filmable (stepped clock, seeds, director camera, clean feed), a shot list on a measured music grid, frame-stepped capture with real slow motion, music/VO/SFX through `vg generate`, and measurable gates before anyone watches. Use for a launch trailer, reveal, teaser, store video, social cut or highlight montage."
---

# Trailer and montage

A trailer is the game's first impression for everyone who hasn't played it.
The common failure is not bad editing; it is a feature list at 60 fps with no
story, shot from a game that can't repeat a take. Work in three stages, and
run the review on every cut:

1. **Make the game filmable**: [references/capture-hooks.md](references/capture-hooks.md)
2. **Plan**: archetype, music grid, story, shot list. [references/plan.md](references/plan.md)
3. **Make and review**: capture, cut, mix, then the gates.
   [references/gates.md](references/gates.md)

Shot language, lenses and camera moves: `cinematography`. Multi-shot
continuity and storyboards: `storytelling`. Chaining generation steps (music,
VO, a generated establishing shot): `media-workflow`. The game's own sound:
`audio`.

## Settle the inputs in one message

Infer everything you can from the repo first (name, genre, engine, palette,
existing music, logo). Then ask **once**, at most four questions, each with a
default so silence means go:

- **Archetype and length.** Default for a browser game: a 45–75 s launch
  trailer, plus 15 s and 30 s vertical cuts.
- **Format.** Default 1920×1080, 60 fps, 16:9; vertical 1080×1920 for
  shorts. 30 fps for App Store previews.
- **Music.** Their track wins. Otherwise offer two or three candidates
  (the game's own score, or generated with `elevenlabs/music/v2.5`) as short
  excerpts with a default. Never "what music do you want?".
- **Spend.** Generation is billed to their vibedgames credit. State what will
  be generated (music, VO, any video) and the likely cost from
  `vg generate pricing <id> --json`, and get a yes before the first paid call.

Log the answers, and any defaults you took, in `trailer/DECISIONS.md`.

## The order of work

1. **Freeze the build.** Record the commit and deployment the film shoots
   from. The game keeps shipping; the film works from this snapshot.
2. **Measure two reference trailers** of the same genre (cut rate per section,
   first voice line, first enemy, title time, silences, share of first
   person). References are for measuring only: never recreate another
   studio's shots, characters or logo.
3. **Choose and measure the music**: tempo, bar map, drops, holes, ending.
   Write `trailer/grid.json` (time of every beat and bar) and verify it with a
   click track mixed over the song.
4. **Map what the game can film** (the hooks checklist) and audit every
   animation, enemy and effect you plan to show on recorded frames, at
   quarter speed. Don't plan a hero shot around an animation nobody has
   watched.
5. **Write the story, then the shot list** (`trailer/shots.json`), then a
   storyboard page (publish it as an artifact if the person wants to review).
6. **Capture** each shot as code: scripted input, a seed, a director camera
   path, speed keys on the beat grid, frame-stepped to PNG or straight into
   ffmpeg.
7. **Grade and title in the engine** at capture (the grade is the game's own
   post chain; the title is the game's logo placed in the world of its shot,
   not a sticker over the frame), then **cut and mix hosted**: upload the
   takes and stems and lay them on the grid with `fal-ai/ffmpeg-api/compose`
   (one video track, any number of audio tracks, each keyframe a URL, a start
   and a duration in ms), or join takes in order with
   `fal-ai/ffmpeg-api/merge-videos` and lay the mix on with
   `fal-ai/ffmpeg-api/merge-audio-video`.
8. **Gate the cut** (`references/gates.md`), then get a fresh reviewer that
   didn't build it (`game-playbook` → `references/critic-loop.md`), then the
   person. Log their notes word for word.

## Rules that decide the score

- **Story, not a feature list.** A hook in the first 3 s, a promise, an
  escalation, a turn, a payoff with its impact frame on screen, and a button
  (one beat after the title that rewards a rewatch). At least one character
  moment and one moment only this game can do.
- **One whole action per shot.** Enter on the wind-up, cut after the payoff
  lands. A payoff sits 1–3 frames before its beat. Never cut within 6 frames
  before an impact.
- **The camera always moves**, with a reason, from the first frame of a shot
  to the last. Warm the rig 3 frames before frame 0 so the cut frame moves too.
- **Real slow motion only.** Slow the simulation and capture more frames;
  never interpolate frames or slow a 60 fps recording. Ease into and out of
  every speed ramp.
- **Designed silences.** Two to four holes (near-silence, then a hit at least
  15 dB up). The loudest moment is the boss or the title, never a mid-film
  feature.
- **Nothing cheap on screen.** No placeholder meshes, idle characters, debug
  text, frame counters, white-out effects, or HUD the plan didn't ask for.
- **Keep the person's words.** A paraphrase that strengthens a note ("sick
  depth of field" → "shallow DOF everywhere") produces the wrong fix.

## Deliverables

`trailer/master-1080p60.mp4` (H.264 high, ~12–20 Mbps, AAC 320k, −14 LUFS
integrated, true peak ≤ −1 dBTP), the vertical cuts, a poster frame, and
`trailer/PLAN.md` with the shot list and decisions. Publishing the film
(stores, socials, a portal page) stays with the person: those accounts are
theirs.
