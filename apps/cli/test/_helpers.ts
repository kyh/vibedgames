import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
  // realpath because macOS's tmpdir is a symlink (/var -> /private/var):
  // any test that chdirs into the dir gets the resolved path back from
  // `process.cwd()`, so the unresolved one would never compare equal.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Stand up a transient HTTP server on a random port for tests that need
 * to exercise real fetch + write paths. The server is closed via the
 * cleanup harness when the test finishes.
 */
export async function makeTestServer(
  cleanups: (() => void)[],
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> {
  const server = createServer(handler);
  const port: number = await new Promise((r) => {
    server.listen(0, () => {
      const addr = server.address();
      r(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  cleanups.push(() => server.close());
  return port;
}
