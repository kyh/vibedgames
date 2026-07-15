import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Solo BEACON e2e (dir-004) — offline arena, same probe surface as
// bot-playtest.spec.ts (`window.__starfall` dev hooks + __GAME_DIAGNOSTICS__).
// Covers the solo acceptance criteria:
//   1/2 (shape)  organic trigger fires in the t≈90 trough window (arena epoch
//                rewound so the wait is seconds, not minutes), never before
//   3            CHARGE is 8s / ACTIVE 40s (asserted from the shared
//                timestamps; the payout run uses compressed dev-hook timers)
//   4            sole controller gains ~3 XP/s; stepping out stops the trickle
//   6/10         controlled expiry pays +40 XP AND exactly one loot crystal at
//                the beacon center, on a LEVEL-CAPPED player, with
//                ITEMS_MAX_LIVE already saturated (cap bypass)
//   11           the hold changes no level — score ticking is the only trace
//
// Headless caveat: SwiftShader runs single-digit FPS; the sim clock is
// wall-based, so XP-tick counts get generous bands, never exact frames.

type BeaconDiag = {
  x: number;
  y: number;
  phase: "charge" | "active";
  controllerId: string | null;
  contested: boolean;
} | null;

type BeaconShared = {
  x: number;
  y: number;
  activeAt: number;
  diesAt: number;
  controllerId: string | null;
  contested: boolean;
};

type Diagnostics = {
  frame: number;
  score: number;
  entities: number;
  beacon: BeaconDiag;
};

// Runtime-reachable slice of the scene (TS-private fields are plain JS in
// page.evaluate) + the dev hooks this spec drives.
type StarfallProbe = {
  scene: {
    shipX: number;
    shipY: number;
    shipVX: number;
    shipVY: number;
    level: number;
    alive: boolean;
    gainXp: (amount: number, now: number) => void;
    world: {
      arenaEpoch: number;
      beacon: BeaconShared | null;
      items: Array<{ x: number; y: number }>;
    };
  };
  grantBooster: (kind: string) => void;
  grantShield: (kind: string) => void;
  spawnItem: (cls: "weapon" | "shield" | "booster", name: string, x?: number, y?: number) => void;
  spawnBeacon: (x?: number, y?: number, chargeS?: number, activeS?: number) => boolean;
  setArenaEpoch: (epochMs: number) => void;
};

declare global {
  interface Window {
    __starfall?: StarfallProbe;
    __GAME_DIAGNOSTICS__?: Diagnostics;
    __GAME_TEST_HOOKS__?: { setState(name: string): void };
  }
}

/** One survival beat: pin the ship at (x,y) and top the shield, so lured
 *  enemies converging on the zone can't kill the bot mid-assertion. */
const pinBeat = (page: Page, x: number, y: number): Promise<void> =>
  page.evaluate(
    ([px, py]) => {
      const h = window.__starfall;
      if (!h) return;
      h.scene.shipX = px;
      h.scene.shipY = py;
      h.scene.shipVX = 0;
      h.scene.shipVY = 0;
      h.grantBooster("repair");
      h.grantShield("overshield");
    },
    [x, y],
  );

const score = (page: Page): Promise<number> =>
  page.evaluate(() => window.__GAME_DIAGNOSTICS__?.score ?? 0);

