// Two-client online smoke: host + guest through join, a bomb across the wire,
// pause without freezing the other side, restarts from both sides (arena
// rotation), a power-up both claim at once, host migration and a late join,
// then an offline client's power-up race. Needs the party server on
// localhost:8787 and a Chrome (playwright-core: channel "chrome", or
// CHROME_PATH). `--url http://localhost:5304` reuses a dev server; otherwise a
// vite instance is spawned on --port (default 5384).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const gameDir = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(path.join(gameDir, "package.json"))("playwright-core");

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const port = Number(option("--port", "5384"));
const room = `t${process.pid}-${Date.now().toString(36)}`;

const startVite = async () => {
  const child = spawn(
    path.resolve(gameDir, "node_modules/.bin/vite"),
    ["--port", String(port), "--strictPort"],
    {
      cwd: gameDir,
      stdio: "ignore",
    },
  );
  const url = `http://localhost:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`vite exited ${child.exitCode}`);
    }
    const ok = await fetch(url).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) {
      return { stop: () => child.kill(), url };
    }
    await wait(200);
  }
  throw new Error("vite did not come up");
};

/** Everything the assertions read, in one round trip. */
const snapshot = () => {
  if (!window.__bb) {
    return { bots: {}, players: [], status: "booting" };
  }
  const { scene, client, simNow } = window.__bb;
  const shared = client.sharedState;
  const bots = Object.fromEntries(
    Object.values(shared.bots ?? {}).map((bot) => [bot.id, `${bot.col},${bot.row}`]),
  );
  return {
    arena: shared.arena ?? null,
    blasts: Object.keys(shared.blasts ?? {}).length,
    bombs: Object.values(shared.bombs ?? {}).map((bomb) => bomb.ownerId),
    bots,
    clock: shared.clock?.kind ?? null,
    controlsPaused: scene.controlsPaused,
    crates: (shared.grid ?? []).flat().filter((cell) => cell.kind === "crate").length,
    deaths: Object.keys(shared.deaths ?? {}),
    frozen: scene.simulationFrozen,
    hostId: client.hostId,
    id: client.playerId,
    isHost: client.isHost,
    me: `${scene.myCol},${scene.myRow}`,
    myRange: scene.myStats().range,
    pickupOwners: Object.fromEntries(
      Object.entries(client.claims)
        .filter(([key]) => key.startsWith("pickup:"))
        .map(([key, claim]) => [key, claim.owner]),
    ),
    pickups: Object.keys(shared.powerups ?? {}).length,
    // A departed peer's seat is held for the reconnect grace window; count live transports.
    players: Object.values(client.players)
      .filter((player) => player.connected !== false)
      .map((player) => player.id),
    ranges: Object.fromEntries(
      Object.entries(shared.stats ?? {}).map(([id, stats]) => [id, stats.range]),
    ),
    round: shared.startedAt ?? null,
    seats: Object.keys(client.players).length,
    seeded: Array.isArray(shared.grid),
    simNow: simNow(),
    started: scene.started,
    status: client.connectionStatus,
    winner: shared.winner ?? null,
  };
};

/** `skewMs` shifts this client's wall clock: machines disagree about Date.now(),
 * and the shared sim clock must follow the host's sim time regardless.
 * `offline` opens it with ?offline=1 instead of the room: it never dials. */
const open = async (browser, url, name, errors, { offline = false, skewMs = 0 } = {}) => {
  const context = await browser.newContext({ viewport: { height: 800, width: 1100 } });
  await context.addInitScript((skew) => {
    const real = Date.now;
    Date.now = () => real() + skew;
  }, skewMs);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`${name}: ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(`${name}: ${response.status()} ${response.url()}`);
    }
  });
  await page.goto(`${url}/?${offline ? "offline=1" : `room=${room}`}&test=1`);
  const client = {
    bomb: () => page.evaluate(() => window.__bb.scene.requestBomb()),
    close: () => context.close(),
    escape: () => page.keyboard.press("Escape"),
    name,
    page,
    play: () => page.evaluate(() => window.__GAME_TEST_HOOKS__.setState("active-play")),
    restart: () => page.evaluate(() => window.__bb.scene.requestRestart()),
    snap: async () => ({ ...(await page.evaluate(snapshot)), at: Date.now() }),
    async until(label, predicate, timeout = 8000) {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        last = await this.snap();
        if (predicate(last)) {
          return last;
        }
        await wait(100);
      }
      throw new Error(`${name}: timed out waiting for ${label}: ${JSON.stringify(last)}`);
    },
  };
  const ready = offline ? "offline" : "connected";
  await client.until(`${ready} + seeded`, (s) => s.status === ready && s.seeded);
  return client;
};

