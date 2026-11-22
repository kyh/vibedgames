import { Interpolator, RemoteClock, lerp, lerpAngle } from "@vibedgames/multiplayer";

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
  /** Seconds of spin-out left. */
  spin: number;
  chassis: number;
  /** Glow orbs carried. */
  orbs: number;
  /** An item is in hand: item boxes pass this kart by. */
  holding: boolean;
}

/** A pose plus when it was sent and which round it belongs to. */
export interface PoseReport extends KartPose {
  t: number;
  round: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export const poseOf = (kart: Kart, holding = false) => ({
  a: kart.a,
  boosting: kart.boost > 0,
  charge: kart.charge,
  chassis: kart.chassis,
  drift: kart.drift,
  finishMs: kart.finishMs,
  holding,
  orbs: kart.orbs,
  prog: kart.prog,
  speed: kartSpeed(kart),
  spin: kart.spin,
  x: kart.x,
  z: kart.z,
});

/** Short keys: this row leaves 20 times a second per kart. */
export const encodePose = (kart: Kart, t: number, round: number, holding = false) => ({
  a: round3(kart.a),
  b: kart.boost > 0 ? 1 : 0,
  c: round2(kart.charge),
  d: kart.drift,
  f: kart.finishMs,
  h: holding ? 1 : 0,
  k: kart.chassis,
  n: round2(kart.spin),
  o: kart.orbs,
  p: round2(kart.prog),
  r: round,
  s: round2(kartSpeed(kart)),
  t: Math.round(t),
  x: round2(kart.x),
  z: round2(kart.z),
});

/** A wire row as a report, or null if it is not one (a player still on the title). */
export const readPose = (row: WireField) => {
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
    chassis: numberOr(row["k"], 0),
    drift: numberOr(row["d"], 0),
    finishMs: numberOr(row["f"], 0),
    holding: row["h"] === 1,
    orbs: numberOr(row["o"], 0),
    prog: numberOr(row["p"], 0),
    round: numberOr(row["r"], 0),
    speed: numberOr(row["s"], 0),
    spin: numberOr(row["n"], 0),
    t,
    x,
    z,
  };
};

const lerpPose = (p: KartPose, q: KartPose, k: number) => {
  const near = k < 0.5 ? p : q;

  return {
    a: lerpAngle(p.a, q.a, k),
    boosting: near.boosting,
    charge: near.charge,
    chassis: q.chassis,
    drift: near.drift,
    finishMs: q.finishMs,
    holding: q.holding,
    orbs: q.orbs,
    prog: lerp(p.prog, q.prog, k),
    speed: lerp(p.speed, q.speed, k),
    spin: near.spin,
    x: lerp(p.x, q.x, k),
    z: lerp(p.z, q.z, k),
  };
};

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
  push(report: PoseReport) {
    const { latest } = this.interp;

    if (
      latest !== undefined &&
      (report.round !== this.round ||
        Math.hypot(latest.x - report.x, latest.z - report.z) > TELEPORT)
    ) {
      this.interp.clear();
    }

    this.round = report.round;
    this.interp.push(report.t, report);
  }

  sample() {
    return this.interp.sample();
  }

  /** Our own connection came back, or the host changed: the route is new. */
  relearn() {
    this.clock.relearn();
  }
}
