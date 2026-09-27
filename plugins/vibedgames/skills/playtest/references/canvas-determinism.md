# Canvas / WebGL Determinism

## Why Canvas Playtests Get Flaky

- Variable frame times (CPU load, software rasterization)
- Time-based movement/physics without a fixed timestep
- RNG for loot, spawns, AI decisions
- Async asset loading and "first frame" races
- Font loading shifting mixed DOM+canvas layouts
- GPU/driver differences in rendering

**The fix is never "more retries" — it's deterministic mode plus explicit readiness.**

## Headless Footguns

These are the ones that produce confidently wrong reports rather than errors:

- **Verify the renderer string before you report a frame rate.** Headless is not one thing: `vg playtest` and Playwright's `channel: "chrome"`/`"chromium"` render on the real GPU (`ANGLE Metal` on a Mac); a bare Playwright `launch()` uses the headless shell, which falls back to SwiftShader. Read `WEBGL_debug_renderer_info` (the bot report's `gpu` field does). SwiftShader ⇒ functional-only evidence. A hardware renderer (ANGLE Metal/D3D/Vulkan on a real device) ⇒ a desktop-GPU signal — still not a phone.
- **Headless can't capture WebGPU canvases on Linux or Windows.** Rendering and in-page readbacks work; only the screenshot comes out black. Use `--headed` — on Linux with no `DISPLAY`, agent-browser starts Xvfb itself. `vg playtest doctor --webgpu` verifies the whole pipeline. macOS captures fine headless.
- **Real GPU in a headed or Playwright-launched run needs flags.** `--use-angle=metal --ignore-gpu-blocklist` (Mac) plus `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`, or an occluded window throttles to ~1 Hz and reads as a hang. SwiftShader renders lit materials black and drops heavy games to ~3–4 fps — a multiplayer host on it looks frozen to every guest.
- **Don't run two playtests against WebGL games concurrently.** The contexts contend for the GPU, and the frame-time collapse drifts game time from wall time, flaking every timed phase and screenshot baseline. Run suites serially (`workers: 1`). ~8 concurrent sessions _run_, but any timing under contention is noise: measure load/perf one **fresh** session at a time — fresh = empty cache = the only honest cold-load number. Serving `dist` yourself? A compression cache keyed by path alone cross-contaminates games that all have an `index.html`; key on game + mtime.
- **`--virtual-time-budget` breaks anything that touches the network.** It fast-forwards `performance.now()` while I/O stays real, so a connect-fallback timer expires before the socket connects and the client silently drops to solo. Screenshot loops may use virtual time; multiplayer runs wall-clock.
- **Screenshot stalls advance clocks, not frames.** A capture blocks the renderer while `performance.now()` keeps running, so the frame after it jumps. Timing-sensitive capture is video-then-slice, never live screenshots. A bare `chrome --headless --screenshot` never self-exits and macOS has no `timeout` — use `gtimeout` or background + kill.
- **When WebGL screenshots lie, assert on state.** Publish a tiny probe from the loop — `Reflect.set(globalThis, "__probe", { frame, x, y })` — and read it via `eval` or CDP `Runtime.evaluate`; `__GAME_DIAGNOSTICS__` is the full form of the same idea.
- **`set device` is not a phone.** Viewport + UA only; `pointer: coarse` stays false and the game runs its desktop build. Held CDP touch emulation and its traps: `cli-cheatsheet.md` § Environment and Emulation.

## Classify Before Fixing

| Type            | Symptom                                             | Root cause                                   |
| --------------- | --------------------------------------------------- | -------------------------------------------- |
| **Readiness**   | "element not found", `undefined` reads              | Acted before the game was live               |
| **Timing**      | Intermittent; passes locally, fails on a slower box | Animation/physics timing varies              |
| **Environment** | Fails only on one machine                           | Viewport/DPR/fonts/GPU differences           |
| **Data**        | Fails after a previous run                          | Leftover storage or daemon state             |
| **Concurrency** | Fails when two runs overlap                         | Contexts contend for the GPU, shared session |

Readiness is by far the most common. Fix it first.

## Deterministic Mode

Gate it behind `?test=1` so it never ships to players:

```javascript
const params = new URLSearchParams(location.search);
const isTest = params.has("test");

if (isTest) {
  seedRng(Number(params.get("seed")) || 12345); // 1. seed RNG
  game.loop.targetFps = 60; // 2. fixed timestep
  game.loop.forceSetTimeOut = true;
  setReducedMotion(true); // 3. kill shake / particles / flashes
  await preloadAllAssets(); // 4. no first-frame asset race
}
```

## Readiness, Not Sleeps

Every wait should name the condition it's waiting for:

```sh
# Bad — a guess that will be wrong on a slower machine
vg playtest wait 2000

# Good — the actual condition
vg playtest wait --fn "(window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10"
vg playtest wait --fn "window.__GAME_DIAGNOSTICS__?.complete === true"
vg playtest wait --load networkidle
```

