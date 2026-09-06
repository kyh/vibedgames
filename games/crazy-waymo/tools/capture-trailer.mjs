// Headed gameplay capture, with the game's actual WebAudio mix.
// Playwright records ~25 fps. This preserves those frames; it does not invent 60 fps.
// node tools/capture-trailer.mjs --out /tmp/crazy-waymo-trailer

import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const gameDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(gameDir, "../..");
const require = createRequire(join(gameDir, "package.json"));
const { chromium } = require("playwright-core");
const viewport = { width: 1920, height: 1080 };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function options(argv) {
  const result = {
    out: "/tmp/crazy-waymo-trailer",
    url: null,
    clean: true,
    scene: null,
    reencode: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help") {
      console.log(
        "Capture real Crazy Waymo gameplay at 1920x1080 with game audio.\n" +
          "Usage: node tools/capture-trailer.mjs [--out DIR] [--url URL] [--no-clean] [--scene ID] [--reencode RAW_DIR]\n" +
          "Default: build + local preview; publication MP4 and clean per-shot reference clips.\n" +
          "Needs Chrome, ffmpeg and ffprobe. Keep capture Chrome foregrounded.\n" +
          "Recording is approximately 25 fps; output reports the measured stream rate.",
      );
      return null;
    }
    if (flag === "--no-clean") {
      result.clean = false;
      continue;
    }
    if (!["--out", "--url", "--scene", "--reencode"].includes(flag))
      throw new Error(`Unknown option ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--out") result.out = value;
    if (flag === "--url") result.url = value;
    if (flag === "--scene") result.scene = value;
    if (flag === "--reencode") result.reencode = value;
  }
  return result;
}

function run(command, args, cwd) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? done() : fail(new Error(`${command} exited ${code}`)),
    );
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return;
    } catch {
      // Preview is still booting.
    }
    await wait(250);
  }
  throw new Error(`Preview did not start: ${url}`);
}

// Installed before game modules. Duplicate only the final destination connection,
// after the game's compressor, leaving its speaker and mute behavior intact.
function installAudioCapture() {
  const original = AudioNode.prototype.connect;
  let capture = null;
  const tapped = new WeakSet();
  AudioNode.prototype.connect = function (...args) {
    const result = original.apply(this, args);
    if (args[0] instanceof AudioDestinationNode && this.context instanceof AudioContext) {
      if (!capture) {
        capture = { context: this.context, sink: this.context.createMediaStreamDestination() };
      }
      if (capture.context === this.context && !tapped.has(this)) {
        original.call(this, capture.sink);
        tapped.add(this);
      }
    }
    return result;
  };
  let recorder = null;
  let stopped = null;
  const chunks = [];
  window.captureAudio = {
    start() {
      if (!capture || capture.context.state !== "running") {
        throw new Error("Game audio is not running; the trusted start gesture did not unlock it");
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find((mime) =>
        MediaRecorder.isTypeSupported(mime),
      );
      if (!mimeType) throw new Error("Chrome does not support WebM audio recording");
      recorder = new MediaRecorder(capture.sink.stream, { mimeType, audioBitsPerSecond: 192000 });
      stopped = new Promise((done, fail) => {
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        });
        recorder.addEventListener("error", () => fail(new Error("Audio recorder failed")));
        recorder.addEventListener("stop", async () => {
          const blob = new Blob(chunks, { type: mimeType });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (let i = 0; i < bytes.length; i += 32768) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
          }
          done(btoa(binary));
        });
      });
      const startedAtMs = performance.now();
      recorder.start(1000);
      return startedAtMs;
    },
    async stop() {
      if (!recorder || !stopped) throw new Error("Audio recording was not started");
      recorder.stop();
      return stopped;
    },
  };
}

async function capture(browser, baseUrl, folder, { clean, scene }) {
  await mkdir(folder, { recursive: true });
  const url = new URL(baseUrl);
  url.searchParams.set("trailer", "1");
  url.searchParams.set("manual", "1");
  url.searchParams.set("offline", "1");
  if (clean) url.searchParams.set("clean", "1");
  else url.searchParams.delete("clean");
  if (scene) url.searchParams.set("scene", scene);
  const errors = [];
  const warnings = [];
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    recordVideo: { dir: folder, size: viewport },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
    if (message.type() === "warning") warnings.push(message.text());
  });
  await page.addInitScript(installAudioCapture);
  let result = { errors, warnings };
  let audioStartedAtMs = null;
  let markerEndedAtMs = null;
  let captureFailure = null;
  let audioFailure = null;
  try {
    console.log(`[capture] ${clean ? "clean references" : "publication"}: loading`);
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    await page.waitForFunction(
      () => window["__trailer"]?.phase === "ready" || window["__trailer"]?.phase === "error",
      null,
      { timeout: 240_000 },
    );
    const ready = await page.evaluate(() => window["__trailer"]);
    if (ready.phase === "error")
      throw new Error(`Trailer failed while loading: ${JSON.stringify(ready)}`);

    // A full-white plate gives the video its own exact synchronization mark.
    // It is present only before recording content; no marker reaches delivery.
    await page.evaluate(() => {
      const marker = document.createElement("div");
      marker.id = "capture-sync";
      marker.style.cssText =
        "position:fixed;inset:0;background:#fff;z-index:2147483647;pointer-events:none";
      document.body.appendChild(marker);
    });
    await page.mouse.click(960, 540);
    await wait(1500); // Audio samples decode during the manual-ready hold.
    audioStartedAtMs = await page.evaluate(() => window.captureAudio.start());
    await wait(600); // At least 15 recorder frames identify the sync interval.
    markerEndedAtMs = await page.evaluate(() => {
      if (!window["__trailerStart"]) throw new Error("Missing manual trailer start API");
      document.getElementById("capture-sync")?.remove();
      const now = performance.now();
      window["__trailerStart"]();
      return now;
    });
    let lastId = "";
    const deadline = Date.now() + 360_000;
    for (;;) {
      const state = await page.evaluate(() => ({
        state: window["__trailer"],
        now: performance.now(),
      }));
      result = { ...state.state, finishedAtMs: state.now, errors, warnings };
      if (state.state.sceneId !== lastId) {
        lastId = state.state.sceneId;
        console.log(`[capture] ${lastId || state.state.phase}`);
      }
      if (state.state.phase === "error")
        throw new Error(`Trailer failed: ${JSON.stringify(state.state)}`);
      if (state.state.done || state.state.phase === "done") {
        break;
      }
      if (Date.now() > deadline) throw new Error("Trailer did not complete within six minutes");
      await wait(40);
    }
    if (errors.length > 0) throw new Error(`Capture has console errors:\n${errors.join("\n")}`);
    if (warnings.some((warning) => /substitut|no stageable|no .*scene/i.test(warning))) {
      throw new Error(`Capture substituted a required shot:\n${warnings.join("\n")}`);
    }
  } catch (error) {
    captureFailure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    // A failed later shot still has useful earlier footage. Preserve the latest
    // timeline and flush audio before closing the context that owns its tracks.
    if (captureFailure && !page.isClosed()) {
      try {
        const snapshot = await page.evaluate(() => ({
          state: window["__trailer"],
          now: performance.now(),
        }));
        result = { ...result, ...snapshot.state, finishedAtMs: snapshot.now };
      } catch {
        // Renderer failures can make the final poll unavailable; keep the last.
      }
    }
    if (audioStartedAtMs !== null && !page.isClosed()) {
      try {
        const encoded = await page.evaluate(() => window.captureAudio.stop());
        await writeFile(join(folder, "audio.webm"), Buffer.from(encoded, "base64"));
      } catch (error) {
        audioFailure = error instanceof Error ? error.message : String(error);
      }
    }
    result = { ...result, audioStartedAtMs, markerEndedAtMs, captureFailure, audioFailure };
    await writeFile(join(folder, "capture.json"), `${JSON.stringify(result, null, 2)}\n`);
    await context.close();
  }
  if (audioFailure) throw new Error(`Audio capture failed: ${audioFailure}`);
  const videos = (await readdir(folder)).filter(
    (name) => name.endsWith(".webm") && name !== "audio.webm",
  );
  if (videos.length !== 1) throw new Error(`Expected one recorded video; found ${videos.length}`);
  return { ...result, video: join(folder, videos[0]), audio: join(folder, "audio.webm") };
}

async function scanRecording(video) {
  const { stderr } = await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      video,
      "-vf",
      "freezedetect=n=-60dB:d=0.24,negate,blackdetect=d=0.4:pic_th=0.999:pix_th=0.04",
      "-an",
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const intervals = [
    ...stderr.matchAll(
      /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)\s+black_duration:\s*([\d.]+)/g,
    ),
  ];
  const marker = intervals.findLast((match) => Number(match[3]) >= 1.6);
  if (!marker) throw new Error("Video sync plate was not detected; refusing guessed alignment");
  const freezes = [];
  let freezeStart = null;
  for (const match of stderr.matchAll(/freeze_(start|end):\s*([\d.]+)/g)) {
    if (match[1] === "start") freezeStart = Number(match[2]);
    else if (freezeStart !== null) {
      freezes.push({ start: freezeStart, end: Number(match[2]) });
      freezeStart = null;
    }
  }
  // A hold can continue through the final recorded frame. Scene bounds below
  // provide its finite end, without including time after the trailer finished.
  if (freezeStart !== null) freezes.push({ start: freezeStart, end: Infinity });
  return { syncEnd: Number(marker[2]), freezes };
}

function timelineOf(recording) {
  const timeline = recording.timeline;
  if (!Array.isArray(timeline) || timeline.length === 0)
    throw new Error("Trailer reported no scene timeline");
  return timeline.map((entry) => {
    if (
      !/^[a-z][a-z0-9-]*$/.test(entry.id) ||
      !Number.isFinite(entry.startMs) ||
      !Number.isFinite(entry.endMs) ||
      entry.endMs <= entry.startMs
    ) {
      throw new Error(`Invalid scene timeline: ${JSON.stringify(entry)}`);
    }
    return { id: entry.id, startMs: entry.startMs, endMs: entry.endMs };
  });
}

async function encode(recording, output) {
  const timeline = timelineOf(recording);
  const { syncEnd, freezes } = await scanRecording(recording.video);
  const { stdout: sourceProbe } = await exec("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_streams",
    "-of",
    "json",
    recording.video,
  ]);
  const source = JSON.parse(sourceProbe).streams[0];
  const [numerator, denominator] = source.avg_frame_rate.split("/").map(Number);
  const frameRate = numerator / denominator;
  if (
    !Number.isFinite(frameRate) ||
    frameRate <= 0 ||
    source.avg_frame_rate !== source.r_frame_rate
  ) {
    throw new Error("Capture video must have a finite constant frame rate");
  }
  // Select whole recorded frames. Match each audio interval to those exact
  // frame boundaries, so concat cannot accumulate rounding gaps between shots.
  let cursorFrames = 0;
  const segments = [];
  const removedStalls = [];
  const frameAt = (seconds) => Math.ceil(seconds * frameRate - 0.00001);
  const editedTimeline = timeline.map((entry) => {
    const expectedStart = syncEnd + (entry.startMs - recording.markerEndedAtMs) / 1000;
    const expectedEnd = syncEnd + (entry.endMs - recording.markerEndedAtMs) / 1000;
    const firstFrame = frameAt(expectedStart);
    const lastFrame = frameAt(expectedEnd);
    const videoStart = firstFrame / frameRate;
    const videoEnd = lastFrame / frameRate;
    const audioStart =
      (entry.startMs - recording.audioStartedAtMs) / 1000 + videoStart - expectedStart;
    const duration = videoEnd - videoStart;
    if (videoStart < 0 || audioStart < 0 || duration <= 0) {
      throw new Error(`Capture alignment produced invalid bounds for ${entry.id}`);
    }
    const shotStartFrame = cursorFrames;
    let keptFrom = firstFrame;
    const keep = (startFrame, endFrame) => {
      if (endFrame <= startFrame) return;
      segments.push({
        id: entry.id,
        start: cursorFrames / frameRate,
        duration: (endFrame - startFrame) / frameRate,
        videoStart: startFrame / frameRate,
        videoEnd: endFrame / frameRate,
        audioStart: audioStart + (startFrame - firstFrame) / frameRate,
      });
      cursorFrames += endFrame - startFrame;
    };
    for (const freeze of freezes) {
      const startFrame = Math.max(firstFrame, frameAt(freeze.start));
      const endFrame = Math.min(lastFrame, frameAt(freeze.end));
      // Only remove a hold when at least 240 ms lies inside this visible shot.
      // Retain its first frame; everything removed has the same captured image.
      if (endFrame - startFrame < Math.ceil(0.24 * frameRate)) continue;
      const removeFrom = Math.max(keptFrom, startFrame + 1);
      if (endFrame <= removeFrom) continue;
      keep(keptFrom, removeFrom);
      removedStalls.push({
        id: entry.id,
        videoStart: removeFrom / frameRate,
        videoEnd: endFrame / frameRate,
        audioStart: audioStart + (removeFrom - firstFrame) / frameRate,
        duration: (endFrame - removeFrom) / frameRate,
      });
      keptFrom = endFrame;
    }
    keep(keptFrom, lastFrame);
    return {
      id: entry.id,
      start: shotStartFrame / frameRate,
      duration: (cursorFrames - shotStartFrame) / frameRate,
    };
  });
  const filter = [
    `[0:v]split=${segments.length}${segments.map((_, i) => `[vs${i}]`).join("")}`,
    `[1:a]asplit=${segments.length}${segments.map((_, i) => `[as${i}]`).join("")}`,
    ...segments.flatMap((segment, i) => [
      `[vs${i}]trim=start=${segment.videoStart}:end=${segment.videoEnd},setpts=PTS-STARTPTS[v${i}]`,
      `[as${i}]atrim=start=${segment.audioStart}:duration=${segment.duration},asetpts=PTS-STARTPTS,` +
        `afade=t=in:d=0.03,afade=t=out:st=${Math.max(0, segment.duration - 0.03)}:d=0.03[a${i}]`,
    ]),
    segments.map((_, i) => `[v${i}][a${i}]`).join("") +
      `concat=n=${segments.length}:v=1:a=1[video][audio]`,
  ].join(";");
  await exec(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      recording.video,
      "-i",
      recording.audio,
      "-filter_complex",
      filter,
      "-map",
      "[video]",
      "-map",
      "[audio]",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "17",
      "-pix_fmt",
      "yuv420p",
      // Closed IDR boundaries and no reordered frames make stream-copy shot
      // extraction exact, including the final frame before the next scene.
      "-bf",
      "0",
      "-forced-idr",
      "1",
      "-force_key_frames",
      editedTimeline.map((shot) => shot.start.toFixed(6)).join(","),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      output,
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    output,
  ]);
  const media = JSON.parse(stdout);
  const video = media.streams.find((stream) => stream.codec_type === "video");
  const audio = media.streams.find((stream) => stream.codec_type === "audio");
  if (!video || video.width !== 1920 || video.height !== 1080 || !audio)
    throw new Error("Encoded master must contain 1080p video and audio");
  if (Number(video.nb_frames) !== cursorFrames)
    throw new Error(`Encoded master has ${video.nb_frames} frames; expected ${cursorFrames}`);
  const { stdout: keyframeProbe } = await exec("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-skip_frame",
    "nokey",
    "-show_entries",
    "frame=pts_time",
    "-of",
    "json",
    output,
  ]);
  const keyframes = JSON.parse(keyframeProbe).frames.map((frame) => Number(frame.pts_time));
  for (const shot of editedTimeline) {
    if (!keyframes.some((time) => Math.abs(time - shot.start) < 0.001))
      throw new Error(`Missing exact shot-start keyframe for ${shot.id}`);
  }
  const { stderr } = await exec(
    "ffmpeg",
    ["-hide_banner", "-i", output, "-af", "volumedetect", "-vn", "-f", "null", "-"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  if (!peak || Number(peak[1]) < -50) throw new Error("Recorded game audio is silent or inaudible");
  return {
    file: output,
    timeline: editedTimeline,
    alignment: {
      markerEndVideoSeconds: syncEnd,
      segments,
      stagingGapsRemoved: true,
      removedStalls,
      removedStallSeconds: removedStalls.reduce((sum, stall) => sum + stall.duration, 0),
      stallDetection:
        "Freezedetect -60 dB, at least 240 ms inside a shot; first held frame retained",
      shotStartKeyframesVerified: true,
      accuracy: "One recorded frame (approximately 40 ms), plus audio encoder latency",
    },
    duration: Number(media.format.duration),
    width: video.width,
    height: video.height,
    frameRate: video.avg_frame_rate,
    audioPeakDb: Number(peak[1]),
    warnings: recording.warnings,
    errors: recording.errors,
  };
}

async function extractShots(master, output) {
  await mkdir(output, { recursive: true });
  const shots = [];
  for (let i = 0; i < master.timeline.length; i++) {
    const shot = master.timeline[i];
    const name = `${String(i + 1).padStart(2, "0")}-${shot.id.replace(/[^a-z0-9-]/gi, "-")}`;
    const clip = join(output, `${name}.mp4`);
    await exec("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(shot.start),
      "-i",
      master.file,
      "-t",
      String(shot.duration),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      clip,
    ]);
    const { stdout: clipProbe } = await exec("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-of",
      "json",
      clip,
    ]);
    const streams = JSON.parse(clipProbe).streams;
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const [numerator, denominator] = master.frameRate.split("/").map(Number);
    const expectedFrames = Math.round((shot.duration * numerator) / denominator);
    if (
      !video ||
      !audio ||
      Number(video.nb_frames) !== expectedFrames ||
      Math.abs(Number(video.start_time)) > 0.001
    ) {
      throw new Error(`Stream-copy boundaries failed for ${shot.id}`);
    }
    const stills = [];
    for (const [label, fraction] of [
      ["start", 0.12],
      ["mid", 0.5],
      ["end", 0.88],
    ]) {
      const still = join(output, `${name}-${label}.jpg`);
      await exec("ffmpeg", [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(shot.start + shot.duration * fraction),
        "-i",
        master.file,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        still,
      ]);
      stills.push(still);
    }
    shots.push({ ...shot, file: clip, still: stills[1], stills, copiedFrames: expectedFrames });
  }
  if (shots.length > 1) {
    const filter =
      shots.map((_, i) => `[${i}:v]scale=480:270[t${i}]`).join(";") +
      ";" +
      shots.map((_, i) => `[t${i}]`).join("") +
      `xstack=inputs=${shots.length}:layout=` +
      shots.map((_, i) => `${(i % 4) * 486}_${Math.floor(i / 4) * 276}`).join("|") +
      ":fill=black[out]";
    await exec(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        ...shots.flatMap((shot) => ["-i", shot.still]),
        "-filter_complex",
        filter,
        "-map",
        "[out]",
        "-frames:v",
        "1",
        join(output, "contact-sheet.jpg"),
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
  }
  return shots;
}

async function loadRecording(folder) {
  const recording = JSON.parse(await readFile(join(folder, "capture.json"), "utf8"));
  const videos = (await readdir(folder)).filter(
    (name) => name.endsWith(".webm") && name !== "audio.webm",
  );
  if (videos.length !== 1) throw new Error(`Expected one recorded video in ${folder}`);
  return { ...recording, video: join(folder, videos[0]), audio: join(folder, "audio.webm") };
}

async function main() {
  const config = options(process.argv.slice(2));
  if (!config) return;
  await exec("ffmpeg", ["-version"]);
  await exec("ffprobe", ["-version"]);
  const output = resolve(config.out);
  await mkdir(output, { recursive: true });
  const scratch = config.reencode
    ? resolve(config.reencode)
    : await mkdtemp(join(tmpdir(), "waymo-trailer-"));
  let server = null;
  let browser = null;
  let complete = false;
  const report = {
    startedAt: new Date().toISOString(),
    viewport,
    recorder: "Playwright headed Chrome, native ~25fps video; captured game WebAudio",
    publication: null,
    clean: null,
  };
  try {
    let baseUrl = config.url;
    if (!baseUrl && !config.reencode) {
      await run("pnpm", ["--filter", "@repo/crazy-waymo", "build"], repoDir);
      const source = await readFile(join(gameDir, "vite.config.ts"), "utf8");
      const match = /port:\s*(\d+)/.exec(source);
      const port = Number(match?.[1] ?? "5193") + 400;
      baseUrl = `http://localhost:${port}/`;
      server = spawn("pnpm", ["exec", "vite", "preview", "--port", String(port), "--strictPort"], {
        cwd: gameDir,
        stdio: "ignore",
        detached: true,
      });
      await waitForServer(baseUrl);
    }
    if (!config.reencode) browser = await chromium.launch({ headless: false, channel: "chrome" });
    const recordingFor = async (clean) => {
      const folder = join(scratch, clean ? "clean" : "publication");
      if (config.reencode) return loadRecording(folder);
      if (!browser || !baseUrl) throw new Error("Capture browser was not initialized");
      return capture(browser, baseUrl, folder, { clean, scene: config.scene });
    };
    const publication = await recordingFor(false);
    report.publication = await encode(publication, join(output, "crazy-waymo-trailer.mp4"));
    report.publication.shots = await extractShots(report.publication, join(output, "review"));
    if (config.clean) {
      const clean = await recordingFor(true);
      report.clean = await encode(clean, join(output, "crazy-waymo-clean.mp4"));
      report.clean.shots = await extractShots(report.clean, join(output, "clean-shots"));
    }
    complete = true;
    console.log(
      `[capture] Saved ${output}/crazy-waymo-trailer.mp4 (${report.publication.frameRate} fps, real audio)`,
    );
  } finally {
    await browser?.close();
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        /* Preview already stopped. */
      }
    }
    await writeFile(
      join(output, "report.json"),
      `${JSON.stringify({ ...report, complete, rawCapture: scratch }, null, 2)}\n`,
    );
    console.log(
      `[capture] Raw evidence retained at ${scratch}; use --reencode to revise the edit without recording again`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
