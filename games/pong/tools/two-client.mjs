// Two-client online verification: host + guest in one headless Chromium, a
// real party server on :8787 (`pnpm dev:party`). Walks a solo match turning
// into a tick-room match when a rival joins, rollback keeping both copies of
// the match identical (state checksums at the same confirmed tick), a power
// shot through the tick stream, pause with a live rival, a transport blip,
// a won match and its rematch, host migration (the match plays on), and the
// rival leaving (the match carries on against the AI).
// node tools/two-client.mjs [--url http://localhost:5188]
// CHROME_PATH picks the browser binary when playwright's own is missing;
// PARTY_PORT routes the game's socket through another party proxy (one that
// keeps frames in order, as every real WebSocket does).

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const gameDir = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(path.join(gameDir, "package.json"))("playwright-core");
const PARTY_PORT = process.env.PARTY_PORT ?? "8787";
const PARTY = `http://localhost:${PARTY_PORT}`;
const PORT = 5300 + (process.pid % 600);

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
    { cwd: gameDir, stdio: "ignore" },
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
const match = (page, at) => page.evaluate((tick) => window.__pong.debugMatch(tick), at);
const confirm = (page) => page.evaluate(() => window.__pong.handleGestureConfirm());
const netInfo = (page) => page.evaluate(() => document.querySelector("#netinfo").textContent);
const isHost = (page) => page.evaluate(() => window.__pong.control.session.isHost);

/** Steer the local paddle (canonical x) every 16 ms: under the ball with an
 *  offset, or parked at `park`. */
const steer = (page, mode) =>
  page.evaluate((how) => {
    clearInterval(window.__steer);
    if (how === null) {
      return;
    }
    window.__steer = setInterval(() => {
      const scene = window.__pong;
      scene.localX = how.park ?? scene.shown.ball.x + how.aim;
    }, 16);
  }, mode);

const moving = async (page, ms) => {
  const { ball: a } = await diag(page);
  await wait(ms);
  const { ball: b } = await diag(page);
  return a.x !== b.x || a.y !== b.y;
};

/**
 * Both clients' states at one confirmed tick they both still hold, compared.
 * A page the machine starves can fall a second behind and catch up in a
 * burst, so a tick that left one client's history between two reads is
 * retried; two different checksums for one tick are a desync.
 */
const agree = async (a, b) => {
  let why = "never read both";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const [ma, mb] = [await match(a), await match(b)];
    if (ma.record !== mb.record || ma.clock !== "tick") {
      why = `records ${ma.record}/${mb.record}`;
    } else {
      const tick = Math.min(ma.confirmed, mb.confirmed) - 8;
      const [ca, cb] = [await match(a, tick), await match(b, tick)];
      why = `tick ${tick}: ${ca.checksum} vs ${cb.checksum}`;
      if (ca.checksum !== undefined && cb.checksum !== undefined) {
        return { ok: ca.checksum === cb.checksum, why };
      }
    }
    await wait(200);
  }
  return { ok: false, why };
};

const open = async (browser, name, room, errors) => {
  // hasTouch: COARSE_INPUT keeps the webcam hand tracker (no camera headless) off.
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { height: 600, width: 960 },
  });
  if (PARTY_PORT !== "8787") {
    await context.addInitScript((port) => {
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(url, protocols) {
          super(String(url).replace("localhost:8787", `localhost:${port}`), protocols);
        }
      };
    }, PARTY_PORT);
  }
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

/** 1–2. Alone, a solo match on the local clock; a rival joins and both are
 *  seated in the host's record. Returns the two pages and the guest's seat. */
const pairUp = async (browser, room, errors) => {
  const host = await open(browser, "host", room, errors);
  const admitted = await until(host.page, () => window.__pong.control.session.isHost, 15_000);
  check(admitted !== null, "host admitted");
  await confirm(host.page);
  const solo = await until(host.page, () => window.__GAME_DIAGNOSTICS__.phase === "rally", 3000);
  const { net } = await diag(host.page);
  check(solo !== null && net.clock === "local", "host serves a solo match vs the AI");
  const hostInfo = await netInfo(host.page);
  check(hostInfo.includes("RIVAL CAN JOIN"), "host HUD advertises the open seat");

  const guest = await open(browser, "guest", room, errors);
  const seated = (page) => until(page, () => window.__pong.debugMatch().clock === "tick", 15_000);
  const both = (await seated(host.page)) !== null && (await seated(guest.page)) !== null;
  check(both, "both seated in a tick-room match");
  const [mh, mg] = [await match(host.page), await match(guest.page)];
  check(
    mh.record === mg.record && mh.slot !== mg.slot,
    `one record, two seats (record ${mh.record})`,
  );
  const guestInfo = await netInfo(guest.page);
  check(guestInfo.includes("LIVE 1V1"), "guest HUD shows the live match");
  return { guest, guestSlot: mg.slot, host };
};

/** 3. Rallies cross the tick stream; both copies stay identical. */
const rallyInSync = async (host, guest) => {
  await steer(host, { aim: 0.25 });
  await steer(guest, { aim: -0.25 });
  const rally = await until(host, () => window.__GAME_DIAGNOSTICS__.rallyHits >= 4, 20_000);
  check(rally !== null, "both paddles return the ball");
  for (let i = 0; i < 3; i += 1) {
    const same = await agree(host, guest);
    check(same.ok, `confirmed states agree (${same.why})`);
    await wait(700);
  }
  const { stats } = await match(guest);
  check(
    stats.mispredicted > 0,
    `rollback ran (guest mispredicted ${stats.mispredicted}, resimulated ${stats.resimulated}, deepest ${stats.deepest})`,
  );
};

