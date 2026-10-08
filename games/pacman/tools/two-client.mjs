// Two-client online smoke: host + guest race for pellets in a fresh party room
// (an idle player is no rival, pellet claims cross the wire, rivals render, a
// contested cell goes to one eater on the server's word, a paused host holds
// up nobody's claims, R after a win resets the shared maze), then the host
// leaves and a late joiner reads the board from the claims. Needs the party
// server on localhost:8787 and a Chrome install (playwright-core, channel
// "chrome", or any Chromium binary in SMOKE_BROWSER). Not part of `pnpm test`
// for that reason.
//
// Usage: node tools/two-client.mjs [--url http://localhost:5309]
// Without --url it starts its own vite. SMOKE_NO_RENDER=1 skips drawing the
// scene, for machines with only software WebGL.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const gameDir = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(path.join(gameDir, "package.json"))("playwright-core");

const PARTY = "http://localhost:8787";
const DEV_PORT = 5309;
const SCORE_PELLET = 10;
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
    const { game } = window.__pacman;
    return {
      applied: game.appliedEaten.size,
      boardRound: game.net.sharedState?.round ?? -1,
      // What the room's claims alone say is gone this round.
      claimed: game.pellets.eaten(game.net.claims, game.boardRound).size,
      host: game.net.isHost,
      inFlight: game.pellets.inFlight,
      left: game.pelletsLeft(),
      paused: game.paused,
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
    ([x, z]) => {
      const { game } = window.__pacman;
      Object.assign(game.pac, {
        dir: "right",
        isMoving: false,
        target: { x, z },
        x,
        z,
      });
      window.__pacman.chomp();
    },
    [col, row],
  );

const eaten = (page, key) =>
  waitFor(page, (k) => window.__pacman.game.appliedEaten.has(k), `eaten ${key}`, {
    arg: key,
    timeoutMs: 4000,
  });

/** Who the room's claim on a cell of this round names, as `page` sees it (null: unclaimed). */
const ownerOf = (page, cell) =>
  page.evaluate(async (c) => {
    const { pelletClaimKey } = await import("/src/net/pellet-claims.ts");
    const { game } = window.__pacman;
    return game.net.claims[pelletClaimKey(game.boardRound, c)]?.owner ?? null;
  }, cell);

const idOf = (page) => page.evaluate(() => window.__pacman.game.net.playerId);

/** The one rival pac this page draws has come to rest on a cell. */
const drawsRivalAt = (page, col, row) =>
  waitFor(
    page,
    ([x, z]) => {
      const pacs = [...window.__pacman.game.remotePacs.pacs.values()];
      const at = pacs[0]?.group.position;
      return pacs.length === 1 && Math.abs(at.x - x) < 0.01 && Math.abs(at.z - z) < 0.01;
    },
    `rival drawn at ${col},${row}`,
    { arg: [col, row], timeoutMs: 4000 },
  );

const startPlaying = async (page) => {
  await page.keyboard.press("Enter");
  await waitFor(page, () => window.__pacman.game.phase === "playing", "playing");
};

/** Runs in the page before main.ts: hides the scene the moment the DEV hooks land. */
const hideScene = () => {
  let hooks;
  Object.defineProperty(window, "__pacman", {
    configurable: true,
    get: () => hooks,
    set: (value) => {
      hooks = value;
      value.game.scene.visible = false;
    },
  });
};

