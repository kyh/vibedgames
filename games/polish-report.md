# Game polish verification

Local implementation and playtest evidence for [the rollout](polish-plan.md).
No releases made. Physical webcam recognition and phone GPU performance are not
established by synthetic-input or desktop browser checks.

The subsequent [Bomberman and Starfall graphics pass](graphics-upgrade-report.md)
has separate assets, captures and verification evidence.

## Pong

Implemented: deliberate flick curves through existing steering inputs, ink-native
spin trail/contact accents, shot and match-point cues, system reduced motion.
Existing camera recognition, ordinary return angles, speed ramp and scoring remain.

- Typecheck, lint, format and production build pass.
- Seven spin tests pass: ordinary tracking, coherent flicks, source/reacquisition
  resets, forward/speed bounds, 30/144 Hz integration, peer bounds and recent-motion
  regression. Review caught and fixed earlier tracking diluting a later flick.
- Real browser input paths: pointer return produced spin 0.424; synthetic hand
  return produced spin 0.369. Post-return speed stayed 7.45 world units/second.
- Pause/resume clears stored flick; reduced-motion camera stays still; fail-state
  fixture followed by fist confirmation restores a 0–0 rally.
- Two live local clients: guest confirmation served, normal simulation scored and
  reached seven, then guest confirmation rematched. A staged incoming ball plus
  synthetic guest hand motion produced spin 0.640 on the host; guest received the
  same spin and its own curve-shot cue. No uncaught errors on either client.
- Headless camera permission was denied. That existing browser restriction was
  explicit; synthetic hand checks do not verify physical recognition.

Screenshots captured before and after; transient evidence is in `/tmp/pong-before.png`
and `/tmp/pong-after-spin.png`. The latter stages match point to inspect the cue.
Portrait layout at 390×844 has no horizontal overflow and the start hint fits.
That viewport check retained desktop input capabilities.

## Flappy Dragons

Implemented: capped pixel wingbeat/trail particles, forest leaves, coin glints and
pickup rings, five-point milestones, crash/new-best feedback. Camera denial becomes
a compact retry pill. Existing sprites/video, physics and pose recognition remain.

- Typecheck, build, format and diff checks pass; lint has zero errors and three
  existing warnings.
- Synthetic pose flight for thirteen seconds scored six, including two coins.
  Portrait play at 393×852 continued to eight, rebuilt visible pipes after resize
  and produced no horizontal overflow.
- Natural death showed `NEW BEST 8`; retry reset score, restored countdown and
  cleared the old notice.
- Pose velocities match baseline: strength zero −480, strength one −720,
  half-strength refire −600. Refire adds no duplicate wingbeat effect.
- Reduced motion suppresses ambient/wing particles and rings while retaining full
  pose control. Enter/Space camera retry no longer starts/flaps the game on release.
- Particle saturation regression: filled 36/64/12 slots, let all expire naturally
  after 6.59 seconds, then refilled each pool without allocation growth. Fixed
  Phaser's total-particle cap blocking dead-slot reuse.
- No browser/page errors. Physical webcam and genuine touch input remain untested;
  the portrait check retained desktop input capabilities.

Transient screenshots: `/tmp/flappy-desktop-playing-after.png` and
`/tmp/flappy-portrait-playing-after.png`.

## Bomberman

Implemented: placement pop, fuse sparks, bounded smoke/embers/scorches and crate
chips around the existing generated fire animation. Added procedural sound,
keyboard/touch mute and actual-pickup feedback. Core simulation remains unchanged.

- Typecheck, lint, format and production build pass; explicit typecheck now joins
  the repository gate.
- Keyboard movement and bomb placement worked. A fuse held at 2,118 ms through
  an 850 ms pause and detonated after resuming.
- Staged authoritative two-bomb chain produced two blasts and destroyed a crate.
  Blast-destroyed items produced no pickup cue; actual collection increased capacity
  from one to two and emitted one cue. Twenty repeated snapshots replayed no sound.
- Unmute activated WebAudio. Placement used one voice; mute immediately cleared it.
- Stress filled pools to 160 embers, 64 smoke particles and 96 chips; clear returned
  all to zero and a following blast reused slots. Fixed Phaser's total-particle cap
  blocking reuse by reserving slots and limiting live particles instead.
