import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Resolve `--output` to a directory the run can write into, plus a hint
 * about how to name files.
 *
 *   - missing path -> fallback directory
 *   - existing directory, or path ending with a path separator -> directory
 *     mode; files are named `${prefix}-NN.${ext}`
 *   - otherwise -> single-file mode; the resolved path is used verbatim for
 *     one output (and only when the run produces exactly one)
 */
export type OutputTarget =
  | { kind: "dir"; dir: string }
  | { kind: "file"; path: string; dir: string };

export function resolveOutputTarget(
  rawPath: string | undefined,
  fallbackDir: string,
): OutputTarget {
  if (rawPath === undefined || rawPath.length === 0) {
    return { kind: "dir", dir: resolve(fallbackDir) };
  }

  const target = rawPath;
  const abs = resolve(target);

  if (existsSync(abs) && statSync(abs).isDirectory()) {
    return { kind: "dir", dir: abs };
  }
  if (target.endsWith("/") || target.endsWith("\\")) {
    return { kind: "dir", dir: abs };
  }
  return { kind: "file", path: abs, dir: dirname(abs) };
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeBytes(path: string, bytes: Uint8Array | Buffer): void {
  ensureDir(dirname(path));
  writeFileSync(path, bytes);
}
