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

/**
 * Set (or, with `undefined`, delete) environment variables for one test; the
 * cleanup harness puts every touched variable back as it was.
 */
export const stubEnv = (cleanups: (() => void)[], vars: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(vars)) {
    const previous = process.env[name];
    cleanups.push(() => {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = previous;
      }
    });

    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
};

export const makeTmpDir = (cleanups: (() => void)[], prefix = "vg-test-") => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanups.push(() => {
    rmSync(dir, { force: true, recursive: true });
  });

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
) => {
  const server = createServer(handler);

  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, () => {
    const addr = server.address();
    resolve(addr instanceof Object ? addr.port : 0);
  });

  const port: number = await promise;

  cleanups.push(() => server.close());

  return port;
};