- True touch emulation at 390×844 exposed coarse-pointer controls. Both controls
  measured 44×44 and cleared the player HUD. A real touch unmuted and unlocked audio.
- No page or console errors. Physical phone performance remains untested.

Final captures: `/tmp/bomberman-after-phone-touch.png` and
`/tmp/bomberman-after-final-blast.png`. The blast is a staged render using actual
blast/crate presentation, frozen with 17 embers, 17 smoke particles and 42 chips
alive. It shows the corrected reusable pools; no browser errors occurred.

## Farm

Implemented: scene-owned pools for 144 tool particles and eight item icons,
material-specific dirt/water/leaves/sparks, 96 camera-local weather/season slots,
and accepted-inventory harvest/catch arcs. Existing art, yields, fishing windows,
stamina, save format and world clock remain. Added read-only live diagnostics.

- Typecheck, build, format and diff checks pass; lint has zero errors and nineteen
  existing warnings. Independent source review found no substantive issues.
- A real `tryAction` harvested a staged ripe Parsnip: inventory zero to one, crop
  removed, one reward arc. Full inventory accepted zero and showed zero arcs.
- Staged fishing traversed casting, waiting, bite, reeling and done: fish zero to
  one, one reward arc. Existing 650 ms return-to-idle remains.
- Requested 1,000 particles; active count capped at 144, expired to zero, then
  re-emitted eight. Rain produced 52 motes. Embed pause froze both game time
  (722.0271) and motes; resume advanced time.
- Farm stop removed its pool and update listener. A real mine hit reduced node
  health three to two and emitted seven particles. Descending rebuilt the pool on
  first use; returning removed the mine pool and created fresh farm ambience.
  Carried produce and fish survived both transitions.
- Pollen, autumn leaves, fireflies and snow followed staged season/weather/time.
  Reduced motion hid ambient particles. Keyboard moved 17.57 pixels across fifteen
  frames through the actual input path.
- Corrected portrait at 393×852: player centered at (196.5, 426) after sixty
  active frames, then keyboard moved 12.4006 pixels over forty-one frames while
  staying visible. Fifty snow motes, no horizontal overflow or page errors.
  This retained desktop input capabilities; live multiplayer and physical touch
  remain untested.

Captures: `/tmp/farm-after-rain.png`, `/tmp/farm-after-harvest.png`,
`/tmp/farm-after-snow-portrait-desktop-input.png`. The earlier snow capture had
stale framing from pausing during resize and is excluded from the final gallery.

## Pacman

Implemented: two persistent power-timer meshes, directional wall dust,
ghost-colored capture/arrival poofs and an existing musical-chain HUD. Face
recognition, discrete chomp semantics, score, AI and network paths remain.

- Typecheck, build, lint, format and diff checks pass. Source review found no bugs.
- Nine keyboard steps moved nine cells and scored 100 over 125 frames. Holding
  synthetic mouth-open caused one step; synthetic head turns retained direction.
- Power collection showed 9,817 ms, warning at 1,167 ms changed the arc, another
  heart refilled to 9,817 ms, and expiry hid it. Pause preserved exact timer/frame.
- Ghost contact awarded 200 once and emitted fourteen capture puffs, six arrival
  puffs and five hearts. Four wall puffs all moved away from contact.
- Death followed by mouth retry restored three lives and zero score with no halo.
  An unchanged chain caused zero DOM writes over 200 ms; expiry/game over hid it.
- True touch emulation at 390×844: three native swipes after turning reached cell
  (1,4), scored 80, activated power and chain three. Pause held 8,933 ms/frame 227
  through 350 ms. Native selfie and camera-porthole touches worked.
- Fresh completed-source browser reached playing with no errors. Two temporary
  missing-element errors came from intermediate HMR while paired TS/HTML edits
  were being written; they do not recur on a fresh load. Webcam denial is expected
  in headless checks; physical recognition remains untested.

Captures: `/tmp/pacman-after-power-chain.png`, `/tmp/pacman-after-phone-chain.png`.

## Tetris

Implemented: four bounded drop streaks, 64 exact cell-contact marks, distinct
power/rescue pulses and a quiet height warning. Existing body controls, camera
orbit/correction, gravity pause, collapse physics and catch deadline remain.

