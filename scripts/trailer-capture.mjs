// Trailer capture harness — records a game's `?trailer=1` run end to end and
// slices it into per-scene stills so the result can be reviewed without a human
// sitting through it.
//
//   node scripts/trailer-capture.mjs <game> [--out DIR] [--shots N] [--keep-server]
//
// Why video-then-slice instead of screenshotting live: trailer-shell drives
// scene time off `performance.now()`, so a 200ms screenshot stall advances the
// clock without advancing the render — choreography lurches and every later
// still lands on a frame the trailer never actually showed. Recording is
// passive, so what lands on disk is what a viewer would see.
//
// Output in <out>/<game>/:
//   trailer.webm            full run
//   NN-<sceneId>-<pct>.png  stills, evenly spaced inside each scene
//   report.json             scene timeline, fps samples, console errors
//
// These games render ~4fps under headless Chrome, so this always runs headed.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// playwright-core is a dep of the game packages, not the root, so resolve it
// through one that has it rather than adding a root dependency for tooling.
const require = createRequire(join(ROOT, "games/crazy-waymo/package.json"));
const { chromium } = require("playwright-core");

const GAMES = ["battle-arena", "crazy-waymo", "farm", "lunerfall", "moba", "starfall"];

const argv = process.argv.slice(2);
const game = argv[0];
if (!game || !GAMES.includes(game)) {
  console.error(`usage: trailer-capture.mjs <${GAMES.join("|")}> [--out DIR] [--shots N]`);
  process.exit(1);
}
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const OUT = resolve(flag("out", "/tmp/trailer-shots"), game);
const SHOTS = Number(flag("shots", "4"));
const VIEWPORT = { width: 1600, height: 900 };

const gameDir = join(ROOT, "games", game);

/** Preview port: the dev port + 400, clear of every game's dev server. */
function previewPort() {
  const cfg = join(gameDir, "vite.config.ts");
  const src = existsSync(cfg) ? require("node:fs").readFileSync(cfg, "utf8") : "";
  const m = /server:\s*\{[^}]*port:\s*(\d+)/.exec(src);
  return (m ? Number(m[1]) : 5200) + 400;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Only one capture at a time, machine-wide. Two headed Chromes rendering a 3D
 * game at once contend for the GPU, and the framerate that lands in report.json
 * is then a measurement of the contention rather than of the game — which is
 * worse than useless, because it looks like a real number. mkdir is atomic, so
 * it is the lock.
 */
const LOCK = "/tmp/trailer-capture.lock";
const STALE_MS = 20 * 60 * 1000;

async function acquireLock() {
  for (;;) {
    try {
      await mkdir(LOCK);
      await writeFile(join(LOCK, "owner"), `${process.pid} ${game}\n`);
      return;
    } catch {
      let age = 0;
      try {
        age = Date.now() - statSync(LOCK).mtimeMs;
      } catch {
        continue; // released between the mkdir and the stat
      }
      if (age > STALE_MS) {
        console.warn(`[${game}] breaking stale capture lock (${Math.round(age / 60000)}m old)`);
        await rm(LOCK, { recursive: true, force: true });
        continue;
      }
      console.log(`[${game}] waiting for the capture lock…`);
      await sleep(5000);
    }
  }
}

const releaseLock = () => {
  try {
    rmSync(LOCK, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
};

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`server never came up: ${url}`);
}

function run(cmd, args, opts) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
    p.on("error", rej);
  });
}

/**
 * Recording does not begin the instant the context exists — the encoder takes a
 * few hundred ms to spin up — while scene timestamps are stamped against the
 * page clock. Left unreconciled, every still comes from the wrong moment.
 *
 * The alignment uses the cuts themselves. The shell dips to black between every
 * pair of scenes, so the video holds one short black interval per scene start,
 * and the offset is whatever shift lines that sequence up with the scene starts
 * we recorded. Two single-anchor approaches were tried first and both failed:
 * anchoring on the first non-black frame put every crazy-waymo still ten
 * seconds early (its loading screen is not black), and deriving the offset from
 * the container duration was worse still, because Playwright's webm reports a
 * duration that disagrees with the wall clock by about a second.
 */
