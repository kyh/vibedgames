// Headless play check: boots the game in Chromium (software WebGL), waits for
// the loading veil to lift, starts a match, lets it run for a few seconds and
// fails on any page error or console error. Screenshots land in --out.
// SMOKE_BROWSER=/path/to/chrome overrides the bundled Chromium when Playwright cannot find one.
// node tools/play-smoke.mjs [--url http://localhost:5195] [--out ./shots] [--seconds 8]

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const gameDir = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(path.join(gameDir, "package.json"))("playwright-core");
const PORT = 5395;

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const baseUrl = flag("--url", `http://localhost:${PORT}`);
const outDir = flag("--out", path.join(gameDir, ".smoke"));
const seconds = Number(flag("--seconds", "8"));
mkdirSync(outDir, { recursive: true });

const reachable = async (url) => {
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
    {
      cwd: gameDir,
      stdio: "ignore",
    },
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
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) {
    failures += 1;
  }
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
const errors = [];
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("console", (msg) => {
  // Network-level resource failures (fonts behind a proxy, a missing favicon)
  // are the environment's, not the game's.
  if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource")) {
    errors.push(`console.error: ${msg.text()}`);
  }
});

await page.goto(`${baseUrl}/?q=low`, { waitUntil: "load" });
await page.waitForFunction(
  () => document.querySelector("#loading")?.classList.contains("done"),
  null,
  {
    timeout: 60_000,
  },
);
check(true, "loading veil lifted");
await wait(500);
await page.screenshot({ path: path.join(outDir, "menu.png") });
check((await page.locator("#menu.open").count()) === 1, "menu is open");
check((await page.locator("#cards .card").count()) === 9, "nine champion cards");

await page.click("#play");
await wait(1200);
check((await page.locator("#hud:not(.hidden)").count()) === 1, "hud shown after PLAY");
await page.screenshot({ path: path.join(outDir, "countdown.png") });

// Move and shoot a bit so the sim exercises input, bullets and effects.
await page.mouse.move(900, 300);
await page.keyboard.down("KeyW");
await wait(700);
await page.keyboard.up("KeyW");
await page.keyboard.down("KeyD");
await page.mouse.down();
await wait(600);
await page.mouse.up();
await page.keyboard.up("KeyD");
await page.keyboard.press("KeyT");
await wait(Math.max(0, seconds * 1000 - 3000));
await page.screenshot({ path: path.join(outDir, "match.png") });

const left = await page.locator("#left-count b").textContent();
check(Number(left) >= 1 && Number(left) <= 8, `brawlers left pill reads ${left}`);
check(
  errors.length === 0,
  `no page/console errors${errors.length ? `:\n  ${errors.slice(0, 8).join("\n  ")}` : ""}`,
);

await browser.close();
vite?.kill();
if (failures > 0) {
  process.exitCode = 1;
}
