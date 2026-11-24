---
name: ship-ready
description: "Make a browser game release-grade: smooth frame-time tails, fast cold and warm loads, real-phone memory and touch, zero crashes, and accessibility (remapping, subtitles, colour-safe signals, reduced motion, flashes). Use when it stutters, loads slowly, crashes or goes blank on phones, before a launch, or when the person asks about accessibility."
---

# Ship-ready

A game that plays well on the builder's laptop is not finished. A stranger's
first visit is a cold load on an ordinary machine or a phone, with a gamepad
or a thumb, and maybe without sound or colour vision. This skill is the release
gate for that visit. Each area has a reference with the rules and the checks:

| Area          | Read                                                       | Symptom                                       |
| ------------- | ---------------------------------------------------------- | --------------------------------------------- |
| Frame time    | [references/performance.md](references/performance.md)     | stutter, hitches, a slow menu, laggy mouse    |
| Loading       | [references/loading.md](references/loading.md)             | long blank, stuck bar, slow return visit      |
| Phones        | [references/mobile.md](references/mobile.md)               | tab reloads, silence, stuck touches           |
| Crashes       | [references/stability.md](references/stability.md)         | freezes, black screen, breaks after a deploy  |
| Accessibility | [references/accessibility.md](references/accessibility.md) | can't remap, can't hear cues, motion sickness |

Engine specifics live in `threejs` (→ `references/debugging-and-profiling.md`)
and `phaser`. Touch controls and pads: `gamepad`. Native wrappers and portal
limits: `distribute`. Verifying any of this in a real browser: `playtest`.

## Rules that hold across all five

- **Measure on the player's path.** Built game (`vite build && vite preview`
  or the deployed URL), entered through the real menu, with real input, cold
  cache for load numbers. A dev-server number is a dev-server number.
- **Report the spread, not the average.** Frame time as median, p95, p99 and
  the worst frame; load as cold and warm. An average with no spread is not a
  result.
- **Prove the instrument.** Before trusting a check, plant the fault it looks
  for (a per-frame allocation, a missing file, a stuck touch) and see it fail.
  A check that examined nothing fails.
- **Phones are measured on phones.** Emulation results are labelled emulation.
  If no real device is available, say the phone claim is unverified.
- **Nothing degrades silently.** A lower tier, a fallback renderer or a missing
  file is visible in the log and, where it changes what the player sees, to
  the player.

## Release gate

- [ ] Frame-time budget met on a mid-range laptop: p99 ≤ 2× median, no frame
      over 50 ms after warm-up, nothing allocates per frame in steady play.
- [ ] Cold first visit reaches an interactive title in ≤ 3 s on a fast 4G
      profile; second visit downloads almost nothing.
- [ ] Ten full runs with real input, no crash, freeze, self-reload or stuck
      input; WebGL context loss recovers.
- [ ] On a real phone: plays in landscape, sound on first touch, every touch
      release seen, tab survives a full session.
- [ ] Remappable controls that swap on conflict; important sounds also shown;
      colour never the only signal; no photosensitive flashes; reduced motion
      honoured; pause works without Escape.
- [ ] Every claim marked observed, emulated or unverified.
