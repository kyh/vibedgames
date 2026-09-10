// Two-client online smoke: host + guest through join, wire traffic, pause,
// rematch, host handoff and a late join. Needs the party server on :8787 and
// Chrome. `node tools/two-client.mjs [--url http://localhost:PORT]` — without
// --url it launches its own vite on :5313.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const gameDir = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(import.meta.url)("playwright-core");
const urlArg = process.argv.indexOf("--url");
const PORT = 5313;
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
  // oxlint-disable-next-line promise/avoid-new -- child_process.spawn is event-based
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

const openClient = async (browser, base, name) => {
  const context = await browser.newContext({ viewport: { height: 540, width: 960 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") {
      errors.push(`${name}: ${m.text()}`);
    }
  });
  await page.goto(`${base}/?online=1&room=${room}&name=${name}`);
  return { context, name, page };
};

const diag = (page) => page.evaluate(() => structuredClone(window.__GAME_DIAGNOSTICS__));

const until = async (page, predicate, label, timeout = 20_000, arg = null) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await page.evaluate(predicate, arg);
    if (value) {
      return value;
    }
    await wait(100);
  }
  throw new Error(`timeout: ${label}`);
};

const joined = (client) =>
  until(
    client.page,
    () => {
      const d = window.__GAME_DIAGNOSTICS__;
      return d?.online?.connection === "connected" && d.player ? d.online.playerId : null;
    },
    `${client.name} joined`,
    45_000,
  );

const unitOf = (page, id) =>
  page.evaluate((unitId) => {
    const u = window.__ba.world.units.get(`h-${unitId}`);
    return u ? { alive: u.alive, hp: u.hp, x: u.x, y: u.y } : null;
  }, id);

const key = (page, type, code, keyName = code) =>
  page.evaluate(
    (ev) =>
      window.dispatchEvent(
        new KeyboardEvent(ev.type, { bubbles: true, code: ev.code, key: ev.key }),
      ),
    { code, key: keyName, type },
  );

const gameTime = (page) => page.evaluate(() => window.__ba.world.gameTime);
const isPaused = (page) => page.evaluate(() => window.__ba.controlsPaused);

const endMatch = async (page) => {
  await page.evaluate(() => {
    const w = window.__ba.world;
    w.phase = "ended";
    w.winner = w.units.get(window.__ba.localId)?.team ?? null;
  });
};

const rematchLabel = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('#hud [data-act="again"]');
    return b ? { disabled: b.disabled, text: b.textContent } : null;
  });

const movesOnKey = async (page, id, sim = page) => {
  const before = await unitOf(sim, id);
  await key(page, "keydown", "KeyW", "w");
  await wait(700);
  await key(page, "keyup", "KeyW", "w");
  const after = await unitOf(sim, id);
  assert.ok(before && after, "unit present");
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) > 0.5, "moved on KeyW");
};

