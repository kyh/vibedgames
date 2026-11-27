import { Interpolator, RemoteClock, lerp, lerpAngle } from "@vibedgames/multiplayer";
import type { JsonRecord } from "@vibedgames/multiplayer";

import { bumperOut, carRadius, heldItem } from "../sim/car";
import type { BumperKind, Car, CarMode, HitHow, ModKind } from "../sim/car";
import type { Ghost } from "../sim/field";
import { isJsonNumber, isJsonObject, isJsonString, numberOr } from "./wire";
import type { WireField } from "./wire";

/** Everything the page draws and scores of any car, simulated here or not. */
export interface CarView {
  x: number;
  y: number;
  z: number;
  a: number;
  vx: number;
  vz: number;
  mode: CarMode;
  safe: boolean;
  boosting: boolean;
  staggered: boolean;
  /** The bumper can fire. */
  ready: boolean;
  dent: number;
  falls: number;
  lastBy: string;
  launches: number;
  hitId: string;
  hitHow: HitHow;
  punches: number;
  bumper: BumperKind;
  mod: ModKind;
  /** Seconds of cooldown left and boost meter 0–1: enough to take a bot over. */
  cooldown: number;
  meter: number;
}

/** A view plus when it was sent and which round it belongs to. */
export interface PoseReport extends CarView {
  t: number;
  round: number;
}

const MODES = ["drive", "fall", "out", "drop"] as const satisfies readonly CarMode[];
const BUMPERS = ["plain", "mega", "spring"] as const satisfies readonly BumperKind[];
const MODS = ["", "giant", "turbo"] as const satisfies readonly ModKind[];

const HOWS = [
  "punch",
  "ram",
  "bumper",
  "sweeper",
  "piston",
  "land",
] as const satisfies readonly HitHow[];

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export const viewOf: (car: Car) => CarView = (car) => ({
  a: car.a,
  boosting: car.boosting,
  bumper: car.bumper,
  cooldown: car.cooldown,
  dent: car.dent,
  falls: car.falls,
  hitHow: car.hitHow,
  hitId: car.hitId,
  lastBy: car.lastBy,
  launches: car.launches,
  meter: car.meter,
  mod: car.mod,
  mode: car.mode,
  punches: car.punches,
  ready: car.cooldown <= 0,
  safe: car.safe > 0,
  staggered: car.stagger > 0,
  vx: car.vx + car.kx,
  vz: car.vz + car.kz,
  x: car.x,
  y: car.y,
  z: car.z,
});

/** Short keys: this row leaves 20 times a second per car. */
export const encodeCar: (car: Car, t: number, round: number) => JsonRecord = (car, t, round) => ({
  a: round3(car.a),
  b: car.boosting ? 1 : 0,
  c: round1(car.cooldown),
  d: car.dent,
  e: round2(car.meter),
  f: car.falls,
  g: car.stagger > 0 ? 1 : 0,
  h: car.hitId,
  i: BUMPERS.indexOf(car.bumper),
  j: MODS.indexOf(car.mod),
  k: car.lastBy,
  l: car.launches,
  m: MODES.indexOf(car.mode),
  n: HOWS.indexOf(car.hitHow),
  p: car.punches,
  r: round,
  s: car.safe > 0 ? 1 : 0,
  t: Math.round(t),
  u: round1(car.vx + car.kx),
  w: round1(car.vz + car.kz),
  x: round2(car.x),
  y: round2(car.y),
  z: round2(car.z),
});

