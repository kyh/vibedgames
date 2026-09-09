// Two-client online smoke: host + guest race in a fresh party room, then the
// host leaves and a late joiner adopts the promoted host's course. Needs the
// party server on localhost:8787 and a Chrome install (playwright-core, channel
// "chrome"). Not part of `pnpm test` for that reason.
//
// Usage: node tools/two-client.mjs [--url http://localhost:5308]
// Without --url it starts its own vite on a free port.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gameDir = resolve(import.meta.dirname, "..");
const { chromium } = createRequire(join(gameDir, "package.json"))("playwright-core");

const PARTY = "http://localhost:8787";
const DEV_PORT = 5308;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(page, fn, label, timeoutMs = 8000) {
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
}

const snapshot = (page) =>
  page.evaluate(() => {
    const { scene, net } = window.__fb;
    return {
      counting: scene.countingDown,
      ghosts: scene.ghosts.size,
      host: net.isHost,
      id: net.playerId,
      paused: scene.presentationPaused,
      phase: scene.phase,
      pipes: [...scene.pipes.keys()].sort((a, b) => a - b),
      players: Object.keys(net.players).length,
      seed: scene.seed,
      status: net.connectionStatus,
      worldX: scene.worldX,
    };
  });

/** Start screen → 3-2-1 → first flap; resolves once the dragon is flying. */
async function startFlying(page) {
  await page.keyboard.press("Enter");
  await waitFor(
    page,
    () => window.__fb.scene.started && !window.__fb.scene.countingDown,
    "countdown",
  );
  await page.keyboard.press("Space");
  await waitFor(page, () => window.__fb.scene.phase === "playing", "playing");
}

async function openClient(browser, url, errors) {
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
}

async function startVite() {
  // The binary itself, not `pnpm exec`: kill() must reach vite, not a wrapper.
  const child = spawn(
    join(gameDir, "node_modules/.bin/vite"),
    ["--port", String(DEV_PORT), "--strictPort"],
    { cwd: gameDir, stdio: "ignore" },
  );
  const base = `http://localhost:${DEV_PORT}`;
  for (let i = 0; i < 100; i++) {
    await wait(200);
    if (
      await fetch(base).then(
        (r) => r.ok,
        () => false,
      )
    ) {
      return { base, child };
    }
  }
  child.kill();
  throw new Error("vite did not start");
}

async function main() {
  const urlArg = process.argv.indexOf("--url");
  const dev = urlArg !== -1 ? { base: process.argv[urlArg + 1], child: null } : await startVite();
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
    await startFlying(host);
    let h = await snapshot(host);
    step("host joins as host and flies", h.host && h.seed > 0, JSON.stringify(h));

    // A solo crash + restart rerolls the seed; a later guest must adopt the reroll.
    await waitFor(host, () => window.__fb.scene.phase === "gameover", "host crash");
    await wait(400);
    await host.keyboard.press("Space");
    await waitFor(
      host,
      () => window.__fb.scene.seed !== 0 && window.__fb.scene.phase === "ready",
      "restart",
    );
    const rerolled = (await snapshot(host)).seed;
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
    const hostTop = await host.evaluate((i) => window.__fb.scene.pipes.get(i).topHeight, shared[0]);
    const guestTop = await guest.evaluate(
      (i) => window.__fb.scene.pipes.get(i).topHeight,
      shared[0],
    );
    step("same pipe geometry on both", hostTop === guestTop, `pipe ${shared[0]} top ${hostTop}`);
    step("rival ghosts drawn on both", h.ghosts === 1 && g.ghosts === 1);

    // Crashes cross the wire: the host's dragon falls, the guest's board greys it.
    await waitFor(host, () => window.__fb.scene.phase === "gameover", "host crash");
    await waitFor(
      guest,
      () => window.__fb.net.otherPlayer()?.state?.live === false,
      "guest sees crash",
    );
    step("crash reaches the other client", true);
    await waitFor(host, () => window.__fb.scene.phase === "playing", "host respawn", 3000);
    await waitFor(
      guest,
      () => window.__fb.net.otherPlayer()?.state?.live === true,
      "guest sees respawn",
    );
    step("host respawns into the race", true);
    await waitFor(guest, () => window.__fb.scene.phase === "gameover", "guest crash");
    await waitFor(guest, () => window.__fb.scene.phase === "playing", "guest respawn", 3000);
    step("guest respawns into the race", true);

    // Escape on the guest pauses presentation only; the shared course keeps scrolling.
    await guest.keyboard.press("Escape");
    await waitFor(guest, () => window.__fb.scene.presentationPaused, "guest paused");
    const beforeH = (await snapshot(host)).worldX;
    const beforeG = (await snapshot(guest)).worldX;
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
    const beforeG2 = (await snapshot(guest)).worldX;
    await wait(600);
    step("host pause does not freeze the guest", (await snapshot(guest)).worldX - beforeG2 > 40);
    await host.keyboard.press("Escape");
    await waitFor(host, () => !window.__fb.scene.presentationPaused, "host resumed");

    // Host leaves: the guest is promoted, keeps the seed, and the course keeps moving.
    const seedBefore = (await snapshot(guest)).seed;
    await host.close();
    await waitFor(guest, () => window.__fb.net.isHost, "guest promoted", 10_000);
    // The server holds the departed seat for a reconnect; the game must not
    // treat that held seat as a rival (no frozen ghost, no "2 players").
    await waitFor(guest, () => window.__fb.scene.rivalIds.length === 0, "held seat ignored");
    g = await snapshot(guest);
    step("guest promoted to host on host leave", g.host && g.ghosts === 0, JSON.stringify(g));
    step("promoted host keeps the seed", g.seed === seedBefore, `${g.seed}`);
    // Alone now, the promoted host is on solo rules: a crash offers a restart
    // (fresh seed, course from zero) instead of the race respawn.
    if (g.phase === "gameover") {
      await wait(400);
      await guest.keyboard.press("Space");
      await waitFor(
        guest,
        () => window.__fb.scene.phase === "ready" && !window.__fb.scene.countingDown,
        "solo restart",
      );
      await guest.keyboard.press("Space");
    }
    await waitFor(
      guest,
      () => window.__fb.scene.phase === "playing",
      "promoted host playable",
      4000,
    );
    const running = (await snapshot(guest)).seed;

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
    step("late joiner and host draw each other", g.ghosts === 1 && l.ghosts === 1);
    await waitFor(late, () => window.__fb.scene.phase === "gameover", "late crash");
    await waitFor(late, () => window.__fb.scene.phase === "playing", "late respawn", 3000);
    step("late joiner respawns into the race", true);
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
