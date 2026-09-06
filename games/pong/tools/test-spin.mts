import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PaddleStroke,
  curveVelocity,
  validatedRemoteStroke,
  SPIN_LIFE,
} from "../src/shared/spin.ts";
import type { Spin } from "../src/shared/spin.ts";

test("stationary returns and slow tracking never add spin", () => {
  const stroke = new PaddleStroke();
  for (let i = 0; i < 20; i++) stroke.sample(i * 0.03, i / 60, "hand");
  assert.equal(stroke.read(19 / 60), 0);
  const velocity = { x: 1, y: 7 };
  curveVelocity(velocity, null, 0.05, 0.25);
  assert.deepEqual(velocity, { x: 1, y: 7 });
});

test("coherent strokes work in both directions and expire", () => {
  for (const direction of [-1, 1]) {
    const stroke = new PaddleStroke();
    for (let i = 0; i < 5; i++) stroke.sample(direction * i * 0.3, i / 60, "hand");
    assert.equal(Math.sign(stroke.read(0.08)), direction);
    assert.equal(stroke.read(0.3), 0);
  }
});

test("reacquisition, source switches, pause reset and implausible jumps cannot arm spin", () => {
  const stroke = new PaddleStroke();
  stroke.sample(0, 0, "hand");
  stroke.sample(4, 0.3, "hand");
  assert.equal(stroke.read(0.3), 0);
  stroke.sample(-4, 0.32, "pointer");
  assert.equal(stroke.read(0.32), 0);
  stroke.sample(4, 0.34, "pointer");
  assert.equal(stroke.read(0.34), 0);
  for (let i = 0; i < 5; i++) stroke.sample(4 - i * 0.3, 0.36 + i / 60, "pointer");
  assert.ok(stroke.read(0.44) < 0);
  stroke.reset();
  assert.equal(stroke.read(0.44), 0);
});

test("curve preserves speed and forward floor for both paddles and edge returns", () => {
  for (const forward of [-1, 1]) {
    for (const lateral of [-1, 0, 1]) {
      for (const direction of [-1, 1]) {
        const velocity = { x: lateral * 12, y: forward * 5 };
        const speed = Math.hypot(velocity.x, velocity.y);
        let spin: Spin = { strength: direction, left: SPIN_LIFE };
        for (let i = 0; i < 120; i++) {
          spin = curveVelocity(velocity, spin, 1 / 120, 0.25);
          assert.ok(Math.abs(Math.hypot(velocity.x, velocity.y) - speed) < 1e-9);
          assert.ok(forward * velocity.y >= speed * 0.25 - 1e-9);
        }
        assert.equal(spin, null);
      }
    }
  }
});

test("30 Hz and 144 Hz integrate the same spin, including final partial step", () => {
  const slow = simulate(30);
  const fast = simulate(144);
  assert.ok(Math.abs(slow.x - fast.x) < 1e-9);
  assert.ok(Math.abs(slow.y - fast.y) < 1e-9);
});

test("peer intent stays finite and bounded without changing valid local power", () => {
  for (const intent of [-1, -0.5, 0, 0.5, 1]) assert.equal(validatedRemoteStroke(intent), intent);
  assert.equal(validatedRemoteStroke(100), 1);
  assert.equal(validatedRemoteStroke(-100), -1);
  assert.equal(validatedRemoteStroke(Number.NaN), 0);
  assert.equal(validatedRemoteStroke(Number.POSITIVE_INFINITY), 0);
});

test("a quick flick stays available after sustained slow tracking", () => {
  const stroke = new PaddleStroke();
  for (let i = 0; i <= 54; i++) stroke.sample((7 * i) / 60, i / 60, "pointer");
  stroke.sample(6.3 + 22 / 60, 55 / 60, "pointer");
  stroke.sample(6.3 + 44 / 60, 56 / 60, "pointer");
  assert.ok(stroke.read(56 / 60) >= 0.15);
});

function simulate(hz: number) {
  const velocity = { x: 0, y: 7 };
  let spin: Spin = { strength: 1, left: SPIN_LIFE };
  for (let i = 0; i < hz; i++) spin = curveVelocity(velocity, spin, 1 / hz, 0.25);
  return velocity;
}