/** A wire row as a report, or null if it is not one (a player still on the title). */
export const readPose: (row: WireField) => PoseReport | null = (row) => {
  if (!isJsonObject(row)) {
    return null;
  }

  const { a, t, x, z } = row;

  if (!isJsonNumber(t) || !isJsonNumber(x) || !isJsonNumber(z) || !isJsonNumber(a)) {
    return null;
  }

  const cooldown = numberOr(row.c, 0);

  return {
    a,
    boosting: row.b === 1,
    bumper: BUMPERS[numberOr(row.i, 0)] ?? "plain",
    cooldown,
    dent: numberOr(row.d, 0),
    falls: numberOr(row.f, 0),
    hitHow: HOWS[numberOr(row.n, 0)] ?? "punch",
    hitId: isJsonString(row.h) ? row.h : "",
    lastBy: isJsonString(row.k) ? row.k : "",
    launches: numberOr(row.l, 0),
    meter: numberOr(row.e, 1),
    mod: MODS[numberOr(row.j, 0)] ?? "",
    mode: MODES[numberOr(row.m, 0)] ?? "drive",
    punches: numberOr(row.p, 0),
    ready: cooldown <= 0,
    round: numberOr(row.r, 0),
    safe: row.s === 1,
    staggered: row.g === 1,
    t,
    vx: numberOr(row.u, 0),
    vz: numberOr(row.w, 0),
    x,
    y: numberOr(row.y, 0),
    z,
  };
};

/** Put a car where a report says it is: a new host picking a bot up mid-round. */
export const adoptCar = (car: Car, report: PoseReport) => {
  Object.assign(car, {
    a: report.a,
    bumper: report.bumper,
    bumperUses: report.bumper === "plain" ? 0 : 1,
    cooldown: report.cooldown,
    dent: report.dent,
    falls: report.falls,
    hitId: report.hitId,
    lastBy: report.lastBy,
    lastByT: 0,
    launches: report.launches,
    meter: report.meter,
    mod: report.mod,
    modT: report.mod === "" ? 0 : 3,
    mode: report.mode,
    modeT: 0,
    punches: report.punches,
    safe: report.safe ? 1 : 0,
    vx: report.staggered ? 0 : report.vx,
    vy: 0,
    vz: report.staggered ? 0 : report.vz,
    x: report.x,
    y: report.y,
    z: report.z,
  } satisfies Partial<Car>);
};

export const ghostOf: (key: string, view: CarView) => Ghost = (key, view) => ({
  a: view.a,
  alive: view.mode === "drive",
  boosting: view.boosting,
  key,
  radius: view.mod === "giant" ? 1.56 : 1.2,
  safe: view.safe,
  vx: view.vx,
  vz: view.vz,
  x: view.x,
  y: view.y,
  z: view.z,
});

/** The same numbers for a car simulated here, so both kinds draw alike. */
export const drawnOf = (car: Car) => ({
  bumperOut: bumperOut(car),
  item: heldItem(car),
  radius: carRadius(car),
  steer: car.steer,
  tumble: car.tumble * car.spin,
});

const lerpView: (p: CarView, q: CarView, k: number) => CarView = (p, q, k) => {
  const near = k < 0.5 ? p : q;

  return {
    ...near,
    a: lerpAngle(p.a, q.a, k),
    vx: lerp(p.vx, q.vx, k),
    vz: lerp(p.vz, q.vz, k),
    x: lerp(p.x, q.x, k),
    y: lerp(p.y, q.y, k),
    z: lerp(p.z, q.z, k),
  };
};

const TELEPORT = 9;

export class RemoteTrack {
  private readonly clock: RemoteClock;
  private readonly interp: Interpolator<CarView>;
  private round = -1;
  private lastT = -1;

  /** Pass the host's shared clock for a bot; a human gets a clock of its own. */
  constructor(clock: RemoteClock = new RemoteClock()) {
    this.clock = clock;
    this.interp = new Interpolator<CarView>({
      clock: this.clock,
      delayMs: 100,
      lerp: lerpView,
      maxExtrapolateMs: 70,
    });
  }

  /** Feed the latest report. Call it every frame: a repeat is ignored. */
  push(report: PoseReport) {
    if (report.t === this.lastT && report.round === this.round) {
      return;
    }

    const { latest } = this.interp;

    const jumped =
      latest !== undefined &&
      (latest.mode !== report.mode && (latest.mode === "out" || report.mode === "drop")
        ? true
        : Math.hypot(latest.x - report.x, latest.z - report.z) > TELEPORT);

    if (report.round !== this.round || jumped) {
      this.interp.clear();
    }

    this.round = report.round;
    this.lastT = report.t;
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
