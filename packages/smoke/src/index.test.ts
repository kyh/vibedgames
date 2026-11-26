import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import { createReport, flagValue, inSequence, parseJson, poll } from "./index.ts";

test("poll resolves the first accepted value", async () => {
  let reads = 0;

  const value = await poll(
    async () => {
      reads += 1;

      return await Promise.resolve(reads);
    },
    (n) => n === 3,
    { intervalMs: 1, timeoutMs: 1000 },
  );

  assert.equal(value, 3);
});

test("poll resolves null once the deadline passes", async () => {
  const value = await poll(
    async () => await Promise.resolve(false),
    (ok) => ok,
    { intervalMs: 1, timeoutMs: 5 },
  );

  assert.equal(value, null);
});

test("inSequence runs each step after the last", async () => {
  const order: number[] = [];

  const results = await inSequence([3, 1, 2], async (n) => {
    await Promise.resolve();
    order.push(n);

    return n * 2;
  });

  assert.deepEqual(order, [3, 1, 2]);
  assert.deepEqual(results, [6, 2, 4]);
});

test("createReport counts failures", () => {
  const report = createReport();
  report.check(true, "passes");
  report.check(false, "fails");
  assert.equal(report.failures, 1);
});

test("flagValue reads a flag's value", () => {
  assert.equal(flagValue("--url", ["node", "x", "--url", "http://a"]), "http://a");
  assert.equal(flagValue("--url", ["node", "x"]), null);
  assert.throws(() => flagValue("--url", ["node", "x", "--url"]));
});

test("parseJson reads what the schema accepts and refuses anything else", () => {
  const schema = z.object({ a: z.number() });
  assert.deepEqual(parseJson('{"a":1}', schema), { a: 1 });
  assert.throws(() => parseJson("[1]", schema));
  assert.throws(() => parseJson("not json", schema));
});
