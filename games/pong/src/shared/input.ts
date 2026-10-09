// A player's input as it rides the tick room: three small integers, held by
// the server until the next change and the only thing the lockstep sim reads
// from a player. Absolute paddle targets cover every control — the pointer and
// a touch drag are positions already, and the hand tracker and the stick are
// smoothed into one locally — and two press counters turn button presses
// into edges the held stream cannot lose.

import type { JsonValue } from "@vibedgames/multiplayer";

import { PADDLE_X_MAX } from "./constants";

/** Paddle targets ride the wire in 1/PADDLE_STEPS of a world unit. A power of
 *  two, so a step converts to world units exactly. */
export const PADDLE_STEPS = 32;
/** Press counters wrap here; a change, not a value, is what counts. */
export const INPUT_COUNTER = 16;
const STEP_LIMIT = Math.round(PADDLE_X_MAX * PADDLE_STEPS);

/** One player's held input. */
export interface SlotInput {
  /** Confirm presses — serve, power shot, rematch — counted mod INPUT_COUNTER. */
  c: number;
  /** Power-shot cancels, counted the same way. */
  k: number;
  /** Paddle target in 1/PADDLE_STEPS world units, canonical frame. */
  x: number;
}

/** A canonical paddle x as the nearest wire step, inside the paddle's travel. */
export const paddleStep = (x: number): number =>
  Math.min(STEP_LIMIT, Math.max(-STEP_LIMIT, Math.round(x * PADDLE_STEPS)));

/** The next value of a press counter. */
export const bump = (count: number): number => (count + 1) % INPUT_COUNTER;

export const encodeInput = (input: SlotInput): JsonValue => [input.x, input.c, input.k];

const isWhole = (v: JsonValue | undefined): v is number => Number.isSafeInteger(v);

const isCount = (v: number): boolean => v >= 0 && v < INPUT_COUNTER;

/**
 * A wire input, or null when it is not one — the same answer on every client,
 * so a malformed input seats the AI everywhere at once.
 */
export const readInput = (wire: JsonValue | undefined): SlotInput | null => {
  if (!Array.isArray(wire) || wire.length !== 3) {
    return null;
  }
  const [x, c, k] = wire;
  if (!isWhole(x) || !isWhole(c) || !isWhole(k)) {
    return null;
  }
  if (Math.abs(x) > STEP_LIMIT || !isCount(c) || !isCount(k)) {
    return null;
  }
  return { c, k, x };
};

export const sameInput = (a: SlotInput | null, b: SlotInput | null): boolean => {
  if (a === null || b === null) {
    return a === b;
  }
  return a.x === b.x && a.c === b.c && a.k === b.k;
};
