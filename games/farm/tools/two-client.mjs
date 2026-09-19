// Two-client co-op smoke: host + guest farm the same room, tile edits cross the
// wire both ways, pausing (farm and mine) never freezes the other side, the
// host leaves and the promoted guest keeps the farm for a late joiner. Needs
// the party server on localhost:8787 and a Chrome install (playwright-core,
// channel "chrome"). Not part of `pnpm test` for that reason.
//
// Usage: node tools/two-client.mjs [--url http://localhost:5305]
// Without --url it starts its own vite on DEV_PORT.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const gameDir = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(path.join(gameDir, "package.json"))("playwright-core");

const PARTY = "http://localhost:8787";
const DEV_PORT = 5325;
/** Past the window in which a silent host gets replaced (~7 s locally). */
const HOST_STALE_MS = 9000;
/** Farm tiles are indexed row-major over the fixed 86×48 map. */
const MAP_W = 86;
const MAP_H = 48;

/** Fetch that answers null when the server is down; any status (even 404) counts as up. */
const probe = async (url) => {
  try {
    return await fetch(url);
  } catch {
    return null;
  }
};

const waitFor = async (page, fn, label, { timeoutMs = 8000, arg } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg);
    if (last) {
      return last;
    }
    await wait(100);
  }
  throw new Error(`timeout: ${label} (last=${JSON.stringify(last)})`);
};

const snapshot = (page) =>
  page.evaluate(() => {
    const gs = window.__gs;
    const d = window.__GAME_DIAGNOSTICS__;
    return {
      day: gs.day,
      frame: d.frame,
      host: gs.net.isHost,
      hostId: gs.net.hostId,
      paused: gs.controlsPaused,
      phase: d.phase,
      players: Object.keys(gs.net.players).length,
      remote: gs.remoteFarmers.count(),
      status: gs.net.connectionStatus,
      time: gs.timeMin,
    };
  });

/** Title → fresh farm → connected to the room. Own browser context: own save. */
const openClient = async (browser, url, errors) => {
  const context = await browser.newContext({ viewport: { height: 600, width: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") {
      errors.push(m.text());
    }
  });
  await page.goto(url);
  await waitFor(page, () => window.__game?.scene.isActive("Title"), "title", {
    timeoutMs: 20_000,
  });
  await page.keyboard.press("n");
  await waitFor(page, () => window.__gs?.net?.connectionStatus === "connected", "connected", {
    timeoutMs: 15_000,
  });
  return page;
};

/** Swing the hoe at the nearest bare tile; resolves with its flat index. */
const till = (page) =>
  page.evaluate(
    ({ w, h }) => {
      const gs = window.__gs;
      const f = gs.feetTile();
      let best = null;
      for (let ty = 0; ty < h; ty += 1) {
        for (let tx = 0; tx < w; tx += 1) {
          if (!gs.world.canTill(tx, ty)) {
            continue;
          }
          const d = Math.abs(tx - f.tx) + Math.abs(ty - f.ty);
          if (!best || d < best.d) {
            best = { d, tx, ty };
          }
        }
      }
      gs.inv.select(0);
      gs.tryAction({ tx: best.tx, ty: best.ty });
      return best.ty * w + best.tx;
    },
    { h: MAP_H, w: MAP_W },
  );

/** ~1.5 s of the other farmer's clip on this client: [clip, frameIndex] per
 *  33 ms, plus how many times a packet re-seeked the clip meanwhile. */
const sampleRemoteClip = (page) =>
  page.evaluate(
    () =>
      // oxlint-disable-next-line promise/avoid-new -- runs inside the page; resolves from a setInterval, which has no promise form in the browser
      new Promise((resolve) => {
        const [farmer] = window.__gs.remoteFarmers.farmers.values();
        const { anims } = farmer.sprite;
        const { setCurrentFrame } = anims;
        let seeks = 0;
        // Phaser steps frames through setCurrentFrame too; only count the
        // network path (RemoteFarmers.sync, unminified under vite dev).
        anims.setCurrentFrame = (frame) => {
          if (String(new Error("stack probe").stack).includes("sync")) {
            seeks += 1;
          }
          return setCurrentFrame.call(anims, frame);
        };
        const samples = [];
        const id = setInterval(() => {
          samples.push([anims.currentAnim?.key, anims.currentFrame?.index]);
          if (samples.length >= 45) {
            clearInterval(id);
            anims.setCurrentFrame = setCurrentFrame;
            resolve({ samples, seeks });
          }
        }, 33);
      }),
  );

