// Pooled particles on a single InstancedMesh — lock dust + line-clear bursts.
// Each burst carries a colour; particles shrink to nothing and fade toward the
// background tone, so they dissolve cleanly on the dark backdrop. One pool,
// preallocated, no per-event allocation (adapted from pong's pool).

import { Color, DynamicDrawUsage, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, type Scene, SphereGeometry, Vector3 } from "three";

import { BG } from "../shared/constants";

export type BurstOptions = {
  x: number;
  y: number;
  z: number;
  color: number;
  count: number;
  speedMin: number;
  speedMax: number;
  /** Upward (world +y) pop, units/s; each particle takes a random share. */
  yKick?: number;
  gravity?: number;
  life: number;
  size: number;
};

type Particle = {
  pos: Vector3;
  vel: Vector3;
  color: Color;
  age: number;
  life: number;
  size: number;
  gravity: number;
};

const BG_COLOR = new Color(BG);
const SCRATCH_MATRIX = new Matrix4();
const SCRATCH_QUAT = new Quaternion();
const SCRATCH_SCALE = new Vector3();
const SCRATCH_COLOR = new Color();

export class ParticlePool {
  private readonly mesh: InstancedMesh;
  private readonly pool: Particle[] = [];
  private live = 0;

  constructor(scene: Scene, max = 320) {
    this.mesh = new InstancedMesh(new SphereGeometry(1, 6, 4), new MeshBasicMaterial(), max);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    for (let i = 0; i < max; i++) {
      this.pool.push({
        pos: new Vector3(),
        vel: new Vector3(),
        color: new Color(),
        age: 0,
        life: 1,
        size: 1,
        gravity: 0,
      });
      this.mesh.setColorAt(i, BG_COLOR);
    }
    scene.add(this.mesh);
  }

  burst(opts: BurstOptions): void {
    for (let i = 0; i < opts.count; i++) {
      const p = this.take();
      if (!p) return;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = opts.speedMin + Math.random() * (opts.speedMax - opts.speedMin);
      p.pos.set(opts.x, opts.y, opts.z);
      p.vel.set(
        Math.sin(phi) * Math.cos(theta) * speed,
        Math.cos(phi) * speed + (opts.yKick ?? 0) * Math.random(),
        Math.sin(phi) * Math.sin(theta) * speed,
      );
      p.color.set(opts.color);
      p.age = 0;
      p.life = opts.life * (0.7 + Math.random() * 0.6);
      p.size = opts.size * (0.6 + Math.random() * 0.8);
      p.gravity = opts.gravity ?? 0;
    }
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.live) {
      const p = this.pool[i];
      if (!p) break;
      p.age += dt;
      if (p.age >= p.life) {
        this.live -= 1;
        const last = this.pool[this.live];
        if (last) {
          this.pool[this.live] = p;
          this.pool[i] = last;
        }
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      i += 1;
    }

    for (let j = 0; j < this.live; j++) {
      const p = this.pool[j];
      if (!p) break;
      const t = p.age / p.life;
      const scale = Math.max(1e-4, p.size * (1 - t));
      SCRATCH_MATRIX.compose(p.pos, SCRATCH_QUAT, SCRATCH_SCALE.setScalar(scale));
      this.mesh.setMatrixAt(j, SCRATCH_MATRIX);
      this.mesh.setColorAt(j, SCRATCH_COLOR.copy(p.color).lerp(BG_COLOR, t * t));
    }
    this.mesh.count = this.live;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private take(): Particle | null {
    if (this.live >= this.pool.length) return null;
    const p = this.pool[this.live];
    if (!p) return null;
    this.live += 1;
    return p;
  }
}
