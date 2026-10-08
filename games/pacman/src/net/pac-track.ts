// One rival pac's motion on this screen. Every player simulates their own pac
// and reports it on a steady 20 Hz clock, stamped with their own
// `performance.now()`. A rival is drawn about 100 ms in the past, blending the
// two reports either side of that moment (Interpolator), so reports that
// arrive bunched or late still play back as the sender's steady motion. A
// respawn, or any jump further than the neighbouring cell, snaps instead of
// gliding through walls.

import { Interpolator, lerp } from "@vibedgames/multiplayer";
import type { Player } from "@vibedgames/multiplayer";

export interface PacPose {
  x: number;
  z: number;
}

/** One report from a rival in the round. */
export interface PacSample extends PacPose {
  /** The sender's `performance.now()` when it sent this report. */
  t: number;
  /** Bumped on every respawn or teleport: a new value never blends with the old. */
  spawn: number;
}

/** One field of the wire player-state dictionary (parsed JSON). */
type PlayerStateField = NonNullable<Player["state"]>[string] | undefined;

// JSON numbers are always finite, so Number.isFinite is the exact check.
const isFiniteNumber = (v: PlayerStateField): v is number => Number.isFinite(v);

/**
 * A player's latest report, or null while they are out of the round (title or
 * game-over screen) or have not reported a position yet. Only a player with a
 * report is a rival: an idle one must neither park a pac in the maze nor put
 * everyone else on race rules.
 */
export const readPacSample = (state: Player["state"]): PacSample | null => {
  if (state?.["active"] !== true) {
    return null;
  }
  const { spawn, t, x, z } = state;
  if (!isFiniteNumber(t) || !isFiniteNumber(x) || !isFiniteNumber(z)) {
    return null;
  }
  return { spawn: isFiniteNumber(spawn) ? spawn : 0, t, x, z };
};

/** Past `from`, in the direction of `to`, no further than the next whole cell. */
const clampToCell = (from: number, to: number): number =>
  to > from ? Math.min(to, Math.ceil(from)) : Math.max(to, Math.floor(from));

/**
 * Blend two poses. Past the newest report (`alpha` above 1, a late update) a
 * pac is carried on only as far as the next cell centre: every step ends on
 * one, so going further would push it into the wall it stopped against.
 */
export const lerpPose = (a: PacPose, b: PacPose, alpha: number): PacPose => {
  const x = lerp(a.x, b.x, alpha);
  const z = lerp(a.z, b.z, alpha);
  return alpha <= 1 ? { x, z } : { x: clampToCell(b.x, x), z: clampToCell(b.z, z) };
};

/** Grid cells between two poses. Steps move one cell at a time, so more than one is a teleport. */
const cellsApart = (a: PacPose, b: PacPose): number =>
  Math.abs(Math.round(a.x) - Math.round(b.x)) + Math.abs(Math.round(a.z) - Math.round(b.z));

export class PacTrack {
  private readonly interp = new Interpolator<PacPose>({ lerp: lerpPose });
  private lastT = Number.NaN;
  private spawn = Number.NaN;

  /** Feed the sender's latest report. Call it every frame: a repeat is ignored. */
  push(sample: PacSample, receivedAt?: number): void {
    if (sample.t === this.lastT) {
      return;
    }
    this.lastT = sample.t;
    const { latest } = this.interp;
    if (latest !== undefined && (sample.spawn !== this.spawn || cellsApart(latest, sample) > 1)) {
      this.interp.clear();
    }
    this.spawn = sample.spawn;
    this.interp.push(sample.t, { x: sample.x, z: sample.z }, receivedAt);
  }

  /** Where to draw the pac now; undefined before its first report. */
  sample(localNow?: number): PacPose | undefined {
    return this.interp.sample(localNow);
  }
}