/** Frames may hold or step forward (or wrap to 1); a step back is a stale network frame. */
const backwardSteps = (samples) => {
  let steps = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const [, prev] = samples[i - 1];
    const [, cur] = samples[i];
    if (cur < prev && cur !== 1) {
      steps += 1;
    }
  }
  return steps;
};

const startVite = async () => {
  const child = spawn(
    path.resolve(gameDir, "node_modules/.bin/vite"),
    ["--port", String(DEV_PORT), "--strictPort"],
    {
      cwd: gameDir,
      stdio: "ignore",
    },
  );
  const base = `http://localhost:${DEV_PORT}`;
  for (let i = 0; i < 100; i += 1) {
    await wait(200);
    const response = await probe(base);
    if (response?.ok) {
      return { base, child };
    }
  }
  child.kill();
  throw new Error("vite did not start");
};

const main = async () => {
  const urlArg = process.argv.indexOf("--url");
  const dev = urlArg === -1 ? await startVite() : { base: process.argv[urlArg + 1], child: null };
  if (!(await probe(PARTY))) {
    throw new Error(`party server not reachable at ${PARTY} (pnpm dev:party)`);
  }
  const room = `t${process.pid}-${Date.now().toString(36)}`;
  const url = `${dev.base}/?room=${room}`;
  const errors = { guest: [], host: [], late: [] };
  // Both clients must keep simulating; Chrome otherwise throttles whichever
  // window is not focused, which reads as a frozen peer.
  const browser = await chromium.launch({
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
    channel: "chrome",
    headless: true,
  });
  const results = [];
  const step = (name, ok, note = "") => {
    results.push(`${ok ? "pass" : "FAIL"}  ${name}${note ? ` — ${note}` : ""}`);
    if (!ok) {
      throw new Error(`${name}: ${note}`);
    }
  };
  try {
    const host = await openClient(browser, url, errors.host);
    let h = await snapshot(host);
    step("host joins as host", h.host && h.players === 1, JSON.stringify(h));

    const guest = await openClient(browser, url, errors.guest);
    await waitFor(guest, () => window.__gs.remoteFarmers.count() === 1, "guest sees host");
    await waitFor(host, () => window.__gs.remoteFarmers.count() === 1, "host sees guest");
    h = await snapshot(host);
    let g = await snapshot(guest);
    step("both see each other", h.players === 2 && g.players === 2 && !g.host);

    // Guest till → host world (intent), host till → guest world (tiles blob).
    const guestTile = await till(guest);
    await waitFor(host, (i) => window.__gs.world.tilled[i] === 1, "host adopts guest till", {
      arg: guestTile,
      timeoutMs: 5000,
    });
    await waitFor(
      guest,
      (i) => (window.__gs.net.sharedState?.tiles?.[i] ?? null) !== null,
      "room ledger",
      { arg: guestTile, timeoutMs: 5000 },
    );
    step("guest's till reaches the host world", true, `tile ${guestTile}`);
    const hostTile = await till(host);
    await waitFor(guest, (i) => window.__gs.world.tilled[i] === 1, "guest adopts host till", {
      arg: hostTile,
      timeoutMs: 5000,
    });
    step("host's till reaches the guest world", true, `tile ${hostTile}`);

    // The other farmer's walk clip runs locally between 12 Hz packets: no
    // re-seeks while the clip is unchanged, frames only hold or advance.
    await host.keyboard.down("d");
    await wait(300);
    const { samples, seeks } = await sampleRemoteClip(guest);
    await host.keyboard.up("d");
    const walking = samples.filter(([k]) => k === "p-walk").length;
    const back = backwardSteps(samples);
    step(
      "remote walk clip runs locally between packets",
      walking >= 40 && seeks === 0 && back === 0,
      `walk ${walking}/45, seeks ${seeks}, back-steps ${back}`,
    );

    // Escape on either side fences that farmer only; the shared clock keeps running.
    await guest.keyboard.press("Escape");
    await waitFor(guest, () => window.__gs.controlsPaused, "guest paused");
    let before = await snapshot(guest);
    await wait(700);
    g = await snapshot(guest);
    step(
      "guest pause keeps the shared clock moving",
      g.time > before.time,
      `+${(g.time - before.time).toFixed(2)} min`,
    );
    await guest.keyboard.press("Escape");
    await waitFor(guest, () => !window.__gs.controlsPaused, "guest resumed");
    await host.keyboard.press("Escape");
    await waitFor(host, () => window.__gs.controlsPaused, "host paused");
    before = await snapshot(guest);
    await wait(700);
    g = await snapshot(guest);
    step(
      "host pause keeps the guest's clock moving",
      g.time > before.time,
      `+${(g.time - before.time).toFixed(2)} min`,
    );
    await host.keyboard.press("Escape");
    await waitFor(host, () => !window.__gs.controlsPaused, "host resumed");

    // Host pauses inside the (offline-only) mine: its loop must keep running so
    // the room keeps hearing from it — the guest is never promoted underneath.
    await host.evaluate(() => {
      const gs = window.__gs;
      const cave = gs.world.objects.find((o) => o.type === "cave");
      gs.tryAction({ tx: cave.tx, ty: cave.ty });
    });
    await waitFor(host, () => window.__GAME_DIAGNOSTICS__.phase === "mine", "host in mine", {
      timeoutMs: 5000,
    });
    await host.keyboard.press("Escape");
    await waitFor(host, () => window.__mine.controlsPaused === true, "mine paused");
    const { hostId: hostIdBefore } = await snapshot(guest);
    const frameBefore = await host.evaluate(() => window.__GAME_DIAGNOSTICS__.frame);
    await wait(HOST_STALE_MS);
    const frameAfter = await host.evaluate(() => window.__GAME_DIAGNOSTICS__.frame);
    g = await snapshot(guest);
    step(
      "mine pause keeps the host loop alive",
      frameAfter > frameBefore + 30,
      `+${frameAfter - frameBefore} frames`,
    );
    step(
      "paused host is not migrated away",
      g.hostId === hostIdBefore && !g.host && g.players === 2,
      `after ${HOST_STALE_MS} ms`,
    );
    await host.keyboard.press("Escape");
    await waitFor(host, () => window.__mine.controlsPaused === false, "mine resumed");
    await host.evaluate(() => window.__mine.exitToFarm());
    await waitFor(host, () => window.__GAME_DIAGNOSTICS__.phase === "farm", "host back on farm", {
      timeoutMs: 5000,
    });

    // Day end is host-only: the guest's sleep is refused, the host's reaches the guest.
    await guest.evaluate(() => window.__gs.doSleep());
    await wait(300);
    const afterGuestSleep = await snapshot(guest);
    step("guest cannot end the day", afterGuestSleep.day === 1);
    await host.evaluate(() => window.__gs.endDay());
    await waitFor(guest, () => window.__gs.day === 2, "guest sees day 2", { timeoutMs: 6000 });
    step("host's day end reaches the guest", true);

    // Host leaves: the guest is promoted with the whole ledger and keeps farming.
    // (The old seat lingers in the player map for the reconnect grace window.)
    await host.close();
    await waitFor(guest, () => window.__gs.net.isHost, "guest promoted", { timeoutMs: 15_000 });
    g = await snapshot(guest);
    step("guest promoted on host leave", g.host && g.phase === "farm", JSON.stringify(g));
    before = g;
    await wait(700);
    g = await snapshot(guest);
    step("promoted host drives the clock", g.time > before.time && g.day === 2);

    const late = await openClient(browser, url, errors.late);
    await waitFor(late, () => window.__gs.remoteFarmers.count() >= 1, "late sees host");
    await waitFor(
      late,
      (ids) => ids.every((i) => window.__gs.world.tilled[i] === 1),
      "late adopts farm",
      {
        arg: [guestTile, hostTile],
        timeoutMs: 6000,
      },
    );
    const l = await snapshot(late);
    step("late joiner adopts the promoted host's farm and day", !l.host && l.day === 2);
    await guest.close();
    await late.close();
    for (const [who, list] of Object.entries(errors)) {
      step(`no console errors: ${who}`, list.length === 0, list.join(" | "));
    }
  } finally {
    console.log(results.join("\n"));
    await browser.close();
    dev.child?.kill();
  }
};

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
