// Points under gravity, held to each other by distance limits and kept out
// of the level: position-based (Verlet) dynamics, where a point's velocity is
// only the difference between where it is and where it was. Limits are
// satisfied by moving points, so a tangle of them settles instead of blowing
// up, and a body built of them needs no physics engine. The ragdoll
// (ragdoll.ts) is the only thing made of these.
import { Vector3 } from "three";

import type { Physics } from "../core/types";

/** The level, as far as a falling point needs it. */
export type Terrain = Pick<Physics, "groundHeight" | "raycast">;

const STEP = 1 / 60;
/** A hitch is not simulated through: the body just falls a little late. */
const MAX_STEPS = 8;
const GRAVITY = 9.8;
const DRAG = 0.995;
const FRICTION = 0.9;
const ITERATIONS = 6;
/** A floor this far above a point is still a floor to it, not a ceiling it is under. */
const LEDGE = 0.25;
/** Slower than this, metres a step, for this many steps and it is at rest. */
const REST_MOVE = 0.0015;
const REST_STEPS = 30;
/** Nothing falls for longer than this many steps, whatever keeps twitching. */
const LONGEST = 60 * 5;

/** One point: where it is, and where it was a step ago. */
export interface Point {
  readonly at: Vector3;
  readonly was: Vector3;
  /** How far it is kept clear of the level. */
  readonly radius: number;
  /** Inverse mass: how readily it gives way to a point it is tied to. */
  readonly give: number;
  /** The lowest it may be this step. */
  floor: number;
}

interface Limit {
  a: Point;
  b: Point;
  min: number;
  max: number;
}

const delta = new Vector3();
const heading = new Vector3();

const hold = ({ a, b, min, max }: Limit): void => {
  delta.subVectors(b.at, a.at);
  const d = delta.length();
  const want = Math.min(max, Math.max(min, d));
  if (d === want || d < 1e-6) {
    return;
  }
  delta.multiplyScalar((d - want) / d / (a.give + b.give));
  a.at.addScaledVector(delta, a.give);
  b.at.addScaledVector(delta, -b.give);
};

export class Verlet {
  /** No point has moved for a while: stepping it does nothing until it is disturbed. */
  resting = false;
  private readonly points: Point[] = [];
  private readonly limits: Limit[] = [];
  private readonly terrain: Terrain;
  private owed = 0;
  private still = 0;
  private steps = 0;

  constructor(terrain: Terrain) {
    this.terrain = terrain;
  }

  /** A point at `at`, kept `radius` clear of the level. */
  add(at: Vector3, radius: number, mass = 1): Point {
    const point = { at: at.clone(), floor: -Infinity, give: 1 / mass, radius, was: at.clone() };
    this.points.push(point);
    return point;
  }

  /** Hold two points between `lo` and `hi` times as far apart as they are now. */
  rod(a: Point, b: Point, lo = 1, hi = 1): void {
    const d = a.at.distanceTo(b.at);
    this.limits.push({ a, b, max: d * hi, min: d * lo });
  }

  /** Keep two points at least `least` metres apart. */
  apart(a: Point, b: Point, least: number): void {
    this.limits.push({ a, b, max: Infinity, min: least });
  }

  /** Put a point somewhere, moving at `velocity`. */
  place(point: Point, at: Vector3, velocity: Vector3): void {
    point.at.copy(at);
    point.was.copy(at).addScaledVector(velocity, -STEP);
    this.wake();
  }

  /** Add `velocity` to a point. */
  kick(point: Point, velocity: Vector3, scale = 1): void {
    point.was.addScaledVector(velocity, -STEP * scale);
    this.wake();
  }

  /**
   * `dt` seconds on. `joints` runs with the limits each pass, for whatever a
   * distance cannot say (which way a knee folds).
   */
  advance(dt: number, joints?: () => void): void {
    this.owed = Math.min(this.owed + dt, STEP * MAX_STEPS);
    while (this.owed >= STEP && !this.resting) {
      this.owed -= STEP;
      this.step(joints);
    }
  }

  private wake(): void {
    this.resting = false;
    this.still = 0;
    this.steps = 0;
  }

  private step(joints?: () => void): void {
    const { points, terrain } = this;
    for (const p of points) {
      delta.subVectors(p.at, p.was).multiplyScalar(DRAG);
      p.was.copy(p.at);
      p.at.add(delta);
      p.at.y -= GRAVITY * STEP * STEP;
      p.floor = terrain.groundHeight(p.at.x, p.at.z, p.was.y + LEDGE) + p.radius;
    }
    for (let pass = 0; pass < ITERATIONS; pass += 1) {
      for (const limit of this.limits) {
        hold(limit);
      }
      joints?.();
      for (const p of points) {
        p.at.y = Math.max(p.at.y, p.floor);
      }
    }
    let moved = 0;
    for (const p of points) {
      this.collide(p);
      moved = Math.max(moved, p.at.distanceToSquared(p.was));
    }
    this.steps += 1;
    this.still = moved < REST_MOVE * REST_MOVE ? this.still + 1 : 0;
    this.resting = this.still >= REST_STEPS || this.steps >= LONGEST;
  }

  /** Stop a point at whatever stands between where it was and where it is; drag it where it lies. */
  private collide({ at, was, radius, floor }: Point): void {
    heading.subVectors(at, was);
    const far = heading.length();
    if (far > 1e-5) {
      heading.multiplyScalar(1 / far);
      const hit = this.terrain.raycast(was, heading, far + radius);
      if (hit) {
        at.copy(was).addScaledVector(heading, Math.max(0, hit.dist - radius));
      }
    }
    if (at.y > floor + 1e-4) {
      return;
    }
    // On the ground: no bounce, and what slides is slowed as much as its weight presses it down.
    was.y = at.y;
    const slide = Math.hypot(at.x - was.x, at.z - was.z);
    const grip = Math.min(1, (FRICTION * GRAVITY * STEP * STEP) / Math.max(slide, 1e-9));
    was.x += (at.x - was.x) * grip;
    was.z += (at.z - was.z) * grip;
  }
}
