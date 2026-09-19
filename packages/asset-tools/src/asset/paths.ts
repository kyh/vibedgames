import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { JsonValue } from "./json.js";

/**
 * Filesystem helpers shared by the ported asset commands. The Python originals
 * leaned on `Path.rglob` and `Path.resolve`, so these keep the same ordering
 * and resolution rules to avoid reshuffling anyone's reports.
 */

export interface Size {
  width: number;
  height: number;
}

/** Parse a `WxH` frame spec, e.g. `32x32`. */
export const parseFrame = (text: string): Size => {
  const groups = /^(?<width>\d+)\s*x\s*(?<height>\d+)$/iu.exec(text.trim())?.groups;
  if (!groups) {
    throw new Error(`frame must be WxH, e.g. 32x32 (got "${text}")`);
  }
  const width = Number(groups.width);
  const height = Number(groups.height);
  if (width <= 0 || height <= 0) {
    throw new Error(`frame dimensions must be positive: ${text}`);
  }
  return { height, width };
};

/** Plain code-unit ordering, the way Python compares `str`. */
export const compareStrings = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

/**
 * Recursive glob for one extension, sorted by full path string. Python sorts
 * `Path` objects by their string form, so plain lexicographic ordering here
 * reproduces the original listings exactly.
 */
export const walkFiles = (root: string, extension = ".png"): string[] => {
  const out: string[] = [];
  const suffix = extension.toLowerCase();

  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // unreadable directory: skip rather than abort the whole scan
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.name.toLowerCase().endsWith(suffix)) {
        out.push(full);
      }
    }
  };

  visit(root);
  return out.toSorted(compareStrings);
};

/** A single file, or every matching file beneath a directory. */
export const resolveTargets = (target: string, extension = ".png"): string[] => {
  if (!existsSync(target)) {
    throw new Error(`Path not found: ${target}`);
  }
  return statSync(target).isFile() ? [target] : walkFiles(target, extension);
};

/**
 * The original default: `./assets` when it exists, otherwise the working
 * directory. Kept so bare invocations behave the way the skills document.
 */
export const defaultRoot = (explicit?: string): string => {
  if (explicit) {
    return explicit;
  }
  return existsSync("assets") ? "assets" : ".";
};

/** Render a path relative to the cwd when possible, matching `_pretty`. */
export const prettyPath = (target: string): string => {
  const rel = path.relative(process.cwd(), path.resolve(target));
  return rel && !rel.startsWith(`..${path.sep}`) && rel !== ".." ? rel : path.resolve(target);
};

/**
 * Serialize the way Python's `json.dumps(..., indent=2)` does, including its
 * default `ensure_ascii=True`: any non-ASCII character is escaped as `\uXXXX`.
 * Without this an em-dash in a QC message serializes literally here and as an
 * escape there, so byte-comparing reports against the Python originals fails
 * on content that is in fact identical.
 */
export const toPythonJson = (payload: JsonValue): string =>
  JSON.stringify(payload, null, 2).replaceAll(/[\u007F-\u{10FFFF}]/gu, (ch) =>
    // Escape per UTF-16 unit: an astral character becomes its surrogate pair,
    // as Python writes it.
    [...ch]
      .map((unit) => `\\u${(unit.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`)
      .join(""),
  );

/** Write JSON to a path, creating parent directories first. */
export const writeJsonFile = (target: string, payload: JsonValue): void => {
  mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  writeFileSync(target, `${toPythonJson(payload)}\n`);
};

/** Write text to a path, creating parent directories first. */
export const writeTextFile = (target: string, contents: string): void => {
  mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  writeFileSync(target, contents);
};
