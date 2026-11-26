import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { createReport, flagValue, poll, reachable, repeat, startVite } from "@repo/smoke";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";

import type { GameScene } from "../src/scenes/game-scene.ts";

declare global {
  interface Window {
    __steer?: ReturnType<typeof setInterval>;
    __frame?: GameScene["update"];
    __sending?: PropertyDescriptor;
    __heldFrames?: number;
  }
}

interface Steer {
  aim?: number;
  park?: number;
}

interface ViteHandle {
  current: ChildProcess | null;
}

interface Client {
  context: Awaited<ReturnType<Browser["newContext"]>>;
  page: Page;
}

const gameDir = path.resolve(import.meta.dirname, "..");
const PARTY_PORT = process.env.PARTY_PORT ?? "8787";
const PARTY = `http://localhost:${PARTY_PORT}`;
const PORT = 5300 + (process.pid % 600);

const urlArg = flagValue("--url");
const baseUrl = urlArg ?? `http://localhost:${PORT}`;
const report = createReport();
const { check } = report;

const until = async <T,>(page: Page, fn: () => T, timeoutMs: number) =>
  await poll(async () => await page.evaluate(fn).catch(() => null), Boolean, { timeoutMs });

const pong = async (page: Page) => {
  await page.evaluate(() => {
    if (window.__pong === undefined) {
      throw new Error("window.__pong is missing: run the game in dev mode");
    }
  });
};

const diag = async (page: Page) =>
  await page.evaluate(() => {
    const read = window.__pong?.diagnostics();

    if (read === undefined) {
      throw new Error("window.__pong is missing: run the game in dev mode");
    }

    return read;
  });

const match = async (page: Page, at?: number) => {
  const read = await page.evaluate((tick) => window.__pong?.debugMatch(tick) ?? null, at);

  if (read === null) {
    throw new Error("window.__pong is missing: run the game in dev mode");
  }

  return read;
};

const confirm = async (page: Page) => {
  await page.evaluate(() => {
    window.__pong?.handleGestureConfirm();
  });
};

const netInfo = async (page: Page) =>
  await page.evaluate(() => document.querySelector("#netinfo")?.textContent ?? "");

const isHost = async (page: Page) =>
  await page.evaluate(() => window.__pong?.control.session.isHost ?? false);

const steer = async (page: Page, mode: Steer | null) => {
  await page.evaluate((how) => {
    clearInterval(window.__steer);

    if (how === null) {
      return;
    }

    window.__steer = setInterval(() => {
      const scene = window.__pong;

      if (scene !== undefined) {
        scene.localX = how.park ?? scene.shown.ball.x + (how.aim ?? 0);
      }
    }, 16);
  }, mode);
};

const moving = async (page: Page, ms: number) => {
  const { ball: a } = await diag(page);
  await wait(ms);
  const { ball: b } = await diag(page);

  return a.x !== b.x || a.y !== b.y;
};

interface Agreement {
  ok: boolean;
  why: string;
}

const agree = async (a: Page, b: Page) => {
  const attempt: (left: number, why: string) => Promise<Agreement> = async (left, why) => {
    if (left === 0) {
      return { ok: false, why };
    }

    const [ma, mb] = [await match(a), await match(b)];
    let reason = why;

    if (ma.record !== mb.record || ma.clock !== "tick") {
      reason = `records ${String(ma.record)}/${String(mb.record)}`;
    } else {
      const tick = Math.min(ma.confirmed, mb.confirmed) - 8;
      const [ca, cb] = [await match(a, tick), await match(b, tick)];
      reason = `tick ${tick}: ${String(ca.checksum)} vs ${String(cb.checksum)}`;

      if (ca.checksum !== undefined && cb.checksum !== undefined) {
        return { ok: ca.checksum === cb.checksum, why: reason };
      }
    }

    await wait(200);

    return await attempt(left - 1, reason);
  };

  return await attempt(10, "never read both");
};

