// How a guest's brawlers follow the host. Remote bodies are puppets blended
// toward the newest authoritative pose (never back toward a stale one); the
// guest's own body predicts from local input and is reconciled against the
// host's copy — a small error blends out over a few snapshots, a large one
// (knockback, a leap landing) snaps because the jerk is the feedback.
import type { Brawler } from "../entities/brawler";
import { damp, dampAngle } from "../utils";
import { terrainHeight } from "../world/terrain";
import type { NetBrawler } from "./snapshot";

export type BrawlerDrive = "sim" | "predict" | "puppet";

type NetworkBody = Pick<
  Brawler,
  | "alive"
  | "ammo"
  | "burst"
  | "cubes"
  | "deadT"
  | "drive"
  | "evadeCooldown"
  | "evasion"
  | "facing"
  | "flash"
  | "hp"
  | "inBush"
  | "kills"
  | "leap"
  | "maxHp"
  | "meleeCue"
  | "netAir"
  | "netTarget"
  | "rank"
  | "recoil"
  | "revealT"
  | "root"
  | "squash"
  | "superCharge"
  | "swing"
  | "vel"
>;

/** The last authoritative pose a guest received for a brawler. */
export interface NetTarget {
  /** Seconds since this pose arrived, for a touch of dead reckoning. */
  age: number;
  evadeAck: number;
  evadeAccepted: boolean;
  /** Local prediction waiting for the host's decision. */
  evadePending: number | null;
  facing: number;
  /** False until the first snapshot lands, so the first pose snaps. */
  fresh: boolean;
  vx: number;
  vz: number;
  x: number;
  y: number;
  z: number;
}

export const makeNetTarget = (): NetTarget => ({
  age: 0,
  evadeAccepted: false,
  evadeAck: 0,
  evadePending: null,
  facing: 0,
  fresh: false,
  vx: 0,
  vz: 0,
  x: 0,
  y: 0,
  z: 0,
});

/** Beyond this error the predicted body snaps to the host's position. */
const SNAP_DISTANCE = 1.5;
/** Below this error the prediction is trusted as-is. */
const DEAD_BAND = 0.12;
/** Fraction of a mid-sized error corrected per snapshot. */
const BLEND = 0.2;
/** How eagerly a puppet chases its target (per second). */
const PUPPET_LAMBDA = 20;
/** Longest a puppet keeps extrapolating along its last velocity. */
const MAX_EXTRAPOLATION = 0.2;

/** A new body or promoted host resumes the authoritative roll's remaining motion. */
export const restoreNetEvasion = (
  b: Pick<NetworkBody, "evasion" | "evadeCooldown" | "netTarget">,
  n: NetBrawler,
): void => {
  b.evasion = n.evasion ? { ...n.evasion } : null;
  b.evadeCooldown = n.evadeCooldown;
  b.netTarget.evadeAck = n.evadeAck;
  b.netTarget.evadeAccepted = n.evadeAccepted;
  b.netTarget.evadePending = null;
};

/** An accepted prediction keeps its own clock; an old snapshot cannot replay a roll. */
const syncEvasion = (
  b: NetworkBody,
  n: NetBrawler,
  first: boolean,
): "defer" | "reject" | "ready" => {
  const t = b.netTarget;
  const pending = t.evadePending;
  if (n.evadeAck < t.evadeAck || (pending !== null && n.evadeAck < pending)) {
    return "defer";
  }
  t.evadeAck = n.evadeAck;
  t.evadeAccepted = n.evadeAccepted;
  b.evadeCooldown = n.evadeCooldown;
  if (b.drive === "puppet" || (first && pending === null)) {
    b.evasion = n.evasion ? { ...n.evasion } : null;
  }
  if (pending !== null) {
    t.evadePending = null;
    if (!n.evadeAccepted) {
      b.evasion = null;
      return "reject";
    }
  }
  return b.drive === "predict" && (b.evasion || n.evasion) ? "defer" : "ready";
};