async function blackEndsSec(video, pixTh) {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-i",
      video,
      // d is deliberately shorter than one frame at the recorder's ~25fps: a
      // 120ms cut only holds full black for a frame or two.
      "-vf",
      `blackdetect=d=0.02:pic_th=0.98:pix_th=${pixTh}`,
      "-an",
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return [...stderr.matchAll(/black_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
}

/**
 * How dark a pixel has to be to count as black, tried loosest first. A game
 * whose own picture is nearly black — starfall is deep space — swallows its own
 * cuts at the default threshold: at 0.10 the detector finds 2 intervals in the
 * whole trailer, at 0.05 it finds all twelve.
 */
const PIX_THRESHOLDS = [0.1, 0.05, 0.03];

/** Latency observed across games whose cuts do align, used only as a fallback. */
const TYPICAL_SKEW_SEC = -0.35;

/**
 * Shift (video seconds − page seconds) that lines the most cuts up. Scored over
 * every candidate offset the data allows rather than assumed, so one spurious
 * black interval — a loading screen, a scene that opens on a dark frame —
 * cannot drag the fit.
 */
function fitOffsetSec(blackEnds, sceneStartsSec, tolerance = 0.25) {
  let best = { offset: 0, hits: -1, error: Infinity };
  for (const end of blackEnds) {
    for (const start of sceneStartsSec) {
      const offset = end - start;
      let hits = 0;
      let error = 0;
      for (const s of sceneStartsSec) {
        let nearest = Infinity;
        for (const e of blackEnds) nearest = Math.min(nearest, Math.abs(e - (s + offset)));
        if (nearest <= tolerance) {
          hits++;
          error += nearest;
        }
      }
      if (hits > best.hits || (hits === best.hits && error < best.error)) {
        best = { offset, hits, error };
      }
    }
  }
  return best;
}

async function extractStill(video, sec, out) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-ss",
    sec.toFixed(3),
    "-i",
    video,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    out,
  ]);
}

/** Align the recording to the scene timeline and cut the per-scene stills. */
async function sliceScenes(video, report) {
  const starts = report.scenes.map((s) => s.startMs / 1000);
  const enough = Math.max(2, Math.ceil(starts.length * 0.6));
  let fit = { offset: TYPICAL_SKEW_SEC, hits: 0 };
  let usedTh = null;
  for (const th of PIX_THRESHOLDS) {
    const ends = await blackEndsSec(video, th);
    const candidate = fitOffsetSec(ends, starts);
    if (candidate.hits > fit.hits) {
      fit = candidate;
      usedTh = th;
      report.alignment = {
        cutsMatched: candidate.hits,
        ofScenes: starts.length,
        blackIntervals: ends.length,
        pixTh: th,
      };
    }
    if (candidate.hits >= starts.length) break;
  }
  const skewSec = fit.hits >= enough ? fit.offset : TYPICAL_SKEW_SEC;
  report.videoSkewSec = Number(skewSec.toFixed(3));
  // A fit that only pins a couple of cuts means the stills cannot be trusted,
  // and a silently misaligned still is worse than no still — it looks like a
  // staging bug that is not there.
  if (fit.hits < enough) {
    report.alignment = { ...report.alignment, fellBackToTypicalSkew: true };
    console.warn(
      `[${game}] WARNING weak alignment: ${fit.hits}/${starts.length} cuts matched, ` +
        `falling back to typical skew ${TYPICAL_SKEW_SEC}s — stills may be off by ~0.2s`,
    );
  }

  console.log(
    `[${game}] slicing ${report.scenes.length} scenes ` +
      `(skew ${skewSec.toFixed(2)}s, ${fit.hits}/${starts.length} cuts matched @ pix_th ${usedTh})`,
  );
  for (const scene of report.scenes) {
    const durMs = (scene.endMs ?? scene.startMs) - scene.startMs;
    scene.durationMs = durMs;
    scene.stills = [];
    for (let k = 0; k < SHOTS; k++) {
      // Inset from both edges: the first and last ~12% of a scene are inside
      // the dip-to-black, and a still of the cut plate reviews nothing.
      const pct = 0.12 + (0.76 * k) / Math.max(1, SHOTS - 1);
      const sec = skewSec + (scene.startMs + durMs * pct) / 1000;
      const name = `${String(scene.index).padStart(2, "0")}-${scene.id}-${Math.round(pct * 100)}.png`;
      try {
        await extractStill(video, sec, join(OUT, name));
        scene.stills.push(name);
      } catch (err) {
        console.warn(`  still failed ${name}: ${err.message}`);
      }
    }
  }
}

/**
 * One frame per scene, tiled. The whole point of a trailer is the shape of the
 * cut, and that is invisible when the scenes are 48 separate files — repetition,
 * a flat palette or a saggy middle only show up when you see them side by side.
 */
async function contactSheet(report, outDir) {
  const picks = report.scenes
    .map((s) => s.stills?.find((n) => n.endsWith("-63.png")))
    .filter(Boolean);
  if (picks.length === 0) return;
  const cols = 5;
  const inputs = picks.flatMap((n) => ["-i", join(OUT, n)]);
  const filter =
    `${picks.map((_, i) => `[${i}:v]scale=480:270[t${i}]`).join(";")};` +
    `${picks.map((_, i) => `[t${i}]`).join("")}xstack=inputs=${picks.length}:` +
    `layout=${picks.map((_, i) => `${(i % cols) * 486}_${Math.floor(i / cols) * 276}`).join("|")}:` +
    `fill=black[out]`;
  const out = join(outDir, `contact-${game}.png`);
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      ...inputs,
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      "-frames:v",
      "1",
      out,
    ]);
    console.log(`[${game}] contact sheet → ${out}`);
  } catch (err) {
    console.warn(`[${game}] contact sheet failed: ${err.message.split("\n")[0]}`);
  }
}