- Clear events now expose cells from the existing deduplicated clearing loop.
  No scoring or clearing algorithm changes.
- Core smoke suite passes, including three new assertions: removed-cell count,
  crossing intersection occurs once, and untouched cells are excluded. The existing
  suite is now wired into the package test command and repository gate.
- Independent source review found no substantive bugs in footprints, pooling,
  reset, reduced motion or gameplay preservation.
- Typecheck, production build, test, format and diff checks pass; lint has zero
  errors and two existing warnings.
- Real Space dropped eleven layers: score 22, four locked cubes and four streaks.
  A staged cross-clear emitted fifteen unique contacts, score 222, two lines and
  charge 0.4. Actual F swept three lowest-layer cells at Y=3, scored fifteen,
  spent charge and shifted an upper cube from Y=6 to Y=5.
- A 1,516 ms wrapper pause froze frames/FX and shifted the catch deadline equally.
  Successful catch showed rescue; a dense failed-catch fixture did not. Natural
  expiry reached game over; Enter retry cleared all effects.
- E orbited corner zero to one while holding the 619 ms fall accumulator and Y=11
  during the swing; falling resumed afterward. Synthetic pose moved one cell.
- Twenty full-contact requests stayed capped at 64, expired to zero and refilled
  64 with the scene child count unchanged at 73. Reset cleared every new effect.
- Reduced motion kept score/contact information, hid streaks and stopped rescue
  rise. Synthetic touch-adapter drop, stick, orbit and hold worked; this retained
  fine-pointer capabilities and does not establish physical touch behavior.
- Active portrait at 393×852 kept the current piece within the camera and produced
  no overflow. No page errors; the headless camera-permission failure is expected.

Captures: `/tmp/tetris-after-hard-drop.png`, `/tmp/tetris-after-cross-clear.png`,
`/tmp/tetris-after-power.png`, `/tmp/tetris-after-rescue.png`,
`/tmp/tetris-after-portrait-desktop-input.png`. The clear capture was replaced
following the label-position fix.

## Lunerfall

Implemented: bounded common FX, hero/biome explosion colors, forty-millisecond
dash echoes, local-player camera response and finite room/boss payoffs. Existing
sprite sheets, authored swings, kits, hitboxes and fixed-step/freeze writes remain.

- Eighty simulation checks and production build pass; independent review found no
  substantive bugs in pool, scene, room or guest-event lifecycles.
- All five heroes across biomes one through five retained real J attacks, K
  specials, authored attack clips, movement and dash paths.
- Pools saturated at 192 particles, 32 echoes and sixteen labels, expired to zero
  and refilled. Stress kept scene children at 295. Room teardown cleared effects.
- Six local camera callbacks produced six shakes; the same six remote callbacks
  produced zero. One hundred same-clock local renders created one echo; one hundred
  remote snapshot applications added one more.
- Synthetic guest snapshots: initial dead/cleared state stayed quiet, a fresh
  death produced one payoff, repeated/stale snapshots added none, and the clear
  edge fired once. Missing-boss/return-dead snapshots produced no extra payoff.
- All five boss fixtures awarded 25 gold and biome-scaled score once, then opened
  doors after the existing delay. Elite clear gates worked. Death→selection→retry
  restored four hearts and zero score. Shutdown removed all scene UPDATE listeners;
  restart added exactly one FX listener above the four system listeners.
- Typecheck/build, scoped lint/format and diff checks pass; final browser errors
  were empty. Local special freeze remained 0.06 seconds.
- Active portrait at 390×844 retained the original landscape FIT letterboxing.
  This remains a presentation constraint; no live two-peer or physical-device
  verification is claimed. Rare states used explicit trailer/snapshot fixtures.

Captures: `/tmp/lunerfall-after-boss.png`,
`/tmp/lunerfall-after-portrait-elite.png`.

## Ancients of Eldermoor (MOBA)

Implemented: bounded common decoration, attacker-aware hero colors and nearby
objective camera response. Authored animation sheets, all six kits, damage,
victim reactions, global announcements and threat geometry remain.

- Fixed pools hold 192 images, 32 animated sprites and 32 labels. Common traffic
  leaves one quarter available; important effects can replace common effects.
  Offscreen decoration is culled without suppressing unit reactions.
