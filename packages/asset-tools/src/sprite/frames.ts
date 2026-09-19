import { readdirSync } from "node:fs";
import path from "node:path";

import { Bitmap } from "../image/raster.js";

/**
 * Frame-sequence helpers shared by the animated-spritesheet commands. The
 * Python originals used `Path.glob("frame-*.png")` plus `sorted()`, so these
 * reproduce that matching and ordering exactly.
 */

/** Translate a shell glob into an anchored regex. Only `*` and `?` are used. */
const globToRegExp = (pattern: string): RegExp => {
  const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", "[^/]*").replaceAll("?", "[^/]")}$`, "u");
};

/** Plain code-unit order, as Python sorts `str` — never locale-aware. */
const compareNames = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

/**
 * Non-recursive glob over one directory, sorted by filename.
 *
 * `Path.glob` is not recursive and Python sorts paths as strings, so a plain
 * lexicographic sort over the directory listing gives the same frame order —
 * which is what keeps `frame-02` before `frame-10` for zero-padded names.
 */
export const globFrames = (dir: string, pattern = "frame-*.png"): string[] => {
  const re = globToRegExp(pattern);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => re.test(name))
    .toSorted(compareNames)
    .map((name) => path.join(dir, name));
};

export interface LoadedFrame {
  path: string;
  image: Bitmap;
}

/** Load every frame matching `pattern`, failing loudly when none match. */
export const loadFrames = (dir: string, pattern = "frame-*.png"): LoadedFrame[] => {
  const paths = globFrames(dir, pattern);
  if (paths.length === 0) {
    throw new Error(`no frames matching ${pattern} in ${dir}`);
  }
  return paths.map((file) => ({ image: Bitmap.fromFile(file), path: file }));
};

/**
 * Median of a numeric list, matching `statistics.median`: the mean of the two
 * middle values for an even-length input, not the lower of them.
 */
export const median = (values: number[]): number => {
  if (values.length === 0) {
    throw new Error("median of an empty sequence");
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
};
