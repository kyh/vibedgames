import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { flagValue, inSequence, poll, startVite } from "@repo/smoke";
import { EVICTION_TIMEOUT_MS, RECONNECT_GRACE_MS } from "@vibedgames/multiplayer";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";

const gameDir = path.resolve(import.meta.dirname, "..");
const urlFlag = flagValue("--url", process.argv);
const room = `t${process.pid}-${Date.now().toString(36)}`;

const startDev = async () => {
  const port = 5400 + Math.floor(Math.random() * 400);
  const child = await startVite({ gameDir, port, timeoutMs: 60_000 });

  return { stop: () => child.kill(), url: `http://localhost:${port}` };
};

const untilArg = async <R, A>(
  page: Page,
  fn: Parameters<typeof page.evaluate<R, A>>[0],
  label: string,
  arg: A,
  timeoutMs = 15_000,
) => {
  const found = await poll(
    () => page.evaluate(fn, arg),
    (value) => Boolean(value),
    { intervalMs: 100, timeoutMs },
  );

  if (found === null) {
    throw new Error(`timeout: ${label}`);
  }

  return found;
};

const until = <R,>(
  page: Page,
  fn: Parameters<typeof page.evaluate<R, null>>[0],
  label: string,
  timeoutMs = 15_000,
) => untilArg(page, fn, label, null, timeoutMs);

const net = (page: Page) =>
  page.evaluate(() => {
    const c = window.__starfall?.client;

    if (c === null || c === undefined) {
      throw new Error("window.__starfall has no client");
    }

    return { hostId: c.hostId, id: c.playerId ?? "", isHost: c.isHost, status: c.connectionStatus };
  });

const summary = async (page: Page) => {
  const found = await page.evaluate(() => window.__starfall?.summary() ?? null);

  if (found === null) {
    throw new Error("window.__starfall is missing: run the game in dev mode");
  }

  return found;
};

const ship = (page: Page) =>
  page.evaluate(() => ({
    x: window.__starfall?.scene.shipX ?? 0,
    y: window.__starfall?.scene.shipY ?? 0,
  }));

const enemyIds = (page: Page) =>
  page.evaluate(() => window.__starfall?.scene.world.enemies.map((e) => e.id) ?? []);

const key = (page: Page, type: string, k: string) =>
  page.evaluate(([t, name]) => window.dispatchEvent(new KeyboardEvent(t, { key: name })), [
    type,
    k,
  ] as const);

const dropLink = (page: Page, ms: number) =>
  page.evaluate((holdMs) => {
    const client = window.__starfall?.client;
    client?.dropConnection(4000);
    setTimeout(() => client?.redial(), holdMs);
  }, ms);

const assertTicking = async (page: Page, ms: number, label: string) => {
  const read = () =>
    page.evaluate(
      () =>
        [
          window.__starfall?.summary().now ?? 0,
          window.__starfall?.scene.world.asteroids[0]?.x ?? 0,
        ] as const,
    );
  const a = await read();

  await sleep(ms);

  const b = await read();

  assert.ok(b[0] > a[0] && b[1] !== a[1], `${label}: world frozen`);
};

const errors: string[] = [];

const open = async (browser: Browser, url: string, name: string) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("Failed to load resource")) {
      errors.push(`${name}: ${m.text()}`);
    }
  });
  await page.goto(`${url}/?room=${room}`);
  await until(
    page,
    () => window.__starfall?.client?.connectionStatus === "connected",
    `${name} connected`,
  );

  return page;
};

const startPlay = async (page: Page, name: string) => {
  await key(page, "keyup", "Shift");
  await until(page, () => window.__starfall?.summary().alive, `${name} spawned`);
};

const join = async (browser: Browser, url: string, name: string, expectHost: boolean) => {
  const page = await open(browser, url, name);
  const n = await net(page);
  assert.equal(n.isHost, expectHost, `${name} host role`);
  await startPlay(page, name);

  return page;
};

