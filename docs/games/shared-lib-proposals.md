# Bundled games — shared-library & consistency proposals

Output of the 2026-07-06 cleanup pass across the 8 changeable games (bomberman,
farm, flappy-dragons, moba, pacman, pong, starfall, tetris). crazy-waymo,
battle-arena and lunerfall are **read-only** here — mined for patterns, never
edited. Nothing below is implemented yet; it is the "for later" backlog.

Guiding rule (unchanged): games are self-contained deployables bundled by
`vg deploy`. Extractions must be **published** `@vibedgames/*` packages (like
`@vibedgames/multiplayer` / `@vibedgames/gamepad`), never `@repo/*`, and must
stay DOM-safe for `@repo/party`'s worker typecheck (use the
`typeof globalThis & {…}` view, never raw `window`/`performance`). Sequence every
extraction as: **align the copies in-repo first → then the extraction is a
mechanical de-dupe of already-identical text.**

---

## A. Library derivations (extract to published packages), by priority

### 1. `@vibedgames/multiplayer/session` — `NetSession`  ·  effort S · risk low
The `net/session.ts` adapter (offline-fallback, host-authoritative verbs). Already
engine-free; 6 field-tested copies, 4 now byte-identical (`fa470c87`). Highest ROI.
- **Blockers:** `MULTIPLAYER_HOST` uses `import.meta.env.DEV` + hardcoded URL → make
  host a param with a default; fold in battle-arena's `?party=` dev override. Guard
  `performance.now` behind the globalThis view. Document `SOLO_ID`/loopback as contract.
- **Do at extraction:** the deferred `otherPlayer()` `for..in` + cached solo-map
  perf fix (skipped in-repo to keep the shared logic untouched).

### 2. `@vibedgames/game-feel` — `TraumaCamera`  ·  effort M · risk low
Pure-math trauma→shake core (~40 LOC). The 3 copies are now unified to
`ShakeSample = {ox,oy,rot}`, so only tuning constants + unit differ.
- **API:** `new TraumaCamera({decayPerSec,maxOffset,maxRot,freqScale})`,
  `add`, `addAt(dist,radius,amount)` (moba falloff), `reset`, `update(dt,tSec?)`.
- Optional subpath adapters `/three` (`translateX/Y`+`rotateZ` after lookAt) and
  `/phaser` (`setAngle` deg vs `setRotation` rad) — peer deps, core stays engine-free.
- **Blockers:** unit semantics per game (px/wu, deg/rad) = config concern; pong's
  freeze-clock needs external `tSec`; moba's `addAt` needs caller camera-centre dist.

### 3. `@vibedgames/multiplayer/interp` — remote-puppet helpers  ·  effort M · risk med
`finiteNum`, `expBlend(rate,dt)`, `shortestAngle`, `hueForId` (FNV-1a), `rebuildMap`
+ a `RemotePuppets<S,P>` class with a per-game `PuppetAdapter` (render stays game-side).
- **Extract the 5 helpers first (zero risk, used by every remote reader).** The class
  couples to the engine via `blend()`; grid games (bomberman tween-to-cell) shouldn't adopt.
- Do NOT extract `encodeWorld`/`applySnapshot` — field lists are 100% game-specific.

### 4. `@vibedgames/sfx` — `createSfx()`  ·  effort M · risk med
Unifies the 3 audio paradigms (live-synth tone/noise · zzfx pre-render bank · blip).
Games shrink to constants + a verbs/recipe table.
- **Canonical pattern donor:** battle-arena `render/audio.ts` (AudioContext-clock
  scheduling, one shared noise buffer, `gate()`, `setTargetAtTime` mute fade, typed
  `webkitAudioContext` view). Samples/loops (crazy-waymo) + spatializer/voice-cap
  (battle-arena) are extension points, not core.
- **Blocker:** audio regressions are hard to verify headlessly → align files in-repo
  and soak before extracting.

### 5. `@vibedgames/fx-pool` — two backends over a tiny core  ·  effort M · risk med
`SlotPool`/`cubicOut`/`jitter` core + `/three` (`ParticlePool`,`RingPool` instanced) +
`/phaser` (`FxPool` persistent emitters + the load-bearing Phaser-4 `updateConfig`
footgun baked in). Bespoke systems (pacman hearts/confetti/motes, starfall
shatter/converge, waymo GPU `ParticleField`) stay per-game on top of primitives.
- **Mine into the lib:** battle-arena dirty-flag upload-skip + scratch spawn options;
  crazy-waymo rest-when-empty guard + exponential drag.
- **Blocker:** standardize timing on seconds + per-slot age + explicit kick axis first.

