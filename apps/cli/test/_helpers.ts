import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Tiny tmpdir harness shared between the media test files. Tests
 * register cleanup callbacks; the harness drains them on teardown.
 */
export const makeCleanups = () => {
  const cleanups: (() => void)[] = [];
  return {
    cleanups,
    drain: () => {
      while (cleanups.length) {
        cleanups.pop()?.();
      }
    },
  };
};

export const makeTmpDir = (cleanups: (() => void)[], prefix = "vg-test-"): string => {
  // realpath because macOS's tmpdir is a symlink (/var -> /private/var):
  // any test that chdirs into the dir gets the resolved path back from
  // `process.cwd()`, so the unresolved one would never compare equal.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
};

/**
 * Stand up a transient HTTP server on a random port for tests that need
 * to exercise real fetch + write paths. The server is closed via the
 * cleanup harness when the test finishes.
 */
export const makeTestServer = async (
  cleanups: (() => void)[],
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> => {
  const server = createServer(handler);
  // oxlint-disable-next-line promise/avoid-new -- server.listen is callback-only
  const port: number = await new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      resolve(addr instanceof Object ? addr.port : 0);
    });
  });
  cleanups.push(() => server.close());
  return port;
};