Set `ready` only after preload completes, the first scene is created, **and** a first render tick has happened. Any earlier and you've moved the race, not removed it.

## What to Assert

**Good** — matches what a player would notice:

- Scene key is correct and the UI is interactive
- Enemy HP decreased after an attack
- Score increased by the expected amount
- Death state triggered at 0 HP, and retry restored play

**Brittle** — avoid:

- Exact pixel positions without fixed dt and seeded RNG
- Internal array/map ordering
- Engine sprite instance properties
- Animation frame indices

## Screenshots and Visual Diffs

```sh
vg playtest set viewport 1280 720          # lock viewport + DPR first
vg playtest open "http://localhost:5173?test=1&seed=42"
vg playtest wait --fn "(window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10"
vg playtest eval "window.__GAME_TEST_HOOKS__.setReducedMotion(true)"
vg playtest eval "window.__GAME_TEST_HOOKS__.hideDebugUi()"
vg playtest screenshot /tmp/baseline.png

# later, after a change
vg playtest diff screenshot --baseline /tmp/baseline.png -o /tmp/diff.png
vg playtest diff screenshot --baseline /tmp/baseline.png -t 0.2   # loosen for AA noise
```

For a named-state capture the preparation order matters, and it all runs inside one `page.evaluate` with a host-side deadline (10 s) so a hung hook fails instead of hanging the run:

1. `setPausedForScreenshot(false)` — unfreeze a scene a previous capture froze
2. `seed(n)`
3. `await setState(name)` and assert the ack is `{ state: name }`
4. `setPausedForScreenshot(true)` — immediately, so the state can't advance during the rest of setup
5. `setReducedMotion(true)`
6. `hideDebugUi(true)`
7. optional settle, then `await document.fonts.ready`, then two `requestAnimationFrame`s

A missing hook, a no-op result, an unknown state, or an ack naming a different state fails the capture — it is never labelled with the state it asked for. Visual hooks must apply their changes while paused, without needing a gameplay tick.

Screenshot **states**, not moments: menus, the first gameplay frame after deterministic setup, pause, game over. Not "every frame" and not random gameplay instants. For animation, record video — a paused frame proves nothing about motion (see the `threejs` skill's visual-defect table, "Animation / rig" row), and live screenshots stall the renderer while the clock runs (§ Headless Footguns).

Skip visual baselines entirely for un-seedable prototypes or particle-dominated scenes, and say why — a mask wide enough to make such a shot stable is a mask wide enough to hide the regression.

For DOM and HUD layout, `vg playtest diff snapshot --baseline before.txt` diffs the accessibility tree instead, which is far more legible than a pixel diff.

## Phaser Specifics

```javascript
// Seeded RNG — use this instead of Math.random() throughout gameplay
const rnd = new Phaser.Math.RandomDataGenerator([String(seed)]);
rnd.frac();
rnd.between(0, 10);

// Fixed timestep physics
const config = { physics: { default: "arcade", arcade: { fps: 60, timeScale: 1 } } };

// Asset readiness
this.load.on("complete", () => {
  window.__GAME_DIAGNOSTICS__.assetsLoaded = true;
});

// Expose values, never the Sprite
window.__GAME_DIAGNOSTICS__.player = {
  x: Math.round(this.player.x),
  y: Math.round(this.player.y),
  hp: this.player.getData("hp"),
};
```

## Three.js Specifics

- Report `player.z` as the depth axis; the bot script already accepts `z` in place of `y`.
- Publish `renderer.info.render` as `{ calls, triangles }` — a draw-call spike is the cheapest early warning for a scene-graph regression.
- `WebGPURenderer` initializes asynchronously and silently falls back to WebGL2 when no adapter exists. Wait for the first rendered frame before capturing anything, and check `vg playtest doctor --webgpu` if captures come out black.
- Drive the fixed-timestep loop from an accumulator, not raw `deltaTime`, or physics results change with frame rate — which is exactly what a software rasterizer does to you.

## Showcase Harness: UI Slices and FX Contact Sheets

Nine-slice panels, HUD bars and spell/hit effects are best caught outside the gameplay flow, in a showcase scene behind a query flag (`?viewer=1`, `?gallery=ui`) that never ships to players.

**UI slices:**

1. Load _only_ the UI assets.
2. Render raw slices next to assembled panels at several sizes, and show ribbons/bars both "raw crop + scale" and "stitched multi-slice".
3. Expose `window.__GAME_TEST_HOOKS__.showTest(n)` so each mode can be selected deterministically.
4. Screenshot each mode and diff them.

**FX contact sheets:** expose the game instance (`window.__game`), drive the scene by hook — `select(i)` a subject, `demoCast('Q')` — then capture with `game.renderer.snapshotArea(x, y, w, h, cb)` at +60/220/450/900 ms and tile the frames into one sheet per subject. One glance shows a missing burst or a wrong colour across every kit. Two traps: a demo must actually be in range (a unit-target cast outside `castRange` silently no-ops and the sheet shows nothing), and half-res sheets lose thin beams — check full-res before calling an effect invisible.
