// What a kart looks like on the wire, and how a remote one is played back.
//
// Every human simulates their own kart and reports it at SEND_HZ; the host
// simulates the bots and reports them in shared state. Both are the same row:
// stamped with the room's server time and drawn through an Interpolator, a
// human's on its own clock (each sender's route to us differs), the bots' on
// one clock they share (they all come from the host).

import { Interpolator, RemoteClock, lerp, lerpAngle } from "@vibedgames/multiplayer";
import type { JsonRecord } from "@vibedgames/multiplayer";

import type { Kart } from "../sim/kart";
import { kartSpeed } from "../sim/kart";
import { isJsonNumber, isJsonObject, numberOr } from "./wire";
import type { WireField } from "./wire";

/** What the renderer and the standings need from any kart, local or remote. */
export interface KartPose {
  x: number;
  z: number;
  a: number;
  speed: number;
  /** -1 / 0 / 1. */
  drift: number;
  boosting: boolean;
  prog: number;
  finishMs: number;
  /** Drift charge in seconds, for spark colour. */
  charge: number;
}

/** A pose plus when it was sent and which round it belongs to. */
export interface PoseReport extends KartPose {
  t: number;
  round: number;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export const poseOf = (kart: Kart): KartPose => ({
  a: kart.a,
  boosting: kart.boost > 0,
  charge: kart.charge,
  drift: kart.drift,
  finishMs: kart.finishMs,
  prog: kart.prog,
  speed: kartSpeed(kart),
  x: kart.x,
  z: kart.z,
});

/** Short keys: this row leaves 20 times a second per kart. */
export const encodePose = (kart: Kart, t: number, round: number): JsonRecord => ({
  a: round3(kart.a),
  b: kart.boost > 0 ? 1 : 0,
  c: round2(kart.charge),
  d: kart.drift,
  f: kart.finishMs,
  p: round2(kart.prog),
  r: round,
  s: round2(kartSpeed(kart)),
  t: Math.round(t),
  x: round2(kart.x),
  z: round2(kart.z),
});

/** A wire row as a report, or null if it is not one (a player still on the title). */
export const readPose = (row: WireField): PoseReport | null => {
  if (!isJsonObject(row)) {
    return null;
  }
  const { a, t, x, z } = row;
  if (!isJsonNumber(t) || !isJsonNumber(x) || !isJsonNumber(z) || !isJsonNumber(a)) {
    return null;
  }
  return {
    a,
    boosting: row["b"] === 1,
    charge: numberOr(row["c"], 0),
    drift: numberOr(row["d"], 0),
    finishMs: numberOr(row["f"], 0),
    prog: numberOr(row["p"], 0),
    round: numberOr(row["r"], 0),
    speed: numberOr(row["s"], 0),
    t,
    x,
    z,
  };
};

const lerpPose = (p: KartPose, q: KartPose, k: number): KartPose => {
  // The discrete fields follow whichever report is nearer in time.
  const near = k < 0.5 ? p : q;
  return {
    a: lerpAngle(p.a, q.a, k),
    boosting: near.boosting,
    charge: near.charge,
    drift: near.drift,
    finishMs: q.finishMs,
    prog: lerp(p.prog, q.prog, k),
    speed: lerp(p.speed, q.speed, k),
    x: lerp(p.x, q.x, k),
    z: lerp(p.z, q.z, k),
  };
};

/** Further than a kart can travel between two reports: a respawn, not motion. */
const TELEPORT = 14;

export class RemoteTrack {
  private readonly clock: RemoteClock;
  private readonly interp: Interpolator<KartPose>;
  private round = -1;

  /** Pass the host's shared clock for a bot; a human gets a clock of its own. */
  constructor(clock: RemoteClock = new RemoteClock()) {
    this.clock = clock;
    this.interp = new Interpolator<KartPose>({
      clock: this.clock,
      delayMs: 100,
      lerp: lerpPose,
      maxExtrapolateMs: 180,
    });
  }

  /** Feed the latest report. Call it every frame: a repeat is ignored. */
  push(report: PoseReport): void {
    const { latest } = this.interp;
    if (
      latest !== undefined &&
      (report.round !== this.round ||
        Math.hypot(latest.x - report.x, latest.z - report.z) > TELEPORT)
    ) {
      // A new round puts the kart back on the grid: never glide it there.
      this.interp.clear();
    }
    this.round = report.round;
    this.interp.push(report.t, report);
  }

  sample(): KartPose | undefined {
    return this.interp.sample();
  }

  /** Our own connection came back, or the host changed: the route is new. */
  relearn(): void {
    this.clock.relearn();
  }
}
