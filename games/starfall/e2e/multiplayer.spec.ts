import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Two-client multiplayer e2e (backlog qa-003) — productionizes QA's proven
// scratch harness. Runs two real browser contexts against the party server on
// :8787 (booted/reused by playwright.config.ts) and asserts the four MP
// contracts BEACON's acceptance criteria lean on: join, position sync, mutual
// PvP damage, and host migration.
//
// Probe surface: the DEV-only `window.__starfall` hooks (client + scene) and
// `window.__GAME_DIAGNOSTICS__`, same pattern as bot-playtest.spec.ts. Scene
// fields like shipX/pvpIframeUntil are TS-private but runtime-reachable —
// page.evaluate is plain JS, and the local type below mirrors just the slice
// this spec touches.
//
// Isolation: each run gets a fresh arena via the DEV-only ?room= override, so
// a stale room's world (or a concurrently running dev client) can't leak into
// assertions.

type NetPlayerState = {
  x: number;
  y: number;
  alive: boolean;
  present: boolean;
  shieldHp: number;
};

type BeaconShared = {
  x: number;
  y: number;
  activeAt: number;
  diesAt: number;
  controllerId: string | null;
  contested: boolean;
};

type StarfallProbe = {
  client: {
    playerId: string | null;
    isHost: boolean;
    connectionStatus: string;
    players: Record<string, { id: string; state?: NetPlayerState }>;
  };
  scene: {
    shipX: number;
    shipY: number;
    shipVX: number;
    shipVY: number;
    shipAngle: number;
    world: { arenaEpoch: number; beacon: BeaconShared | null };
    pvpIframeUntil: Map<string, number>;
  };
  fire: () => void;
  grantBooster: (kind: string) => void;
  grantShield: (kind: string) => void;
  spawnEnemy: (kind: string, x?: number, y?: number) => string | null;
  spawnBeacon: (x?: number, y?: number, chargeS?: number, activeS?: number) => boolean;
  summary: () => { shieldHp: number; isHost: boolean };
};

type BeaconDiag = { phase: "charge" | "active" } | null;

declare global {
  interface Window {
    __starfall?: StarfallProbe;
    __GAME_DIAGNOSTICS__?: { frame: number; score: number; beacon: BeaconDiag };
  }
}

