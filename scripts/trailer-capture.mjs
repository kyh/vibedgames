import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

const require = createRequire(path.join(ROOT, "games/crazy-waymo/package.json"));
const { chromium } = require("playwright-core");

const GAMES = ["battle-arena", "crazy-waymo", "farm", "lunerfall", "moba", "starfall"];

const argv = process.argv.slice(2);
const [game] = argv;

if (!game || !GAMES.includes(game)) {
  console.error(`usage: trailer-capture.mjs <${GAMES.join("|")}> [--out DIR] [--shots N]`);
  process.exit(1);
}

const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);

  return i === -1 ? fallback : argv[i + 1];
};

const OUT = path.resolve(flag("out", "/tmp/trailer-shots"), game);
const SHOTS = Number(flag("shots", "4"));
const VIEWPORT = { height: 900, width: 1600 };

const gameDir = path.join(ROOT, "games", game);

const previewPort = () => {
  const cfg = path.join(gameDir, "vite.config.ts");
  const src = existsSync(cfg) ? require("node:fs").readFileSync(cfg, "utf-8") : "";
  const port = /server:\s*\{[^}]*port:\s*(?<port>\d+)/u.exec(src)?.groups?.port;

  return (port ? Number(port) : 5200) + 400;
};

const LOCK = "/tmp/trailer-capture.lock";
const STALE_MS = 20 * 60 * 1000;

const acquireLock = async () => {
  for (;;) {
    try {
      await mkdir(LOCK);
      await writeFile(path.join(LOCK, "owner"), `${process.pid} ${game}\n`);

      return;
    } catch {
      let age = 0;

      try {
        age = Date.now() - statSync(LOCK).mtimeMs;
      } catch {
        continue;
      }

      if (age > STALE_MS) {
        console.warn(`[${game}] breaking stale capture lock (${Math.round(age / 60_000)}m old)`);
        await rm(LOCK, { force: true, recursive: true });
        continue;
      }

      console.log(`[${game}] waiting for the capture lock…`);
      await sleep(5000);
    }
  }
};

const releaseLock = () => {
  try {
    rmSync(LOCK, { force: true, recursive: true });

    return true;
  } catch {
    return false;
  }
};

const waitForServer = async (url, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => null);

    if (res?.ok) {
      return;
    }

    await sleep(300);
  }

  throw new Error(`server never came up: ${url}`);
};

const run = async (cmd, args, opts) => {
  const p = spawn(cmd, args, { stdio: "inherit", ...opts });
  const [code] = await once(p, "exit");

  if (code !== 0) {
    throw new Error(`${cmd} exited ${code}`);
  }
};

const blackEndsSec = async (video, pixTh) => {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-i",
      video,
      "-vf",
      `blackdetect=d=0.02:pic_th=0.98:pix_th=${pixTh}`,
      "-an",
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );

  return [...stderr.matchAll(/black_end:\s*(?<end>[\d.]+)/gu)].map((m) => Number(m.groups?.end));
};

const PIX_THRESHOLDS = [0.1, 0.05, 0.03];

const TYPICAL_SKEW_SEC = -0.35;

const fitOffsetSec = (blackEnds, sceneStartsSec, tolerance = 0.25) => {
  let best = { error: Infinity, hits: -1, offset: 0 };

  for (const end of blackEnds) {
    for (const start of sceneStartsSec) {
      const offset = end - start;
      let hits = 0;
      let error = 0;

      for (const s of sceneStartsSec) {
        let nearest = Infinity;

        for (const e of blackEnds) {
          nearest = Math.min(nearest, Math.abs(e - (s + offset)));
        }

        if (nearest <= tolerance) {
          hits += 1;
          error += nearest;
        }
      }

      if (hits > best.hits || (hits === best.hits && error < best.error)) {
        best = { error, hits, offset };
      }
    }
  }

  return best;
};

const extractStill = async (video, sec, out) => {
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
};

const sliceScenes = async (video, report) => {
  const starts = report.scenes.map((s) => s.startMs / 1000);
  const enough = Math.max(2, Math.ceil(starts.length * 0.6));
  let fit = { hits: 0, offset: TYPICAL_SKEW_SEC };
  let usedTh = null;

  for (const th of PIX_THRESHOLDS) {
    const ends = await blackEndsSec(video, th);
    const candidate = fitOffsetSec(ends, starts);

    if (candidate.hits > fit.hits) {
      fit = candidate;
      usedTh = th;
      report.alignment = {
        blackIntervals: ends.length,
        cutsMatched: candidate.hits,
        ofScenes: starts.length,
        pixTh: th,
      };
    }

    if (candidate.hits >= starts.length) {
      break;
    }
  }

  const skewSec = fit.hits >= enough ? fit.offset : TYPICAL_SKEW_SEC;
  report.videoSkewSec = Number(skewSec.toFixed(3));

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

    for (let k = 0; k < SHOTS; k += 1) {
      const pct = 0.12 + (0.76 * k) / Math.max(1, SHOTS - 1);
      const sec = skewSec + (scene.startMs + durMs * pct) / 1000;
      const name = `${String(scene.index).padStart(2, "0")}-${scene.id}-${Math.round(pct * 100)}.png`;

      try {
        await extractStill(video, sec, path.join(OUT, name));
        scene.stills.push(name);
      } catch (error) {
        console.warn(`  still failed ${name}: ${error.message}`);
      }
    }
  }
};

