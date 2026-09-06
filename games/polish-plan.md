# Game polish rollout

Preserve each game's art direction, assets, controls and core rules. Bring action
readability, impact, atmosphere and presentation up to a consistent standard.
Crazy Waymo is the reference for care and verification, not a visual template.

Follow-up: [Bomberman art and Starfall battle effects](graphics-upgrade-report.md),
with [further quality proposals](quality-roadmap.md).

Implement and verify one game before starting the next. Existing generated
sprites, animation frames, video, models and audio remain in use. Generate assets
only if a specific visual gap cannot be filled by the existing library.

## Order and scope

| Order | Game                  | Identity to preserve                                    | Planned pass                                                                                     | Status   |
| ----- | --------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------- |
| 1     | Pong                  | Two-tone dither, ring paddles, hand tracking            | Deliberate flick-spin returns, ink spin cues, match-point feedback, reduced motion               | Verified |
| 2     | Flappy Dragons        | Pixel forest, dragon skins/video animation, pose flight | Wingbeat air, coin glints and pickup rings, score milestones, forest atmosphere, new-best payoff | Verified |
| 3     | Bomberman             | Generated characters/props and video-derived fire       | Fuse sparks, layered blast residue/crate fragments, first sound pass and mute, pickup feedback   | Verified |
| 4     | Farm                  | Existing pixel farming world and sprites                | Bounded delta-driven tool FX, weather/season atmosphere, harvest and fishing payoff              | Verified |
| 5     | Pacman                | Plush cream clinic, face steering/chomp                 | Power-duration halo, ghost capture/respawn poofs, visible pearl chain                            | Verified |
| 6     | Tetris                | Matte spatial blocks, body-controlled camera            | Hard-drop streak/landing contact, clear sweeps, power/rescue distinctions, height warning        | Verified |
| 7     | Lunerfall             | Authored pixel heroes and dungeon biomes                | Biome blast palettes, bounded common FX, local impact camera, elite/boss payoff                  | Verified |
| 8     | Ancients of Eldermoor | Authored fantasy sheets and spell silhouettes           | Bounded/cullable common FX, ability-aware contact color, local camera response to objectives     | Verified |
| 9     | Battle Arena          | 3D dungeon, champions and animated weapon trails        | Local-impact hierarchy, particle headroom for major events, champion contact color               | Verified |
| 10    | Starfall              | Thin vector hulls and neon space                        | Stable charge telegraphs, important-effect retention, distinct progression/boss beats            | Verified |

## 1. Pong

- Keep open-hand steering, fist serve/rematch, mouse/touch/controller fallbacks,
  collision dimensions, first-to-seven rules and rally speed ramp.
- Add a deliberate lateral flick at contact. A short decaying curve provides
  expression through existing inputs; stationary returns retain their current
  trajectory. Conserve speed and minimum forward travel. Ignore input reacquisition,
  pause and network jumps when measuring flicks.
- Show spin with existing ink particles/rings, a brief shot label and trail
  variation. Signal match point during the existing serve interval. Keep the paper
  palette and dither pass.
- Replicate spin through host snapshots and guest prediction. Respect reduced
  motion without removing useful contact/shot information.
- Gate: pure spin tests; real pointer and synthetic hand play; scoring, rematch,
  pause, phone layout, clean browser errors; package typecheck/build/test.

## 2. Flappy Dragons

- Keep pose strength/refire semantics, flap velocity, gravity, course generation,
  score rules and translucent multiplayer dragons. Retain all animation/video assets.
- Reuse the puff emitter for downward/backward wingbeats. Add sparse forest motes,
  coin glints, short pickup rings and a restrained five-point milestone.
- Distinguish pipe/coin sounds and new-best feedback. Collision debris follows
  contact; no particle curtain over upcoming gaps.
- Gate: keyboard/tap and synthetic pose flight, pipe and coin scoring, death/retry,
  portrait readability, typecheck/build. Physical pose tracking remains a human check.

## 3. Bomberman

- Keep authoritative bomb fuses, blast tiles, chain reactions, movement and bots.
  The existing sixteen-frame generated explosion remains the core visual.
- Placement pop and fuse sparks communicate remaining time without implying a new
  blast radius. Add short core flashes, bounded smoke/embers/scorches and crate chips.
- Add gesture-unlocked procedural placement/blast/pickup/death/win audio and a mute
  control. Trigger effects once per real state transition, including guest snapshots.
- Gate: fuse/chain, destroyed crates, actual pickup versus destroyed pickup,
  death/restart, mute/pause, phone layout, explicit TypeScript check and build.

## 4. Farm

- Keep yields, stamina, fishing windows, seasons, save format and all existing art.
- Replace per-particle rectangle/timer allocation with a scene-owned bounded pool
  and one delta-driven update before adding more effects. Preserve callers' simple
  burst interface.
- Give dirt, water, leaves and ore distinct shapes/direction. Add camera-local
  rain/snow and sparse seasonal ambience from the existing weather/time state.
- Harvest/fishing feedback reuses existing item icons; inventory awards remain
  immediate. Keep mature-crop accents and crop movement subtle.
