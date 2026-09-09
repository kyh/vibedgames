// Two-client online smoke: host + guest through join, wire traffic, pause,
// host drop/reconnect, host stall, match end + rematch, late join and host
// leave. Needs the party server on :8787 and Chrome (playwright-core, channel
// "chrome"), so it is `pnpm test:online`, not part of `pnpm test`.
// `node tools/two-client.mjs [--url http://localhost:PORT]` — without --url it
// launches its own vite on :5302.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const gameDir = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(import.meta.url)("playwright-core");
const { EVICTION_TIMEOUT_MS, RECONNECT_GRACE_MS } = await import("@vibedgames/multiplayer");
const wait = (ms) =>
  // oxlint-disable-next-line no-promise-executor-return, promise/avoid-new -- setTimeout sleep has no promise form in the browser
  new Promise((resolve) => setTimeout(resolve, ms));
const urlArg = process.argv.indexOf("--url");
const PORT = 5302;
const room = `tc${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const errors = [];

const startVite = async () => {
  const child = spawn(
    path.resolve(gameDir, "node_modules/.bin/vite"),
    ["--port", String(PORT), "--strictPort"],
    {
      cwd: gameDir,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  // oxlint-disable-next-line promise/avoid-new -- wraps an event callback
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Local:")) {
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`vite exited ${code}`)));
  });
  return child;
};

const openClient = async (browser, base, name, hero) => {
  const context = await browser.newContext({ viewport: { height: 720, width: 1280 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => {
    // The dev server has no favicon; the browser asks for one anyway.
    if (m.type() === "error" && !m.location().url.endsWith("/favicon.ico")) {
      errors.push(`${name}: ${m.text()}`);
    }
  });
  await page.goto(`${base}/?auto=1&online=1&room=${room}&hero=${hero}`);
  return { context, name, page };
};

const until = async (page, predicate, label, { arg, timeout = 20_000 } = {}) => {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await page.evaluate(predicate, arg);
    if (last) {
      return last;
    }
    await wait(100);
  }
  throw new Error(`timeout: ${label} (last=${JSON.stringify(last)})`);
};

const online = (page) => page.evaluate(() => window.__moba.online());
const joined = (client) =>
  until(
    client.page,
    () => {
      const o = window.__moba?.online();
      return o?.status === "connected" && window.__moba.player() ? o.id : null;
    },
    `${client.name} joined`,
    { timeout: 45_000 },
  );
const unitOf = (page, id) =>
  page.evaluate((heroId) => {
    const u = window.__moba.world.units.get(`h-${heroId}`);
    return u ? { alive: u.alive, hp: u.hp, q: u.hero.abilities.Q, x: u.x, y: u.y } : null;
  }, id);
const seesUnit = (page, id, label) =>
  until(page, (heroId) => !!window.__moba.world.units.get(`h-${heroId}`), label, { arg: id });
const key = (page, type, name, keyCode, extra = {}) =>
  page.evaluate(
    (ev) =>
      window.dispatchEvent(
        new KeyboardEvent(ev.type, {
          bubbles: true,
          code: ev.key,
          key: ev.key,
          keyCode: ev.keyCode,
          ...ev.extra,
        }),
      ),
    { extra, key: name, keyCode, type },
  );
const gameTime = (page) => page.evaluate(() => window.__moba.world.gameTime);
const phase = (page) => page.evaluate(() => window.__moba.world.phase);
const isPaused = (page) => page.evaluate(() => window.__moba.scene.controlsPaused);
const hasResult = (page) => page.evaluate(() => !!window.__moba.scene.matchResult);

const clockAdvances = async (page, label) => {
  // Headless frames arrive in bursts; measure long enough that a frozen sim
  // (0 s) and a throttled one (≥ half speed) cannot be confused.
  const t0 = await gameTime(page);
  await wait(3000);
  const t1 = await gameTime(page);
  assert.ok(t1 - t0 > 1.5, label);
};

const movesOnArrow = async (page, id, sim = page) => {
  const before = await unitOf(sim, id);
  await key(page, "keydown", "ArrowRight", 39);
  await wait(700);
  await key(page, "keyup", "ArrowRight", 39);
  const after = await unitOf(sim, id);
  assert.ok(before && after, "unit present");
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) > 0.5, "moved on ArrowRight");
};

const pauseDoesNotFreeze = async (pauser, other) => {
  await key(pauser.page, "keydown", "Escape", 27);
  await until(pauser.page, () => window.__moba.scene.controlsPaused, `${pauser.name} paused`);
  await clockAdvances(other.page, `${other.name} clock runs while ${pauser.name} pauses`);
  await clockAdvances(pauser.page, `${pauser.name} keeps spectating while paused`);
  await key(pauser.page, "keydown", "Escape", 27);
  await until(pauser.page, () => !window.__moba.scene.controlsPaused, `${pauser.name} resumed`);
  assert.equal(await isPaused(pauser.page), false);
};

/** Wait until `client` hosts and simulates, and `follower` renders its clock. */
const promoted = async (client, follower) => {
  await until(client.page, () => window.__moba.online().isHost, `${client.name} promoted`, {
    timeout: 30_000,
  });
  await clockAdvances(client.page, `${client.name} simulates`);
  const clientOnline = await online(client.page);
  await until(
    follower.page,
    (id) => {
      const o = window.__moba.online();
      return o.status === "connected" && o.hostId === id && !o.isHost;
    },
    `${follower.name} follows ${client.name}`,
    { arg: clientOnline.id, timeout: 30_000 },
  );
  await clockAdvances(follower.page, `${follower.name} renders the new host's clock`);
};

