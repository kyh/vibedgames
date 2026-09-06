# Bomberman and Starfall graphics upgrade

Second pass, September 5, 2026. Builds on the [collection polish pass](polish-report.md).
Plan and further proposals: [quality roadmap](quality-roadmap.md).
Changes remain local; no release made.

## Bomberman

Seven generated WebP textures replace the active floor, wall, crate, bomb and
three pickup textures. The original grass surrounds a new stone courtyard.
Contact shadows give props depth. Fuse sparks follow the new bomb's lit tip.
The camera keeps more arena visible near edges and accounts for touch-button
clearance, with the existing zoom preserved.

Generated through the built-in image tool. Six sprite textures retain alpha;
the floor is opaque. Runtime art is 166,760 bytes combined (167 KB). All final
prompts, source provenance and runtime paths are in
[art-direction.md](bomberman/art-direction.md). Existing files remain available;
the original character sheets and sixteen-frame fire animation stay in use.

- Typecheck, production build, lint and formatting pass.
- ArrowRight moved the player from column 1 to 2 and played the original side
  animation. Space placed a bomb and its shadow. A 500 ms pause held the clock
  and visual scales; resuming restored play.
- A staged authoritative three-bomb chain produced three blasts. The original
  fire played; a crate and its shadow were destroyed. Two pickups burned without
  collection feedback. Real collection raised range from 2 to 3 exactly once.
- Death and R-to-restart work. Repeated snapshots replayed no feedback.
- Three spawn/remove cycles returned scene children from 273 to the same 270
  baseline, with bomb and pickup children destroyed each time.
- Four corners checked at 1280×800 and 390×844; landscape checked at 844×390.
  Touch framing kept the player center at least 44.17 screen pixels beyond the
  bomb button edge, with character half-size at most 25 pixels. No horizontal
  overflow. Final browser error count: zero.

Screenshots use staged fixtures to expose assets and chain reactions. Touch UI
was exercised synthetically; physical touch hardware and live multiplayer were
not re-tested in this art pass.

## Starfall

Live weapons now have differentiated luminous trails, cores, muzzle flashes and
surface impacts. Deaths have bright cores, traveling fronts, angular fragments
and afterglow; boss destruction has three finite stages. Subdued parallax salvos,
far silhouettes and haze add battlefield depth. Original vector hulls, attack
geometry, warning timing, movement, weapon numbers, loot and wire data remain.

Thirty-six reusable glow images serve bounded burst records. Common bursts use
at most 27 slots, preserving capacity for important events. Decorative weapon
draws cap at 96 per frame, reserving 24 for local fire. Distant salvos and flashes
cap at 14 and 5. Actual shots and warnings render independently of these budgets.

- Typecheck, production build, lint, formatting and five regression groups pass.
  Browser checks exercised all 26 special-weapon cast branches.
- A rail impact appeared at the target surface, x=2043, while the actual lance
  head remained x=2300. Repeated contact did not repeat damage/feedback. An area
  attack produced three distinct victim contacts.
- Pool pressure respected all limits; important bursts survived common traffic.
  Expiry/refill reused objects. Silent world reset cleared UFO presentation
  without a false death burst.
- A local 32-peer snapshot fixture preserved projectile data across 120 redraws.
  First-dead snapshots and departures stayed quiet; an alive-to-dead transition
  emitted one blast. This is rendering verification, not a live network session.
- Level 1→2 produced the hull cue. Actual 20 damage left 80 shield and one impact;
  death produced one blast, then respawn restored 100 shield after 2.8 seconds.
- Pointer steering/firing and synthetic held-Space input passed. Pause/resume
  held the cosmetic stages. The driver supplied empty key codes for its native
  Space command, so that path used full DOM keyboard events.
- Reduced-motion media lowered bloom intensity, removed distant salvos and
  secondary blast stages, and retained live shots and warning geometry.
- Active 393×852 portrait had no overflow and kept the player near (199,426).
  A narrow-screen boss-bar rule moved it below weapon and combo text. Final
  HTML formatting and production build also pass after that responsive change.
- Actual scene shutdown cleared glow references, bursts, salvos and haze arrays.
  Gameplay QA and a fresh isolated recording run returned no browser errors.
- Server logs identified the earlier empty recording errors as an existing
  energy-barrier resize listener surviving shutdown. It now detaches on shutdown
  and remains safe during explicit destroy/replacement. Listener counts followed
  1→0→1→0; both graphics were destroyed once. Real stop followed by window and
  393×852 viewport resize produced no page, rejection or server errors.

Review also corrected broad glow ordering so hulls render above it. Crowded
captures exposed dark rectangular seams from Phaser's additive blending over a
transparent canvas. Normal alpha blending on soft glow/haze images removed those
seams; sharp vector effects retain additive blending. Final stills use that fix.

Captures use staged real casts, contacts and removals. The comparison uses the
same seed and trigger; cosmetic randomness and actor timing differ. Portrait
retains desktop input capabilities. Physical phone performance remains untested.

## Integration

Forty-four source/package files from the previous pass outside these two games
match their verified hashes. Existing work in the other games remains intact.

Full `pnpm verify` passed: 25 typecheck tasks, lint, formatting, and 14 test tasks.
This includes Starfall's five regression groups and Crazy Waymo's unchanged
237 simulation checks. An added-line syntax audit across 54 TypeScript files
found no added `any`, type assertions, non-null assertions or definite assignments.
All 71 captured source/asset/HTML hashes remained unchanged through the final gate,
including the responsive HUD and shutdown cleanup fixes.
