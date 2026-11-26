import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { poll } from "@repo/smoke";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { z } from "zod";

import { inOrder } from "../src/shared/paced.ts";
import type { TrailerState } from "../src/trailer/trailer-shell.ts";
import { execFileText as exec } from "./exec-file.mts";

declare global {
  interface Window {
    captureAudio?: { start: () => number; stop: () => Promise<string> };
  }
}

interface CaptureOptions {
  clean: boolean;
  out: string;
  reencode: string | null;
  scene: string | null;
  url: string | null;
}

const timelineEntrySchema = z.object({ endMs: z.number(), id: z.string(), startMs: z.number() });

const recordingSchema = z.object({
  audioStartedAtMs: z.number(),
  errors: z.array(z.string()),
  markerEndedAtMs: z.number(),
  timeline: z.array(timelineEntrySchema),
  warnings: z.array(z.string()),
});

interface TrailerReport<Run> {
  clean: Run | null;
  publication: Run | null;
  recorder: string;
  startedAt: string;
  viewport: typeof viewport;
}

type Recording = z.infer<typeof recordingSchema> & { audio: string; video: string };

const sourceProbeSchema = z.object({
  streams: z.array(z.object({ avg_frame_rate: z.string(), r_frame_rate: z.string() })),
});

const streamSchema = z.object({
  avg_frame_rate: z.string().optional(),
  codec_type: z.string(),
  height: z.number().optional(),
  nb_frames: z.string().optional(),
  start_time: z.string().optional(),
  width: z.number().optional(),
});

const mediaSchema = z.object({
  format: z.object({ duration: z.string() }),
  streams: z.array(streamSchema),
});

const keyframeSchema = z.object({ frames: z.array(z.object({ pts_time: z.string() })) });
const gameDir = path.resolve(import.meta.dirname, "..");
const repoDir = path.resolve(gameDir, "../..");
const viewport = { height: 1080, width: 1920 };

