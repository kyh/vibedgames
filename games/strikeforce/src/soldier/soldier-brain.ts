// How a computer-played soldier fights: what it sees, where it goes, when and
// how well it shoots. Shared by deathmatch bots (src/net/bots.ts) and the
// garrison in Mission and Holdout (src/garrison/garrison.ts). Knows nothing of
// rosters, networks or meshes: its owner hands it the people it may shoot and
// `Orders` saying where to wander, whether it may open fire, and what a shot
// does.
//
// It is a worse shot than a person on purpose: it reacts late, fires bursts
// slower than the rifle, and misses more with range, movement and crouching.
//
// It moves like something with weight: it speeds up and slows down at its
// gait's `accel`, eases into and out of a turn, slows for a corner it is not
// yet facing, cuts corners it can see past, commits to a sidestep (or to
// standing its ground) for a second or two, and all but plants its feet to
// fire a burst.
import { Vector3 } from "three";

import type { Physics } from "../core/types";

export interface Point {
  x: number;
  y: number;
  z: number;
}

/** Someone a soldier may shoot. */
export interface Combatant {
  id: string;
  /** Feet. */
  pos: Point;
  crouch: boolean;
  moving: boolean;
}

export interface Marksmanship {
  /** Seconds from first sight to the first shot. */
  reaction: readonly [number, number];
  /** Seconds between shots in a burst. */
  cadence: number;
  burst: readonly [number, number];
  /** Seconds between bursts. */
  pause: readonly [number, number];
  /** Hit chance up close, what each metre takes off it, and its floor. */
  hit: number;
  falloff: number;
  minHit: number;
  damage: number;
  headChance: number;
}

export interface Gait {
  walk: number;
  run: number;
  strafe: number;
  /** Closer than this it stops advancing on its target. */
  hold: number;
  /** Radians per second. */
  turn: number;
  /** Metres per second squared: how hard it starts; it stops half as hard again. */
  accel: number;
  /** Seconds it stands at the end of a patrol leg before the next. */
  pause: readonly [number, number];
}

export interface Senses {
  range: number;
  /** Cosine of half the field of view. */
  cone: number;
  /** Seconds a target may be out of sight before it goes looking. */
  lose: number;
  /** Seconds it searches where it last saw (or heard) someone. */
  search: number;
}

export interface Profile {
  aim: Marksmanship;
  gait: Gait;
  senses: Senses;
}

/** A shot fired: the owner applies the hit and shows the tracer. */
export interface Shot {
  shooter: string;
  /** Who it hit, if anyone. */
  victim: string | null;
  damage: number;
  head: boolean;
  muzzle: Vector3;
  end: Vector3;
}

export interface Orders {
  /** Where an unalerted soldier walks next, or null to stand. */
  wander: (soldier: SoldierBrain) => Vector3 | null;
  /** May it open a burst now? (The garrison rations who fires at once.) */
  mayOpenFire: (soldier: SoldierBrain) => boolean;
  /** Its burst is over, or it lost the target mid-burst. Only needed when `mayOpenFire` rations. */
  ceaseFire?: (soldier: SoldierBrain) => void;
  fire: (shot: Shot) => void;
}

/** The core's physics, as far as a soldier needs it. */
export type World = Pick<Physics, "groundHeight" | "lineOfSight" | "nav">;

type Mode =
  | { kind: "idle" }
  /** Heading to a place to look around it. */
  | { kind: "hunt"; at: Vector3; search: number; arrived: boolean }
  | { kind: "fight"; target: string; react: number; lost: number };

const EYE = 1.55;
const CHEST = 1.15;
const CROUCH_CHEST = 0.8;
/** How often it looks around, in seconds. */
const THINK = 0.2;
/** Extra reaction when it was caught calm: whoever surprises it shoots first. */
const SURPRISE = 0.35;

/** How eagerly a turn closes its last few degrees, per second. */
const TURN_EASE = 9;
/** Seconds a fighter keeps to one sidestep, or to standing still. */
const COMMIT: readonly [number, number] = [1.1, 2.6];
/** How much of its pace it keeps while firing a burst. */
const FIRING_PACE = 0.3;
/** Path waypoints count as reached this close; the last one closer. */
const CORNER = 0.9;
const ARRIVE = 0.45;

const between = ([lo, hi]: readonly [number, number]): number => lo + Math.random() * (hi - lo);

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** The yaw that faces from `a` towards `b` (the camera looks down -Z at yaw 0). */
const yawTo = (a: Point, b: Point): number => Math.atan2(-(b.x - a.x), -(b.z - a.z));