interface Presence {
  present: boolean;
  alive?: boolean;
}

const seesPeer = (page: Page, id: string, want: Presence, label: string) =>
  untilArg(
    page,
    ([peerId, expected]) => {
      const p = window.__starfall?.client?.players[peerId];

      return (
        p !== undefined &&
        (p.connected ?? true) &&
        p.state?.present === expected.present &&
        (expected.alive === undefined || p.state.alive === expected.alive)
      );
    },
    label,
    [id, want] as const,
  );

const step = (name: string, note?: string) =>
  console.log(`PASS ${name}${note ? ` — ${note}` : ""}`);

const vite = urlFlag === null ? await startDev() : { stop: null, url: urlFlag };

const browser = await chromium.launch({
  args: [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
  channel: "chrome",
  headless: true,
});

try {
  const host = await join(browser, vite.url, "host", true);
  const guest = await join(browser, vite.url, "guest", false);
  const hostNet = await net(host);
  const hostId = hostNet.id;
  const guestNet = await net(guest);
  const guestId = guestNet.id;
  await seesPeer(host, guestId, { present: true }, "host sees guest");
  await seesPeer(guest, hostId, { present: true }, "guest sees host");
  step("join + mutual presence");

  const g = await ship(guest);

  const droneId = await host.evaluate(
    ([x, y]) => window.__starfall?.spawnEnemy("drone", x + 400, y) ?? null,
    [g.x, g.y] as const,
  );

  await untilArg(
    guest,
    (id) => window.__starfall?.scene.world.enemies.some((e) => e.id === id),
    "drone on guest",
    droneId,
  );
  await guest.evaluate(
    (id) => window.__starfall?.scene.netSendEvent("intents", { h: [["e", id, 1e6]] }),
    droneId,
  );
  await untilArg(
    host,
    (id) => !window.__starfall?.scene.world.enemies.some((e) => e.id === id),
    "host killed drone",
    droneId,
  );
  await untilArg(
    guest,
    (id) => !window.__starfall?.scene.world.enemies.some((e) => e.id === id),
    "guest saw kill",
    droneId,
  );
  step("gameplay events cross the wire");

  const railgunId = await host.evaluate(
    ([x, y]) => window.__starfall?.spawnItem("weapon", "RAILGUN", x, y) ?? null,
    [g.x, g.y] as const,
  );

  await until(
    guest,
    () => window.__starfall?.summary().weapon === "RAILGUN",
    "guest holds RAILGUN",
  );
  await untilArg(
    host,
    (id) => !window.__starfall?.scene.world.items.some((it) => it.id === id),
    "host removed item",
    railgunId,
  );
  const hostSummary = await summary(host);
  assert.notEqual(hostSummary.weapon, "RAILGUN", "host kept its own weapon");

  const mastery = await until(
    guest,
    () => {
      const el = document.querySelector("#weapon-mastery");

      return el instanceof HTMLElement && !el.hidden ? el.textContent : null;
    },
    "guest mastery HUD",
  );

  step("pickup ownership (guest RAILGUN + mastery HUD)", mastery);

  await key(guest, "keydown", "Escape");
  await until(guest, () => window.__starfall?.scene.paused, "guest paused");
  await seesPeer(host, guestId, { present: false }, "host sees guest docked");
  await assertTicking(host, 400, "host during guest pause");
  await key(guest, "keydown", "Escape");
  await until(
    guest,
    () => !window.__starfall?.scene.paused && window.__starfall?.summary().alive,
    "guest resumed",
  );
  await seesPeer(host, guestId, { present: true }, "host sees guest back");
  step("pause on one side does not freeze the other");

  await inSequence(
    [
      { id: guestId, name: "guest", other: host, page: guest },
      { id: hostId, name: "host", other: guest, page: host },
    ],
    async ({ id, name, other, page }) => {
      await page.evaluate(() => window.__starfall?.setShield(0));
      await until(page, () => window.__starfall?.summary().alive === false, `${name} died`);
      await seesPeer(other, id, { alive: false, present: true }, `${name} death seen`);
      await until(page, () => window.__starfall?.summary().alive, `${name} re-entered`);
      await seesPeer(other, id, { alive: true, present: true }, `${name} re-entry seen`);
    },
  );

  step("restart from each side", "death → re-entry (no rematch concept)");

  const h = await ship(host);

  const bossId = await host.evaluate(
    ([x, y]) => window.__starfall?.spawnEnemy("dreadnought", x + 900, y + 900) ?? null,
    [h.x, h.y] as const,
  );

  if (bossId === null || droneId === null || railgunId === null) {
    throw new Error("the dev hooks spawned nothing");
  }

  await untilArg(
    guest,
    (id) => window.__starfall?.scene.world.enemies.some((e) => e.id === id),
    "boss on guest",
    bossId,
  );
  const epoch = await guest.evaluate(() => window.__starfall?.scene.world.arenaEpoch);
  await host.context().close();
  await until(
    guest,
    () => window.__starfall?.client?.isHost === true && window.__starfall.scene.wasHost,
    "guest promoted",
    30_000,
  );
  assert.equal(
    await guest.evaluate(() => window.__starfall?.scene.world.arenaEpoch),
    epoch,
    "epoch kept",
  );
  const guestEnemies = await enemyIds(guest);
  assert.ok(guestEnemies.includes(bossId), "boss kept across migration");
  await untilArg(
    guest,
    (id) => !(id in (window.__starfall?.client?.players ?? {})),
    "departed host left the roster",
    hostId,
    RECONNECT_GRACE_MS + EVICTION_TIMEOUT_MS,
  );
  step("host leaves → guest promoted, world continues");

  const late = await join(browser, vite.url, "late", false);
  const lateNet = await net(late);
  const lateId = lateNet.id;
  await untilArg(
    late,
    (id) => window.__starfall?.scene.world.enemies.some((e) => e.id === id),
    "late sees boss",
    bossId,
  );
  await seesPeer(guest, lateId, { present: true }, "new host sees late joiner");
  step("late join");

  await dropLink(late, 1500);
  await until(
    late,
    () => window.__starfall?.client?.connectionStatus !== "connected",
    "late dropped",
  );
  await assertTicking(late, 400, "guest during blip");
  await until(
    late,
    () => window.__starfall?.client?.connectionStatus === "connected",
    "late readmitted",
  );
  await untilArg(
    late,
    (id) => window.__starfall?.scene.world.enemies.some((e) => e.id === id),
    "late reconciled",
    bossId,
  );
  await dropLink(guest, 1500);
  await until(
    guest,
    () => window.__starfall?.client?.connectionStatus !== "connected",
    "host dropped",
  );
  assert.ok(
    await guest.evaluate(() => window.__starfall?.summary().isHost),
    "host keeps authority through the blip",
  );
  await assertTicking(guest, 400, "host during blip");
  await until(
    guest,
    () => window.__starfall?.client?.connectionStatus === "connected",
    "host readmitted",
  );
  assert.deepEqual(
    await guest.evaluate(() => [
      window.__starfall?.client?.isHost,
      window.__starfall?.scene.hostSnapshotReady,
      window.__starfall?.scene.world.arenaEpoch,
    ]),
    [true, true, epoch],
    "host resumed without re-adopting",
  );

  const before = await late.evaluate(
    (id) => window.__starfall?.scene.world.enemies.find((e) => e.id === id)?.x,
    bossId,
  );

  await untilArg(
    late,
    ([id, x]) => window.__starfall?.scene.world.enemies.find((e) => e.id === id)?.x !== x,
    "guest streams again",
    [bossId, before ?? null] as const,
  );
  step("reconnect: prediction during blip, host continuity");

  assert.deepEqual(errors, [], "console errors");
  console.log("PASS no console errors on any client");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  vite.stop?.();
  process.exit(process.exitCode ?? 0);
}
