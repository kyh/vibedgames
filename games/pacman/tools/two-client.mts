import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { flagValue, poll, reachable, startVite } from "@repo/smoke";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";

const gameDir = path.resolve(import.meta.dirname, "..");

const PARTY = "http://localhost:8787";
const DEV_PORT = 5309;
const SCORE_PELLET = 10;

const waitFor = async <T,>(read: () => Promise<T>, label: string, timeoutMs = 8000) => {
  let last: T | null = null;

  const found = await poll(
    async () => {
      last = await read();

      return last;
    },
    Boolean,
    { intervalMs: 100, timeoutMs },
  );

  if (found === null) {
    throw new Error(`timeout: ${label} (last=${JSON.stringify(last)})`);
  }

  return found;
};

const gameOf = async (page: Page) =>
  await page.evaluate(() => {
    const game = window.__pacman?.game;

    return game === undefined
      ? null
      : {
          paused: game.paused,
          phase: game.phase,
          rivals: game.rivalIds.length,
          round: game.boardRound,
        };
  });

type GameView = NonNullable<Awaited<ReturnType<typeof gameOf>>>;

const until = async (
  page: Page,
  test: (game: GameView) => boolean,
  label: string,
  timeoutMs = 8000,
) =>
  await waitFor(
    async () => {
      const game = await gameOf(page);

      return game !== null && test(game);
    },
    label,
    timeoutMs,
  );

const snapshot = async (page: Page) =>
  await page.evaluate(() => {
    const game = window.__pacman?.game;

    if (game === undefined) {
      throw new Error("window.__pacman is missing: run the game in dev mode");
    }

    return {
      applied: game.appliedEaten.size,
      boardRound: game.net.sharedState?.round ?? -1,
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

const chompFrom = async (page: Page, col: number, row: number) => {
  await page.evaluate(
    ([x, z]) => {
      const hooks = window.__pacman;

      if (hooks === undefined) {
        throw new Error("window.__pacman is missing");
      }

      Object.assign(hooks.game.pac, {
        dir: "right",
        isMoving: false,
        target: { x, z },
        x,
        z,
      });
      hooks.chomp();
    },
    [col, row] as const,
  );
};

const eaten = async (page: Page, key: string) =>
  await waitFor(
    async () => await page.evaluate((k) => window.__pacman?.game.appliedEaten.has(k) === true, key),
    `eaten ${key}`,
    4000,
  );

const ownerOf = async (page: Page, cell: string) =>
  await page.evaluate((c) => {
    const hooks = window.__pacman;

    if (hooks === undefined) {
      return null;
    }

    const { game } = hooks;

    const claim = hooks.claimKey(game.boardRound, c);

    return claim === null ? null : (game.net.claims[claim]?.owner ?? null);
  }, cell);

const idOf = async (page: Page) =>
  await page.evaluate(() => window.__pacman?.game.net.playerId ?? null);

const drawsRivalAt = async (page: Page, col: number, row: number) =>
  await waitFor(
    async () =>
      await page.evaluate(
        ([x, z]) => {
          const pacs = [...(window.__pacman?.game.remotePacs.pacs.values() ?? [])];
          const at = pacs[0]?.group.position;

          return (
            pacs.length === 1 &&
            at !== undefined &&
            Math.abs(at.x - x) < 0.01 &&
            Math.abs(at.z - z) < 0.01
          );
        },
        [col, row] as const,
      ),
    `rival drawn at ${col},${row}`,
    4000,
  );

const startPlaying = async (page: Page) => {
  await page.keyboard.press("Enter");
  await until(page, (game) => game.phase === "playing", "playing");
};

const hideScene = () => {
  let hooks: Window["__pacman"];
  Object.defineProperty(window, "__pacman", {
    configurable: true,
    get: () => hooks,
    set: (value: NonNullable<Window["__pacman"]>) => {
      hooks = value;
      value.game.scene.visible = false;
    },
  });
};

type Errors = Record<"guest" | "host" | "idle" | "late" | "solo", string[]>;

type Step = (name: string, ok: boolean, note?: string) => void;

interface Pair {
  guest: Page;
  host: Page;
  step: Step;
}

interface Room {
  browser: Browser;
  errors: Errors;
  fullMaze: number;
  step: Step;
  url: string;
}

const openClient = async (browser: Browser, url: string, errors: string[]) => {
  const page = await browser.newPage({ viewport: { height: 600, width: 900 } });

  if (process.env.SMOKE_NO_RENDER !== undefined && process.env.SMOKE_NO_RENDER !== "") {
    await page.addInitScript(hideScene);
  }

  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.location().url.endsWith("/favicon.ico")) {
      errors.push(m.text());
    }
  });
  await page.goto(url);
  await waitFor(
    async () =>
      await page.evaluate(() => window.__pacman?.game.net.connectionStatus === "connected"),
    "connected",
  );

  return page;
};

const startDev = async () => {
  const base = `http://localhost:${DEV_PORT}`;
  const child = await startVite({ gameDir, port: DEV_PORT, timeoutMs: 20_000 });

  return { base, child };
};

