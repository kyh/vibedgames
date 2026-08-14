import { readdirSync } from "node:fs";
import { join } from "node:path";

import { Bitmap } from "../image/raster.js";

/**
 * Frame-sequence helpers shared by the animated-spritesheet commands. The
 * Python originals used `Path.glob("frame-*.png")` plus `sorted()`, so these
 * reproduce that matching and ordering exactly.
 */

/** Translate a shell glob into an anchored regex. Only `*` and `?` are used. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", "[^/]*").replaceAll("?", "[^/]")}$`);
}

/**
 * Non-recursive glob over one directory, sorted by filename.
 *
 * `Path.glob` is not recursive and Python sorts paths as strings, so a plain
 * lexicographic sort over the directory listing gives the same frame order —
 * which is what keeps `frame-02` before `frame-10` for zero-padded names.
 */
export function globFrames(dir: string, pattern = "frame-*.png"): string[] {
  const re = globToRegExp(pattern);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => re.test(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => join(dir, name));
}

export type LoadedFrame = { path: string; image: Bitmap };

/** Load every frame matching `pattern`, failing loudly when none match. */
export function loadFrames(dir: string, pattern = "frame-*.png"): LoadedFrame[] {
  const paths = globFrames(dir, pattern);
  if (paths.length === 0) throw new Error(`no frames matching ${pattern} in ${dir}`);
  return paths.map((path) => ({ path, image: Bitmap.fromFile(path) }));
}

/**
 * Median of a numeric list, matching `statistics.median`: the mean of the two
 * middle values for an even-length input, not the lower of them.
 */
export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of an empty sequence");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
