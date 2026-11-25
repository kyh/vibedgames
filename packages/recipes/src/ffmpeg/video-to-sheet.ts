import path from "node:path";

import type { RecipeInput } from "@repo/contract/asset/recipe-schema";

import type { RecipeContext } from "../recipe";
import { need, one, RecipeError } from "../recipe";
import { probe } from "./probe";

export const videoToSheet = async (ctx: RecipeContext<RecipeInput<"video-to-sheet">>) => {
  const ffmpeg = need(ctx.tools.ffmpeg, "ffmpeg");
  const video = one(ctx.files, "video_url");
  const p = ctx.params;
  const info = await probe(ctx, video);

  if (!info.hasVideo) {
    throw new RecipeError("video_url has no video stream.");
  }

  const end = Math.min(p.end_seconds ?? info.duration, info.duration);
  const span = end - p.start_seconds;

  if (span <= 0) {
    throw new RecipeError(
      `start_seconds (${p.start_seconds}) is at or past the end (${end.toFixed(2)} s).`,
    );
  }

  const frames = Math.max(1, Math.min(p.max_frames, Math.floor(span * p.fps)));
  const columns = Math.min(p.columns, frames);
  const rows = Math.ceil(frames / columns);
  const output = path.join(ctx.out, "sheet.png");

  await ctx.run(ffmpeg, [
    "-hide_banner",
    "-y",
    "-ss",
    String(p.start_seconds),
    "-t",
    String(span),
    "-i",
    video,
    "-an",
    "-vf",
    `fps=${p.fps},scale=${p.cell_width}:-2:flags=lanczos,format=rgba,trim=end_frame=${frames},tile=${columns}x${rows}`,
    "-frames:v",
    "1",
    output,
  ]);

  const sheet = await probe(ctx, output);

  return {
    outputs: [],
    result: {
      cell_height: sheet.height === null ? null : Math.round(sheet.height / rows),
      cell_width: p.cell_width,
      columns,
      fps: p.fps,
      frames,
      rows,
      start_seconds: p.start_seconds,
    },
  };
};