const contactSheet = async (report, outDir) => {
  const picks = report.scenes
    .map((s) => s.stills?.find((n) => n.endsWith("-63.png")))
    .filter(Boolean);

  if (picks.length === 0) {
    return;
  }

  const cols = 5;
  const inputs = picks.flatMap((n) => ["-i", path.join(OUT, n)]);

  const filter =
    `${picks.map((_, i) => `[${i}:v]scale=480:270[t${i}]`).join(";")};` +
    `${picks.map((_, i) => `[t${i}]`).join("")}xstack=inputs=${picks.length}:` +
    `layout=${picks.map((_, i) => `${(i % cols) * 486}_${Math.floor(i / cols) * 276}`).join("|")}:` +
    `fill=black[out]`;

  const out = path.join(outDir, `contact-${game}.png`);

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
  } catch (error) {
    console.warn(`[${game}] contact sheet failed: ${error.message.split("\n")[0]}`);
  }
};

const reslice = async () => {
  const video = path.join(OUT, "trailer.webm");
  const report = JSON.parse(await readFile(path.join(OUT, "report.json"), "utf-8"));
  await sliceScenes(video, report);
  await contactSheet(report, path.resolve(OUT, ".."));
  await writeFile(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[${game}] ✓ resliced ${report.scenes.length} scenes → ${OUT}`);
};

const main = async () => {
  await rm(OUT, { force: true, recursive: true });
  await mkdir(OUT, { recursive: true });

  console.log(`[${game}] building…`);
  await run("pnpm", ["--filter", `@repo/${game}`, "build"], { cwd: ROOT });

  const port = previewPort();
  const url = `http://localhost:${port}/?trailer=1`;
  console.log(`[${game}] preview on ${port}`);

  const server = spawn(
    "pnpm",
    ["exec", "vite", "preview", "--port", String(port), "--strictPort"],
    { cwd: gameDir, detached: true, stdio: "ignore" },
  );

  const stopServer = () => {
    try {
      process.kill(-server.pid, "SIGTERM");

      return true;
    } catch {
      return false;
    }
  };

  process.on("exit", stopServer);

  await acquireLock();
  process.on("exit", releaseLock);

  const browser = await chromium.launch({ channel: "chrome", headless: false });

  const report = {
    errors: [],
    fps: [],
    game,
    port,
    scenes: [],
    startedAt: new Date().toISOString(),
  };

  try {
    await waitForServer(`http://localhost:${port}/`, 60_000);

    const context = await browser.newContext({
      recordVideo: { dir: path.join(OUT, "raw"), size: VIEWPORT },
      viewport: VIEWPORT,
    });

    const videoEpoch = Date.now();
    const page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        report.errors.push(msg.text().slice(0, 400));
      }
    });
    page.on("pageerror", (err) => report.errors.push(`pageerror: ${String(err).slice(0, 400)}`));

    await page.addInitScript(() => {
      globalThis.__frames = 0;

      const tick = () => {
        globalThis.__frames += 1;
        requestAnimationFrame(tick);
      };

      requestAnimationFrame(tick);
    });

    console.log(`[${game}] loading…`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (globalThis.__trailer?.sceneIndex ?? -1) >= 0, null, {
      polling: 200,
      timeout: 240_000,
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
        if (report.scenes.length > 0) {
          report.scenes.at(-1).endMs = now - videoEpoch;
        }

        report.scenes.push({ id: s.sceneId, index: s.sceneIndex, startMs: now - videoEpoch });
        console.log(`[${game}] scene ${s.sceneIndex} ${s.sceneId}`);
        lastIndex = s.sceneIndex;
      }

      if (now - lastFpsAt >= 1000) {
        report.fps.push({
          fps: Math.round(((s.frames - lastFrames) * 1000) / (now - lastFpsAt)),
          sceneId: s.sceneId,
        });
        lastFrames = s.frames;
        lastFpsAt = now;
      }

      if (s.done) {
        if (report.scenes.length > 0) {
          report.scenes.at(-1).endMs = now - videoEpoch;
        }

        break;
      }

      if (now > deadline) {
        throw new Error("trailer never reported done");
      }

      await sleep(40);
    }

    console.log(`[${game}] done, flushing video…`);
    await context.close();

    const raw = path.join(OUT, "raw");
    const recorded = await readdir(raw);
    const file = recorded.find((f) => f.endsWith(".webm"));

    if (!file) {
      throw new Error("no video recorded");
    }

    const video = path.join(OUT, "trailer.webm");
    await rename(path.join(raw, file), video);
    await rm(raw, { force: true, recursive: true });

    await sliceScenes(video, report);
    await contactSheet(report, path.resolve(OUT, ".."));

    const fpsValues = report.fps.map((f) => f.fps).filter((f) => f > 0);
    report.fpsMedian = fpsValues.toSorted((a, b) => a - b)[Math.floor(fpsValues.length / 2)] ?? 0;
    report.totalMs = (report.scenes.at(-1)?.endMs ?? 0) - (report.scenes[0]?.startMs ?? 0);
  } finally {
    await browser.close();
    stopServer();
    releaseLock();
  }

  await writeFile(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `[${game}] ✓ ${report.scenes.length} scenes, ${(report.totalMs / 1000).toFixed(1)}s, ` +
      `median ${report.fpsMedian}fps, ${report.errors.length} console errors → ${OUT}`,
  );
};

try {
  await (argv.includes("--reslice") ? reslice() : main());
} catch (error) {
  console.error(error);
  process.exit(1);
}
