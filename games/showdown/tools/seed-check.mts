import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

import { flagValue, inSequence, parseJson, startVite } from "@repo/smoke";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { z } from "zod";

import type { MatchOptions } from "./seed-pilot.mts";

const gameDir = path.resolve(import.meta.dirname, "..");
const PORT = 5396;
const STEP_HZ = 60;
const SAMPLE_EVERY_S = 5;
const SOAK_CAP_S = 260;
const FIRST_SOAK_SEED = 1001;

const flag = (name: string, fallback: string) => flagValue(name, process.argv) ?? fallback;

const urlFlag = flagValue("--url", process.argv);
const baseUrl = urlFlag ?? `http://localhost:${PORT}`;
const seconds = Number(flag("--seconds", "45"));
const soak = Number(flag("--soak", "0"));
const bots = flag("--bots", "normal");
const move = flag("--move", "fight");

const tuneSchema = z
  .object({
    cadence: z.number(),
    damage: z.number(),
    engage: z.number(),
    hunters: z.number(),
    label: z.string(),
    react: z.number(),
    skill: z.tuple([z.number(), z.number()]),
  })
  .partial();

const tune = parseJson(flag("--tune", "{}"), tuneSchema);
const pages = Number(flag("--pages", "4"));

const pilot = stripTypeScriptTypes(
  readFileSync(path.join(gameDir, "tools/seed-pilot.mts"), "utf-8"),
);

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
  await page.addScriptTag({ content: pilot, type: "module" });
  await page.waitForFunction(() => window.__seedPilot !== undefined);

  return page;
};

const run = async (page: Page, seed: number, ticks: number, untilEnded: boolean) =>
  await page.evaluate(
    (args) => {
      if (window.__seedPilot === undefined) {
        throw new Error("the seed pilot did not load");
      }

      return window.__seedPilot.playMatch(args);
    },
    {
      hz: STEP_HZ,
      moveName: move,
      sampleEvery: SAMPLE_EVERY_S * STEP_HZ,
      seed,
      ticks,
      tune,
      untilEnded,
    } satisfies MatchOptions,
  );

let failed = false;

try {
  if (soak > 0) {
    const playSeed = async (seed: number, page: Page) => {
      const result = await run(page, seed, SOAK_CAP_S * STEP_HZ, true);
      await page.close();
      const { cubes, ended, kills, rank, survived } = result;

      return { cubes, ended, kills, rank, seed, survived };
    };

    const seeds = Array.from({ length: soak }, (_, i) => FIRST_SOAK_SEED + i);

    const batches = Array.from({ length: Math.ceil(seeds.length / pages) }, (_, i) =>
      seeds.slice(i * pages, (i + 1) * pages),
    );

    const settled = await inSequence(batches, async (batch) => {
      const playing = await inSequence(batch, async (seed) => ({
        result: playSeed(seed, await openPage()),
      }));

      return await Promise.all(playing.map(async ({ result }) => await result));
    });

    const rows = settled.flat();

    console.table(rows, ["seed", "rank", "kills", "cubes", "survived", "ended"]);

    const mean = (key: "rank" | "kills" | "survived") =>
      (rows.reduce((sum, row) => sum + row[key], 0) / rows.length).toFixed(2);

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
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
  vite?.kill();
}

if (failed) {
  process.exitCode = 1;
}