const botsMoved = (before, after) =>
  Object.keys(before).some((id) => after[id] !== undefined && after[id] !== before[id]);

const assertMoving = async (client, label) => {
  const before = await client.snap();
  await client.until(label, (s) => botsMoved(before.bots, s.bots), 3000);
};

/** Both clients' boards agree: bots may open a crate meanwhile, so poll both together. */
const assertSameBoard = async (a, b, label) => {
  const deadline = Date.now() + 4000;
  for (;;) {
    const [x, y] = await Promise.all([a.snap(), b.snap()]);
    if (x.crates === y.crates) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${label}: ${a.name} has ${x.crates} crates, ${b.name} ${y.crates}`);
    }
    await wait(100);
  }
};

const assertClocksAligned = (a, b, label) => {
  // Snapshots are sequential; measure each side's sim time against this process's clock.
  const drift = Math.abs(a.simNow - a.at - (b.simNow - b.at));
  assert.ok(drift < 300, `${label}: sim clocks drift ${drift}ms`);
};

const errors = [];
const results = [];
const step = async (name, run) => {
  try {
    await run();
    results.push(`pass  ${name}`);
  } catch (error) {
    results.push(`FAIL  ${name}: ${error.message}`);
    throw error;
  }
};

const server = option("--url") ? { stop: () => null, url: option("--url") } : await startVite();
const browser = await chromium.launch({
  args: [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : { channel: "chrome" }),
  headless: true,
});
let host;
let guest;
let late;
try {
  await step("host joins and seeds the room", async () => {
    host = await open(browser, server.url, "host", errors);
    await host.play();
    const s = await host.until("host role", (h) => h.isHost && h.started);
    assert.equal(s.arena, "classic");
  });
  await step("solo host pause freezes the sim clock", async () => {
    await host.escape();
    const s = await host.until("frozen", (h) => h.frozen && h.clock === "paused");
    await wait(400);
    const held = await host.snap();
    assert.equal(held.simNow, s.simNow, "frozen sim time must hold");
  });
  await step("joiner wakes the frozen host; both see each other; clocks align", async () => {
    guest = await open(browser, server.url, "guest", errors, { skewMs: 5000 });
    await host.until("host resumed", (h) => !h.frozen && h.players.length === 2);
    await guest.until("guest sees both", (g) => g.players.length === 2 && g.clock === "running");
    await host.escape();
    await host.until("host overlay dismissed", (h) => !h.controlsPaused);
    assertClocksAligned(await host.snap(), await guest.snap(), "after wake");
    const h = await host.snap();
    const g = await guest.snap();
    assert.equal(g.round, h.round);
    assert.equal(g.hostId, h.id);
  });
  await step("guest bomb crosses the wire and detonates on both sides", async () => {
    await guest.play();
    const g = await guest.until("guest spawned", (s) => s.started && s.me !== "0,0");
    await guest.bomb();
    await host.until("host accepted guest bomb", (h) => h.bombs.includes(g.id));
    await guest.until("guest sees own bomb", (s) => s.bombs.includes(g.id));
    await guest.until("blast on guest", (s) => s.blasts > 0 && !s.bombs.includes(g.id), 4000);
    await host.until("guest died on host", (h) => h.deaths.includes(g.id), 4000);
    await guest.until("guest sees own death", (s) => s.deaths.includes(g.id));
    await assertSameBoard(host, guest, "after the guest's blast");
  });
  await step("guest pause does not freeze the host's live match", async () => {
    await guest.escape();
    const g = await guest.until("guest paused", (s) => s.controlsPaused);
    assert.equal(g.frozen, false, "shared arena must not freeze");
    await assertMoving(host, "host bots keep moving");
    await assertMoving(guest, "guest still receives moves");
    await guest.escape();
    await guest.until("guest resumed", (s) => !s.controlsPaused);
  });
  await step("host pause does not freeze the guest's live match", async () => {
    await host.escape();
    const h = await host.until("host paused", (s) => s.controlsPaused);
    assert.equal(h.frozen, false);
    await assertMoving(guest, "guest sees bots move while host paused");
    await host.escape();
    await host.until("host resumed", (s) => !s.controlsPaused);
  });
  await step("restart from guest rotates the arena on both sides", async () => {
    const before = await host.snap();
    await guest.restart();
    const h = await host.until("new round", (s) => s.round !== before.round);
    assert.equal(h.arena, "crossroads");
    const g = await guest.until("guest adopted", (s) => s.round === h.round);
    assert.equal(g.arena, "crossroads");
    assert.deepEqual(g.deaths, [], "guest revived");
  });
  await step("restart from host rotates back", async () => {
    const before = await guest.snap();
    await host.restart();
    const g = await guest.until("new round", (s) => s.round !== before.round);
    assert.equal(g.arena, "classic");
    const h = await host.snap();
    assert.equal(h.arena, "classic");
  });
  await step("power-up race: the room picks one claimant and the host grants only it", async () => {
    // On a pillar, which no bot walks onto and no blast reaches: only the two claims race.
    const pickup = { col: 8, kind: "fire", row: 6 };
    const before = await host.snap();
    await host.page.evaluate((pu) => {
      const { scene } = window.__bb;
      const { powerups } = scene.shared();
      scene.netPatchShared({ powerups: { ...powerups, [`${pu.col},${pu.row}`]: pu } });
    }, pickup);
    await guest.until("guest sees the power-up", (s) => s.pickups > before.pickups);
    const reach = (client) =>
      client.page.evaluate((pu) => {
        const { scene } = window.__bb;
        const state = scene.shared();
        return scene.pickupClaims.reach(window.__bb.client, state, scene.myId, pu) !== null;
      }, pickup);
    assert.deepEqual(await Promise.all([reach(host), reach(guest)]), [true, true]);
    const key = `pickup:${pickup.col},${pickup.row}:${before.round}`;
    const owned = await host.until("one owner", (s) => s.pickupOwners[key] !== undefined);
    const winner = owned.pickupOwners[key];
    const was = (id) => before.ranges[id] ?? 2;
    for (const client of [host, guest]) {
      const s = await client.until("granted", (snap) => snap.ranges[winner] === was(winner) + 1);
      const loser = s.players.find((id) => id !== winner);
      assert.equal(s.ranges[loser] ?? 2, was(loser), "the other claimant got nothing");
      assert.equal(s.myRange, s.ranges[s.id] ?? 2, "a lost claim comes back off its stats");
    }
  });
  await step("host leaves: guest promoted, round kept, sim keeps running", async () => {
    const before = await guest.snap();
    await host.close();
    host = null;
    const g = await guest.until("promoted", (s) => s.isHost && s.players.length === 1, 15_000);
    assert.equal(g.round, before.round, "promotion must not reset the round");
    assert.equal(g.arena, before.arena);
    await assertMoving(guest, "promoted host drives bots");
    await guest.bomb();
    await guest.until("promoted host places", (s) => s.bombs.includes(g.id));
    await guest.until("promoted host detonates", (s) => s.blasts > 0, 4000);
  });
  await step("late join into the running match", async () => {
    late = await open(browser, server.url, "late", errors, { skewMs: -3000 });
    const g = await guest.snap();
    const l = await late.until("late synced", (s) => s.players.length === 2 && s.round === g.round);
    assert.equal(l.arena, g.arena);
    await assertSameBoard(guest, late, "late join");
    assert.equal(l.hostId, g.id);
    assertClocksAligned(await guest.snap(), await late.snap(), "late join");
    await late.play();
    await late.until("late spawned", (s) => s.started && s.me !== "0,0");
    await late.bomb();
    await guest.until("host accepted late bomb", (s) => s.bombs.includes(l.id));
    await late.until("late bomb detonates", (s) => s.blasts > 0 && !s.bombs.includes(l.id), 4000);
  });
  await step("offline: a bot's power-up, claimed mid host step, is granted once", async () => {
    const solo = await open(browser, server.url, "solo", errors, { offline: true });
    await solo.play();
    await solo.until("bots in", (s) => s.isHost && s.started && Object.keys(s.bots).length === 3);
    // Offline the room grants a claim inside claim(), so a bot's arrives in the
    // middle of the host step. Stage the worst case: a bot on a power-up while
    // a bomb elsewhere, long past its fuse, goes off in that same step, so the
    // step writes the power-ups too. Every bot is parked: a bot's stride would
    // split the step's write and send the power-ups before the claim. The
    // bot's grant must land once.
    const race = await solo.page.evaluate(() => {
      const { scene, simNow } = window.__bb;
      const state = scene.shared();
      const me = { col: scene.myCol, row: scene.myRow };
      const bot = Object.values(state.bots).find(
        (b) => !state.deaths[b.id] && (b.col !== me.col || b.row !== me.row),
      );
      const fighters = [me, ...Object.values(state.bots)];
      const far = (col, row) =>
        fighters.every((f) => Math.abs(f.col - col) + Math.abs(f.row - row) > 3);
      const spot = state.grid
        .flatMap((line, row) => line.map((cell, col) => ({ col, kind: cell.kind, row })))
        .find(
          (c) => c.kind === "empty" && far(c.col, c.row) && !state.powerups[`${c.col},${c.row}`],
        );
      const now = simNow();
      const parked = Object.values(state.bots).map((b) => [
        b.id,
        { ...b, moving: false, nextMoveAt: now + 60_000 },
      ]);
      scene.netPatchShared({
        bombs: {
          ...state.bombs,
          race: {
            col: spot.col,
            id: "race",
            ownerId: bot.id,
            placedAt: now - 5000,
            range: 1,
            row: spot.row,
          },
        },
        bots: Object.fromEntries(parked),
        powerups: {
          ...state.powerups,
          [`${bot.col},${bot.row}`]: { col: bot.col, kind: "fire", row: bot.row },
          [`${spot.col},${spot.row}`]: { col: spot.col, kind: "bomb", row: spot.row },
        },
      });
      return { bot: bot.id, range: state.stats[bot.id]?.range ?? 2 };
    });
    await solo.until("granted", (s) => s.ranges[race.bot] >= race.range + 1);
    await wait(500);
    const after = await solo.snap();
    assert.equal(after.ranges[race.bot], race.range + 1, "granted once, not again a step later");
    assert.equal(after.status, "offline");
    await solo.close();
  });
  await step("no console errors on any client", () => {
    assert.deepEqual(errors, []);
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  console.log(results.join("\n"));
  if (errors.length > 0) {
    console.log(`console errors:\n${errors.join("\n")}`);
  }
  await browser.close();
  server.stop();
  // A leaked dev-server handle would otherwise keep node alive past the last check.
  process.exit(process.exitCode ?? 0);
}
