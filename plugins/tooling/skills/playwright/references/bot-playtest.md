# Bot Playtest: Prove the Game Plays, Not Just Renders

A canvas check proves the game renders; a bot playtest proves it *plays*. The bot drives real scripted input and measures **progression** — objective movement, player responsiveness, softlock windows, error-free runtime. A game that renders beautifully but can't be progressed by a scripted sweep is not ready. Engine-agnostic: works for Phaser and Three.js alike.

## The Diagnostics Contract

The bot needs machine-readable game state. Expose two globals (this generalizes the per-game `window.__TEST__` harnesses we've hand-built — same idea, split into read-only telemetry vs mutation hooks):

```javascript
// Read-only, updated every frame from the game loop
window.__GAME_DIAGNOSTICS__ = {
  frame: 0, // increments every update — the loop's heartbeat
  score: 0, // or the objective metric: waves, distance, gems
  complete: false, // win/fail state reached
  player: { x: 0, y: 0, speed: 0 }, // x/z for 3D games
  entities: 0, // live entity count
  renderer: null, // Three.js only: { calls, triangles } from renderer.info.render
};

// Mutations — keep them real as the game evolves; silent no-op hooks
// make every downstream assertion lie
window.__GAME_TEST_HOOKS__ = {
  seed(n) {}, // reseed RNG — all gameplay randomness must route through it
  setState(name) {}, // jump to a named state: 'active-play', 'fail', 'boss'
  setPausedForScreenshot(paused) {},
  setReducedMotion(enabled) {}, // freeze shake/particles/time-based FX
  hideDebugUi() {},
};
```

Rule: JSON-serializable primitives only, never raw engine objects. If gameplay randomness bypasses the seeded RNG, bot metrics are noise.

## Metrics and What They Mean

- `framesAdvanced > 100` — the loop survived the run. A stall is a crash or frozen loop.
- `distanceTravelled > threshold` — input mapping is alive. Near-zero under held keys means broken input.
- `scoreAfter > scoreBefore` + step-of-first-score — the objective is reachable, and how fast a naive player finds it. If a scripted sweep never scores, the objective is unreachable, unreadable, or broken.
- `softlockWindows` — sampling windows where frames advanced but held input produced **neither motion nor score progress**. Repeated windows = stuck-on-geometry, dead input states, or unrecovered fail states. Fail if > 2.
- Zero page errors, zero console errors, for the full run.
- Games with fail states: add a "reckless" run that seeks hazards — assert the fail state triggers and retry restores play. A game that can't be failed has no pressure; a fail state that can't be retried is a release blocker.

## Test Template

Adapt `INPUT_SCRIPT` to the game's core verb — a runner holds forward and switches lanes, an arena game sweeps the space, a tower defense places towers via test hooks (game-specific hooks like `forceWave()` are encouraged where raw keys can't express the verb).

```typescript
import { expect, test } from "@playwright/test";

const INPUT_SCRIPT: Array<{ keys: string[]; ms: number }> = [
  { keys: ["KeyW"], ms: 1000 },
  { keys: ["KeyA"], ms: 1900 },
  { keys: ["KeyD"], ms: 3400 },
  { keys: ["KeyS"], ms: 1700 },
  { keys: ["KeyA"], ms: 3400 },
];

test("bot playtest: scripted input drives progress without errors", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  await page.goto("/");
  await page.waitForFunction(() => (window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  await page.evaluate(() => {
    window.__GAME_TEST_HOOKS__?.seed(12345);
    window.__GAME_TEST_HOOKS__?.setState("active-play");
  });

  const sample = () =>
    page.evaluate(() => {
      const d = window.__GAME_DIAGNOSTICS__;
      return d && { frame: d.frame, score: d.score, x: d.player.x, y: d.player.y };
    });

  const before = await sample();
  expect(before, "diagnostics must be published").not.toBeNull();
  let prev = before, distance = 0, softlockWindows = 0, stepOfFirstScore = -1;

  for (const [index, step] of INPUT_SCRIPT.entries()) {
    for (const key of step.keys) await page.keyboard.down(key);
    await page.waitForTimeout(step.ms);
    for (const key of step.keys) await page.keyboard.up(key);

    const snap = await sample();
    if (!snap) continue;
    const moved = Math.hypot(snap.x - prev.x, snap.y - prev.y);
    distance += moved;
    const progressed = snap.score > prev.score;
    if (progressed && stepOfFirstScore === -1) stepOfFirstScore = index;
    // Softlock signature: frames advance, held input moves nothing, no progress
    if (snap.frame > prev.frame && moved < 0.2 && !progressed) softlockWindows += 1;
    prev = snap;
  }

  const report = {
    framesAdvanced: prev.frame - before.frame,
    scoreBefore: before.score, scoreAfter: prev.score,
    distanceTravelled: Number(distance.toFixed(2)),
    stepOfFirstScore, softlockWindows, consoleErrors, pageErrors,
  };
  await testInfo.attach("bot-playtest-report", {
    body: JSON.stringify(report, null, 2), contentType: "application/json",
  });

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(report.framesAdvanced, "game loop must keep running").toBeGreaterThan(100);
  expect(report.distanceTravelled, "player must respond to input").toBeGreaterThan(5);
  expect(report.softlockWindows, "held input repeatedly produced nothing").toBeLessThanOrEqual(2);
  expect(report.scoreAfter, "sweep should progress the objective").toBeGreaterThan(report.scoreBefore);
});
```

Attach the JSON report and the seed to the test output — pass/fail alone isn't evidence.

## Difficulty and Fairness Runs

For games with fail states, run the bot at two skill levels — 0ms vs 300ms artificial reaction delay between script steps — and compare survival time and score:

- Delayed bot survives as long as the fast one → difficulty pressure is decorative.
- Even the fast script can't survive the first threat → the opening is unfair.

Report both runs whenever difficulty tuning is in scope.

## Headless WebGL Footguns

- **Never report headless FPS as performance.** Headless Chromium renders WebGL on SwiftShader (software rasterizer) — ~2 fps on scenes a real GPU runs at 120. Headless runs are for correctness only; capture FPS on a real GPU (headed browser) and label headless numbers functional-only.
- **Run Playwright with `workers: 1` for WebGL games.** Parallel headless contexts share the software rasterizer; the frame-time collapse drifts game time from wall time, flaking timed phases and screenshot baselines.
