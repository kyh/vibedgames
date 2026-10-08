// Ball flight and paddle contact — pure rules shared by the host simulation, a
// guest's local copy of the same flight, the host's replay of a guest's return
// and the unit tests. Canonical frame: slot A defends −y, slot B +y.

import { HIT_HALF_X, HIT_HALF_Y, MIN_VY_FRAC, WALL_X } from "./constants";
import { curveVelocity } from "./spin";
import type { Spin } from "./spin";

export interface Vec2 {
  x: number;
  y: number;
}

/** A ball in flight. Generic so the scene can keep its THREE vectors. */
export interface Flight<V extends Vec2 = Vec2> {
  pos: V;
  vel: V;
  spin: Spin;
}

/** Longest single step when replaying flight in bulk (a projection, a fast-forward). */
const SUBSTEP_S = 1 / 120;

/** Hitbox deliberately larger than the visible ring — keep it generous. */
export const hitsPaddle = (ball: Vec2, paddleX: number, paddleY: number): boolean =>
  Math.abs(ball.y - paddleY) < HIT_HALF_Y && Math.abs(ball.x - paddleX) < HIT_HALF_X;

/**
 * Paddle return: the lateral component scales linearly with the hit's x
 * offset from paddle center — dead-center returns straight, a full-edge
 * graze leaves MIN_VY_FRAC of the speed pointing at the opponent. Derived
 * from x alone: the y penetration depth at the detection frame varies with
 * frame rate and must not steer the ball (the legacy atan2-of-penetration
 * formula made the same hit return steep at 144Hz and shallow at 30Hz).
 * Speed stays exactly the given rally speed.
 */
export const reflectOffPaddle = (
  ballX: number,
  paddleX: number,
  towardY: 1 | -1,
  speed: number,
): Vec2 => {
  const offset = Math.min(1, Math.max(-1, (ballX - paddleX) / HIT_HALF_X));
  const maxVxFrac = Math.sqrt(1 - MIN_VY_FRAC * MIN_VY_FRAC);
  const x = offset * maxVxFrac * speed;
  return { x, y: towardY * Math.sqrt(speed * speed - x * x) };
};

/**
 * One step of free flight: the slice's curve, travel, and a side-wall bank.
 * The overshoot past the wall is reflected rather than clamped away, so a
 * bank lands where a continuous ball would at any frame rate — the host and
 * a guest stepping the same flight at different rates must agree. True when
 * the ball banked this step.
 */
export const stepFlight = (ball: Flight, dt: number): boolean => {
  const { pos, vel } = ball;
  ball.spin = curveVelocity(vel, ball.spin, dt, MIN_VY_FRAC);
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;
  const side = Math.sign(pos.x);
  if (Math.abs(pos.x) < WALL_X || Math.sign(vel.x) !== side) {
    return false;
  }
  pos.x = side * Math.max(0, 2 * WALL_X - Math.abs(pos.x));
  vel.x = -vel.x;
  // A bank ends the curve; no hidden second bend off the rail.
  ball.spin = null;
  return true;
};

/** Free flight for `seconds`, in steps no longer than one 120 Hz frame. */
export const advanceFlight = (ball: Flight, seconds: number): void => {
  let left = seconds;
  while (left > 0) {
    const dt = Math.min(left, SUBSTEP_S);
    stepFlight(ball, dt);
    left -= dt;
  }
};

/** A detached copy — spin included, which curveVelocity mutates in place. */
export const copyFlight = (ball: Flight): Flight => ({
  pos: { x: ball.pos.x, y: ball.pos.y },
  spin: ball.spin === null ? null : { left: ball.spin.left, strength: ball.spin.strength },
  vel: { x: ball.vel.x, y: ball.vel.y },
});
