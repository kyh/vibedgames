import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, describe, test } from "node:test";

import { z } from "zod";

import { exec } from "./exec";
import { findTools, runRecipe } from "./index";

const tools = findTools();

const skip =
  tools.ffmpeg !== undefined && tools.ffprobe !== undefined ? false : "ffmpeg is not installed";

const dir = mkdtempSync(path.join(tmpdir(), "recipes-test-"));
const at = (name: string) => path.join(dir, name);

const ffmpeg = async (...args: string[]) =>
  await exec(tools.ffmpeg ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

const fixtures = async () => {
  await ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=160x90:rate=30:duration=2",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:size=160x90:rate=30:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1[v]",
    "-map",
    "[v]",
    "-map",
    "2:a",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    at("clip.mp4"),
  );
  await ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono:d=0.5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:duration=1:sample_rate=48000",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono:d=0.5",
    "-filter_complex",
    "[0:a][1:a][2:a]concat=n=3:v=0:a=1,volume=-20dB[a]",
    "-map",
    "[a]",
    at("take.wav"),
  );
  mkdirSync(at("frames"));
  await ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x48:rate=10:duration=1",
    path.join(at("frames"), "%03d.png"),
  );
};

describe("recipes on local ffmpeg", { skip }, () => {
  before(fixtures);

  test("video-probe reports length, the cut, the silence-free audio and stills", async () => {
    const { outputs, result } = await runRecipe("video-probe", {
      files: { video_url: at("clip.mp4") },
      params: { frames: [0, 75] },
      tools,
    });

    const info = z
      .object({
        cuts: z.array(z.number()),
        fps: z.number(),
        frame_count: z.number(),
        has_audio: z.boolean(),
      })
      .parse(result);

    assert.equal(info.frame_count, 90);
    assert.equal(info.fps, 30);
    assert.equal(info.has_audio, true);
    assert.ok(
      info.cuts.some((t) => Math.abs(t - 2) < 0.1),
      String(info.cuts),
    );
    assert.deepEqual(
      outputs.map((o) => o.name),
      ["frame-0.png", "frame-75.png"],
    );
  });

  test("audio-master trims, normalises and encodes", async () => {
    const { outputs, result } = await runRecipe("audio-master", {
      files: { audio_url: at("take.wav") },
      params: { format: "ogg", lufs: -16 },
      tools,
    });

    const info = z
      .object({ duration_seconds: z.number(), output: z.object({ integrated: z.number() }) })
      .parse(result);

    assert.deepEqual(
      outputs.map((o) => o.name),
      ["audio.ogg"],
    );
    assert.ok(info.duration_seconds < 1.2, `${info.duration_seconds} s left after trim`);
    assert.ok(Math.abs(info.output.integrated + 16) < 1.5, `${info.output.integrated} LUFS`);
  });

  test("video-probe measures an audio-only file", async () => {
    const { result } = await runRecipe("video-probe", {
      files: { video_url: at("take.wav") },
      params: {},
      tools,
    });

    const info = z
      .object({
        frame_count: z.number(),
        loudness: z.object({ integrated: z.number() }).nullable(),
      })
      .parse(result);

    assert.equal(info.frame_count, 0);
    assert.ok(info.loudness, "no loudness for the audio");
  });

  test("audio-master names its output and reports only what it wrote into a shared folder", async () => {
    const out = at("shared");
    mkdirSync(out);
    writeFileSync(path.join(out, "keep.txt"), "already here");

    const { outputs } = await runRecipe("audio-master", {
      files: { audio_url: at("take.wav") },
      out,
      params: { format: "mp3", mono: true, name: "jump" },
      tools,
    });

    assert.deepEqual(
      outputs.map((o) => o.name),
      ["jump.mp3"],
    );
  });

  test("frames-to-video encodes a folder of frames in order", async () => {
    const { outputs, result } = await runRecipe("frames-to-video", {
      files: { frames_url: at("frames") },
      params: { fps: 10 },
      tools,
    });

    assert.equal(z.object({ frames: z.number() }).parse(result).frames, 10);
    assert.equal(outputs[0]?.name, "video.mp4");
  });

  test("video-to-sheet tiles sampled frames", async () => {
    const { result } = await runRecipe("video-to-sheet", {
      files: { video_url: at("clip.mp4") },
      params: { cell_width: 32, columns: 4, fps: 4, max_frames: 8 },
      tools,
    });

    assert.deepEqual(result, {
      cell_height: 18,
      cell_width: 32,
      columns: 4,
      fps: 4,
      frames: 8,
      rows: 2,
      start_seconds: 0,
    });
  });

  test("trailer-render cuts, crossfades and lays music under the edit", async () => {
    const { outputs, result } = await runRecipe("trailer-render", {
      files: { music_url: at("take.wav"), video_urls: [at("clip.mp4")] },
      params: {
        clips: [
          { in_seconds: 0, out_seconds: 1, video: 0 },
          { in_seconds: 2, out_seconds: 3, video: 0 },
        ],
        crossfade_seconds: 0.25,
        fps: 30,
        height: 144,
        width: 256,
      },
      tools,
    });

    const info = z.object({ duration_seconds: z.number(), loudness: z.unknown() }).parse(result);

    assert.equal(outputs[0]?.name, "trailer.mp4");
    assert.ok(Math.abs(info.duration_seconds - 1.75) < 0.1, `${info.duration_seconds} s`);
    assert.notEqual(info.loudness, null);
  });

  test("refuses parameters out of range before running anything", async () => {
    await assert.rejects(
      runRecipe("video-to-sheet", {
        files: { video_url: at("clip.mp4") },
        params: { columns: 99 },
        tools,
      }),
      /columns/u,
    );
  });

  test("image-to-threejs returns the files a script wrote", async () => {
    const root = at("i2t");
    mkdirSync(path.join(root, "forge", "stage0"), { recursive: true });
    writeFileSync(
      path.join(root, "forge", "stage0", "next.py"),
      "import sys\nopen('out/'+sys.argv[1],'w').write(open('spec.json').read().upper())\nprint('ok')\n",
    );
    writeFileSync(at("spec.json"), '{"a":1}');

    const { outputs, result } = await runRecipe("image-to-threejs", {
      files: { file_urls: { "out/keep.txt": at("spec.json"), "spec.json": at("spec.json") } },
      params: { args: ["copy.json"], script: "next.py" },
      tools: { ...tools, img2threejs: root, uv: undefined },
    });

    assert.equal(z.object({ exit_code: z.number() }).parse(result).exit_code, 0);
    assert.deepEqual(
      outputs.map((o) => o.name),
      ["out/copy.json"],
    );
    assert.equal(readFileSync(outputs[0]?.path ?? "", "utf-8"), '{"A":1}');
  });
});