/** Move the predicted body onto the authoritative pose (leaps, big errors). */
export const snapToTarget = (b: NetworkBody): void => {
  const t = b.netTarget;
  b.root.position.set(t.x, b.netAir ? t.y : terrainHeight(t.x, t.z), t.z);
  b.vel.set(0, 0);
};

const reconcilePrediction = (b: NetworkBody): void => {
  const pos = b.root.position;
  const t = b.netTarget;
  const dx = t.x - pos.x;
  const dz = t.z - pos.z;
  const error = Math.hypot(dx, dz);
  if (b.netAir || error > SNAP_DISTANCE) {
    snapToTarget(b);
    return;
  }
  if (error > DEAD_BAND) {
    pos.x += dx * BLEND;
    pos.z += dz * BLEND;
  }
  pos.y = terrainHeight(pos.x, pos.z);
};

const applyVitals = (b: NetworkBody, n: NetBrawler): void => {
  if (n.hp < b.hp) {
    b.flash = 1;
    b.squash = 1;
  }
  if (n.ammo < b.ammo - 0.5 || n.charge < b.superCharge - 0.5) {
    b.recoil = 1;
  }
  b.hp = n.hp;
  b.maxHp = n.maxHp;
  b.ammo = n.ammo;
  b.superCharge = n.charge;
  b.cubes = n.cubes;
  b.kills = n.kills;
  b.rank = n.rank;
  b.meleeCue = n.melee ? { ...n.melee } : null;
  if (b.alive && !n.alive) {
    b.alive = false;
    b.hp = 0;
    b.deadT = 0;
    b.burst = null;
    b.swing = null;
    b.meleeCue = null;
    b.evasion = null;
    b.netTarget.evadePending = null;
    b.leap = null;
    b.netAir = false;
  }
};

/** Fold one snapshot row into a guest-driven brawler. */
export const applyNetState = (b: NetworkBody, n: NetBrawler): void => {
  const t = b.netTarget;
  const first = !t.fresh;
  const evasion = syncEvasion(b, n, first);
  t.x = n.x;
  t.y = n.y;
  t.z = n.z;
  t.vx = n.vx;
  t.vz = n.vz;
  t.facing = n.facing;
  t.age = 0;
  t.fresh = true;
  b.netAir = n.leap !== null;
  applyVitals(b, n);
  if (!b.alive) {
    return;
  }
  if (b.drive === "puppet") {
    b.inBush = n.bush;
    b.revealT = 0;
    if (first) {
      b.root.position.set(n.x, b.netAir ? n.y : terrainHeight(n.x, n.z), n.z);
      b.facing = n.facing;
    }
    return;
  }
  if (evasion === "defer") {
    return;
  }
  if (evasion === "reject") {
    snapToTarget(b);
    return;
  }
  reconcilePrediction(b);
};

/** Advance a puppet one frame toward its target; returns whether it reads as moving. */
export const steerPuppet = (b: NetworkBody, dt: number): boolean => {
  const pos = b.root.position;
  const t = b.netTarget;
  t.age += dt;
  const lead = Math.min(t.age, MAX_EXTRAPOLATION);
  const goalX = t.x + t.vx * lead;
  const goalZ = t.z + t.vz * lead;
  const fromX = pos.x;
  const fromZ = pos.z;
  pos.x = damp(pos.x, goalX, PUPPET_LAMBDA, dt);
  pos.z = damp(pos.z, goalZ, PUPPET_LAMBDA, dt);
  pos.y = b.netAir
    ? Math.max(terrainHeight(pos.x, pos.z), damp(pos.y, t.y, 30, dt))
    : terrainHeight(pos.x, pos.z);
  if (dt > 0) {
    b.vel.set((pos.x - fromX) / dt, (pos.z - fromZ) / dt);
  }
  b.facing = dampAngle(b.facing, t.facing, 24, dt);
  return b.vel.lengthSq() > 0.2 && !b.netAir;
};
