// Two-client online smoke: host + guest race for pellets in a fresh party room
// (claims cross the wire, a contested cell resolves to one eater, a pause on
// one side leaves the other's maze live, R after a win resets the shared
// maze), then the host leaves and a late joiner adopts the promoted host's
// board. Needs the party server on localhost:8787 and a Chrome install
// (playwright-core, channel "chrome"). Not part of `pnpm test` for that reason.
//
// Usage: node tools/two-client.mjs [--url http://localhost:5309]
// Without --url it starts its own vite.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gameDir = resolve(import.meta.dirname, "..");
const { chromium } = createRequire(join(gameDir, "package.json"))("playwright-core");

const PARTY = "http://localhost:8787";
const DEV_PORT = 5309;
const SCORE_PELLET = 10;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(page, fn, label, timeoutMs = 8000, arg) {
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
}

const snapshot = (page) =>
  page.evaluate(() => {
    const { game } = window.__pacman;
    const board = game.net.sharedState?.board;
    return {
      applied: game.appliedEaten.size,
      boardEaten: board ? Object.keys(board.eaten).length : -1,
      host: game.net.isHost,
      hostEaten: game.hostEaten.size,
      left: game.pelletsLeft(),
      paused: game.paused,
      pending: game.pendingClaims.size,
      phase: game.phase,
      pill: game.statsEl.textContent,
      rivals: game.rivalIds.length,
      round: game.boardRound,
      score: game.score,
      t: game.t,
    };
  });

/** Park the pac on a cell facing right and chomp once toward the next cell.
 *  The first step also eats the pellet under the pac, so two cells go. */
const chompFrom = (page, col, row) =>
  page.evaluate(
    ([col, row]) => {
      const { game } = window.__pacman;
      Object.assign(game.pac, {
        dir: "right",
        isMoving: false,
        target: { x: col, z: row },
        x: col,
        z: row,
      });
      window.__pacman.chomp();
    },
    [col, row],
  );

const eaten = (page, key) =>
  waitFor(page, (k) => window.__pacman.game.appliedEaten.has(k), `eaten ${key}`, 4000, key);

async function startPlaying(page) {
  await page.keyboard.press("Enter");
  await waitFor(page, () => window.__pacman.game.phase === "playing", "playing");
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
  await waitFor(
    page,
    () => window.__pacman?.game.net.connectionStatus === "connected",
    "connected",
  );
  return page;
}

