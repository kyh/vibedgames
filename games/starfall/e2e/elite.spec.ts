import { expect, test } from "@playwright/test";

// Elite durability e2e (qa-018 / dir-007) — offline arena, same probe surface
// as boss.spec.ts. Two layers:
//   1. Stamp inspection (criteria 2 + 8): the host stamps elite hp at spawn
//      via eliteHp(kind, maxPresentLevel) — Lv1 room = exact base, Lv3 room =
//      ×6.06, stamped ONCE (no retro-buff); sniper/fodder stay flat and the
//      fodder one-shot rule holds.
//   2. Live TTK probes (criteria 3-7, cycle-15 method): dev-spawn one elite,
//      epoch pinned to intensity≈0, real mouse aim (the ship chases the
//      cursor, so pinning it on the elite is sustained point-blank focus) +
//      held-SPACE autofire, TTK measured fire-start → death on the sim clock.
//      Each probe asserts the elite's signature mechanic EXPRESSES before
//      death — the entire point of the retune.
//
// Expected stamps mirror shared/constants.ts: baseBeamDps L1 = 100,
// L3 = 3×0.40×100/0.198 ≈ 606.06 → eliteHpMult(3) ≈ 6.0606.

const LV3 = { lancer: 970, splitter: 1455, warden: 3152, spawner: 3030 };
const LV1 = { lancer: 160, splitter: 240, warden: 520, spawner: 500 };

type EnemyView = { id: string; kind: string; hp: number; maxHp: number; graceUntil: number };

type StarfallProbe = {
  scene: {
    shipX: number;
    shipY: number;
    level: number;
    gainXp: (amount: number, now: number) => void;
    enemySim: Map<
      string,
      { lancerPhase: "cruise" | "windup" | "charge" | "recover"; broodCount: number }
    >;
    cameras: { main: { worldView: { x: number; y: number }; zoom: number } };
    world: {
      arenaEpoch: number;
      enemies: Array<
        EnemyView & {
          x: number;
          y: number;
          vx: number;
          vy: number;
          shielded: boolean;
          chargeUntil: number;
        }
      >;
    };
  };
  grantBooster: (kind: string) => void;
  grantShield: (kind: string) => void;
  spawnEnemy: (kind: string, x?: number, y?: number) => string | null;
  damageEnemy: (id: string, amount: number) => number | null;
  setArenaEpoch: (epochMs: number) => void;
  summary: () => { now: number; alive: boolean };
};

declare global {
  interface Window {
    __starfall?: StarfallProbe;
    __GAME_DIAGNOSTICS__?: { frame: number };
    __GAME_TEST_HOOKS__?: { setState(name: string): void };
  }
}

/** Boot the offline arena, pin the epoch (intensity≈0 — clean reads, no
 *  organic swarm mid-probe), and armor the bot. */
