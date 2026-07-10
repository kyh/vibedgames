// Ground-eruption spikes — instanced cone shards that RISE from the floor,
// hold, then sink back or shatter. One InstancedMesh (one draw call), free-list
// pooled. The ARPG "matter erupts" primitive: frost-nova ice ring, bog vines,
// stone teeth, sprouting mushrooms — same pool, different tint/shape params.
import * as THREE from "three";
import { terrainHeight } from "../data/terrain";

const MAX_SPIKES = 96;

export type SpikeOpts = {
  h?: number; // full height (world units)
  w?: number; // base width
  riseMs?: number;
  holdMs?: number;
  exitMs?: number; // sink/shrink duration
  tiltOut?: number; // radians leaned away from ring center
  jitter?: number; // 0..1 randomness on height/placement
};

type Spike = {
  idx: number;
  x: number;
  z: number;
  gy: number; // ground height at (x,z) — spikes erupt from the plateau too
  yaw: number;
  tilt: number; // lean, applied about the outward axis
  h: number;
  w: number;
  rise: number;
  hold: number;
  exit: number;
  t: number; // elapsed ms
};

export class SpikePool {
  private mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private active: Spike[] = [];
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(scene: THREE.Scene) {
    // base sits at the origin so y-scaling grows the spike out of the ground
    const geo = new THREE.ConeGeometry(0.5, 1, 5);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_SPIKES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.dummy.position.set(0, -100, 0);
    this.dummy.scale.setScalar(0.0001);
    this.dummy.updateMatrix();
    for (let i = MAX_SPIKES - 1; i >= 0; i--) {
      this.free.push(i);
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
  }

  /** A ring of `n` spikes at radius `r` around (x,z). */
  ring(x: number, z: number, r: number, n: number, color: number, opts: SpikeOpts = {}): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.25;
      this.one(x + Math.cos(a) * r, z + Math.sin(a) * r, a, color, opts);
    }
  }

  /** Spikes scattered inside a disc (vine patches, mushroom sprouts). */
  scatter(x: number, z: number, r: number, n: number, color: number, opts: SpikeOpts = {}): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * r;
      this.one(x + Math.cos(a) * rr, z + Math.sin(a) * rr, a, color, opts);
    }
  }

  private one(x: number, z: number, outward: number, color: number, opts: SpikeOpts): void {
    const idx = this.free.pop();
    if (idx === undefined) return; // saturated — drop
    const { h = 1.2, w = 0.4, riseMs = 130, holdMs = 700, exitMs = 260, tiltOut = 0.18, jitter = 0.35 } = opts;
    const j = 1 - jitter / 2 + Math.random() * jitter;
    const s: Spike = {
      idx,
      x,
      z,
      gy: terrainHeight(x, z),
      yaw: Math.random() * Math.PI * 2,
      tilt: tiltOut * (0.5 + Math.random()),
      h: h * j,
      w: w * (0.8 + Math.random() * 0.4),
      rise: riseMs,
      hold: holdMs,
      exit: exitMs,
      t: 0,
    };
    // lean away from the ring center (outward = placement angle)
    this.dummy.rotation.set(Math.sin(outward) * s.tilt, s.yaw, -Math.cos(outward) * s.tilt);
    this.active.push(s);
    const v = 0.8 + Math.random() * 0.35;
    this.mesh.setColorAt(idx, this.color.setHex(color).multiplyScalar(v));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    if (this.active.length === 0 && this.mesh.count === 0) return;
    const ms = dt * 1000;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const s = this.active[i]!;
      s.t += ms;
      const total = s.rise + s.hold + s.exit;
      if (s.t >= total) {
        this.free.push(s.idx);
        this.dummy.position.set(0, -100, 0);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.setScalar(0.0001);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(s.idx, this.dummy.matrix);
        const last = this.active[this.active.length - 1]!;
        this.active[i] = last;
        this.active.pop();
        continue;
      }
      // rise fast with a slight overshoot, hold, then sink
      let k: number;
      if (s.t < s.rise) {
        const u = s.t / s.rise;
        k = 1.12 * (1 - Math.pow(1 - u, 3)); // cubic-out, 12% overshoot
      } else if (s.t < s.rise + s.hold) {
        const u = (s.t - s.rise) / s.hold;
        k = 1.12 - 0.12 * Math.min(1, u * 3); // settle back to 1
      } else {
        const u = (s.t - s.rise - s.hold) / s.exit;
        k = 1 - u * u; // sink accelerating
      }
      this.dummy.position.set(s.x, s.gy, s.z);
      this.dummy.rotation.set(Math.sin(s.yaw) * s.tilt, s.yaw, -Math.cos(s.yaw) * s.tilt);
      this.dummy.scale.set(s.w, Math.max(0.001, s.h * k), s.w);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(s.idx, this.dummy.matrix);
    }
    this.mesh.count = this.active.length > 0 ? MAX_SPIKES : 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
