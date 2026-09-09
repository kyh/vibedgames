// Two-client online smoke: `pnpm --filter @repo/starfall test:online`.
// Needs the party server on localhost:8787 and a Chrome install. Launches its
// own vite unless `--url http://localhost:<port>` is given.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const { EVICTION_TIMEOUT_MS, RECONNECT_GRACE_MS } = await import("@vibedgames/multiplayer");
const gameDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const urlFlag = argv.indexOf("--url");
const room = `t${process.pid}-${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startVite() {
  const port = 5400 + Math.floor(Math.random() * 400);
  const child = spawn(
    resolve(gameDir, "node_modules/.bin/vite"),
    ["--port", String(port), "--strictPort"],
    {
      cwd: gameDir,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const url = await new Promise((res, rej) => {
    child.stdout.on("data", (chunk) => {
      const m = /Local:\s+(http:\/\/localhost:\d+)/.exec(String(chunk));
      if (m) res(m[1]);
    });
    child.on("exit", (code) => rej(new Error(`vite exited ${code}`)));
  });
  return { url, stop: () => child.kill() };
}

/** Poll `fn` (evaluated in the page) until truthy; returns its value. */
async function until(page, fn, label, arg, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await sleep(100);
  }
}
const net = (page) =>
  page.evaluate(() => {
    const c = window.__starfall.client;
    return { status: c.connectionStatus, isHost: c.isHost, id: c.playerId, hostId: c.hostId };
  });
const summary = (page) => page.evaluate(() => window.__starfall.summary());
const ship = (page) =>
  page.evaluate(() => ({ x: __starfall.scene.shipX, y: __starfall.scene.shipY }));
const enemyIds = (page) => page.evaluate(() => __starfall.scene.world.enemies.map((e) => e.id));
const key = (page, type, k) =>
  page.evaluate(([t, key]) => window.dispatchEvent(new KeyboardEvent(t, { key })), [type, k]);
/** Drop the transport (RWS's own disconnect path, so the close is seen at once
 *  — a raw ws.close() sits in CLOSING against the dev party server) and hold
 *  the auto-reconnect for `ms`, so the room sees a real drop-and-reclaim.
 *  4000 because WebSocket.close() rejects reserved codes such as 1006, and
 *  _disconnect swallows that throw — the link would stay up. */
/** A transport blip: an unclean close (anything but 1000, which the server
 * reads as a deliberate leave) parks the seat, then reconnect after `ms`. */
const dropLink = (page, ms) =>
  page.evaluate((ms) => {
    const s = __starfall.client.socket;
    s.close(4000, "blip");
    setTimeout(() => s.reconnect(), ms);
  }, ms);
/** Local time keeps flowing and bodies keep moving over `ms`. */
async function assertTicking(page, ms, label) {
  const a = await page.evaluate(() => [
    __starfall.summary().now,
    __starfall.scene.world.asteroids[0].x,
  ]);
  await sleep(ms);
  const b = await page.evaluate(() => [
    __starfall.summary().now,
    __starfall.scene.world.asteroids[0].x,
  ]);
  assert.ok(b[0] > a[0] && b[1] !== a[1], `${label}: world frozen`);
}

const errors = [];
async function open(browser, url, name) {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("Failed to load resource"))
      errors.push(`${name}: ${m.text()}`);
  });
  await page.goto(`${url}/?room=${room}`);
  await until(
    page,
    () => window.__starfall?.client.connectionStatus === "connected",
    `${name} connected`,
  );
  return page;
}
async function startPlay(page, name) {
  await key(page, "keyup", "Shift");
  await until(page, () => __starfall.summary().alive, `${name} spawned`);
}
async function join(browser, url, name, expectHost) {
  const page = await open(browser, url, name);
  const n = await net(page);
  assert.equal(n.isHost, expectHost, `${name} host role`);
  await startPlay(page, name);
  return page;
}
const seesPeer = (page, id, want, label) =>
  until(
    page,
    ([id, want]) => {
      const p = __starfall.client.players[id];
      return (
        p !== undefined &&
        (p.connected ?? true) &&
        p.state?.present === want.present &&
        (want.alive === undefined || p.state.alive === want.alive)
      );
    },
    label,
    [id, want],
  );

const step = (name, note) => console.log(`PASS ${name}${note ? ` — ${note}` : ""}`);

const vite = urlFlag === -1 ? await startVite() : { url: argv[urlFlag + 1], stop() {} };
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
try {
  // 1. join: both connected, both see each other's ship
  const host = await join(browser, vite.url, "host", true);
  const guest = await join(browser, vite.url, "guest", false);
  const hostId = (await net(host)).id;
  const guestId = (await net(guest)).id;
  await seesPeer(host, guestId, { present: true }, "host sees guest");
  await seesPeer(guest, hostId, { present: true }, "guest sees host");
  step("join + mutual presence");

  // 2. events cross the wire: host spawn → guest sees; guest hit → host kills
  const g = await ship(guest);
  const droneId = await host.evaluate(
    ([x, y]) => __starfall.spawnEnemy("drone", x + 400, y),
    [g.x, g.y],
  );
  await until(
    guest,
    (id) => __starfall.scene.world.enemies.some((e) => e.id === id),
    "drone on guest",
    droneId,
  );
  await guest.evaluate(
    (id) => __starfall.scene.netSendEvent("enemy_hit", { enemyId: id, damage: 1e6, kx: 0, ky: 0 }),
    droneId,
  );
  await until(
    host,
    (id) => !__starfall.scene.world.enemies.some((e) => e.id === id),
    "host killed drone",
    droneId,
  );
  await until(
    guest,
    (id) => !__starfall.scene.world.enemies.some((e) => e.id === id),
    "guest saw kill",
    droneId,
  );
  step("gameplay events cross the wire");

  // 2b. pickup ownership: guest grabs a RAILGUN the host dropped on it
  await host.evaluate(([x, y]) => __starfall.spawnItem("weapon", "RAILGUN", x, y), [g.x, g.y]);
  await until(guest, () => __starfall.summary().weapon === "RAILGUN", "guest holds RAILGUN");
  await until(host, () => __starfall.summary().items.length === 0, "host removed item");
  assert.notEqual((await summary(host)).weapon, "RAILGUN", "host kept its own weapon");
  const mastery = await until(
    guest,
    () => {
      const el = document.getElementById("weapon-mastery");
      return !el.hidden && el.textContent;
    },
    "guest mastery HUD",
  );
  step("pickup ownership (guest RAILGUN + mastery HUD)", mastery);

  // 3. pause on the guest: host's match keeps running, guest docks out
  await key(guest, "keydown", "Escape");
  await until(guest, () => __starfall.scene.paused, "guest paused");
  await seesPeer(host, guestId, { present: false }, "host sees guest docked");
  await assertTicking(host, 400, "host during guest pause");
  await key(guest, "keydown", "Escape");
  await until(guest, () => !__starfall.scene.paused && __starfall.summary().alive, "guest resumed");
  await seesPeer(host, guestId, { present: true }, "host sees guest back");
  step("pause on one side does not freeze the other");

  // 4. no rematch in an endless arena: death → re-entry from each side instead
  for (const [page, other, id, name] of [
    [guest, host, guestId, "guest"],
    [host, guest, hostId, "host"],
  ]) {
    await page.evaluate(() => __starfall.setShield(0));
    await until(page, () => !__starfall.summary().alive, `${name} died`);
    await seesPeer(other, id, { present: true, alive: false }, `${name} death seen`);
    await until(page, () => __starfall.summary().alive, `${name} re-entered`);
    await seesPeer(other, id, { present: true, alive: true }, `${name} re-entry seen`);
  }
  step("restart from each side", "death → re-entry (no rematch concept)");

  // 5. host leaves: guest promoted, boss + epoch survive, no reset
  const h = await ship(host);
  const bossId = await host.evaluate(
    ([x, y]) => __starfall.spawnEnemy("dreadnought", x + 900, y + 900),
    [h.x, h.y],
  );
  await until(
    guest,
    (id) => __starfall.scene.world.enemies.some((e) => e.id === id),
    "boss on guest",
    bossId,
  );
  const epoch = await guest.evaluate(() => __starfall.scene.world.arenaEpoch);
  await host.context().close();
  await until(
    guest,
    () => __starfall.client.isHost && __starfall.scene.wasHost,
    "guest promoted",
    undefined,
    30_000,
  );
  assert.equal(await guest.evaluate(() => __starfall.scene.world.arenaEpoch), epoch, "epoch kept");
  assert.ok((await enemyIds(guest)).includes(bossId), "boss kept across migration");
  // A closed tab is a transport drop: the server parks the seat for the
  // reconnect grace window, and a tab that vanished without a close frame is
  // only reaped by the ping eviction.
  await until(
    guest,
    (id) => !(id in __starfall.client.players),
    "departed host left the roster",
    hostId,
    RECONNECT_GRACE_MS + EVICTION_TIMEOUT_MS,
  );
  step("host leaves → guest promoted, world continues");

  // 6. late join into the running match
  const late = await join(browser, vite.url, "late", false);
  const lateId = (await net(late)).id;
  await until(
    late,
    (id) => __starfall.scene.world.enemies.some((e) => e.id === id),
    "late sees boss",
    bossId,
  );
  await seesPeer(guest, lateId, { present: true }, "new host sees late joiner");
  step("late join");

  // 7. transport blips: a guest keeps predicting, the host stays host
  await dropLink(late, 1500);
  await until(late, () => __starfall.client.connectionStatus !== "connected", "late dropped");
  await assertTicking(late, 400, "guest during blip");
  await until(late, () => __starfall.client.connectionStatus === "connected", "late readmitted");
  await until(
    late,
    (id) => __starfall.scene.world.enemies.some((e) => e.id === id),
    "late reconciled",
    bossId,
  );
  await dropLink(guest, 1500);
  await until(guest, () => __starfall.client.connectionStatus !== "connected", "host dropped");
  assert.ok(
    await guest.evaluate(() => __starfall.summary().isHost),
    "host keeps authority through the blip",
  );
  await assertTicking(guest, 400, "host during blip");
  await until(guest, () => __starfall.client.connectionStatus === "connected", "host readmitted");
  assert.deepEqual(
    await guest.evaluate(() => [
      __starfall.client.isHost,
      __starfall.scene.hostSnapshotReady,
      __starfall.scene.world.arenaEpoch,
    ]),
    [true, true, epoch],
    "host resumed without re-adopting",
  );
  const before = await late.evaluate(
    (id) => __starfall.scene.world.enemies.find((e) => e.id === id)?.x,
    bossId,
  );
  await until(
    late,
    ([id, x]) => __starfall.scene.world.enemies.find((e) => e.id === id)?.x !== x,
    "guest streams again",
    [bossId, before],
  );
  step("reconnect: prediction during blip, host continuity");

  assert.deepEqual(errors, [], "console errors");
  console.log("PASS no console errors on any client");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  vite.stop();
  // A leaked dev-server handle would otherwise keep node alive past the last check.
  process.exit(process.exitCode ?? 0);
}
