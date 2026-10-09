// Blends for the guest's puppets: each remote actor renders at least INTERP_MS
// behind the relay clock, between the two snapshots that bracket that moment
// (Interpolator). Positions blend; discrete state (clip-driving flags, ids,
// the FSM state) steps over at the midpoint; an FSM state's age blends while
// the state holds, so posed attack frames advance every rendered frame rather
// than at the snapshot rate.
//
// The relay clock is the SDK's RemoteClock, fed each snapshot's stamp and the
// local time it landed (scenes/guest-sync.ts). The host stamps each snapshot
// with the room's server time as it sends it, and the snapshot reaches the
// guest host → party server → guest later — two hops, 100–150 ms under the dev
// proxy — so INTERP_MS behind server time alone would sit past the newest
// snapshot and extrapolate every frame. The clock reads server time less the
// fastest recent relay, measured at arrival on this tab's own clock, so this
// guest's server-clock estimate never enters it. The clock also measures how
// late snapshots land (RemoteClock.hold), and the render delay grows past
// INTERP_MS to cover it on a jittery route or a busy tab; anything else drawn
// on the host's timeline goes at the Interpolator's renderTime. Hit-stop and a
// slow host move the stamps with real time, so there is nothing to reset; a
// new host or a reconnect carries them straight on by another route, which
// the clock relearns (GuestSync.admit).

import { lerp } from "@vibedgames/multiplayer";

import type { BossPose, EnemyPose, PlayerPose } from "./snapshot";

/** The least render delay behind the relay clock (ms): a 30 Hz snapshot
 * interval plus a quiet route's jitter, so the bracketing snapshot has almost
 * always landed. The Interpolator renders further back when the stream needs it. */
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
