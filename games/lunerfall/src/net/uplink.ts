// One 60 Hz sim tick of a guest's input, packed into a small integer for the
// `in` event. Held keys and the presses that landed since the previous tick
// (a 144 Hz frame with no sim step still counts) are what PlayerBody.buffer
// consumed on the guest for that tick, so the host — buffering the same value
// before the same step — drives its copy of the body exactly as the guest's
// prediction did.

import { STEP } from "../config";
import type { BodyInput, PlayerBody } from "../entities/player-body";

const LEFT = 1;
const RIGHT = 2;
const UP = 4;
const DOWN = 8;
const JUMP_HELD = 16;
const JUMP = 32;
const DASH = 64;
const ATTACK = 128;
const SPECIAL = 256;
/** The guest held still this tick (versus countdown / match end): the body got
 * neutral input. The raw keys still ride along — a press asks for a rematch. */
export const FROZEN = 512;
/** The guest dropped its queued input before this tick (pause, reconnect). */
export const CLEAR = 1024;
/** The guest's feet met a head on its screen this tick (a co-op stomp): the
 * body bounces after the step, on the guest and on the host's copy alike. */
export const STOMP = 2048;

const PRESSES = [JUMP, DASH, ATTACK, SPECIAL];

const has = (bits: number, flag: number): boolean => Math.floor(bits / flag) % 2 === 1;
const on = (set: boolean, flag: number): number => (set ? flag : 0);

export const NEUTRAL_BODY_INPUT: BodyInput = {
  attackPressed: false,
  dashPressed: false,
  down: false,
  jumpHeld: false,
  jumpPressed: false,
  left: false,
  right: false,
  specialPressed: false,
  up: false,
};

/** Held keys only — what stays down from one tick to the next. */
export const heldBits = (i: BodyInput): number =>
  on(i.left, LEFT) +
  on(i.right, RIGHT) +
  on(i.up, UP) +
  on(i.down, DOWN) +
  on(i.jumpHeld, JUMP_HELD);

/** The edge presses of one input sample. */
export const pressBits = (i: BodyInput): number =>
  on(i.jumpPressed, JUMP) +
  on(i.dashPressed, DASH) +
  on(i.attackPressed, ATTACK) +
  on(i.specialPressed, SPECIAL);

/** Presses from two samples that both fall before one sim step. */
export const mergePresses = (a: number, b: number): number => {
  let out = 0;
  for (const press of PRESSES) {
    out += has(a, press) || has(b, press) ? press : 0;
  }
  return out;
};

export const unpackInput = (bits: number): BodyInput => ({
  attackPressed: has(bits, ATTACK),
  dashPressed: has(bits, DASH),
  down: has(bits, DOWN),
  jumpHeld: has(bits, JUMP_HELD),
  jumpPressed: has(bits, JUMP),
  left: has(bits, LEFT),
  right: has(bits, RIGHT),
  specialPressed: has(bits, SPECIAL),
  up: has(bits, UP),
});

export const isFrozen = (bits: number): boolean => has(bits, FROZEN);
export const isClear = (bits: number): boolean => has(bits, CLEAR);
export const isStomp = (bits: number): boolean => has(bits, STOMP);

/** A tick rewritten as frozen (the host neutralised it): keys kept, body input dropped. */
export const frozenBits = (bits: number): number => (isFrozen(bits) ? bits : bits + FROZEN);

/** What the body consumed for this tick. */
export const tickInput = (bits: number): BodyInput =>
  isFrozen(bits) ? NEUTRAL_BODY_INPUT : unpackInput(bits);

/** One sim tick of a guest's body — the same call on the guest (prediction and
 * replay) and on the host (its copy), so the two can only diverge where the
 * host reaches in. */
export const advanceTick = (body: PlayerBody, bits: number): void => {
  if (isClear(bits)) {
    body.clearInput();
  }
  body.buffer(tickInput(bits));
  body.step(STEP);
  if (isStomp(bits)) {
    body.applyEdge({ kind: "bounce" });
  }
};
