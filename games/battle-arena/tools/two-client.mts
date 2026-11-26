import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { flagValue, poll, startVite } from "@repo/smoke";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";

interface Client {
  context: Awaited<ReturnType<Browser["newContext"]>>;
  name: string;
  page: Page;
}

const gameDir = path.resolve(import.meta.dirname, "..");
const urlArg = flagValue("--url");
const PORT = 5313;
const room = `tc${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const errors: string[] = [];

const openClient = async (
  browser: Browser,
  base: string,
  name: string,
  prepare?: (page: Page) => Promise<void>,
) => {
  const context = await browser.newContext({ viewport: { height: 540, width: 960 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") {
      errors.push(`${name}: ${m.text()}`);
    }
  });
  await prepare?.(page);
  await page.goto(`${base}/?online=1&room=${room}&name=${name}`);

  return { context, name, page } satisfies Client;
};

const diag = async (page: Page) => {
  const read = await page.evaluate(() => structuredClone(window.__GAME_DIAGNOSTICS__) ?? null);

  if (read === null) {
    throw new Error("window.__GAME_DIAGNOSTICS__ is missing");
  }

  return read;
};

const onlineOf = async (page: Page) => {
  const { online } = await diag(page);

  if (online === null) {
    throw new Error("not online");
  }

  return online;
};

const until = async <T,>(read: () => Promise<T>, label: string, timeout = 20_000) => {
  const value = await poll(read, (v) => Boolean(v), { intervalMs: 100, timeoutMs: timeout });

  if (value === null) {
    throw new Error(`timeout: ${label}`);
  }

  return value;
};

const joined = (client: Client) =>
  until(
    () =>
      client.page.evaluate(() => {
        const d = window.__GAME_DIAGNOSTICS__;

        return d?.online?.connection === "connected" && d.player !== undefined
          ? d.online.playerId
          : null;
      }),
    `${client.name} joined`,
    45_000,
  );

const unitOf = (page: Page, id: string) =>
  page.evaluate((unitId) => {
    const u = window.__ba?.world.units.get(`h-${unitId}`);

    return u ? { alive: u.alive, hp: u.hp, x: u.x, y: u.y } : null;
  }, id);

const hasUnit = (page: Page, id: string) =>
  page.evaluate((unitId) => window.__ba?.world.units.has(`h-${unitId}`) === true, id);

const key = (page: Page, type: string, code: string, keyName = code) =>
  page.evaluate(
    (ev) =>
      window.dispatchEvent(
        new KeyboardEvent(ev.type, { bubbles: true, code: ev.code, key: ev.key }),
      ),
    { code, key: keyName, type },
  );

const gameTime = (page: Page) => page.evaluate(() => window.__ba?.world.gameTime ?? 0);
const isPaused = (page: Page) => page.evaluate(() => window.__ba?.controlsPaused ?? false);

const endMatch = async (page: Page) => {
  await page.evaluate(() => {
    const scene = window.__ba;

    if (scene === undefined) {
      return;
    }

    const w = scene.world;
    w.phase = "ended";
    w.winner = w.units.get(scene.localId)?.team ?? null;
  });
};

const rematchLabel = (page: Page) =>
  page.evaluate(() => {
    const b = document.querySelector<HTMLButtonElement>('#hud [data-act="again"]');

    return b ? { disabled: b.disabled, text: b.textContent } : null;
  });

const rematchReady = (page: Page) =>
  page.evaluate(
    () => document.querySelector('#hud [data-act="again"]')?.textContent === "START REMATCH",
  );

const movesOnKey = async (page: Page, id: string, sim = page) => {
  const before = await unitOf(sim, id);
  await key(page, "keydown", "KeyW", "w");
  await wait(700);
  await key(page, "keyup", "KeyW", "w");
  const after = await unitOf(sim, id);
  assert.ok(before && after, "unit present");
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) > 0.5, "moved on KeyW");
};

const dropTransport = (page: Page) =>
  page.evaluate(() => {
    window.__ba?.net?.dropConnection(4000);
  });
const restoreTransport = (page: Page) =>
  page.evaluate(() => {
    window.__ba?.net?.redial();
  });

const showsStatus = (page: Page, text: string, label: string) =>
  until(
    () => page.evaluate((expected) => window.__ba?.statusEl.textContent === expected, text),
    label,
    45_000,
  );

const matchGeneration = async (page: Page) => (await onlineOf(page)).matchGeneration;

const rematchStarted = (page: Page, previous: number | null) =>
  page.evaluate(
    (gen) =>
      window.__ba?.world.phase === "playing" &&
      window.__GAME_DIAGNOSTICS__?.online?.matchGeneration === (gen ?? 0) + 1,
    previous,
  );

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
    const host = await openClient(browser, base, "Host");
    const guest = await openClient(browser, base, "Guest");
    let hostId = "";
    let guestId = "";
    await step("join", async () => {
      [hostId, guestId] = await Promise.all([joined(host), joined(guest)]);
      assert.equal((await onlineOf(host.page)).authority, true, "first player hosts");
    });
    await step("both see each other", async () => {
      await until(() => hasUnit(host.page, guestId), "host sees guest");
      await until(() => hasUnit(guest.page, hostId), "guest sees host");
      assert.ok(await unitOf(host.page, guestId));
      assert.ok(await unitOf(guest.page, hostId));
    });
    await step("guest input crosses the wire", async () => {
      const jumped = (page: Page) =>
        page.evaluate(
          (id) => (window.__ba?.world.units.get(`h-${id}`)?.jumpUntil ?? 0) > 0,
          guestId,
        );
      await wait(1500);
      await movesOnKey(guest.page, guestId, host.page);
      await key(guest.page, "keydown", "Space", " ");
      await key(guest.page, "keyup", "Space", " ");
      await until(() => jumped(host.page), "guest jump reached host");
      await until(() => jumped(guest.page), "jump echoed to guest");
    });
    await step("host pause does not freeze the guest", async () => {
      await key(host.page, "keydown", "Escape", "Escape");
      await until(() => isPaused(host.page), "host paused");
      const t0 = await gameTime(guest.page);
      await wait(1000);
      assert.ok((await gameTime(guest.page)) - t0 > 0.5, "guest clock advances while host pauses");
      await key(host.page, "keydown", "Escape", "Escape");
      await until(async () => !(await isPaused(host.page)), "host resumed");
      assert.equal(await isPaused(host.page), false);
    });
    await step("a guest's own drop reads Reconnecting…, then it plays on", async () => {
      await dropTransport(guest.page);
      await showsStatus(guest.page, "Reconnecting…", "guest shows its own drop");
      await until(
        () =>
          host.page.evaluate((id) => window.__ba?.net?.players[id]?.connected === false, guestId),
        "host holds the guest's seat",
      );
      await restoreTransport(guest.page);
      await until(
        () =>
          guest.page.evaluate(
            () => window.__GAME_DIAGNOSTICS__?.online?.connection === "connected",
          ),
        "guest back in the room",
      );
      await showsStatus(guest.page, "", "guest back in the match");
      await movesOnKey(guest.page, guestId, host.page);
    });
    await step("a host's own drop: the guest waits, the host keeps the role", async () => {
      await dropTransport(host.page);
      await showsStatus(host.page, "Reconnecting…", "host shows its own drop");
      await showsStatus(guest.page, "Host reconnecting…", "guest waits for the host");
      await restoreTransport(host.page);
      await until(
        () =>
          host.page.evaluate((id) => {
            const d = window.__GAME_DIAGNOSTICS__?.online;

            return d?.authority === true && d.hostId === id && d.takeover === "own";
          }, hostId),
        "host carries the match on from its own world",
      );
      await showsStatus(guest.page, "", "guest plays on");
      await movesOnKey(guest.page, guestId, host.page);
    });
    await step("rematch from the host", async () => {
      await endMatch(host.page);
      await until(
        () => guest.page.evaluate(() => window.__ba?.world.phase === "ended"),
        "guest sees the result",
      );
      assert.deepEqual(await rematchLabel(guest.page), {
        disabled: true,
        text: "WAITING FOR HOST",
      });
      await until(() => rematchReady(host.page), "host may rematch");
      const gen = await matchGeneration(guest.page);
      await host.page.click('#hud [data-act="again"]');
      await until(() => rematchStarted(guest.page, gen), "guest joins the rematch");
      assert.ok(await unitOf(guest.page, guestId), "guest keeps a seat");
    });
    await step("host leaves, guest is promoted and plays on", async () => {
      await host.context.close();
      await until(
        () =>
          guest.page.evaluate((id) => {
            const online = window.__GAME_DIAGNOSTICS__?.online;

            return online?.hostId === id && online.authority;
          }, guestId),
        "guest promoted within seconds",
        10_000,
      );
      await until(
        async () => !(await hasUnit(guest.page, hostId)),
        "departed host removed",
        10_000,
      );
      const t0 = await gameTime(guest.page);
      await wait(1000);
      assert.ok((await gameTime(guest.page)) - t0 > 0.5, "promoted guest simulates");
      await movesOnKey(guest.page, guestId);
    });
    await step("rematch from the promoted guest", async () => {
      const gen = await matchGeneration(guest.page);
      await endMatch(guest.page);
      await until(() => rematchReady(guest.page), "promoted guest may rematch");
      await guest.page.click('#hud [data-act="again"]');
      await until(() => rematchStarted(guest.page, gen), "rematch started");
    });
    await step("late join into the running match", async () => {
      await wait(2000);
      const late = await openClient(browser, base, "Late");
      const lateId = await joined(late);
      await until(() => hasUnit(late.page, guestId), "late sees the host");
      await until(() => hasUnit(guest.page, lateId), "host sees late");
      assert.ok((await gameTime(late.page)) > 1, "late joiner lands in a live clock");
      await late.context.close();
    });
    await step("no room admits: Connecting…, then a match vs bots, offline", async () => {
      const lone = await openClient(browser, base, "Lone", (page) =>
        page.routeWebSocket(/\/parties\//u, async (ws) => {
          await ws.close({ code: 1011 });
        }),
      );

      await showsStatus(lone.page, "Connecting…", "no room yet");
      await until(
        () =>
          lone.page.evaluate(() => {
            const d = window.__GAME_DIAGNOSTICS__;

            return (
              d?.online?.connection === "offline" && d.online.authority && d.player !== undefined
            );
          }),
        "hosts its own room of one",
        60_000,
      );
      await until(
        () =>
          lone.page.evaluate(
            () =>
              document.querySelector("#ba-toasts")?.textContent.includes("SERVER UNREACHABLE") ===
              true,
          ),
        "says why",
      );

      const heroes = await lone.page.evaluate(
        () =>
          [...(window.__ba?.world.units.values() ?? [])].filter((u) => u.kind === "hero").length,
      );

      assert.equal(heroes, 4, "bots fill the arena");
      await movesOnKey(lone.page, "solo");
      await key(lone.page, "keydown", "Escape", "Escape");
      await until(() => isPaused(lone.page), "paused");
      const t0 = await gameTime(lone.page);
      await wait(1000);
      assert.equal(await gameTime(lone.page), t0, "frozen while paused");
      await key(lone.page, "keydown", "Escape", "Escape");
      await until(async () => !(await isPaused(lone.page)), "resumed");
      await lone.context.close();
    });
  } finally {
    console.log(results.join("\n"));
    await browser.close();
  }

  if (errors.length > 0) {
    throw new Error(`console errors:\n${errors.join("\n")}`);
  }
};

const vite = urlArg === null ? await startVite({ gameDir, port: PORT }) : null;

try {
  await run(urlArg ?? `http://localhost:${PORT}`);
  console.log("two-client: ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  vite?.kill();
  process.exit(process.exitCode ?? 0);
}
