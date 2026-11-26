import path from "node:path";

import type { RecipeInput } from "@repo/contract/asset/recipe-schema";
import { runInOrder } from "@repo/contract/run-in-order";

import type { RecipeContext } from "../recipe";
import { many, maybe, need, RecipeError } from "../recipe";
import type { MediaInfo } from "./probe";
import { loudnormStats, measureLoudness, probe, roundTo } from "./probe";

const AUDIO_FORMAT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";

const filterPath = (file: string) => file.replaceAll("\\", "/").replaceAll(":", "\\\\:");

interface Plan {
  graph: string[];
  duration: number;
  audio: string | null;
}

const buildGraph = (
  params: RecipeInput<"trailer-render">,
  infos: readonly MediaInfo[],
  lut: string | undefined,
  musicIndex: number | null,
) => {
  const { clips, crossfade_seconds: xf, fps, height, width } = params;
  const graph: string[] = [];
  const durations: number[] = [];

  for (const [i, clip] of clips.entries()) {
    const info = infos[clip.video];

    if (!info) {
      throw new RecipeError(`clips[${i}].video is ${clip.video}, past the end of video_urls.`);
    }

    const end = Math.min(clip.out_seconds, info.duration);
    const length = end - clip.in_seconds;

    if (length <= 0) {
      throw new RecipeError(`clips[${i}] is empty: in_seconds must be before out_seconds.`);
    }

    if (xf > 0 && length <= xf) {
      throw new RecipeError(`clips[${i}] (${length.toFixed(2)} s) is shorter than the crossfade.`);
    }

    durations.push(length);
    graph.push(
      `[${clip.video}:v]trim=start=${clip.in_seconds}:end=${end},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`,
    );

    if (params.keep_clip_audio) {
      graph.push(
        info.hasAudio
          ? `[${clip.video}:a]atrim=start=${clip.in_seconds}:end=${end},asetpts=PTS-STARTPTS,${AUDIO_FORMAT}[a${i}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${length},${AUDIO_FORMAT}[a${i}]`,
      );
    }
  }

  const join = (kind: "v" | "a") => {
    if (clips.length === 1) {
      return `[${kind}0]`;
    }

    if (xf === 0) {
      const inputs = clips.map((_, i) => `[${kind}${i}]`).join("");
      graph.push(
        `${inputs}concat=n=${clips.length}:v=${kind === "v" ? 1 : 0}:a=${kind === "a" ? 1 : 0}[${kind}cat]`,
      );

      return `[${kind}cat]`;
    }

    let previous = `[${kind}0]`;
    let offset = 0;

    for (let i = 1; i < clips.length; i += 1) {
      offset += (durations[i - 1] ?? 0) - xf;
      const label = `[${kind}x${i}]`;
      graph.push(
        kind === "v"
          ? `${previous}[v${i}]xfade=transition=fade:duration=${xf}:offset=${roundTo(offset, 4)}${label}`
          : `${previous}[a${i}]acrossfade=d=${xf}${label}`,
      );
      previous = label;
    }

    return previous;
  };

  const duration = durations.reduce((sum, d) => sum + d, 0) - xf * (clips.length - 1);
  const joined = join("v");
  graph.push(
    lut === undefined ? `${joined}null[vout]` : `${joined}lut3d=file='${filterPath(lut)}'[vout]`,
  );

  const beds: string[] = [];

  if (params.keep_clip_audio) {
    beds.push(join("a"));
  }

  if (musicIndex !== null) {
    const fade = Math.min(1, duration / 4);
    graph.push(
      `[${musicIndex}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,${AUDIO_FORMAT},volume=${params.music_gain_db}dB,afade=t=out:st=${Math.max(0, duration - fade)}:d=${fade}[music]`,
    );
    beds.push("[music]");
  }

  let audio: string | null = null;

  if (beds.length === 1) {
    graph.push(`${beds[0]}anull[aout]`);
    audio = "[aout]";
  } else if (beds.length === 2) {
    graph.push(`${beds.join("")}amix=inputs=2:normalize=0:duration=first[aout]`);
    audio = "[aout]";
  }

  const plan: Plan = { audio, duration, graph };

  return plan;
};

export const trailerRender = async (ctx: RecipeContext<RecipeInput<"trailer-render">>) => {
  const ffmpeg = need(ctx.tools.ffmpeg, "ffmpeg");
  const videos = many(ctx.files, "video_urls");
  const music = maybe(ctx.files, "music_url");
  const lut = maybe(ctx.files, "lut_url");
  const p = ctx.params;
  const infos = await runInOrder(videos, async (video) => await probe(ctx, video));
  const musicIndex = music === undefined ? null : videos.length;
  const plan = buildGraph(p, infos, lut, musicIndex);
  const edit = path.join(ctx.work, "edit.mp4");
  const output = path.join(ctx.out, "trailer.mp4");

  const inputs = [...videos, ...(music === undefined ? [] : [music])].flatMap((file) => [
    "-i",
    file,
  ]);

  const encode = [
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(p.crf),
    "-pix_fmt",
    "yuv420p",
  ];

  await ctx.run(ffmpeg, [
    "-hide_banner",
    "-y",
    ...inputs,
    "-filter_complex",
    plan.graph.join(";"),
    "-map",
    "[vout]",
    ...(plan.audio === null ? [] : ["-map", plan.audio, "-c:a", "pcm_s16le"]),
    ...encode,
    "-f",
    plan.audio === null ? "mp4" : "mov",
    ...(plan.audio === null ? ["-movflags", "+faststart"] : []),
    plan.audio === null ? output : `${edit}.mov`,
  ]);

  let loudness = null;

  if (plan.audio !== null) {
    const target = `I=${p.lufs}:TP=${p.true_peak}:LRA=11`;

    const pass1 = await ctx.run(ffmpeg, [
      "-hide_banner",
      "-nostats",
      "-i",
      `${edit}.mov`,
      "-vn",
      "-af",
      `loudnorm=${target}:print_format=json`,
      "-f",
      "null",
      "-",
    ]);

    const m = loudnormStats(pass1.stderr);

    await ctx.run(ffmpeg, [
      "-hide_banner",
      "-y",
      "-i",
      `${edit}.mov`,
      "-c:v",
      "copy",
      "-af",
      `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,${AUDIO_FORMAT}`,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      output,
    ]);

    const measured = await measureLoudness(ctx, output);
    loudness = {
      integrated: roundTo(measured.integrated, 1),
      lra: roundTo(measured.lra, 1),
      true_peak: roundTo(measured.true_peak, 1),
    };
  }

  const info = await probe(ctx, output);

  return {
    outputs: [],
    result: {
      clips: p.clips.length,
      duration_seconds: roundTo(info.duration, 3),
      fps: p.fps,
      height: info.height,
      loudness,
      planned_seconds: roundTo(plan.duration, 3),
      width: info.width,
    },
  };
};