async function boot(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/?seed=777&offline=1");
  await page.waitForFunction(() => (window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  await page.evaluate(() => window.__GAME_TEST_HOOKS__?.setState("active-play"));
  await page.waitForFunction(() => window.__starfall !== undefined);
  await page.evaluate(() => {
    const h = window.__starfall;
    if (!h) return;
    h.setArenaEpoch(h.summary().now);
    h.grantBooster("repair");
    h.grantShield("overshield");
  });
}

const capLevel = (page: import("@playwright/test").Page): Promise<void> =>
  page.evaluate(() => window.__starfall?.scene.gainXp(1_000, 0));

/** Spawn `kind` at ship+dx and return its freshly-stamped hp/maxHp (read in
 *  the same evaluate — hostDespawnBreather can never cull it first). */
const spawnRead = (
  page: import("@playwright/test").Page,
  kind: string,
  dx = 900,
): Promise<{ hp: number; maxHp: number; id: string } | null> =>
  page.evaluate(
    ([k, d]) => {
      const h = window.__starfall;
      if (!h) return null;
      const id = h.spawnEnemy(String(k), h.scene.shipX + Number(d), h.scene.shipY + 200);
      if (!id) return null;
      const e = h.scene.world.enemies.find((en) => en.id === id);
      return e ? { hp: e.hp, maxHp: e.maxHp, id } : null;
    },
    [kind, dx] as const,
  );

type FightSample = {
  now: number;
  hp: number;
  shielded: boolean;
  phase: string | null;
  brood: number;
};

type FightResult = {
  ttkS: number | null;
  samples: FightSample[];
  gracedDronesAtDeath: number;
};

/** The cycle-15 probe: spawn one elite near the ship, pin the cursor on it
 *  every ~80ms (velocity-led — the ship chases the cursor into point-blank
 *  range), hold SPACE for real autofire, re-armor each poll, and measure
 *  fire-start → death on the sim clock. */
async function fightElite(
  page: import("@playwright/test").Page,
  kind: string,
  timeoutMs: number,
): Promise<FightResult> {
  const spawned = await spawnRead(page, kind, 300);
  expect(spawned, `${kind} spawned via dev hook`).not.toBeNull();
  if (!spawned) return { ttkS: null, samples: [], gracedDronesAtDeath: 0 };
  const id = spawned.id;

  const poll = (): Promise<
    | { gone: true; now: number; graced: number }
    | (FightSample & { gone: false; sx: number; sy: number })
    | null
  > =>
    page.evaluate((eid) => {
      const h = window.__starfall;
      if (!h) return null;
      const now = h.summary().now;
      h.grantBooster("repair");
      h.grantShield("overshield");
      const e = h.scene.world.enemies.find((en) => en.id === eid);
      if (!e) {
        const graced = h.scene.world.enemies.filter(
          (en) => en.kind === "drone" && en.graceUntil > now,
        ).length;
        return { gone: true as const, now, graced };
      }
      const sim = h.scene.enemySim.get(eid);
      const cam = h.scene.cameras.main;
      const phase = sim?.lancerPhase ?? null;
      // The cursor is BOTH aim and thrust target (the ship chases it), so the
      // probe plays the designed counter-play, not naive pursuit:
      // - windup: hold position with the nose on the lancer — its locked
      //   charge vector lands it right beside the ship;
      // - charge: fly to the charge ENDPOINT so the melt resumes the moment
      //   it stops (beams at 520 px/s can't catch a 640 px/s charge anyway);
      // - otherwise: pin the cursor on the hull with a small intercept lead —
      //   point-blank keeps the whole Lv3 pellet fan connecting.
      const sx0 = h.scene.shipX;
      const sy0 = h.scene.shipY;
      let tx: number;
      let ty: number;
      if (phase === "windup") {
        const d = Math.hypot(e.x - sx0, e.y - sy0) || 1;
        tx = sx0 + ((e.x - sx0) / d) * 60;
        ty = sy0 + ((e.y - sy0) / d) * 60;
      } else if (phase === "charge") {
        const rem = Math.max(0, (e.chargeUntil - now) / 1000);
        tx = e.x + e.vx * rem;
        ty = e.y + e.vy * rem;
      } else {
        const lead = Math.min(0.2, Math.hypot(e.x - sx0, e.y - sy0) / 520);
        tx = e.x + e.vx * lead;
        ty = e.y + e.vy * lead;
      }
      return {
        gone: false as const,
        now,
        hp: e.hp,
        shielded: e.shielded === true,
        phase,
        brood: sim?.broodCount ?? 0,
        sx: (tx - cam.worldView.x) * cam.zoom,
        sy: (ty - cam.worldView.y) * cam.zoom,
      };
    }, id);

  // Aim before the first shot so TTK starts at fire-start, not acquire-start.
  const first = await poll();
  if (first && !first.gone) {
    await page.mouse.move(
      Math.min(1272, Math.max(8, first.sx)),
      Math.min(712, Math.max(8, first.sy)),
    );
  }
  const t0 = await page.evaluate(() => window.__starfall?.summary().now ?? 0);
  await page.keyboard.down("Space");

  const samples: FightSample[] = [];
  let ttkS: number | null = null;
  let gracedDronesAtDeath = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await poll();
    if (!s) break;
    if (s.gone) {
      ttkS = (s.now - t0) / 1000;
      gracedDronesAtDeath = s.graced;
      break;
    }
    samples.push({ now: s.now, hp: s.hp, shielded: s.shielded, phase: s.phase, brood: s.brood });
    await page.mouse.move(Math.min(1272, Math.max(8, s.sx)), Math.min(712, Math.max(8, s.sy)));
    await page.waitForTimeout(25);
  }
  await page.keyboard.up("Space");
  return { ttkS, samples, gracedDronesAtDeath };
}

/** Distinct vent windows = shielded true→false transitions in the samples
 *  (the pre-first-telegraph default-false stretch never counts). */
const ventWindows = (samples: FightSample[]): number => {
  let n = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (prev && cur && prev.shielded && !cur.shielded) n++;
  }
  return n;
};

