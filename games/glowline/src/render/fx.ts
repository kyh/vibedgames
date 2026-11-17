// One pool of additive sparks on a single InstancedMesh: drift sparks, boost
// flames, splat bursts and rail scrapes all draw from it. Created once, reused
// forever; a full pool overwrites its oldest spark.

import * as THREE from "three";

interface Spark {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  color: THREE.Color;
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
  color: THREE.Color;
  gravity?: number;
}

const MATRIX = new THREE.Matrix4();
const QUAT = new THREE.Quaternion();
const SCALE = new THREE.Vector3();
const TINT = new THREE.Color();

export class Sparks {
  private readonly mesh: THREE.InstancedMesh;
  private readonly pool: Spark[] = [];
  private next = 0;

  constructor(scene: THREE.Scene, max = 420) {
    this.mesh = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(1, 0),
      new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        transparent: true,
      }),
      max,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < max; i += 1) {
      this.pool.push({
        age: 1,
        color: new THREE.Color(),
        gravity: 0,
        life: 1,
        pos: new THREE.Vector3(),
        size: 0,
        vel: new THREE.Vector3(),
      });
      // Allocates the instanceColor buffer.
      this.mesh.setColorAt(i, TINT.setScalar(0));
    }
    scene.add(this.mesh);
  }

  emit(options: SparkOptions): void {
    const spark = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    if (!spark) {
      return;
    }
    spark.pos.set(options.x, options.y, options.z);
    spark.vel.set(options.vx, options.vy, options.vz);
    spark.color.copy(options.color);
    spark.age = 0;
    spark.life = options.life;
    spark.size = options.size;
    spark.gravity = options.gravity ?? 0;
  }

  /** A burst of `count` sparks flung outwards and up from one point. */
  burst(x: number, y: number, z: number, color: THREE.Color, count: number, speed: number): void {
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      this.emit({
        color,
        gravity: 14,
        life: 0.35 + Math.random() * 0.45,
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
    for (const [i, spark] of this.pool.entries()) {
      if (spark.age < spark.life) {
        spark.age += dt;
        spark.vel.y -= spark.gravity * dt;
        spark.pos.addScaledVector(spark.vel, dt);
        const k = Math.max(0, 1 - spark.age / spark.life);
        SCALE.setScalar(spark.size * (0.3 + 0.7 * k));
        MATRIX.compose(spark.pos, QUAT, SCALE);
        this.mesh.setColorAt(i, TINT.copy(spark.color).multiplyScalar(k * 1.8));
      } else {
        MATRIX.makeScale(0, 0, 0);
      }
      this.mesh.setMatrixAt(i, MATRIX);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }
  }
}
