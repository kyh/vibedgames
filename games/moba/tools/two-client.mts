import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { flagValue, poll, startVite } from "@repo/smoke";
import { EVICTION_TIMEOUT_MS, RECONNECT_GRACE_MS } from "@vibedgames/multiplayer";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";

import type { HudScene } from "../src/scenes/hud-scene.ts";

const gameDir = path.resolve(import.meta.dirname, "..");

const PORT = 5302;
const room = `tc${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const errors: string[] = [];

interface Client {
  context: BrowserContext;
  name: string;
  page: Page;
}

const openClient = async (
  browser: Browser,
  base: string,
  name: string,
  hero: string,
  prepare?: (page: Page) => Promise<void>,
) => {
  const context = await browser.newContext({ viewport: { height: 720, width: 1280 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.location().url.endsWith("/favicon.ico")) {
      errors.push(`${name}: ${m.text()}`);
    }
  });
  await prepare?.(page);
  await page.goto(`${base}/?auto=1&online=1&room=${room}&hero=${hero}`);

  return { context, name, page } satisfies Client;
};

const until = async <T,>(read: () => Promise<T>, label: string, timeout = 20_000) => {
  let last: T | null = null;

  const found = await poll(
    async () => {
      last = await read();

      return last;
    },
    (value) => Boolean(value),
    { intervalMs: 100, timeoutMs: timeout },
  );

  if (found === null) {
    throw new Error(`timeout: ${label} (last=${JSON.stringify(last)})`);
  }

  return found;
};

const online = async (page: Page) => {
  const o = await page.evaluate(() => window.__moba?.online() ?? null);

  if (o === null) {
    throw new Error("window.__moba is not online");
  }

  return o;
};

const joined = async (client: Client) =>
  await until(
    async () =>
      await client.page.evaluate(() => {
        const o = window.__moba?.online();

        return o?.status === "connected" && window.__moba?.player() ? o.id : null;
      }),
    `${client.name} joined`,
    45_000,
  );

const unitOf = async (page: Page, id: string) =>
  await page.evaluate((heroId) => {
    const u = window.__moba?.world.units.get(`h-${heroId}`);

    return u ? { alive: u.alive, hp: u.hp, q: u.hero?.abilities.Q, x: u.x, y: u.y } : null;
  }, id);

const seesUnit = async (page: Page, id: string, label: string) =>
  await until(
    async () =>
      await page.evaluate((heroId) => window.__moba?.world.units.has(`h-${heroId}`) === true, id),
    label,
  );

const key = async (page: Page, type: string, name: string, keyCode: number, extra = {}) =>
  await page.evaluate(
    (ev) =>
      window.dispatchEvent(
        new KeyboardEvent(ev.type, {
          bubbles: true,
          code: ev.key,
          key: ev.key,
          keyCode: ev.keyCode,
          ...ev.extra,
        }),
      ),
    { extra, key: name, keyCode, type },
  );

const blip = async (client: Client) => {
  await client.page.evaluate(() => window.__moba?.scene.net?.dropConnection(4000));
  await until(
    async () =>
      await client.page.evaluate(
        () => window.__moba?.scene.connectionNotice?.text === "RECONNECTING…",
      ),
    `${client.name} shows reconnecting`,
  );
};

const connected = async (page: Page) =>
  await page.evaluate(
    () => window.__moba?.online()?.status === "connected" && !window.__moba.scene.connectionNotice,
  );

const reconnect = async (client: Client) => {
  await client.page.evaluate(() => window.__moba?.scene.net?.redial());
  await until(async () => await connected(client.page), `${client.name} back, notice cleared`);
};

const gameTime = async (page: Page) =>
  await page.evaluate(() => window.__moba?.world.gameTime ?? 0);

const phase = async (page: Page) => await page.evaluate(() => window.__moba?.world.phase);

const isPaused = async (page: Page) =>
  await page.evaluate(() => window.__moba?.scene.controlsPaused);

const hasResult = async (page: Page) =>
  await page.evaluate(() => Boolean(window.__moba?.scene.matchResult));

const isHost = async (page: Page) =>
  await page.evaluate(() => window.__moba?.online()?.isHost === true);

const qOf = async (page: Page, id: string) =>
  await page.evaluate(
    (heroId) => window.__moba?.world.units.get(`h-${heroId}`)?.hero?.abilities.Q ?? null,
    id,
  );

const clockAdvances = async (page: Page, label: string) => {
  const t0 = await gameTime(page);
  await wait(3000);
  const t1 = await gameTime(page);
  assert.ok(t1 - t0 > 1.5, label);
};

const movesOnArrow = async (
  page: Page,
  id: string,
  sim = page,
  [arrow, keyCode]: readonly [string, number] = ["ArrowRight", 39],
) => {
  const before = await unitOf(sim, id);
  await key(page, "keydown", arrow, keyCode);
  await wait(700);
  await key(page, "keyup", arrow, keyCode);
  const after = await unitOf(sim, id);
  assert.ok(before && after, "unit present");
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) > 0.5, `moved on ${arrow}`);
};

const pauseDoesNotFreeze = async (pauser: Client, other: Client) => {
  await key(pauser.page, "keydown", "Escape", 27);
  await until(async () => (await isPaused(pauser.page)) === true, `${pauser.name} paused`);
  await clockAdvances(other.page, `${other.name} clock runs while ${pauser.name} pauses`);
  await clockAdvances(pauser.page, `${pauser.name} keeps spectating while paused`);
  await key(pauser.page, "keydown", "Escape", 27);
  await until(async () => (await isPaused(pauser.page)) === false, `${pauser.name} resumed`);
  assert.equal(await isPaused(pauser.page), false);
};

const promoted = async (client: Client, follower: Client) => {
  await until(async () => await isHost(client.page), `${client.name} promoted`, 30_000);
  await clockAdvances(client.page, `${client.name} simulates`);
  const clientOnline = await online(client.page);
  await until(
    async () =>
      await follower.page.evaluate((id) => {
        const o = window.__moba?.online();

        return o?.status === "connected" && o.hostId === id && !o.isHost;
      }, clientOnline.id),
    `${follower.name} follows ${client.name}`,
    30_000,
  );
  await clockAdvances(follower.page, `${follower.name} renders the new host's clock`);
};