- Independent review found no substantive regressions in priority, animation
  clocks, reset/shutdown, simulation metadata or network event ordering.
- Twenty-five simulation checks pass, including unchanged damage and source
  identity for all six heroes, plus the absent-source fallback.
- Stress filled common limits at 144/24/24, then important limits at 192/32/32.
  All effects expired and refilled with scene children unchanged at 1,537.
- Authored explosion frame advanced zero to three after 0.2 seconds, preserving
  its original 500 ms duration with one manual animation update.
- Actual Emberhex damage remained 70 before mitigation and 52.5 afterward, with
  orange contact effects. An offscreen hit emitted no decoration but preserved
  recoil and flash. Distant structure destruction caused zero trauma; nearby
  destruction retained 0.85 trauma and four bursts.

- All 22 active abilities across six heroes cast successfully; two passives
  correctly refused active casting. Real basic attacks produced hits with the
  matching hero identity. Viewer selection cleared pools each time.
- Arrow movement advanced X=680 to 770.75 over seventeen frames. Space attack
  lowered a staged target from 10,000 to 9,680.45 HP.
- Offline pause preserved world time 39,200 ms, frame 2,260 and effect age
  0.11667 seconds; all advanced after resume.
- Viewer-to-match and match restart both released the old pool references and
  created fresh 192/32/32 pools. Reset canceled pending delayed bursts.
- Serialized network batches retained hero identity and sequence seven. Existing
  host capture/feed/drain and guest sequence guards were source-reviewed unchanged;
  this was not a live two-peer session.
- Active portrait at 393×852 kept the player visible over 45 frames with zero
  overflow. Desktop input capabilities remained. Page and console errors empty.
- Typecheck, production build, scoped format and diff checks pass; lint has zero
  errors and thirteen existing warnings.

Captures: `/tmp/moba-after-ember-impact.png` (real basic hit against a settled
staged target), `/tmp/moba-after-storm-viewer.png`. The portrait fixture failed
during capture and is omitted; the earlier active portrait checks remain valid.

## Battle Arena

Implemented: particle priority with reserved impact capacity, champion magic-hit
colors and quieter distant contacts. Models, authored clips, real weapon trails,
threat geometry, adaptive quality and shader prewarming remain.

- Independent review found no substantive regressions in replacement/expiry,
  scratch state, attribution, local responses, hit-stop or network ordering.
- Sixty timing checks and four focused particle tests pass. Tests cover both
  pools, reserved capacity, replacement in place, repeated expiry/refill with
  unique live mesh slots, equal-priority retention and scratch-priority reset.
- Ambient traffic leaves 96 of 512 additive slots and 32 of 160 normal slots
  free. Higher priority can replace a lower-priority slot without changing the
  active/free counts. Major effects never evict another major effect.
- Distant noncritical contacts emit three sparks and less camera trauma; local
  hits, victim feedback, criticals, audio and damage numbers retain their responses.
- Actual W movement traveled 4.779 units over 0.8 simulation seconds; Digit1
  advanced Mage Q cooldown through the real input path.
- Saturation held 416 additive and 128 normal ambient particles. A local hit
  replaced thirteen ambient slots with major particles while retaining audio,
  damage number, 25 ms freeze and local hit accounting. A local kill retained
  eighteen additive/four normal major particles, 100 ms freeze and one kill sound.
- Far remote contact retained audio and a damage number with three particles;
  local victim feedback retained thirteen major particles. Mage contact matched
  the existing orange palette. Expiry returned both active counts to zero.
- All six champions landed actual basics and cast ultimates through the viewer.
  Rogue's ultimate produced actual death/kill events; buff-only ultimates retained
  their existing behavior.
- Seven spell captures exercised existing real casts. The meteor impact capture
  was corrected to freeze 133 ms after the actual explosion event; the existing
  harness predicate could otherwise match a spawn beam.
- Wrapper pause held world time 27,233.33 ms and particle life ten seconds across
  450 ms. Resume advanced simulation 433.33 ms and particle life to 9.5521 seconds.
  Existing death handling respawned alive at full 450 HP after 3.05 seconds.
- Active portrait at 390×844 kept the player visible with zero overflow. This
  retained desktop capabilities; no physical touch or live two-peer claim.
