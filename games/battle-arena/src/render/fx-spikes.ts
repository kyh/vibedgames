// Ground-eruption spikes — instanced faceted crystals that RISE from the floor,
// hold, then sink back. Free-list pooled, two draw calls total.
// The ARPG "matter erupts" primitive: frost-nova ice ring, bog vines, stone
// teeth, ember spurs — same pool, different tint/shape params.
//
// Two banks, not one: a tall BLADE and a squat SHARD, picked by the caller's
// height/width ratio. One geometry stretched to cover both gives ankle-height
// rubble that reads as a miniature spike, which is what made the old field look
// stamped. Within a bank, variety is per-instance — independent x/z width, yaw,
// and `aSeed`, which re-rolls the fracture, veining and rime in the shader.
import * as THREE from "three";
import { terrainHeight } from "../data/terrain";
import { uploadPrefix } from "./buffer-upload";
import { createCrystalGeometry, createShardGeometry } from "./fx-geometry";
import { Bank } from "./fx-spike-bank";
import { createCrystalMaterial } from "./fx-crystal";
import { fxClock } from "./fx-shaders";

/** h/w at or below which an eruption is rubble rather than a blade. */
const SHARD_RATIO = 1.6;

export interface SpikeOpts {
  // full height (world units)
  h?: number;
  // base width
  w?: number;
  riseMs?: number;
  holdMs?: number;
  // sink/shrink duration
  exitMs?: number;
  // radians leaned away from ring center
  tiltOut?: number;
  // 0..1 randomness on height/placement
  jitter?: number;
}

interface Spike {
  bank: Bank;
  idx: number;
  x: number;
  z: number;
  // ground height at (x,z) — spikes erupt from the plateau too
  gy: number;
  // placement angle; the lean is away from this
  outward: number;
  yaw: number;
  tilt: number;
  h: number;
  wx: number;
  wz: number;
  rise: number;
  hold: number;
  exit: number;
  // elapsed ms
  t: number;
}

export class SpikePool {
  private blades: Bank;
  private shards: Bank;
  private material: THREE.Material;
  private active: Spike[] = [];
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(scene: THREE.Scene) {
    // Both geometries sit base-on-y=0, apex at y=1, so y-scale grows the crystal
    // out of the ground and local.y reads as "how far up am I" for the shader.
    this.material = createCrystalMaterial(fxClock);
    this.blades = new Bank(
      scene,
      createCrystalGeometry({ bend: 0.26, roughness: 0.38, seed: 7, sides: 6, taper: 0.2 }),
      this.material,
    );
    this.shards = new Bank(scene, createShardGeometry(3, 5), this.material);
  }

