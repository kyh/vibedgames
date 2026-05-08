import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tiny tmpdir/tmpfile harness shared between the media-args and
 * media-download test files. Tests register cleanup callbacks; the
 * harness drains them on teardown.
 */
export function makeCleanups(): {
  cleanups: (() => void)[];
  drain: () => void;
} {
  const cleanups: (() => void)[] = [];
  return {
    cleanups,
    drain: () => {
      while (cleanups.length) cleanups.pop()?.();
    },
  };
}

export function makeTmpDir(cleanups: (() => void)[], prefix = "vg-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function makeTmpFile(
  cleanups: (() => void)[],
  name: string,
  content = "x",
  prefix = "vg-test-",
): string {
  const dir = makeTmpDir(cleanups, prefix);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}
