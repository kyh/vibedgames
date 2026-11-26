import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { chromium } from "playwright-core";

const gameDir = path.resolve(import.meta.dirname, "..");
const PORT = 5396;

const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);

  return i === -1 ? fallback : process.argv[i + 1];
};

const baseUrl = flag("--url", `http://localhost:${PORT}`);

const reachable = async (url: string | URL | Request) => {
  try {
    await fetch(url);

    return true;
  } catch {
    return false;
  }
};

let vite = null;

const startVite = async () => {
  vite = spawn(
    path.join(gameDir, "node_modules/.bin/vite"),
    ["--port", String(PORT), "--strictPort"],
    { cwd: gameDir, stdio: "ignore" },
  );

  for (let i = 0; i < 150; i += 1) {
    if (await reachable(baseUrl)) {
      return;
    }

    await wait(100);
  }

  throw new Error(`vite did not come up on ${baseUrl}`);
};

let failures = 0;

const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);

  if (!ok) {
    failures += 1;
  }
};

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
  navigator.getGamepads = () => [pad.connected ? pad : null];
};

if (!process.argv.includes("--url")) {
  await startVite();
}

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

await page.evaluate(() => window.__pad.connect());

await page.click("#play");

await page.waitForFunction(() => window.__GAME_DIAGNOSTICS__?.phase === "playing", null, {
  timeout: 90_000,
});

const readPlayer = () => page.evaluate(() => window.__GAME_DIAGNOSTICS__?.player ?? null);
const before = await readPlayer();

check(before !== null, "diagnostics expose the player (installDiagnostics wired)");

await page.evaluate(() => window.__pad.set({ axes: [1, 0, 0, 0] }));

let after = before;
const movedRight = () => before !== null && after !== null && after.x - before.x > 0.5;

for (let i = 0; i < 60 && !movedRight(); i += 1) {
  await wait(250);
  after = await readPlayer();
}

await page.evaluate(() => window.__pad.set({ axes: [0, 0, 0, 0] }));

const moved = before !== null && after !== null && after.x - before.x > 0.5;

check(moved, `left stick moved the player right (${before?.x} -> ${after?.x})`);

check(
  errors.length === 0,
  `no page errors${errors.length ? `:\n  ${errors.slice(0, 8).join("\n  ")}` : ""}`,
);

await browser.close();

vite?.kill();

if (failures > 0) {
  process.exitCode = 1;
}
