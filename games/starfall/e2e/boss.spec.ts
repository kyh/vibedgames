import { expect, test } from "@playwright/test";

// DREADNOUGHT durability e2e (qa-009) — offline arena, same probe surface as
// beacon.spec.ts. Drives the REAL host damage pipeline via the dev hook
// (`damageEnemy` routes through hostDamageEnemy) with absurd overkill damage,
// and asserts the per-phase minimum-duration floors:
//   1. a full-HP nuke in phase 1's first seconds CANNOT skip the fight — HP
//      clamps just above the phase-2 boundary (0.66 x maxHp)
//   2. the clamp holds against repeated nukes inside the window
//   3. once BOSS_PHASE_MIN_MS (8s) elapses, damage crosses — but only to the
//      TOP of the next phase (0.33 x maxHp boundary), never past it
//   4. phase 2's window then holds the same way; after it, HP floors at 1
//      (phase 3 entered ALIVE — the enrage script always expresses)
//   5. after phase 3's window the boss can actually die
// Net effect: even vs infinite DPS the fight lasts >= 3 x 8s and every
// phase's attack script runs. (Base-beam solo fights run far longer — the
// floors only bind against stacked specials / full rooms.)

const BOSS_MAX_HP = 14_000; // ENEMY_SPECS.dreadnought.hp = BOSS_HP_BASE
const P2_BOUNDARY = 0.66 * BOSS_MAX_HP; // 9240
const P3_BOUNDARY = 0.33 * BOSS_MAX_HP; // 4620
const FLOOR_MS = 8_000; // BOSS_PHASE_MIN_MS
const NUKE = 50_000; // always overkill from any HP

type StarfallProbe = {
  scene: { shipX: number; shipY: number };
  spawnEnemy: (kind: string, x?: number, y?: number) => string | null;
  damageEnemy: (id: string, amount: number) => number | null;
  grantShield: (raw: string) => void;
  grantBooster: (raw: string) => void;
  summary: () => { enemies: string[] };
};

declare global {
  interface Window {
    __starfall?: StarfallProbe;
    __GAME_DIAGNOSTICS__?: { frame: number };
    __GAME_TEST_HOOKS__?: { setState(name: string): void };
  }
}

test("dreadnought phase floors: overkill damage cannot skip phases; boss dies only after all three windows", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto("/?seed=777&offline=1");
  await page.waitForFunction(() => (window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  await page.evaluate(() => window.__GAME_TEST_HOOKS__?.setState("active-play"));
  await page.waitForFunction(() => window.__starfall !== undefined);

  // The bot's survival is irrelevant to host-side sim assertions, but keep it
  // healthy so death/respawn noise can't muddy the run.
  const shieldUp = () =>
    page.evaluate(() => {
      window.__starfall?.grantBooster("repair");
      window.__starfall?.grantShield("overshield");
    });
  await shieldUp();

  const bossId = await page.evaluate(() => {
    const h = window.__starfall;
    if (!h) return null;
    return h.spawnEnemy("dreadnought", h.scene.shipX + 700, h.scene.shipY);
  });
  expect(bossId, "boss spawned via dev hook").not.toBeNull();
  if (!bossId) return;

  const nuke = () =>
    page.evaluate(
      ([id, amount]) => window.__starfall?.damageEnemy(String(id), Number(amount)) ?? null,
      [bossId, NUKE] as const,
    );

  // 1. Full-overkill nuke at t=0: phase 1's floor holds just above the
  //    phase-2 boundary. With the old constants this single call was 12.5x
  //    the boss's entire HP pool.
  const hp1 = await nuke();
  expect(hp1, "boss survives a full-HP nuke in phase 1").not.toBeNull();
  expect(hp1 ?? 0).toBeGreaterThan(P2_BOUNDARY);
  expect(hp1 ?? 0).toBeLessThan(P2_BOUNDARY + 3);

  // 2. The window holds against repeated overkill.
  const hp2 = await nuke();
  expect(hp2 ?? 0).toBeGreaterThan(P2_BOUNDARY);

  // 3. After the phase-1 window, damage crosses — but only to the top of
  //    phase 2, never through it.
  await page.waitForTimeout(FLOOR_MS + 600);
  await shieldUp();
  const hp3 = await nuke();
  expect(hp3, "boss alive at the top of phase 2").not.toBeNull();
  expect(hp3 ?? 0).toBeGreaterThan(P3_BOUNDARY);
  expect(hp3 ?? 0).toBeLessThan(P3_BOUNDARY + 3);

  // 4. Phase 2's window holds; after it the boss floors at 1 HP — phase 3 is
  //    entered ALIVE, so the enrage script always expresses.
  const hp4 = await nuke();
  expect(hp4 ?? 0).toBeGreaterThan(P3_BOUNDARY);
  await page.waitForTimeout(FLOOR_MS + 600);
  await shieldUp();
  const hp5 = await nuke();
  expect(hp5, "phase 3 entered alive (1 HP floor)").not.toBeNull();
  expect(hp5 ?? 0).toBeGreaterThanOrEqual(1);
  expect(hp5 ?? 0).toBeLessThan(3);
  const stillThere = await page.evaluate(
    () => window.__starfall?.summary().enemies.includes("dreadnought") ?? false,
  );
  expect(stillThere, "dreadnought still in the world during phase 3's window").toBe(true);

  // 5. After phase 3's window the kill goes through (real hostKillEnemy path:
  //    the enemy leaves the world, so damageEnemy reports null).
  await page.waitForTimeout(FLOOR_MS + 600);
  await shieldUp();
  const hp6 = await nuke();
  expect(hp6, "boss killable once all windows have run").toBeNull();
  const gone = await page.evaluate(
    () => window.__starfall?.summary().enemies.includes("dreadnought") ?? true,
  );
  expect(gone, "dreadnought removed from the world").toBe(false);

  expect(pageErrors, "zero page errors").toEqual([]);
});