const open = async (browser: Browser, name: string, room: string, errors: string[]) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { height: 600, width: 960 },
  });

  if (PARTY_PORT !== "8787") {
    await context.addInitScript((port) => {
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
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

  return { context, page } satisfies Client;
};

const pairUp = async (browser: Browser, room: string, errors: string[]) => {
  const host = await open(browser, "host", room, errors);
  const admitted = await until(host.page, () => window.__pong?.control.session.isHost, 15_000);
  check(admitted !== null, "host admitted");
  await pong(host.page);
  await confirm(host.page);
  const solo = await until(host.page, () => window.__pong?.diagnostics().phase === "rally", 3000);
  const { net } = await diag(host.page);
  check(solo !== null && net.clock === "local", "host serves a solo match vs the AI");
  const hostInfo = await netInfo(host.page);
  check(hostInfo.includes("RIVAL CAN JOIN"), "host HUD advertises the open seat");

  const guest = await open(browser, "guest", room, errors);

  const seated = async (page: Page) =>
    await until(page, () => window.__pong?.debugMatch().clock === "tick", 15_000);

  const both = (await seated(host.page)) !== null && (await seated(guest.page)) !== null;
  check(both, "both seated in a tick-room match");
  const [mh, mg] = [await match(host.page), await match(guest.page)];
  check(
    mh.record === mg.record && mh.slot !== mg.slot,
    `one record, two seats (record ${String(mh.record)})`,
  );
  const guestInfo = await netInfo(guest.page);
  check(guestInfo.includes("LIVE 1V1"), "guest HUD shows the live match");

  return { guest, guestSlot: mg.slot, host };
};

const rallyInSync = async (host: Page, guest: Page) => {
  await steer(host, { aim: 0.25 });
  await steer(guest, { aim: -0.25 });
  const rally = await until(host, () => (window.__pong?.diagnostics().rallyHits ?? 0) >= 4, 20_000);
  check(rally !== null, "both paddles return the ball");

  await repeat(3, async () => {
    const same = await agree(host, guest);
    check(same.ok, `confirmed states agree (${same.why})`);
    await wait(700);
  });

  const { stats } = await match(guest);
  check(
    stats.mispredicted > 0,
    `rollback ran (guest mispredicted ${stats.mispredicted}, resimulated ${stats.resimulated}, deepest ${stats.deepest})`,
  );
};

const powerAndPause = async (host: Page, guest: Page) => {
  const ready = await until(
    guest,
    () =>
      window.__pong?.diagnostics().charge.ready === true &&
      window.__pong?.diagnostics().phase === "rally",
    30_000,
  );

  await confirm(guest);
  const armed = await until(guest, () => window.__pong?.diagnostics().charge.armed, 2000);

  const powered = await until(
    host,
    () => (window.__pong?.diagnostics().powerShots ?? 0) >= 1,
    10_000,
  );

  check(
    ready !== null && armed !== null && powered !== null,
    `guest power shot: ready ${String(ready !== null)} → armed ${String(armed !== null)} → lands on the host ${String(powered !== null)}`,
  );

  await guest.keyboard.press("Escape");
  await wait(200);
  const { paused } = await diag(guest);
  const running = (await moving(guest, 300)) && (await moving(host, 300));
  check(!paused && running, "guest pause keeps the live match running");
  await guest.keyboard.press("Escape");
};

const blip = async (host: Page, guest: Page, guestSlot: number) => {
  await guest.evaluate(() => {
    window.__pong?.control.session.client.dropConnection(4000);
  });

  const covered = await poll(
    async () =>
      await host
        .evaluate((slot) => {
          const scene = window.__pong;

          return scene !== undefined && !(slot === 0 ? scene.shown.a : scene.shown.b).human;
        }, guestSlot)
        .catch(() => false),
    (value) => value,
    { timeoutMs: 5000 },
  );

  check(covered !== null, "the AI holds the dropped guest's paddle on the host");
  await wait(1500);
  await guest.evaluate(() => {
    window.__pong?.control.session.client.redial();
  });
  await until(guest, () => window.__pong?.control.session.connectionStatus === "connected", 10_000);
  await wait(1500);
  const back = await agree(host, guest);
  check(back.ok, `copies agree after the blip (${back.why})`);
};

const winAndRematch = async (host: Page, guest: Page) => {
  await steer(guest, { park: 4.5 });
  const won = await until(host, () => window.__pong?.diagnostics().complete, 60_000);
  const guestSees = await until(guest, () => window.__pong?.diagnostics().complete, 3000);
  const [dh, dg] = [await diag(host), await diag(guest)];
  check(
    won !== null && guestSees !== null && dh.points === dg.opponentScore && dh.points === 7,
    `match ends on both sides (${dh.points}–${dh.opponentScore})`,
  );
  await steer(guest, { aim: -0.25 });
  await confirm(guest);
  const restarted = await until(host, () => window.__pong?.diagnostics().phase === "rally", 3000);
  const zero = await diag(host);
  check(
    restarted !== null && zero.points === 0 && zero.opponentScore === 0,
    "the guest's confirm rematches at 0–0",
  );
};

const migrate = async (host: Page, guest: Page) => {
  const { record } = await match(host);
  await host.evaluate(() => {
    const scene = window.__pong;

    if (scene === undefined) {
      return;
    }

    const sending = Object.getOwnPropertyDescriptor(WebSocket.prototype, "send");

    if (sending === undefined) {
      return;
    }

    const native: Partial<Pick<WebSocket, "send">> = Object.defineProperties({}, { send: sending });
    window.__sending = sending;
    WebSocket.prototype.send = function send(data) {
      if (data !== '{"type":"heartbeat"}') {
        native.send?.call(this, data);
      }
    };

    window.__frame = scene.update.bind(scene);
    window.__heldFrames = 0;
    scene.update = () => {
      window.__heldFrames = (window.__heldFrames ?? 0) + 1;
    };
  });
  const promoted = await until(guest, () => window.__pong?.control.session.isHost, 15_000);
  check(promoted !== null, "guest promoted after the host goes silent");
  const after = await match(guest);
  check(after.record === record && after.clock === "tick", "the match survives the migration");
  check(await moving(guest, 300), "the ball keeps moving for the promoted guest");
  const silent = await agree(host, guest);
  check(silent.ok, `the silent old host still confirms the same ticks (${silent.why})`);

  const held = await host.evaluate(() => {
    const scene = window.__pong;

    if (scene === undefined || window.__frame === undefined || window.__sending === undefined) {
      return 0;
    }

    Object.defineProperty(WebSocket.prototype, "send", window.__sending);
    scene.update = window.__frame;

    return window.__heldFrames ?? 0;
  });

  check(held > 0, "the old host's frames were held while it was silent");

  const demoted = !(await isHost(host));
  check(demoted && (await moving(host, 300)), "the old host plays on as the guest");
};

const rivalLeaves = async (host: Page, guest: Page) => {
  const score = await diag(host);
  await guest.evaluate(() => {
    window.__pong?.control.destroy();
  });
  const alone = await until(host, () => window.__pong?.debugMatch().clock === "local", 10_000);
  const solo = await diag(host);
  check(
    alone !== null && solo.points === score.points && solo.opponentScore === score.opponentScore,
    "the rival leaves: the match goes on vs the AI, score kept",
  );
  check(await moving(host, 300), "the ball keeps moving after the rival left");
  await steer(host, null);
};

const main = async (vite: ViteHandle) => {
  if (!(await reachable(PARTY))) {
    throw new Error(`party server not reachable at ${PARTY}`);
  }

  if (urlArg === null) {
    vite.current = await startVite({ gameDir, port: PORT, url: baseUrl });
  }

  const room = `t${process.pid}-${Date.now()}`;
  const errors: string[] = [];

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

  check(
    errors.length === 0,
    `no console errors (${errors.length > 0 ? errors.join(" | ") : "clean"})`,
  );
};

const vite: ViteHandle = { current: null };

try {
  await main(vite);
} catch (error) {
  console.error(error);
  report.fail();
} finally {
  vite.current?.kill();
  process.exit(report.failures > 0 ? 1 : 0);
}