/** 4–5. A power shot through the tick stream (armed mid-rally — between
 *  rallies a confirm serves); a pause with a live rival only suspends input. */
const powerAndPause = async (host, guest) => {
  const ready = await until(
    guest,
    () => window.__GAME_DIAGNOSTICS__.charge.ready && window.__GAME_DIAGNOSTICS__.phase === "rally",
    30_000,
  );
  await confirm(guest);
  const armed = await until(guest, () => window.__GAME_DIAGNOSTICS__.charge.armed, 2000);
  const powered = await until(host, () => window.__GAME_DIAGNOSTICS__.powerShots >= 1, 10_000);
  check(
    ready && armed && powered,
    `guest power shot: ready ${Boolean(ready)} → armed ${Boolean(armed)} → lands on the host ${Boolean(powered)}`,
  );

  await guest.keyboard.press("Escape");
  await wait(200);
  const { paused } = await diag(guest);
  const running = (await moving(guest, 300)) && (await moving(host, 300));
  check(!paused && running, "guest pause keeps the live match running");
  await guest.keyboard.press("Escape");
};

/** 6. A transport blip: the AI holds the guest's paddle meanwhile, the
 *  missed ticks replay on return, and the copies agree again. */
const blip = async (host, guest, guestSlot) => {
  await guest.evaluate(() => window.__pong.control.session.client.socket.close(4000));
  const covered = await until(
    host,
    (slot) => !(slot === 0 ? window.__pong.shown.a : window.__pong.shown.b).human,
    5000,
    guestSlot,
  );
  check(covered !== null, "the AI holds the dropped guest's paddle on the host");
  await wait(1500);
  await guest.evaluate(() => window.__pong.control.session.client.socket.reconnect());
  await until(guest, () => window.__pong.control.session.connectionStatus === "connected", 10_000);
  await wait(1500);
  const back = await agree(host, guest);
  check(back.ok, `copies agree after the blip (${back.why})`);
};

/** 7. The guest stops defending: the host wins, and the guest's confirm rematches. */
const winAndRematch = async (host, guest) => {
  await steer(guest, { park: 4.5 });
  const won = await until(host, () => window.__GAME_DIAGNOSTICS__.complete, 60_000);
  const guestSees = await until(guest, () => window.__GAME_DIAGNOSTICS__.complete, 3000);
  const [dh, dg] = [await diag(host), await diag(guest)];
  check(
    won && guestSees && dh.points === dg.opponentScore && dh.points === 7,
    `match ends on both sides (${dh.points}–${dh.opponentScore})`,
  );
  await steer(guest, { aim: -0.25 });
  await confirm(guest);
  const restarted = await until(host, () => window.__GAME_DIAGNOSTICS__.phase === "rally", 3000);
  const zero = await diag(host);
  check(
    restarted !== null && zero.points === 0 && zero.opponentScore === 0,
    "the guest's confirm rematches at 0–0",
  );
};

/** 8. The host goes silent (no heartbeat, no frames): the guest is promoted
 *  and the match simply plays on — same record, same ticks. */
const migrate = async (host, guest) => {
  const { record } = await match(host);
  await host.evaluate(() => {
    const { client } = window.__pong.control.session;
    window.__send = client.send;
    client.send = (m) => (m.type === "heartbeat" ? undefined : window.__send.call(client, m));
    window.__frame = window.__pong.update;
    window.__pong.update = () => null;
  });
  const promoted = await until(guest, () => window.__pong.control.session.isHost, 15_000);
  check(promoted !== null, "guest promoted after the host goes silent");
  const after = await match(guest);
  check(after.record === record && after.clock === "tick", "the match survives the migration");
  check(await moving(guest, 300), "the ball keeps moving for the promoted guest");
  const silent = await agree(host, guest);
  check(silent.ok, `the silent old host still confirms the same ticks (${silent.why})`);
  await host.evaluate(() => {
    window.__pong.control.session.client.send = window.__send;
    window.__pong.update = window.__frame;
  });
  const demoted = !(await isHost(host));
  check(demoted && (await moving(host, 300)), "the old host plays on as the guest");
};

/** 9. The guest leaves for good: the host carries the match on against the AI. */
const rivalLeaves = async (host, guest) => {
  const score = await diag(host);
  await guest.evaluate(() => window.__pong.control.destroy());
  const alone = await until(host, () => window.__pong.debugMatch().clock === "local", 10_000);
  const solo = await diag(host);
  check(
    alone !== null && solo.points === score.points && solo.opponentScore === score.opponentScore,
    "the rival leaves: the match goes on vs the AI, score kept",
  );
  check(await moving(host, 300), "the ball keeps moving after the rival left");
  await steer(host, null);
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
    executablePath: process.env.CHROME_PATH,
    headless: true,
  });
  try {
    const { guest, guestSlot, host } = await pairUp(browser, room, errors);
    await rallyInSync(host.page, guest.page);
    await powerAndPause(host.page, guest.page);
    await blip(host.page, guest.page, guestSlot);
    await winAndRematch(host.page, guest.page);
    await migrate(host.page, guest.page);
    await rivalLeaves(host.page, guest.page);
    await guest.context.close();
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