/** Boot a client into the shared room and dismiss the start overlay. */
async function joinArena(page: Page, room: string): Promise<string> {
  await page.goto(`/?room=${room}`);
  await page.waitForFunction(() => (window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  await page.waitForFunction(
    () =>
      window.__starfall?.client.connectionStatus === "connected" &&
      window.__starfall.client.playerId !== null,
  );
  // Dismiss the start overlay the way a real player does — any keyup. The
  // bot-playtest hook (`setState("active-play")`) is WRONG here: it forces
  // the offline solo fallback and destroys the multiplayer client.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("start")?.isConnected !== true);
  const id = await page.evaluate(() => window.__starfall?.client.playerId ?? null);
  expect(id).not.toBeNull();
  return id ?? "";
}

/** Pin the local ship at a fixed spot/heading (kills drift from steering). */
async function pinShip(page: Page, x: number, y: number, angle: number): Promise<void> {
  await page.evaluate(
    ([px, py, pa]) => {
      const s = window.__starfall?.scene;
      if (!s) return;
      s.shipX = px;
      s.shipY = py;
      s.shipVX = 0;
      s.shipVY = 0;
      s.shipAngle = pa;
    },
    [x, y, angle],
  );
}

test("two clients: join, position sync, mutual PvP damage, host migration", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const room = `e2e-${Date.now().toString(36)}`;

  const errors: string[] = [];
  const track = (label: string, page: Page): void => {
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`${label} console: ${m.text()}`);
    });
  };

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  track("A", pageA);
  track("B", pageB);

  // ---- join: both clients see both players, exactly one host ----
  const idA = await joinArena(pageA, room);
  const idB = await joinArena(pageB, room);
  expect(idA).not.toEqual(idB);
  for (const page of [pageA, pageB]) {
    await page.waitForFunction(
      () => Object.keys(window.__starfall?.client.players ?? {}).length === 2,
    );
  }
  const hostA = await pageA.evaluate(() => window.__starfall?.client.isHost ?? false);
  const hostB = await pageB.evaluate(() => window.__starfall?.client.isHost ?? false);
  expect(hostA !== hostB).toBe(true);

  // ---- position sync: B's mirror of A tracks A's live position ----
  // A drifts under normal cursor-steering; require B's copy of A within 250px
  // of A's self-reported position (20Hz snapshots + dead reckoning) at two
  // spots ≥200px apart — two matching samples at distinct positions prove the
  // mirror is live, not a stale snapshot.
  await pinShip(pageA, 1500, 1000, 0); // start from a known mid-world spot
  const matched: Array<{ x: number; y: number }> = [];
  // qa-015 deflake: sample both pages CONCURRENTLY — sequential evaluates on
  // a starved SwiftShader worker let A drift between the two reads, inflating
  // apparent mirror error past the (correct) 250px bound. 40s of retries
  // rides out full-suite load spikes; bound + spot separation stay exact.
  const syncDeadline = Date.now() + 40_000;
  while (Date.now() < syncDeadline && matched.length < 2) {
    const [aPos, bView] = await Promise.all([
      pageA.evaluate(() => {
        const s = window.__starfall?.scene;
        return s ? { x: s.shipX, y: s.shipY } : null;
      }),
      pageB.evaluate(
        (aId) => window.__starfall?.client.players[aId]?.state ?? null,
        idA,
      ),
    ]);
    if (aPos && bView && Math.hypot(aPos.x - bView.x, aPos.y - bView.y) < 250) {
      const first = matched[0];
      if (!first || Math.hypot(aPos.x - first.x, aPos.y - first.y) > 200) matched.push(aPos);
    }
    await pageA.waitForTimeout(400);
  }
  expect(matched.length, "B tracked A within 250px at two spots ≥200px apart").toBe(2);

  // ---- mutual PvP damage (victim-side adjudication) ----
  // Face the ships at each other 120px apart and volley until each victim's
  // pvpIframeUntil map names the other player — that map is only written when
  // a remote player's serialized beam actually drains this ship, so it is an
  // attributable "PvP damage landed" signal that ambient enemy contact can't
  // fake. Ships are re-pinned and shields re-topped every beat so enemy
  // pressure can't kill anyone mid-assertion.
  // One evaluate per beat per page: at single-digit headless FPS a frame
  // between "pin" and "fire" would let cursor-steering swing the heading.
  const volley = (page: Page, x: number, y: number, angle: number): Promise<void> =>
    page.evaluate(
      ([px, py, pa]) => {
        const h = window.__starfall;
        if (!h) return;
        h.scene.shipX = px;
        h.scene.shipY = py;
        h.scene.shipVX = 0;
        h.scene.shipVY = 0;
        h.scene.shipAngle = pa;
        h.grantBooster("repair");
        h.fire();
      },
      [x, y, angle],
    );
  // Hits are ACCUMULATED across beats: the two directions land in different
  // beats (i-frame entries expire within ~1s), and an ambient enemy kill puts
  // the victim behind respawn invulnerability for a while — requiring both
  // sides to show up in the same 150ms read made this flake.
  const pvpDeadline = Date.now() + 45_000;
  const aHitBy = new Set<string>();
  const bHitBy = new Set<string>();
  while (Date.now() < pvpDeadline && !(aHitBy.has(idB) && bHitBy.has(idA))) {
    await volley(pageA, 2000, 1200, 0); // facing +x, toward B
    await volley(pageB, 2120, 1200, Math.PI); // facing -x, toward A
    await pageA.waitForTimeout(150);
    for (const id of await pageA.evaluate(() =>
      Array.from(window.__starfall?.scene.pvpIframeUntil.keys() ?? []),
    ))
      aHitBy.add(id);
    for (const id of await pageB.evaluate(() =>
      Array.from(window.__starfall?.scene.pvpIframeUntil.keys() ?? []),
    ))
      bHitBy.add(id);
  }
  expect(
    aHitBy.has(idB) && bHitBy.has(idA),
    "each client adjudicated a PvP hit from the other",
  ).toBe(true);

  // ---- host migration: close the host, the survivor inherits the arena ----
  const hostPage = hostA ? pageA : pageB;
  const survivorPage = hostA ? pageB : pageA;
  const departedId = hostA ? idA : idB;
  const epochBefore = await survivorPage.evaluate(
    () => window.__starfall?.scene.world.arenaEpoch ?? 0,
  );
  expect(epochBefore).toBeGreaterThan(0);

  await (hostA ? ctxA : ctxB).close();
  await survivorPage.waitForFunction(() => window.__starfall?.client.isHost === true, undefined, {
    timeout: 20_000,
  });
  // Departed player drops out of the roster (removed or flagged not-present).
  await survivorPage.waitForFunction(
    (gone) => {
      const players = window.__starfall?.client.players ?? {};
      const p = players[gone];
      return p === undefined || p.state?.present === false;
    },
    departedId,
    { timeout: 20_000 },
  );
  // Shared world survived the migration: the arena epoch (set once at seed
  // time) is unchanged — the new host adopted the old world, not a fresh one.
  const epochAfter = await survivorPage.evaluate(
    () => window.__starfall?.scene.world.arenaEpoch ?? 0,
  );
  expect(epochAfter).toBe(epochBefore);
  // ...and the new host has real host powers: host-only spawns now succeed.
  const spawned = await survivorPage.evaluate(
    () => window.__starfall?.spawnEnemy("drone") ?? null,
  );
  expect(spawned).not.toBeNull();
  // The sim keeps ticking for the survivor.
  const frameBefore = await survivorPage.evaluate(() => window.__GAME_DIAGNOSTICS__?.frame ?? 0);
  await survivorPage.waitForFunction(
    (f) => (window.__GAME_DIAGNOSTICS__?.frame ?? 0) > f + 30,
    frameBefore,
  );

  expect(errors, "zero page/console errors across both clients").toEqual([]);

  await (hostA ? ctxB : ctxA).close();
});