const resultButton = async (page: Page, action: string) =>
  await page.evaluate((wanted) => {
    const result = window.__moba?.scene.scene.get<HudScene>("Hud").result;
    const b = result?.buttons.find((button) => button.action === wanted);

    if (result === null || result === undefined || b === undefined) {
      return null;
    }

    const { root } = result;

    return { x: root.x + b.bg.x * root.scaleX, y: root.y + b.bg.y * root.scaleY };
  }, action);

const pressResult: (page: Page, action: string, attempts?: number) => Promise<void> = async (
  page,
  action,
  attempts = 5,
) => {
  if (attempts === 0) {
    return;
  }

  const at = await resultButton(page, action);

  if (!at) {
    return;
  }

  await page.mouse.click(at.x, at.y);
  await wait(400);
  await pressResult(page, action, attempts - 1);
};

const run = async (base: string) => {
  const browser = await chromium.launch({
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

  const results: string[] = [];

  const step = async (label: string, body: () => Promise<void>) => {
    const started = Date.now();
    await body();
    results.push(`${label}: pass (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  };

  try {
    const a = await openClient(browser, base, "A", "ironvow");
    const b = await openClient(browser, base, "B", "duskblade");
    const [aId, bId] = await Promise.all([joined(a), joined(b)]);
    await step("join", async () => {
      const [aOnline, bOnline] = await Promise.all([online(a.page), online(b.page)]);
      assert.equal(aOnline.isHost, true, "first player hosts");
      assert.equal(bOnline.isHost, false);
    });
    await step("both see each other", async () => {
      await seesUnit(a.page, bId, "host sees guest");
      await seesUnit(b.page, aId, "guest sees host");
      await seesUnit(b.page, bId, "guest sees itself");
    });
    await step("guest transport blip: input held while away, plays on after", async () => {
      await blip(b);
      const away = await unitOf(a.page, bId);
      await key(b.page, "keydown", "ArrowRight", 39);
      await wait(700);
      await key(b.page, "keyup", "ArrowRight", 39);
      const held = await unitOf(a.page, bId);
      assert.ok(held && away, "unit present");
      assert.ok(Math.hypot(held.x - away.x, held.y - away.y) < 0.5, "no input while reconnecting");
      await reconnect(b);
      await clockAdvances(b.page, "guest renders the host's clock again");
      await movesOnArrow(b.page, bId, a.page, ["ArrowLeft", 37]);
    });
    await step("host transport blip: the host keeps its seat and its match", async () => {
      await blip(a);
      const away = await gameTime(a.page);
      await reconnect(a);
      const back = await online(a.page);
      assert.equal(back.isHost, true, "a blip keeps the host role");
      await clockAdvances(b.page, "guest renders the host's clock again");
      assert.ok((await gameTime(a.page)) > away, "the match carried on rather than restarting");
    });
    await step("guest input crosses the wire", async () => {
      await movesOnArrow(b.page, bId, a.page);
      await key(b.page, "keydown", "Q", 81, { shiftKey: true });
      await key(b.page, "keyup", "Q", 81, { shiftKey: true });
      await until(
        async () => ((await qOf(a.page, bId))?.rank ?? 0) > 0,
        "guest level-up reached host",
        10_000,
      );
      await key(b.page, "keydown", "Q", 81);
      await key(b.page, "keyup", "Q", 81);
      await until(
        async () => ((await qOf(a.page, bId))?.readyAt ?? 0) > 0,
        "guest Q cast reached host",
        10_000,
      );
      await until(
        async () => ((await qOf(b.page, bId))?.readyAt ?? 0) > 0,
        "cast echoed to guest",
        10_000,
      );
    });
    await step("guest pause does not freeze the host", async () => {
      await pauseDoesNotFreeze(b, a);
    });
    await step("host pause does not freeze the guest", async () => {
      await pauseDoesNotFreeze(a, b);
    });
    await step("host transport drop: guest promoted, host reconnects as guest", async () => {
      await a.page.evaluate(() => window.__moba?.scene.net?.dropConnection(1000));
      await until(
        async () => await a.page.evaluate(() => window.__moba?.online()?.status !== "connected"),
        "host dropped",
      );
      await until(async () => await isHost(b.page), "guest promoted", 30_000);
      await a.page.evaluate(() => window.__moba?.scene.net?.redial());
      await promoted(b, a);
      const [ta, tb] = await Promise.all([gameTime(a.page), gameTime(b.page)]);
      assert.ok(
        Math.abs(ta - tb) < 1.5,
        `reconnected host adopted the live clock (${ta} vs ${tb})`,
      );
      await movesOnArrow(a.page, aId, b.page);
    });
    await step("host loop stall: other client takes over, stalled host follows", async () => {
      const hang = b.page.evaluate(() => {
        const end = performance.now() + 9000;
        let spins = 0;

        while (performance.now() < end) {
          spins += 1;
        }

        return spins;
      });

      try {
        await promoted(a, b);
      } finally {
        await hang;
      }

      const [ta, tb] = await Promise.all([gameTime(a.page), gameTime(b.page)]);
      assert.ok(Math.abs(ta - tb) < 1.5, `stalled host follows the live clock (${ta} vs ${tb})`);
    });
    await step("match end reaches both, rematch from the host", async () => {
      await a.page.evaluate(() => window.__moba?.kill("d-ancient"));
      await until(async () => await hasResult(a.page), "host sees the result");
      await until(async () => await hasResult(b.page), "guest sees the result");
      assert.equal(await resultButton(b.page, "again"), null, "guest cannot rematch");

      const again = await until(
        async () =>
          await a.page.evaluate(
            () =>
              window.__moba?.scene.scene
                .get<HudScene>("Hud")
                .result?.buttons.some((button) => button.action === "again") === true,
          ),
        "host may rematch",
      );

      assert.ok(again);
      await pressResult(a.page, "again");

      const rematched = async (page: Page) =>
        !(await hasResult(page)) && (await phase(page)) === "playing";

      await until(async () => await rematched(a.page), "host rematch started");
      await until(async () => await rematched(b.page), "guest joins the rematch");
      await seesUnit(b.page, bId, "guest keeps a seat");
      assert.ok((await gameTime(a.page)) < 30, "fresh clock");
    });
    const c = await openClient(browser, base, "C", "emberhex");
    const cId = await joined(c);
    await step("late join into the running match", async () => {
      await seesUnit(c.page, aId, "late sees the host");
      await seesUnit(a.page, cId, "host sees late");
      assert.ok((await gameTime(c.page)) > 1, "late joiner lands in a live clock");
      await clockAdvances(c.page, "late joiner clock runs");
    });
    await step("host leaves: a remaining player is promoted and plays on", async () => {
      await a.context.close();
      const bOnline = await online(b.page);
      const next = (bOnline.id ?? "") < cId ? b : c;
      const other = next === b ? c : b;
      await promoted(next, other);
      await until(
        async () =>
          await next.page.evaluate(
            (id) => window.__moba?.world.units.has(`h-${id}`) === false,
            aId,
          ),
        "departed host removed",
        RECONNECT_GRACE_MS + EVICTION_TIMEOUT_MS,
      );
      await movesOnArrow(next.page, next === b ? bId : cId);
      await movesOnArrow(other.page, other === b ? bId : cId, next.page);
      assert.equal(await phase(next.page), "playing");
      assert.equal(await hasResult(other.page), false);
    });
    await step("no room admits: PLAY ONLINE says so, then plays the bots", async () => {
      const d = await openClient(browser, base, "D", "ironvow", async (page) => {
        await page.routeWebSocket(/\/parties\//u, async (ws) => {
          await ws.close({ code: 1011 });
        });
      });

      await until(
        async () =>
          await d.page.evaluate(
            () => window.__moba?.scene.connectionNotice?.text === "CONNECTING…",
          ),
        "connecting notice",
        45_000,
      );
      await until(
        async () =>
          await d.page.evaluate(
            () =>
              window.__moba?.scene.isOnline() === false &&
              window.__moba.scene.scene
                .get<HudScene>("Hud")
                .banner.text.text.startsWith("SERVER UNREACHABLE"),
          ),
        "fell back to a bot match, and says so",
        60_000,
      );
      await movesOnArrow(d.page, "you");
      await d.context.close();
    });
    await c.context.close();
    await b.context.close();
  } finally {
    console.log(results.join("\n"));
    await browser.close();
  }

  if (errors.length > 0) {
    throw new Error(`console errors:\n${errors.join("\n")}`);
  }
};

const urlFlag = flagValue("--url", process.argv);
const vite = urlFlag === null ? await startVite({ gameDir, port: PORT, timeoutMs: 60_000 }) : null;

try {
  await run(urlFlag ?? `http://localhost:${PORT}`);
  console.log("two-client: ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  vite?.kill();
  process.exit(process.exitCode ?? 0);
}