const resultButton = (page, action) =>
  page.evaluate((wanted) => {
    const hud = window.__moba.scene.scene.get("Hud");
    const b = hud.result?.buttons.find((button) => button.action === wanted);
    if (!b) {
      return null;
    }
    const { root } = hud.result;
    return { x: root.x + b.bg.x * root.scaleX, y: root.y + b.bg.y * root.scaleY };
  }, action);

/** Click a result-card button as a player would, re-trying while the card is
 * still up: the card lays itself out over a couple of frames after it appears. */
const pressResult = async (page, action) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const at = await resultButton(page, action);
    if (!at) {
      return;
    }
    await page.mouse.click(at.x, at.y);
    await wait(400);
  }
};

const run = async (base) => {
  // Both clients must keep simulating; Chrome otherwise throttles whichever
  // window is not focused, which reads as a frozen peer.
  const browser = await chromium.launch({
    // Metal keeps headless Chrome on the real GPU; under SwiftShader two
    // clients starve each other and the host's frames stop entirely.
    args: [
      "--use-angle=metal",
      "--ignore-gpu-blocklist",
      "--mute-audio",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
    channel: "chrome",
    headless: true,
  });
  const results = [];
  const step = async (label, body) => {
    const started = Date.now();
    await body();
    results.push(`${label}: pass (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  };
  try {
    const a = await openClient(browser, base, "A", "ironvow");
    const b = await openClient(browser, base, "B", "duskblade");
    let aId;
    let bId;
    await step("join", async () => {
      [aId, bId] = await Promise.all([joined(a), joined(b)]);
      const [aOnline, bOnline] = await Promise.all([online(a.page), online(b.page)]);
      assert.equal(aOnline.isHost, true, "first player hosts");
      assert.equal(bOnline.isHost, false);
    });
    await step("both see each other", async () => {
      await seesUnit(a.page, bId, "host sees guest");
      await seesUnit(b.page, aId, "guest sees host");
      await seesUnit(b.page, bId, "guest sees itself");
    });
    await step("guest input crosses the wire", async () => {
      await movesOnArrow(b.page, bId, a.page);
      await key(b.page, "keydown", "Q", 81, { shiftKey: true });
      await key(b.page, "keyup", "Q", 81, { shiftKey: true });
      await until(
        a.page,
        (id) => window.__moba.world.units.get(`h-${id}`)?.hero.abilities.Q.rank > 0,
        "guest level-up reached host",
        { arg: bId, timeout: 10_000 },
      );
      await key(b.page, "keydown", "Q", 81);
      await key(b.page, "keyup", "Q", 81);
      await until(
        a.page,
        (id) => window.__moba.world.units.get(`h-${id}`)?.hero.abilities.Q.readyAt > 0,
        "guest Q cast reached host",
        { arg: bId, timeout: 10_000 },
      );
      await until(
        b.page,
        (id) => window.__moba.world.units.get(`h-${id}`)?.hero.abilities.Q.readyAt > 0,
        "cast echoed to guest",
        { arg: bId, timeout: 10_000 },
      );
    });
    await step("guest pause does not freeze the host", () => pauseDoesNotFreeze(b, a));
    await step("host pause does not freeze the guest", () => pauseDoesNotFreeze(a, b));
    await step("host transport drop: guest promoted, host reconnects as guest", async () => {
      await a.page.evaluate(() => window.__moba.scene.net.socket.close());
      await until(a.page, () => window.__moba.online().status !== "connected", "host dropped");
      await until(b.page, () => window.__moba.online().isHost, "guest promoted", {
        timeout: 30_000,
      });
      await a.page.evaluate(() => window.__moba.scene.net.socket.reconnect());
      await promoted(b, a);
      const [ta, tb] = await Promise.all([gameTime(a.page), gameTime(b.page)]);
      assert.ok(
        Math.abs(ta - tb) < 1.5,
        `reconnected host adopted the live clock (${ta} vs ${tb})`,
      );
      await movesOnArrow(a.page, aId, b.page);
    });
    await step("host loop stall: other client takes over, stalled host follows", async () => {
      const hang = b.page.evaluate(() => {
        const end = performance.now() + 9000;
        while (performance.now() < end) {
          // busy-wait on purpose: the test needs the host's main thread blocked
        }
      });
      // Settle the hang whichever way promotion goes, or its rejection on
      // browser close would mask the real failure.
      try {
        await promoted(a, b);
      } finally {
        await hang;
      }
      const [ta, tb] = await Promise.all([gameTime(a.page), gameTime(b.page)]);
      assert.ok(Math.abs(ta - tb) < 1.5, `stalled host follows the live clock (${ta} vs ${tb})`);
    });
    await step("match end reaches both, rematch from the host", async () => {
      await a.page.evaluate(() => window.__moba.kill("d-ancient"));
      await until(a.page, () => !!window.__moba.scene.matchResult, "host sees the result");
      await until(b.page, () => !!window.__moba.scene.matchResult, "guest sees the result");
      assert.equal(await resultButton(b.page, "again"), null, "guest cannot rematch");
      const again = await until(
        a.page,
        () =>
          !!window.__moba.scene.scene
            .get("Hud")
            .result?.buttons.some((button) => button.action === "again"),
        "host may rematch",
      );
      assert.ok(again);
      await pressResult(a.page, "again");
      await until(
        a.page,
        () => !window.__moba.scene.matchResult && window.__moba.world.phase === "playing",
        "host rematch started",
      );
      await until(
        b.page,
        () => !window.__moba.scene.matchResult && window.__moba.world.phase === "playing",
        "guest joins the rematch",
      );
      await seesUnit(b.page, bId, "guest keeps a seat");
      assert.ok((await gameTime(a.page)) < 30, "fresh clock");
    });
    let c;
    let cId;
    await step("late join into the running match", async () => {
      c = await openClient(browser, base, "C", "emberhex");
      cId = await joined(c);
      await seesUnit(c.page, aId, "late sees the host");
      await seesUnit(a.page, cId, "host sees late");
      assert.ok((await gameTime(c.page)) > 1, "late joiner lands in a live clock");
      await clockAdvances(c.page, "late joiner clock runs");
    });
    await step("host leaves: a remaining player is promoted and plays on", async () => {
      await a.context.close();
      const bOnline = await online(b.page);
      const next = bOnline.id < cId ? b : c;
      const other = next === b ? c : b;
      await promoted(next, other);
      // A closed tab is a transport drop: the seat is parked for the reconnect
      // grace window, and one that sent no close frame waits for eviction.
      await until(
        next.page,
        (id) => !window.__moba.world.units.get(`h-${id}`),
        "departed host removed",
        { arg: aId, timeout: RECONNECT_GRACE_MS + EVICTION_TIMEOUT_MS },
      );
      await movesOnArrow(next.page, next === b ? bId : cId);
      await movesOnArrow(other.page, other === b ? bId : cId, next.page);
      assert.equal(await phase(next.page), "playing");
      assert.equal(await hasResult(other.page), false);
    });
    await c.context.close();
    await b.context.close();
  } finally {
    console.log(results.join("\n"));
    await browser.close();
  }
  if (errors.length) {
    throw new Error(`console errors:\n${errors.join("\n")}`);
  }
};

const vite = urlArg === -1 ? await startVite() : null;
try {
  await run(urlArg === -1 ? `http://localhost:${PORT}` : process.argv[urlArg + 1]);
  console.log("two-client: ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  vite?.kill();
  // A leaked dev-server handle would otherwise keep node alive past the last check.
  process.exit(process.exitCode ?? 0);
}