const contestOwners = async (page: Page) => [
  await ownerOf(page, "13,1"),
  await ownerOf(page, "14,1"),
];

const contest = async ({ guest, host, step }: Pair) => {
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

const handOver = async ({ browser, errors, fullMaze, guest, host, step, url }: Room & Pair) => {
  await chompFrom(host, 1, 1);
  await eaten(guest, "2,1");
  await host.close();
  await waitFor(
    async () => await guest.evaluate(() => window.__pacman?.game.net.isHost === true),
    "guest promoted",
    10_000,
  );
  await until(guest, (game) => game.rivals === 0, "held seat ignored");
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
  await until(late, (game) => game.rivals === 1, "late sees host");
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

const soloGuestRestart = async ({ browser, errors, fullMaze, step, url }: Room) => {
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
  await until(solo, (game) => game.round > roundBefore, "fresh maze granted");
  await until(solo, (game) => game.phase === "playing", "solo restarted");
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
  const urlFlag = flagValue("--url", process.argv);
  const dev = urlFlag === null ? await startDev() : { base: urlFlag, child: null };

  if (!(await reachable(PARTY))) {
    throw new Error(`party server not reachable at ${PARTY} (pnpm dev:party)`);
  }

  const room = `t${process.pid}-${Date.now().toString(36)}`;
  const url = `${dev.base}/?room=${room}`;
  const errors: Errors = { guest: [], host: [], idle: [], late: [], solo: [] };

  const browser = await chromium.launch({
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
    ...(process.env.SMOKE_BROWSER === undefined || process.env.SMOKE_BROWSER === ""
      ? { channel: "chrome" }
      : { executablePath: process.env.SMOKE_BROWSER }),
    headless: true,
  });

  const results: string[] = [];

  const step: Step = (name, ok, note = "") => {
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
    await until(guest, (game) => game.rivals === 1, "guest sees host");
    await wait(400);
    h = await snapshot(host);
    step("an idle guest is no rival", h.rivals === 0, JSON.stringify(h));
    await startPlaying(guest);
    await until(host, (game) => game.rivals === 1, "host sees guest");
    let g = await snapshot(guest);
    step(
      "both see each other",
      !g.host && g.rivals === 1 && g.left === fullMaze,
      JSON.stringify(g),
    );
    await drawsRivalAt(host, 1, 1);
    await drawsRivalAt(guest, 1, 1);
    step("each draws the other's pac at spawn", true);

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

    await contest({ guest, host, step });

    await host.keyboard.press("Escape");
    await until(host, (game) => game.paused, "host paused");
    const { t: gt } = await snapshot(guest);
    await chompFrom(guest, 3, 1);
    await eaten(guest, "4,1");
    await waitFor(
      async () =>
        await guest.evaluate(() => {
          const hooks = window.__pacman;

          if (hooks === undefined) {
            return false;
          }

          const { game } = hooks;

          const claim = hooks.claimKey(game.boardRound, "4,1");

          return claim !== null && game.net.claims[claim]?.owner === game.net.playerId;
        }),
      "claim granted while the host is paused",
    );
    g = await snapshot(guest);
    step(
      "host pause does not freeze the guest",
      g.t > gt && !g.paused,
      `guest +${(g.t - gt).toFixed(2)}s`,
    );
    await host.keyboard.press("Escape");
    await until(host, (game) => !game.paused, "host resumed");
    await eaten(host, "4,1");
    const resumed = await snapshot(host);
    step("resumed host catches up", resumed.left === g.left, `${g.left} left`);
    await guest.keyboard.press("Escape");
    await until(guest, (game) => game.paused, "guest paused");
    await chompFrom(host, 5, 1);
    await eaten(host, "6,1");
    step("guest pause does not freeze the host", true);
    await guest.keyboard.press("Escape");
    await until(guest, (game) => !game.paused, "guest resumed");
    await eaten(guest, "6,1");

    await host.evaluate(() => {
      const hooks = window.__pacman;

      if (hooks === undefined) {
        throw new Error("window.__pacman is missing");
      }

      const { game } = hooks;

      for (const cell of hooks.cells) {
        if (game.appliedEaten.has(cell)) {
          continue;
        }

        const [x, z] = cell.split(",").map(Number);
        Object.assign(game.pac, { isMoving: false, target: { x, z }, x, z });
        game.collectPellet();
      }
    });
    await until(host, (game) => game.phase === "win", "host win");
    await until(guest, (game) => game.phase === "win", "guest win");
    step("shared maze empties into a win on both", true);
    await guest.keyboard.press("r");
    await wait(400);
    const waiting = await snapshot(guest);
    step("guest R waits for the host", waiting.phase === "win");
    await host.keyboard.press("r");
    await until(host, (game) => game.phase === "playing", "host rematch");
    await until(guest, (game) => game.phase === "playing", "guest rematch");
    h = await snapshot(host);
    g = await snapshot(guest);
    step(
      "rematch resets the shared maze on both",
      h.left === fullMaze && g.left === fullMaze && h.round === g.round && g.round > 0,
      `round ${g.round}`,
    );

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
