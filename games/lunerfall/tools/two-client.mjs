// Two-client online smoke for co-op AND versus: join, wire traffic, pause,
// restart/rematch from each side, host handoff, lobby room-code entry, a late
// join and room-full rejection. Needs the party server on :8787 and Chrome.
// `node tools/two-client.mjs [--url http://localhost:PORT] [--mode coop|vs]`
// — without --url it launches its own vite on :5314.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const gameDir = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(import.meta.url)("playwright-core");
const { EVICTION_TIMEOUT_MS, RECONNECT_GRACE_MS } = await import("@vibedgames/multiplayer");
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
};
const PORT = 5314;
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const roomCode = () =>
  Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(
    "",
  );
const errors = [];

const startVite = async () => {
  const child = spawn(
    path.resolve(gameDir, "node_modules/.bin/vite"),
    ["--port", String(PORT), "--strictPort"],
    {
      cwd: gameDir,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  // oxlint-disable-next-line promise/avoid-new -- bridges vite's stdout/exit events into one awaitable
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Local:")) {
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`vite exited ${code}`)));
  });
  return child;
};

const until = async (page, predicate, label, timeout = 20_000, param = null) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await page.evaluate(predicate, param);
    if (value) {
      return value;
    }
    await wait(100);
  }
  throw new Error(`timeout: ${label}`);
};

// oxlint-disable-next-line unicorn/prefer-structured-clone -- runs in the page: JSON drops the probe's non-serialisable fields that structuredClone would throw on
const lf = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__lf ?? null)));
const hubReady = (page) =>
  until(page, () => !!document.querySelector("#lf-room-code"), "hub ready", 30_000);
const inGame = (page, role) =>
  until(
    page,
    (want) => {
      const s = window.__lf;
      return s && s.conn === "connected" && s.state === "active" && s.role === want;
    },
    `in game as ${role}`,
    30_000,
    role,
  );
const seesPeer = (page, label) =>
  until(page, () => window.__lf?.players === 2 && window.__lf.rx !== null, label, 20_000);

