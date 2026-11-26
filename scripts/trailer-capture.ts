import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { repeatWhile, runInOrder } from "@repo/contract/run-in-order";
import { chromium } from "playwright-core";
import { z } from "zod";

declare global {
  var __trailer: { done?: boolean; sceneId?: string; sceneIndex?: number } | undefined;
  var __frames: number;
}

const execFileAsync = async (cmd: string, args: string[]) => {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  await once(child, "close");

  if (child.exitCode !== 0) {
    throw new Error(`${cmd} exited ${String(child.exitCode)}\n${stderr.slice(-2000)}`);
  }

  return { stderr, stdout };
};

const ROOT = path.resolve(import.meta.dirname, "..");

const GAMES = ["battle-arena", "crazy-waymo", "farm", "lunerfall", "moba", "starfall"];

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { default: "/tmp/trailer-shots", type: "string" },
    reslice: { default: false, type: "boolean" },
    shots: { default: "4", type: "string" },
  },
});

const [game] = positionals;

if (game === undefined || !GAMES.includes(game)) {
  console.error(
    `usage: trailer-capture.ts <${GAMES.join("|")}> [--out DIR] [--shots N] [--reslice]`,
  );
  process.exit(1);
}

const OUT = path.resolve(values.out, game);
const SHOTS = Number(values.shots);
const VIEWPORT = { height: 900, width: 1600 };

const gameDir = path.join(ROOT, "games", game);

const previewPort = () => {
  const cfg = path.join(gameDir, "vite.config.ts");
  const src = existsSync(cfg) ? readFileSync(cfg, "utf-8") : "";
  const port = /server:\s*\{[^}]*port:\s*(?<port>\d+)/u.exec(src)?.groups?.port;

  return (port === undefined ? 5200 : Number(port)) + 400;
};

const LOCK = "/tmp/trailer-capture.lock";
const STALE_MS = 20 * 60 * 1000;

const lockAge = () => {
  try {
    return Date.now() - statSync(LOCK).mtimeMs;
  } catch {
    return null;
  }
};

const acquireLock: () => Promise<void> = async () => {
  try {
    await mkdir(LOCK);
    await writeFile(path.join(LOCK, "owner"), `${process.pid} ${game}\n`);

    return;
  } catch {
    const age = lockAge();

    if (age !== null && age > STALE_MS) {
      console.warn(`[${game}] breaking stale capture lock (${Math.round(age / 60_000)}m old)`);
      await rm(LOCK, { force: true, recursive: true });
    } else if (age !== null) {
      console.log(`[${game}] waiting for the capture lock…`);
      await sleep(5000);
    }
  }

  await acquireLock();
};

const releaseLock = () => {
  rmSync(LOCK, { force: true, recursive: true });
};

const answers = async (url: string) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });

    return res.ok;
  } catch {
    return false;
  }
};

const waitForServer = async (url: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  let up = false;

  await repeatWhile(async () => {
    up = await answers(url);

    if (up || Date.now() >= deadline) {
      return false;
    }

    await sleep(300);

    return true;
  });

  if (!up) {
    throw new Error(`server never came up: ${url}`);
  }
};

const run = async (cmd: string, args: string[], opts: SpawnOptions) => {
  const p = spawn(cmd, args, { stdio: "inherit", ...opts });
  await once(p, "exit");

  if (p.exitCode !== 0) {
    throw new Error(`${cmd} exited ${String(p.exitCode)}`);
  }
};

const blackEndsSec = async (video: string, pixTh: number) => {
  const { stderr } = await execFileAsync("ffmpeg", [
    "-i",
    video,
    "-vf",
    `blackdetect=d=0.02:pic_th=0.98:pix_th=${pixTh}`,
    "-an",
    "-f",
    "null",
    "-",
  ]);

  return [...stderr.matchAll(/black_end:\s*(?<end>[\d.]+)/gu)].map((m) => Number(m.groups?.end));
};

const PIX_THRESHOLDS = [0.1, 0.05, 0.03];

const TYPICAL_SKEW_SEC = -0.35;

const nearestTo = (target: number, candidates: number[]) =>
  Math.min(...candidates.map((candidate) => Math.abs(candidate - target)));

const fitOffsetSec = (blackEnds: number[], sceneStartsSec: number[], tolerance = 0.25) => {
  let best = { error: Infinity, hits: -1, offset: 0 };

  for (const end of blackEnds) {
    for (const start of sceneStartsSec) {
      const offset = end - start;

      const matched = sceneStartsSec.flatMap((s) => {
        const nearest = nearestTo(s + offset, blackEnds);

        return nearest <= tolerance ? [nearest] : [];
      });

      const hits = matched.length;
      const error = matched.reduce((sum, nearest) => sum + nearest, 0);

      if (hits > best.hits || (hits === best.hits && error < best.error)) {
        best = { error, hits, offset };
      }
    }
  }

  return best;
};