- Typecheck, production build and repository verification pass. Source lint has
  zero errors; existing warnings remain. Browser errors empty; console only
  contained Vite debug messages.

Captures: `/tmp/battle-arena-after.png`, `/tmp/battle-arena-phone.png`, and seven
images in `/tmp/battle-arena-fx-shots/`.

## Starfall

Implemented: stable charge warnings, important-effect retention, a hull-upgrade
echo and a distinct dreadnought defeat cue. Existing vector hulls, movement,
weapons, damage, attack deadlines, locked aim, XP rules and clock split remain.

- Common particles cap at 340 of the existing 400; important responses can use
  the remaining sixty. Common stroke effects leave a quarter of eight rings,
  twelve shatters and six converges available. Routine traffic cannot evict
  important effects.
- Two reusable text nodes and two bounded cue records distinguish hull growth
  and boss defeat. Trailer reset clears effects; shutdown only releases data
  after Phaser destroys display objects.
- Review caught two boss phase-transition edges: stale lance data selecting the
  wrong duration, and cached duration selecting the wrong upcoming attack shape.
  Duration now stays fixed per warning deadline; current boss phase selects
  the shape. Attack timing and locked target data remain untouched.
- Independent review is clear after the correction. Smoke checks cover pool
  bounds/retention, six authored enemy windups, all three boss durations and a
  phase transition with unchanged deadline and stale lance data.
- Runtime common limits: 340 particles, six rings, nine shatters, four converges.
  Important effects filled 400/8/12/6 and survived one hundred common requests.
  Expiry returned counts to zero; re-emission worked with scene children stable
  at 2,175.
- Actual mouse steering moved X=2,316 to 3,238 at speed 136.4. Held Space emitted
  four beams. Arrow keys are not the game's steering input.

- A sniper kept its locked target at (1,900, 1,100) after the ship moved. Charge
  progressed 0.209 to 0.489. A 400 ms pause held frame, simulation time, scene
  time and deadline; it fired one shot one millisecond after the deadline.
- A lancer retained its 600 ms windup, angle and deadline, then charged at 640.
  A real boss phase-two-to-three transition kept its original 1,100 ms deadline,
  switched to nova warning despite stale lance data, and fired sixteen shots at
  speed 260 five milliseconds after the deadline.
- Actual XP 69+1 reached level two, BEAM level two and zero residual XP; the
  upgrade cue fired once. Under 340-particle pressure, a real twenty-point shield
  hit left eighty shield, 348 particles and one impact arc.
- An actual boss kill produced thirty shards, two items, two protected rings and
  one protected shatter. Death retained the existing level/XP loss and respawned
  alive at full shield with BEAM five milliseconds after the 2.5-second deadline.
- First-dead and spectator snapshots produced no death effects. Trailer clear
  removed every effect silently.

- Natural warning windows also matched warden 700 ms, drone 400 ms, spawner
  650 ms and wasp 350 ms.
- Active portrait at 393×852 kept the player visible over 45 frames, matched
  canvas dimensions and had zero overflow. It retained desktop capabilities.
- Actual scene shutdown destroyed Graphics and left effect arrays empty and
  milestone records null. Final page errors empty. Typecheck, regression groups,
  lint and final production build pass; existing asset/chunk warnings remain.
- Physical touch/controller and live 32-peer load were not tested.

Captures: `/tmp/starfall-after-locked-aim.png`,
`/tmp/starfall-after-hull-upgrade.png`, `/tmp/starfall-after-boss-defeat.png`,
`/tmp/starfall-after-portrait-desktop-input.png`.

## Integration verification

`pnpm verify` passed after all ten implementations: 25 typecheck tasks and
14 Turbo test tasks, plus lint and formatting. Crazy Waymo's unchanged suite
passed 237 checks. Full log: `/tmp/vibedgames-polish-final-verify.log`.

A source-content snapshot confirmed no code changed during the final gate.
An AST scan across 49 changed/new TypeScript files found no added `any`, casts,
non-null assertions or definite-assignment assertions. `git diff --check` passed.
Each changed game also passed its production build and independent source review.

All code changes remain inside the ten target game directories; Crazy Waymo,
platform packages and production state are unchanged. No release or commit made.