const options = (argv: readonly string[]) => {
  const result: CaptureOptions = {
    clean: true,
    out: "/tmp/crazy-waymo-trailer",
    reencode: null,
    scene: null,
    url: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";

    if (flag === "--help") {
      console.log(
        "Capture real Crazy Waymo gameplay at 1920x1080 with game audio.\n" +
          "Usage: node tools/capture-trailer.mts [--out DIR] [--url URL] [--no-clean] [--scene ID] [--reencode RAW_DIR]\n" +
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

    i += 1;
    const value = argv[i];

    if (value === undefined || value === "" || value.startsWith("--")) {
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

const run = async (command: string, args: readonly string[], cwd: string) => {
  const { promise, resolve, reject } = Promise.withResolvers<null>();
  const child = spawn(command, args, { cwd, stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code) => {
    if (code === 0) {
      resolve(null);
    } else {
      reject(new Error(`${command} exited ${String(code)}`));
    }
  });

  return await promise;
};

const answers = async (url: string) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });

    return response.ok;
  } catch {
    return false;
  }
};

const waitForServer = async (url: string) => {
  const up = await poll(
    async () => await answers(url),
    (ok) => ok,
    {
      intervalMs: 250,
      timeoutMs: 60_000,
    },
  );

  if (up === null) {
    throw new Error(`Preview did not start: ${url}`);
  }
};

const installAudioCapture = () => {
  // oxlint-disable-next-line typescript/unbound-method -- the native connect is kept so the patched one can call it bound to each node
  const nativeConnect: AudioNode["connect"] = AudioNode.prototype.connect;

  let capture: { context: AudioContext; sink: MediaStreamAudioDestinationNode } | null = null;
  const tapped = new WeakSet<AudioNode>();

  const tap = (node: AudioNode) => {
    if (!(node.context instanceof AudioContext)) {
      return;
    }

    capture ??= { context: node.context, sink: node.context.createMediaStreamDestination() };

    if (capture.context === node.context && !tapped.has(node)) {
      node.connect(capture.sink);
      tapped.add(node);
    }
  };

  Object.defineProperty(AudioNode.prototype, "connect", {
    configurable: true,
    value(this: AudioNode, destination: AudioNode | AudioParam, output?: number, input?: number) {
      const connect = nativeConnect.bind(this);
      let result: AudioNode | undefined;

      if (destination instanceof AudioParam) {
        connect(destination, output);
      } else {
        result = connect(destination, output, input);

        if (destination instanceof AudioDestinationNode) {
          tap(this);
        }
      }

      return result;
    },
    writable: true,
  });

  let recorder: MediaRecorder | null = null;
  let stopped: Promise<string> | null = null;
  const chunks: Blob[] = [];

  const encodeChunks = async (mimeType: string) => {
    const blob = new Blob(chunks, { type: mimeType });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";

    for (let i = 0; i < bytes.length; i += 32_768) {
      binary += String.fromCodePoint(...bytes.subarray(i, i + 32_768));
    }

    return btoa(binary);
  };

  const settle = async (finished: PromiseWithResolvers<string>, mimeType: string) => {
    try {
      finished.resolve(await encodeChunks(mimeType));
    } catch (error) {
      finished.reject(error);
    }
  };

  window.captureAudio = {
    start() {
      if (!capture || capture.context.state !== "running") {
        throw new Error("Game audio is not running; the trusted start gesture did not unlock it");
      }

      const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find((mime) =>
        MediaRecorder.isTypeSupported(mime),
      );

      if (mimeType === undefined || mimeType === "") {
        throw new Error("Chrome does not support WebM audio recording");
      }

      const active = new MediaRecorder(capture.sink.stream, {
        audioBitsPerSecond: 192_000,
        mimeType,
      });

      const finished = Promise.withResolvers<string>();
      active.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      });
      active.addEventListener("error", () => {
        finished.reject(new Error("Audio recorder failed"));
      });
      active.addEventListener("stop", () => {
        void settle(finished, mimeType);
      });
      recorder = active;
      stopped = finished.promise;
      const startedAtMs = performance.now();
      active.start(1000);

      return startedAtMs;
    },
    async stop() {
      if (!recorder || !stopped) {
        throw new Error("Audio recording was not started");
      }

      recorder.stop();

      return await stopped;
    },
  };
};

const captureUrl = (
  baseUrl: string,
  { clean, scene }: { clean: boolean; scene: string | null },
) => {
  const url = new URL(baseUrl);
  url.searchParams.set("trailer", "1");
  url.searchParams.set("manual", "1");
  url.searchParams.set("offline", "1");

  if (clean) {
    url.searchParams.set("clean", "1");
  } else {
    url.searchParams.delete("clean");
  }

  if (scene !== null && scene !== "") {
    url.searchParams.set("scene", scene);
  }

  return url;
};

const recordedVideo = async (folder: string) => {
  const entries = await readdir(folder);
  const videos = entries.filter((name) => name.endsWith(".webm") && name !== "audio.webm");

  if (videos.length !== 1) {
    throw new Error(`Expected one recorded video in ${folder}; found ${videos.length}`);
  }

  const [video = ""] = videos;

  return path.join(folder, video);
};

