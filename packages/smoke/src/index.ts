import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import type { z } from "zod";

export interface PollOptions {
  timeoutMs: number;
  intervalMs?: number;
}

/**
 * Read until `done` accepts a value or the deadline passes, waiting
 * `intervalMs` between reads. Resolves the accepted value, or `null` once the
 * deadline has passed.
 */
export const poll = <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  { intervalMs = 50, timeoutMs }: PollOptions,
) => {
  const deadline = Date.now() + timeoutMs;
  const attempt: () => Promise<T | null> = async () => {
    if (Date.now() >= deadline) {
      return null;
    }

    const value = await read();

    if (done(value)) {
      return value;
    }

    await wait(intervalMs);

    return attempt();
  };

  return attempt();
};

/** Run `step` for each item in order, each one after the last has settled. */
export const inSequence = async <T, R>(
  items: readonly T[],
  step: (item: T, index: number) => Promise<R>,
) => {
  const results: R[] = [];

  await items.reduce<Promise<void>>(
    (previous, item, index) =>
      previous.then(async () => {
        results.push(await step(item, index));
      }),
    Promise.resolve(),
  );

  return results;
};

/** Run `step` `count` times in order. */
export const repeat = (count: number, step: (index: number) => Promise<void>) =>
  inSequence(
    Array.from({ length: count }, (_, index) => index),
    step,
  );

/** Whether anything answers `url`. */
export const reachable = async (url: string) => {
  try {
    await fetch(url);

    return true;
  } catch {
    return false;
  }
};

export interface ViteOptions {
  gameDir: string;
  port: number;
  url?: string;
  args?: readonly string[];
  timeoutMs?: number;
}

/** Start the game's Vite dev server on `port` and resolve once it answers. */
export const startVite = async ({
  args = [],
  gameDir,
  port,
  timeoutMs = 10_000,
  url,
}: ViteOptions) => {
  const target = url ?? `http://localhost:${port}`;
  const vite: ChildProcess = spawn(
    path.join(gameDir, "node_modules/.bin/vite"),
    ["--port", String(port), "--strictPort", ...args],
    { cwd: gameDir, stdio: "ignore" },
  );
  const up = await poll(
    () => reachable(target),
    (ok) => ok,
    { intervalMs: 100, timeoutMs },
  );

  if (up === null) {
    vite.kill();
    throw new Error(`vite did not come up on ${target}`);
  }

  return vite;
};

/** A pass/fail tally that prints each check as it lands. */
export const createReport = () => {
  let failures = 0;

  return {
    check: (ok: boolean, label: string) => {
      console.log(`${ok ? "ok  " : "FAIL"} ${label}`);

      if (!ok) {
        failures += 1;
      }
    },
    fail: () => {
      failures += 1;
    },
    get failures() {
      return failures;
    },
  };
};

/** The value of `--name <value>` on the command line, `null` when absent. */
export const flagValue = (name: string, argv: readonly string[] = process.argv) => {
  const at = argv.indexOf(name);

  if (at === -1) {
    return null;
  }

  const value = argv[at + 1];

  if (value === undefined || value === "") {
    throw new Error(`${name} needs a value`);
  }

  return value;
};

/** Parse `text` as JSON that `schema` accepts, throwing when it does not. */
export const parseJson = <T,>(text: string, schema: z.ZodType<T>) => schema.parse(JSON.parse(text));
