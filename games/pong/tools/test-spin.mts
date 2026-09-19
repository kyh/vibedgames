import assert from "node:assert/strict";
import { test } from "node:test";
import { curveVelocity, SPIN_LIFE } from "../src/shared/spin.ts";
import type { Spin } from "../src/shared/spin.ts";

test("flat and topspin have no lateral curve", () => {
  const velocity = { x: 1, y: 7 };
  curveVelocity(velocity, null, 0.05, 0.25);
  assert.deepEqual(velocity, { x: 1, y: 7 });
});

test("curve preserves speed and forward floor for both paddles and edge returns", () => {
  for (const forward of [-1, 1]) {
    for (const lateral of [-1, 0, 1]) {
      for (const direction of [-1, 1]) {
        const velocity = { x: lateral * 12, y: forward * 5 };
        const speed = Math.hypot(velocity.x, velocity.y);
        let spin: Spin = { left: SPIN_LIFE, strength: direction };
        for (let i = 0; i < 120; i += 1) {
          spin = curveVelocity(velocity, spin, 1 / 120, 0.25);
          assert.ok(Math.abs(Math.hypot(velocity.x, velocity.y) - speed) < 1e-9);
          assert.ok(forward * velocity.y >= speed * 0.25 - 1e-9);
        }
        assert.equal(spin, null);
      }
    }
  }
});

const simulate = (hz: number) => {
  const velocity = { x: 0, y: 7 };
  let spin: Spin = { left: SPIN_LIFE, strength: 1 };
  for (let i = 0; i < hz; i += 1) {
    spin = curveVelocity(velocity, spin, 1 / hz, 0.25);
  }
  return velocity;
};

test("30 Hz and 144 Hz integrate the same spin, including final partial step", () => {
  const slow = simulate(30);
  const fast = simulate(144);
  assert.ok(Math.abs(slow.x - fast.x) < 1e-9);
  assert.ok(Math.abs(slow.y - fast.y) < 1e-9);
});