const flushAudio = async (page: Page, folder: string) => {
  try {
    const encoded = await page.evaluate(async () => {
      if (!window.captureAudio) {
        throw new Error("Audio capture was not installed");
      }

      return await window.captureAudio.stop();
    });

    await writeFile(path.join(folder, "audio.webm"), Buffer.from(encoded, "base64"));

    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const readTrailer = async (page: Page) =>
  await page.evaluate(() => ({ now: performance.now(), state: window.__trailer ?? null }));

const capture = async (
  browser: Browser,
  baseUrl: string,
  folder: string,
  { clean, scene }: { clean: boolean; scene: string | null },
) => {
  await mkdir(folder, { recursive: true });
  const url = captureUrl(baseUrl, { clean, scene });
  const errors: string[] = [];
  const warnings: string[] = [];

  const context = await browser.newContext({
    deviceScaleFactor: 1,
    recordVideo: { dir: folder, size: viewport },
    viewport,
  });

  const page = await context.newPage();
  page.on("pageerror", (error) => {
    errors.push(String(error));
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }

    if (message.type() === "warning") {
      warnings.push(message.text());
    }
  });
  await page.addInitScript(installAudioCapture);
  let state: (TrailerState & { finishedAtMs: number }) | null = null;
  let audioStartedAtMs: number | null = null;
  let markerEndedAtMs: number | null = null;
  let captureFailure: string | null = null;
  let audioFailure: string | null = null;

  try {
    console.log(`[capture] ${clean ? "clean references" : "publication"}: loading`);
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    await page.waitForFunction(
      () => window.__trailer?.phase === "ready" || window.__trailer?.phase === "error",
      null,
      { timeout: 240_000 },
    );
    const ready = await page.evaluate(() => window.__trailer ?? null);

    if (ready === null || ready.phase === "error") {
      throw new Error(`Trailer failed while loading: ${JSON.stringify(ready)}`);
    }

    await page.evaluate(() => {
      const marker = document.createElement("div");
      marker.id = "capture-sync";
      marker.style.cssText =
        "position:fixed;inset:0;background:#fff;z-index:2147483647;pointer-events:none";
      document.body.append(marker);
    });
    await page.mouse.click(960, 540);
    await wait(1500);
    audioStartedAtMs = await page.evaluate(() => {
      if (!window.captureAudio) {
        throw new Error("Audio capture was not installed");
      }

      return window.captureAudio.start();
    });
    await wait(600);
    markerEndedAtMs = await page.evaluate(() => {
      if (!window.__trailerStart) {
        throw new Error("Missing manual trailer start API");
      }

      document.querySelector("#capture-sync")?.remove();
      const now = performance.now();
      window.__trailerStart();

      return now;
    });
    let lastId = "";
    const deadline = Date.now() + 360_000;

    const follow: () => Promise<void> = async () => {
      const read = await readTrailer(page);

      if (read.state === null) {
        throw new Error("Trailer state disappeared");
      }

      state = { ...read.state, finishedAtMs: read.now };

      if (read.state.sceneId !== lastId) {
        lastId = read.state.sceneId;
        console.log(`[capture] ${lastId === "" ? read.state.phase : lastId}`);
      }

      if (read.state.phase === "error") {
        throw new Error(`Trailer failed: ${JSON.stringify(read.state)}`);
      }

      if (read.state.done) {
        return;
      }

      if (Date.now() > deadline) {
        throw new Error("Trailer did not complete within six minutes");
      }

      await wait(40);
      await follow();
    };

    await follow();

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
    if (captureFailure !== null && captureFailure !== "" && !page.isClosed()) {
      try {
        const snapshot = await readTrailer(page);

        if (snapshot.state !== null) {
          state = { ...snapshot.state, finishedAtMs: snapshot.now };
        }
      } catch (snapshotError) {
        console.warn(`final trailer state unreadable: ${String(snapshotError)}`);
      }
    }

    if (audioStartedAtMs !== null && !page.isClosed()) {
      audioFailure = await flushAudio(page, folder);
    }

    const saved = {
      ...state,
      audioFailure,
      audioStartedAtMs,
      captureFailure,
      errors,
      markerEndedAtMs,
      warnings,
    };

    await writeFile(path.join(folder, "capture.json"), `${JSON.stringify(saved, null, 2)}\n`);
    await context.close();
  }

  if (audioFailure !== null && audioFailure !== "") {
    throw new Error(`Audio capture failed: ${audioFailure}`);
  }

  return {
    ...recordingSchema.parse({ ...state, audioStartedAtMs, errors, markerEndedAtMs, warnings }),
    audio: path.join(folder, "audio.webm"),
    video: await recordedVideo(folder),
  };
};

const scanRecording = async (video: string) => {
  const { stderr } = await exec("ffmpeg", [
    "-hide_banner",
    "-i",
    video,
    "-vf",
    "freezedetect=n=-60dB:d=0.24,negate,blackdetect=d=0.4:pic_th=0.999:pix_th=0.04",
    "-an",
    "-f",
    "null",
    "-",
  ]);

  const intervals = [
    ...stderr.matchAll(
      /black_start:\s*(?<start>[\d.]+)\s+black_end:\s*(?<end>[\d.]+)\s+black_duration:\s*(?<duration>[\d.]+)/gu,
    ),
  ];

  const marker = intervals.findLast((match) => Number(match.groups?.duration) >= 1.6);

  if (!marker) {
    throw new Error("Video sync plate was not detected; refusing guessed alignment");
  }

  const freezes: { end: number; start: number }[] = [];
  let freezeStart: number | null = null;

  for (const match of stderr.matchAll(/freeze_(?<edge>start|end):\s*(?<seconds>[\d.]+)/gu)) {
    if (match.groups?.edge === "start") {
      freezeStart = Number(match.groups.seconds);
    } else if (freezeStart !== null) {
      freezes.push({ end: Number(match.groups?.seconds), start: freezeStart });
      freezeStart = null;
    }
  }

  if (freezeStart !== null) {
    freezes.push({ end: Infinity, start: freezeStart });
  }

  return { freezes, syncEnd: Number(marker.groups?.end) };
};

const timelineOf = (recording: Recording) => {
  const { timeline } = recording;

  if (timeline.length === 0) {
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

const encode = async (recording: Recording, output: string) => {
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

  const [source] = sourceProbeSchema.parse(JSON.parse(sourceProbe)).streams;

  if (!source) {
    throw new Error("Capture video has no video stream");
  }

  const [numerator = Number.NaN, denominator = Number.NaN] = source.avg_frame_rate
    .split("/")
    .map(Number);

  const frameRate = numerator / denominator;

  if (
    !Number.isFinite(frameRate) ||
    frameRate <= 0 ||
    source.avg_frame_rate !== source.r_frame_rate
  ) {
    throw new Error("Capture video must have a finite constant frame rate");
  }

  let cursorFrames = 0;

  const segments: {
    audioStart: number;
    duration: number;
    id: string;
    start: number;
    videoEnd: number;
    videoStart: number;
  }[] = [];

  const removedStalls: {
    audioStart: number;
    duration: number;
    id: string;
    videoEnd: number;
    videoStart: number;
  }[] = [];

  const frameAt = (seconds: number) => Math.ceil(seconds * frameRate - 0.00001);

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

    const keep = (startFrame: number, endFrame: number) => {
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

  await exec("ffmpeg", [
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
  ]);

  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    output,
  ]);

  const media = mediaSchema.parse(JSON.parse(stdout));
  const video = media.streams.find((stream) => stream.codec_type === "video");
  const audio = media.streams.find((stream) => stream.codec_type === "audio");

  if (
    !video ||
    video.width !== 1920 ||
    video.height !== 1080 ||
    !audio ||
    video.avg_frame_rate === undefined
  ) {
    throw new Error("Encoded master must contain 1080p video and audio");
  }

  if (Number(video.nb_frames) !== cursorFrames) {
    throw new Error(
      `Encoded master has ${video.nb_frames ?? "no"} frames; expected ${cursorFrames}`,
    );
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

  const keyframes = keyframeSchema
    .parse(JSON.parse(keyframeProbe))
    .frames.map((frame) => Number(frame.pts_time));

  for (const shot of editedTimeline) {
    if (!keyframes.some((time) => Math.abs(time - shot.start) < 0.001)) {
      throw new Error(`Missing exact shot-start keyframe for ${shot.id}`);
    }
  }

  const { stderr } = await exec("ffmpeg", [
    "-hide_banner",
    "-i",
    output,
    "-af",
    "volumedetect",
    "-vn",
    "-f",
    "null",
    "-",
  ]);

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

type Master = Awaited<ReturnType<typeof encode>>;

const extractShots = async (master: Master, output: string) => {
  await mkdir(output, { recursive: true });

  const shots: (Master["timeline"][number] & {
    copiedFrames: number;
    file: string;
    still: string | undefined;
    stills: string[];
  })[] = [];

  for await (const [i, shot] of inOrder(master.timeline.entries())) {
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

    const { streams } = z.object({ streams: z.array(streamSchema) }).parse(JSON.parse(clipProbe));
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");

    const [numerator = Number.NaN, denominator = Number.NaN] = master.frameRate
      .split("/")
      .map(Number);

    const expectedFrames = Math.round((shot.duration * numerator) / denominator);

    if (
      !video ||
      !audio ||
      Number(video.nb_frames) !== expectedFrames ||
      Math.abs(Number(video.start_time)) > 0.001
    ) {
      throw new Error(`Stream-copy boundaries failed for ${shot.id}`);
    }

    const stills: string[] = [];

    const marks = [
      ["start", 0.12],
      ["mid", 0.5],
      ["end", 0.88],
    ] as const;

    for await (const [label, fraction] of inOrder(marks)) {
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

    await exec("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...shots.flatMap((shot) => ["-i", shot.still ?? ""]),
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      "-frames:v",
      "1",
      path.join(output, "contact-sheet.jpg"),
    ]);
  }

  return shots;
};

const loadRecording = async (folder: string) => {
  const saved = await readFile(path.join(folder, "capture.json"), "utf-8");

  return {
    ...recordingSchema.parse(JSON.parse(saved)),
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

  const scratch =
    config.reencode === null || config.reencode === ""
      ? await mkdtemp(path.join(tmpdir(), "waymo-trailer-"))
      : path.resolve(config.reencode);

  const reencode = config.reencode !== null && config.reencode !== "";
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  let complete = false;

  type EncodedRun = Master & { shots: Awaited<ReturnType<typeof extractShots>> };

  const report: TrailerReport<EncodedRun> = {
    clean: null,
    publication: null,
    recorder: "Playwright headed Chrome, native ~25fps video; captured game WebAudio",
    startedAt: new Date().toISOString(),
    viewport,
  };

  try {
    let baseUrl = config.url;

    if ((baseUrl === null || baseUrl === "") && !reencode) {
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

    if (!reencode) {
      browser = await chromium.launch({ channel: "chrome", headless: false });
    }

    const recordingFor = async (clean: boolean) => {
      const folder = path.join(scratch, clean ? "clean" : "publication");

      if (reencode) {
        return await loadRecording(folder);
      }

      if (!browser || baseUrl === null || baseUrl === "") {
        throw new Error("Capture browser was not initialized");
      }

      return await capture(browser, baseUrl, folder, { clean, scene: config.scene });
    };

    const publication = await encode(
      await recordingFor(false),
      path.join(output, "crazy-waymo-trailer.mp4"),
    );

    report.publication = {
      ...publication,
      shots: await extractShots(publication, path.join(output, "review")),
    };

    if (config.clean) {
      const clean = await encode(
        await recordingFor(true),
        path.join(output, "crazy-waymo-clean.mp4"),
      );

      report.clean = {
        ...clean,
        shots: await extractShots(clean, path.join(output, "clean-shots")),
      };
    }

    complete = true;
    console.log(
      `[capture] Saved ${output}/crazy-waymo-trailer.mp4 (${publication.frameRate} fps, real audio)`,
    );
  } finally {
    await browser?.close();

    if (server !== null && server.pid !== undefined && server.pid !== 0) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch (killError) {
        console.warn(`dev server already gone: ${String(killError)}`);
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
