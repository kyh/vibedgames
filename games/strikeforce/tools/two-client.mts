import path from "node:path";

import { flagValue, poll, reachable, startVite } from "@repo/smoke";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";

const gameDir = path.resolve(import.meta.dirname, "..");

const partyArg = flagValue("--party", process.argv) ?? "8787";
const PARTY = /^\d+$/u.test(partyArg) ? `http://localhost:${partyArg}` : partyArg;
const DEV_PORT = 5397;

const waitForArg = async <R, A>(
  page: Page,
  fn: Parameters<typeof page.evaluate<R, A>>[0],
  label: string,
  arg: A,
  timeoutMs = 60_000,
) => {
  let last: R | null = null;

  const found = await poll(
    async () => {
      last = await page.evaluate(fn, arg);

      return last;
    },
    (value) => Boolean(value),
    { intervalMs: 250, timeoutMs },
  );

  if (found === null) {
    throw new Error(`timeout: ${label} (last=${JSON.stringify(last)})`);
  }

  return found;
};

const waitFor = async <R,>(
  page: Page,
  fn: Parameters<typeof page.evaluate<R, null>>[0],
  label: string,
  timeoutMs = 60_000,
) => await waitForArg(page, fn, label, null, timeoutMs);

const startDev = async () => {
  const url = flagValue("--url", process.argv);

  if (url !== null) {
    return { base: url, stop: () => null };
  }

  const base = `http://localhost:${DEV_PORT}`;
  const vite = await startVite({ gameDir, port: DEV_PORT, timeoutMs: 30_000 });

  return { base, stop: () => vite.kill() };
};

const launch = async () =>
  await chromium.launch({
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
    ...(process.env.SMOKE_BROWSER === undefined || process.env.SMOKE_BROWSER === ""
      ? { channel: "chrome" }
      : { executablePath: process.env.SMOKE_BROWSER }),
    headless: true,
  });

const phase = async (page: Page, want: string, label: string, timeoutMs = 90_000) =>
  await waitForArg(
    page,
    (p) => window.__strikeforce?.match.state?.phase === p,
    label,
    want,
    timeoutMs,
  );

const probe = async (page: Page) =>
  await page.evaluate(() => {
    const G = window.__G;
    const m = window.__strikeforce?.match;

    if (G === undefined || m === undefined) {
      throw new Error("window.__G or window.__strikeforce is missing");
    }

    const s = m.state;
    const me = s?.roster.get(m.me);

    return {
      alive: G.player.alive,
      host: !m.guest,
      kills: me?.kills ?? -1,
      life: me?.life ?? -1,
      phase: s?.phase ?? "",
      pos: [G.player.pos.x, G.player.pos.z] as const,
    };
  });

const headshot = async (page: Page) =>
  await page.evaluate(() => {
    const G = window.__G;
    const m = window.__strikeforce?.match;

    if (G === undefined || m === undefined) {
      throw new Error("window.__G or window.__strikeforce is missing");
    }

    const eye = G.player.eye.clone();
    const [other] = m.enemies();

    if (!other) {
      return false;
    }

    const target = eye.clone().set(other.x, other.y + 1.62, other.z);
    const dir = target.sub(eye).normalize();

    return m.shoot(eye, dir, 500, 28) !== null;
  });

const main = async () => {
  if (!(await reachable(PARTY))) {
    throw new Error(`party server not reachable at ${PARTY} (pnpm dev:party)`);
  }

  const dev = await startDev();
  const room = `t${process.pid}${Date.now().toString(36)}`;
  const base = `${dev.base}/?q=low&autostart=1&noaudio=1&norender=1&bots=0&party=${encodeURIComponent(PARTY)}`;
  const url = `${base}&room=${room}&mode=deathmatch`;
  const browsers: Browser[] = [];
  const results: string[] = [];
  const errors: string[] = [];

  const step = (name: string, ok: boolean, note = "") => {
    results.push(`${ok ? "pass" : "FAIL"}  ${name}${note ? ` — ${note}` : ""}`);

    if (!ok) {
      throw new Error(`${name}: ${note}`);
    }
  };

  const open = async (label: string) => {
    const browser = await launch();
    browsers.push(browser);
    const page = await browser.newPage({ viewport: { height: 270, width: 480 } });
    page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(`${label}: ${msg.text().slice(0, 240)}`);
      }
    });
    await page.goto(url, { timeout: 180_000, waitUntil: "commit" });
    await waitFor(page, () => window.__ready === true, `${label} boot`, 180_000);

    return page;
  };

  try {
    const host = await open("host");
    await phase(host, "warmup", "host warmup");
    step("host alone sits in warmup", true);

    const guest = await open("guest");
    await phase(host, "live", "match live");
    await phase(guest, "live", "match live (guest)");
    step("a second player starts the match", true);
    const seesEnemy = () => (window.__strikeforce?.match.enemies().length ?? 0) > 0;
    await waitFor(guest, seesEnemy, "guest sees host");
    await waitFor(host, seesEnemy, "host sees guest");
    step("each sees the other's avatar", true);

    const before = await probe(host);
    step("guest's shot meets the host's head hitbox", await headshot(guest));
    await waitFor(host, () => window.__G?.player.alive === false, "host down");
    await waitFor(
      guest,
      () => {
        const m = window.__strikeforce?.match;

        return m?.state?.roster.get(m.me)?.kills === 1;
      },
      "guest credited",
    );
    step("the kill is credited", true);
    await waitFor(host, () => window.__G?.player.alive === true, "host back", 30_000);
    const back = await probe(host);
    const moved = Math.hypot(back.pos[0] - before.pos[0], back.pos[1] - before.pos[1]);
    step(
      "the dead come back on a new life at an arena spawn",
      back.life === before.life + 1,
      `life ${before.life}→${back.life}, moved ${moved.toFixed(1)} m`,
    );

    const barrel = await guest.evaluate(
      () => window.__G?.explosives.aliveMask().indexOf("1") ?? -1,
    );

    await guest.evaluate((i) => window.__strikeforce?.match.barrelHit(i, 999, null, null), barrel);
    const blown = (i: number) => window.__G?.explosives.aliveMask()[i] === "0";
    await waitForArg(host, blown, "host barrel blew", barrel);
    await waitForArg(guest, blown, "guest barrel synced", barrel);
    step("guest barrel shot blows the host's barrel", true);

    await host.context().browser()?.close();
    await waitFor(
      guest,
      () => window.__strikeforce?.match.guest === false,
      "guest promoted",
      90_000,
    );
    const after = await probe(guest);
    step(
      "guest inherits the match",
      after.host && after.phase === "warmup" && after.kills === 1,
      `${after.phase}, ${after.kills} kills`,
    );
  } finally {
    console.log(results.join("\n"));

    if (errors.length > 0) {
      console.log(`\npage errors:\n${errors.slice(0, 20).join("\n")}`);
    }

    await Promise.all(browsers.map(async (b) => await b.close().catch(() => null)));
    dev.stop();
  }
};

await main();
