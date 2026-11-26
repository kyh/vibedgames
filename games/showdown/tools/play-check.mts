import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { createReport, flagValue, startVite } from "@repo/smoke";
import { chromium } from "playwright-core";

const gameDir = path.resolve(import.meta.dirname, "..");
const PORT = 5395;

const urlFlag = flagValue("--url", process.argv);
const baseUrl = urlFlag ?? `http://localhost:${PORT}`;
const outDir = flagValue("--out", process.argv) ?? path.join(gameDir, ".smoke");
const seconds = Number(flagValue("--seconds", process.argv) ?? "8");

mkdirSync(outDir, { recursive: true });

const report = createReport();
const { check } = report;

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

page.on("console", (msg) => {
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
  `no page/console errors${errors.length > 0 ? `:\n  ${errors.slice(0, 8).join("\n  ")}` : ""}`,
);

await browser.close();

vite?.kill();

if (report.failures > 0) {
  process.exitCode = 1;
}
