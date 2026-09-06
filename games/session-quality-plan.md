# Complete-session quality pass

The art and VFX passes are complete. This pass brings the rest of each game up
with them: a clear first action, purposeful sound, readable stakes, a satisfying
ending and a clean return to play. Implement and verify one game before the next.

Keep every game's visual identity, existing assets and video animation. Preserve
camera, hand, face, pose, pointer, touch and controller paths. No changes to core
rules, combat timing, rewards, network authority or save contracts. Crazy Waymo
remains the reference; its separate ongoing art work is outside this pass.

## Order and concrete scope

| Order | Game                  | Implementation                                                                                                                                         | Status   |
| ----- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| 1     | Pong                  | Ink-native start/results with Serve/Rematch and longest rally; labeled score beats and visible sound state; accurate reconnect and live-pause copy     | Verified |
| 2     | Flappy Dragons        | Staged crash/results/retry; clear pose readiness; distinct countdown/milestone/new-best sound using existing samples                                   | Verified |
| 3     | Farm                  | Owned mute/pause/music lifecycle; contextual action feedback with bounded notices; actual shipping/day recap and saved-day continuation                | Verified |
| 4     | Pacman                | Brief accepted-input teaching; cosmetic capture/reappearance/victory transitions; useful solo/race result summary                                      | Verified |
| 5     | Tetris                | Clear spatial-rule teaching and real rescue-window meter; bounded mute/pause-safe audio with distinct clear/power/rescue phrases; complete run summary | Verified |
| 6     | Lunerfall             | Truthful hub run recap; edge-driven door unlock response; boss/priority banners and pause-safe owned audio                                             | Verified |
| 7     | Ancients of Eldermoor | Bounded audio with distinct spell families; objective announcement ordering; existing hero stats and portrait in results                               | Verified |
| 8     | Battle Arena          | Correct local win/loss music resolution; bounded priority announcements; coordinated champion selection and outcome presentation                       | Verified |
| 9     | Bomberman             | Courtyard-matched start and round results; render-only character/pickup response; spatial blast audio and round cadence                                | Verified |
| 10    | Starfall              | Sparse state-driven music with audio headroom; once-per-encounter boss cues; coherent recovery and sector handoff presentation                         | Verified |

## Per-game acceptance

- **Pong:** start, real serve/return, score, win/loss and three rematches; longest
  rally follows authoritative contacts and survives repeated snapshots; original
  hand/flick and peer seams; live pause never promises frozen play.
- **Flappy Dragons:** solo crash/retry and race respawn retain their existing
  timing; same seeded course and pose velocities; camera retry consumes its own
  input; sound follows mute/pause; results fit a phone.
- **Farm:** already scheduled notes stop at mute/pause; one music scheduler after
  repeated mine/farm changes; recap reads actual completed transactions; no second
  reward; blocked actions remain understandable; save/yield/fishing rules match.
- **Pacman:** identical synthetic face step/turn traces; no delay to logical
  capture/respawn; solo lives and shared resets unchanged; result counters reset
  correctly; repeated snapshots do not replay celebrations.
- **Tetris:** smoke suite passes; displayed rescue time uses the actual deadline,
  including pause adjustment; failed catch never celebrates; immediate mute;
  clear intersections count once; restart resets summaries and effects.
- **Lunerfall:** five heroes and current biomes remain valid; door updates do not
  restart presentation every snapshot; death returns on the existing deadline;
  recap never re-banks rewards or invents guest earnings; critical banners win.
- **Ancients of Eldermoor:** six hero families, local/distant casts, simultaneous
  objective notifications, victory/defeat, three menu/match cycles; preserve host
  capture/feed/view order and offline-only freeze; phone result readability.
- **Battle Arena:** both local outcomes, sudden death with overlapping objectives,
  keyboard/touch selection, reduced motion, result/pause/disposal; preserve strike
  timing, camera and adaptive rendering; existing timing/particle checks pass.
- **Bomberman:** start creates no bomb; eliminated players remain distinct from
  final round results; actual pickup and guest baseline semantics; chain audio
  stays bounded; win/draw/restart and all arena corners fit both phone orientations.
- **Starfall:** first snapshot establishes a boss baseline; arrival/phase cues do
  not repeat on camera re-entry; death/respawn deadlines and sector awards remain;
  music/voices stop on pause/shutdown; threat readability and FX reserve gates pass.

For every game: typecheck, build, relevant existing simulations, a complete browser
session and responsive visual inspection. Rare states may use explicit development
fixtures; report them as fixtures. Keep previous verified work intact. Run the full
repository gate after integration. Changes stay local.

## Quality still requiring a human/device session

Browser tests establish behavior, cleanup and layout. They do not establish
physical-camera recognition, phone input latency, sustained GPU/thermal behavior,
subjective sound mix or fun. Those are release gates, not reasons to defer the
authorized implementation. More optional mechanics should follow playtesting.

Unresolved questions: none blocking implementation.
