import { Interpolator, RemoteClock, lerp } from "@vibedgames/multiplayer";
import type { Player } from "@vibedgames/multiplayer";

import { RIVAL_DELAY_MS, RIVAL_EXTRAPOLATE_MS } from "../shared/constants";

export interface PacPose {
  x: number;
  z: number;
}

/** One report from a rival in the round. */
export interface PacSample extends PacPose {
  /** Server time (ms since the epoch) when the sender sent this report. */
  t: number;
  /** Bumped on every respawn or teleport: a new value never blends with the old. */
  spawn: number;
}

type PlayerStateField = NonNullable<Player["state"]>[string] | undefined;

const isFiniteNumber = (v: PlayerStateField): v is number => Number.isFinite(v);

/**
 * A player's latest report, or null while they are out of the round (title or
 * game-over screen) or have not reported a position yet. Only a player with a
 * report is a rival: an idle one must neither park a pac in the maze nor put
 * everyone else on race rules.
 */
export const readPacSample = (state: Player["state"]) => {
  if (state?.["active"] !== true) {
    return null;
  }

  const { spawn, t, x, z } = state;

  if (!isFiniteNumber(t) || !isFiniteNumber(x) || !isFiniteNumber(z)) {
    return null;
  }

  return { spawn: isFiniteNumber(spawn) ? spawn : 0, t, x, z };
};

const clampToCell = (from: number, to: number) =>
  to > from ? Math.min(to, Math.ceil(from)) : Math.max(to, Math.floor(from));

/**
 * Blend two poses. Past the newest report (`alpha` above 1, a late update) a
 * pac is carried on only as far as the next cell centre: every step ends on
 * one, so going further would push it into the wall it stopped against.
 */
export const lerpPose = (a: PacPose, b: PacPose, alpha: number) => {
  const x = lerp(a.x, b.x, alpha);
  const z = lerp(a.z, b.z, alpha);

  return alpha <= 1 ? { x, z } : { x: clampToCell(b.x, x), z: clampToCell(b.z, z) };
};

const cellsApart = (a: PacPose, b: PacPose) =>
  Math.abs(Math.round(a.x) - Math.round(b.x)) + Math.abs(Math.round(a.z) - Math.round(b.z));

export class PacTrack {
  private readonly clock = new RemoteClock();
  private readonly interp = new Interpolator<PacPose>({
    clock: this.clock,
    delayMs: RIVAL_DELAY_MS,
    lerp: lerpPose,
    maxExtrapolateMs: RIVAL_EXTRAPOLATE_MS,
  });
  private spawn = Number.NaN;

  /**
   * Feed the sender's latest report. Call it every frame: a repeat is ignored
   * (its stamp, spawn and cell match the newest, so nothing here fires either).
   */
  push(sample: PacSample, receivedAt?: number) {
    const { latest } = this.interp;

    if (latest !== undefined && (sample.spawn !== this.spawn || cellsApart(latest, sample) > 1)) {
      this.interp.clear();
    }

    this.spawn = sample.spawn;
    this.interp.push(sample.t, { x: sample.x, z: sample.z }, receivedAt);
  }

  /** Where to draw the pac now; undefined before its first report. */
  sample(localNow?: number) {
    return this.interp.sample(localNow);
  }

  /**
   * Our own connection came back: this rival's reports now reach us by
   * another route. The clock measures it from the next arrival and eases onto
   * it; timed by the old route's quicker trips, a slower one would run the pac
   * past its newest report for seconds.
   */
  relearn() {
    this.clock.relearn();
  }
}
