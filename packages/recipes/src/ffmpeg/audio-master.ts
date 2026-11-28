import path from "node:path";

import type { RecipeInput } from "@repo/contract/asset/recipe-schema";

import type { RecipeContext } from "../recipe";
import { need, one, RecipeError } from "../recipe";
import { loudnormStats, measureLoudness, probe, roundTo } from "./probe";

const CODECS = {
  m4a: ["-c:a", "aac", "-b:a", "160k"],
  mp3: ["-c:a", "libmp3lame", "-q:a", "2"],
  ogg: ["-c:a", "libopus", "-b:a", "96k"],
  wav: ["-c:a", "pcm_s16le"],
} as const;

export const audioMaster = async (ctx: RecipeContext<RecipeInput<"audio-master">>) => {
  const ffmpeg = need(ctx.tools.ffmpeg, "ffmpeg");
  const source = one(ctx.files, "audio_url");
  const p = ctx.params;
  const input = await probe(ctx, source);

  if (!input.hasAudio) {
    throw new RecipeError("audio_url has no audio stream.");
  }

  const trim = `silenceremove=start_periods=1:start_threshold=${p.trim_db}dB,areverse,silenceremove=start_periods=1:start_threshold=${p.trim_db}dB,areverse`;
  const channels = p.mono ? ["-ac", "1"] : [];
  const trimmed = path.join(ctx.work, "trimmed.wav");

  await ctx.run(ffmpeg, [
    "-hide_banner",
    "-y",
    "-i",
    source,
    "-vn",
    "-af",
    trim,
    ...channels,
    "-c:a",
    "pcm_f32le",
    trimmed,
  ]);

  const trimmedInfo = await probe(ctx, trimmed);

  if (trimmedInfo.duration <= 0.01) {
    throw new RecipeError(
      `Nothing in audio_url is louder than trim_db (${p.trim_db} dB); lower trim_db.`,
    );
  }

  const target = `I=${p.lufs}:TP=${p.true_peak}:LRA=11`;

  const pass1 = await ctx.run(ffmpeg, [
    "-hide_banner",
    "-nostats",
    "-i",
    trimmed,
    "-af",
    `loudnorm=${target}:print_format=json`,
    "-f",
    "null",
    "-",
  ]);

  const m = loudnormStats(pass1.stderr);
  const measured = `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`;

  const fadeOut = p.fade_out_ms / 1000;

  const fades = [
    p.fade_in_ms > 0 ? `afade=t=in:d=${p.fade_in_ms / 1000}` : "",
    fadeOut > 0 ? `afade=t=out:st=${Math.max(0, trimmedInfo.duration - fadeOut)}:d=${fadeOut}` : "",
  ].filter(Boolean);

  const output = path.join(ctx.out, `${p.name}.${p.format}`);

  await ctx.run(ffmpeg, [
    "-hide_banner",
    "-y",
    "-i",
    trimmed,
    "-af",
    [
      `loudnorm=${target}:${measured}:linear=true`,
      "aresample=48000",
      `aformat=channel_layouts=${p.mono ? "mono" : "stereo"}`,
      ...fades,
    ].join(","),
    ...CODECS[p.format],
    output,
  ]);

  const result = await measureLoudness(ctx, output);
  const outputInfo = await probe(ctx, output);

  return {
    outputs: [],
    result: {
      duration_seconds: roundTo(outputInfo.duration, 3),
      input: {
        integrated: roundTo(Number(m.input_i), 1),
        lra: roundTo(Number(m.input_lra), 1),
        true_peak: roundTo(Number(m.input_tp), 1),
      },
      output: {
        integrated: roundTo(result.integrated, 1),
        lra: roundTo(result.lra, 1),
        true_peak: roundTo(result.true_peak, 1),
      },
      trimmed_seconds: roundTo(input.duration - trimmedInfo.duration, 3),
    },
  };
};
