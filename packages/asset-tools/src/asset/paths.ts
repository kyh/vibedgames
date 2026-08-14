import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Filesystem helpers shared by the ported asset commands. The Python originals
 * leaned on `Path.rglob` and `Path.resolve`, so these keep the same ordering
 * and resolution rules to avoid reshuffling anyone's reports.
 */

export type Size = { width: number; height: number };

/** Parse a `WxH` frame spec, e.g. `32x32`. */
export function parseFrame(text: string): Size {
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(text.trim());
  if (!match) throw new Error(`frame must be WxH, e.g. 32x32 (got "${text}")`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) throw new Error(`frame dimensions must be positive: ${text}`);
  return { width, height };
}

/**
 * Recursive glob for one extension, sorted by full path string. Python sorts
 * `Path` objects by their string form, so plain lexicographic ordering here
 * reproduces the original listings exactly.
 */
export function walkFiles(root: string, extension = ".png"): string[] {
  const out: string[] = [];
  const suffix = extension.toLowerCase();

  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip rather than abort the whole scan
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.toLowerCase().endsWith(suffix)) out.push(full);
    }
  };

  visit(root);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A single file, or every matching file beneath a directory. */
export function resolveTargets(path: string, extension = ".png"): string[] {
  if (!existsSync(path)) throw new Error(`Path not found: ${path}`);
  return statSync(path).isFile() ? [path] : walkFiles(path, extension);
}

/**
 * The original default: `./assets` when it exists, otherwise the working
 * directory. Kept so bare invocations behave the way the skills document.
 */
export function defaultRoot(explicit?: string): string {
  if (explicit) return explicit;
  return existsSync("assets") ? "assets" : ".";
}

/** Render a path relative to the cwd when possible, matching `_pretty`. */
export function prettyPath(path: string): string {
  const rel = relative(process.cwd(), resolve(path));
  return rel && !rel.startsWith(`..${sep}`) && rel !== ".." ? rel : resolve(path);
}

/** Write JSON to a path, creating parent directories first. */
export function writeJsonFile(path: string, payload: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

/** Write text to a path, creating parent directories first. */
export function writeTextFile(path: string, contents: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, contents);
}
