import path from "node:path";

import type { RecipeInput } from "@repo/contract/asset/recipe-schema";
import { runInOrder } from "@repo/contract/run-in-order";

import type { JsonValue, RecipeContext } from "../recipe";
import { need, one } from "../recipe";
import { measureLoudness, probe, roundTo } from "./probe";

const times = (stderr: string, pattern: RegExp) =>
  [...stderr.matchAll(pattern)].map((match) => Number(match.groups?.t));

export const videoProbe = async (ctx: RecipeContext<RecipeInput<"video-probe">>) => {
  const ffmpeg = need(ctx.tools.ffmpeg, "ffmpeg");
  const video = one(ctx.files, "video_url");
  const info = await probe(ctx, video, true);
  const { params } = ctx;
  const base = ["-hide_banner", "-nostats", "-i", video];

  const videoPass = async (filter: string) => {
    if (!info.hasVideo) {
      return "";
    }

    const pass = await ctx.run(ffmpeg, [...base, "-an", "-vf", filter, "-f", "null", "-"]);

    return pass.stderr;
  };

  const scenes = await videoPass(`select='gt(scene,${params.scene_threshold})',showinfo`);
  const decimated = await videoPass("mpdecimate,showinfo");
  const kept = (decimated.match(/\] n:\s*\d+/gu) ?? []).length;

  let silences: JsonValue = [];
  let loudness: JsonValue = null;

  if (info.hasAudio) {
    const silence = await ctx.run(ffmpeg, [
      ...base,
      "-vn",
      "-af",
      `silencedetect=n=${params.silence_db}dB:d=${params.silence_min_seconds}`,
      "-f",
      "null",
      "-",
    ]);

    const starts = times(silence.stderr, /silence_start: (?<t>-?[\d.]+)/gu);
    const ends = times(silence.stderr, /silence_end: (?<t>-?[\d.]+)/gu);
    silences = starts.map((start, i) => ({
      end: roundTo(ends[i] ?? info.duration, 3),
      start: roundTo(Math.max(0, start), 3),
    }));
    const measured = await measureLoudness(ctx, video);
    loudness = {
      integrated: roundTo(measured.integrated, 1),
      lra: roundTo(measured.lra, 1),
      true_peak: roundTo(measured.true_peak, 1),
    };
  }

  const frameCount = info.frames ?? 0;
  const wanted = [...new Set(params.frames)].filter((index) => index < frameCount);

  const stills = await runInOrder(wanted, async (index) => {
    const name = `frame-${index}.png`;
    await ctx.run(ffmpeg, [
      ...base,
      "-an",
      "-vf",
      `select=eq(n\\,${index})`,
      "-frames:v",
      "1",
      "-y",
      path.join(ctx.out, name),
    ]);

    return name;
  });

  return {
    outputs: [],
    result: {
      cuts: times(scenes, /pts_time:\s*(?<t>[\d.]+)/gu).map((t) => roundTo(t, 3)),
      duplicate_frames: info.hasVideo ? Math.max(0, frameCount - kept) : 0,
      duration_seconds: roundTo(info.duration, 3),
      fps: info.fps,
      frame_count: frameCount,
      has_audio: info.hasAudio,
      height: info.height,
      loudness,
      silences,
      skipped_frames: params.frames.filter((index) => index >= frameCount),
      stills,
      width: info.width,
    },
  };
};
