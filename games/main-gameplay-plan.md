# Extend normal play

User direction: new mechanics belong in ordinary play. Do not add a second
mode, challenge selector or practice entry point. Preserve each game's assets,
animation medium, core controls and existing character/multiplayer choices.
This supersedes the optional-mode plans in `aaa-completion-plan.md`.

| Game           | Change                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Flappy Dragons | Count and celebrate actual gate milestones in ordinary flights; remove fixed-route mode and its separate records. |
| Pacman         | Keep full-maze play, pearl chains and chase feedback; remove the short circuit, marked subset and early finish.   |
| Pong           | Keep curve physics and teach accepted contacts during normal matches; remove separate practice.                   |
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

Unresolved questions: none.
