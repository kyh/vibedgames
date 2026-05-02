import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";

/**
 * Resolve `--output` to a directory the run can write into, plus a hint
 * about how to name files. Mirrors the behavior the AI CLI uses:
 *
 *   - missing path → `process.cwd()`
 *   - existing directory, or path ending with a path separator → directory
 *     mode; files are named `${prefix}-NN.${ext}`
 *   - looks like a file path (has an extension or doesn't exist as a dir) →
 *     single-file mode; the resolved path is used verbatim for one output.
 */
export type OutputTarget =
  | { kind: "dir"; dir: string }
  | { kind: "file"; path: string; dir: string };

export function resolveOutputTarget(
  rawPath: string | undefined,
  fallbackDir: string,
): OutputTarget {
  const target = rawPath ?? fallbackDir;
  const abs = isAbsolute(target) ? target : resolve(target);

  if (existsSync(abs) && statSync(abs).isDirectory()) {
    return { kind: "dir", dir: abs };
  }
  if (target.endsWith("/") || target.endsWith("\\")) {
    return { kind: "dir", dir: abs };
  }
  if (extname(abs) !== "") {
    return { kind: "file", path: abs, dir: dirname(abs) };
  }
  return { kind: "dir", dir: abs };
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeBytes(path: string, bytes: Uint8Array | Buffer): void {
  ensureDir(dirname(path));
  writeFileSync(path, bytes);
}