test("criteria 2+8: elite hp stamps Lv1 exact / Lv3 ×6.06, stamped once; sniper+fodder flat, fodder one-shot", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await boot(page);

  // Lv1 room: elites spawn at exactly base HP (hp AND maxHp stamped).
  for (const [kind, hp] of Object.entries(LV1)) {
    const e = await spawnRead(page, kind);
    expect(e?.hp, `${kind} Lv1 hp`).toBe(hp);
    expect(e?.maxHp, `${kind} Lv1 maxHp`).toBe(hp);
  }
  // Exempt kinds keep their spec hp at Lv1...
  const sniper1 = await spawnRead(page, "sniper");
  expect(sniper1?.hp).toBe(35);
  // ...and fodder dies to one L1 pellet (25 dmg): kill = damageEnemy → null.
  const drone = await spawnRead(page, "drone");
  const wasp = await spawnRead(page, "wasp");
  expect(drone?.hp).toBe(20);
  expect(wasp?.hp).toBe(25);
  for (const f of [drone, wasp]) {
    if (!f) continue;
    const after = await page.evaluate((id) => window.__starfall?.damageEnemy(id, 25), f.id);
    expect(after, "fodder one-shot rule").toBeNull();
  }

  // Keep a live Lv1 warden across the level-up: stamped ONCE, never
  // retro-buffed by a mid-fight level. Close enough (+600) to never be the
  // despawn breather's farthest-enemy cull candidate (min dist 1200).
  const held = await spawnRead(page, "warden", 600);
  expect(held?.hp).toBe(LV1.warden);

  await page.evaluate(() => {
    window.__starfall?.grantBooster("repair");
    window.__starfall?.grantShield("overshield");
  });
  await capLevel(page);
  expect(await page.evaluate(() => window.__starfall?.scene.level ?? 0)).toBe(3);

  // Lv3 room: ~6.06× (±1 rounding), sniper still 35 flat, fodder untouched.
  for (const [kind, hp] of Object.entries(LV3)) {
    const e = await spawnRead(page, kind);
    expect(e, `${kind} Lv3 spawned`).not.toBeNull();
    if (!e) continue;
    expect(Math.abs(e.hp - hp), `${kind} Lv3 hp ${e.hp} ≈ ${hp}`).toBeLessThanOrEqual(1);
    expect(e.maxHp).toBe(e.hp);
  }
  const sniper3 = await spawnRead(page, "sniper");
  expect(sniper3?.hp, "sniper exempt in every room composition").toBe(35);
  const drone3 = await spawnRead(page, "drone");
  expect(drone3?.hp).toBe(20);

  // The pre-level warden kept its Lv1 stamp.
  const heldNow = await page.evaluate(
    (id) => window.__starfall?.scene.world.enemies.find((e) => e.id === id)?.maxHp ?? null,
    held?.id ?? "",
  );
  expect(heldNow, "live elite never retro-buffed by a level-up").toBe(LV1.warden);

  expect(pageErrors).toEqual([]);
});

test("criterion 3: WARDEN under Lv3 point-blank focus — second vent window opens before death, TTK 8-14s", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await boot(page);
  await capLevel(page);

  const fight = await fightElite(page, "warden", 25_000);
  expect(fight.ttkS, "warden fight ends (no stall)").not.toBeNull();
  expect(fight.ttkS ?? 0).toBeGreaterThanOrEqual(8);
  expect(fight.ttkS ?? 99).toBeLessThanOrEqual(14);
  expect(
    ventWindows(fight.samples),
    "≥2 vent windows — the qa-018 headline",
  ).toBeGreaterThanOrEqual(2);
  expect(pageErrors).toEqual([]);
});

test("criterion 7: WARDEN in a Lv1 room — the dance is level-invariant (vent 2 opens, TTK ≤14s)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await boot(page);

  const fight = await fightElite(page, "warden", 25_000);
  expect(fight.ttkS, "Lv1 warden is no sponge — fight ends").not.toBeNull();
  expect(fight.ttkS ?? 99).toBeLessThanOrEqual(14);
  expect(ventWindows(fight.samples), "second vent window at Lv1 too").toBeGreaterThanOrEqual(2);
  expect(pageErrors).toEqual([]);
});

test("criterion 4: HIVE under Lv3 focus — first brood pulse lands before death, TTK 4.5-7s", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await boot(page);
  await capLevel(page);

  const fight = await fightElite(page, "spawner", 20_000);
  expect(fight.ttkS, "hive fight ends").not.toBeNull();
  expect(fight.ttkS ?? 0).toBeGreaterThanOrEqual(4.5);
  expect(fight.ttkS ?? 99).toBeLessThanOrEqual(7);
  const maxBrood = Math.max(0, ...fight.samples.map((s) => s.brood));
  expect(maxBrood, "≥1 brood pulse actually spawned mites").toBeGreaterThanOrEqual(1);
  expect(pageErrors).toEqual([]);
});

test("criteria 5+6: LANCER full windup→charge before death (TTK 1.3-3.5s); SPLITTER TTK 2-4.5s with graced children", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await boot(page);
  await capLevel(page);

  const lancer = await fightElite(page, "lancer", 15_000);
  expect(lancer.ttkS, "lancer fight ends").not.toBeNull();
  expect(lancer.ttkS ?? 0).toBeGreaterThanOrEqual(1.3);
  expect(lancer.ttkS ?? 99).toBeLessThanOrEqual(3.5);
  const phases = lancer.samples.map((s) => s.phase);
  expect(phases, "windup observed").toContain("windup");
  expect(phases, "charge observed — a full windup→charge before death").toContain("charge");

  const splitter = await fightElite(page, "splitter", 15_000);
  expect(splitter.ttkS, "splitter fight ends").not.toBeNull();
  expect(splitter.ttkS ?? 0).toBeGreaterThanOrEqual(2);
  expect(splitter.ttkS ?? 99).toBeLessThanOrEqual(4.5);
  expect(
    splitter.gracedDronesAtDeath,
    "children spawned with grace exactly as today",
  ).toBeGreaterThanOrEqual(2);

  expect(pageErrors).toEqual([]);
});
