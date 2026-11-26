import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { flagValue, poll, repeat, startVite } from "@repo/smoke";
import { EVICTION_TIMEOUT_MS, RECONNECT_GRACE_MS } from "@vibedgames/multiplayer";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";

import type { GameScene } from "../src/scenes/game-scene.ts";

const gameDir = path.resolve(import.meta.dirname, "..");

const PORT = 5314;
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const roomCode = () =>
  Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(
    "",
  );

const errors: string[] = [];

interface Client {
  context: BrowserContext;
  name: string;
  page: Page;
}

const until = async (read: () => Promise<boolean>, label: string, timeout = 20_000) => {
  const found = await poll(read, (ok) => ok, { intervalMs: 100, timeoutMs: timeout });

  if (found === null) {
    throw new Error(`timeout: ${label}`);
  }
};

const lf = async (page: Page) => {
  const probe = await page.evaluate(() => window.__lf ?? null);

  if (probe === null) {
    throw new Error("window.__lf is missing: the run is not online");
  }

  return probe;
};

const hubReady = async (page: Page) => {
  await until(
    async () => await page.evaluate(() => document.querySelector("#lf-room-code") !== null),
    "hub ready",
    30_000,
  );
};

const inGame = async (page: Page, role: "host" | "guest") => {
  await until(
    async () =>
      await page.evaluate((want) => {
        const s = window.__lf;

        return s !== undefined && s.conn === "connected" && s.state === "active" && s.role === want;
      }, role),
    `in game as ${role}`,
    30_000,
  );
};

const seesPeer = async (page: Page, label: string) => {
  await until(
    async () => await page.evaluate(() => window.__lf?.players === 2 && window.__lf.rx !== null),
    label,
    20_000,
  );
};

