// Two-client online smoke: host + guest through join, a bomb across the wire,
// pause without freezing the other side, restarts from both sides (arena
// rotation), host migration and a late join. Needs the party server on
// localhost:8787 and Chrome. `--url http://localhost:5304` reuses a dev server;
// otherwise a vite instance is spawned on --port (default 5384).
/* eslint-disable no-underscore-dangle */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gameDir = resolve(import.meta.dirname, "..");
const { chromium } = createRequire(join(gameDir, "package.json"))("playwright-core");
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index !== -1 ? argv[index + 1] : fallback;
};
const port = Number(option("--port", "5384"));
const room = `t${process.pid}-${Date.now().toString(36)}`;

async function startVite() {
  const child = spawn(
    resolve(gameDir, "node_modules/.bin/vite"),
    ["--port", String(port), "--strictPort"],
    {
      cwd: gameDir,
      stdio: "ignore",
    },
  );
  const url = `http://localhost:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`vite exited ${child.exitCode}`);
    }
    const ok = await fetch(url).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) {
      return { url, stop: () => child.kill() };
    }
    await wait(200);
  }
  throw new Error("vite did not come up");
}

/** Everything the assertions read, in one round trip. */
const snapshot = () => {
  if (!window.__bb) {
    return { status: "booting", bots: {}, players: [] };
  }
  const { scene, client, simNow } = window.__bb;
  const shared = client.sharedState;
  const bots = Object.fromEntries(
    Object.values(shared.bots ?? {}).map((bot) => [bot.id, `${bot.col},${bot.row}`]),
  );
  return {
    status: client.connectionStatus,
    id: client.playerId,
    hostId: client.hostId,
    isHost: client.isHost,
    // A departed peer's seat is held for the reconnect grace window; count live transports.
    players: Object.values(client.players)
      .filter((player) => player.connected !== false)
      .map((player) => player.id),
    seats: Object.keys(client.players).length,
    seeded: Array.isArray(shared.grid),
    arena: shared.arena ?? null,
    round: shared.startedAt ?? null,
    winner: shared.winner ?? null,
    clock: shared.clock?.kind ?? null,
    bombs: Object.values(shared.bombs ?? {}).map((bomb) => bomb.ownerId),
    blasts: Object.keys(shared.blasts ?? {}).length,
    deaths: Object.keys(shared.deaths ?? {}),
    bots,
    started: scene.started,
    frozen: scene.simulationFrozen,
    controlsPaused: scene.controlsPaused,
    me: `${scene.myCol},${scene.myRow}`,
    simNow: simNow(),
  };
};

/** `skewMs` shifts this client's wall clock: machines disagree about Date.now(),
 * and the shared sim clock must follow the host's sim time regardless. */
async function open(browser, url, name, errors, skewMs = 0) {
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
  await page.goto(`${url}/?room=${room}&test=1`);
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
        if (predicate(last)) return last;
        await wait(100);
      }
      throw new Error(`${name}: timed out waiting for ${label}: ${JSON.stringify(last)}`);
    },
  };
  await client.until("connected + seeded", (s) => s.status === "connected" && s.seeded);
  return client;
}

const botsMoved = (before, after) =>
  Object.keys(before).some((id) => after[id] !== undefined && after[id] !== before[id]);

const assertMoving = async (client, label) => {
  const before = await client.snap();
  await client.until(label, (s) => botsMoved(before.bots, s.bots), 3000);
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

const server = option("--url") ? { stop() {}, url: option("--url") } : await startVite();
const browser = await chromium.launch({
  args: [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
  channel: "chrome",
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
    assert.equal((await host.snap()).simNow, s.simNow, "frozen sim time must hold");
  });
  await step("joiner wakes the frozen host; both see each other; clocks align", async () => {
    guest = await open(browser, server.url, "guest", errors, 5000);
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
    assert.equal((await host.snap()).arena, "classic");
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
    late = await open(browser, server.url, "late", errors, -3000);
    const g = await guest.snap();
    const l = await late.until("late synced", (s) => s.players.length === 2 && s.round === g.round);
    assert.equal(l.arena, g.arena);
    assert.equal(l.hostId, g.id);
    assertClocksAligned(await guest.snap(), await late.snap(), "late join");
    await late.play();
    await late.until("late spawned", (s) => s.started && s.me !== "0,0");
    await late.bomb();
    await guest.until("host accepted late bomb", (s) => s.bombs.includes(l.id));
    await late.until("late bomb detonates", (s) => s.blasts > 0 && !s.bombs.includes(l.id), 4000);
  });
  await step("no console errors on any client", async () => {
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
