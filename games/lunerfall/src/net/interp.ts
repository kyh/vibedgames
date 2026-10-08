// Blends for the guest's puppets: each remote actor renders INTERP_MS behind
// the host's clock, between the two snapshots that bracket that moment
// (Interpolator, sharing the host's RemoteClock). Positions blend; discrete
// state (clip-driving flags, ids, the FSM state) steps over at the midpoint;
// an FSM state's age blends while the state holds, so posed attack frames
// advance every rendered frame rather than at the snapshot rate.

import { lerp } from "@vibedgames/multiplayer";

import type { BossPose, EnemyPose, PlayerPose } from "./snapshot";

/** Render delay behind the host clock (ms): a 30 Hz snapshot interval plus
 * arrival jitter, so the bracketing snapshot has almost always landed. */
export const INTERP_MS = 100;
// px between consecutive snapshots that no movement covers in 33 ms — a
// respawn or a blink. Hold the old pose until the new one's stamp, then step.
const TELEPORT = 48;

interface Point {
  x: number;
  y: number;
}

const teleported = (a: Point, b: Point): boolean =>
  Math.abs(b.x - a.x) + Math.abs(b.y - a.y) > TELEPORT;

export const lerpPlayer = (a: PlayerPose, b: PlayerPose, k: number): PlayerPose => {
  if (teleported(a, b)) {
    return k < 1 ? a : b;
  }
  return { ...(k < 0.5 ? a : b), x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) };
};

export const lerpEnemy = (a: EnemyPose, b: EnemyPose, k: number): EnemyPose => {
  if (teleported(a, b)) {
    return k < 1 ? a : b;
  }
  const near = k < 0.5 ? a : b;
  return {
    ...near,
    elapsed: a.state === b.state ? lerp(a.elapsed, b.elapsed, k) : near.elapsed,
    x: lerp(a.x, b.x, k),
    y: lerp(a.y, b.y, k),
  };
};

export const lerpBoss = (a: BossPose, b: BossPose, k: number): BossPose => {
  if (teleported(a, b)) {
    return k < 1 ? a : b;
  }
  const near = k < 0.5 ? a : b;
  return {
    ...near,
    elapsed: a.state === b.state ? lerp(a.elapsed, b.elapsed, k) : near.elapsed,
    x: lerp(a.x, b.x, k),
    y: lerp(a.y, b.y, k),
  };
};