// BEACON acceptance criteria 5 + 9 (dir-004): two occupants read CONTESTED
// with no controller; a host closed mid-ACTIVE hands the survivor a beacon
// with identical position/timers, still ACTIVE, and the promoted host resumes
// control ticks (survivor becomes sole controller and its trickle flows).
test("beacon: contested with two occupants, survives host migration mid-ACTIVE", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const room = `e2e-beacon-${Date.now().toString(36)}`;

  const errors: string[] = [];
  const track = (label: string, page: Page): void => {
    page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`${label} console: ${m.text()}`);
    });
  };

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  track("A", pageA);
  track("B", pageB);

  const idA = await joinArena(pageA, room);
  const idB = await joinArena(pageB, room);
  for (const page of [pageA, pageB]) {
    await page.waitForFunction(
      () => Object.keys(window.__starfall?.client.players ?? {}).length === 2,
    );
  }
  const hostA = await pageA.evaluate(() => window.__starfall?.client.isHost ?? false);
  const hostPage = hostA ? pageA : pageB;
  const hostCtx = hostA ? ctxA : ctxB;
  const survivorPage = hostA ? pageB : pageA;
  const survivorId = hostA ? idB : idA;

  // Compressed CHARGE (1s), long ACTIVE (120s) so the whole sequence — pin,
  // contest, migrate, re-control — happens mid-ACTIVE with margin.
  const bx = 2600;
  const by = 1400;
  const spawned = await hostPage.evaluate(
    ([x, y]) => window.__starfall?.spawnBeacon(x, y, 1, 120) ?? false,
    [bx, by],
  );
  expect(spawned, "host dev hook spawned the beacon").toBe(true);
  // Both clients see the same beacon go ACTIVE (guest gets it off the wire).
  for (const page of [pageA, pageB]) {
    await page.waitForFunction(
      () => window.__GAME_DIAGNOSTICS__?.beacon?.phase === "active",
      undefined,
      { timeout: 20_000 },
    );
  }

  // ---- criterion 5: both ships inside → CONTESTED, controllerId null ----
  const pinBoth = async (): Promise<void> => {
    // Both inside the 420px zone, 120px apart (not stacked on one point).
    const spots: Array<[Page, number]> = [
      [pageA, bx - 60],
      [pageB, bx + 60],
    ];
    for (const [page, x] of spots) {
      await page.evaluate(
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
        [x, by],
      );
    }
  };
  const contestedDeadline = Date.now() + 25_000;
  let contested = false;
  while (Date.now() < contestedDeadline && !contested) {
    await pinBoth();
    contested = await survivorPage.evaluate(() => {
      const b = window.__starfall?.scene.world.beacon;
      return b !== null && b !== undefined && b.contested && b.controllerId === null;
    });
    await survivorPage.waitForTimeout(250);
  }
  expect(contested, "two occupants → contested, nobody controls").toBe(true);

  // ---- criterion 9: host migration mid-ACTIVE preserves the beacon ----
  const before = await survivorPage.evaluate(() => {
    const b = window.__starfall?.scene.world.beacon;
    return b ? { x: b.x, y: b.y, activeAt: b.activeAt, diesAt: b.diesAt } : null;
  });
  expect(before).not.toBeNull();
  if (!before) return;

  await hostCtx.close();
  await survivorPage.waitForFunction(() => window.__starfall?.client.isHost === true, undefined, {
    timeout: 20_000,
  });

  // Same beacon: position and BOTH phase timers survived the migration.
  const afterMig = await survivorPage.evaluate(() => {
    const b = window.__starfall?.scene.world.beacon;
    return b ? { x: b.x, y: b.y, activeAt: b.activeAt, diesAt: b.diesAt } : null;
  });
  expect(afterMig, "beacon still live after migration").toEqual(before);
  expect(
    await survivorPage.evaluate(() => window.__GAME_DIAGNOSTICS__?.beacon?.phase ?? ""),
    "still mid-ACTIVE",
  ).toBe("active");

  // The promoted host resumes control ticks: with the departed ship gone the
  // survivor is the sole occupant, becomes controller, and its owner-simulated
  // trickle starts paying again.
  const controlDeadline = Date.now() + 20_000;
  let controls = false;
  while (Date.now() < controlDeadline && !controls) {
    await survivorPage.evaluate(
      ([x, y]) => {
        const h = window.__starfall;
        if (!h) return;
        h.scene.shipX = x;
        h.scene.shipY = y;
        h.scene.shipVX = 0;
        h.scene.shipVY = 0;
        h.grantBooster("repair");
        h.grantShield("overshield");
      },
      [bx + 40, by],
    );
    controls = await survivorPage.evaluate(
      (id) => window.__starfall?.scene.world.beacon?.controllerId === id,
      survivorId,
    );
    await survivorPage.waitForTimeout(250);
  }
  expect(controls, "promoted host resumed control ticks; survivor controls").toBe(true);

  const scoreBefore = await survivorPage.evaluate(() => window.__GAME_DIAGNOSTICS__?.score ?? 0);
  const trickleDeadline = Date.now() + 15_000;
  let trickled = false;
  while (Date.now() < trickleDeadline && !trickled) {
    // Keep pinning: an unpinned ship drifts out of the zone under
    // cursor-steering and the trickle legitimately stops.
    await survivorPage.evaluate(
      ([x, y]) => {
        const h = window.__starfall;
        if (!h) return;
        h.scene.shipX = x;
        h.scene.shipY = y;
        h.scene.shipVX = 0;
        h.scene.shipVY = 0;
        h.grantBooster("repair");
      },
      [bx + 40, by],
    );
    trickled = await survivorPage.evaluate(
      (s) => (window.__GAME_DIAGNOSTICS__?.score ?? 0) >= s + 3,
      scoreBefore,
    );
    await survivorPage.waitForTimeout(250);
  }
  expect(trickled, "owner-simulated trickle flows after migration").toBe(true);

  expect(errors, "zero page/console errors across both clients").toEqual([]);
  await (hostA ? ctxB : ctxA).close();
});
