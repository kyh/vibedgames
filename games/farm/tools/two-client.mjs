import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const gameDir = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(path.join(gameDir, "package.json"))("playwright-core");

const PARTY = "http://localhost:8787";
const DEV_PORT = 5325;
const HOST_STALE_MS = 9000;
const MAP_W = 86;
const MAP_H = 48;

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

const sampleRemoteClip = (page) =>
  page.evaluate(
    () =>
      // oxlint-disable-next-line promise/avoid-new -- runs inside the page; resolves from a setInterval, which has no promise form in the browser
      new Promise((resolve) => {
        const [farmer] = window.__gs.remoteFarmers.farmers.values();
        const { anims } = farmer.sprite;
        const { setCurrentFrame } = anims;
        let seeks = 0;
        anims.setCurrentFrame = (frame) => {
          if (String(new Error("stack probe").stack).includes("seekClip")) {
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

const swingAt = async (page, tx, ty) => {
  await page.evaluate(({ x, y }) => window.__gs.tryAction({ tx: x, ty: y }), { x: tx, y: ty });
  await waitFor(page, () => !window.__gs.acting, "swing done", { timeoutMs: 3000 });
};

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

    const guestTile = await till(guest);
    await waitFor(host, (i) => window.__gs.world.tilled[i] === 1, "host adopts guest till", {
      arg: guestTile,
      timeoutMs: 5000,
    });
    await waitFor(guest, (i) => window.__gs.net.sharedState?.[`t${i}`] === 1, "room ledger", {
      arg: guestTile,
      timeoutMs: 5000,
    });
    step("guest's till reaches the host world", true, `tile ${guestTile}`);
    const hostTile = await till(host);
    await waitFor(guest, (i) => window.__gs.world.tilled[i] === 1, "guest adopts host till", {
      arg: hostTile,
      timeoutMs: 5000,
    });
    step("host's till reaches the guest world", true, `tile ${hostTile}`);

    const felled = await guest.evaluate(() => {
      const gs = window.__gs;
      const f = gs.feetTile();
      const trees = gs.world.objects.filter((o) => o.type === "tree");
      trees.sort(
        (a, b) =>
          Math.abs(a.tx - f.tx) +
          Math.abs(a.ty - f.ty) -
          Math.abs(b.tx - f.tx) -
          Math.abs(b.ty - f.ty),
      );
      gs.inv.select(
        gs.inv.slots.findIndex((s) => s?.item.kind === "tool" && s.item.tool === "axe"),
      );

      return trees[0];
    });

    for (let hit = 0; hit < felled.hp; hit += 1) {
      await swingAt(guest, felled.tx, felled.ty);
    }

    await waitFor(
      host,
      (id) => !window.__gs.world.objects.some((o) => o.id === id),
      "host loses the felled tree",
      { arg: felled.id, timeoutMs: 5000 },
    );
    step("guest's felled tree is gone on the host", true, `object ${felled.id}`);

    const picked = await host.evaluate(() => {
      const gs = window.__gs;
      const mushroom = gs.world.objects.find((o) => o.type === "forage");
      gs.tryAction({ tx: mushroom.tx, ty: mushroom.ty });

      return mushroom.id;
    });

    await waitFor(
      guest,
      (id) => !window.__gs.world.objects.some((o) => o.id === id),
      "guest loses the picked mushroom",
      { arg: picked, timeoutMs: 5000 },
    );
    step("host's picked mushroom is gone on the guest", true, `object ${picked}`);

    await host.keyboard.down("d");
    await wait(600);
    const { samples, seeks } = await sampleRemoteClip(guest);
    await host.keyboard.up("d");
    const walking = samples.filter(([k]) => k === "p-walk").length;
    const back = backwardSteps(samples);
    step(
      "remote walk clip runs locally between packets",
      walking >= 40 && seeks === 0 && back === 0,
      `walk ${walking}/45, seeks ${seeks}, back-steps ${back}`,
    );

    const home = await host.evaluate(() => {
      const { player } = window.__gs;
      const was = { x: player.x, y: player.y };
      player.setPosition(80 * 16 + 8, 20 * 16 + 12);

      return was;
    });

    await waitFor(guest, () => window.__gs.remoteFarmers.count() === 0, "far host hidden", {
      timeoutMs: 5000,
    });
    h = await snapshot(host);
    step("a far farmer leaves the guest's view; the host still sees everyone", h.remote === 1);
    await host.evaluate((p) => {
      window.__gs.player.setPosition(p.x, p.y);
    }, home);
    await waitFor(guest, () => window.__gs.remoteFarmers.count() === 1, "host back in view", {
      timeoutMs: 5000,
    });
    step("back in range, the farmer is drawn again", true);

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

    await guest.evaluate(() => window.__gs.doSleep());
    await wait(300);
    const afterGuestSleep = await snapshot(guest);
    step("guest cannot end the day", afterGuestSleep.day === 1);
    const tired = await guest.evaluate(() => window.__GAME_DIAGNOSTICS__.energy);
    await host.evaluate(() => window.__gs.endDay());
    await waitFor(guest, () => window.__gs.day === 2, "guest sees day 2", { timeoutMs: 6000 });
    step("host's day end reaches the guest", true);
    const rested = await guest.evaluate(() => window.__GAME_DIAGNOSTICS__.energy);
    step(
      "the new day restores the guest's energy",
      tired < 100 && rested === 100,
      `${tired} → ${rested}`,
    );

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
