import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { flagValue, poll, startVite } from "@repo/smoke";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";

const gameDir = path.resolve(import.meta.dirname, "..");
const PORT = 5396;
const room = `tc${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const errors: string[] = [];

interface Client {
  context: BrowserContext;
  name: string;
  page: Page;
}

const openClient = async (browser: Browser, base: string, name: string, kit = "dusty") => {
  const context = await browser.newContext({ viewport: { height: 360, width: 640 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => {
    console.error(`[${name}] pageerror: ${e.message}`);
    errors.push(`${name}: ${e.message}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) {
      console.error(`[${name}] console.error: ${m.text()}`);
      errors.push(`${name}: ${m.text()}`);
    }
  });
  await page.goto(`${base}/?online=1&room=${room}&name=${name}&auto=${kit}&q=low`, {
    timeout: 180_000,
    waitUntil: "domcontentloaded",
  });

  return { context, name, page } satisfies Client;
};

const status = async (page: Page) =>
  await page.evaluate(() => {
    const g = window.__game;

    if (!g) {
      return {
        alive: 0,
        brawlers: 0,
        generation: 0,
        isHost: false,
        mode: "boot",
        playerCount: 0,
        playerId: null,
        seated: false,
        seq: 0,
        state: "boot",
        status: "none",
      };
    }

    const s = g.session;

    const net = s
      ? {
          isHost: s.isHost,
          playerCount: s.playerCount,
          playerId: s.playerId,
          seq: s.seq,
          status: s.status,
        }
      : { isHost: false, playerCount: 0, playerId: null, seq: 0, status: "none" };

    return {
      ...net,
      alive: g.brawlers.filter((b) => b.alive).length,
      brawlers: g.brawlers.length,
      generation: g.generation,
      mode: g.mode,
      seated: g.player !== null,
      state: g.state,
    };
  });

const untilArg = async <R, A>(
  page: Page,
  predicate: Parameters<typeof page.evaluate<R, A>>[0],
  label: string,
  timeout: number,
  arg: A,
) => {
  const found = await poll(async () => await page.evaluate(predicate, arg), Boolean, {
    intervalMs: 150,
    timeoutMs: timeout,
  });

  if (found === null) {
    throw new Error(`timeout: ${label} — ${JSON.stringify(await status(page))}`);
  }

  return found;
};

const until = async <R,>(
  page: Page,
  predicate: Parameters<typeof page.evaluate<R, null>>[0],
  label: string,
  timeout = 30_000,
) => await untilArg(page, predicate, label, timeout, null);

const connectedAs = async (client: Client, mode: "host" | "guest") =>
  await untilArg(
    client.page,
    (want) => {
      const g = window.__game;

      if (g === undefined) {
        throw new Error("window.__game is missing");
      }

      return g?.mode === want && g.session?.status === "connected" && g.state !== "menu"
        ? g.session.playerId
        : null;
    },
    `${client.name} connected as ${mode}`,
    150_000,
    mode,
  );

const brawlerOf = async (page: Page, playerId: string) =>
  await page.evaluate((id) => {
    const b = window.__game?.brawlers.find((other) => other.netId === `p:${id}`);

    return b ? { alive: b.alive, ammo: b.ammo, owner: b.owner, x: b.x, z: b.z } : null;
  }, playerId);

const facesAim = async (client: Client, playerId: string, angle: number) =>
  await untilArg(
    client.page,
    ({ id, aim }) => {
      const b = window.__game?.brawlers.find((other) => other.netId === `p:${id}`);

      if (!b) {
        return false;
      }

      const error = (value: number) =>
        Math.abs(Math.atan2(Math.sin(value - aim), Math.cos(value - aim)));

      return (
        error(b.facing) < 0.12 &&
        (b.drive === "puppet" || (b.lookAngle !== null && error(b.lookAngle) < 0.12))
      );
    },
    `${client.name} observes authoritative aim facing`,
    20_000,
    { aim: angle, id: playerId },
  );

const endBrawl = async (page: Page) => {
  await page.evaluate(() => {
    const g = window.__game;

    if (g === undefined) {
      throw new Error("window.__game is missing");
    }

    for (const b of g.brawlers) {
      if (b !== g.player) {
        b.die(null);
      }
    }
  });
};

const restartFrom = async (authority: Client, watchers: Client[]) => {
  const before = await status(authority.page);
  await endBrawl(authority.page);
  await until(authority.page, () => window.__game?.state === "ended", "brawl ended");
  await until(
    authority.page,
    () => {
      const again = document.querySelector("#again");

      return (
        again instanceof HTMLElement &&
        again.hidden === false &&
        document.querySelector("#result.open") !== null
      );
    },
    "result screen offers PLAY AGAIN",
  );
  await authority.page.click("#again");

  await Promise.all(
    [authority, ...watchers].map(
      async (client) =>
        await untilArg(
          client.page,
          (gen) =>
            window.__game !== undefined &&
            window.__game.generation > gen &&
            window.__game.state !== "ended",
          `${client.name} joins the next brawl`,
          45_000,
          before.generation,
        ),
    ),
  );
};

