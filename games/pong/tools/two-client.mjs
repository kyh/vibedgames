// Two-client online verification: host + guest in one headless Chrome, a
// real party server on :8787 (`pnpm dev:party`). Walks late join, wire
// events, charged power shots, pause-with-live-opponent, rematch from both
// seats, host migration in both directions and a host leaving for good.
// node tools/two-client.mjs [--url http://localhost:5188]

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const gameDir = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(path.join(gameDir, "package.json"))("playwright-core");
const PARTY = "http://localhost:8787";
const PORT = 5399;
const WIN_SCORE = 7;

const urlFlag = process.argv.indexOf("--url");
let vite = null;
const baseUrl = urlFlag === -1 ? `http://localhost:${PORT}` : process.argv[urlFlag + 1];
if (!baseUrl) {
  throw new Error("--url needs a value");
}

const reachable = async (url) => {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
};

const startVite = async () => {
  vite = spawn(
    path.join(gameDir, "node_modules/.bin/vite"),
    ["--port", String(PORT), "--strictPort"],
    {
      cwd: gameDir,
      stdio: "ignore",
    },
  );
  for (let i = 0; i < 100; i += 1) {
    if (await reachable(baseUrl)) {
      return;
    }
    await wait(100);
  }
  throw new Error(`vite did not come up on ${baseUrl}`);
};

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) {
    failures += 1;
  }
};

/** Poll `fn` (runs in the page) until truthy; returns its value or null on timeout. */
const until = async (page, fn, timeoutMs, arg) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await page.evaluate(fn, arg).catch(() => null);
    if (value) {
      return value;
    }
    await wait(50);
  }
  return null;
};

const diag = (page) => page.evaluate(() => window.__GAME_DIAGNOSTICS__);
const confirm = (page) => page.evaluate(() => window.__pong.handleGestureConfirm());
const netInfo = (page) => page.evaluate(() => document.querySelector("#netinfo").textContent);
/** Chase the ball with the local paddle (sim-frame, so it holds through host swaps). */
const track = (page, on) =>
  page.evaluate((enabled) => {
    clearInterval(window.__track);
    if (enabled) {
      window.__track = setInterval(() => {
        window.__pong.myPaddle = window.__pong.ballPos.x;
      }, 16);
    }
  }, on);
const rally = (page, ms) => until(page, () => window.__GAME_DIAGNOSTICS__.phase === "rally", ms);
const moving = async (page, ms) => {
  const { ball: a } = await diag(page);
  await wait(ms);
  const { ball: b } = await diag(page);
  return a.x !== b.x || a.y !== b.y;
};

const open = async (browser, name, room, errors) => {
  // hasTouch: COARSE_INPUT keeps the webcam hand tracker (no camera headless) off.
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { height: 600, width: 960 },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") {
      errors.push(`${name}: ${m.text()}`);
    }
  });
  await page.goto(`${baseUrl}/?room=${room}`);
  return { context, page };
};

const pauseKeepsSimRunning = async (page, other, label) => {
  await page.keyboard.press("Escape");
  await wait(200);
  const { paused: frozen } = await diag(page);
  const ownMoves = await moving(page, 300);
  const otherMoves = await moving(other, 300);
  check(!frozen && ownMoves && otherMoves, `${label} pause (Escape) keeps the live rally running`);
  await page.keyboard.press("Escape");
  await wait(100);
};

/** Force the current point to end the match, then rematch from `from`. */
const winThenRematch = async (host, guest, from, label) => {
  await track(guest, false);
  // Park at the rail so the next ball gets past.
  await guest.evaluate(() => {
    window.__pong.myPaddle = -4.5;
  });
  await host.evaluate((n) => {
    window.__pong.scoreYou = n;
  }, WIN_SCORE - 1);
  const won = await until(host, () => window.__GAME_DIAGNOSTICS__.complete, 15_000);
  const guestSees = await until(
    guest,
    (n) => window.__GAME_DIAGNOSTICS__.complete && window.__GAME_DIAGNOSTICS__.opponentScore === n,
    3000,
    WIN_SCORE,
  );
  check(won && guestSees, `match ends on both sides (${label})`);
  await confirm(from);
  const restarted = (await rally(host, 3000)) && (await rally(guest, 3000));
  const scores = await diag(guest);
  check(
    restarted && scores.score === 0 && scores.opponentScore === 0,
    `rematch from ${label} restarts at 0-0 on both sides`,
  );
  await track(guest, true);
};