const openClient = async (browser: Browser, base: string, name: string, url: string) => {
  const context = await browser.newContext({ viewport: { height: 720, width: 1280 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}\n${e.stack}`));
  page.on("console", (m) => {
    if (m.type() === "error") {
      errors.push(`${name}: ${m.text()}`);
    }
  });
  await page.goto(`${base}/${url}`, { timeout: 90_000 });
  await hubReady(page);

  return { context, name, page } satisfies Client;
};

const play = async (client: Client, role: "host" | "guest") => {
  await client.page.click(".lf-hub-go");
  await inGame(client.page, role);
};

const tap = async (page: Page, code: string) => {
  await page.keyboard.down(code);
  await wait(60);
  await page.keyboard.up(code);
};

const hold = async (page: Page, code: string, ms: number) => {
  await page.keyboard.down(code);
  await wait(ms);
  await page.keyboard.up(code);
};

const live = async (page: Page) =>
  await page.evaluate(() => window.__lf?.vs === null || window.__lf?.vs?.phase === "fighting");

const vsPhase = async (page: Page) => await page.evaluate(() => window.__lf?.vs?.phase ?? null);

const attackCrossesWire = async (guest: Client, host: Client) => {
  const hostState = await lf(host.page);
  const before = hostState.rSwing ?? 0;
  await until(async () => await live(host.page), "round live on the host");
  await until(async () => await live(guest.page), "round live on the guest");
  await tap(guest.page, "KeyJ");
  await until(
    async () => await host.page.evaluate((n) => (window.__lf?.rSwing ?? 0) > n, before),
    "guest attack reached host",
    8000,
  );
};

const moveCrossesWire = async (guest: Client, host: Client) => {
  const hostState = await lf(host.page);
  const before = hostState.rx;
  await hold(guest.page, "KeyD", 500);
  await until(
    async () => await host.page.evaluate((x) => window.__lf?.rx !== x, before),
    "guest movement reached host",
    8000,
  );
};

const killRun = async (page: Page) => {
  await page.evaluate(() => {
    window.__game?.scene.getScene<GameScene>("game").playerDie();
  });
};

const endMatch = async (page: Page) => {
  await page.evaluate(() => {
    const vs = window.__game?.scene.getScene<GameScene>("game").vs;

    if (vs?.phase === "fighting") {
      vs.damage("guest", 99);
    }
  });
};

const run = async (base: string, mode: string) => {
  const code = roomCode();
  const query = mode === "vs" ? `?party=${code}&mode=vs` : `?party=${code}`;

  const browser = await chromium.launch({
    args: [
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
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

    try {
      await body();
      results.push(`${mode} ${label}: pass (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (error) {
      results.push(`${mode} ${label}: FAIL ${String(error)}`);
      throw error;
    }
  };

  try {
    let host = await openClient(browser, base, "host", query);
    let guest = await openClient(browser, base, "guest", query);
    await step("join", async () => {
      await play(host, "host");
      await play(guest, "guest");
    });
    await step("both see each other", async () => {
      await seesPeer(host.page, "host sees guest");
      await seesPeer(guest.page, "guest sees host");
    });
    await step("first guest input is an attack and it lands", async () => {
      await attackCrossesWire(guest, host);
      await moveCrossesWire(guest, host);
    });

    if (mode === "vs") {
      await step("a real hit takes a heart", async () => {
        const hostHp = async () => (await lf(host.page)).vs?.hostHp ?? 0;
        const hp0 = await hostHp();

        const hop: (left: number) => Promise<boolean> = async (left) => {
          if (left === 0) {
            return false;
          }

          const s = await lf(host.page);

          if ((s.vs?.hostHp ?? 0) < hp0) {
            return true;
          }

          const gap = (s.rx ?? 0) - s.px;

          if (Math.abs(gap) > 18) {
            const dir = gap > 0 ? "KeyA" : "KeyD";
            await guest.page.keyboard.down(dir);
            await guest.page.keyboard.down("Space");
            await wait(450);
            await guest.page.keyboard.up("Space");
            await guest.page.keyboard.up(dir);
          } else {
            await tap(guest.page, gap > 0 ? "KeyA" : "KeyD");
            await tap(guest.page, "KeyJ");
          }

          await wait(120);

          return await hop(left - 1);
        };

        assert.ok(await hop(40), "guest never landed a hit");
      });
    }

    await step(
      mode === "vs" ? "pause n/a: Escape exits the duel" : "host pause does not freeze the guest",
      async () => {
        if (mode === "vs") {
          return;
        }

        await host.page.keyboard.press("Escape");
        await until(
          async () => await host.page.evaluate(() => window.__lf?.paused === true),
          "host paused",
        );
        await moveCrossesWire(guest, host);
        await host.page.keyboard.press("Escape");
        await until(
          async () => await host.page.evaluate(() => window.__lf?.paused === false),
          "host resumed",
        );
      },
    );

    const rematch = async (page: Page) =>
      await page.evaluate(
        () => window.__lf?.vs?.round === 1 && window.__lf.vs.phase !== "matchEnd",
      );

    const restart = async (first: Client, second: Client) => {
      if (mode === "vs") {
        await until(async () => (await vsPhase(host.page)) === "fighting", "fighting");
        await until(
          async () => {
            if ((await vsPhase(host.page)) === "matchEnd") {
              return true;
            }

            await endMatch(host.page);

            return false;
          },
          "host match end",
          60_000,
        );
        await until(async () => (await vsPhase(guest.page)) === "matchEnd", "guest sees match end");
        await wait(1500);
        await tap(first.page, "KeyJ");
        await until(async () => await rematch(host.page), "rematch round 1");
        await until(async () => await rematch(guest.page), "guest sees rematch");

        return;
      }

      await killRun(host.page);
      await hubReady(host.page);
      await hubReady(guest.page);

      const receipts = await Promise.all(
        [first, second].map(async (c) => ({
          c,
          seen: (await c.page.$(".lf-hub-receipt")) !== null,
        })),
      );

      for (const { c, seen } of receipts) {
        assert.ok(seen, `${c.name} sees the run receipt`);
      }

      await play(first, "host");
      await play(second, "guest");
      await seesPeer(first.page, "restart: host sees guest");
      await seesPeer(second.page, "restart: guest sees host");
      [host, guest] = [first, second];
    };

    await step("restart from the guest", async () => {
      await restart(guest, host);
    });
    await step("restart from the host", async () => {
      await restart(host, guest);
    });
    await step("host leaves, guest is promoted and plays on", async () => {
      const before = await lf(guest.page);
      await host.context.close();
      await until(
        async () =>
          await guest.page.evaluate(
            () => window.__lf?.role === "host" && window.__lf.state === "active",
          ),
        "guest promoted",
        30_000,
      );
      const after = await lf(guest.page);

      if (mode !== "vs" && before.entities > 0) {
        assert.ok(after.entities > 0, "enemies survive the handoff");
      }

      const { swing } = after;
      await tap(guest.page, "KeyJ");
      await until(
        async () => await guest.page.evaluate((n) => (window.__lf?.swing ?? n) > n, swing),
        "promoted host attacks",
        8000,
      );
      host = guest;
    });
    await step("late join via the lobby room code", async () => {
      await until(
        async () =>
          await host.page.evaluate(() => {
            const session = window.__game?.scene.getScene<GameScene>("game").session;

            return session !== undefined && Object.keys(session.players).length === 1;
          }),
        "departed seat reaped",
        RECONNECT_GRACE_MS + EVICTION_TIMEOUT_MS,
      );
      const late = await openClient(browser, base, "late", "");
      await late.page.click(`.lf-hub-modes button:nth-of-type(${mode === "vs" ? 3 : 2})`);
      await late.page.fill("#lf-room-code", code);
      await late.page.press("#lf-room-code", "Enter");
      await until(
        async () =>
          await late.page.evaluate(() =>
            /Room selected/u.test(document.querySelector(".lf-hub-status")?.textContent ?? ""),
          ),
        "room selected",
      );
      const lateUrl = late.page.url();
      assert.ok(lateUrl.includes(`party=${code}`), "invite code in URL");
      await play(late, "guest");
      await seesPeer(late.page, "late sees host");
      await seesPeer(host.page, "host sees late");
      guest = late;
    });
    await step("third client is rejected from the full room", async () => {
      const extra = await openClient(browser, base, "extra", query);
      await extra.page.click(".lf-hub-go");
      await until(
        async () =>
          await extra.page.evaluate(() =>
            /Room full/u.test(document.querySelector(".lf-hub-status")?.textContent ?? ""),
          ),
        "room full notice",
        30_000,
      );
      const hostState = await lf(host.page);
      assert.equal(hostState.players, 2, "room still holds two");
      await extra.context.close();
    });
  } finally {
    console.log(results.join("\n"));

    if (errors.length > 0) {
      console.log(`console errors:\n${errors.join("\n")}`);
    }

    await browser.close();
  }
};

const modeFlag = flagValue("--mode", process.argv);
const urlFlag = flagValue("--url", process.argv);
const modes = modeFlag === null ? ["coop", "vs"] : [modeFlag];
const vite = urlFlag === null ? await startVite({ gameDir, port: PORT, timeoutMs: 60_000 }) : null;

try {
  await repeat(modes.length, async (i) => {
    await run(urlFlag ?? `http://localhost:${PORT}`, modes[i] ?? "coop");
  });

  if (errors.length > 0) {
    throw new Error(`console errors:\n${errors.join("\n")}`);
  }

  console.log("two-client: ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  vite?.kill();
  process.exit(process.exitCode ?? 0);
}
