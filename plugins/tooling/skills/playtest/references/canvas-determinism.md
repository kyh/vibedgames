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

- **Never report headless FPS as performance.** Headless Chrome renders WebGL on SwiftShader, a software rasterizer — ~2fps on scenes a real GPU runs at 120. Headless runs are for _correctness_. Capture frame rate with `--headed` on a real GPU, and label any headless number functional-only.
- **Headless can't capture WebGPU canvases on Linux or Windows.** Rendering and in-page readbacks work; only the screenshot comes out black. Use `--headed` — on Linux with no `DISPLAY`, agent-browser starts Xvfb itself. `vg playtest doctor --webgpu` verifies the whole pipeline. macOS captures fine headless.
- **Don't run two playtests against WebGL games concurrently.** They share the software rasterizer, and the frame-time collapse drifts game time from wall time, flaking every timed phase and screenshot baseline.

## Classify Before Fixing

| Type            | Symptom                                             | Root cause                                 |
| --------------- | --------------------------------------------------- | ------------------------------------------ |
| **Readiness**   | "element not found", `undefined` reads              | Acted before the game was live             |
| **Timing**      | Intermittent; passes locally, fails on a slower box | Animation/physics timing varies            |
| **Environment** | Fails only on one machine                           | Viewport/DPR/fonts/GPU differences         |
| **Data**        | Fails after a previous run                          | Leftover storage or daemon state           |
| **Concurrency** | Fails when two runs overlap                         | Shared software rasterizer, shared session |

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

Screenshot **states**, not moments: menus, the first gameplay frame after deterministic setup, pause, game over. Not "every frame" and not random gameplay instants.

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

## UI Harness for Slicing Regressions

Nine-slice panels, segmented ribbons, and HUD bars are best caught outside the gameplay flow:

1. Build a `test.html` that loads _only_ the UI assets.
2. Render raw slices next to assembled panels at several sizes, and show ribbons/bars both "raw crop + scale" and "stitched multi-slice".
3. Expose `window.__GAME_TEST_HOOKS__.showTest(n)` so each mode can be selected deterministically.
4. Screenshot each mode and diff them.

This makes trimming and slicing bugs obvious without gameplay noise.
