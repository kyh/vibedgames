import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { zipSync } from "fflate";
import type { Zippable } from "fflate";

// Formats that are already compressed: deflating them again costs time and
// saves nothing.
const STORED = /\.(?:png|jpe?g|webp|avif|gif|mp3|ogg|m4a|aac|mp4|webm|woff2?|br|gz|zip|ktx2)$/iu;

// Every entry carries the same timestamp, so one build always packs to the
// same bytes and a re-run is recognisably the upload a portal already has.
// Zip's own epoch, read in local time because that is how fflate writes it.
const ENTRY_TIME = new Date(1980, 0, 1);

export interface ZipEntry {
  /** Forward-slash path inside the archive. */
  path: string;
  absolutePath: string;
}

/** Bytes to pack in place of a file's own, by archive path. */
export type ZipOverrides = Map<string, Uint8Array>;

export interface ZipResult {
  bytes: number;
}

/**
 * Write `entries` as a zip whose root is the build root: a portal looks for
 * `index.html` at the top of the archive, not inside a folder.
 */
export const writeZip = (
  entries: ZipEntry[],
  outFile: string,
  overrides: ZipOverrides = new Map(),
): ZipResult => {
  const tree: Zippable = {};
  for (const entry of entries) {
    tree[entry.path] = [
      overrides.get(entry.path) ?? readFileSync(entry.absolutePath),
      { level: STORED.test(entry.path) ? 0 : 9, mtime: ENTRY_TIME },
    ];
  }
  const archive = zipSync(tree);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, archive);
  return { bytes: archive.byteLength };
};
