// One pool of particles: drift sparks, tyre smoke, boost flames, paint
// droplets, shockwave rings and confetti. Each is a single round unlit splat in
// a palette tone, so an explosion is pixel art like everything else. Tones step
// down the ramp as a particle ages; nothing fades.

import { FLAG, tone } from "../splat/splat-set";
import type { SplatSet } from "../splat/splat-set";

interface Spark {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ramp: number;
  age: number;
  life: number;
  size: number;
  gravity: number;
  /** Size at the end of its life as a multiple of its size at birth. */
  grow: number;
  /** The step it is born at; it drops two steps over its life. */
  hot: number;
}

export interface SparkOptions {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size: number;
  ramp: number;
  gravity?: number;
  grow?: number;
  hot?: number;
}

const FLAGS = FLAG.unlit + FLAG.round + FLAG.noShadow;
/** The floor: a particle never sinks through the track. */
const FLOOR = 0.3;

export class Sparks {
  private readonly pool: Spark[] = [];
  private next = 0;

  constructor(max = 700) {
    for (let i = 0; i < max; i += 1) {
      this.pool.push({
        age: 1,
        gravity: 0,
        grow: 0.4,
        hot: 4,
        life: 1,
        ramp: 0,
        size: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        x: 0,
        y: 0,
        z: 0,
      });
    }
  }

  emit(options: SparkOptions): void {
    const spark = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    if (spark) {
      Object.assign(spark, options, {
        age: 0,
        gravity: options.gravity ?? 0,
        grow: options.grow ?? 0.4,
        hot: options.hot ?? 4,
      });
    }
  }

  /** A burst of `count` sparks flung outwards and up from one point. */
  burst(x: number, y: number, z: number, ramp: number, count: number, speed: number): void {
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      this.emit({
        gravity: 14,
        life: 0.35 + Math.random() * 0.45,
        ramp,
        size: 0.16 + Math.random() * 0.22,
        vx: Math.cos(a) * v,
        vy: 2 + Math.random() * speed * 0.6,
        vz: Math.sin(a) * v,
        x,
        y,
        z,
      });
    }
  }

  /** A shockwave: a ring of sparks racing outwards along the ground. */
  ring(x: number, z: number, ramp: number, speed: number, count = 28): void {
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * Math.PI * 2;
      this.emit({
        grow: 1.6,
        life: 0.42,
        ramp,
        size: 0.26,
        vx: Math.cos(a) * speed,
        vy: 0,
        vz: Math.sin(a) * speed,
        x,
        y: 0.5,
        z,
      });
    }
  }

  /** A small puff that shrinks away: tyre smoke, dust. */
  puff(x: number, y: number, z: number, ramp: number, size: number): void {
    this.emit({
      grow: 0.2,
      hot: 4,
      life: 0.22 + Math.random() * 0.12,
      ramp,
      size,
      vx: (Math.random() - 0.5) * 1.5,
      vy: 1.2 + Math.random(),
      vz: (Math.random() - 0.5) * 1.5,
      x,
      y,
      z,
    });
  }

  /** Paper in every colour given, thrown high and falling slowly. */
  confetti(x: number, y: number, z: number, ramps: readonly number[], count: number): void {
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const v = 3 + Math.random() * 9;
      this.emit({
        gravity: 7,
        grow: 1,
        hot: 3,
        life: 1.1 + Math.random() * 0.9,
        ramp: ramps[i % ramps.length] ?? 0,
        size: 0.22 + Math.random() * 0.12,
        vx: Math.cos(a) * v,
        vy: 7 + Math.random() * 8,
        vz: Math.sin(a) * v,
        x,
        y,
        z,
      });
    }
  }

  update(dt: number): void {
    for (const spark of this.pool) {
      if (spark.age < spark.life) {
        spark.age += dt;
        spark.vy -= spark.gravity * dt;
        spark.x += spark.vx * dt;
        spark.y = Math.max(FLOOR, spark.y + spark.vy * dt);
        spark.z += spark.vz * dt;
      }
    }
  }

  draw(out: SplatSet): void {
    for (const spark of this.pool) {
      if (spark.age < spark.life) {
        const k = spark.age / spark.life;
        // Stepped, not faded: hot, then the ramp's colour, then a step darker.
        const step = Math.max(0, spark.hot - Math.floor(k * 3));
        out.push(
          spark.x,
          spark.y,
          spark.z,
          0,
          1,
          0,
          spark.size * (1 + (spark.grow - 1) * k),
          tone(spark.ramp, step),
          FLAGS,
        );
      }
    }
  }
}