/** Redo alignment and stills from an already-captured run — no browser. */
async function reslice() {
  const video = join(OUT, "trailer.webm");
  const report = JSON.parse(await readFile(join(OUT, "report.json"), "utf8"));
  await sliceScenes(video, report);
  await contactSheet(report, resolve(OUT, ".."));
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[${game}] ✓ resliced ${report.scenes.length} scenes → ${OUT}`);
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  console.log(`[${game}] building…`);
  await run("pnpm", ["--filter", `@repo/${game}`, "build"], { cwd: ROOT });

  const port = previewPort();
  const url = `http://localhost:${port}/?trailer=1`;
  console.log(`[${game}] preview on ${port}`);
  const server = spawn(
    "pnpm",
    ["exec", "vite", "preview", "--port", String(port), "--strictPort"],
    { cwd: gameDir, stdio: "ignore", detached: true },
  );
  const stopServer = () => {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.on("exit", stopServer);

  await acquireLock();
  process.on("exit", releaseLock);

  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const report = {
    game,
    port,
    scenes: [],
    fps: [],
    errors: [],
    startedAt: new Date().toISOString(),
  };

  try {
    await waitForServer(`http://localhost:${port}/`, 60_000);

    const context = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir: join(OUT, "raw"), size: VIEWPORT },
    });
    const videoEpoch = Date.now();
    const page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") report.errors.push(msg.text().slice(0, 400));
    });
    page.on("pageerror", (err) => report.errors.push(`pageerror: ${String(err).slice(0, 400)}`));

    // Frame counter, sampled once a second alongside the scene poll — a scene
    // that only looks bad because it dropped to 12fps is a different bug than a
    // scene that is badly staged, and the report has to tell them apart.
    await page.addInitScript(() => {
      globalThis.__frames = 0;
      const tick = () => {
        globalThis.__frames++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    console.log(`[${game}] loading…`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (globalThis.__trailer?.sceneIndex ?? -1) >= 0, null, {
      timeout: 240_000,
      polling: 200,
    });

    let lastIndex = -1;
    let lastFrames = 0;
    let lastFpsAt = Date.now();
    const deadline = Date.now() + 300_000;

    for (;;) {
      const s = await page.evaluate(() => ({
        ...globalThis.__trailer,
        frames: globalThis.__frames,
      }));
      const now = Date.now();

      if (s.sceneIndex !== lastIndex && s.sceneIndex >= 0) {
        if (report.scenes.length > 0) report.scenes.at(-1).endMs = now - videoEpoch;
        report.scenes.push({ index: s.sceneIndex, id: s.sceneId, startMs: now - videoEpoch });
        console.log(`[${game}] scene ${s.sceneIndex} ${s.sceneId}`);
        lastIndex = s.sceneIndex;
      }
      if (now - lastFpsAt >= 1000) {
        report.fps.push({
          sceneId: s.sceneId,
          fps: Math.round(((s.frames - lastFrames) * 1000) / (now - lastFpsAt)),
        });
        lastFrames = s.frames;
        lastFpsAt = now;
      }
      if (s.done) {
        if (report.scenes.length > 0) report.scenes.at(-1).endMs = now - videoEpoch;
        break;
      }
      if (now > deadline) throw new Error("trailer never reported done");
      await sleep(40);
    }

    console.log(`[${game}] done, flushing video…`);
    await context.close();
    const closedAt = Date.now();

    const raw = join(OUT, "raw");
    const [file] = (await readdir(raw)).filter((f) => f.endsWith(".webm"));
    if (!file) throw new Error("no video recorded");
    const video = join(OUT, "trailer.webm");
    await rename(join(raw, file), video);
    await rm(raw, { recursive: true, force: true });

    await sliceScenes(video, report);
    await contactSheet(report, resolve(OUT, ".."));

    const fpsValues = report.fps.map((f) => f.fps).filter((f) => f > 0);
    report.fpsMedian = fpsValues.sort((a, b) => a - b)[Math.floor(fpsValues.length / 2)] ?? 0;
    report.totalMs = (report.scenes.at(-1)?.endMs ?? 0) - (report.scenes[0]?.startMs ?? 0);
  } finally {
    await browser.close();
    stopServer();
    releaseLock();
  }

  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `[${game}] ✓ ${report.scenes.length} scenes, ${(report.totalMs / 1000).toFixed(1)}s, ` +
      `median ${report.fpsMedian}fps, ${report.errors.length} console errors → ${OUT}`,
  );
}

(argv.includes("--reslice") ? reslice() : main()).catch((err) => {
  console.error(err);
  process.exit(1);
});
