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
const q1 = (n: number): number => Math.round(n * 10) / 10;
/** 0.001 rad (~0.06°) — headings. */
const q3 = (n: number): number => Math.round(n * 1000) / 1000;
/** Whole ms — host-clock deadlines/timestamps (sub-ms precision is noise). */
const qms = Math.round;

const qVec = (v: Vec): Vec => ({ x: q1(v.x), y: q1(v.y) });

export const asteroidToWire = (a: AsteroidState): AsteroidState => ({
  id: a.id,
  radius: q1(a.radius),
  rot: q3(a.rot),
  vx: q1(a.vx),
  vy: q1(a.vy),
  x: q1(a.x),
  y: q1(a.y),
});

export const ufoToWire = (u: UfoState): UfoState => ({
  blinkUntil: qms(u.blinkUntil),
  destX: q1(u.destX),
  destY: q1(u.destY),
  hp: q1(u.hp),
  id: u.id,
  x: q1(u.x),
  y: q1(u.y),
});

export const itemToWire = (it: ItemState): ItemState => ({
  ...it,
  diesAt: qms(it.diesAt),
  vx: q1(it.vx),
  vy: q1(it.vy),
  x: q1(it.x),
  y: q1(it.y),
});

export const enemyToWire = (e: EnemyState): EnemyState => ({
  angle: q3(e.angle),
  attackAt: qms(e.attackAt),
  blinkUntil: qms(e.blinkUntil),
  chargeUntil: qms(e.chargeUntil),
  graceUntil: qms(e.graceUntil),
  hp: q1(e.hp),
  id: e.id,
  kind: e.kind,
  lances: e.lances.map(qVec),
  maxHp: e.maxHp,
  shielded: e.shielded,
  telegraphUntil: qms(e.telegraphUntil),
  vx: q1(e.vx),
  vy: q1(e.vy),
  x: q1(e.x),
  y: q1(e.y),
});

export const enemyShotToWire = (s: EnemyShotState): EnemyShotState => ({
  diesAt: qms(s.diesAt),
  id: s.id,
  vx: q1(s.vx),
  vy: q1(s.vy),
  x: q1(s.x),
  y: q1(s.y),
});

export const shardToWire = (s: ShardState): ShardState => ({
  diesAt: qms(s.diesAt),
  id: s.id,
  vx: q1(s.vx),
  vy: q1(s.vy),
  x: q1(s.x),
  y: q1(s.y),
});

export const beaconToWire = (b: BeaconState): BeaconState => ({
  activeAt: qms(b.activeAt),
  contested: b.contested,
  controllerId: b.controllerId,
  diesAt: qms(b.diesAt),
  x: q1(b.x),
  y: q1(b.y),
});

export const pullToWire = (p: PullState): PullState => ({
  id: p.id,
  until: qms(p.until),
  x: q1(p.x),
  y: q1(p.y),
});

export const beamToWire = (b: SerializedBeam): SerializedBeam => {
  const out: SerializedBeam = {
    ...b,
    explosionRadius: q1(b.explosionRadius),
    hx: q1(b.hx),
    hy: q1(b.hy),
    tx: q1(b.tx),
    ty: q1(b.ty),
  };
  if (b.chain) {
    out.chain = b.chain.map(qVec);
  }
  return out;
};

export const playerToWire = (s: PlayerNetState): PlayerNetState => ({
  ...s,
  angle: q3(s.angle),
  beams: s.beams.map(beamToWire),
  boosts: s.boosts.map((b) => ({ kind: b.kind, until: qms(b.until) })),
  sentry: s.sentry ? { until: qms(s.sentry.until), x: q1(s.sentry.x), y: q1(s.sentry.y) } : null,
  shieldMod: s.shieldMod ? { ...s.shieldMod, until: qms(s.shieldMod.until) } : null,
  vx: q1(s.vx),
  vy: q1(s.vy),
  // 0.01 windup steps — remotes only drive a glow alpha from it.
  windup: Math.round(s.windup * 100) / 100,
  x: q1(s.x),
  y: q1(s.y),
});
