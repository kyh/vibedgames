import { expect, test } from "@playwright/test";

// Bot playtest — starfall adoption of the diagnostics contract in the
// playwright skill (references/bot-playtest.md; lunerfall is the reference
// implementation). Drives real MOUSE input (starfall's core verb: the ship
// steers toward the cursor, holding the button autofires) through an offline
// solo arena and asserts PROGRESSION, not pixels.
//
// Seeding: starfall's GameScene is single-start, so the seed rides the URL
// (?seed=N, read in main.ts before boot) instead of a mid-run seed() hook —
// the contract's sanctioned boot-time alternative. Determinism boundary:
// local rolls (spawns, drops, weapon picks, shot jitter) are seeded; roll
// CONSUMPTION order is frame-timing dependent, so replays are statistically
// stable rather than frame-identical (same boundary as lunerfall).
//
// Headless caveat: SwiftShader renders this at single-digit FPS — everything
// here is a correctness signal, never a performance one.

type Diagnostics = {
  frame: number;
  score: number;
  complete: boolean;
  player: { x: number; y: number; speed: number };
  entities: number;
};

type TestHooks = {
  setState(name: string): void;
  setPausedForScreenshot(paused: boolean): void;
};

declare global {
  interface Window {
    __GAME_DIAGNOSTICS__?: Diagnostics;
    __GAME_TEST_HOOKS__?: TestHooks;
  }
}

// Cursor sweep in viewport coordinates (1280×720 default). The ship chases
// the cursor, so far-flung waypoints keep it moving; the button stays down
// the whole run (holding autofires) and enemies converge on the player, so a
// sweep reliably farms fodder kills → XP.
const SWEEP: Array<{ x: number; y: number; ms: number }> = [
  { x: 1150, y: 120, ms: 2400 },
  { x: 140, y: 620, ms: 2400 },
  { x: 1150, y: 620, ms: 2400 },
  { x: 140, y: 120, ms: 2400 },
  { x: 640, y: 360, ms: 1600 },
  { x: 1150, y: 360, ms: 2400 },
  { x: 140, y: 360, ms: 2400 },
  { x: 640, y: 120, ms: 2400 },
];

test("bot playtest: mouse sweep progresses a seeded offline solo arena", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  await page.goto("/?seed=12345");
  await page.waitForFunction(() => (window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  // active-play forces the offline solo fallback immediately (no 4s connect
  // grace) and dismisses the start overlay.
  await page.evaluate(() => window.__GAME_TEST_HOOKS__?.setState("active-play"));
  await page.waitForFunction(() => (window.__GAME_DIAGNOSTICS__?.entities ?? 0) > 0);

  const sample = () =>
    page.evaluate(() => {
      const d = window.__GAME_DIAGNOSTICS__;
      if (!d) return null;
      return {
        frame: d.frame,
        score: d.score,
        x: d.player?.x ?? 0,
        y: d.player?.y ?? 0,
        entities: d.entities,
      };
    });

  const before = await sample();
  expect(before, "diagnostics must be published").not.toBeNull();
  if (!before) return;

  // Hold fire for the whole sweep — pointer.isDown autofires.
  await page.mouse.move(640, 360);
  await page.mouse.down();

  let prev = before;
  let distance = 0;
  let softlockWindows = 0;
  let stepOfFirstScore = -1;

  for (const [index, step] of SWEEP.entries()) {
    await page.mouse.move(step.x, step.y, { steps: 10 });
    await page.waitForTimeout(step.ms);

    const snap = await sample();
    if (!snap) continue;
    const moved = Math.hypot(snap.x - prev.x, snap.y - prev.y);
    distance += moved;
    const progressed = snap.score > prev.score;
    if (progressed && stepOfFirstScore === -1) stepOfFirstScore = index;
    // Softlock signature: frames advance, the steered ship moves nowhere, and
    // nothing progresses. (Respawn invulnerability still moves the ship, so a
    // death mid-sweep doesn't false-positive.)
    if (snap.frame > prev.frame && moved < 2 && !progressed) softlockWindows += 1;
    prev = snap;
  }

  await page.mouse.up();

  const report = {
    framesAdvanced: prev.frame - before.frame,
    scoreBefore: before.score,
    scoreAfter: prev.score,
    distanceTravelled: Number(distance.toFixed(1)),
    stepOfFirstScore,
    softlockWindows,
    entitiesAtEnd: prev.entities,
    consoleErrors,
    pageErrors,
  };
  await testInfo.attach("bot-playtest-report", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(report.framesAdvanced, "game loop must keep running").toBeGreaterThan(100);
  expect(report.distanceTravelled, "ship must chase the cursor").toBeGreaterThan(500);
  expect(report.softlockWindows, "held input repeatedly produced nothing").toBeLessThanOrEqual(2);
  // XP is the run objective: autofiring through a converging wave must score.
  expect(report.scoreAfter, "sweep should earn XP").toBeGreaterThan(report.scoreBefore);
});

// Offline-only real freeze (shared/clock.ts): the sim clock and the render loop
// both stop, so the frame counter halts, positions hold, and — because every
// stored deadline (boosts, fuses, respawns) is measured against the paused
// clock — nothing detonates or teleports when the loop wakes.
test("pause hook freezes the sim and resumes without a jump", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto("/?seed=12345");
  await page.waitForFunction(() => (window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  await page.evaluate(() => window.__GAME_TEST_HOOKS__?.setState("active-play"));
  await page.waitForFunction(() => (window.__GAME_DIAGNOSTICS__?.entities ?? 0) > 0);
  // Let the ship pick up some velocity toward the cursor before freezing.
  await page.mouse.move(1150, 360);
  await page.mouse.down();
  await page.waitForTimeout(1200);

  const grab = () =>
    page.evaluate(() => {
      const d = window.__GAME_DIAGNOSTICS__;
      if (!d) return null;
      return { frame: d.frame, x: d.player?.x ?? 0, y: d.player?.y ?? 0 };
    });

  await page.evaluate(() => window.__GAME_TEST_HOOKS__?.setPausedForScreenshot(true));
  const atPause = await grab();
  expect(atPause, "diagnostics must be published").not.toBeNull();
  if (!atPause) return;
  await page.waitForTimeout(1500); // a real pause span, so drift would show
  const stillPaused = await grab();
  expect(stillPaused, "diagnostics must survive the pause").not.toBeNull();
  if (!stillPaused) return;
  expect(stillPaused.frame, "frame counter must halt while paused").toBe(atPause.frame);
  expect(stillPaused.x, "position must hold while paused").toBe(atPause.x);
  expect(stillPaused.y, "position must hold while paused").toBe(atPause.y);

  await page.evaluate(() => window.__GAME_TEST_HOOKS__?.setPausedForScreenshot(false));
  // First frames after wake: motion continues from where it stopped. The ship's
  // top speed is a few hundred px/s, so a short window bounds the legal delta —
  // a stored-deadline blowup or dt spike would fling it much farther.
  await page.waitForTimeout(250);
  const afterResume = await grab();
  expect(afterResume, "diagnostics must resume").not.toBeNull();
  if (!afterResume) return;
  await page.mouse.up();
  expect(afterResume.frame, "loop must advance after resume").toBeGreaterThan(stillPaused.frame);
  const jump = Math.hypot(afterResume.x - stillPaused.x, afterResume.y - stillPaused.y);
  expect(jump, "resume must continue smoothly, not teleport").toBeLessThan(300);
  expect(pageErrors).toEqual([]);
});
