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
import { createCrystalGeometry, createShardGeometry } from "./fx-geometry";
import { createCrystalMaterial } from "./fx-crystal";
import { fxClock } from "./fx-shaders";

const BANK_SIZE = 96;
/** h/w at or below which an eruption is rubble rather than a blade. */
const SHARD_RATIO = 1.6;

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
  bank: Bank;
  idx: number;
  x: number;
  z: number;
  gy: number; // ground height at (x,z) — spikes erupt from the plateau too
  outward: number; // placement angle; the lean is away from this
  yaw: number;
  tilt: number;
  h: number;
  wx: number;
  wz: number;
  rise: number;
  hold: number;
  exit: number;
  t: number; // elapsed ms
};

/** One InstancedMesh plus its free list. */
class Bank {
  readonly mesh: THREE.InstancedMesh;
  readonly free: number[] = [];
  readonly birth: THREE.InstancedBufferAttribute;
  live = 0;

  constructor(scene: THREE.Scene, geo: THREE.BufferGeometry, mat: THREE.Material) {
    const seeds = new Float32Array(BANK_SIZE);
    for (let i = 0; i < BANK_SIZE; i++) seeds[i] = Math.random() * 100;
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
    this.birth = new THREE.InstancedBufferAttribute(new Float32Array(BANK_SIZE), 1);
    this.birth.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aBirth", this.birth);

    this.mesh = new THREE.InstancedMesh(geo, mat, BANK_SIZE);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // No castShadow: the arena's shadow map is baked once and never re-rendered
    // (View sets shadowMap.autoUpdate = false), so a transient eruption could
    // never appear in it — flagging it only risks a depth-program compile.
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);

    const parked = new THREE.Object3D();
    parked.position.set(0, -100, 0);
    parked.scale.setScalar(0.0001);
    parked.updateMatrix();
    const white = new THREE.Color(0xffffff);
    for (let i = BANK_SIZE - 1; i >= 0; i--) {
      this.free.push(i);
      this.mesh.setMatrixAt(i, parked.matrix);
      // Allocating instanceColor NOW, not on the first spawn: setColorAt adds
      // USE_INSTANCING_COLOR to the program, and doing that lazily throws away
      // the prewarm and recompiles the shader mid-fight.
      this.mesh.setColorAt(i, white);
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
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
      createCrystalGeometry({ seed: 7, sides: 6, taper: 0.2, roughness: 0.38, bend: 0.26 }),
      this.material,
    );
    this.shards = new Bank(scene, createShardGeometry(3, 5), this.material);
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
    this.scatter(x, z, r * 1.12, Math.round(n * 1.4), color, {
      ...opts,
      h: h * 0.32,
      w: w * 1.5,
      tiltOut: 0.5,
      jitter: 0.7,
      // Rubble settles a beat after the blades and outlives them slightly, so
      // the field decays raggedly instead of all sinking on one frame.
      riseMs: (opts.riseMs ?? 130) * 1.5,
      exitMs: (opts.exitMs ?? 260) * 1.3,
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
    if (idx === undefined) return; // saturated — drop
    const j = 1 - jitter / 2 + Math.random() * jitter;
    this.active.push({
      bank,
      idx,
      x,
      z,
      gy: terrainHeight(x, z),
      outward,
      yaw: Math.random() * Math.PI * 2,
      tilt: tiltOut * (0.5 + Math.random()),
      h: h * j,
      // Independent x/z width: one crystal mesh, but every instance a different
      // cross-section, so a ring of them doesn't read as a stamped repeat.
      wx: w * (0.75 + Math.random() * 0.55),
      wz: w * (0.75 + Math.random() * 0.55),
      rise: riseMs,
      hold: holdMs,
      exit: exitMs,
      t: 0,
    });
    bank.live++;
    const v = 0.8 + Math.random() * 0.35;
    bank.mesh.setColorAt(idx, this.color.setHex(color).multiplyScalar(v));
    if (bank.mesh.instanceColor) bank.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    if (this.active.length === 0 && this.blades.mesh.count === 0 && this.shards.mesh.count === 0) {
      return;
    }
    const ms = dt * 1000;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const s = this.active[i];
      if (!s) continue;
      s.t += ms;
      const total = s.rise + s.hold + s.exit;
      if (s.t >= total) {
        s.bank.free.push(s.idx);
        s.bank.live--;
        this.dummy.position.set(0, -100, 0);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.setScalar(0.0001);
        this.dummy.updateMatrix();
        s.bank.mesh.setMatrixAt(s.idx, this.dummy.matrix);
        s.bank.birth.setX(s.idx, 0);
        const last = this.active[this.active.length - 1];
        if (last) this.active[i] = last;
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
      bank.mesh.count = bank.live > 0 ? BANK_SIZE : 0;
      bank.mesh.instanceMatrix.needsUpdate = true;
      bank.birth.needsUpdate = true;
    }
  }

  dispose(): void {
    this.blades.dispose();
    this.shards.dispose();
    this.material.dispose();
  }
}
