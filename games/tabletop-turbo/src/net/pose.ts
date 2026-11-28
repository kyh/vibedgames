import { Interpolator, RemoteClock, lerp, lerpAngle } from "@vibedgames/multiplayer";
import type { JsonRecord, JsonValue } from "@vibedgames/multiplayer";

import { CAR_RADIUS } from "../shared/constants";
import { attackClock, carRadius, swingAt } from "../sim/car";
import type { Car, CarMode, HitHow } from "../sim/car";
import type { Ghost } from "../sim/field";
import { CAR_KINDS, KINDS } from "../sim/kinds";
import type { CarKind } from "../sim/kinds";
import { SHOT_KINDS, makeShot } from "../sim/shots";
import type { Shot } from "../sim/shots";
import { GIANT_RADIUS, SPECIALS } from "../sim/specials";
import type { ModKind, SpecialKind } from "../sim/specials";
import { isJsonNumber, isJsonObject, isJsonString, numberOr } from "./wire";
import type { WireField } from "./wire";

/** Everything the page draws and scores of any car, simulated here or not. */
export interface CarView {
  kind: CarKind;
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
  slipping: boolean;
  /** The attack can go off. */
  ready: boolean;
  damage: number;
  falls: number;
  lastBy: string;
  /** Who its last fall belongs to: what the host scores from. */
  outBy: string;
  launches: number;
  hitId: string;
  hitHow: HitHow;
  attacks: number;
  special: SpecialKind | "";
  uses: number;
  usedKind: SpecialKind | "";
  mod: ModKind;
  /** Seconds of cooldown left and boost meter 0–1: enough to take a bot over. */
  cooldown: number;
  meter: number;
}

/** A view plus when it was sent, which round it belongs to, its colour and what it has let go. */
export interface PoseReport extends CarView {
  t: number;
  round: number;
  /** Which of the car colours it wears. */
  colour: number;
  shots: readonly ShotRow[];
}

/**
 * A shot as its owner reports it: enough for anyone to fly it the same way.
 * Where and which way it was let go, except a seeker, which turns as it goes
 * and so says where it is now.
 */
export interface ShotRow {
  seq: number;
  kind: Shot["kind"];
  x: number;
  z: number;
  a: number;
  t: number;
  target: string;
}

const MODES = ["drive", "fall", "out", "drop"] as const satisfies readonly CarMode[];
const MODS = ["", "giant", "turbo", "shield"] as const satisfies readonly ModKind[];

/** Every way a car can be thrown, in wire order. */
export const HOWS = [
  "punch",
  "dash",
  "slam",
  "shot",
  "scoop",
  "spin",
  "ram",
  "bumper",
  "sweeper",
  "piston",
  "land",
  "rocket",
  "seeker",
  "mine",
  "shock",
  "magnet",
  "zap",
  "stomp",
] as const satisfies readonly HitHow[];

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export const viewOf: (car: Car) => CarView = (car) => ({
  a: car.a,
  attacks: car.attacks,
  boosting: car.boosting,
  cooldown: car.cooldown,
  damage: car.damage,
  falls: car.falls,
  hitHow: car.hitHow,
  hitId: car.hitId,
  kind: car.kind,
  lastBy: car.lastBy,
  launches: car.launches,
  meter: car.meter,
  mod: car.mod,
  mode: car.mode,
  outBy: car.outBy,
  ready: car.cooldown <= 0,
  safe: car.safe > 0,
  slipping: car.slip > 0,
  special: car.special,
  staggered: car.stagger > 0,
  usedKind: car.usedKind,
  uses: car.uses,
  vx: car.vx + car.kx,
  vz: car.vz + car.kz,
  x: car.x,
  y: car.y,
  z: car.z,
});

const seqOf = (id: string) => Number(id.slice(id.lastIndexOf(":") + 1)) || 0;

const shotRows = (shots: readonly Shot[], by: string) => {
  const rows: JsonValue[] = [];

  for (const shot of shots) {
    if (shot.own && shot.by === by && !shot.dead) {
      const steered = shot.kind === "seeker";
      rows.push([
        seqOf(shot.id),
        SHOT_KINDS.indexOf(shot.kind),
        round2(steered ? shot.x : shot.x0),
        round2(steered ? shot.z : shot.z0),
        round3(steered ? shot.a : shot.a0),
        round3(shot.t0),
        shot.target,
      ]);
    }
  }

  return rows;
};

