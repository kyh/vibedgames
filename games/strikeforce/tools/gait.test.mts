// The soldier's gait: which clips play, how fast the stride turns over, and
// which way the legs face, read off nothing but positions.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Gait, gaitWeights, strideLength } from "../src/soldier/soldier-gait.ts";

const DT = 1 / 60;

/** Walk a gait along a velocity (m/s, world) while facing `yaw`, for `seconds`. */
const run = (gait: Gait, vx: number, vz: number, yaw: number, seconds: number): void => {
  for (let t = 0; t < seconds; t += DT) {
    gait.update(vx * t, vz * t, yaw, 0, DT);
  }
};

const total = (weights: Record<string, number>): number =>
  Object.values(weights).reduce((a, b) => a + b, 0);

test("standing still plays no stride; moving plays a whole one", () => {
  assert.equal(total(gaitWeights(0, 0, false)), 0);
  for (const pace of [1, 2.2, 4.4, 6.4, 9]) {
    assert.ok(Math.abs(total(gaitWeights(pace, 0, false)) - 1) < 1e-9, `pace ${pace}`);
    assert.ok(Math.abs(total(gaitWeights(pace, 0, true)) - 1) < 1e-9, `back at ${pace}`);
  }
});

test("the stride turns over by distance covered, so feet do not slide", () => {
  const gait = new Gait();
  run(gait, 0, -3, 0, 2);
  const before = gait.phase;
  gait.update(0, -3 * 2 - 3 * DT, 0, 0, DT);
  const cycles = (gait.phase - before + 1) % 1;
  assert.ok(Math.abs(cycles * strideLength(gait.weights) - 3 * DT) < 1e-3);
});

test("walking forward leaves the hips square", () => {
  const gait = new Gait();
  run(gait, 0, -2, 0, 2);
  assert.ok(Math.abs(gait.speed - 2) < 0.05);
  assert.ok(Math.abs(gait.twist) < 0.02);
  assert.equal(gait.back, false);
});

test("a sidestep turns the hips towards it, within their limit", () => {
  const right = new Gait();
  run(right, 2.2, 0, 0, 2);
  assert.ok(right.twist < -1, "moving right turns the hips right");
  const left = new Gait();
  run(left, -2.2, 0, 0, 2);
  assert.ok(left.twist > 1, "moving left turns them left");
  assert.ok(Math.abs(left.twist) <= 1.2 + 1e-9);
});

test("moving away from where it faces is a backpedal, hips square", () => {
  const gait = new Gait();
  run(gait, 0, 1.6, 0, 2);
  assert.equal(gait.back, true);
  assert.ok(Math.abs(gait.twist) < 0.05);
  assert.ok(gait.weights.back > 0.9);
});

test("turning on the spot plants the feet, then steps them round", () => {
  const gait = new Gait();
  gait.update(0, 0, 0, 0, DT);
  gait.update(0, 0, 0.5, 0, DT);
  assert.ok(Math.abs(gait.twist + 0.5) < 1e-9, "a small turn leaves the feet where they were");
  for (let i = 0; i < 120; i += 1) {
    gait.update(0, 0, 1.6, 0, DT);
  }
  assert.ok(Math.abs(gait.twist) < 0.05, "a big one brings them round");
});

test("a respawn is not a sprint", () => {
  const gait = new Gait();
  run(gait, 0, 0, 0, 0.5);
  gait.update(40, 12, 0, 0, DT);
  assert.ok(gait.speed < 0.01);
});