const chestOf = (c: Combatant, out: Vector3): Vector3 =>
  out.set(c.pos.x, c.pos.y + (c.crouch ? CROUCH_CHEST : CHEST), c.pos.z);

export class SoldierBrain {
  readonly id: string;
  readonly pos = new Vector3();
  yaw = 0;
  pitch = 0;
  private readonly world: World;
  private readonly profile: Profile;
  private mode: Mode = { kind: "idle" };
  private path: Vector3[] = [];
  /** Where it last saw its target. */
  private readonly last = new Vector3();
  private cooldown = 0;
  private burst = 0;
  private think = Math.random() * THINK;
  private readonly vel = new Vector3();
  /** -1 left, 1 right, 0 holding still. */
  private strafe = 0;
  private strafeT = 0;
  private stuck = 0;
  private rest = 0;
  private readonly eye = new Vector3();
  private readonly aim = new Vector3();

  constructor(id: string, world: World, profile: Profile) {
    this.id = id;
    this.world = world;
    this.profile = profile;
  }

  /** Who it is fighting, if anyone. */
  get target(): string | null {
    return this.mode.kind === "fight" ? this.mode.target : null;
  }

  get alerted(): boolean {
    return this.mode.kind !== "idle";
  }

  /** Stand here, calm, facing `yaw`. */
  place(at: Point, yaw: number, orders: Orders): void {
    this.stop(orders);
    this.pos.set(at.x, at.y, at.z);
    this.yaw = yaw;
    this.pitch = 0;
    this.vel.set(0, 0, 0);
    this.mode = { kind: "idle" };
    this.path = [];
  }

  /** Heard or felt something at `at`: unless already fighting, go and look. */
  investigate(at: Point): void {
    if (this.mode.kind === "fight") {
      return;
    }
    this.mode = { arrived: false, at: new Vector3(at.x, 0, at.z), kind: "hunt", search: 0 };
    this.path = this.world.nav.findPath(this.pos, this.mode.at) ?? [];
  }

  /** Down, or gone: give back the right to fire. */
  stop(orders: Orders): void {
    if (this.burst > 0) {
      this.burst = 0;
      orders.ceaseFire?.(this);
    }
  }

