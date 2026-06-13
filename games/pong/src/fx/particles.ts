// Pooled ink particles on a single InstancedMesh. Particles shrink and
// fade from ink toward the paper tone, which the dither pass renders as a
// dissolve into speckle. One pool serves contact bursts and the ball's
// trail ghosts — created once, reused forever (no per-hit allocation).

import * as THREE from "three";

import { BG, INK } from "../shared/constants";

export type BurstOptions = {
  x: number;
  y: number;
  z: number;
  count: number;
  /** Fan direction in the table plane; omit for a full-circle burst. */
  dirX?: number;
  dirY?: number;
  /** Fan width in radians around the direction (default full circle). */
  spread?: number;
  speedMin: number;
  speedMax: number;
  /** Upward pop, world units/s (each particle gets a random share). */
  zKick?: number;
  gravity?: number;
  /** Nominal lifetime in seconds (randomized ±30% per particle). */
  life: number;
  /** Nominal radius in world units (randomized per particle). */
  size: number;
};

type Particle = {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  size: number;
  gravity: number;
};

const INK_COLOR = new THREE.Color(INK);
const PAPER_COLOR = new THREE.Color(BG);

// Per-frame scratch — never escapes this module.
const SCRATCH_MATRIX = new THREE.Matrix4();
const SCRATCH_QUAT = new THREE.Quaternion();
const SCRATCH_SCALE = new THREE.Vector3();
const SCRATCH_COLOR = new THREE.Color();

export class ParticlePool {
  private readonly mesh: THREE.InstancedMesh;
  private readonly pool: Particle[] = [];
  private live = 0;

  constructor(scene: THREE.Scene, max = 256) {
    this.mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 6, 4),
      new THREE.MeshBasicMaterial(),
      max,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    for (let i = 0; i < max; i++) {
      this.pool.push({
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        age: 0,
        life: 1,
        size: 1,
        gravity: 0,
      });
      this.mesh.setColorAt(i, PAPER_COLOR); // allocates the instanceColor buffer
    }
    scene.add(this.mesh);
  }

  burst(opts: BurstOptions): void {
    const hasDir = opts.dirX !== undefined || opts.dirY !== undefined;
    const dir = Math.atan2(opts.dirY ?? 0, opts.dirX ?? 0);
    const spread = opts.spread ?? Math.PI * 2;
    for (let i = 0; i < opts.count; i++) {
      const p = this.take();
      if (!p) return;
      const angle = hasDir ? dir + (Math.random() - 0.5) * spread : Math.random() * Math.PI * 2;
      const speed = opts.speedMin + Math.random() * (opts.speedMax - opts.speedMin);
      p.pos.set(opts.x, opts.y, opts.z);
      p.vel.set(
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        (opts.zKick ?? 0) * Math.random(),
      );
      p.age = 0;
      p.life = opts.life * (0.7 + Math.random() * 0.6);
      p.size = opts.size * (0.6 + Math.random() * 0.8);
      p.gravity = opts.gravity ?? 0;
    }
  }

  /** Stationary fading ghost — spawned per frame these draw a motion trail. */
  ghost(x: number, y: number, z: number, size: number, life: number): void {
    const p = this.take();
    if (!p) return;
    p.pos.set(x, y, z);
    p.vel.set(0, 0, 0);
    p.age = 0;
    p.life = life;
    p.size = size;
    p.gravity = 0;
  }

  update(dt: number): void {
    // Integrate and retire (swap-remove keeps the live range contiguous).
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
      p.vel.z -= p.gravity * dt;
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
      // Ease-in fade: stay ink early, dissolve into paper speckle late.
      this.mesh.setColorAt(j, SCRATCH_COLOR.copy(INK_COLOR).lerp(PAPER_COLOR, t * t));
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
