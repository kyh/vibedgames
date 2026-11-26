import path from "node:path";

import { createReport, flagValue, poll, startVite } from "@repo/smoke";
import type { ChildProcess } from "node:child_process";
import { chromium } from "playwright-core";

declare global {
  interface Window {
    __pad?: {
      connect: () => void;
      set: (input: { axes?: number[]; buttons?: boolean[] }) => void;
    };
  }
}

const gameDir = path.resolve(import.meta.dirname, "..");
const PORT = 5396;

const urlFlag = flagValue("--url", process.argv);
const baseUrl = urlFlag ?? `http://localhost:${PORT}`;

const report = createReport();
const { check } = report;

const installPadStub = () => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));

  const pad = {
    axes: [0, 0, 0, 0],
    buttons,
    connected: false,
    id: "smoke-pad",
    index: 0,
    mapping: "standard",
    timestamp: 0,
  };

  window.__pad = {
    connect: () => {
      pad.connected = true;
    },
    set: ({ axes, buttons: pressed }) => {
      if (axes) {
        pad.axes = axes;
      }

      for (let i = 0; i < buttons.length; i += 1) {
        const on = Boolean(pressed?.[i]);
        buttons[i] = { pressed: on, touched: on, value: on ? 1 : 0 };
      }

      pad.buttons = buttons;
    },
  };
  Object.defineProperty(navigator, "getGamepads", { value: () => [pad.connected ? pad : null] });
};

const vite: ChildProcess | null =
  urlFlag === null ? await startVite({ gameDir, port: PORT, timeoutMs: 15_000 }) : null;

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
  executablePath: process.env.SMOKE_BROWSER,
  headless: true,
});

const page = await browser.newPage({ viewport: { height: 720, width: 1280 } });
const errors: string[] = [];

page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

await page.addInitScript(installPadStub);

await page.goto(`${baseUrl}/?q=low&speed=4`, { waitUntil: "load" });

await page.waitForFunction(
  () => document.querySelector("#loading")?.classList.contains("done"),
  null,
  { timeout: 60_000 },
);

check(true, "loading veil lifted");

await page.evaluate(() => window.__pad?.connect());

await page.click("#play");

await page.waitForFunction(() => window.__GAME_DIAGNOSTICS__?.phase === "playing", null, {
  timeout: 90_000,
});

const readPlayer = async () =>
  await page.evaluate(() => window.__GAME_DIAGNOSTICS__?.player ?? null);

const before = await readPlayer();

check(before !== null, "diagnostics expose the player (installDiagnostics wired)");

await page.evaluate(() => window.__pad?.set({ axes: [1, 0, 0, 0] }));

const movedRight = (after: typeof before) =>
  before !== null && after !== null && after.x - before.x > 0.5;

const after = movedRight(before)
  ? before
  : ((await poll(readPlayer, movedRight, { intervalMs: 250, timeoutMs: 60 * 250 })) ??
    (await readPlayer()));

await page.evaluate(() => window.__pad?.set({ axes: [0, 0, 0, 0] }));

const moved = before !== null && after !== null && after.x - before.x > 0.5;

check(moved, `left stick moved the player right (${before?.x} -> ${after?.x})`);

check(
  errors.length === 0,
  `no page errors${errors.length > 0 ? `:\n  ${errors.slice(0, 8).join("\n  ")}` : ""}`,
);

await browser.close();

vite?.kill();

if (report.failures > 0) {
  process.exitCode = 1;
}