const openClient = async (browser, base, name, url) => {
  const context = await browser.newContext({ viewport: { height: 720, width: 1280 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}\n${e.stack}`));
  page.on("console", (m) => {
    if (m.type() === "error") {
      errors.push(`${name}: ${m.text()}`);
    }
  });
  // The dev server transforms the whole game on a cold client; give it room.
  await page.goto(`${base}/${url}`, { timeout: 90_000 });
  await hubReady(page);
  return { context, name, page };
};

/** Hub → expedition: PLAY. Escape pause only arms through this path. */
const play = async (client, role) => {
  await client.page.click(".lf-hub-go");
  await inGame(client.page, role);
};

const tap = async (page, code) => {
  await page.keyboard.down(code);
  await wait(60);
  await page.keyboard.up(code);
};

const hold = async (page, code, ms) => {
  await page.keyboard.down(code);
  await wait(ms);
  await page.keyboard.up(code);
};

// Versus drops every input through the round countdown, and the guest
// mirrors that freeze from the broadcast phase — both must see it end.
const live = () => window.__lf?.vs === null || window.__lf?.vs?.phase === "fighting";

/** Guest presses attack; the host must register the swing on the remote body. */
const attackCrossesWire = async (guest, host) => {
  const hostState = await lf(host.page);
  const before = hostState.rSwing ?? 0;
  await until(host.page, live, "round live on the host");
  await until(guest.page, live, "round live on the guest");
  await tap(guest.page, "KeyJ");
  await until(
    host.page,
    (n) => (window.__lf?.rSwing ?? 0) > n,
    "guest attack reached host",
    8000,
    before,
  );
};

const moveCrossesWire = async (guest, host) => {
  const hostState = await lf(host.page);
  const before = hostState.rx;
  await hold(guest.page, "KeyD", 500);
  await until(host.page, (x) => window.__lf?.rx !== x, "guest movement reached host", 8000, before);
};

/** Host-side shortcut to a run end; the wire and both hubs do the rest. */
const killRun = (page) => page.evaluate(() => window.__game.scene.getScene("game").playerDie());
const endMatch = (page) =>
  page.evaluate(() => {
    const scene = window.__game.scene.getScene("game");
    const { vs } = scene;
    if (vs.phase === "fighting") {
      vs.damage("guest", 99);
    }
  });

const run = async (base, mode) => {
  const code = roomCode();
  const query = mode === "vs" ? `?party=${code}&mode=vs` : `?party=${code}`;
  // Both clients must keep simulating; Chrome otherwise throttles whichever
  // window is not focused, which reads as a frozen peer.
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
  const results = [];
  const step = async (label, body) => {
    const started = Date.now();
    try {
      await body();
      results.push(`${mode} ${label}: pass (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (error) {
      results.push(`${mode} ${label}: FAIL ${error.message}`);
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
        const start = await lf(host.page);
        const hp0 = start.vs.hostHp;
        const gapNow = async () => {
          const s = await lf(host.page);
          return { gap: s.rx - s.px, s };
        };
        // The arena floor is head-height pens (data/rooms.ts VERSUS): each
        // crossing is a running jump, so approach in bounded hops and swing
        // whenever the duelists overlap.
        for (let hop = 0; hop < 40; hop += 1) {
          const { s, gap } = await gapNow();
          if (s.vs.hostHp < hp0) {
            return;
          }
          if (Math.abs(gap) > 18) {
            const dir = gap > 0 ? "KeyA" : "KeyD";
            await guest.page.keyboard.down(dir);
            await guest.page.keyboard.down("Space");
            await wait(450);
            await guest.page.keyboard.up("Space");
            await guest.page.keyboard.up(dir);
          } else {
            // Face the opponent first: a swing only reaches a few px behind.
            await tap(guest.page, gap > 0 ? "KeyA" : "KeyD");
            await tap(guest.page, "KeyJ");
          }
          await wait(120);
        }
        assert.fail("guest never landed a hit");
      });
    }
    await step(
      mode === "vs" ? "pause n/a: Escape exits the duel" : "host pause does not freeze the guest",
      async () => {
        if (mode === "vs") {
          return;
        }
        await host.page.keyboard.press("Escape");
        await until(host.page, () => window.__lf?.paused === true, "host paused");
        await moveCrossesWire(guest, host);
        await host.page.keyboard.press("Escape");
        await until(host.page, () => window.__lf?.paused === false, "host resumed");
      },
    );
    const restart = async (first, second) => {
      if (mode === "vs") {
        await until(host.page, () => window.__lf?.vs?.phase === "fighting", "fighting");
        for (;;) {
          const state = await lf(host.page);
          if (state.vs.phase === "matchEnd") {
            break;
          }
          await endMatch(host.page);
          await wait(200);
        }
        await until(
          guest.page,
          () => window.__lf?.vs?.phase === "matchEnd",
          "guest sees match end",
        );
        await wait(1500);
        await tap(first.page, "KeyJ");
        await until(
          host.page,
          () => window.__lf?.vs?.round === 1 && window.__lf.vs.phase !== "matchEnd",
          "rematch round 1",
        );
        await until(
          guest.page,
          () => window.__lf?.vs?.round === 1 && window.__lf.vs.phase !== "matchEnd",
          "guest sees rematch",
        );
        return;
      }
      await killRun(host.page);
      await hubReady(host.page);
      await hubReady(guest.page);
      for (const c of [first, second]) {
        assert.ok(await c.page.$(".lf-hub-receipt"), `${c.name} sees the run receipt`);
      }
      await play(first, "host");
      await play(second, "guest");
      await seesPeer(first.page, "restart: host sees guest");
      await seesPeer(second.page, "restart: guest sees host");
      [host, guest] = [first, second];
    };
    await step("restart from the guest", () => restart(guest, host));
    await step("restart from the host", () => restart(host, guest));
    await step("host leaves, guest is promoted and plays on", async () => {
      const before = await lf(guest.page);
      await host.context.close();
      await until(
        guest.page,
        () => window.__lf?.role === "host" && window.__lf.state === "active",
        "guest promoted",
        30_000,
      );
      const after = await lf(guest.page);
      if (mode !== "vs" && before.entities > 0) {
        assert.ok(after.entities > 0, "enemies survive the handoff");
      }
      const { swing } = after;
      await tap(guest.page, "KeyJ");
      await until(guest.page, (n) => window.__lf?.swing > n, "promoted host attacks", 8000, swing);
      host = guest;
    });
    await step("late join via the lobby room code", async () => {
      // A closed tab is a transport drop, not a leave: the server parks that
      // seat for the reconnect grace window (or until eviction if no close
      // frame arrived), and this 2-max room only reopens once it is reaped.
      await until(
        host.page,
        () => Object.keys(window.__game.scene.getScene("game").session.players).length === 1,
        "departed seat reaped",
        RECONNECT_GRACE_MS + EVICTION_TIMEOUT_MS,
      );
      const late = await openClient(browser, base, "late", "");
      await late.page.click(`.lf-hub-modes button:nth-of-type(${mode === "vs" ? 3 : 2})`);
      await late.page.fill("#lf-room-code", code);
      await late.page.press("#lf-room-code", "Enter");
      await until(
        late.page,
        () => /Room selected/u.test(document.querySelector(".lf-hub-status")?.textContent ?? ""),
        "room selected",
      );
      const lateUrl = await late.page.url();
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
        extra.page,
        () => /Room full/u.test(document.querySelector(".lf-hub-status")?.textContent ?? ""),
        "room full notice",
        30_000,
      );
      const hostState = await lf(host.page);
      assert.equal(hostState.players, 2, "room still holds two");
      await extra.context.close();
    });
  } finally {
    console.log(results.join("\n"));
    if (errors.length) {
      console.log(`console errors:\n${errors.join("\n")}`);
    }
    await browser.close();
  }
};

const modes = arg("--mode") ? [arg("--mode")] : ["coop", "vs"];
const vite = arg("--url") ? null : await startVite();
try {
  for (const mode of modes) {
    await run(arg("--url") ?? `http://localhost:${PORT}`, mode);
  }
  if (errors.length) {
    throw new Error(`console errors:\n${errors.join("\n")}`);
  }
  console.log("two-client: ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  vite?.kill();
  // A leaked dev-server handle would otherwise keep node alive past the last check.
  process.exit(process.exitCode ?? 0);
}
