// Instanced particle pool: one InstancedMesh, preallocated slots, free-list +
// per-priority live buckets (swap-remove) so a saturated spawn only scans the
// lowest-ranked bucket. Module scratch math: zero per-frame allocs in update().
import * as THREE from "three";
import { uploadPrefix } from "./buffer-upload";

export type ParticlePriority = "ambient" | "impact" | "major";
const PRIORITY = { ambient: 0, impact: 1, major: 2 } satisfies Readonly<
  Record<ParticlePriority, number>
>;
const RANKED: readonly ParticlePriority[] = ["ambient", "impact", "major"];
const emptyList = (): number[] => [];

export interface SpawnOptions {
  /** Ambient leaves impact headroom; major may replace less important particles. */
  priority?: ParticlePriority;
  /** World position (y is up; sim-plane callers pass (x, height, simY)). */
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  /** Base color as hex (ignored when cr/cg/cb are given). */
  color?: number;
  /** Linear RGB 0..1 override — for callers that today use setRGB (smoke/dust). */
  cr?: number;
  cg?: number;
  cb?: number;
  /** Start scale (fx.ts `s0`). */
  size: number;
  /** Lifetime in seconds (callers bake their own jitter, as fx.ts does). */
  life: number;
  /** Vertical acceleration per second (fx.ts convention; default 0). */
  gravity?: number;
  /** Velocity decay per second (default 0). */
  drag?: number;
  /** Elongate along the velocity direction (energy/sparks). */
  stretch?: boolean;
  /** Color multiplier — pass HDR_BRIGHT (2.2) for blooming cores. Default 1. */
  bright?: number;
  /** NORMAL pool start alpha (default 1; ignored by the ADD pool). */
  alpha?: number;
}

// ── module scratch (single-threaded render path) ────────────────────────────
const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchMat = new THREE.Matrix4();
const scratchDir = new THREE.Vector3();
const scratchCol = new THREE.Color();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const ZERO_MAT = new THREE.Matrix4().makeScale(0, 0, 0);
interface Slot {
  priority: ParticlePriority;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  s0: number;
  gravity: number;
  drag: number;
  stretch: boolean;
  // base color (bright-premultiplied)
  r: number;
  g: number;
  b: number;
  // NORMAL start alpha
  alpha: number;
}

const makeSlot = (): Slot => ({
  alpha: 1,
  b: 1,
  drag: 0,
  g: 1,
  gravity: 0,
  life: 0,
  maxLife: 1,
  priority: "impact",
  px: 0,
  py: 0,
  pz: 0,
  r: 1,
  s0: 1,
  stretch: false,
  vx: 0,
  vy: 0,
  vz: 0,
});

/** One InstancedMesh + free-list. `fadeColor` = ADD-style fade (color→black);
 *  otherwise the pool fades its `aAlpha` attribute (NORMAL-style). */
/** Copy a spawn request into a slot (motion, life, premultiplied color). */
const fillSlot = (s: Slot, o: SpawnOptions): void => {
  s.px = o.x;
  s.py = o.y;
  s.pz = o.z;
  s.vx = o.vx ?? 0;
  s.vy = o.vy ?? 0;
  s.vz = o.vz ?? 0;
  s.maxLife = Math.max(0.016, o.life);
  s.life = s.maxLife;
  s.s0 = o.size;
  s.gravity = o.gravity ?? 0;
  s.drag = o.drag ?? 0;
  s.stretch = o.stretch ?? false;
  s.alpha = o.alpha ?? 1;
  const bright = o.bright ?? 1;
  if (o.cr !== undefined || o.cg !== undefined || o.cb !== undefined) {
    scratchCol.setRGB(o.cr ?? 1, o.cg ?? 1, o.cb ?? 1);
  } else {
    scratchCol.setHex(o.color ?? 0xff_ff_ff);
  }
  s.r = scratchCol.r * bright;
  s.g = scratchCol.g * bright;
  s.b = scratchCol.b * bright;
};

export class Pool {
  readonly mesh: THREE.InstancedMesh;
  private readonly slots: Slot[] = [];
  // live indices packed per priority (swap-remove), so a saturated spawn only
  // scans the lowest-ranked bucket instead of everything alive
  private readonly live = {
    ambient: emptyList(),
    impact: emptyList(),
    major: emptyList(),
  } satisfies Record<ParticlePriority, number[]>;
  // slot → index in its priority list
  private readonly livePos: number[] = [];
  private readonly free: number[] = [];
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly alphaAttr: THREE.InstancedBufferAttribute | null;
  private highWater = 0;
  private dirty = false;

