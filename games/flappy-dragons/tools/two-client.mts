import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { flagValue, poll, reachable, startVite } from "@repo/smoke";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";

const gameDir = path.resolve(import.meta.dirname, "..");

const PARTY = "http://localhost:8787";
const DEV_PORT = 5308;

const waitFor = async <T,>(read: () => Promise<T>, label: string, timeoutMs = 8000) => {
  let last: T | null = null;
  const found = await poll(
    async () => {
      last = await read();

      return last;
    },
    (value) => Boolean(value),
    { intervalMs: 100, timeoutMs },
  );

  if (found === null) {
    throw new Error(`timeout: ${label} (last=${JSON.stringify(last)})`);
  }

  return found;
};

const snapshot = (page: Page) =>
  page.evaluate(() => {
    const fb = window.__fb;

    if (fb === undefined) {
      throw new Error("window.__fb is missing: run the game in dev mode");
    }

    const { scene, net } = fb;
    const server = net.serverNow(performance.now());

    return {
      away: [...scene.ghosts.values()].filter((ghost) => ghost.away).length,
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

interface Snapshot {
  clock: number | null;
}

const oneClock = (a: Snapshot, b: Snapshot) =>
  [
    a.clock !== null && b.clock !== null && Math.abs(a.clock - b.clock) < 60,
    `server − wall: ${a.clock?.toFixed(1)} vs ${b.clock?.toFixed(1)} ms`,
  ] as const;

const fbOf = (page: Page) =>
  page.evaluate(() => {
    const fb = window.__fb;

    return fb === undefined
      ? null
      : {
          countingDown: fb.scene.countingDown,
          isHost: fb.net.isHost,
          other: fb.net.otherPlayer()?.state?.live ?? null,
          paused: fb.scene.presentationPaused,
          phase: fb.scene.phase,
          rivals: fb.scene.rivalIds.length,
          seed: fb.scene.seed,
          seesOther: fb.net.otherPlayer() !== null,
          started: fb.scene.started,
          status: fb.net.connectionStatus,
        };
  });

type Fb = NonNullable<Awaited<ReturnType<typeof fbOf>>>;

const until = (page: Page, test: (fb: Fb) => boolean, label: string, timeoutMs = 8000) =>
  waitFor(
    async () => {
      const fb = await fbOf(page);

      return fb !== null && test(fb);
    },
    label,
    timeoutMs,
  );

const phaseOf = async (page: Page) => (await fbOf(page))?.phase ?? null;

const startFlying = async (page: Page) => {
  await page.keyboard.press("Enter");
  await until(page, (fb) => fb.started && !fb.countingDown,
    "countdown",
  );
  await page.keyboard.press("Space");
  await until(page, (fb) => fb.phase === "playing", "playing");
};

const crashOf = async (page: Page, label: string) => {
  const crashed = await poll(
    async () => {
      const current = await phaseOf(page);

      if (current === "ready") {
        await page.keyboard.press("Space");
      }

      return current;
    },
    (current) => current === "gameover",
    { intervalMs: 100, timeoutMs: 8000 },
  );

  if (crashed === null) {
    throw new Error(`timeout: ${label}`);
  }
};

const blip = async (page: Page, watcher: Page) => {
  await page.evaluate(() => window.__fb?.net.client.dropConnection(4000));
  await until(page, (fb) => fb.status === "reconnecting", "blip drops");
  await waitFor(
    () =>
      watcher.evaluate(
        () =>
          document.querySelector("#board .row.away")?.textContent.includes("reconnecting") === true,
      ),
    "blip shows on the board",
  );
  const away = await snapshot(watcher);
  await page.evaluate(() => window.__fb?.net.client.redial());
  await until(page, (fb) => fb.status === "connected", "blip redials");
  await waitFor(
    () => watcher.evaluate(() => document.querySelector("#board .row.away") === null),
    "blip back on the board",
  );

  return { away, back: await snapshot(watcher) };
};

interface Race {
  rivals: number;
  ghosts: number;
  away: number;
}

const racesOne = (s: Race, away: number) => s.rivals === 1 && s.ghosts === 1 && s.away === away;

const respawnAndFly = async (page: Page, label: string) => {
  await until(page, (fb) => fb.phase === "ready", `${label} hover`, 3000);
  await page.keyboard.press("Space");
  await until(page, (fb) => fb.phase === "playing", `${label} flying`);
};

const worstScrollStep = (page: Page, ms: number) =>
  page.evaluate(
    (span) =>
      // oxlint-disable-next-line promise/avoid-new -- requestAnimationFrame has no promise form
      new Promise<number>((resolve, reject) => {
        const scene = window.__fb?.scene;

        if (scene === undefined) {
          reject(new Error("window.__fb is missing"));

          return;
        }

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

const openClient = async (browser: Browser, url: string, errors: string[]) => {
  const page = await browser.newPage({ viewport: { height: 600, width: 900 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.location().url.endsWith("/favicon.ico")) {
      errors.push(m.text());
    }
  });
  await page.goto(url);
  await until(page, (fb) => fb.status === "connected", "connected");

  return page;
};

const startDev = async () => {
  const base = `http://localhost:${DEV_PORT}`;
  const child = await startVite({ gameDir, port: DEV_PORT, timeoutMs: 20_000 });

  return { base, child };
};

const main = async () => {
  const urlFlag = flagValue("--url", process.argv);
  const dev = urlFlag === null ? await startDev() : { base: urlFlag, child: null };

  if (!(await reachable(PARTY))) {
    throw new Error(`party server not reachable at ${PARTY} (pnpm dev:party)`);
  }

  const room = `t${process.pid}-${Date.now().toString(36)}`;
  const url = `${dev.base}/?room=${room}`;
  const errors: Record<"guest" | "host" | "late", string[]> = { guest: [], host: [], late: [] };

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

  const results: string[] = [];

  const step = (name: string, ok: boolean, note = "") => {
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

    await crashOf(host, "host crash");
    await wait(400);
    await host.keyboard.press("Space");
    await until(host, (fb) => fb.seed !== 0 && fb.phase === "ready",
      "restart",
    );
    const { seed: rerolled } = await snapshot(host);
    step("solo restart rerolls the seed", rerolled !== h.seed, `${h.seed} → ${rerolled}`);
    await until(host, (fb) => !fb.countingDown, "countdown");
    await host.keyboard.press("Space");

    const guest = await openClient(browser, url, errors.guest);
    await until(guest, (fb) => fb.seesOther, "guest sees host");
    await until(host, (fb) => fb.seesOther, "host sees guest");
    await startFlying(guest);
    await until(guest, (fb) => fb.seed !== 0, "guest seed");
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
    const newest = shared.at(-1);
    if (newest === undefined) {
      throw new Error("no shared pipe");
    }

    const topOf = (page: Page) =>
      page.evaluate((i) => window.__fb?.scene.pipes.get(i)?.topHeight ?? null, newest);
    const hostTop = await topOf(host);
    const guestTop = await topOf(guest);
    step("same pipe geometry on both", hostTop === guestTop, `pipe ${newest} top ${hostTop}`);
    step("rival ghosts drawn on both", h.ghosts === 1 && g.ghosts === 1);

    await crashOf(host, "host crash");
    await until(guest, (fb) => fb.other === false,
      "guest sees crash",
    );
    step("crash reaches the other client", true);
    await respawnAndFly(host, "host respawn");
    await until(guest, (fb) => fb.other === true,
      "guest sees respawn",
    );
    step("host respawns into the race", true);
    await crashOf(guest, "guest crash");
    await respawnAndFly(guest, "guest respawn");
    step("guest respawns into the race", true);

    await guest.keyboard.press("Escape");
    await until(guest, (fb) => fb.paused, "guest paused");
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
    await until(guest, (fb) => !fb.paused, "guest resumed");
    await host.keyboard.press("Escape");
    await until(host, (fb) => fb.paused, "host paused");
    const { worldX: beforeG2 } = await snapshot(guest);
    await wait(600);
    const { worldX: afterG2 } = await snapshot(guest);
    step("host pause does not freeze the guest", afterG2 - beforeG2 > 40);
    await host.keyboard.press("Escape");
    await until(host, (fb) => !fb.paused, "host resumed");

    const { seed: seedBefore } = await snapshot(guest);
    await host.close();
    await until(guest, (fb) => fb.isHost, "guest promoted", 10_000);
    await until(guest, (fb) => fb.rivals === 0, "departed host gone");
    g = await snapshot(guest);
    step("guest promoted to host on host leave", g.host && g.ghosts === 0, JSON.stringify(g));
    step("promoted host keeps the seed", g.seed === seedBefore, `${g.seed}`);

    if (g.phase === "gameover") {
      await wait(400);
      await guest.keyboard.press("Space");
      await until(guest, (fb) => fb.phase === "ready" && !fb.countingDown,
        "solo restart",
      );
      await guest.keyboard.press("Space");
    } else if (g.phase === "ready") {
      await guest.keyboard.press("Space");
    }

    await until(guest, (fb) => fb.phase === "playing",
      "promoted host playable",
      4000,
    );
    const { seed: running } = await snapshot(guest);

    const late = await openClient(browser, url, errors.late);
    await until(late, (fb) => fb.seesOther, "late sees host");
    await until(late, (fb) => fb.seed !== 0, "late seed");
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
