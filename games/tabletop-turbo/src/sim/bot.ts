// The bot driver: turns a kart and the road ahead into the same KartInput a
// player produces, so bots race under exactly the player's physics.

import { MAX_SPEED } from "../shared/constants";
import { angleDelta, kartSpeed } from "./kart";
import type { Kart, KartInput } from "./kart";
import { curvatureAt, pointAt } from "./track";
import type { Track } from "./track";

export interface BotBrain {
  /** -1 … 1: the side of the road this bot prefers on straights. */
  lane: number;
  /** Throttle ceiling, 0–1: how close to flat-out it drives. */
  skill: number;
  /** Offsets its weave so the pack does not move as one. */
  phase: number;
}

/** Angular speed (rad/s) a kart can hold through a bend without sliding wide. */
export const CORNER_RATE = 1.75;
const DRIFT_CURVE = 0.034;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const makeBrain = (index: number): BotBrain => ({
  lane: ((index * 0.618) % 1) * 2 - 1,
  phase: index * 1.7,
  skill: 0.86 + ((index * 0.37) % 1) * 0.09,
});

/** Sharpest bend between `from` and `to` samples ahead, signed. */
const sharpestAhead = (track: Track, s: number, from: number, to: number): number => {
  let sharpest = 0;
  for (let d = from; d <= to; d += 3) {
    const c = curvatureAt(track, s + d);
    if (Math.abs(c) > Math.abs(sharpest)) {
      sharpest = c;
    }
  }
  return sharpest;
};

/**
 * `pace` scales the throttle ceiling (rubber band: >1 when trailing the
 * leader, <1 when clear ahead); `time` is seconds, for the weave.
 */
export const botInput = (
  kart: Kart,
  track: Track,
  brain: BotBrain,
  time: number,
  pace: number,
): KartInput => {
  const speed = kartSpeed(kart);
  const look = kart.idx + 7 + speed * 0.42;
  const bend = curvatureAt(track, look);
  // Weave on the straights, hug the inside of a bend (+curve turns right, +lat is right).
  const weave = brain.lane * 0.5 + Math.sin(time * 0.3 + brain.phase) * 0.25;
  const apex = clamp(bend * 55, -1, 1) * 0.55;
  const lat = clamp(weave * (1 - Math.abs(apex)) + apex, -0.8, 0.8) * track.halfWidth;
  const target = pointAt(track, look, lat);
  const error = angleDelta(Math.atan2(target.z - kart.z, target.x - kart.x), kart.a);
  const steer = clamp(error * 2.6, -1, 1);

  const ahead = sharpestAhead(track, kart.idx, 4, 8 + speed * 0.9);
  const cornerSpeed = Math.abs(ahead) > 1e-4 ? CORNER_RATE / Math.abs(ahead) : MAX_SPEED * 2;
  const tooFast = speed > cornerSpeed * 1.12;
  const here = curvatureAt(track, kart.idx + 4);
  const drift =
    Math.abs(here) > DRIFT_CURVE && Math.sign(here) === Math.sign(steer) && Math.abs(error) < 1.1;

  return {
    brake: tooFast ? 0.7 : 0,
    drift,
    steer,
    throttle: clamp(brain.skill * pace, 0.3, 1),
  };
};