const extractStill = async (video: string, sec: number, out: string) => {
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

const sceneSchema = z.object({
  durationMs: z.number().optional(),
  endMs: z.number().optional(),
  id: z.string(),
  index: z.number(),
  startMs: z.number(),
  stills: z.array(z.string()).optional(),
});

const reportSchema = z.object({
  alignment: z.record(z.string(), z.union([z.number(), z.boolean()])).optional(),
  errors: z.array(z.string()),
  fps: z.array(z.object({ fps: z.number(), sceneId: z.string() })),
  fpsMedian: z.number().optional(),
  game: z.string(),
  port: z.number(),
  scenes: z.array(sceneSchema),
  startedAt: z.string(),
  totalMs: z.number().optional(),
  videoSkewSec: z.number().optional(),
});

type Report = z.infer<typeof reportSchema>;

type Scene = Report["scenes"][number];

const stillsOf = async (video: string, scene: Scene, skewSec: number, durMs: number) => {
  const shots = await Promise.all(
    Array.from({ length: SHOTS }, async (_, k) => {
      const pct = 0.12 + (0.76 * k) / Math.max(1, SHOTS - 1);
      const sec = skewSec + (scene.startMs + durMs * pct) / 1000;
      const name = `${String(scene.index).padStart(2, "0")}-${scene.id}-${Math.round(pct * 100)}.png`;

      try {
        await extractStill(video, sec, path.join(OUT, name));

        return [name];
      } catch (error) {
        console.warn(
          `  still failed ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );

        return [];
      }
    }),
  );

  return shots.flat();
};

const sliceScenes = async (video: string, report: Report) => {
  const starts = report.scenes.map((s) => s.startMs / 1000);
  const enough = Math.max(2, Math.ceil(starts.length * 0.6));
  let fit = { hits: 0, offset: TYPICAL_SKEW_SEC };
  let usedTh: number | null = null;

  const passes = await Promise.all(
    PIX_THRESHOLDS.map(async (th) => ({ ends: await blackEndsSec(video, th), th })),
  );

  for (const { ends, th } of passes) {
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
      `(skew ${skewSec.toFixed(2)}s, ${fit.hits}/${starts.length} cuts matched @ pix_th ${String(usedTh)})`,
  );

  await runInOrder(report.scenes, async (scene) => {
    const durMs = (scene.endMs ?? scene.startMs) - scene.startMs;
    scene.durationMs = durMs;
    scene.stills = await stillsOf(video, scene, skewSec, durMs);
  });
};

const contactSheet = async (report: Report, outDir: string) => {
  const picks = report.scenes.flatMap((s) => s.stills?.filter((n) => n.endsWith("-63.png")) ?? []);

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
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[${game}] contact sheet failed: ${message.split("\n")[0] ?? ""}`);
  }
};

const reslice = async () => {
  const video = path.join(OUT, "trailer.webm");

  const report = reportSchema.parse(
    JSON.parse(await readFile(path.join(OUT, "report.json"), "utf-8")),
  );

  await sliceScenes(video, report);
  await contactSheet(report, path.resolve(OUT, ".."));
  await writeFile(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[${game}] ✓ resliced ${report.scenes.length} scenes → ${OUT}`);
};

const trailerState = z.object({
  done: z.boolean().optional(),
  frames: z.number(),
  sceneId: z.string().optional(),
  sceneIndex: z.number().optional(),
});

const closeLastScene = (report: Report, endMs: number) => {
  const last = report.scenes.at(-1);

  if (last) {
    last.endMs = endMs;
  }
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
    if (server.pid !== undefined && server.exitCode === null) {
      process.kill(-server.pid, "SIGTERM");
    }
  };

  process.on("exit", stopServer);

  await acquireLock();
  process.on("exit", releaseLock);

  const browser = await chromium.launch({ channel: "chrome", headless: false });

  const report: Report = {
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
    page.on("pageerror", (err) => {
      report.errors.push(`pageerror: ${err.message.slice(0, 400)}`);
    });

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

    await repeatWhile(async () => {
      const s = trailerState.parse(
        await page.evaluate(() => ({ ...globalThis.__trailer, frames: globalThis.__frames })),
      );

      const now = Date.now();
      const sceneIndex = s.sceneIndex ?? -1;
      const sceneId = s.sceneId ?? "";

      if (sceneIndex !== lastIndex && sceneIndex >= 0) {
        closeLastScene(report, now - videoEpoch);
        report.scenes.push({ id: sceneId, index: sceneIndex, startMs: now - videoEpoch });
        console.log(`[${game}] scene ${sceneIndex} ${sceneId}`);
        lastIndex = sceneIndex;
      }

      if (now - lastFpsAt >= 1000) {
        report.fps.push({
          fps: Math.round(((s.frames - lastFrames) * 1000) / (now - lastFpsAt)),
          sceneId,
        });
        lastFrames = s.frames;
        lastFpsAt = now;
      }

      if (s.done === true) {
        closeLastScene(report, now - videoEpoch);

        return false;
      }

      if (now > deadline) {
        throw new Error("trailer never reported done");
      }

      await sleep(40);

      return true;
    });

    console.log(`[${game}] done, flushing video…`);
    await context.close();

    const raw = path.join(OUT, "raw");
    const recorded = await readdir(raw);
    const file = recorded.find((f) => f.endsWith(".webm"));

    if (file === undefined) {
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
    `[${game}] ✓ ${report.scenes.length} scenes, ${((report.totalMs ?? 0) / 1000).toFixed(1)}s, ` +
      `median ${report.fpsMedian ?? 0}fps, ${report.errors.length} console errors → ${OUT}`,
  );
};

try {
  await (values.reslice ? reslice() : main());
} catch (error) {
  console.error(error);
  process.exit(1);
}
