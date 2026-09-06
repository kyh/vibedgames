# AAA completion goal

The goal remains the full collection at AAA finish quality within each game's
existing art direction. Previous polish passes are the starting point, not the
completion criterion. Continue implementing and verifying the gaps below; do not
close the goal merely because a pass or test suite finishes.

Preserve core gameplay, asset/video animation and hand/face/pose/pointer/touch/
controller inputs. Optional new modes add depth without replacing the normal
rules. Keep Crazy Waymo's separate work intact while checking it as the reference.

## Completion evidence

1. **Presentation:** coherent world, characters, lighting/materials, interface and
   transitions at desktop, portrait and short landscape sizes. Full-session
   captures must show clear threats and player silhouettes under peak effects.
2. **Animation and feedback:** authored anticipation, action, impact, recovery and
   outcomes wherever the current characters need them. Preserve the existing
   animation medium. Responsive inputs cannot wait for decorative animation.
3. **Sound:** purposeful music, ambience and event hierarchy; useful quiet moments,
   controlled peaks, no masking of threats, and reliable mute/pause/lifecycle.
   Inspect actual rendered mixes as well as source ownership and budgets.
4. **Session depth:** clear first action, progression/mastery, memorable pacing and
   useful reasons to replay. Implement the per-game features below, then assess
   complete sessions instead of isolated screenshots.
5. **Reliability:** real connected clients agree on play, winners, rewards and
   restart state through transport loss, host migration and late joins. Saves,
   navigation, input recovery and repeated sessions retain their contracts.
6. **Performance and access:** measured load/frame/input behavior, explicit quality
   controls where needed, reduced motion and readable layouts. Verify camera,
   touch and controller paths with the strongest available device evidence;
   synthetic traces alone cannot prove physical recognition or thermal behavior.
7. **Integration:** meaningful permanent regressions, scoped builds, full repository
   verification and a final requirement-by-requirement audit. No completion claim
   while a required item lacks adequate evidence.

## Implementation queue

One game at a time. Cross-game primitives only when actual callers justify them.
Each row includes the existing polish/graphics baseline plus the remaining work.

| Game                  | Work to finish                                                                                        | Current work                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Ancients of Eldermoor | Crowded team silhouettes; full-match sound/pacing/readability                                         | Combat, settings, soundscape and live multiplayer verified locally            |
| Battle Arena          | Match/handoff reliability; champion animation continuity; consistent arena materials/lighting         | Live multiplayer, animation, materials and hardware combat verified locally   |
| Bomberman             | Character anticipation/recovery/victory animation; encounter/result sound mix; optional arena variety | Acting, score, arenas, live recovery and hardware chains verified locally     |
| Starfall              | Authored battle escalation and quiet intervals; weapon-specific trials; dense-combat performance      | Battle score, real weapon trials, live recovery and hardware combat verified  |
| Lunerfall             | Enemy anticipation/recovery; portrait hub composition; complete co-op expedition and boss pacing      | Original acting, responsive hub, live co-op/versus and hardware load verified |
| Farm                  | Character/tool transition continuity; seasonal collection goals; complete day/mine/save pacing        | Original acting, journal, saves, live pause and hardware scenes verified      |
| Pong                  | Spin teaching/practice; optional trick-shot mastery; full local/connected match feel                  | Practice, camera recovery, live matches and hardware rendering verified       |
| Flappy Dragons        | Distinct forest landmarks; seeded challenge routes; pose recovery and full-flight pacing              | Route, camera recovery, live races and hardware flight verified locally       |
| Pacman                | Musical escalation; optional maze challenges; camera recovery and complete chase pacing               | Camera/audio ownership and shared-board completion next                       |
| Tetris                | Advanced spatial teaching; seeded score challenges; camera recovery and full-run pacing               | Queued                                                                        |

Ancients' reconnect, host migration, ended results and late joins passed live
two-client checks. [Authority evidence](/Users/kyh/.codex/visualizations/2026/09/05/01a072e5-b121-77b0-b7f7-52a06ec3e9e2/aaa-completion/moba-authority/README.md)
closes that milestone only.

Ancients now also has verified crowd readability, explicit presentation settings,
connected pause recovery and adaptive score ownership. [Presentation evidence](/Users/kyh/.codex/visualizations/2026/09/05/01a072e5-b121-77b0-b7f7-52a06ec3e9e2/aaa-completion/moba-presentation/README.md) records captures, checks and device/audio limits.

Battle Arena plan: server-elected authority and accepted-state adoption; preserve
human seats through bot replacement; phase-correct existing champion clips and
bounded recoil; then consistent owned floor materials and matched lighting.
Original models, strike timing, combat and all control paths stay intact.
Unresolved questions: none blocking this pass.

Battle Arena's local pass is complete. [Evidence and matched captures](/Users/kyh/.codex/visualizations/2026/09/05/01a072e5-b121-77b0-b7f7-52a06ec3e9e2/aaa-completion/battle-arena/README.md)
include real multiplayer/rematches, permanent animation/material/FX/HUD checks,
and Apple M1 Max combat measurements with explicit device limits.

