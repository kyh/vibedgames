import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tiny tmpdir harness shared between the media test files. Tests
 * register cleanup callbacks; the harness drains them on teardown.
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
