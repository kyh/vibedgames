// Two-client online smoke: host + guest race in a fresh party room, then the
// host leaves and a late joiner adopts the promoted host's course. Needs the
// party server on localhost:8787 and a Chrome install (playwright-core, channel
// "chrome", or CHROME_PATH=/path/to/chrome). Not part of `pnpm test` for that
// reason.
//
// Usage: node tools/two-client.mjs [--url http://localhost:5308]
// Without --url it starts its own vite on a free port.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const gameDir = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(path.join(gameDir, "package.json"))("playwright-core");

const PARTY = "http://localhost:8787";
const DEV_PORT = 5308;
const waitFor = async (page, fn, label, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn);
    if (last) {
      return last;
    }
    await wait(100);
  }
  throw new Error(`timeout: ${label} (last=${JSON.stringify(last)})`);
};

const snapshot = (page) =>
  page.evaluate(() => {
    const { scene, net } = window.__fb;
    const server = net.serverNow(performance.now());
    return {
      // Rivals whose connection dropped, drawn faded while the room holds their seat.
      away: [...scene.ghosts.values()].filter((ghost) => ghost.away).length,
      // This client's server time against the machine's wall clock, which the
      // local party server shares: how far its course is from the room's.
      clock: server === null ? null : server - Date.now(),
      counting: scene.countingDown,
      ghosts: scene.ghosts.size,
      host: net.isHost,
      id: net.playerId,
      paused: scene.presentationPaused,
      phase: scene.phase,
      pipes: [...scene.pipes.keys()].toSorted((a, b) => a - b),
      players: Object.keys(net.players).length,
      rivals: scene.rivalIds.length,
      seed: scene.seed,
      status: net.connectionStatus,
      worldX: scene.worldX,
    };
  });

/**
 * Two snapshots read the room's clock alike, so their courses agree: PIPE_SPEED
 * is 0.15 px per ms of disagreement. 60 ms (9 px) leaves room for a loaded
 * machine, where a busy main thread stamps probe replies late.
 */
const oneClock = (a, b) => [
  a.clock !== null && b.clock !== null && Math.abs(a.clock - b.clock) < 60,
  `server − wall: ${a.clock?.toFixed(1)} vs ${b.clock?.toFixed(1)} ms`,
];

/** Start screen → 3-2-1 → first flap; resolves once the dragon is flying. */
const startFlying = async (page) => {
  await page.keyboard.press("Enter");
  await waitFor(
    page,
    () => window.__fb.scene.started && !window.__fb.scene.countingDown,
    "countdown",
  );
  await page.keyboard.press("Space");
  await waitFor(page, () => window.__fb.scene.phase === "playing", "playing");
};

/**
 * Wait for the dragon to crash. With no input it falls into the ground on its
 * own — unless an earlier race crash already respawned it into the ready
 * hover, which waits for a flap: launch it.
 */
const crashOf = async (page, label) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const phase = await page.evaluate(() => window.__fb.scene.phase);
    if (phase === "gameover") {
      return;
    }
    if (phase === "ready") {
      await page.keyboard.press("Space");
    }
    await wait(100);
  }
  throw new Error(`timeout: ${label}`);
};

/**
 * A network blip, not a leave: `page`'s socket drops with a code other than
 * 1000 and 1001, so the room holds its seat, then redials. Resolves with what
 * `watcher` showed of that player while it was away and once it was back.
 */
const blip = async (page, watcher) => {
  await page.evaluate(() => window.__fb.net.client.socket.close(4000));
  await waitFor(page, () => window.__fb.net.connectionStatus === "reconnecting", "blip drops");
  await waitFor(
    watcher,
    () => document.querySelector("#board .row.away")?.textContent.includes("reconnecting"),
    "blip shows on the board",
  );
  const away = await snapshot(watcher);
  await page.evaluate(() => window.__fb.net.client.socket.reconnect());
  await waitFor(page, () => window.__fb.net.connectionStatus === "connected", "blip redials");
  await waitFor(
    watcher,
    () => document.querySelector("#board .row.away") === null,
    "blip back on the board",
  );
  return { away, back: await snapshot(watcher) };
};

/** One rival, still racing, with `away` of them drawn as dropped. */
const racesOne = (s, away) => s.rivals === 1 && s.ghosts === 1 && s.away === away;

/** A race crash respawns into the ready hover; the first flap relaunches it. */
const respawnAndFly = async (page, label) => {
  await waitFor(page, () => window.__fb.scene.phase === "ready", `${label} hover`, 3000);
  await page.keyboard.press("Space");
  await waitFor(page, () => window.__fb.scene.phase === "playing", `${label} flying`);
};