Bomberman plan: generated placement and victory sheets matching the original
character; bounded accepted-event animation; sparse score and distinct result
mix; opt-in Crossroads central lanes. Classic grid/RNG and original walk/fire
remain intact. Verify actual connected pause, arena selection and rematches.
Unresolved questions: none blocking this pass.

Bomberman's local pass now includes native connected pause/late join, remote
acting, host-only arena choice, guest rematch, missed-round reconnect and host
migration. [Evidence and captures](/Users/kyh/.codex/visualizations/2026/09/05/01a072e5-b121-77b0-b7f7-52a06ec3e9e2/aaa-completion/bomberman/README.md)
record generated sheets, live audio, touch emulation and Apple GPU chain loads.

Starfall plan: measure the existing dense battle first; choreograph background
broadsides and musical rests around its existing waves and boss warnings; add
optional seeded Railgun alignment and Glaive return-path trials. Trials use real
pickups, real contacts and the existing20-second weapon lifetime. Preserve normal
spawn pacing, all26 weapon rules, existing vector art and all controls.
Unresolved questions: none blocking this pass.

Starfall's local pass is complete. [Evidence and matched captures](/Users/kyh/.codex/visualizations/2026/09/05/01a072e5-b121-77b0-b7f7-52a06ec3e9e2/aaa-completion/starfall/README.md)
cover actual trial expiry/retry, live score and reduced motion, real reconnect/
handoff, and matched Apple GPU combat with measured tail-frame limits.

Lunerfall plan: align original enemy/boss action frames to existing damage
windows; give the hub readable portrait controls and persistent receipts;
synchronize visible merchant/shrine offers; add complete typed expedition
checkpoints, stable seats and neutral pause/reconnect input. Preserve original
atlas bytes, combat/RNG behavior and landscape gameplay camera.
Unresolved questions: none blocking this pass.

Lunerfall's local pass is complete. [Evidence and captures](/Users/kyh/.codex/visualizations/2026/09/05/01a072e5-b121-77b0-b7f7-52a06ec3e9e2/aaa-completion/lunerfall/README.md)
cover original-atlas contact timing, native hub/forge/receipts, real co-op and
versus recovery, terminal outcomes, recorded sound, Apple GPU load and the full
repository gate. Original assets and core combat rules remain intact.

Farm plan: preserve the existing tool strips and impact times; tighten action
ownership and accepted-harvest feedback; add a personal seasonal crop/fish
journal using original icons; improve season rollover and mine receipts inside
existing transitions. Make failed saves visible and final audio/input/session
cleanup reliable. Preserve yields, prices, damage, farming/fishing rules and all
inputs. No crate carrying or rolling mechanics.
Unresolved questions: none blocking implementation.

Farm's local pass is complete. [Evidence and captures](/Users/kyh/.codex/visualizations/2026/09/05/01a072e5-b121-77b0-b7f7-52a06ec3e9e2/aaa-completion/farm/README.md)
cover original acting, native seasonal journal and touch scrolling, real farming/
fishing/day/mine/save flows, two-client pause and final cleanup, recorded audio,
matched Apple GPU load and the full repository gate. All80 original assets stay.

Pong plan: preserve the ink-and-paper court and existing curve physics; teach
accepted curves and add optional offline practice; repair camera retry/focus and
final ownership; retain admitted guest orientation across transport gaps. Verify
real local/connected contacts, results/rematches and original input paths.
Unresolved questions: none blocking implementation.

Pong's local pass is complete. [Evidence and captures](/Users/kyh/.codex/visualizations/2026/09/05/01a072e5-b121-77b0-b7f7-52a06ec3e9e2/aaa-completion/pong/README.md)
cover native accepted curve practice, camera denial/retry and final ownership,
all original input paths, actual two-client curves/results/three rematches and
reconnect/election, four responsive sizes, matched Apple GPU frames and recorded
audio. All 33 regressions pass; 4,822 simulation samples match the saved baseline.

Flappy Dragons plan: preserve the four-frame dragon art, forest palette, all pose
methods and original flap/race rules. Finish final scene/camera ownership and
paused-controller fencing; verify real race recovery; add an optional fixed-seed
solo route and sparse forest landmarks using the existing course generator.
Unresolved questions: none blocking implementation.

Flappy Dragons' local pass is complete. [Evidence and captures](/Users/kyh/.codex/visualizations/2026/09/05/01a072e5-b121-77b0-b7f7-52a06ec3e9e2/aaa-completion/flappy-dragons/README.md)
cover native ten-gate Canopy Trail completion and retry, a generated landmark
sprite matching the original forest, camera recovery and unchanged pose traces,
real races/reconnect/election/late join, touch with expanded-camera layouts,
bounded effects, matched Apple GPU flight and lossless recorded audio. All89
original assets and the original flight/race rules remain intact.

Pacman plan: preserve its plush maze, original lullaby and face/step/turn rules;
finish paused-input, camera and audio ownership; fix stale shared-board claim
rollback; add restrained chase mixing and an optional original-maze Pearl
circuit. Verify real claims, host recovery, full chase and native input paths.
Unresolved questions: none blocking implementation.

After individual work, compare the collection for quality consistency and close
remaining shared device, audio and multiplayer issues. Production publishing is
separate from the local completion goal.

Unresolved questions: none blocking implementation.
