import { lerp } from "@vibedgames/multiplayer";

import type { BossPose, EnemyPose, PlayerPose } from "./snapshot";

/** The least render delay behind the relay clock (ms): a 30 Hz snapshot
 * interval plus a quiet route's jitter, so the bracketing snapshot has almost
 * always landed. The Interpolator renders further back when the stream needs it. */
export const INTERP_MS = 100;
const TELEPORT = 48;

interface Point {
  x: number;
  y: number;
}

const teleported = (a: Point, b: Point) => Math.abs(b.x - a.x) + Math.abs(b.y - a.y) > TELEPORT;

export const lerpPlayer = (a: PlayerPose, b: PlayerPose, k: number) => {
  if (teleported(a, b)) {
    return k < 1 ? a : b;
  }

  return { ...(k < 0.5 ? a : b), x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) };
};

export const lerpEnemy = (a: EnemyPose, b: EnemyPose, k: number) => {
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

export const lerpBoss = (a: BossPose, b: BossPose, k: number) => {
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

/** A projectile as one snapshot row has it. */
export interface ProjPose {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export const lerpProj = (a: ProjPose, b: ProjPose, k: number) => ({
  vx: lerp(a.vx, b.vx, k),
  vy: lerp(a.vy, b.vy, k),
  x: lerp(a.x, b.x, k),
  y: lerp(a.y, b.y, k),
});