### 6. `@vibedgames/vision` — MediaPipe capture layer  ·  effort M · risk med
`createVisionCamera({task,onFrame,modelUrl,panel,draw,onStatus})` — **capture only;
interpretation (gestures, calibration, cooldowns) stays per-game.** Task adapter over
Gesture/Pose/Face is the real design work.
- **Canonical:** tetris `camera.ts`+`pose-control.ts` (only copy that splits capture
  from interpretation; has every lifecycle fix). Port flappy's retry-button UX.
- **Blocker:** webcam gimmicks are core features (regressions user-visible) + hard to
  verify headlessly (use Playwright `--use-fake-device-for-media-stream`).

### 7. `@vibedgames/game-boot` — `bootThree` / `bootPhaser`  ·  effort M · risk med
Renderer + resize + loop + fatal-panel + dev-hook. Two engine shapes (subpath
exports), loop injects `render(dt,rawDt)` so dither passes / perf governors / composers
still fit. Lowest priority (most coupling). Constants stay per-game.

### 8. `@vibedgames/game-clock` — pausable sim clock  ·  effort S · risk low
Offset-based `now()/pauseClock()/resumeClock()`: wall time minus every ms spent
paused, frozen while paused, seamless on resume (stored deadlines hold — no
mass-detonation/teleport on wake). 2 byte-identical field-tested copies:
bomberman `src/util/clock.ts` (pattern donor, "real pause" work) and starfall
`src/shared/clock.ts` (2026-07-09, enables offline freeze + the
`setPausedForScreenshot` test hook). **Contract:** only SIM timestamps read
`now()`; net heartbeats/connection deadlines stay on raw `Date.now()`
(pausing must not break reconnect), and pause is only honored offline/solo —
freezing a shared online world stalls the other players. Engine-free, DOM-safe,
zero-alloc. Extraction is a mechanical de-dupe.

---

## B. In-repo consistency alignment still to do (no package; do before extraction)

These are behavior- or feel-sensitive, or file-move churn, so they were **not** done
in the 2026-07-06 pass (which was strictly behavior-preserving + typecheck-verifiable).

- **trauma-camera:** extend the unified module to pong/moba/bomberman/farm (replace
  inline shakers + fixed `camera.shake` that fight each other). Needs per-game feel tuning.
- **audio:** bomberman ships **silent** — add `src/audio/sfx.ts` (live-synth shape).
  Standardize path→`src/audio/sfx.ts` + `export const sfx` + one storage/mute block;
  port battle-arena's at-clock scheduling, shared noise buffer, `gate()`, typed
  `webkitAudioContext` view. (moba `render/audio.ts`→`audio/sfx.ts` + add pitch jitter.)
- **fx-pool:** converge pong/tetris `ParticlePool`; fix pong `shock-rings` steal-oldest
  bug; rework pacman fx-pool onto the slot pattern (kill per-spawn `new Color`/Vector3);
  replace per-burst-emitter churn (bomberman/flappy/moba) and farm's 16ms-timer-per-particle.
- **mediapipe camera:** split capture/interpretation uniformly (tetris shape); fix
  pacman's missing monotonic-timestamp guard + `try/catch` + teardown race; port flappy's
  retry button; pin wasm CDN to the installed 0.10.35 (needs runtime verify).
- **bootstrap:** fatal-error surfacing for pacman/pong/tetris (crazy-waymo pattern);
  re-clamp DPR on resize (pacman/tetris); move farm `config.ts` + moba `data/config.ts`
  → `src/shared/constants.ts`; add `loaderror` + progress to farm/moba boot scenes;
  converge dev hooks to one `window.__<game>` namespace object.
- **net-snapshot:** add `finiteNum` guards to farm/pacman/pong/flappy/bomberman remote
  readers (NaN peer state currently reaches transforms); snap-on-teleport in farm/pacman;
  harden moba `rebuildMap` iteration; port battle-arena `?party=` override to moba.

## C. Deferred per-game items (risk/verification-gated)

- tetris: cache `ghostCells`/`landingCells` (stale-cache risk, no sim harness);
  add `Engine.pause/resume/finalizeGameOver` instead of mutating `state.status`.
- moba: pool floating damage/gold/heal Text (per-event `Phaser.Text` churn);
  dedupe the 4 nearest-unit scan loops (untargetable-rule behavior nuance).
- farm: rewrite `render/fx.ts` `burst()` (per-particle 16ms timers → one timer/burst).

## D. Skills follow-up

The `game-playbook` / `game-feel` / `multiplayer` skills currently teach the
copy-paste pattern. When any package above ships, update the matching skill in the
same change or newly-scaffolded games will keep forking the code.