/** Short keys: this row leaves 20 times a second per car. */
export const encodeCar: (
  car: Car,
  t: number,
  round: number,
  colour: number,
  shots: readonly Shot[],
) => JsonRecord = (car, t, round, colour, shots) => ({
  a: round3(car.a),
  b: car.boosting ? 1 : 0,
  c: round1(car.cooldown),
  co: colour,
  d: Math.round(car.damage),
  e: round2(car.meter),
  f: car.falls,
  g: car.stagger > 0 ? 1 : 0,
  h: car.hitId,
  i: car.special === "" ? 0 : SPECIALS.indexOf(car.special) + 1,
  j: MODS.indexOf(car.mod),
  k: car.lastBy,
  l: car.launches,
  m: MODES.indexOf(car.mode),
  n: HOWS.indexOf(car.hitHow),
  o: car.outBy,
  p: car.attacks,
  q: CAR_KINDS.indexOf(car.kind),
  r: round,
  s: car.safe > 0 ? 1 : 0,
  sh: shotRows(shots, car.key),
  t: Math.round(t),
  u: round1(car.vx + car.kx),
  uk: car.usedKind === "" ? 0 : SPECIALS.indexOf(car.usedKind) + 1,
  un: car.uses,
  v: car.slip > 0 ? 1 : 0,
  w: round1(car.vz + car.kz),
  x: round2(car.x),
  y: round2(car.y),
  z: round2(car.z),
});

const readShot: (row: JsonValue) => ShotRow | null = (row) => {
  if (!Array.isArray(row)) {
    return null;
  }

  const [seq, kind, x, z, a, t, target] = row;
  const known = SHOT_KINDS[numberOr(kind, -1)];

  if (!isJsonNumber(seq) || !known || !isJsonNumber(x) || !isJsonNumber(z)) {
    return null;
  }

  return {
    a: numberOr(a, 0),
    kind: known,
    seq,
    t: numberOr(t, 0),
    target: isJsonString(target) ? target : "",
    x,
    z,
  };
};

const readShots = (value: WireField) => {
  const out: ShotRow[] = [];

  for (const row of Array.isArray(value) ? value.slice(0, 24) : []) {
    const shot = readShot(row);

    if (shot) {
      out.push(shot);
    }
  }

  return out;
};

const special = (value: WireField) => SPECIALS[numberOr(value, 0) - 1] ?? "";

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
    attacks: numberOr(row.p, 0),
    boosting: row.b === 1,
    colour: Math.max(0, Math.floor(numberOr(row.co, 0))),
    cooldown,
    damage: Math.max(0, numberOr(row.d, 0)),
    falls: numberOr(row.f, 0),
    hitHow: HOWS[numberOr(row.n, 0)] ?? "punch",
    hitId: isJsonString(row.h) ? row.h : "",
    kind: CAR_KINDS[numberOr(row.q, 0)] ?? "bumper",
    lastBy: isJsonString(row.k) ? row.k : "",
    launches: numberOr(row.l, 0),
    meter: numberOr(row.e, 1),
    mod: MODS[numberOr(row.j, 0)] ?? "",
    mode: MODES[numberOr(row.m, 0)] ?? "drive",
    outBy: isJsonString(row.o) ? row.o : "",
    ready: cooldown <= 0,
    round: numberOr(row.r, 0),
    safe: row.s === 1,
    shots: readShots(row.sh),
    slipping: row.v === 1,
    special: special(row.i),
    staggered: row.g === 1,
    t,
    usedKind: special(row.uk),
    uses: numberOr(row.un, 0),
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
    attacks: report.attacks,
    cooldown: report.cooldown,
    cooldownOf: Math.max(report.cooldown, KINDS[report.kind].cooldown),
    damage: report.damage,
    falls: report.falls,
    hitId: report.hitId,
    kind: report.kind,
    lastBy: report.lastBy,
    lastByT: 0,
    launches: report.launches,
    meter: report.meter,
    mod: report.mod,
    modT: report.mod === "" ? 0 : 3,
    mode: report.mode,
    modeT: 0,
    outBy: report.outBy,
    safe: report.safe ? 1 : 0,
    special: report.special,
    usedKind: report.usedKind,
    uses: report.uses,
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
  radius: CAR_RADIUS * (view.mod === "giant" ? GIANT_RADIUS : 1),
  safe: view.safe,
  vx: view.vx,
  vz: view.vz,
  x: view.x,
  y: view.y,
  z: view.z,
});

/** Somebody else's shot, rebuilt from its owner's row: it only moves here, it never hits. */
export const shotOf = (owner: string, round: number, row: ShotRow) => {
  const shot = makeShot(`${owner}:${round}:${row.seq}`, row.kind, owner, row, false);
  shot.target = row.target;

  return shot;
};

/** The same numbers for a car simulated here, so both kinds draw alike. */
export const drawnOf = (car: Car) => ({
  radius: carRadius(car),
  steer: car.steer,
  swing: swingAt(car.kind, attackClock(car)),
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
