import { expect, test } from "@playwright/test";

// SECTOR cycle e2e (dir-006) — offline arena, same probe surface as
// beacon.spec.ts (`window.__starfall` dev hooks + __GAME_DIAGNOSTICS__).
// Covers the assignment's minimum set on the REAL host code paths:
//   1. boundary: sector pts owner-reset to 0, recap banner shows ≤10s and the
//      sim keeps running behind it, lifetime runXp + level + enemies persist
//      (no room reset), HUD line flips to the next sector, and the rel-180
//      standings pulse fires in the new sector
//   2. guaranteed boss: with the organic gates held closed (fresh boss-kill
//      cooldown), a dreadnought force-spawns at sectorRelT≈405 and
//      sectorBossIdx marks the sector satisfied (no second spawn)
//   3. beacon deferral: the rel-450 trough window opens while the boss is
//      alive → no beacon spawns
// Time travel uses setArenaEpoch (rewinding the epoch moves tSec forward),
// exactly like beacon.spec.ts — the gates under test all read arena time.

const SECTOR_LEN_S = 540; // SECTOR_LENGTH_S
const BOSS_AT_S = 405; // SECTOR_BOSS_AT_S

type SectorSummary = {
  alive: boolean;
  now: number;
  enemies: string[];
  sector: { idx: number; rel: number; score: number; best: number; bossIdx: number };
};

type StarfallProbe = {
  scene: {
    shipX: number;
    shipY: number;
    level: number;
    xp: number;
    lastBossKilledAt: number;
    gainXp: (amount: number, now: number) => void;
    world: {
      arenaEpoch: number;
      sectorBossIdx: number;
      beacon: unknown;
      enemies: Array<{ id: string; kind: string }>;
    };
  };
  grantBooster: (kind: string) => void;
  grantShield: (kind: string) => void;
  spawnEnemy: (kind: string, x?: number, y?: number) => string | null;
  setShield: (hp: number) => void;
  fire: () => void;
  setArenaEpoch: (epochMs: number) => void;
  summary: () => SectorSummary;
};

declare global {
  interface Window {
    __starfall?: StarfallProbe;
    __GAME_DIAGNOSTICS__?: { frame: number; score: number; beams: number };
    __GAME_TEST_HOOKS__?: { setState(name: string): void };
  }
}

/** Shift arena time so sectorRelT lands at `targetRel` within the CURRENT
 *  sector (the probe reads rel first, so this never crosses a boundary by
 *  accident — boundary crossings in the tests are always explicit). */
const jumpToRel = (page: import("@playwright/test").Page, targetRel: number): Promise<void> =>
  page.evaluate((rel) => {
    const h = window.__starfall;
    if (!h) return;
    const cur = h.summary().sector.rel;
    h.setArenaEpoch(h.scene.world.arenaEpoch - Math.round((rel - cur) * 1000));
  }, targetRel);

