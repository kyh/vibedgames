import assert from "node:assert/strict";
import { test } from "node:test";

import { repeatWhile, runInOrder } from "./run-in-order";

test("runInOrder starts each step after the last settles, and keeps the order", async () => {
  const seen: string[] = [];

  const results = await runInOrder([3, 0, 1], async (hops, index) => {
    seen.push(`start ${index}`);
    await runInOrder(Array.from({ length: hops }), async () => {
      await Promise.resolve();
    });
    seen.push(`end ${index}`);

    return hops * 2;
  });

  assert.deepEqual(results, [6, 0, 2]);
  assert.deepEqual(seen, ["start 0", "end 0", "start 1", "end 1", "start 2", "end 2"]);
});

test("repeatWhile stops on the first false", async () => {
  const rounds: number[] = [];
  await repeatWhile(async (round) => {
    rounds.push(round);

    return await Promise.resolve(round < 2);
  });
  assert.deepEqual(rounds, [0, 1, 2]);
});