async function startVite() {
  // The binary itself, not `pnpm exec`: kill() must reach vite, not a wrapper.
  const child = spawn(
    join(gameDir, "node_modules/.bin/vite"),
    ["--port", String(DEV_PORT), "--strictPort"],
    {
      cwd: gameDir,
      stdio: "ignore",
    },
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
    await startPlaying(host);
    let h = await snapshot(host);
    step("host joins as host and plays", h.host && h.phase === "playing", JSON.stringify(h));
    const fullMaze = h.left;

    const guest = await openClient(browser, url, errors.guest);
    await waitFor(guest, () => window.__pacman.game.rivalIds.length === 1, "guest sees host");
    await waitFor(host, () => window.__pacman.game.rivalIds.length === 1, "host sees guest");
    await startPlaying(guest);
    let g = await snapshot(guest);
    step(
      "both see each other",
      !g.host && g.rivals === 1 && g.left === fullMaze,
      JSON.stringify(g),
    );

    // A guest pellet crosses the wire: the host's maze and "N left" pill follow.
    await chompFrom(guest, 1, 1);
    await eaten(guest, "2,1");
    await eaten(host, "2,1");
    await wait(300);
    h = await snapshot(host);
    g = await snapshot(guest);
    step(
      "rival pellets vanish on the host",
      h.left === fullMaze - 2 && g.left === h.left,
      `${h.left}`,
    );
    step("pellets-left pill matches on both", h.pill === g.pill, h.pill);
    step(
      "guest claims accepted",
      g.score === 2 * SCORE_PELLET && h.hostEaten === 2,
      `score ${g.score}`,
    );

    // Same cells, same instant: each resolves to exactly one eater on both screens.
    const hs = h.score;
    const gs = g.score;
    const before = h.left;
    await Promise.all([chompFrom(host, 13, 1), chompFrom(guest, 13, 1)]);
    await eaten(host, "14,1");
    await eaten(guest, "14,1");
    await wait(600);
    h = await snapshot(host);
    g = await snapshot(guest);
    step(
      "contested cell resolves to one eater",
      h.score - hs + (g.score - gs) === 2 * SCORE_PELLET,
      `host +${h.score - hs} guest +${g.score - gs}`,
    );
    step(
      "maze agrees after the contest",
      h.left === g.left && h.left === before - 2,
      `${h.left} left`,
    );

    // Escape on the host freezes only the host's pac: the guest keeps eating
    // and the (paused) host still arbitrates its claims.
    await host.keyboard.press("Escape");
    await waitFor(host, () => window.__pacman.game.paused, "host paused");
    const gt = (await snapshot(guest)).t;
    await chompFrom(guest, 3, 1);
    await eaten(guest, "4,1");
    await waitFor(
      host,
      () => window.__pacman.game.net.sharedState.board.eaten["4,1"] === 1,
      "paused host arbitrated",
    );
    g = await snapshot(guest);
    step(
      "host pause does not freeze the guest",
      g.t > gt && !g.paused,
      `guest +${(g.t - gt).toFixed(2)}s`,
    );
    await host.keyboard.press("Escape");
    await waitFor(host, () => !window.__pacman.game.paused, "host resumed");
    await eaten(host, "4,1");
    step("resumed host catches up", (await snapshot(host)).left === g.left, `${g.left} left`);
    await guest.keyboard.press("Escape");
    await waitFor(guest, () => window.__pacman.game.paused, "guest paused");
    await chompFrom(host, 5, 1);
    await eaten(host, "6,1");
    step("guest pause does not freeze the host", true);
    await guest.keyboard.press("Escape");
    await waitFor(guest, () => !window.__pacman.game.paused, "guest resumed");
    await eaten(guest, "6,1");

    // Host clears the maze; both land on the win banner. R on the guest waits
    // for the host; R on the host starts a fresh shared round for both.
    await host.evaluate(() => {
      const { game } = window.__pacman;
      for (let row = 0; row < 31; row++) {
        for (let col = 0; col < 31; col++) {
          if (game.appliedEaten.has(`${col},${row}`) || !game.parseEatKey(`${col},${row}`)) {
            continue;
          }
          Object.assign(game.pac, { isMoving: false, target: { x: col, z: row }, x: col, z: row });
          game.collectPellet();
        }
      }
    });
    await waitFor(host, () => window.__pacman.game.phase === "win", "host win");
    await waitFor(guest, () => window.__pacman.game.phase === "win", "guest win");
    step("shared maze empties into a win on both", true);
    await guest.keyboard.press("r");
    await wait(400);
    step("guest R waits for the host", (await snapshot(guest)).phase === "win");
    await host.keyboard.press("r");
    await waitFor(host, () => window.__pacman.game.phase === "playing", "host rematch");
    await waitFor(guest, () => window.__pacman.game.phase === "playing", "guest rematch");
    h = await snapshot(host);
    g = await snapshot(guest);
    step(
      "rematch resets the shared maze on both",
      h.left === fullMaze && g.left === fullMaze && h.round === g.round && g.round > 0,
      `round ${g.round}`,
    );

    // Host leaves: the guest is promoted, adopts the eaten set, keeps playing.
    await chompFrom(host, 1, 1);
    await eaten(guest, "2,1");
    await host.close();
    await waitFor(guest, () => window.__pacman.game.net.isHost, "guest promoted", 10_000);
    await waitFor(guest, () => window.__pacman.game.rivalIds.length === 0, "held seat ignored");
    g = await snapshot(guest);
    step(
      "guest promoted to host on host leave",
      g.host && g.phase === "playing" && g.hostEaten === g.applied,
      JSON.stringify(g),
    );
    await chompFrom(guest, 3, 1);
    await eaten(guest, "4,1");
    step("promoted host keeps playing", true);

    const late = await openClient(browser, url, errors.late);
    await waitFor(late, () => window.__pacman.game.rivalIds.length === 1, "late sees host");
    await startPlaying(late);
    await eaten(late, "4,1");
    g = await snapshot(guest);
    const l = await snapshot(late);
    step(
      "late joiner adopts the running board",
      !l.host && l.round === g.round && l.left === g.left,
      `${l.left} left, round ${l.round}`,
    );
    await chompFrom(late, 5, 1);
    await eaten(guest, "6,1");
    step("late joiner's pellet reaches the promoted host", true);
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