test("sector boundary: score resets, recap shows without stopping play, world persists, pulse fires", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto("/?seed=777&offline=1");
  await page.waitForFunction(() => (window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  await page.evaluate(() => window.__GAME_TEST_HOOKS__?.setState("active-play"));
  await page.waitForFunction(() => window.__starfall !== undefined);

  // Waive sector 0's boss guarantee: this test jumps past rel 405 and wants a
  // clean boundary, not a forced dreadnought (test 2 owns that path).
  await page.evaluate(() => {
    const h = window.__starfall;
    if (h) h.scene.world.sectorBossIdx = 0;
  });

  // Sector pts ride the pre-cap-discard XP sink: 1,000 XP caps the level
  // (LEVEL_CAP=3, beacon.spec precedent); 200 more is discarded as XP but
  // still lands on the sector scoreboard.
  await page.evaluate(() => window.__starfall?.scene.gainXp(1_000, 0));
  const capped = await page.evaluate(() => ({
    level: window.__starfall?.scene.level ?? 0,
    xp: window.__starfall?.scene.xp ?? -1,
    score: window.__starfall?.summary().sector.score ?? 0,
  }));
  expect(capped.level).toBe(3);
  expect(capped.score).toBe(1_000);
  await page.evaluate(() => window.__starfall?.scene.gainXp(200, 0));
  const postCap = await page.evaluate(() => ({
    xp: window.__starfall?.scene.xp ?? -1,
    score: window.__starfall?.summary().sector.score ?? 0,
  }));
  expect(postCap.xp).toBe(capped.xp); // capped XP discarded...
  expect(postCap.score).toBe(1_200); // ...but the sector chase still pays

  // Death costs exactly 0 sector points (the XP death tax is the price).
  await page.evaluate(() => window.__starfall?.setShield(0));
  expect(await page.evaluate(() => window.__starfall?.summary().sector.score ?? -1)).toBe(1_200);
  await page.waitForFunction(() => window.__starfall?.summary().alive === true, undefined, {
    timeout: 15_000,
  });
  await page.evaluate(() => {
    window.__starfall?.grantBooster("repair");
    window.__starfall?.grantShield("overshield");
  });

  // World-persistence marker + pre-boundary lifetime score. Near the ship on
  // purpose: hostDespawnBreather culls the FARTHEST enemy when over cap, and
  // the marker must never be that candidate.
  const markerId = await page.evaluate(() => {
    const h = window.__starfall;
    return h ? h.spawnEnemy("drone", h.scene.shipX + 500, h.scene.shipY + 300) : null;
  });
  expect(markerId).not.toBeNull();
  const levelBefore = await page.evaluate(() => window.__starfall?.scene.level ?? 0);
  const runXpBefore = await page.evaluate(() => window.__GAME_DIAGNOSTICS__?.score ?? 0);
  expect(runXpBefore).toBeGreaterThanOrEqual(1_200);

  // Jump to rel≈537 and let the boundary cross on the live clock. Wait on
  // `best` (written the same tick as the reset), NOT on `idx`: idx derives
  // from the raw clock and flips between frames, so polling it can win the
  // race against the frame that actually processes the crossing.
  await jumpToRel(page, SECTOR_LEN_S - 3);
  await page.waitForFunction(() => (window.__starfall?.summary().sector.best ?? 0) > 0, undefined, {
    timeout: 15_000,
  });
  expect(await page.evaluate(() => window.__starfall?.summary().sector.idx ?? 0)).toBe(1);

  // Owner-reset within a tick of the crossing; nothing else resets.
  const after = await page.evaluate(() => {
    const h = window.__starfall;
    return h
      ? {
          score: h.summary().sector.score,
          best: h.summary().sector.best,
          level: h.scene.level,
          runXp: window.__GAME_DIAGNOSTICS__?.score ?? 0,
          markerAlive: h.scene.world.enemies.map((e) => e.id),
        }
      : null;
  });
  expect(after).not.toBeNull();
  if (!after) return;
  expect(after.score).toBe(0); // criterion 4: reset at the boundary
  expect(after.best).toBe(1_200); // completed score became the session best
  expect(after.runXp).toBeGreaterThanOrEqual(runXpBefore); // criterion 11: lifetime score monotonic
  expect(after.level).toBe(levelBefore); // no room reset: levels persist...
  expect(after.markerAlive).toContain(markerId); // ...and so do live enemies

  // Recap banner: visible, right copy, and the sim keeps running behind it.
  const recap = page.locator("#recap");
  await expect(recap).toHaveCSS("opacity", "1");
  await expect(recap).toContainText("SECTOR 1 COMPLETE");
  await expect(recap).toContainText("PTS");
  // dir-009 presence pass: entry scale-in class + the single winner-row pop
  // (~450ms after show). Still non-blocking — the beam assertion below fires
  // while the banner is up, exactly as before.
  await expect(recap).toHaveClass(/\bin\b/);
  await expect(recap.locator(".row").first()).toHaveClass(/\bpop\b/, { timeout: 3_000 });
  await page.evaluate(() => window.__starfall?.fire());
  expect(await page.evaluate(() => window.__GAME_DIAGNOSTICS__?.beams ?? 0)).toBeGreaterThan(0);
  await expect(page.locator("#sector")).toContainText("SECTOR 2");

  // Gone by rel 15 (10s show + fade).
  await expect(recap).toHaveCSS("opacity", "0", { timeout: 15_000 });

  // Standings pulse at rel 180 (solo variant: pts vs session best), 5s.
  await jumpToRel(page, 179);
  const pulse = page.locator("#pulse");
  await expect(pulse).toHaveCSS("opacity", "1", { timeout: 8_000 });
  await expect(pulse).toContainText("BEST 1,200");
  await expect(pulse).toHaveCSS("opacity", "0", { timeout: 10_000 });

  expect(pageErrors).toEqual([]);
});

test("qa-020: offline-solo sector clock starts at first input, not at boot", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto("/?seed=777&offline=1");
  await page.waitForFunction(() => (window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10);

  // Idle on the attract overlay: pre-fix this burned real sector time (the
  // HUD showed 8:5x before first input). beginPlay must re-stamp arenaEpoch.
  await page.waitForTimeout(3_000);
  await page.evaluate(() => window.__GAME_TEST_HOOKS__?.setState("active-play"));
  await page.waitForFunction(() => window.__starfall !== undefined);
  const rel = await page.evaluate(() => window.__starfall?.summary().sector.rel ?? -1);
  expect(rel).toBeGreaterThanOrEqual(0);
  expect(rel).toBeLessThan(2.5); // the 3s overlay idle did NOT reach the clock

  expect(pageErrors).toEqual([]);
});

test("guaranteed boss force-spawns at rel 405 with organic gates closed; beacon defers while it lives", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto("/?seed=777&offline=1");
  await page.waitForFunction(() => (window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  await page.evaluate(() => window.__GAME_TEST_HOOKS__?.setState("active-play"));
  await page.waitForFunction(() => window.__starfall !== undefined);
  await page.evaluate(() => {
    window.__starfall?.grantBooster("repair");
    window.__starfall?.grantShield("overshield");
  });

  // Close the ORGANIC spawn path: a fresh "boss just died" stamp puts the
  // 150s cooldown gate in front of the intensity trigger (rel 405 is a wave
  // peak by design, so intensity alone would open it). The FORCED path
  // deliberately bypasses this cooldown — that's exactly what we isolate.
  await page.evaluate(() => {
    const h = window.__starfall;
    if (h) h.scene.lastBossKilledAt = h.summary().now;
  });

  expect(await page.evaluate(() => window.__starfall?.summary().enemies ?? [])).not.toContain(
    "dreadnought",
  );

  // Sit just before the guarantee beat; organic stays closed across it.
  await jumpToRel(page, BOSS_AT_S - 5);
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => window.__starfall?.summary().enemies ?? [])).not.toContain(
    "dreadnought",
  );

  // rel 405 (±1 host tick): the forced spawn fires and marks the sector.
  await page.waitForFunction(
    () => window.__starfall?.summary().enemies.includes("dreadnought") ?? false,
    undefined,
    { timeout: 15_000 },
  );
  const at = await page.evaluate(() => window.__starfall?.summary().sector ?? null);
  expect(at).not.toBeNull();
  if (!at) return;
  expect(at.rel).toBeGreaterThanOrEqual(BOSS_AT_S);
  expect(at.rel).toBeLessThan(BOSS_AT_S + 7); // ±1 tick + polling slop
  expect(at.bossIdx).toBe(0); // satisfied-marker set

  // Satisfied sector: no second dreadnought (criterion 6).
  await page.waitForTimeout(2_500);
  const bossCount = await page.evaluate(
    () => window.__starfall?.scene.world.enemies.filter((e) => e.kind === "dreadnought").length ?? 0,
  );
  expect(bossCount).toBe(1);

  // Beacon deferral (criterion 7): open the rel-450 trough window with the
  // boss alive — beacon.spec proves this exact window spawns one otherwise.
  await jumpToRel(page, 448);
  await page.waitForFunction(() => (window.__starfall?.summary().sector.rel ?? 0) >= 456, undefined, {
    timeout: 15_000,
  });
  expect(await page.evaluate(() => window.__starfall?.scene.world.beacon ?? null)).toBeNull();
  expect(await page.evaluate(() => window.__starfall?.summary().enemies ?? [])).toContain(
    "dreadnought",
  );

  expect(pageErrors).toEqual([]);
});
