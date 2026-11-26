import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { inSequence, poll, startVite } from "@repo/smoke";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";

import type { Powerup } from "../src/shared/constants.ts";

const gameDir = path.resolve(import.meta.dirname, "..");

const argv = process.argv.slice(2);

const option = (name: string) => {
  const index = argv.indexOf(name);

  return index === -1 ? null : (argv[index + 1] ?? null);
};

const port = Number(option("--port") ?? "5384");
const room = `t${process.pid}-${Date.now().toString(36)}`;

const snapshot = () => {
  const hooks = window.__bb;
  const shared = hooks?.scene.shared() ?? null;

  if (hooks === undefined || shared === null) {
    return null;
  }

  const { scene, client, simNow } = hooks;

  return {
    arena: shared.arena ?? null,
    blasts: Object.keys(shared.blasts).length,
    bombs: Object.values(shared.bombs).map((bomb) => bomb.ownerId),
    bots: Object.fromEntries(
      Object.values(shared.bots).map((bot) => [bot.id, `${bot.col},${bot.row}`]),
    ),
    clock: shared.clock?.kind ?? null,
    controlsPaused: scene.controlsPaused,
    crates: shared.grid.flat().filter((cell) => cell.kind === "crate").length,
    deaths: Object.keys(shared.deaths),
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
    pickups: Object.keys(shared.powerups).length,
    players: Object.values(client.players)
      .filter((player) => player.connected !== false)
      .map((player) => player.id),
    ranges: Object.fromEntries(
      Object.entries(shared.stats).map(([id, stats]) => [id, stats.range]),
    ),
    round: shared.startedAt,
    seats: Object.keys(client.players).length,
    seeded: true,
    simNow: simNow(),
    started: scene.started,
    status: client.connectionStatus,
    winner: shared.winner,
  };
};

type Snapshot = NonNullable<ReturnType<typeof snapshot>> & { at: number };

const BOOTING: Snapshot = {
  arena: null,
  at: 0,
  blasts: 0,
  bombs: [],
  bots: {},
  clock: null,
  controlsPaused: false,
  crates: 0,
  deaths: [],
  frozen: false,
  hostId: null,
  id: null,
  isHost: false,
  me: "0,0",
  myRange: 2,
  pickupOwners: {},
  pickups: 0,
  players: [],
  ranges: {},
  round: 0,
  seats: 0,
  seeded: false,
  simNow: 0,
  started: false,
  status: "connecting",
  winner: null,
};

interface OpenOptions {
  offline?: boolean;
  skewMs?: number;
}

const open = async (
  browser: Browser,
  url: string,
  name: string,
  errors: string[],
  { offline = false, skewMs = 0 }: OpenOptions = {},
) => {
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

  const snap = async () => {
    const read = await page.evaluate(snapshot);

    return { ...(read ?? BOOTING), at: Date.now() } satisfies Snapshot;
  };

  const client = {
    bomb: () =>
      page.evaluate(() => {
        window.__bb?.scene.requestBomb();
      }),
    close: () => context.close(),
    escape: () => page.keyboard.press("Escape"),
    name,
    page,
    play: () =>
      page.evaluate(async () => {
        await window.__GAME_TEST_HOOKS__?.setState("active-play");
      }),
    restart: () =>
      page.evaluate(() => {
        window.__bb?.scene.requestRestart();
      }),
    snap,
    until: async (label: string, predicate: (s: Snapshot) => boolean, timeout = 8000) => {
      let last: Snapshot | null = null;
      const found = await poll(
        async () => {
          last = await snap();

          return last;
        },
        predicate,
        { intervalMs: 100, timeoutMs: timeout },
      );

      if (found === null) {
        throw new Error(`${name}: timed out waiting for ${label}: ${JSON.stringify(last)}`);
      }

      return found;
    },
  };

  const ready = offline ? "offline" : "connected";
  await client.until(`${ready} + seeded`, (s) => s.status === ready && s.seeded);

  return client;
};

type Client = Awaited<ReturnType<typeof open>>;

const botsMoved = (before: Record<string, string>, after: Record<string, string>) =>
  Object.keys(before).some((id) => after[id] !== undefined && after[id] !== before[id]);

const assertMoving = async (client: Client, label: string) => {
  const before = await client.snap();
  await client.until(label, (s) => botsMoved(before.bots, s.bots), 3000);
};

const assertSameBoard = async (a: Client, b: Client, label: string) => {
  const deadline = Date.now() + 4000;
  const compare: () => Promise<void> = async () => {
    const [x, y] = await Promise.all([a.snap(), b.snap()]);

    if (x.crates === y.crates) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(`${label}: ${a.name} has ${x.crates} crates, ${b.name} ${y.crates}`);
    }

    await wait(100);
    await compare();
  };

  await compare();
};