  /** A ring of `n` spikes at radius `r` around (x,z). */
  ring(x: number, z: number, r: number, n: number, color: number, opts: SpikeOpts = {}): void {
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.25;
      this.one(x + Math.cos(a) * r, z + Math.sin(a) * r, a, color, opts);
    }
  }

  /** Spikes scattered inside a disc (vine patches, mushroom sprouts). */
  scatter(x: number, z: number, r: number, n: number, color: number, opts: SpikeOpts = {}): void {
    for (let i = 0; i < n; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * r;
      this.one(x + Math.cos(a) * rr, z + Math.sin(a) * rr, a, color, opts);
    }
  }

  /**
   * A full eruption: a ring of blades with a skirt of rubble packed in around
   * their feet. The rubble is what makes a field read as ground being torn open
   * rather than as N props being scaled up out of it, so it is the default
   * shape for every "matter erupts" beat.
   */
  erupt(x: number, z: number, r: number, n: number, color: number, opts: SpikeOpts = {}): void {
    this.ring(x, z, r, n, color, opts);
    const h = opts.h ?? 1.2;
    const w = opts.w ?? 0.4;
    // Rubble settles a beat after the blades and outlives them slightly, so
    // the field decays raggedly instead of all sinking on one frame.
    const riseMs = (opts.riseMs ?? 130) * 1.5;
    const exitMs = (opts.exitMs ?? 260) * 1.3;
    this.scatter(x, z, r * 1.12, Math.round(n * 1.4), color, {
      ...opts,
      exitMs,
      h: h * 0.32,
      jitter: 0.7,
      riseMs,
      tiltOut: 0.5,
      w: w * 1.5,
    });
  }

  private one(x: number, z: number, outward: number, color: number, opts: SpikeOpts): void {
    const {
      h = 1.2,
      w = 0.4,
      riseMs = 130,
      holdMs = 700,
      exitMs = 260,
      tiltOut = 0.18,
      jitter = 0.35,
    } = opts;
    const bank = h / w <= SHARD_RATIO ? this.shards : this.blades;
    const idx = bank.free.pop();
    if (idx === undefined) {
      return;
      // saturated — drop
    }
    if (idx >= bank.highWater) {
      bank.highWater = idx + 1;
    }
    const j = 1 - jitter / 2 + Math.random() * jitter;
    const yaw = Math.random() * Math.PI * 2;
    const tilt = tiltOut * (0.5 + Math.random());
    // Independent x/z width: one crystal mesh, but every instance a different
    // cross-section, so a ring of them doesn't read as a stamped repeat.
    const wx = w * (0.75 + Math.random() * 0.55);
    const wz = w * (0.75 + Math.random() * 0.55);
    this.active.push({
      bank,
      exit: exitMs,
      gy: terrainHeight(x, z),
      h: h * j,
      hold: holdMs,
      idx,
      outward,
      rise: riseMs,
      t: 0,
      tilt,
      wx,
      wz,
      x,
      yaw,
      z,
    });
    bank.live += 1;
    const v = 0.8 + Math.random() * 0.35;
    bank.mesh.setColorAt(idx, this.color.setHex(color).multiplyScalar(v));
    if (bank.mesh.instanceColor) {
      uploadPrefix(bank.mesh.instanceColor, bank.highWater * 3);
    }
  }

  update(dt: number): void {
    if (this.active.length === 0 && this.blades.mesh.count === 0 && this.shards.mesh.count === 0) {
      return;
    }
    const ms = dt * 1000;
    for (let i = this.active.length - 1; i >= 0; i -= 1) {
      const s = this.active[i];
      if (!s) {
        continue;
      }
      s.t += ms;
      const total = s.rise + s.hold + s.exit;
      if (s.t >= total) {
        s.bank.free.push(s.idx);
        s.bank.live -= 1;
        this.dummy.position.set(0, -100, 0);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.setScalar(0.0001);
        this.dummy.updateMatrix();
        s.bank.mesh.setMatrixAt(s.idx, this.dummy.matrix);
        s.bank.birth.setX(s.idx, 0);
        const last = this.active.at(-1);
        if (last) {
          this.active[i] = last;
        }
        this.active.pop();
        continue;
      }
      // rise fast with a slight overshoot, hold, then sink
      let k: number;
      if (s.t < s.rise) {
        const u = s.t / s.rise;
        // cubic-out, 12% overshoot
        k = 1.12 * (1 - (1 - u) ** 3);
      } else if (s.t < s.rise + s.hold) {
        const u = (s.t - s.rise) / s.hold;
        // settle back to 1
        k = 1.12 - 0.12 * Math.min(1, u * 3);
      } else {
        const u = (s.t - s.rise - s.hold) / s.exit;
        // sink accelerating
        k = 1 - u * u;
      }
      // Lit from within for the moment it tears out of the floor — this is what
      // sells the eruption as violent rather than as a mesh being scaled up.
      s.bank.birth.setX(s.idx, Math.max(0, 1 - s.t / (s.rise * 2.2)));
      this.dummy.position.set(s.x, s.gy, s.z);
      this.dummy.rotation.set(Math.sin(s.outward) * s.tilt, s.yaw, -Math.cos(s.outward) * s.tilt);
      this.dummy.scale.set(s.wx, Math.max(0.001, s.h * k), s.wz);
      this.dummy.updateMatrix();
      s.bank.mesh.setMatrixAt(s.idx, this.dummy.matrix);
    }
    for (const bank of [this.blades, this.shards]) {
      // a bank nothing touched uploads nothing; one that just emptied uploads
      // its parked prefix once (count → 0) and then goes quiet
      if (bank.live === 0 && bank.mesh.count === 0) {
        continue;
      }
      const n = bank.highWater;
      bank.mesh.count = bank.live > 0 ? n : 0;
      uploadPrefix(bank.mesh.instanceMatrix, n * 16);
      uploadPrefix(bank.birth, n);
      if (bank.live === 0) {
        bank.highWater = 0;
      }
    }
  }

  clear(): void {
    for (const spike of this.active) {
      spike.t = spike.rise + spike.hold + spike.exit;
    }
    this.update(0);
  }

  dispose(): void {
    this.blades.dispose();
    this.shards.dispose();
    this.material.dispose();
  }
}
