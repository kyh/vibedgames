import { expect, test } from "@playwright/test";

// Bot playtest — reference implementation of the diagnostics contract in the
// playwright skill (references/bot-playtest.md). Drives real keyboard input
// through a combat room and asserts PROGRESSION, not pixels: the loop runs,
// input moves the player, attacks score, and no softlock windows accumulate.
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
  seed(n: number): void;
  setState(name: string): void;
  setPausedForScreenshot(paused: boolean): void;
};

declare global {
  interface Window {
    __GAME_DIAGNOSTICS__?: Diagnostics;
    __GAME_TEST_HOOKS__?: TestHooks;
  }
}

// Movement sweep matched to lunerfall's core verb: run, jump, and tap attack
// (J is edge-triggered — hold does nothing). `ms` is the hold window; attack
// is tapped every ~260ms inside it.
const INPUT_SCRIPT: Array<{ keys: string[]; ms: number; tapAttack: boolean }> = [
  { keys: ["ArrowRight"], ms: 2400, tapAttack: true },
  { keys: ["ArrowRight", "Space"], ms: 900, tapAttack: false },
  { keys: ["ArrowLeft"], ms: 2400, tapAttack: true },
  { keys: ["ArrowLeft", "Space"], ms: 900, tapAttack: false },
  { keys: ["ArrowRight"], ms: 2800, tapAttack: true },
  { keys: ["ArrowUp"], ms: 700, tapAttack: true },
  { keys: ["ArrowLeft"], ms: 2800, tapAttack: true },
  { keys: ["ArrowRight", "Space"], ms: 900, tapAttack: false },
  { keys: ["ArrowRight"], ms: 2400, tapAttack: true },
  { keys: ["ArrowLeft"], ms: 2400, tapAttack: true },
];

test("bot playtest: scripted sweep progresses a seeded combat room", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  // ?hero skips the select screen; ?room=combat drops straight into a fight.
  await page.goto("/?hero=axion&room=combat");
  await page.waitForFunction(() => (window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  // seed() reseeds the gameplay RNG and restarts the run — the frames above
  // were unseeded and are not measured.
  await page.evaluate(() => window.__GAME_TEST_HOOKS__?.seed(12345));
  await page.waitForFunction(() => (window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10);

  const sample = () =>
    page.evaluate(() => {
      const d = window.__GAME_DIAGNOSTICS__;
      if (!d) return null;
      return {
        frame: d.frame,
        score: d.score,
        complete: d.complete,
        x: d.player.x,
        y: d.player.y,
        entities: d.entities,
      };
    });

  const before = await sample();
  expect(before, "diagnostics must be published").not.toBeNull();
  if (!before) return;

  let prev = before;
  let distance = 0;
  let softlockWindows = 0;
  let stepOfFirstScore = -1;

  for (const [index, step] of INPUT_SCRIPT.entries()) {
    for (const key of step.keys) await page.keyboard.down(key);
    if (step.tapAttack) {
      for (let t = 0; t < step.ms; t += 260) {
        await page.keyboard.press("KeyJ", { delay: 40 });
        await page.waitForTimeout(220);
      }
    } else {
      await page.waitForTimeout(step.ms);
    }
    for (const key of step.keys) await page.keyboard.up(key);

    const snap = await sample();
    if (!snap) continue;
    const moved = Math.hypot(snap.x - prev.x, snap.y - prev.y);
    distance += moved;
    const progressed = snap.score > prev.score;
    if (progressed && stepOfFirstScore === -1) stepOfFirstScore = index;
    // Softlock signature: frames advance, held input moves nothing, no progress.
    if (snap.frame > prev.frame && moved < 2 && !progressed) softlockWindows += 1;
    prev = snap;
    if (snap.complete) break; // died — everything measured so far still counts
  }

  const report = {
    framesAdvanced: prev.frame - before.frame,
    scoreBefore: before.score,
    scoreAfter: prev.score,
    distanceTravelled: Number(distance.toFixed(1)),
    stepOfFirstScore,
    softlockWindows,
    entitiesAtEnd: prev.entities,
    completed: prev.complete,
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
  expect(report.distanceTravelled, "player must respond to input (px)").toBeGreaterThan(150);
  expect(report.softlockWindows, "held input repeatedly produced nothing").toBeLessThanOrEqual(2);
  expect(report.scoreAfter, "attack sweep should kill something").toBeGreaterThan(
    report.scoreBefore,
  );
});