  private readonly cap: number;
  private readonly reserve: number;
  private readonly fadeColor: boolean;

  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    cap: number,
    reserve: number,
    fadeColor: boolean,
    renderOrder: number,
    alphaAttr: THREE.InstancedBufferAttribute | null,
  ) {
    this.cap = cap;
    this.reserve = reserve;
    this.fadeColor = fadeColor;
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = this.colorAttr;
    this.alphaAttr = alphaAttr;
    for (let i = cap - 1; i >= 0; i -= 1) {
      this.free.push(i);
      // pop order 0,1,2… keeps count low
    }
    for (let i = 0; i < cap; i += 1) {
      this.slots.push(makeSlot());
      this.livePos.push(0);
    }
  }

  spawn(o: SpawnOptions): void {
    const priority = o.priority ?? "impact";
    if (priority === "ambient" && this.free.length <= this.reserve) {
      return;
    }
    const freeIndex = this.free.pop();
    const idx = freeIndex ?? this.replaceable(priority);
    if (idx === undefined) {
      return;
    }
    const s = this.slots[idx];
    if (!s) {
      return;
    }
    if (freeIndex === undefined) {
      this.unlink(idx, s.priority);
    }
    this.link(idx, priority);
    s.priority = priority;
    fillSlot(s, o);
    if (idx >= this.highWater) {
      this.highWater = idx + 1;
      this.mesh.count = this.highWater;
    }
    // visible from the very next render
    this.writeInstance(idx, s, 1);
    this.dirty = true;
  }

  /** Lowest-ranked live particle below `priority`, closest to expiring. */
  private replaceable(priority: ParticlePriority): number | undefined {
    for (const rank of RANKED) {
      if (PRIORITY[rank] >= PRIORITY[priority]) {
        return undefined;
      }
      let candidate: number | undefined;
      let fraction = Infinity;
      for (const idx of this.live[rank]) {
        const slot = this.slots[idx];
        if (!slot) {
          continue;
        }
        const remaining = slot.life / slot.maxLife;
        if (remaining < fraction) {
          candidate = idx;
          fraction = remaining;
        }
      }
      if (candidate !== undefined) {
        return candidate;
      }
    }
    return undefined;
  }

  private link(idx: number, priority: ParticlePriority): void {
    const list = this.live[priority];
    this.livePos[idx] = list.length;
    list.push(idx);
  }

  private unlink(idx: number, priority: ParticlePriority): void {
    const list = this.live[priority];
    const at = this.livePos[idx] ?? 0;
    const last = list.pop();
    if (last !== undefined && last !== idx) {
      list[at] = last;
      this.livePos[last] = at;
    }
  }

  private liveCount(): number {
    return this.live.ambient.length + this.live.impact.length + this.live.major.length;
  }

  counts() {
    return {
      active: this.liveCount(),
      ambient: this.live.ambient.length,
      capacity: this.cap,
      impact: this.live.impact.length,
      major: this.live.major.length,
    };
  }

  update(dt: number): void {
    for (const rank of RANKED) {
      const list = this.live[rank];
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const idx = list[i];
        const s = idx === undefined ? undefined : this.slots[idx];
        if (idx === undefined || !s) {
          continue;
        }
        s.life -= dt;
        if (s.life <= 0) {
          this.mesh.setMatrixAt(idx, ZERO_MAT);
          this.unlink(idx, rank);
          this.release(idx);
          this.dirty = true;
          continue;
        }
        s.vy += s.gravity * dt;
        if (s.drag > 0) {
          const d = Math.max(0, 1 - s.drag * dt);
          s.vx *= d;
          s.vy *= d;
          s.vz *= d;
        }
        s.px += s.vx * dt;
        s.py += s.vy * dt;
        s.pz += s.vz * dt;
        this.writeInstance(idx, s, s.life / s.maxLife);
        this.dirty = true;
      }
    }
    if (this.dirty) {
      // only the live prefix goes up and gets drawn: a pool sized for a full
      // brawl must not re-upload its whole buffer for a handful of embers
      const n = this.highWater;
      this.mesh.count = n;
      uploadPrefix(this.mesh.instanceMatrix, n * 16);
      uploadPrefix(this.colorAttr, n * 3);
      if (this.alphaAttr) {
        uploadPrefix(this.alphaAttr, n);
      }
      this.dirty = this.liveCount() > 0;
    }
  }

  /** Return a slot, keeping `free` descending so the lowest index is handed
   *  out next and the high-water mark tracks the live count rather than the
   *  highest slot ever touched. */
  private release(idx: number): void {
    const { free } = this;
    let lo = 0;
    let hi = free.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((free[mid] ?? -1) > idx) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    free.splice(lo, 0, idx);
    while (this.highWater > 0 && (this.slots[this.highWater - 1]?.life ?? 0) <= 0) {
      this.highWater -= 1;
    }
  }

  /** Compose the instance matrix + fade channel for life fraction `t` (1→0). */
  private writeInstance(idx: number, s: Slot, t: number): void {
    const sc = Math.max(0.01, s.s0 * t);
    scratchPos.set(s.px, s.py, s.pz);
    if (s.stretch) {
      const speed = Math.hypot(s.vx, s.vy, s.vz);
      if (speed > 1e-4) {
        scratchDir.set(s.vx / speed, s.vy / speed, s.vz / speed);
        scratchQuat.setFromUnitVectors(Z_AXIS, scratchDir);
      } else {
        scratchQuat.identity();
      }
      scratchScale.set(sc, sc, sc * (1 + Math.min(3, speed * 0.16)));
    } else {
      scratchQuat.identity();
      scratchScale.set(sc, sc, sc);
    }
    scratchMat.compose(scratchPos, scratchQuat, scratchScale);
    this.mesh.setMatrixAt(idx, scratchMat);
    if (this.fadeColor) {
      // → black = invisible (ADD)
      this.colorAttr.setXYZ(idx, s.r * t, s.g * t, s.b * t);
    } else {
      this.colorAttr.setXYZ(idx, s.r, s.g, s.b);
      this.alphaAttr?.setX(idx, s.alpha * t);
    }
  }

  clear(): void {
    for (const slot of this.slots) {
      slot.life = 0;
    }
    // release through the same free-list path as natural expiry
    this.update(0);
    this.mesh.count = 0;
    this.highWater = 0;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    const m = this.mesh.material;
    if (Array.isArray(m)) {
      for (const mm of m) {
        mm.dispose();
      }
    } else {
      m.dispose();
    }
    this.mesh.dispose();
  }
}