const main = async () => {
  if (!(await reachable(PARTY))) {
    throw new Error(`party server not reachable at ${PARTY}`);
  }
  if (urlFlag === -1) {
    await startVite();
  }
  const room = `t${process.pid}-${Date.now()}`;
  const errors = [];
  // Both clients must keep simulating; Chrome otherwise throttles whichever
  // window is not focused, which reads as a frozen peer.
  const browser = await chromium.launch({
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
    channel: "chrome",
    headless: true,
  });
  try {
    // 1. Host alone: plays the AI, room open for a rival.
    const host = await open(browser, "host", room, errors);
    check(
      (await until(host.page, () => window.__pong.role === "host", 15_000)) !== null,
      "host admitted",
    );
    await confirm(host.page);
    check((await rally(host.page, 3000)) !== null, "host serves vs AI");
    const hostInfo = await netInfo(host.page);
    check(hostInfo.includes("RIVAL CAN JOIN"), "host HUD advertises the open seat");

    // 2. Late join into the running match.
    const guest = await open(browser, "guest", room, errors);
    check(
      (await until(guest.page, () => window.__pong.role === "guest", 15_000)) !== null,
      "late joiner admitted as guest",
    );
    check(
      (await rally(guest.page, 3000)) !== null && (await moving(guest.page, 200)),
      "guest picks up the running rally",
    );
    const liveHost = await until(host.page, () => window.__pong.hasLiveOpponent(), 3000);
    const guestInfo = await netInfo(guest.page);
    check(liveHost !== null && guestInfo.includes("LIVE 1V1"), "both sides see each other");

    // 3. Paddle contacts cross the wire.
    await track(host.page, true);
    await track(guest.page, true);
    const hits = await until(host.page, () => window.__GAME_DIAGNOSTICS__.rallyHits >= 4, 15_000);
    const { rallyHits: guestHits } = await diag(guest.page);
    check(
      hits !== null && guestHits >= 3,
      `rally hits reach the guest (host 4+, guest ${guestHits})`,
    );

    // 4. Guest charges through the host, arms, and lands a power shot.
    const ready = await until(
      guest.page,
      () => window.__GAME_DIAGNOSTICS__.charge.hits === 4,
      15_000,
    );
    await confirm(guest.page);
    const armed = await until(guest.page, () => window.__GAME_DIAGNOSTICS__.charge.armed, 2000);
    const powered = await until(host.page, () => window.__GAME_DIAGNOSTICS__.powerShots >= 1, 8000);
    check(ready && armed && powered, "guest power shot: charge → armed → lands on the host");
    await until(host.page, () => window.__GAME_DIAGNOSTICS__.charge.hits === 4, 15_000);
    await confirm(host.page);
    check(
      (await until(host.page, () => window.__GAME_DIAGNOSTICS__.powerShots >= 2, 8000)) !== null,
      "host power shot lands",
    );

    // 5. Pause on either side never freezes the live match.
    await pauseKeepsSimRunning(guest.page, host.page, "guest");
    await pauseKeepsSimRunning(host.page, guest.page, "host");

    // 6. Rematch from each seat.
    await winThenRematch(host.page, guest.page, guest.page, "guest");
    await winThenRematch(host.page, guest.page, host.page, "host");

    // 7. Host backgrounds (no heartbeat, no frames): guest is promoted, keeps its
    //    charge and paddle; the old host returns and is remapped into slot B.
    await until(guest.page, () => window.__GAME_DIAGNOSTICS__.charge.hits >= 1, 15_000);
    await track(guest.page, false);
    await track(host.page, false);
    const guestBefore = await diag(guest.page);
    const hostBefore = await diag(host.page);
    await host.page.evaluate(() => {
      const { client } = window.__pong.net;
      window.__send = client.send;
      client.send = (m) => (m.type === "heartbeat" ? undefined : window.__send.call(client, m));
      window.__pong.update = () => null;
    });
    const promoted = await until(guest.page, () => window.__pong.role === "host", 15_000);
    const guestAfter = await diag(guest.page);
    check(promoted !== null, "guest promoted to host after the host goes silent");
    check(
      Math.abs(guestAfter.player.x - guestBefore.player.x) < 0.05,
      "promoted paddle keeps its screen position",
    );
    check(
      guestAfter.charge.hits === guestBefore.charge.hits,
      `promoted charge survives (${guestBefore.charge.hits} hits)`,
    );
    check(
      (await rally(guest.page, 5000)) !== null && (await moving(guest.page, 200)),
      "promoted host restarts the point",
    );
    await track(guest.page, true);
    await host.page.evaluate(() => {
      window.__pong.net.client.send = window.__send;
      delete window.__pong.update;
    });
    const demoted = await until(host.page, () => window.__pong.role === "guest", 5000);
    const hostAfter = await diag(host.page);
    check(demoted !== null, "returning host is admitted as guest");
    check(
      Math.abs(hostAfter.player.x - hostBefore.player.x) < 0.05,
      "demoted paddle keeps its screen position",
    );
    check(
      (await moving(host.page, 300)) &&
        (await until(host.page, () => window.__pong.lastSeq > 0, 3000)) !== null,
      "demoted side adopts the new host's snapshots",
    );
    const newHost = await diag(guest.page);
    const oldHost = await diag(host.page);
    check(
      oldHost.score === newHost.opponentScore && oldHost.opponentScore === newHost.score,
      "scores stay mirrored across the swap",
    );
    await track(host.page, true);
    const rivalHits = await until(
      guest.page,
      () => window.__GAME_DIAGNOSTICS__.charge.rivalHits >= 1,
      15_000,
    );
    check(rivalHits !== null, "demoted side's paddle still returns the ball");

    // 8. The host leaves for good: the remaining player is promoted and plays on.
    await guest.context.close();
    const survivor = await until(host.page, () => window.__pong.role === "host", 20_000);
    check(survivor !== null, "guest promoted after the host closes its tab");
    check(
      (await rally(host.page, 5000)) !== null && (await moving(host.page, 200)),
      "match stays playable after the host leaves",
    );

    await track(host.page, false);
    await host.context.close();
  } finally {
    await browser.close();
  }
  check(errors.length === 0, `no console errors (${errors.length ? errors.join(" | ") : "clean"})`);
};

try {
  await main();
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  vite?.kill();
  process.exit(failures ? 1 : 0);
}
