// Seed replay check: a match is a pure function of its seed and the player's
// inputs. Boots the game in headless Chromium and steps the sim by hand at a
// fixed 60 Hz (tools/seed-pilot.mjs, injected into the page), with the
// playtest `fight` reflex as the scripted player. The same seed must
// replay to identical positions, health and knock-out order; another seed
// must not.
// node tools/seed-smoke.mjs [--url http://localhost:5195] [--seconds 45]
// node tools/seed-smoke.mjs --soak 8 [--bots normal] [--move fight|flee|loot|to_zone|rules]   full matches, one per seed, as a table
// SMOKE_BROWSER=/path/to/chrome overrides the bundled Chromium.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const gameDir = path.resolve(import.meta.dirname, "..");
const { chromium } = createRequire(path.join(gameDir, "package.json"))("playwright-core");
const PORT = 5396;
const STEP_HZ = 60;
const SAMPLE_EVERY_S = 5;
/** The gas has closed completely well before this; a match still running is a stalemate. */
const SOAK_CAP_S = 260;
const FIRST_SOAK_SEED = 1001;

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const baseUrl = flag("--url", `http://localhost:${PORT}`);
const seconds = Number(flag("--seconds", "45"));
const soak = Number(flag("--soak", "0"));
const bots = flag("--bots", "normal");
const move = flag("--move", "fight");
/** Difficulty fields to try without editing config.ts, e.g. --tune '{"damage":0.9,"hunters":3}'. */
const tune = JSON.parse(flag("--tune", "{}"));
const pages = Number(flag("--pages", "4"));

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

const openPage = async () => {
  const page = await browser.newPage({ viewport: { height: 720, width: 1280 } });
  await page.goto(`${baseUrl}/?q=low&offline=1&test=1&bots=${bots}`, {
    timeout: 120_000,
    waitUntil: "load",
  });
  await page.waitForFunction(
    () => document.querySelector("#loading")?.classList.contains("done"),
    null,
    { timeout: 60_000 },
  );
  await page.addScriptTag({ path: path.join(gameDir, "tools/seed-pilot.mjs"), type: "module" });
  await page.waitForFunction(() => window.__seedPilot !== undefined);
  return page;
};

const run = (page, seed, ticks, untilEnded) =>
  page.evaluate((args) => window.__seedPilot.playMatch(args), {
    hz: STEP_HZ,
    moveName: move,
    sampleEvery: SAMPLE_EVERY_S * STEP_HZ,
    seed,
    ticks,
    tune,
    untilEnded,
  });

let failed = false;
try {
  if (soak > 0) {
    // A fresh page per match: the hidden mercy streak must not carry between rows.
    const playSeed = async (seed, page) => {
      const result = await run(page, seed, SOAK_CAP_S * STEP_HZ, true);
      await page.close();
      const { cubes, ended, kills, rank, survived } = result;
      return { cubes, ended, kills, rank, seed, survived };
    };
    const seeds = Array.from({ length: soak }, (_, i) => FIRST_SOAK_SEED + i);
    const rows = [];
    for (let i = 0; i < seeds.length; i += pages) {
      // Matches step side by side, each page its own process and sim. Pages boot one at
      // a time: software WebGL compiles slowly under contention.
      const batch = [];
      for (const seed of seeds.slice(i, i + pages)) {
        batch.push(playSeed(seed, await openPage()));
      }
      rows.push(...(await Promise.all(batch)));
    }
    console.table(rows, ["seed", "rank", "kills", "cubes", "survived", "ended"]);
    const mean = (key) => (rows.reduce((sum, row) => sum + row[key], 0) / rows.length).toFixed(2);
    const wins = rows.filter((row) => row.rank === 1 && row.ended).length;
    console.log(
      `bots=${bots} tune=${JSON.stringify(tune)} move=${move} wins=${wins}/${rows.length} meanRank=${mean("rank")} meanKills=${mean("kills")} meanSurvived=${mean("survived")}s`,
    );
  } else {
    const page = await openPage();
    const ticks = seconds * STEP_HZ;
    const first = await run(page, 4242, ticks, false);
    const other = await run(page, 4243, ticks, false);
    const replay = await run(page, 4242, ticks, false);
    assert.ok(first.samples.length > 0, "the match was sampled");
    assert.deepEqual(replay.roster, first.roster, "same seed, same names and kits");
    assert.deepEqual(replay.samples, first.samples, "same seed, same positions and health");
    assert.deepEqual(replay.downs, first.downs, "same seed, same knock-out order");
    assert.equal(replay.kills, first.kills, "same seed, same takedowns");
    assert.notDeepEqual(other.samples, first.samples, "another seed plays out differently");
    console.log(
      `ok   seed 4242 replays identically over ${seconds}s (${first.samples.length} samples, downs: ${first.downs.join(", ") || "none"})`,
    );
    console.log("ok   seed 4243 differs");
  }
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  await browser.close();
  vite?.kill();
}
if (failed) {
  process.exitCode = 1;
}
