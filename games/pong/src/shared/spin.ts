import { MIN_VY_FRAC, TICK_RATE, TICK_S } from "./constants";
import { exactCos, exactExp, exactLength, exactSin } from "./exact-math";

// A left-side contact adds a brief slice. No paddle-motion input is sampled.
export const SPIN_LIFE = 0.5;
export const SPIN_RATE = 1.35;
const SPIN_DECAY = 3.5;

/** Ticks a slice bends the flight for. */
export const SPIN_TICKS = Math.round(SPIN_LIFE * TICK_RATE);

/** Heading change (rad) a full-strength slice makes on each tick of its life:
 *  the continuous curve's exact integral over that tick, built from exact
 *  arithmetic so every client holds the same table. */
const spinTurns = (): number[] => {
  const keep = exactExp(-SPIN_DECAY * TICK_S);
  const turns: number[] = [];
  let left = 1;
  for (let tick = 0; tick < SPIN_TICKS; tick += 1) {
    turns.push((SPIN_RATE * left * (1 - keep)) / SPIN_DECAY);
    left *= keep;
  }
  return turns;
};
const SPIN_TURNS = spinTurns();

/** What the per-tick curve reads and bends: a velocity and the slice on it. */
export interface Sliced {
  vx: number;
  vy: number;
  /** Slice strength still bending the flight (0: none). */
  spin: number;
  /** Ticks the slice has already run. */
  spinAge: number;
}

/**
 * One tick of a slice, for the lockstep sim: turn the heading by that tick's
 * share of the curve, keep the speed and the toward-opponent sign, and never
 * let the forward component fall under MIN_VY_FRAC of the speed. Exact
 * arithmetic only (see exact-math), so every client bends the ball alike.
 */
export const curveTick = (ball: Sliced): void => {
  const turn = SPIN_TURNS[ball.spinAge];
  if (ball.spin === 0 || turn === undefined) {
    ball.spin = 0;
    ball.spinAge = 0;
    return;
  }
  const speed = exactLength(ball.vx, ball.vy);
  const sign = ball.vy < 0 ? -1 : 1;
  const forward = Math.abs(ball.vy);
  const angle = ball.spin * turn;
  const cos = exactCos(angle);
  const sin = exactSin(angle);
  let vx = ball.vx * cos + forward * sin;
  let ahead = forward * cos - ball.vx * sin;
  const floor = MIN_VY_FRAC * speed;
  if (ahead < floor) {
    ahead = floor;
    vx = Math.sign(vx) * Math.sqrt(speed * speed - floor * floor);
  }
  ball.vx = vx;
  ball.vy = sign * ahead;
  ball.spinAge += 1;
  if (ball.spinAge >= SPIN_TICKS) {
    ball.spin = 0;
    ball.spinAge = 0;
  }
};