const assertClocksAligned = (a: Snapshot, b: Snapshot, label: string) => {
  const drift = Math.abs(a.simNow - a.at - (b.simNow - b.at));
  assert.ok(drift < 300, `${label}: sim clocks drift ${drift}ms`);
};

const errors: string[] = [];
const results: string[] = [];

const step = async (name: string, run: () => Promise<void> | void) => {
  try {
    await run();
    results.push(`pass  ${name}`);
  } catch (error) {
    results.push(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
};

const startServer = async () => {
  const given = option("--url");

  if (given !== null) {
    return { stop: () => null, url: given };
  }

  const url = `http://localhost:${port}`;
  const vite = await startVite({ gameDir, port, timeoutMs: 20_000, url });

  return { stop: () => vite.kill(), url };
};

const server = await startServer();

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

let host: Client | null = null;
let guest: Client | null = null;
let late: Client | null = null;

const live = (client: Client | null) => {
  if (client === null) {
    throw new Error("client not open");
  }

  return client;
};

try {
  await step("host joins and seeds the room", async () => {
    host = await open(browser, server.url, "host", errors);
    await live(host).play();
    const s = await live(host).until("host role", (h) => h.isHost && h.started);
    assert.equal(s.arena, "classic");
  });
  await step("solo host pause freezes the sim clock", async () => {
    await live(host).escape();
    const s = await live(host).until("frozen", (h) => h.frozen && h.clock === "paused");
    await wait(400);
    const held = await live(host).snap();
    assert.equal(held.simNow, s.simNow, "frozen sim time must hold");
  });
  await step("joiner wakes the frozen host; both see each other; clocks align", async () => {
    guest = await open(browser, server.url, "guest", errors, { skewMs: 5000 });
    await live(host).until("host resumed", (h) => !h.frozen && h.players.length === 2);
    await live(guest).until(
      "guest sees both",
      (g) => g.players.length === 2 && g.clock === "running",
    );
    await live(host).escape();
    await live(host).until("host overlay dismissed", (h) => !h.controlsPaused);
    assertClocksAligned(await live(host).snap(), await live(guest).snap(), "after wake");
    const h = await live(host).snap();
    const g = await live(guest).snap();
    assert.equal(g.round, h.round);
    assert.equal(g.hostId, h.id);
  });
  await step("guest bomb crosses the wire and detonates on both sides", async () => {
    await live(guest).play();
    const g = await live(guest).until("guest spawned", (s) => s.started && s.me !== "0,0");
    const gid = g.id ?? "";
    await live(guest).bomb();
    await live(host).until("host accepted guest bomb", (h) => h.bombs.includes(gid));
    await live(guest).until("guest sees own bomb", (s) => s.bombs.includes(gid));
    await live(guest).until("blast on guest", (s) => s.blasts > 0 && !s.bombs.includes(gid), 4000);
    await live(host).until("guest died on host", (h) => h.deaths.includes(gid), 4000);
    await live(guest).until("guest sees own death", (s) => s.deaths.includes(gid));
    await assertSameBoard(live(host), live(guest), "after the guest's blast");
  });
  await step("guest pause does not freeze the host's live match", async () => {
    await live(guest).escape();
    const g = await live(guest).until("guest paused", (s) => s.controlsPaused);
    assert.equal(g.frozen, false, "shared arena must not freeze");
    await assertMoving(live(host), "host bots keep moving");
    await assertMoving(live(guest), "guest still receives moves");
    await live(guest).escape();
    await live(guest).until("guest resumed", (s) => !s.controlsPaused);
  });
  await step("host pause does not freeze the guest's live match", async () => {
    await live(host).escape();
    const h = await live(host).until("host paused", (s) => s.controlsPaused);
    assert.equal(h.frozen, false);
    await assertMoving(live(guest), "guest sees bots move while host paused");
    await live(host).escape();
    await live(host).until("host resumed", (s) => !s.controlsPaused);
  });
  await step("restart from guest rotates the arena on both sides", async () => {
    const before = await live(host).snap();
    await live(guest).restart();
    const h = await live(host).until("new round", (s) => s.round !== before.round);
    assert.equal(h.arena, "crossroads");
    const g = await live(guest).until("guest adopted", (s) => s.round === h.round);
    assert.equal(g.arena, "crossroads");
    assert.deepEqual(g.deaths, [], "guest revived");
  });
  await step("restart from host rotates back", async () => {
    const before = await live(guest).snap();
    await live(host).restart();
    const g = await live(guest).until("new round", (s) => s.round !== before.round);
    assert.equal(g.arena, "classic");
    const h = await live(host).snap();
    assert.equal(h.arena, "classic");
  });
  await step("power-up race: the room picks one claimant and the host grants only it", async () => {
    const pickup: Powerup = { col: 8, kind: "fire", row: 6 };
    const before = await live(host).snap();
    await live(host).page.evaluate((pu) => {
      const scene = window.__bb?.scene;
      const shared = scene?.shared();

      if (scene === undefined || shared === undefined || shared === null) {
        throw new Error("no room state");
      }

      scene.netPatchShared({ powerups: { ...shared.powerups, [`${pu.col},${pu.row}`]: pu } });
    }, pickup);
    await live(guest).until("guest sees the power-up", (s) => s.pickups > before.pickups);

    const reach = (client: Client) =>
      client.page.evaluate((pu) => {
        const hooks = window.__bb;
        const state = hooks?.scene.shared();

        if (hooks === undefined || state === undefined || state === null) {
          throw new Error("no room state");
        }

        const { scene } = hooks;

        return scene.pickupClaims.reach(hooks.client, state, scene.myId ?? "", pu) !== null;
      }, pickup);

    assert.deepEqual(await Promise.all([reach(live(host)), reach(live(guest))]), [true, true]);
    const key = `pickup:${pickup.col},${pickup.row}:${before.round}`;
    const owned = await live(host).until("one owner", (s) => s.pickupOwners[key] !== undefined);
    const winner = owned.pickupOwners[key] ?? "";
    const was = (id: string) => before.ranges[id] ?? 2;

    await inSequence([live(host), live(guest)], async (client) => {
      const s = await client.until("granted", (snap) => snap.ranges[winner] === was(winner) + 1);
      const loser = s.players.find((id) => id !== winner) ?? "";
      assert.equal(s.ranges[loser] ?? 2, was(loser), "the other claimant got nothing");
      assert.equal(s.myRange, s.ranges[s.id ?? ""] ?? 2, "a lost claim comes back off its stats");
    });
  });
  await step("host leaves: guest promoted, round kept, sim keeps running", async () => {
    const before = await live(guest).snap();
    await live(host).close();
    host = null;
    const g = await live(guest).until(
      "promoted",
      (s) => s.isHost && s.players.length === 1,
      15_000,
    );
    const gid = g.id ?? "";
    assert.equal(g.round, before.round, "promotion must not reset the round");
    assert.equal(g.arena, before.arena);
    await assertMoving(live(guest), "promoted host drives bots");
    await live(guest).bomb();
    await live(guest).until("promoted host places", (s) => s.bombs.includes(gid));
    await live(guest).until("promoted host detonates", (s) => s.blasts > 0, 4000);
  });
  await step("late join into the running match", async () => {
    late = await open(browser, server.url, "late", errors, { skewMs: -3000 });
    const g = await live(guest).snap();
    const l = await live(late).until(
      "late synced",
      (s) => s.players.length === 2 && s.round === g.round,
    );
    const lid = l.id ?? "";
    assert.equal(l.arena, g.arena);
    await assertSameBoard(live(guest), live(late), "late join");
    assert.equal(l.hostId, g.id);
    assertClocksAligned(await live(guest).snap(), await live(late).snap(), "late join");
    await live(late).play();
    await live(late).until("late spawned", (s) => s.started && s.me !== "0,0");
    await live(late).bomb();
    await live(guest).until("host accepted late bomb", (s) => s.bombs.includes(lid));
    await live(late).until(
      "late bomb detonates",
      (s) => s.blasts > 0 && !s.bombs.includes(lid),
      4000,
    );
  });
  await step("offline: a bot's power-up, claimed mid host step, is granted once", async () => {
    const solo = await open(browser, server.url, "solo", errors, { offline: true });
    await solo.play();
    await solo.until("bots in", (s) => s.isHost && s.started && Object.keys(s.bots).length === 3);

    const race = await solo.page.evaluate(() => {
      const hooks = window.__bb;
      const state = hooks?.scene.shared();

      if (hooks === undefined || state === undefined || state === null) {
        throw new Error("no room state");
      }

      const { scene, simNow } = hooks;
      const me = { col: scene.myCol, row: scene.myRow };

      const bot = Object.values(state.bots).find(
        (b) => state.deaths[b.id] === undefined && (b.col !== me.col || b.row !== me.row),
      );

      const fighters = [me, ...Object.values(state.bots)];

      const far = (col: number, row: number) =>
        fighters.every((f) => Math.abs(f.col - col) + Math.abs(f.row - row) > 3);

      const spot = state.grid
        .flatMap((line, row) => line.map((cell, col) => ({ col, kind: cell.kind, row })))
        .find(
          (c) =>
            c.kind === "empty" &&
            far(c.col, c.row) &&
            state.powerups[`${c.col},${c.row}`] === undefined,
        );

      if (bot === undefined || spot === undefined) {
        throw new Error("no live bot or open tile");
      }

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

    await solo.until("granted", (s) => (s.ranges[race.bot] ?? 0) >= race.range + 1);
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
  process.exit(process.exitCode ?? 0);
}
