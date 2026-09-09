// Headed gameplay capture, with the game's actual WebAudio mix.
// Playwright records ~25 fps. This preserves those frames; it does not invent 60 fps.
// node tools/capture-trailer.mjs --out /tmp/crazy-waymo-trailer

import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const gameDir = path.resolve(import.meta.dirname, "..");
const repoDir = path.resolve(gameDir, "../..");
const require = createRequire(path.join(gameDir, "package.json"));
const { chromium } = require("playwright-core");
const viewport = { height: 1080, width: 1920 };

const options = (argv) => {
  const result = {
    clean: true,
    out: "/tmp/crazy-waymo-trailer",
    reencode: null,
    scene: null,
    url: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
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
    if (!["--out", "--url", "--scene", "--reencode"].includes(flag)) {
      throw new Error(`Unknown option ${flag}`);
    }
    const value = argv[(i += 1)];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === "--out") {
      result.out = value;
    }
    if (flag === "--url") {
      result.url = value;
    }
    if (flag === "--scene") {
      result.scene = value;
    }
    if (flag === "--reencode") {
      result.reencode = value;
    }
  }
  return result;
};

const run = (command, args, cwd) =>
  // oxlint-disable-next-line promise/avoid-new -- child_process exposes completion only as events
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited ${code}`));
      }
    });
  });

const waitForServer = async (url) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        return;
      }
    } catch {
      // Preview is still booting.
    }
    await wait(250);
  }
  throw new Error(`Preview did not start: ${url}`);
};

// Installed before game modules. Duplicate only the final destination connection,
// after the game's compressor, leaving its speaker and mute behavior intact.
const installAudioCapture = () => {
  const original = AudioNode.prototype.connect;
  let capture = null;
  const tapped = new WeakSet();
  AudioNode.prototype.connect = function connect(...args) {
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
      if (!mimeType) {
        throw new Error("Chrome does not support WebM audio recording");
      }
      recorder = new MediaRecorder(capture.sink.stream, { audioBitsPerSecond: 192_000, mimeType });
      // oxlint-disable-next-line promise/avoid-new -- MediaRecorder reports completion only as events
      stopped = new Promise((resolve, reject) => {
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) {
            chunks.push(event.data);
          }
        });
        recorder.addEventListener("error", () => reject(new Error("Audio recorder failed")));
        recorder.addEventListener("stop", async () => {
          const blob = new Blob(chunks, { type: mimeType });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (let i = 0; i < bytes.length; i += 32_768) {
            binary += String.fromCodePoint(...bytes.subarray(i, i + 32_768));
          }
          resolve(btoa(binary));
        });
      });
      const startedAtMs = performance.now();
      recorder.start(1000);
      return startedAtMs;
    },
    stop() {
      if (!recorder || !stopped) {
        throw new Error("Audio recording was not started");
      }
      recorder.stop();
      return stopped;
    },
  };
};

const captureUrl = (baseUrl, { clean, scene }) => {
  const url = new URL(baseUrl);
  url.searchParams.set("trailer", "1");
  url.searchParams.set("manual", "1");
  url.searchParams.set("offline", "1");
  if (clean) {
    url.searchParams.set("clean", "1");
  } else {
    url.searchParams.delete("clean");
  }
  if (scene) {
    url.searchParams.set("scene", scene);
  }
  return url;
};

const recordedVideo = async (folder) => {
  const entries = await readdir(folder);
  const videos = entries.filter((name) => name.endsWith(".webm") && name !== "audio.webm");
  if (videos.length !== 1) {
    throw new Error(`Expected one recorded video in ${folder}; found ${videos.length}`);
  }
  const [video] = videos;
  return path.join(folder, video);
};

const flushAudio = async (page, folder) => {
  try {
    const encoded = await page.evaluate(() => window.captureAudio.stop());
    await writeFile(path.join(folder, "audio.webm"), Buffer.from(encoded, "base64"));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const capture = async (browser, baseUrl, folder, { clean, scene }) => {
  await mkdir(folder, { recursive: true });
  const url = captureUrl(baseUrl, { clean, scene });
  const errors = [];
  const warnings = [];
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    recordVideo: { dir: folder, size: viewport },
    viewport,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
    if (message.type() === "warning") {
      warnings.push(message.text());
    }
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
    if (ready.phase === "error") {
      throw new Error(`Trailer failed while loading: ${JSON.stringify(ready)}`);
    }

    // A full-white plate gives the video its own exact synchronization mark.
    // It is present only before recording content; no marker reaches delivery.
    await page.evaluate(() => {
      const marker = document.createElement("div");
      marker.id = "capture-sync";
      marker.style.cssText =
        "position:fixed;inset:0;background:#fff;z-index:2147483647;pointer-events:none";
      document.body.append(marker);
    });
    await page.mouse.click(960, 540);
    // Audio samples decode during the manual-ready hold.
    await wait(1500);
    audioStartedAtMs = await page.evaluate(() => window.captureAudio.start());
    // At least 15 recorder frames identify the sync interval.
    await wait(600);
    markerEndedAtMs = await page.evaluate(() => {
      if (!window["__trailerStart"]) {
        throw new Error("Missing manual trailer start API");
      }
      document.querySelector("#capture-sync")?.remove();
      const now = performance.now();
      window["__trailerStart"]();
      return now;
    });
    let lastId = "";
    const deadline = Date.now() + 360_000;
    for (;;) {
      const state = await page.evaluate(() => ({
        now: performance.now(),
        state: window["__trailer"],
      }));
      result = { ...state.state, errors, finishedAtMs: state.now, warnings };
      if (state.state.sceneId !== lastId) {
        lastId = state.state.sceneId;
        console.log(`[capture] ${lastId || state.state.phase}`);
      }
      if (state.state.phase === "error") {
        throw new Error(`Trailer failed: ${JSON.stringify(state.state)}`);
      }
      if (state.state.done || state.state.phase === "done") {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error("Trailer did not complete within six minutes");
      }
      await wait(40);
    }
    if (errors.length > 0) {
      throw new Error(`Capture has console errors:\n${errors.join("\n")}`);
    }
    if (warnings.some((warning) => /substitut|no stageable|no .*scene/iu.test(warning))) {
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
          now: performance.now(),
          state: window["__trailer"],
        }));
        result = { ...result, ...snapshot.state, finishedAtMs: snapshot.now };
      } catch {
        // Renderer failures can make the final poll unavailable; keep the last.
      }
    }
    if (audioStartedAtMs !== null && !page.isClosed()) {
      audioFailure = await flushAudio(page, folder);
    }
    result = { ...result, audioFailure, audioStartedAtMs, captureFailure, markerEndedAtMs };
    await writeFile(path.join(folder, "capture.json"), `${JSON.stringify(result, null, 2)}\n`);
    await context.close();
  }
  if (audioFailure) {
    throw new Error(`Audio capture failed: ${audioFailure}`);
  }
  return {
    ...result,
    audio: path.join(folder, "audio.webm"),
    video: await recordedVideo(folder),
  };
};

const scanRecording = async (video) => {
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
      /black_start:\s*(?<start>[\d.]+)\s+black_end:\s*(?<end>[\d.]+)\s+black_duration:\s*(?<duration>[\d.]+)/gu,
    ),
  ];
  const marker = intervals.findLast((match) => Number(match.groups?.duration) >= 1.6);
  if (!marker) {
    throw new Error("Video sync plate was not detected; refusing guessed alignment");
  }
  const freezes = [];
  let freezeStart = null;
  for (const match of stderr.matchAll(/freeze_(?<edge>start|end):\s*(?<seconds>[\d.]+)/gu)) {
    if (match.groups?.edge === "start") {
      freezeStart = Number(match.groups.seconds);
    } else if (freezeStart !== null) {
      freezes.push({ end: Number(match.groups?.seconds), start: freezeStart });
      freezeStart = null;
    }
  }
  // A hold can continue through the final recorded frame. Scene bounds below
  // provide its finite end, without including time after the trailer finished.
  if (freezeStart !== null) {
    freezes.push({ end: Infinity, start: freezeStart });
  }
  return { freezes, syncEnd: Number(marker.groups?.end) };
};

const timelineOf = (recording) => {
  const { timeline } = recording;
  if (!Array.isArray(timeline) || timeline.length === 0) {
    throw new Error("Trailer reported no scene timeline");
  }
  return timeline.map((entry) => {
    if (
      !/^[a-z][a-z0-9-]*$/u.test(entry.id) ||
      !Number.isFinite(entry.startMs) ||
      !Number.isFinite(entry.endMs) ||
      entry.endMs <= entry.startMs
    ) {
      throw new Error(`Invalid scene timeline: ${JSON.stringify(entry)}`);
    }
    return { endMs: entry.endMs, id: entry.id, startMs: entry.startMs };
  });
};

const encode = async (recording, output) => {
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
  const [source] = JSON.parse(sourceProbe).streams;
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
      if (endFrame <= startFrame) {
        return;
      }
      segments.push({
        audioStart: audioStart + (startFrame - firstFrame) / frameRate,
        duration: (endFrame - startFrame) / frameRate,
        id: entry.id,
        start: cursorFrames / frameRate,
        videoEnd: endFrame / frameRate,
        videoStart: startFrame / frameRate,
      });
      cursorFrames += endFrame - startFrame;
    };
    for (const freeze of freezes) {
      const startFrame = Math.max(firstFrame, frameAt(freeze.start));
      const endFrame = Math.min(lastFrame, frameAt(freeze.end));
      // Only remove a hold when at least 240 ms lies inside this visible shot.
      // Retain its first frame; everything removed has the same captured image.
      if (endFrame - startFrame < Math.ceil(0.24 * frameRate)) {
        continue;
      }
      const removeFrom = Math.max(keptFrom, startFrame + 1);
      if (endFrame <= removeFrom) {
        continue;
      }
      keep(keptFrom, removeFrom);
      removedStalls.push({
        audioStart: audioStart + (removeFrom - firstFrame) / frameRate,
        duration: (endFrame - removeFrom) / frameRate,
        id: entry.id,
        videoEnd: endFrame / frameRate,
        videoStart: removeFrom / frameRate,
      });
      keptFrom = endFrame;
    }
    keep(keptFrom, lastFrame);
    return {
      duration: (cursorFrames - shotStartFrame) / frameRate,
      id: entry.id,
      start: shotStartFrame / frameRate,
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
    `${segments
      .map((_, i) => `[v${i}][a${i}]`)
      .join("")}concat=n=${segments.length}:v=1:a=1[video][audio]`,
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
  if (!video || video.width !== 1920 || video.height !== 1080 || !audio) {
    throw new Error("Encoded master must contain 1080p video and audio");
  }
  if (Number(video.nb_frames) !== cursorFrames) {
    throw new Error(`Encoded master has ${video.nb_frames} frames; expected ${cursorFrames}`);
  }
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
    if (!keyframes.some((time) => Math.abs(time - shot.start) < 0.001)) {
      throw new Error(`Missing exact shot-start keyframe for ${shot.id}`);
    }
  }
  const { stderr } = await exec(
    "ffmpeg",
    ["-hide_banner", "-i", output, "-af", "volumedetect", "-vn", "-f", "null", "-"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const peak = /max_volume:\s*(?<decibels>-?[\d.]+) dB/u.exec(stderr);
  const audioPeakDb = Number(peak?.groups?.decibels);
  if (!Number.isFinite(audioPeakDb) || audioPeakDb < -50) {
    throw new Error("Recorded game audio is silent or inaudible");
  }
  return {
    alignment: {
      accuracy: "One recorded frame (approximately 40 ms), plus audio encoder latency",
      markerEndVideoSeconds: syncEnd,
      removedStallSeconds: removedStalls.reduce((sum, stall) => sum + stall.duration, 0),
      removedStalls,
      segments,
      shotStartKeyframesVerified: true,
      stagingGapsRemoved: true,
      stallDetection:
        "Freezedetect -60 dB, at least 240 ms inside a shot; first held frame retained",
    },
    audioPeakDb,
    duration: Number(media.format.duration),
    errors: recording.errors,
    file: output,
    frameRate: video.avg_frame_rate,
    height: video.height,
    timeline: editedTimeline,
    warnings: recording.warnings,
    width: video.width,
  };
};

const extractShots = async (master, output) => {
  await mkdir(output, { recursive: true });
  const shots = [];
  for (let i = 0; i < master.timeline.length; i += 1) {
    const shot = master.timeline[i];
    const name = `${String(i + 1).padStart(2, "0")}-${shot.id.replaceAll(/[^a-z0-9-]/giu, "-")}`;
    const clip = path.join(output, `${name}.mp4`);
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
    const { streams } = JSON.parse(clipProbe);
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
      const still = path.join(output, `${name}-${label}.jpg`);
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
    shots.push({ ...shot, copiedFrames: expectedFrames, file: clip, still: stills[1], stills });
  }
  if (shots.length > 1) {
    const filter = `${shots.map((_, i) => `[${i}:v]scale=480:270[t${i}]`).join(";")};${shots
      .map((_, i) => `[t${i}]`)
      .join("")}xstack=inputs=${shots.length}:layout=${shots
      .map((_, i) => `${(i % 4) * 486}_${Math.floor(i / 4) * 276}`)
      .join("|")}:fill=black[out]`;
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
        path.join(output, "contact-sheet.jpg"),
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
  }
  return shots;
};

const loadRecording = async (folder) => {
  const saved = await readFile(path.join(folder, "capture.json"), "utf-8");
  return {
    ...JSON.parse(saved),
    audio: path.join(folder, "audio.webm"),
    video: await recordedVideo(folder),
  };
};

const main = async () => {
  const config = options(process.argv.slice(2));
  if (!config) {
    return;
  }
  await exec("ffmpeg", ["-version"]);
  await exec("ffprobe", ["-version"]);
  const output = path.resolve(config.out);
  await mkdir(output, { recursive: true });
  const scratch = config.reencode
    ? path.resolve(config.reencode)
    : await mkdtemp(path.join(tmpdir(), "waymo-trailer-"));
  let server = null;
  let browser = null;
  let complete = false;
  const report = {
    clean: null,
    publication: null,
    recorder: "Playwright headed Chrome, native ~25fps video; captured game WebAudio",
    startedAt: new Date().toISOString(),
    viewport,
  };
  try {
    let baseUrl = config.url;
    if (!baseUrl && !config.reencode) {
      await run("pnpm", ["--filter", "@repo/crazy-waymo", "build"], repoDir);
      const source = await readFile(path.join(gameDir, "vite.config.ts"), "utf-8");
      const match = /port:\s*(?<port>\d+)/u.exec(source);
      const port = Number(match?.groups?.port ?? "5193") + 400;
      baseUrl = `http://localhost:${port}/`;
      server = spawn("pnpm", ["exec", "vite", "preview", "--port", String(port), "--strictPort"], {
        cwd: gameDir,
        detached: true,
        stdio: "ignore",
      });
      await waitForServer(baseUrl);
    }
    if (!config.reencode) {
      browser = await chromium.launch({ channel: "chrome", headless: false });
    }
    const recordingFor = (clean) => {
      const folder = path.join(scratch, clean ? "clean" : "publication");
      if (config.reencode) {
        return loadRecording(folder);
      }
      if (!browser || !baseUrl) {
        throw new Error("Capture browser was not initialized");
      }
      return capture(browser, baseUrl, folder, { clean, scene: config.scene });
    };
    const publication = await recordingFor(false);
    report.publication = await encode(publication, path.join(output, "crazy-waymo-trailer.mp4"));
    report.publication.shots = await extractShots(report.publication, path.join(output, "review"));
    if (config.clean) {
      const clean = await recordingFor(true);
      report.clean = await encode(clean, path.join(output, "crazy-waymo-clean.mp4"));
      report.clean.shots = await extractShots(report.clean, path.join(output, "clean-shots"));
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
      path.join(output, "report.json"),
      `${JSON.stringify({ ...report, complete, rawCapture: scratch }, null, 2)}\n`,
    );
    console.log(
      `[capture] Raw evidence retained at ${scratch}; use --reencode to revise the edit without recording again`,
    );
  }
};

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
