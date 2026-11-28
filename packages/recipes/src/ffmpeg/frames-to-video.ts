import { copyFileSync, linkSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { RecipeInput } from "@repo/contract/asset/recipe-schema";

import type { RecipeContext } from "../recipe";
import { ensureDir, maybe, need, one, RecipeError } from "../recipe";
import { probe } from "./probe";

const FRAME = /\.(?:png|jpe?g)$/iu;

const unpack = async (ctx: RecipeContext<unknown>, source: string) => {
  if (statSync(source).isDirectory()) {
    return source;
  }

  const dir = ensureDir(path.join(ctx.work, "frames"));
  await ctx.run(need(ctx.tools.tar, "tar"), ["-xf", source, "-C", dir]);

  return dir;
};

const framesIn = (dir: string) => {
  const found: string[] = [];

  const walk = (sub: string) => {
    for (const entry of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, entry.name);

      if (entry.isDirectory()) {
        walk(rel);
      } else if (FRAME.test(entry.name) && !entry.name.startsWith(".")) {
        found.push(path.join(dir, rel));
      }
    }
  };

  walk("");

  return found.toSorted((a, b) => a.localeCompare(b, "en", { numeric: true }));
};

const place = (from: string, to: string) => {
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
};

export const framesToVideo = async (ctx: RecipeContext<RecipeInput<"frames-to-video">>) => {
  const ffmpeg = need(ctx.tools.ffmpeg, "ffmpeg");
  const frames = framesIn(await unpack(ctx, one(ctx.files, "frames_url")));

  if (frames.length === 0) {
    throw new RecipeError("frames_url holds no PNG or JPEG frames.");
  }

  const ext = path.extname(frames[0] ?? "").toLowerCase() === ".png" ? ".png" : ".jpg";
  const seq = ensureDir(path.join(ctx.work, "seq"));

  for (const [index, frame] of frames.entries()) {
    if ((path.extname(frame).toLowerCase() === ".png") !== (ext === ".png")) {
      throw new RecipeError("frames_url mixes PNG and JPEG frames; give one kind.");
    }

    place(frame, path.join(seq, `f${String(index).padStart(6, "0")}${ext}`));
  }

  const audio = maybe(ctx.files, "audio_url");
  const output = path.join(ctx.out, "video.mp4");
  const { crf, fps } = ctx.params;

  await ctx.run(ffmpeg, [
    "-hide_banner",
    "-y",
    "-framerate",
    String(fps),
    "-i",
    path.join(seq, `f%06d${ext}`),
    ...(audio === undefined
      ? []
      : ["-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-shortest", "-c:a", "aac"]),
    "-vf",
    "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    output,
  ]);

  const info = await probe(ctx, output);

  return {
    outputs: [],
    result: {
      duration_seconds: frames.length / fps,
      fps,
      frames: frames.length,
      height: info.height,
      width: info.width,
    },
  };
};
