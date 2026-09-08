# Extend normal play

User direction: new mechanics belong in ordinary play. Do not add a second
mode, challenge selector or practice entry point. Preserve each game's assets,
animation medium, core controls and existing character/multiplayer choices.
This supersedes the optional-mode plans in `aaa-completion-plan.md`.

| Game           | Change                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Flappy Dragons | Count and celebrate actual gate milestones in ordinary flights; remove fixed-route mode and its separate records. |
| Pacman         | Keep full-maze play, pearl chains and chase feedback; remove the short circuit, marked subset and early finish.   |
| Pong           | Charge each return for fist power shots; paddle contact controls slice/topspin; keep instructions off the court.  |
| Starfall       | Track mastery for weapons acquired during normal battles; remove selectable seeded trials.                        |
| Bomberman      | Introduce arena variety through normal round progression; remove new arena selection.                             |
| Tetris         | Keep random bags, spatial teaching and HOLD feedback; remove fixed-sequence selection and separate records.       |
| Ancients       | Retain integrated combat, ability and objective improvements; no new gameplay mode.                               |
| Battle Arena   | Retain integrated combat, loadout and objective improvements; preserve original champion selection.               |
| Lunerfall      | Retain expedition/relic progression in the existing run.                                                          |
| Farm           | Retain farming, mine, fishing and skill progression in the existing save.                                         |

Work one game at a time. Verify ordinary start, accepted actions, loss/retry,
compact layouts and affected multiplayer paths. Preserve unrelated regression
coverage. Commit and push through the existing PR327.

Flappy complete: native normal flight earned 10 gates and 9 coins, continued
playing, crashed naturally and retried with a fresh course and zero gates. Phone
start and compact results pass. Actual two-client races retain shared seeds,
pause/reconnect/host migration and automatic respawns. All 90 assets stay exact.
Full verification and build pass.

Pacman complete: normal keyboard/touch play and full-maze restart pass. A staged
28-pearl subset leaves the game running; only the final maze pearl wins. Compact
results fit with the camera open. Actual two-client claims, reconnect, host
migration and host-authorized full-maze rematch pass. All assets stay exact.
Full verification and build pass.

Pong update: replace flick shots with four-return charge and a fist-triggered
power return. Left-third contacts slice; right-third contacts add faster, lower
topspin. Preserve hand steering and mouse/touch/controller fallbacks. Instructions
move into the pause menu; serve/rematch stays at the court edge. Validate accepted
contacts, power consumption, guest ownership/rearming, pause/reconnect/migration,
compact layouts and normal first-to-seven rematches.

Starfall complete: staged ordinary items activate mastery through real pickup
handling; native railgun and glaive shots complete their techniques through real
contacts. Stacking retains progress and the actual weapon deadline. Compact HUD,
pause and death pass. Actual two-client pickups and guest shots credit only the
local owner; spectator pause retires that feedback. No trial world setup remains.
Assets, audio and core weapon/world rules stay exact. Full verification and build pass.

Bomberman complete: native Play starts Classic; real two-client guest/host
rematch requests advance Crossroads then Classic. Native movement/bomb placement
and a staged blast finish retain ordinary results. Compact results fit. Reconnect
and host migration preserve the accepted grid; duplicate/stale request tests
prevent extra rotation. Art, video acting, clocks, fuse and core rules stay exact.
Full verification and build pass.

Tetris complete: native ordinary random-bag play, HOLD, natural stacking loss,
normal best and retry pass. Compact results retain one Play again button. Real
WebGL loss/restoration preserves title, orbit, paused collapse, catch and original
camera ownership; final teardown releases everything. Engine, assets and input
detectors stay exact. The seeded generator now exists only in test fixtures.
Full verification and build pass.

All six mode corrections are complete. Farm, Lunerfall, Ancients and Battle Arena
already integrate their additions into normal sessions and remain unchanged.

Unresolved questions: none.