- Gate: farm/tool actions, catch, mining, weather/time, inventory, pause and scene
  transition cleanup; trailer/gallery asset checks; typecheck/build.

## 5. Pacman

- Keep face/head controls, discrete chomps, camera modes, maze rules and plush look.
  Existing pooled hearts/poofs, soft shadows and musical pellets are already strong.
- A floor halo and remaining-duration arc expose the current power timer. Final
  warning should remain readable without harsh flashing.
- Add directional wall poofs and ghost-colored capture/reappearance cues. Expose
  the existing musical pellet chain as a small temporary HUD indicator.
- Gate: chomp/turn/mouth input, power expiry, ghost contacts, retry, pause/selfie,
  touch porthole, typecheck/build. No new scores, ghost AI or movement rules.

## 6. Tetris

- Camera orbit/correction, pose lean/twist/T-pose, well geometry and all puzzle
  rules remain. Existing game-over collapse/catch remains a real mechanic.
- Sample hard-drop start/landing cells before the immediate drop; render a short
  vertical streak and footprint impact afterward. Highlight the exact clear footprint.
- Distinguish the existing power sweep from a successful rescue. Add a quiet
  height warning, with no changes to drop cadence or catch deadlines.
- Gate: hard drop, clear, power, collapse/catch, pause, orbit and touch controls;
  existing headless smoke, typecheck/build.

## 7. Lunerfall

- Preserve authored swings, hero kits, hitboxes, combat freeze and multiplayer rules.
- Use biome/hero colors instead of the universal magenta explosion. Layer a short
  core, angular fragments and slower dust through bounded reusable effects.
- Focus camera response on the local player and meaningful nearby danger. Ordinary
  remote movement should not shake the whole view.
- Separate elite/room clear and boss defeat from routine kills. Keep common sparks
  cheap and bigger celebration finite; clean up on room teardown.
- Gate: five heroes/biomes, normal and boss rooms, clear/death/retry, guest event
  review, diagnostics, sim harness, typecheck/build.

## 8. Ancients of Eldermoor (MOBA)

- Preserve all six kits, combat numbers, map, multiplayer authority and authored
  animation sheets. Existing hero-kill simulation freeze remains offline-only.
- Pool/cull common sparks, rings and repeated bursts. Prioritize player damage,
  hero death and objectives over offscreen decoration.
- Carry caster/ability color to impacts, keeping basics below critical/ultimate
  effects. Enemy zones and tower ranges stay visible.
- Weight structure camera response by proximity; keep the global objective
  announcement. Distant tower destruction should not jolt the player's fight.
- Gate: all hero presentation paths, tower effects, local/remote event review,
  viewer/gallery, sim smoke, typecheck/build.

## 9. Battle Arena

- Preserve champion models, actual weapon trails, clip-aligned combat, adaptive
  rendering and shader prewarming. Existing FX are already extensive.
- Give local hits/criticals a full response; compress distant basic contacts.
  Keep dangerous spell silhouettes regardless of decorative budget.
- Reserve particle capacity for major impacts/deaths; throttle ambient/trail use
  before those events. Match magic contact to the champion palette.
- Gate: champion basics/ultimates against the real arena, overlapping effects,
  local versus remote responses, fixed FX shots, timing harness, typecheck/build.

## 10. Starfall

- Keep movement, weapon stats, enemy attack timing/locked aim and the vector style.
- Stable warning shapes plus visible charge progress replace reliance on strobing.
  Limit bright accents; keep aim readable at phone zoom.
- Retain major rings/shatters under heavy traffic; reserve importance for local
  shield damage, bosses and level-ups. Distinguish the hull/progression payoff from
  an ordinary kill without hiding enemy attacks.
- Gate: seeded offline play, enemy telegraphs, shield/level-up/boss states,
  death/respawn, phone view, diagnostics, typecheck/build.

## Verification and limits

For each game: capture the existing look, implement the pass, inspect it in motion,
drive real inputs and relevant reward/failure transitions, then check type/build
and applicable simulations. Use development fixtures to reach rare states; label
those fixtures separately from natural progression. Reuse existing diagnostics and
add small honest read-only telemetry where absent.

Run the repository `pnpm verify` gate after integration. Initial baseline: all
static gates and all eleven test tasks passed (tests required access to local IPC
sockets). Browser frame rate is not a physical-device performance measurement.
Synthetic pose/hand inputs do not establish physical camera recognition quality.

Changes remain local until a release is requested. No blanket claim of AAA quality:
the result is a verified craft pass; fun, balance of Pong's new shot and physical
device feel still need a human session.

## Later candidates

Optional future mechanics: Flappy clean-center medals, Bomberman bomb-kick pickup,
Farm daily harvest badges, Pacman clean-chomp badges, Tetris multi-axis accolades,
Lunerfall no-hit room challenge, MOBA last-hit streaks, Battle Arena mastery cosmetics,
Starfall close-dodge streaks. These are not requirements of this first pass.

Unresolved questions: none blocking implementation.
