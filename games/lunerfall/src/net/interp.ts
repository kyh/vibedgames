// Blends for the guest's puppets: each remote actor renders INTERP_MS behind
// the relay clock below, between the two snapshots that bracket that moment
// (Interpolator). Positions blend; discrete state (clip-driving flags, ids,
// the FSM state) steps over at the midpoint; an FSM state's age blends while
// the state holds, so posed attack frames advance every rendered frame rather
// than at the snapshot rate.

import { lerp, RemoteClock } from "@vibedgames/multiplayer";
import type { SenderClock } from "@vibedgames/multiplayer";

import type { BossPose, EnemyPose, PlayerPose } from "./snapshot";

/** Render delay behind the relay clock (ms): a 30 Hz snapshot interval plus
 * arrival jitter, so the bracketing snapshot has almost always landed. */
export const INTERP_MS = 100;
// px between consecutive snapshots that no movement covers in 33 ms — a
// respawn or a blink. Hold the old pose until the new one's stamp, then step.
const TELEPORT = 48;

/**
 * What the guest renders on: the room's server time, less the fastest recent
 * relay. The host stamps each snapshot with server time as it sends it, and
 * the snapshot reaches the guest host → party server → guest later — two hops,
 * 100–150 ms under the dev proxy — so INTERP_MS behind server time alone would
 * sit past the newest snapshot and extrapolate every frame. Each age is
 * measured at arrival, server time at both ends, through the SDK's
 * windowed-minimum RemoteClock: hit-stop, a slow host or a host change move
 * the stamps with real time, so there is nothing to reset.
 */
export class RelayClock implements SenderClock {
  private readonly server: () => SenderClock | undefined;
  private readonly relay = new RemoteClock();

  /** `server`: the session's server clock, once there is a session. */
  constructor(server: () => SenderClock | undefined) {
    this.server = server;
  }

  /** True once a snapshot has been measured. */
  get synced(): boolean {
    return this.relay.synced;
  }

  /** A snapshot stamped `sentAt` landed at server time `arrivedAt`. */
  learn(sentAt: number, arrivedAt: number): void {
    this.relay.observe(sentAt, arrivedAt);
  }

  now(localNow: number = performance.now()): number {
    return this.relay.now(this.server()?.now(localNow) ?? localNow);
  }
}

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

/** A projectile as one snapshot row has it. */
export interface ProjPose {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// Rows are where the projectile WAS at their stamps — through a hit-stop it
// does not move while the stamps go on, so it is blended between rows, never
// flown from one.
export const lerpProj = (a: ProjPose, b: ProjPose, k: number): ProjPose => ({
  vx: lerp(a.vx, b.vx, k),
  vy: lerp(a.vy, b.vy, k),
  x: lerp(a.x, b.x, k),
  y: lerp(a.y, b.y, k),
});