/** The smallest frame-to-frame change of the course scroll over `ms`. */
const worstScrollStep = (page, ms) =>
  page.evaluate(
    (span) =>
      // oxlint-disable-next-line promise/avoid-new -- requestAnimationFrame has no promise form
      new Promise((resolve) => {
        const { scene } = window.__fb;
        const until = performance.now() + span;
        let prev = scene.worldX;
        let worst = Number.POSITIVE_INFINITY;
        const tick = () => {
          worst = Math.min(worst, scene.worldX - prev);
          prev = scene.worldX;
          if (performance.now() < until) {
            requestAnimationFrame(tick);
          } else {
            resolve(worst);
          }
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );

const openClient = async (browser, url, errors) => {
  const page = await browser.newPage({ viewport: { height: 600, width: 900 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    // The dev server has no favicon; production is served by the games worker.
    if (m.type() === "error" && !m.location().url.endsWith("/favicon.ico")) {
      errors.push(m.text());
    }
  });
  await page.goto(url);
  await waitFor(page, () => window.__fb?.net.connectionStatus === "connected", "connected");
  return page;
};

const reachable = async (url) => {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
};

const startVite = async () => {
  // The binary itself, not `pnpm exec`: kill() must reach vite, not a wrapper.
  const child = spawn(
    path.join(gameDir, "node_modules/.bin/vite"),
    ["--port", String(DEV_PORT), "--strictPort"],
    { cwd: gameDir, stdio: "ignore" },
  );
  const base = `http://localhost:${DEV_PORT}`;
  for (let i = 0; i < 100; i += 1) {
    await wait(200);
    if (await reachable(base)) {
      return { base, child };
    }
  }
  child.kill();
  throw new Error("vite did not start");
};

const main = async () => {
  const urlArg = process.argv.indexOf("--url");
  const dev = urlArg === -1 ? await startVite() : { base: process.argv[urlArg + 1], child: null };
  if (
    !(await fetch(PARTY).then(
      () => true,
      () => false,
    ))
  ) {
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
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : { channel: "chrome" }),
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
    await startFlying(host);
    let h = await snapshot(host);
    step("host joins as host and flies", h.host && h.seed > 0, JSON.stringify(h));

    // A solo crash + restart rerolls the seed; a later guest must adopt the reroll.
    await crashOf(host, "host crash");
    await wait(400);
    await host.keyboard.press("Space");
    await waitFor(
      host,
      () => window.__fb.scene.seed !== 0 && window.__fb.scene.phase === "ready",
      "restart",
    );
    const { seed: rerolled } = await snapshot(host);
    step("solo restart rerolls the seed", rerolled !== h.seed, `${h.seed} → ${rerolled}`);
    await waitFor(host, () => !window.__fb.scene.countingDown, "countdown");
    await host.keyboard.press("Space");

    const guest = await openClient(browser, url, errors.guest);
    await waitFor(guest, () => window.__fb.net.otherPlayer() !== null, "guest sees host");
    await waitFor(host, () => window.__fb.net.otherPlayer() !== null, "host sees guest");
    await startFlying(guest);
    await waitFor(guest, () => window.__fb.scene.seed !== 0, "guest seed");
    h = await snapshot(host);
    let g = await snapshot(guest);
    step("guest adopts the host's seed", g.seed === rerolled && h.seed === rerolled, `${g.seed}`);
    step("both see each other", h.players === 2 && g.players === 2 && !g.host);
    await wait(1500);
    h = await snapshot(host);
    g = await snapshot(guest);
    const shared = h.pipes.filter((i) => g.pipes.includes(i));
    step(
      "both render the same pipe window",
      shared.length >= 2,
      `host ${h.pipes} guest ${g.pipes}`,
    );
    step(
      "guest scroll tracks the host",
      Math.abs(h.worldX - g.worldX) < 120,
      `${(h.worldX - g.worldX).toFixed(0)}px`,
    );
    step("host and guest scroll on one clock", ...oneClock(h, g));
    const worst = await worstScrollStep(guest, 1500);
    step("guest scroll never runs backwards", worst >= 0, `worst frame step ${worst}`);
    // The newest shared pipe: the oldest may have scrolled out during the check above.
    const newest = shared.at(-1);
    const hostTop = await host.evaluate((i) => window.__fb.scene.pipes.get(i).topHeight, newest);
    const guestTop = await guest.evaluate((i) => window.__fb.scene.pipes.get(i).topHeight, newest);
    step("same pipe geometry on both", hostTop === guestTop, `pipe ${newest} top ${hostTop}`);
    step("rival ghosts drawn on both", h.ghosts === 1 && g.ghosts === 1);

    // Crashes cross the wire: the host's dragon falls, the guest's board greys it.
    await crashOf(host, "host crash");
    await waitFor(
      guest,
      () => window.__fb.net.otherPlayer()?.state?.live === false,
      "guest sees crash",
    );
    step("crash reaches the other client", true);
    await respawnAndFly(host, "host respawn");
    await waitFor(
      guest,
      () => window.__fb.net.otherPlayer()?.state?.live === true,
      "guest sees respawn",
    );
    step("host respawns into the race", true);
    await crashOf(guest, "guest crash");
    await respawnAndFly(guest, "guest respawn");
    step("guest respawns into the race", true);

    // Escape on the guest pauses presentation only; the shared course keeps scrolling.
    await guest.keyboard.press("Escape");
    await waitFor(guest, () => window.__fb.scene.presentationPaused, "guest paused");
    const { worldX: beforeH } = await snapshot(host);
    const { worldX: beforeG } = await snapshot(guest);
    await wait(600);
    h = await snapshot(host);
    g = await snapshot(guest);
    step(
      "guest pause does not freeze the race",
      h.worldX - beforeH > 40 && g.worldX - beforeG > 40,
      `host +${(h.worldX - beforeH).toFixed(0)} guest +${(g.worldX - beforeG).toFixed(0)}`,
    );
    await guest.keyboard.press("Escape");
    await waitFor(guest, () => !window.__fb.scene.presentationPaused, "guest resumed");
    await host.keyboard.press("Escape");
    await waitFor(host, () => window.__fb.scene.presentationPaused, "host paused");
    const { worldX: beforeG2 } = await snapshot(guest);
    await wait(600);
    const { worldX: afterG2 } = await snapshot(guest);
    step("host pause does not freeze the guest", afterG2 - beforeG2 > 40);
    await host.keyboard.press("Escape");
    await waitFor(host, () => !window.__fb.scene.presentationPaused, "host resumed");

    // Host leaves: the guest is promoted, keeps the seed, and the course keeps moving.
    const { seed: seedBefore } = await snapshot(guest);
    await host.close();
    await waitFor(guest, () => window.__fb.net.isHost, "guest promoted", 10_000);
    // Closing a page is a leave, not a drop: the seat frees at once, so the
    // promoted guest races no one (no frozen ghost, no "2 players").
    await waitFor(guest, () => window.__fb.scene.rivalIds.length === 0, "departed host gone");
    g = await snapshot(guest);
    step("guest promoted to host on host leave", g.host && g.ghosts === 0, JSON.stringify(g));
    step("promoted host keeps the seed", g.seed === seedBefore, `${g.seed}`);
    // Alone now, the promoted host is on solo rules: a crash offers a restart
    // (fresh seed, course from zero) instead of the race respawn. A respawn
    // hover from before the handover waits for its first flap.
    if (g.phase === "gameover") {
      await wait(400);
      await guest.keyboard.press("Space");
      await waitFor(
        guest,
        () => window.__fb.scene.phase === "ready" && !window.__fb.scene.countingDown,
        "solo restart",
      );
      await guest.keyboard.press("Space");
    } else if (g.phase === "ready") {
      await guest.keyboard.press("Space");
    }
    await waitFor(
      guest,
      () => window.__fb.scene.phase === "playing",
      "promoted host playable",
      4000,
    );
    const { seed: running } = await snapshot(guest);

    const late = await openClient(browser, url, errors.late);
    await waitFor(late, () => window.__fb.net.otherPlayer() !== null, "late sees host");
    await waitFor(late, () => window.__fb.scene.seed !== 0, "late seed");
    await startFlying(late);
    await wait(1500);
    g = await snapshot(guest);
    const l = await snapshot(late);
    step(
      "late joiner adopts the running seed",
      l.seed === running && !l.host && l.worldX > 0,
      `${l.seed}`,
    );
    step(
      "late joiner scroll tracks the promoted host",
      Math.abs(g.worldX - l.worldX) < 120,
      `${(g.worldX - l.worldX).toFixed(0)}px`,
    );
    step("promoted host and late joiner scroll on one clock", ...oneClock(g, l));
    step("late joiner and host draw each other", g.ghosts === 1 && l.ghosts === 1);
    await crashOf(late, "late crash");
    await respawnAndFly(late, "late respawn");
    step("late joiner respawns into the race", true);
    // The room holds the late joiner's seat through a blip: the promoted host
    // races on with it, faded and reconnecting, and has it back on redial.
    const seen = await blip(late, guest);
    step(
      "a dropped rival stays in the race, faded and reconnecting",
      racesOne(seen.away, 1),
      JSON.stringify(seen.away),
    );
    step(
      "back from the blip, the rival races on",
      racesOne(seen.back, 0),
      JSON.stringify(seen.back),
    );
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
