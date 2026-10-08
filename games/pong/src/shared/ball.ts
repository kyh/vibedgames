// Ball flight and paddle contact — pure rules the lockstep sim (./sim) steps
// a tick at a time, on every client alike. Canonical frame: slot A defends
// −y, slot B +y.

import { HIT_HALF_X, HIT_HALF_Y, MIN_VY_FRAC, TICK_S, WALL_X } from "./constants";
import { curveTick } from "./spin";
import type { Sliced } from "./spin";

export interface Vec2 {
  x: number;
  y: number;
}

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

/** A ball as the lockstep sim holds it: plain numbers, stepped a tick at a time. */
export interface Ball extends Sliced {
  x: number;
  y: number;
}

/**
 * One tick (TICK_S) of free flight for the lockstep sim: the slice's curve,
 * travel, and a side-wall bank whose overshoot is reflected rather than
 * clamped. Exact arithmetic only, so every client's ball takes the same path.
 * True when the ball banked this tick.
 */
export const flyTick = (ball: Ball): boolean => {
  curveTick(ball);
  ball.x += ball.vx * TICK_S;
  ball.y += ball.vy * TICK_S;
  const side = Math.sign(ball.x);
  if (Math.abs(ball.x) < WALL_X || Math.sign(ball.vx) !== side) {
    return false;
  }
  ball.x = side * Math.max(0, 2 * WALL_X - Math.abs(ball.x));
  ball.vx = -ball.vx;
  // A bank ends the curve; no hidden second bend off the rail.
  ball.spin = 0;
  ball.spinAge = 0;
  return true;
};