test("solo beacon: trough trigger, phase timers, trickle, capped-player hold crystal with cap bypass", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  await page.goto("/?seed=777&offline=1");
  await page.waitForFunction(() => (window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  await page.evaluate(() => window.__GAME_TEST_HOOKS__?.setState("active-play"));
  await page.waitForFunction(() => window.__starfall !== undefined);

  // ---- criterion 1 (shape): no beacon in the opening minute... ----
  expect(await page.evaluate(() => window.__GAME_DIAGNOSTICS__?.beacon ?? null)).toBeNull();

  // ...then rewind the arena epoch so tSec jumps to ≈86 and the ORGANIC
  // trigger (trough window gate at t≥90, tSec mod 90 ∈ [0,5]) fires on the
  // real host code path within a few seconds.
  await page.evaluate(() => {
    const h = window.__starfall;
    if (h) h.setArenaEpoch(h.scene.world.arenaEpoch - 86_000);
  });
  await page.waitForFunction(() => window.__GAME_DIAGNOSTICS__?.beacon !== null, undefined, {
    timeout: 25_000,
  });

  // ---- criterion 3: phase timers from the shared timestamps ----
  const spawn = await page.evaluate(() => {
    const b = window.__starfall?.scene.world.beacon;
    return b ? { activeAt: b.activeAt, diesAt: b.diesAt, now: Date.now(), x: b.x, y: b.y } : null;
  });
  expect(spawn).not.toBeNull();
  if (!spawn) return;
  expect(spawn.diesAt - spawn.activeAt).toBe(40_000); // ACTIVE = 40s
  expect(spawn.activeAt - spawn.now).toBeGreaterThan(0); // still charging
  expect(spawn.activeAt - spawn.now).toBeLessThanOrEqual(8_000); // CHARGE = 8s
  expect(await page.evaluate(() => window.__GAME_DIAGNOSTICS__?.beacon?.phase ?? "")).toBe(
    "charge",
  );

  // ---- criterion 4: sole-controller trickle at ~3 XP/s ----
  await page.waitForFunction(
    () => window.__GAME_DIAGNOSTICS__?.beacon?.phase === "active",
    undefined,
    { timeout: 15_000 },
  );
  await pinBeat(page, spawn.x, spawn.y);
  await page.waitForFunction(
    () => window.__GAME_DIAGNOSTICS__?.beacon?.controllerId === "solo",
    undefined,
    { timeout: 5_000 },
  );
  const s0 = await score(page);
  const holdStart = Date.now();
  while (Date.now() - holdStart < 6_000) {
    await pinBeat(page, spawn.x, spawn.y);
    await page.waitForTimeout(250);
  }
  const s1 = await score(page);
  // ~6 ticks × 3 XP; the bot never fires, so the trickle is the only source.
  expect(s1 - s0, "sole-controller trickle ≈ 3 XP/s").toBeGreaterThanOrEqual(9);
  expect(s1 - s0, "trickle never exceeds 3 XP/s").toBeLessThanOrEqual(30);

  // Stepping out stops the trickle within a tick.
  const outX = spawn.x > 2000 ? spawn.x - 1800 : spawn.x + 1800;
  await pinBeat(page, outX, spawn.y);
  await page.waitForFunction(
    () => window.__GAME_DIAGNOSTICS__?.beacon?.controllerId === null,
    undefined,
    { timeout: 5_000 },
  );
  await page.waitForTimeout(400); // let any already-crossed tick boundary land
  const s2 = await score(page);
  const idleStart = Date.now();
  while (Date.now() - idleStart < 2_500) {
    await pinBeat(page, outX, spawn.y);
    await page.waitForTimeout(250);
  }
  const s3 = await score(page);
  expect(s3 - s2, "no trickle while outside the zone").toBeLessThanOrEqual(3);

  // ---- criteria 6/10/11: capped-player hold payout with the item cap full ----
  // Cap the player (LEVEL_CAP = 3) — qa-008's point: capped players ARE the
  // beacon's main audience, and the payout must not be XP-only for them.
  await page.evaluate(() => window.__starfall?.scene.gainXp(1_000, 0));
  expect(await page.evaluate(() => window.__starfall?.scene.level ?? 0)).toBe(3);

  // Saturate ITEMS_MAX_LIVE (6) with far-away pickups nobody can touch.
  await page.evaluate(() => {
    for (let i = 0; i < 6; i++) window.__starfall?.spawnItem("booster", "nitro", 150 + i * 40, 150);
  });
  const itemsBefore = await page.evaluate(() => window.__starfall?.scene.world.items.length ?? 0);
  expect(itemsBefore).toBeGreaterThanOrEqual(6);

  // Compressed-timer beacon via the dev hook (clobbers the organic one, which
  // by design pays nothing when replaced early). Ship pinned INSIDE the zone
  // but 280px off-center, so the center-spawned crystal isn't instantly eaten.
  const cx = 2000;
  const cy = 1200;
  await pinBeat(page, cx + 280, cy);
  expect(await page.evaluate(([x, y]) => window.__starfall?.spawnBeacon(x, y, 1, 6) ?? false, [cx, cy])).toBe(true);
  const s4 = await score(page);
  const payoutDeadline = Date.now() + 15_000;
  let expired = false;
  while (Date.now() < payoutDeadline && !expired) {
    await pinBeat(page, cx + 280, cy);
    expired = await page.evaluate(() => window.__GAME_DIAGNOSTICS__?.beacon === null);
    await page.waitForTimeout(200);
  }
  expect(expired, "compressed beacon expired").toBe(true);
  await page.waitForTimeout(400); // one beat for the payout fx/roll to land

  const after = await page.evaluate(([x, y]) => {
    const h = window.__starfall;
    const d = window.__GAME_DIAGNOSTICS__;
    if (!h || !d) return null;
    return {
      score: d.score,
      level: h.scene.level,
      alive: h.scene.alive,
      items: h.scene.world.items.length,
      // Spawned dead-center, drifting ≤30px/s (ITEM_SPEED) since expiry.
      crystalAtCenter: h.scene.world.items.some(
        (it) => Math.hypot(it.x - x, it.y - y) < 120,
      ),
    };
  }, [cx, cy]);
  expect(after).not.toBeNull();
  if (!after) return;
  expect(after.alive, "controller survived the hold").toBe(true);
  // +40 hold bonus (runXp still ticks at cap — criterion 11's "only trace").
  expect(after.score - s4, "hold bonus + trickle landed").toBeGreaterThanOrEqual(40);
  // The crystal: exactly the non-XP payout, at the center, PAST the item cap.
  expect(after.crystalAtCenter, "guaranteed crystal at beacon center").toBe(true);
  expect(after.items, "ITEMS_MAX_LIVE bypassed for the guaranteed payout").toBeGreaterThanOrEqual(
    7,
  );
  // No permanent gain: still level 3 — the crystal is a timed pickup on the
  // floor, not an auto-applied buff.
  expect(after.level).toBe(3);

  expect(pageErrors, "zero page errors").toEqual([]);
  expect(consoleErrors, "zero console errors").toEqual([]);
});
