/**
 * Wire quantization — every entity the host (SharedState arrays) or a client
 * (PlayerNetState) serializes at 20Hz passes through here on its way out.
 *
 * Why: raw float64 positions JSON-stringify at up to 17 significant digits
 * ("3811.9282936758663" — 18 bytes where "3811.9" carries everything the
 * receiver can use). Nothing downstream resolves below 0.1px: collision radii
 * are 8–80px, reconcile snaps at 80px, and guests re-integrate velocity every
 * frame anyway. Measured by scripts/wire-audit.ts, quantization cuts the
 * worst-case 32-player tick roughly in half with zero gameplay effect.
 *
 * Quantize ONLY at the serialization boundary: the host's working copy and
 * each client's local sim keep full precision (rounding inside the sim at
 * 60Hz would stall slow integrations below the step size).
 */

import type {
  AsteroidState,
  BeaconState,
  EnemyShotState,
  EnemyState,
  ItemState,
  PlayerNetState,
  PullState,
  SerializedBeam,
  ShardState,
  UfoState,
  Vec,
} from "./constants";

/** 0.1px — positions, velocities, radii, beam endpoints, asteroid verts. */
function q1(n: number): number {
  return Math.round(n * 10) / 10;
}
/** 0.001 rad (~0.06°) — headings. */
function q3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
/** Whole ms — host-clock deadlines/timestamps (sub-ms precision is noise). */
const qms = Math.round;

function qVec(v: Vec): Vec {
  return { x: q1(v.x), y: q1(v.y) };
}

export function asteroidToWire(a: AsteroidState): AsteroidState {
  return {
    id: a.id,
    x: q1(a.x),
    y: q1(a.y),
    vx: q1(a.vx),
    vy: q1(a.vy),
    radius: q1(a.radius),
    rot: q3(a.rot),
  };
}

export function ufoToWire(u: UfoState): UfoState {
  return {
    id: u.id,
    x: q1(u.x),
    y: q1(u.y),
    destX: q1(u.destX),
    destY: q1(u.destY),
    hp: q1(u.hp),
    blinkUntil: qms(u.blinkUntil),
  };
}

export function itemToWire(it: ItemState): ItemState {
  return {
    ...it,
    x: q1(it.x),
    y: q1(it.y),
    vx: q1(it.vx),
    vy: q1(it.vy),
    diesAt: qms(it.diesAt),
  };
}

export function enemyToWire(e: EnemyState): EnemyState {
  return {
    id: e.id,
    kind: e.kind,
    x: q1(e.x),
    y: q1(e.y),
    vx: q1(e.vx),
    vy: q1(e.vy),
    angle: q3(e.angle),
    hp: q1(e.hp),
    telegraphUntil: qms(e.telegraphUntil),
    chargeUntil: qms(e.chargeUntil),
    blinkUntil: qms(e.blinkUntil),
    graceUntil: qms(e.graceUntil),
    maxHp: e.maxHp,
    lances: e.lances.map(qVec),
    shielded: e.shielded,
  };
}

export function enemyShotToWire(s: EnemyShotState): EnemyShotState {
  return { id: s.id, x: q1(s.x), y: q1(s.y), vx: q1(s.vx), vy: q1(s.vy), diesAt: qms(s.diesAt) };
}

export function shardToWire(s: ShardState): ShardState {
  return { id: s.id, x: q1(s.x), y: q1(s.y), vx: q1(s.vx), vy: q1(s.vy), diesAt: qms(s.diesAt) };
}

export function beaconToWire(b: BeaconState): BeaconState {
  return {
    x: q1(b.x),
    y: q1(b.y),
    activeAt: qms(b.activeAt),
    diesAt: qms(b.diesAt),
    controllerId: b.controllerId,
    contested: b.contested,
  };
}

export function pullToWire(p: PullState): PullState {
  return { id: p.id, x: q1(p.x), y: q1(p.y), until: qms(p.until) };
}

export function beamToWire(b: SerializedBeam): SerializedBeam {
  const out: SerializedBeam = {
    ...b,
    hx: q1(b.hx),
    hy: q1(b.hy),
    tx: q1(b.tx),
    ty: q1(b.ty),
    explosionRadius: q1(b.explosionRadius),
  };
  if (b.chain) out.chain = b.chain.map(qVec);
  return out;
}

export function playerToWire(s: PlayerNetState): PlayerNetState {
  return {
    ...s,
    x: q1(s.x),
    y: q1(s.y),
    angle: q3(s.angle),
    vx: q1(s.vx),
    vy: q1(s.vy),
    // 0.01 windup steps — remotes only drive a glow alpha from it.
    windup: Math.round(s.windup * 100) / 100,
    shieldMod: s.shieldMod ? { ...s.shieldMod, until: qms(s.shieldMod.until) } : null,
    boosts: s.boosts.map((b) => ({ kind: b.kind, until: qms(b.until) })),
    sentry: s.sentry ? { x: q1(s.sentry.x), y: q1(s.sentry.y), until: qms(s.sentry.until) } : null,
    beams: s.beams.map(beamToWire),
  };
}
