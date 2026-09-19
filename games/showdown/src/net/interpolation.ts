// How a guest's brawlers follow the host. Remote bodies are puppets blended
// toward the newest authoritative pose (never back toward a stale one); the
// guest's own body predicts from local input and is reconciled against the
// host's copy — a small error blends out over a few snapshots, a large one
// (knockback, a leap landing) snaps because the jerk is the feedback.
import type { Brawler } from "../entities/brawler";
import { damp, dampAngle } from "../utils";
import type { NetBrawler } from "./snapshot";

export type BrawlerDrive = "sim" | "predict" | "puppet";

/** The last authoritative pose a guest received for a brawler. */
export interface NetTarget {
  /** Seconds since this pose arrived, for a touch of dead reckoning. */
  age: number;
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

/** Move the predicted body onto the authoritative pose (leaps, big errors). */
export const snapToTarget = (b: Brawler): void => {
  const t = b.netTarget;
  b.root.position.set(t.x, t.y, t.z);
  b.vel.set(0, 0);
};

const reconcilePrediction = (b: Brawler): void => {
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
  pos.y = 0;
};

const applyVitals = (b: Brawler, n: NetBrawler): void => {
  if (n.hp < b.hp) {
    b.flash = 1;
    b.squash = 1;
  }
  if (n.ammo < b.ammo - 0.5) {
    b.recoil = 1;
  }
  b.hp = n.hp;
  b.maxHp = n.maxHp;
  b.ammo = n.ammo;
  b.superCharge = n.charge;
  b.cubes = n.cubes;
  b.kills = n.kills;
  b.rank = n.rank;
  if (b.alive && !n.alive) {
    b.alive = false;
    b.hp = 0;
    b.deadT = 0;
    b.burst = null;
    b.leap = null;
    b.netAir = false;
  }
};

/** Fold one snapshot row into a guest-driven brawler. */
export const applyNetState = (b: Brawler, n: NetBrawler): void => {
  const t = b.netTarget;
  const first = !t.fresh;
  t.x = n.x;
  t.y = n.y;
  t.z = n.z;
  t.vx = n.vx;
  t.vz = n.vz;
  t.facing = n.facing;
  t.age = 0;
  t.fresh = true;
  b.netAir = n.y > 0.001;
  applyVitals(b, n);
  if (!b.alive) {
    return;
  }
  if (b.drive === "puppet") {
    b.inBush = n.bush;
    b.revealT = 0;
    if (first) {
      b.root.position.set(n.x, n.y, n.z);
      b.facing = n.facing;
    }
    return;
  }
  reconcilePrediction(b);
};

/** Advance a puppet one frame toward its target; returns whether it reads as moving. */
export const steerPuppet = (b: Brawler, dt: number): boolean => {
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
  pos.y = b.netAir ? damp(pos.y, t.y, 30, dt) : 0;
  if (dt > 0) {
    b.vel.set((pos.x - fromX) / dt, (pos.z - fromZ) / dt);
  }
  b.facing = dampAngle(b.facing, t.facing, 24, dt);
  return b.vel.lengthSq() > 0.2 && !b.netAir;
};