const run = async (base: string) => {
  const browser = await chromium.launch({
    args: [
      "--use-gl=angle",
      process.platform === "darwin" ? "--use-angle=metal" : "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--mute-audio",
    ],
    executablePath: process.env.SMOKE_BROWSER,
    headless: true,
  });

  const results: string[] = [];

  const step = async (label: string, body: () => Promise<void>) => {
    console.log(`two-client: ${label}`);
    const started = Date.now();
    await body();
    results.push(`${label}: pass (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  };

  try {
    const host = await openClient(browser, base, "Host");
    const hostId = await connectedAs(host, "host");
    await step("host joins and runs the brawl", async () => {
      const s = await status(host.page);
      assert.equal(s.isHost, true, "first player hosts");
      assert.equal(s.brawlers, 8, "host fields eight brawlers");
      assert.ok(s.seated, "host holds a seat");
    });
    await until(
      host.page,
      () => window.__game?.state === "playing",
      "host brawl under way",
      60_000,
    );
    const guest = await openClient(browser, base, "Guest", "titan");
    const guestId = await connectedAs(guest, "guest");
    await step("guest joins and mirrors the snapshot", async () => {
      await until(
        guest.page,
        () => window.__game?.brawlers.length === 8,
        "guest sees eight brawlers",
        45_000,
      );
      const first = await status(guest.page);
      await wait(2000);
      const later = await status(guest.page);
      assert.ok(later.seq > first.seq, `guest snapshots advance (${first.seq} → ${later.seq})`);

      const bytes = await guest.page.evaluate(() => {
        const shared = window.__game?.session?.client.sharedState;

        return {
          frame: JSON.stringify(shared?.f).length,
          fx: JSON.stringify(shared?.fx ?? []).length,
          roster: JSON.stringify(shared?.m).length,
        };
      });

      console.log(
        `two-client: wire frame ${bytes.frame} B + fx ${bytes.fx} B per tick; roster ${bytes.roster} B on change`,
      );
      await until(
        host.page,
        () => window.__game?.session?.playerCount === 2,
        "host counts two humans",
      );
    });
    await step("next brawl seats the guest", async () => {
      const s = await status(guest.page);

      if (!s.seated) {
        const spectating = await guest.page.evaluate(() => {
          const strip = document.querySelector("#spectate");

          return strip instanceof HTMLElement && strip.hidden === false;
        });

        assert.ok(spectating, "a mid-brawl arrival is told it is spectating");
      }

      await restartFrom(host, [guest]);
      await until(
        guest.page,
        () => window.__game?.player !== null && window.__game?.brawlers.length === 8,
        "guest is seated with eight brawlers",
        45_000,
      );
      const onHost = await brawlerOf(host.page, guestId);
      assert.ok(onHost, "host fields the guest's brawler");
      assert.equal(onHost.owner, guestId, "the guest owns its seat on the host");
      const hostNow = await status(host.page);
      assert.equal(hostNow.brawlers, 8, "host still fields eight");
    });
    await step("guest movement crosses the wire", async () => {
      await until(host.page, () => window.__game?.state === "playing", "countdown over", 30_000);
      const before = await brawlerOf(host.page, guestId);
      await guest.page.keyboard.down("KeyW");
      await wait(2500);
      await guest.page.keyboard.up("KeyW");
      await wait(500);
      const after = await brawlerOf(host.page, guestId);
      assert.ok(before && after, "guest brawler present on the host");
      const moved = Math.hypot(after.x - before.x, after.z - before.z);
      assert.ok(moved > 0.3, `guest brawler moved on the host's sim (${moved.toFixed(2)})`);
    });
    await step(
      "stationary and strafing guest aim reaches the host and a remote puppet",
      async () => {
        await host.page.evaluate((id) => {
          const g = window.__game;

          if (g === undefined) {
            throw new Error("window.__game is missing");
          }

          const b = g.brawlers.find((other) => other.netId === `p:${id}`);

          if (b === undefined || g.player === null) {
            throw new Error("the guest's brawler or the host's player is missing");
          }

          const point = g.world.nearestOpen(g.player.x + 2, g.player.z);
          b.root.position.set(point.x, g.world.heightAt(point.x, point.z), point.z);
          b.knock.set(0, 0);

          for (const other of g.brawlers) {
            if (other.owner === null) {
              other.freezeT = 120;
            }
          }
        }, guestId);
        const witness = await openClient(browser, base, "Witness");
        await connectedAs(witness, "guest");
        await guest.page.mouse.move(580, 180);

        const aim = await until(
          guest.page,
          () => {
            const b = window.__game?.player;

            return b !== null && b !== undefined && b.lookAngle !== null && b.lookAngle > 0.5
              ? { angle: b.lookAngle, x: b.x, z: b.z }
              : null;
          },
          "stationary guest turns toward the cursor without firing",
        );

        await facesAim(host, guestId, aim.angle);
        await facesAim(witness, guestId, aim.angle);
        const still = await brawlerOf(host.page, guestId);
        assert.ok(still, "the guest's brawler is on the host");
        assert.ok(
          Math.hypot(still.x - aim.x, still.z - aim.z) < 0.2,
          "aiming alone does not move the guest",
        );
        await witness.page.screenshot({ path: "/tmp/showdown-online-aim-puppet.png" });
        await guest.page.keyboard.down("KeyW");
        await wait(450);

        const strafe = await guest.page.evaluate(() => {
          const b = window.__game?.player;

          if (b === null || b === undefined) {
            throw new Error("the guest has no player");
          }

          return { angle: b.lookAngle, mx: b.moveX, mz: b.moveZ };
        });

        assert.equal(strafe.mz, -1, "guest is moving north");
        assert.ok(
          strafe.angle !== null && Math.abs(strafe.angle) < 2.4,
          "guest aims across its movement direction",
        );
        await facesAim(host, guestId, strafe.angle);
        await facesAim(witness, guestId, strafe.angle);
        await guest.page.keyboard.up("KeyW");
        await witness.context.close();
      },
    );
    await step("guest click fires on the host", async () => {
      await guest.page.mouse.move(480, 120);
      await guest.page.mouse.down();
      await wait(1500);
      await guest.page.mouse.up();
      await untilArg(
        host.page,
        (id) => {
          const g = window.__game;

          if (g === undefined) {
            throw new Error("window.__game is missing");
          }

          const b = g.brawlers.find((other) => other.netId === `p:${id}`);

          return (
            (b !== undefined && b.ammo < 3) ||
            g.combat.bullets.some((bullet) => bullet.owner.netId === `p:${id}`) ||
            g.combat.bombs.some((bomb) => bomb.owner.netId === `p:${id}`)
          );
        },
        "host fired the guest's shot",
        20_000,
        guestId,
      );
    });
    await step("grounded guest moves on the high terrace", async () => {
      const start = await host.page.evaluate((id) => {
        const g = window.__game;

        if (g === undefined) {
          throw new Error("window.__game is missing");
        }

        const b = g.brawlers.find((other) => other.netId === `p:${id}`);

        if (b?.alive !== true) {
          return null;
        }

        const first = g.world.toTile(18);
        const edge = g.world.toTile(20);

        for (let tz = first; tz < edge; tz += 1) {
          for (let tx = g.world.toTile(-17); tx < g.world.toTile(16); tx += 1) {
            if (![0, 1, 2].every((offset) => g.world.isWalkable(tx + offset, tz))) {
              continue;
            }

            const x = g.world.center(tx);
            const z = g.world.center(tz);
            b.root.position.set(x, g.world.heightAt(x, z), z);
            b.knock.set(0, 0);
            g.matchTime = 0;

            for (const other of g.brawlers) {
              if (other.owner === null) {
                other.freezeT = 120;
              }
            }

            return { x, z };
          }
        }

        return null;
      }, guestId);

      assert.ok(start, "a walkable highland lane exists");
      await untilArg(
        guest.page,
        (point) => {
          const b = window.__game?.player;

          return b && Math.hypot(b.x - point.x, b.z - point.z) < 0.2 && !b.netAir;
        },
        "guest receives grounded highland position",
        20_000,
        start,
      );
      await guest.page.keyboard.down("KeyD");
      await wait(900);
      await guest.page.keyboard.up("KeyD");

      const result = await guest.page.evaluate(() => {
        const g = window.__game;

        if (g === undefined) {
          throw new Error("window.__game is missing");
        }

        const b = g.player;

        if (b === null) {
          throw new Error("the guest has no player");
        }

        return { air: b.netAir, ground: g.world.heightAt(b.x, b.z), x: b.x, y: b.root.position.y };
      });

      assert.ok(result.x > start.x + 0.3, "prediction accepts movement on high ground");
      assert.equal(result.air, false, "height does not imply a leap");
      assert.ok(result.ground > 2, "the test runs on the high terrace");
      assert.ok(Math.abs(result.y - result.ground) < 0.001, "guest feet meet terrain");
    });

    const leapLanding = await host.page.evaluate((id) => {
      const g = window.__game;

      if (g === undefined) {
        throw new Error("window.__game is missing");
      }

      const b = g.brawlers.find((other) => other.netId === `p:${id}`);

      if (b?.alive !== true) {
        return null;
      }

      b.freezeT = 0;
      b.swing = null;
      b.burst = null;
      b.superCharge = 1;
      b.useSuper(0, -1, b.x, b.z - 5);
      b.update(0.3);
      b.freezeT = 120;

      return b.leap ? { x: b.leap.tx, z: b.leap.tz } : null;
    }, guestId);

    await step("guest receives a leap frozen midway through its arc", async () => {
      assert.ok(leapLanding, "Warden starts its leap");
      await until(
        guest.page,
        () => {
          const g = window.__game;

          if (g === undefined) {
            throw new Error("window.__game is missing");
          }

          const b = g.player;

          return b?.netAir === true && b.root.position.y > g.world.heightAt(b.x, b.z) + 1;
        },
        "guest receives airborne snapshot",
        20_000,
      );
    });
    await step("host leaves, guest is promoted and plays on", async () => {
      await host.context.close();
      await until(
        guest.page,
        () => window.__game?.mode === "host" && window.__game.session?.isHost === true,
        "guest promoted",
        30_000,
      );
      const s0 = await status(guest.page);
      assert.ok(s0.seated, "promoted guest keeps its seat");
      assert.equal(s0.brawlers, 8, "the roster survives the handoff");

      const roster = await guest.page.evaluate(() => {
        const g = window.__game;

        if (g === undefined) {
          throw new Error("window.__game is missing");
        }

        return {
          brawlers: g.brawlers.map((b) => [b.netId, b.owner, b.alive, b.drive] as const),
          generation: g.generation,
          picks: [...g.picks.keys()],
          players: Object.keys(g.session?.players ?? {}),
        };
      });

      const adopted = roster.brawlers.find(([netId]) => netId === `p:${hostId}`);
      assert.ok(
        adopted && adopted[1] === null,
        `the departed host's seat is now a bot: ${JSON.stringify({ hostId, ...roster })}`,
      );
      assert.ok(leapLanding, "Warden started its leap");
      await untilArg(
        guest.page,
        (landing) => {
          const g = window.__game;

          if (g === undefined) {
            throw new Error("window.__game is missing");
          }

          const b = g.player;

          return (
            b &&
            !b.airborne &&
            Math.hypot(b.x - landing.x, b.z - landing.z) < 0.5 &&
            Math.abs(b.root.position.y - g.world.heightAt(b.x, b.z)) < 0.001
          );
        },
        "promoted host completes the inherited leap on its original landing spot",
        20_000,
        leapLanding,
      );
      await wait(2000);
      const s1 = await status(guest.page);
      assert.ok(s1.seq > s0.seq, `promoted host keeps broadcasting (${s0.seq} → ${s1.seq})`);
      const before = await brawlerOf(guest.page, guestId);
      await guest.page.keyboard.down("KeyD");
      await wait(2500);
      await guest.page.keyboard.up("KeyD");
      const after = await brawlerOf(guest.page, guestId);
      assert.ok(before && after, "the promoted host's brawler is present");
      const moved = Math.hypot(after.x - before.x, after.z - before.z);
      assert.ok(moved > 0.3, `promoted host simulates its own body (${moved.toFixed(2)})`);
    });
    await step("late join spectates, then is seated by the next brawl", async () => {
      const late = await openClient(browser, base, "Late");
      const lateId = await connectedAs(late, "guest");
      await until(
        late.page,
        () => window.__game?.brawlers.length === 8,
        "late sees the roster",
        45_000,
      );
      const s = await status(late.page);
      assert.equal(s.seated, false, "late arrival has no seat mid-brawl");
      assert.ok(
        await late.page.evaluate(() => {
          const strip = document.querySelector("#spectate");

          return strip instanceof HTMLElement && strip.hidden === false;
        }),
        "late arrival sees the spectator strip",
      );
      await restartFrom(guest, [late]);
      await until(
        late.page,
        () => window.__game?.player !== null,
        "late arrival seated in the next brawl",
        45_000,
      );
      const onHost = await brawlerOf(guest.page, lateId);
      assert.ok(onHost && onHost.owner === lateId, "host fields the late arrival");
      await late.context.close();
    });
    await guest.context.close();
  } finally {
    console.log(results.join("\n"));
    await browser.close();
  }

  if (errors.length > 0) {
    throw new Error(`console errors:\n${errors.join("\n")}`);
  }
};

const urlFlag = flagValue("--url", process.argv);

const vite: ChildProcess | null =
  urlFlag === null ? await startVite({ gameDir, port: PORT, timeoutMs: 30_000 }) : null;

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
