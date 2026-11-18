// One pool of sparks: drift sparks, boost flames, splat bursts and rail
// scrapes. Each is a single round unlit splat in a palette tone, so an
// explosion is pixel art like everything else.

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
}

const FLAGS = FLAG.unlit + FLAG.round + FLAG.noShadow;

export class Sparks {
  private readonly pool: Spark[] = [];
  private next = 0;

  constructor(max = 420) {
    for (let i = 0; i < max; i += 1) {
      this.pool.push({
        age: 1,
        gravity: 0,
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
      Object.assign(spark, options, { age: 0, gravity: options.gravity ?? 0 });
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
        size: 0.14 + Math.random() * 0.2,
        vx: Math.cos(a) * v,
        vy: 2 + Math.random() * speed * 0.6,
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
        spark.y = Math.max(0.3, spark.y + spark.vy * dt);
        spark.z += spark.vz * dt;
      }
    }
  }

  draw(out: SplatSet): void {
    for (const spark of this.pool) {
      if (spark.age < spark.life) {
        const k = 1 - spark.age / spark.life;
        // White-hot when new, the ramp's own colour as it dies.
        const step = k > 0.6 ? 4 : 3;
        out.push(
          spark.x,
          spark.y,
          spark.z,
          0,
          1,
          0,
          spark.size * (0.6 + k),
          tone(spark.ramp, step),
          FLAGS,
        );
      }
    }
  }
}