  update(dt: number, people: readonly Combatant[], orders: Orders): void {
    this.think -= dt;
    if (this.think <= 0) {
      this.think = THINK;
      this.look(people, orders);
      this.cutCorner();
    }
    const target =
      this.mode.kind === "fight" ? (people.find((p) => p.id === this.target) ?? null) : null;
    if (this.mode.kind === "fight" && target) {
      this.fight(this.mode, target, dt, orders);
    } else if (this.mode.kind === "hunt") {
      this.hunt(this.mode, dt);
    } else {
      this.wander(dt, orders);
    }
    this.pos.y = this.world.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.6);
  }

  /** Where its muzzle is, near enough for a tracer. */
  muzzle(out: Vector3): Vector3 {
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    return out.set(
      this.pos.x + fx * 0.8 - fz * 0.1,
      this.pos.y + 1.36,
      this.pos.z + fz * 0.8 + fx * 0.1,
    );
  }

  private eyeAt(): Vector3 {
    return this.eye.set(this.pos.x, this.pos.y + EYE, this.pos.z);
  }

  private sees(c: Combatant, fov: boolean): boolean {
    const dx = c.pos.x - this.pos.x;
    const dz = c.pos.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > this.profile.senses.range) {
      return false;
    }
    if (fov && d > 2) {
      const facing = (-Math.sin(this.yaw) * dx - Math.cos(this.yaw) * dz) / d;
      if (facing < this.profile.senses.cone) {
        return false;
      }
    }
    return this.world.lineOfSight(this.eyeAt(), chestOf(c, this.aim));
  }

  private look(people: readonly Combatant[], orders: Orders): void {
    const { mode } = this;
    if (mode.kind === "fight") {
      const current = people.find((p) => p.id === mode.target);
      // Once engaged it tracks all round, not just ahead.
      if (current && this.sees(current, false)) {
        mode.lost = 0;
        this.last.set(current.pos.x, 0, current.pos.z);
        return;
      }
      mode.lost += THINK;
      if (current && mode.lost < this.profile.senses.lose) {
        return;
      }
    }
    let best: Combatant | null = null;
    let bestD = Infinity;
    for (const p of people) {
      const d = Math.hypot(p.pos.x - this.pos.x, p.pos.z - this.pos.z);
      // Owners may hand it a list with itself in (bots all see each other).
      if (p.id !== this.id && d < bestD && this.sees(p, true)) {
        best = p;
        bestD = d;
      }
    }
    if (best) {
      if (mode.kind !== "fight" || mode.target !== best.id) {
        this.stop(orders);
        this.mode = {
          kind: "fight",
          lost: 0,
          react: between(this.profile.aim.reaction) + (mode.kind === "idle" ? SURPRISE : 0),
          target: best.id,
        };
      }
      this.last.set(best.pos.x, 0, best.pos.z);
    } else if (mode.kind === "fight") {
      this.stop(orders);
      this.investigate(this.last);
    }
  }

  private fight(
    mode: Extract<Mode, { kind: "fight" }>,
    t: Combatant,
    dt: number,
    orders: Orders,
  ): void {
    const { aim, gait } = this.profile;
    this.path = [];
    const want = yawTo(this.pos, t.pos);
    this.turn(want, dt);
    const dist = Math.hypot(t.pos.x - this.pos.x, t.pos.z - this.pos.z);
    const chest = chestOf(t, this.aim);
    const pitch = Math.atan2(chest.y - (this.pos.y + EYE), dist);
    this.pitch += (pitch - this.pitch) * (1 - Math.exp(-10 * dt));

    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      this.sidestep();
    }
    // Close to its hold distance; give ground to someone on top of it.
    let advance = 0;
    if (dist > gait.hold) {
      advance = 1;
    } else if (dist < gait.hold * 0.35) {
      advance = -0.6;
    }
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    // Right of facing is (-fz, fx).
    const wx = fx * advance - fz * this.strafe;
    const wz = fz * advance + fx * this.strafe;
    const pace =
      (gait.strafe * (this.burst > 0 ? FIRING_PACE : 1)) / Math.max(1, Math.hypot(wx, wz));
    if (!this.steer(wx * pace, wz * pace, dt) && this.strafe !== 0) {
      this.strafe = -this.strafe;
      this.strafeT = between(COMMIT);
    }

    mode.react -= dt;
    this.cooldown -= dt;
    const onTarget = Math.abs(wrap(want - this.yaw)) < 0.15;
    if (mode.react > 0 || this.cooldown > 0 || !onTarget || mode.lost > 0) {
      return;
    }
    if (this.burst <= 0) {
      if (!orders.mayOpenFire(this)) {
        this.cooldown = 0.3;
        return;
      }
      this.burst = Math.round(between(aim.burst));
    }
    this.burst -= 1;
    if (this.burst > 0) {
      this.cooldown = aim.cadence;
    } else {
      this.cooldown = between(aim.pause);
      orders.ceaseFire?.(this);
    }
    this.shoot(t, dist, orders);
  }

  private shoot(t: Combatant, dist: number, orders: Orders): void {
    const { aim } = this.profile;
    const muzzle = this.muzzle(new Vector3());
    const end = chestOf(t, new Vector3());
    let chance = Math.max(aim.minHit, aim.hit - dist * aim.falloff);
    if (t.moving) {
      chance *= 0.75;
    }
    if (t.crouch) {
      chance *= 0.85;
    }
    const hit = this.world.lineOfSight(muzzle, end) && Math.random() < chance;
    const head = hit && Math.random() < aim.headChance;
    if (head) {
      end.y += t.crouch ? 0.35 : 0.47;
    }
    if (!hit) {
      // A near miss: past the target by a body's width or so.
      end.x += between([-1.2, 1.2]);
      end.y += between([-0.5, 0.9]);
      end.z += between([-1.2, 1.2]);
    }
    orders.fire({
      damage: head ? aim.damage * 2 : aim.damage,
      end,
      head,
      muzzle,
      shooter: this.id,
      victim: hit ? t.id : null,
    });
  }

  private hunt(mode: Extract<Mode, { kind: "hunt" }>, dt: number): void {
    if (!mode.arrived) {
      if (this.follow(this.profile.gait.run, dt)) {
        return;
      }
      mode.arrived = true;
    }
    mode.search += dt;
    if (mode.search > this.profile.senses.search) {
      this.mode = { kind: "idle" };
      return;
    }
    if (this.path.length === 0) {
      const { nav } = this.world;
      this.path = nav.findPath(this.pos, nav.randomPoint(mode.at, 7)) ?? [];
    }
    this.follow(this.profile.gait.walk, dt);
  }

  /** Pick the next sidestep: the other way, or now and then none at all. */
  private sidestep(): void {
    this.strafeT = between(COMMIT);
    if (this.strafe === 0) {
      this.strafe = Math.random() < 0.5 ? -1 : 1;
    } else {
      this.strafe = Math.random() < 0.35 ? 0 : -this.strafe;
    }
  }

  /** Drop the next waypoint when the one after it is a straight walk away. */
  private cutCorner(): void {
    const [, after] = this.path;
    if (!after) {
      return;
    }
    const { nav } = this.world;
    const dx = after.x - this.pos.x;
    const dz = after.z - this.pos.z;
    const steps = Math.ceil(Math.hypot(dx, dz) / 0.4);
    for (let i = 1; i <= steps; i += 1) {
      if (!nav.isWalkable(this.pos.x + (dx * i) / steps, this.pos.z + (dz * i) / steps)) {
        return;
      }
    }
    this.path.shift();
  }

  private wander(dt: number, orders: Orders): void {
    if (this.path.length === 0) {
      this.rest -= dt;
      if (this.rest > 0) {
        this.steer(0, 0, dt);
        return;
      }
      const to = orders.wander(this);
      this.path = to ? (this.world.nav.findPath(this.pos, to) ?? []) : [];
    }
    if (!this.follow(this.profile.gait.walk, dt)) {
      this.rest = between(this.profile.gait.pause);
    }
  }

  /** Walk the path at `speed`. False once there is nowhere left to go. */
  private follow(speed: number, dt: number): boolean {
    const [next] = this.path;
    if (!next) {
      this.steer(0, 0, dt);
      return false;
    }
    const dx = next.x - this.pos.x;
    const dz = next.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    const last = this.path.length === 1;
    if (d < (last ? ARRIVE : CORNER)) {
      this.path.shift();
      return !last;
    }
    const heading = Math.atan2(-dx, -dz);
    this.turn(heading, dt);
    this.pitch *= 1 - Math.min(1, dt * 4);
    // Facing the wrong way it all but stops and turns first, rather than slide sideways.
    const facing = Math.max(0.12, Math.min(1, (Math.cos(wrap(heading - this.yaw)) - 0.1) / 0.6));
    // And it brakes into the end of the path.
    const brake = last ? Math.sqrt(2 * this.profile.gait.accel * d) : speed;
    const pace = (Math.min(speed, brake) * facing) / d;
    if (this.steer(dx * pace, dz * pace, dt)) {
      this.stuck = 0;
    } else {
      this.stuck += dt;
      if (this.stuck > 0.6) {
        this.stuck = 0;
        this.path = [];
      }
    }
    return true;
  }

  private turn(to: number, dt: number): void {
    const off = wrap(to - this.yaw);
    const rate = Math.min(this.profile.gait.turn, Math.max(0.5, Math.abs(off) * TURN_EASE));
    this.yaw = wrap(this.yaw + Math.sign(off) * Math.min(Math.abs(off), rate * dt));
  }

  /**
   * Bring its velocity towards (vx, vz) at its gait's acceleration and move.
   * False when it wanted to go somewhere and a wall said no.
   */
  private steer(vx: number, vz: number, dt: number): boolean {
    const { accel } = this.profile.gait;
    const dvx = vx - this.vel.x;
    const dvz = vz - this.vel.z;
    const dv = Math.hypot(dvx, dvz);
    const slowing = Math.hypot(vx, vz) < Math.hypot(this.vel.x, this.vel.z);
    const k = dv > 0 ? Math.min(1, ((slowing ? accel * 1.5 : accel) * dt) / dv) : 0;
    this.vel.x += dvx * k;
    this.vel.z += dvz * k;
    const moved = this.walk(this.vel.x * dt, this.vel.z * dt);
    return moved || Math.hypot(vx, vz) < 0.05;
  }

  /** Step on the walkable grid, sliding along an edge. False if it went nowhere. */
  private walk(dx: number, dz: number): boolean {
    const { nav } = this.world;
    const { x, z } = this.pos;
    if (nav.isWalkable(x + dx, z + dz)) {
      this.pos.x += dx;
      this.pos.z += dz;
    } else if (nav.isWalkable(x + dx, z)) {
      this.pos.x += dx;
      this.vel.z = 0;
    } else if (nav.isWalkable(x, z + dz)) {
      this.pos.z += dz;
      this.vel.x = 0;
    } else {
      this.vel.set(0, 0, 0);
      return false;
    }
    return Math.abs(dx) + Math.abs(dz) > 0;
  }
}
