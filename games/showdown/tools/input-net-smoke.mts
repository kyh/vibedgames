import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInputState, shouldSendInput } from "../src/net/input-intent.ts";

test("wire movement is bounded and passive facing accepts only finite angles", () => {
  const parsed = parseInputState({ look: Math.PI * 2 + 0.7, mx: 4, mz: -5 });
  assert.equal(parsed.mx, 1);
  assert.equal(parsed.mz, -1);
  assert.ok(parsed.look !== null);
  assert.ok(Math.abs(parsed.look - 0.7) < 1e-10);
  for (const look of [null, "north", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(parseInputState({ look, mx: 0, mz: 0 }).look, null);
  }
  assert.deepEqual(parseInputState({}), { look: null, mx: 0, mz: 0 });
});

test("aim updates are capped at 20 Hz while movement and aim ownership changes remain immediate", () => {
  const previous = { look: 0, mx: 0, mz: 0 };
  assert.equal(shouldSendInput(previous, { ...previous, look: 0.2 }, 49), false);
  assert.equal(shouldSendInput(previous, { ...previous, look: 0.4 }, 50), true);
  assert.equal(shouldSendInput(previous, { ...previous, mx: 1 }, 1), true);
  assert.equal(shouldSendInput(previous, { ...previous, look: null }, 1), true);
  assert.equal(shouldSendInput({ ...previous, look: null }, previous, 1), true);
});

test("stationary aiming refreshes across long holds while completely idle input stays quiet", () => {
  const aiming = { look: 1.4, mx: 0, mz: 0 };
  assert.equal(shouldSendInput(aiming, aiming, 499), false);
  assert.equal(shouldSendInput(aiming, aiming, 500), true);
  const idle = { look: null, mx: 0, mz: 0 };
  assert.equal(shouldSendInput(idle, idle, 10_000), false);
  const moving = { ...idle, mx: 1 };
  assert.equal(shouldSendInput(moving, moving, 500), true);
});