const openClient = async (browser, url, errors) => {
  const page = await browser.newPage({ viewport: { height: 600, width: 900 } });
  if (process.env.SMOKE_NO_RENDER) {
    // Software WebGL draws this scene at about one frame a second, which
    // starves the sim and the socket alike. Nothing here checks pixels, so
    // drawing nothing from the first frame keeps both at full speed.
    await page.addInitScript(hideScene);
  }
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
    {
      cwd: gameDir,
      stdio: "ignore",
    },
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

/** Who holds the two cells the contest runs through, as `page` sees it. */
const contestOwners = async (page) => [await ownerOf(page, "13,1"), await ownerOf(page, "14,1")];

/**
 * Host and guest step through the same two cells at once. The server's claim
 * decides each: both screens name the same eater, the loser hands its points
 * back, and the mazes agree.
 */
const contest = async ({ guest, host, step }) => {
  const [hostId, guestId] = [await idOf(host), await idOf(guest)];
  let h = await snapshot(host);
  let g = await snapshot(guest);
  const [hs, gs, before] = [h.score, g.score, h.left];
  await Promise.all([chompFrom(host, 13, 1), chompFrom(guest, 13, 1)]);
  await eaten(host, "14,1");
  await eaten(guest, "14,1");
  await wait(600);
  h = await snapshot(host);
  g = await snapshot(guest);
  step(
    "contested cells resolve to one eater each",
    h.score - hs + (g.score - gs) === 2 * SCORE_PELLET,
    `host +${h.score - hs} guest +${g.score - gs}`,
  );
  const onHost = await contestOwners(host);
  const hostWon = onHost.filter((id) => id === hostId).length;
  step(
    "both screens name the same eaters, and only they kept the points",
    onHost.every((id) => id === hostId || id === guestId) &&
      JSON.stringify(onHost) === JSON.stringify(await contestOwners(guest)) &&
      h.score - hs === SCORE_PELLET * hostWon,
    JSON.stringify(onHost),
  );
  step(
    "maze agrees after the contest",
    h.left === g.left && h.left === before - 2 && h.claimed === g.claimed,
    `${h.left} left`,
  );
};

/**
 * The host leaves: the guest is promoted and its maze is still the claims, and
 * a late joiner reads the same board from them.
 */
const handOver = async ({ browser, errors, fullMaze, guest, host, step, url }) => {
  await chompFrom(host, 1, 1);
  await eaten(guest, "2,1");
  await host.close();
  await waitFor(guest, () => window.__pacman.game.net.isHost, "guest promoted", {
    timeoutMs: 10_000,
  });
  await waitFor(guest, () => window.__pacman.game.rivalIds.length === 0, "held seat ignored");
  let g = await snapshot(guest);
  step(
    "guest promoted to host on host leave, its maze still the claims",
    g.host && g.phase === "playing" && g.claimed === g.applied && g.applied === fullMaze - g.left,
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
    "late joiner reads the running board from the claims",
    !l.host && l.round === g.round && l.left === g.left && l.claimed === g.claimed,
    `${l.left} left, round ${l.round}`,
  );
  await chompFrom(late, 5, 1);
  await eaten(guest, "6,1");
  step("late joiner's pellet reaches the promoted host", true);
  await guest.close();
  await late.close();
};

/**
 * A guest alone in the round (its host idles on the title screen) plays
 * solo rules, and a restart asks the idle host for a fresh shared maze.
 */
const soloGuestRestart = async ({ browser, errors, fullMaze, step, url }) => {
  const idle = await openClient(browser, url, errors.idle);
  const solo = await openClient(browser, url, errors.solo);
  await startPlaying(solo);
  await chompFrom(solo, 1, 1);
  await eaten(solo, "2,1");
  await eaten(idle, "2,1");
  let s = await snapshot(solo);
  const roundBefore = s.round;
  step(
    "a lone guest plays solo next to an idle host",
    !s.host && s.rivals === 0 && s.score === 2 * SCORE_PELLET && s.left === fullMaze - 2,
    JSON.stringify(s),
  );
  await solo.keyboard.press("r");
  await waitFor(solo, (round) => window.__pacman.game.boardRound > round, "fresh maze granted", {
    arg: roundBefore,
  });
  await waitFor(solo, () => window.__pacman.game.phase === "playing", "solo restarted");
  s = await snapshot(solo);
  const i = await snapshot(idle);
  step(
    "its restart resets the shared maze and leaves the idle host on its title",
    s.left === fullMaze &&
      i.left === fullMaze &&
      s.round === i.round &&
      s.score === 0 &&
      i.phase === "title",
    `${JSON.stringify(s)} / ${JSON.stringify(i)}`,
  );
  await solo.close();
  await idle.close();
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
  const errors = { guest: [], host: [], idle: [], late: [], solo: [] };
  // Both clients must keep simulating; Chrome otherwise throttles whichever
  // window is not focused, which reads as a frozen peer.
  const browser = await chromium.launch({
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
    ...(process.env.SMOKE_BROWSER
      ? { executablePath: process.env.SMOKE_BROWSER }
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
    await startPlaying(host);
    let h = await snapshot(host);
    step("host joins as host and plays", h.host && h.phase === "playing", JSON.stringify(h));
    const fullMaze = h.left;

    const guest = await openClient(browser, url, errors.guest);
    await waitFor(guest, () => window.__pacman.game.rivalIds.length === 1, "guest sees host");
    // Still on the title screen, the guest is in the room but not the round:
    // no pac parked in the host's maze, no race rules for the host.
    await wait(400);
    h = await snapshot(host);
    step("an idle guest is no rival", h.rivals === 0, JSON.stringify(h));
    await startPlaying(guest);
    await waitFor(host, () => window.__pacman.game.rivalIds.length === 1, "host sees guest");
    let g = await snapshot(guest);
    step(
      "both see each other",
      !g.host && g.rivals === 1 && g.left === fullMaze,
      JSON.stringify(g),
    );
    await drawsRivalAt(host, 1, 1);
    await drawsRivalAt(guest, 1, 1);
    step("each draws the other's pac at spawn", true);

    // A guest pellet crosses the wire: the host's maze and "N left" pill follow.
    await chompFrom(guest, 1, 1);
    await eaten(guest, "2,1");
    await eaten(host, "2,1");
    await drawsRivalAt(host, 2, 1);
    step("the host draws the guest's pac where its step ended", true);
    await wait(300);
    h = await snapshot(host);
    g = await snapshot(guest);
    step(
      "rival pellets vanish on the host",
      h.left === fullMaze - 2 && g.left === h.left,
      `${h.left}`,
    );
    step("pellets-left pill matches on both", h.pill === g.pill, h.pill);
    const guestId = await idOf(guest);
    step(
      "guest claims granted",
      g.score === 2 * SCORE_PELLET &&
        g.inFlight === 0 &&
        (await ownerOf(host, "2,1")) === guestId &&
        h.claimed === 2,
      `score ${g.score}, host sees ${h.claimed} claimed`,
    );

    // Same cells, same instant: each resolves to exactly one eater on both screens.
    await contest({ guest, host, step });

    // Escape on the host freezes only the host's pac: the guest keeps eating,
    // and its claims need no host to be granted.
    await host.keyboard.press("Escape");
    await waitFor(host, () => window.__pacman.game.paused, "host paused");
    const { t: gt } = await snapshot(guest);
    await chompFrom(guest, 3, 1);
    await eaten(guest, "4,1");
    await waitFor(
      guest,
      async () => {
        const { pelletClaimKey } = await import("/src/net/pellet-claims.ts");
        const { game } = window.__pacman;
        return game.net.claims[pelletClaimKey(game.boardRound, "4,1")]?.owner === game.net.playerId;
      },
      "claim granted while the host is paused",
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
    const resumed = await snapshot(host);
    step("resumed host catches up", resumed.left === g.left, `${g.left} left`);
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
    await host.evaluate(async () => {
      const { PELLET_CELLS } = await import("/src/net/pellet-claims.ts");
      const { game } = window.__pacman;
      for (const cell of PELLET_CELLS) {
        if (game.appliedEaten.has(cell)) {
          continue;
        }
        const [x, z] = cell.split(",").map(Number);
        Object.assign(game.pac, { isMoving: false, target: { x, z }, x, z });
        game.collectPellet();
      }
    });
    await waitFor(host, () => window.__pacman.game.phase === "win", "host win");
    await waitFor(guest, () => window.__pacman.game.phase === "win", "guest win");
    step("shared maze empties into a win on both", true);
    await guest.keyboard.press("r");
    await wait(400);
    const waiting = await snapshot(guest);
    step("guest R waits for the host", waiting.phase === "win");
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

    // Host leaves: the guest is promoted and keeps playing; a late joiner
    // reads the same board from the claims.
    await handOver({ browser, errors, fullMaze, guest, host, step, url });

    await soloGuestRestart({
      browser,
      errors,
      fullMaze,
      step,
      url: `${dev.base}/?room=${room}-solo`,
    });

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