const run = async (base) => {
  // Both clients must keep simulating; Chrome otherwise throttles whichever
  // window is not focused, which reads as a frozen peer.
  const browser = await chromium.launch({
    // Metal keeps headless Chrome on the real GPU; SwiftShader renders this scene at ~1 fps.
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
    const host = await openClient(browser, base, "Host");
    const guest = await openClient(browser, base, "Guest");
    let hostId;
    let guestId;
    await step("join", async () => {
      [hostId, guestId] = await Promise.all([joined(host), joined(guest)]);
      const d = await diag(host.page);
      assert.equal(d.online.authority, true, "first player hosts");
    });
    await step("both see each other", async () => {
      await until(
        host.page,
        (id) => !!window.__ba.world.units.get(`h-${id}`),
        "host sees guest",
        20_000,
        guestId,
      );
      await until(
        guest.page,
        (id) => !!window.__ba.world.units.get(`h-${id}`),
        "guest sees host",
        20_000,
        hostId,
      );
      assert.ok(await unitOf(host.page, guestId));
      assert.ok(await unitOf(guest.page, hostId));
    });
    await step("guest input crosses the wire", async () => {
      // the intro sweep; the sim runs, input is live
      await wait(1500);
      await movesOnKey(guest.page, guestId, host.page);
      await key(guest.page, "keydown", "Space", " ");
      await key(guest.page, "keyup", "Space", " ");
      await until(
        host.page,
        (id) => window.__ba.world.units.get(`h-${id}`)?.jumpUntil > 0,
        "guest jump reached host",
        20_000,
        guestId,
      );
      await until(
        guest.page,
        (id) => window.__ba.world.units.get(`h-${id}`)?.jumpUntil > 0,
        "jump echoed to guest",
        20_000,
        guestId,
      );
    });
    await step("host pause does not freeze the guest", async () => {
      await key(host.page, "keydown", "Escape", "Escape");
      await until(host.page, () => window.__ba.controlsPaused, "host paused");
      const t0 = await gameTime(guest.page);
      await wait(1000);
      assert.ok((await gameTime(guest.page)) - t0 > 0.5, "guest clock advances while host pauses");
      await key(host.page, "keydown", "Escape", "Escape");
      await until(host.page, () => !window.__ba.controlsPaused, "host resumed");
      assert.equal(await isPaused(host.page), false);
    });
    await step("rematch from the host", async () => {
      await endMatch(host.page);
      await until(guest.page, () => window.__ba.world.phase === "ended", "guest sees the result");
      assert.deepEqual(await rematchLabel(guest.page), {
        disabled: true,
        text: "WAITING FOR HOST",
      });
      await until(
        host.page,
        () => document.querySelector('#hud [data-act="again"]')?.textContent === "START REMATCH",
        "host may rematch",
      );
      const before = await diag(guest.page);
      const gen = before.online.matchGeneration;
      await host.page.click('#hud [data-act="again"]');
      await until(
        guest.page,
        (previous) =>
          window.__ba.world.phase === "playing" &&
          window.__GAME_DIAGNOSTICS__.online.matchGeneration === previous + 1,
        "guest joins the rematch",
        20_000,
        gen,
      );
      assert.ok(await unitOf(guest.page, guestId), "guest keeps a seat");
    });
    await step("host leaves, guest is promoted and plays on", async () => {
      await host.context.close();
      await until(
        guest.page,
        (id) =>
          window.__GAME_DIAGNOSTICS__.online.hostId === id &&
          window.__GAME_DIAGNOSTICS__.online.authority,
        "guest promoted within seconds",
        10_000,
        guestId,
      );
      await until(
        guest.page,
        (id) => !window.__ba.world.units.get(`h-${id}`),
        "departed host removed",
        10_000,
        hostId,
      );
      const t0 = await gameTime(guest.page);
      await wait(1000);
      assert.ok((await gameTime(guest.page)) - t0 > 0.5, "promoted guest simulates");
      await movesOnKey(guest.page, guestId);
    });
    await step("rematch from the promoted guest", async () => {
      const before = await diag(guest.page);
      const gen = before.online.matchGeneration;
      await endMatch(guest.page);
      await until(
        guest.page,
        () => document.querySelector('#hud [data-act="again"]')?.textContent === "START REMATCH",
        "promoted guest may rematch",
      );
      await guest.page.click('#hud [data-act="again"]');
      await until(
        guest.page,
        (previous) =>
          window.__ba.world.phase === "playing" &&
          window.__GAME_DIAGNOSTICS__.online.matchGeneration === previous + 1,
        "rematch started",
        20_000,
        gen,
      );
    });
    await step("late join into the running match", async () => {
      await wait(2000);
      const late = await openClient(browser, base, "Late");
      const lateId = await joined(late);
      await until(
        late.page,
        (id) => !!window.__ba.world.units.get(`h-${id}`),
        "late sees the host",
        20_000,
        guestId,
      );
      await until(
        guest.page,
        (id) => !!window.__ba.world.units.get(`h-${id}`),
        "host sees late",
        20_000,
        lateId,
      );
      assert.ok((await gameTime(late.page)) > 1, "late joiner lands in a live clock");
      await late.context.close();
    });
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
