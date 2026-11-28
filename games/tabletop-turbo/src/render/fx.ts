import type { DabSet } from "../pixel/dab-set";
import { tone } from "../pixel/palette";

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
  grow: number;
  hot: number;
  rim: boolean;
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
  /** Smoke and dust: drawn with an ink edge. */
  rim?: boolean;
}

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
        hot: 7,
        life: 1,
        ramp: 0,
        rim: false,
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

  emit(options: SparkOptions) {
    const spark = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;

    if (spark) {
      Object.assign(spark, options, {
        age: 0,
        gravity: options.gravity ?? 0,
        grow: options.grow ?? 0.4,
        hot: options.hot ?? 7,
        rim: options.rim ?? false,
      });
    }
  }

  /** A burst of `count` sparks flung outwards and up from one point. */
  burst(x: number, y: number, z: number, ramp: number, count: number, speed: number) {
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
  ring(x: number, z: number, ramp: number, speed: number, count = 28) {
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * Math.PI * 2;
      this.emit({
        grow: 1,
        life: 0.42,
        ramp,
        size: 0.2,
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
  puff(x: number, y: number, z: number, ramp: number, size: number) {
    this.emit({
      grow: 0.2,
      hot: 6,
      life: 0.22 + Math.random() * 0.12,
      ramp,
      rim: true,
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
  confetti(x: number, y: number, z: number, ramps: readonly number[], count: number) {
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const v = 3 + Math.random() * 9;
      this.emit({
        gravity: 7,
        grow: 1,
        hot: 5,
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

  update(dt: number) {
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

  draw(out: DabSet) {
    for (const spark of this.pool) {
      if (spark.age < spark.life) {
        const k = spark.age / spark.life;
        const step = Math.max(1, spark.hot - Math.floor(k * 4));
        out.push(
          spark.x,
          spark.y,
          spark.z,
          spark.size * (1 + (spark.grow - 1) * k),
          tone(spark.ramp, step),
          false,
          spark.rim,
        );
      }
    }
  }
}
