import type { RecipeContext } from "../recipe";
import { need, RecipeError } from "../recipe";

export interface MediaInfo {
  duration: number;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames: number | null;
}

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  nb_read_frames?: string;
  duration?: string;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

const rate = (text: string | undefined) => {
  const [num, den] = (text ?? "").split("/").map(Number);

  if (!num || !den) {
    return null;
  }

  return Math.round((num / den) * 1000) / 1000;
};

const count = (text: string | undefined) => {
  const value = Number(text);

  return Number.isFinite(value) && value > 0 ? value : null;
};

/** Reads a media file's streams with ffprobe; `countFrames` decodes every frame for an exact count. */
export const probe = async (ctx: RecipeContext<unknown>, file: string, countFrames = false) => {
  const ffprobe = need(ctx.tools.ffprobe, "ffprobe");
  const args = ["-v", "error", "-print_format", "json", "-show_streams", "-show_format"];

  const { stdout } = await ctx.run(ffprobe, [
    ...args,
    ...(countFrames ? ["-count_frames"] : []),
    file,
  ]);

  let parsed: ProbeOutput;

  try {
    parsed = JSON.parse(stdout) as ProbeOutput;
  } catch {
    throw new RecipeError(`${file} is not a media file ffprobe can read.`);
  }

  return describeStreams(parsed);
};

const describeStreams = (parsed: ProbeOutput) => {
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  const info: MediaInfo = {
    duration: Number(parsed.format?.duration ?? video?.duration ?? audio?.duration ?? 0) || 0,
    fps: rate(video?.avg_frame_rate) ?? rate(video?.r_frame_rate),
    frames: count(video?.nb_read_frames) ?? count(video?.nb_frames),
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    height: video?.height ?? null,
    width: video?.width ?? null,
  };

  return info;
};

export interface Loudness {
  integrated: number;
  true_peak: number;
  lra: number;
}

const summary = (stderr: string, label: RegExp) => {
  const tail = stderr.slice(stderr.lastIndexOf("Summary:"));
  const value = label.exec(tail)?.groups?.value;

  return value === undefined ? Number.NaN : Number(value);
};

/** Measures integrated loudness, true peak and range with ebur128. */
export const measureLoudness = async (ctx: RecipeContext<unknown>, file: string) => {
  const ffmpeg = need(ctx.tools.ffmpeg, "ffmpeg");

  const { stderr } = await ctx.run(ffmpeg, [
    "-hide_banner",
    "-nostats",
    "-i",
    file,
    "-vn",
    "-af",
    "ebur128=peak=true",
    "-f",
    "null",
    "-",
  ]);

  const loudness: Loudness = {
    integrated: summary(stderr, /I:\s+(?<value>-?[\d.]+|-inf) LUFS/u),
    lra: summary(stderr, /LRA:\s+(?<value>-?[\d.]+) LU/u),
    true_peak: summary(stderr, /Peak:\s+(?<value>-?[\d.]+|-inf) dBFS/u),
  };

  return loudness;
};

/** Reads the JSON block loudnorm prints with print_format=json. */
export const loudnormStats = (stderr: string) => {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");

  if (start === -1 || end < start) {
    throw new RecipeError("loudnorm printed no measurement.");
  }

  return JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
};

export const roundTo = (value: number, places = 2) => {
  if (!Number.isFinite(value)) {
    return null;
  }

  const scale = 10 ** places;

  return Math.round(value * scale) / scale;
};
