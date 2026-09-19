// Two-client online smoke: host + guest through join, seating, wire traffic,
// host handoff and a late join. Needs the party server on :8787
// (`cd apps/party && pnpm exec wrangler dev --port 8787 --local`) and Chrome.
// `node tools/two-client.mjs [--url http://localhost:PORT]` — without --url it
// launches its own vite. SMOKE_BROWSER=/path/to/chrome picks the browser.
// macOS uses hardware ANGLE; other hosts fall back to software WebGL, so waits
// are generous and motion assertions stay loose.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const gameDir = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(path.join(gameDir, "package.json"))("playwright-core");
const urlArg = process.argv.indexOf("--url");
const PORT = 5396;
const room = `tc${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const errors = [];

const reachable = async (url) => {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
};

const startVite = async () => {
  const child = spawn(
    path.join(gameDir, "node_modules/.bin/vite"),
    ["--port", String(PORT), "--strictPort"],
    { cwd: gameDir, stdio: "ignore" },
  );
  for (let i = 0; i < 300; i += 1) {
    if (await reachable(`http://localhost:${PORT}`)) {
      return child;
    }
    await wait(100);
  }
  child.kill();
  throw new Error(`vite did not come up on :${PORT}`);
};

const openClient = async (browser, base, name, kit = "dusty") => {
  // A small viewport keeps two software-rendered tabs from starving each other.
  const context = await browser.newContext({ viewport: { height: 360, width: 640 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => {
    console.error(`[${name}] pageerror: ${e.message}`);
    errors.push(`${name}: ${e.message}`);
  });
  page.on("console", (m) => {
    // Network-level resource failures (fonts behind a proxy) are the environment's.
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) {
      console.error(`[${name}] console.error: ${m.text()}`);
      errors.push(`${name}: ${m.text()}`);
    }
  });
  await page.goto(`${base}/?online=1&room=${room}&name=${name}&auto=${kit}&q=low`, {
    timeout: 180_000,
    waitUntil: "domcontentloaded",
  });
  return { context, name, page };
};

/** The net view of a client: mode, connection, seat and match clocks. */
const status = (page) =>
  page.evaluate(() => {
    const g = window.__game;
    if (!g) {
      return { mode: "boot" };
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

const until = async (page, predicate, label, timeout = 30_000, arg = null) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await page.evaluate(predicate, arg);
    if (value) {
      return value;
    }
    await wait(150);
  }
  throw new Error(`timeout: ${label} — ${JSON.stringify(await status(page))}`);
};

const connectedAs = (client, mode) =>
  until(
    client.page,
    (want) => {
      const g = window.__game;
      return g?.mode === want && g.session?.status === "connected" && g.state !== "menu"
        ? g.session.playerId
        : null;
    },
    `${client.name} connected as ${mode}`,
    150_000,
    mode,
  );

const brawlerOf = (page, playerId) =>
  page.evaluate((id) => {
    const b = window.__game.brawlers.find((other) => other.netId === `p:${id}`);
    return b ? { alive: b.alive, ammo: b.ammo, owner: b.owner, x: b.x, z: b.z } : null;
  }, playerId);

const facesAim = (client, playerId, angle) =>
  until(
    client.page,
    ({ id, aim }) => {
      const b = window.__game.brawlers.find((other) => other.netId === `p:${id}`);
      if (!b) {
        return false;
      }
      const error = (value) => Math.abs(Math.atan2(Math.sin(value - aim), Math.cos(value - aim)));
      return (
        error(b.facing) < 0.12 &&
        (b.drive === "puppet" || (b.lookAngle !== null && error(b.lookAngle) < 0.12))
      );
    },
    `${client.name} observes authoritative aim facing`,
    20_000,
    { aim: angle, id: playerId },
  );

/** Kill every other brawler on the authority so the brawl ends now. */
const endBrawl = (page) =>
  page.evaluate(() => {
    const g = window.__game;
    for (const b of g.brawlers) {
      if (b !== g.player) {
        b.die(null);
      }
    }
  });

const restartFrom = async (authority, watchers) => {
  const before = await status(authority.page);
  await endBrawl(authority.page);
  await until(authority.page, () => window.__game.state === "ended", "brawl ended");
  await until(
    authority.page,
    () => {
      const again = document.querySelector("#again");
      return again && !again.hidden && document.querySelector("#result.open");
    },
    "result screen offers PLAY AGAIN",
  );
  await authority.page.click("#again");
  for (const client of [authority, ...watchers]) {
    await until(
      client.page,
      (gen) => window.__game.generation > gen && window.__game.state !== "ended",
      `${client.name} joins the next brawl`,
      45_000,
      before.generation,
    );
  }
};

const run = async (base) => {
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
  const results = [];
  const step = async (label, body) => {
    console.log(`two-client: ${label}`);
    const started = Date.now();
    await body();
    results.push(`${label}: pass (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  };
  try {
    const host = await openClient(browser, base, "Host");
    let hostId;
    let guestId;
    await step("host joins and runs the brawl", async () => {
      hostId = await connectedAs(host, "host");
      const s = await status(host.page);
      assert.equal(s.isHost, true, "first player hosts");
      assert.equal(s.brawlers, 8, "host fields eight brawlers");
      assert.ok(s.seated, "host holds a seat");
    });
    // Let the host's first match warm its shaders before a second tab competes for the CPU.
    await until(host.page, () => window.__game.state === "playing", "host brawl under way", 60_000);
    const guest = await openClient(browser, base, "Guest", "titan");
    await step("guest joins and mirrors the snapshot", async () => {
      guestId = await connectedAs(guest, "guest");
      await until(
        guest.page,
        () => window.__game.brawlers.length === 8,
        "guest sees eight brawlers",
        45_000,
      );
      const first = await status(guest.page);
      await wait(2000);
      const later = await status(guest.page);
      assert.ok(later.seq > first.seq, `guest snapshots advance (${first.seq} → ${later.seq})`);
      await until(
        host.page,
        () => window.__game.session.playerCount === 2,
        "host counts two humans",
      );
    });
    await step("next brawl seats the guest", async () => {
      const s = await status(guest.page);
      if (!s.seated) {
        const spectating = await guest.page.evaluate(
          () => !document.querySelector("#spectate").hidden,
        );
        assert.ok(spectating, "a mid-brawl arrival is told it is spectating");
      }
      await restartFrom(host, [guest]);
      await until(
        guest.page,
        () => window.__game.player !== null && window.__game.brawlers.length === 8,
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
      await until(host.page, () => window.__game.state === "playing", "countdown over", 30_000);
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
          const b = g.brawlers.find((other) => other.netId === `p:${id}`);
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
            const b = window.__game.player;
            return b?.lookAngle !== null && b?.lookAngle > 0.5
              ? { angle: b.lookAngle, x: b.x, z: b.z }
              : null;
          },
          "stationary guest turns toward the cursor without firing",
        );
        await facesAim(host, guestId, aim.angle);
        await facesAim(witness, guestId, aim.angle);
        const still = await brawlerOf(host.page, guestId);
        assert.ok(
          Math.hypot(still.x - aim.x, still.z - aim.z) < 0.2,
          "aiming alone does not move the guest",
        );
        await witness.page.screenshot({ path: "/tmp/showdown-online-aim-puppet.png" });
        await guest.page.keyboard.down("KeyW");
        await wait(450);
        const strafe = await guest.page.evaluate(() => {
          const b = window.__game.player;
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
      // Hold the button across several frames: software rendering runs at a few fps.
      await guest.page.mouse.move(480, 120);
      await guest.page.mouse.down();
      await wait(1500);
      await guest.page.mouse.up();
      await until(
        host.page,
        (id) => {
          const g = window.__game;
          const b = g.brawlers.find((other) => other.netId === `p:${id}`);
          return (
            (b && b.ammo < 3) ||
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
        const b = g.brawlers.find((other) => other.netId === `p:${id}`);
        if (!b?.alive) {
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
      await until(
        guest.page,
        (point) => {
          const b = window.__game.player;
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
        const b = g.player;
        return { air: b.netAir, ground: g.world.heightAt(b.x, b.z), x: b.x, y: b.root.position.y };
      });
      assert.ok(result.x > start.x + 0.3, "prediction accepts movement on high ground");
      assert.equal(result.air, false, "height does not imply a leap");
      assert.ok(result.ground > 2, "the test runs on the high terrace");
      assert.ok(Math.abs(result.y - result.ground) < 0.001, "guest feet meet terrain");
    });
    let leapLanding;
    await step("guest receives a leap frozen midway through its arc", async () => {
      leapLanding = await host.page.evaluate((id) => {
        const g = window.__game;
        const b = g.brawlers.find((other) => other.netId === `p:${id}`);
        if (!b?.alive) {
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
      assert.ok(leapLanding, "Warden starts its leap");
      await until(
        guest.page,
        () => {
          const g = window.__game;
          const b = g.player;
          return b?.netAir && b.root.position.y > g.world.heightAt(b.x, b.z) + 1;
        },
        "guest receives airborne snapshot",
        20_000,
      );
    });
    await step("host leaves, guest is promoted and plays on", async () => {
      await host.context.close();
      await until(
        guest.page,
        () => window.__game.mode === "host" && window.__game.session.isHost,
        "guest promoted",
        30_000,
      );
      const s0 = await status(guest.page);
      assert.ok(s0.seated, "promoted guest keeps its seat");
      assert.equal(s0.brawlers, 8, "the roster survives the handoff");
      const roster = await guest.page.evaluate(() => ({
        brawlers: window.__game.brawlers.map((b) => [b.netId, b.owner, b.alive, b.drive]),
        generation: window.__game.generation,
        picks: [...window.__game.picks.keys()],
        players: Object.keys(window.__game.session.players),
      }));
      const adopted = roster.brawlers.find(([netId]) => netId === `p:${hostId}`);
      assert.ok(
        adopted && adopted[1] === null,
        `the departed host's seat is now a bot: ${JSON.stringify({ hostId, ...roster })}`,
      );
      await until(
        guest.page,
        (landing) => {
          const g = window.__game;
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
      const moved = Math.hypot(after.x - before.x, after.z - before.z);
      assert.ok(moved > 0.3, `promoted host simulates its own body (${moved.toFixed(2)})`);
    });
    await step("late join spectates, then is seated by the next brawl", async () => {
      const late = await openClient(browser, base, "Late");
      const lateId = await connectedAs(late, "guest");
      await until(
        late.page,
        () => window.__game.brawlers.length === 8,
        "late sees the roster",
        45_000,
      );
      const s = await status(late.page);
      assert.equal(s.seated, false, "late arrival has no seat mid-brawl");
      assert.ok(
        await late.page.evaluate(() => !document.querySelector("#spectate").hidden),
        "late arrival sees the spectator strip",
      );
      await restartFrom(guest, [late]);
      await until(
        late.page,
        () => window.__game.player !== null,
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
  if (errors.length) {
    throw new Error(`console errors:\n${errors.join("\n")}`);
  }
};

const vite = urlArg === -1 ? await startVite() : null;
try {
  await run(urlArg === -1 ? `http://localhost:${PORT}` : process.argv[urlArg + 1]);
  console.log("two-client: ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  vite?.kill();
  // A leaked dev-server handle would otherwise keep node alive past the last check.
  process.exit(process.exitCode ?? 0);
}
