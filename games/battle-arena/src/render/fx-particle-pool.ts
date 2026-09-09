import * as THREE from "three";

export interface SpawnOptions {
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
export class Pool {
  readonly mesh: THREE.InstancedMesh;
  private readonly slots: Slot[] = [];
  // packed index list (swap-remove)
  private readonly active: number[] = [];
  private activeCount = 0;
  private readonly free: number[] = [];
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly alphaAttr: THREE.InstancedBufferAttribute | null;
  private highWater = 0;
  private dirty = false;

  private readonly cap: number;
  private readonly fadeColor: boolean;

  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    cap: number,
    fadeColor: boolean,
    renderOrder: number,
    alphaAttr: THREE.InstancedBufferAttribute | null,
  ) {
    this.cap = cap;
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
      // preallocated packed list (activeCount is the live length)
      this.active.push(0);
    }
  }

  spawn(o: SpawnOptions): void {
    const idx = this.free.pop();
    if (idx === undefined) {
      return;
      // saturated — drop (scale-of-importance budget)
    }
    const s = this.slots[idx];
    if (!s) {
      return;
    }
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
    this.active[this.activeCount] = idx;
    this.activeCount += 1;
    if (idx >= this.highWater) {
      this.highWater = idx + 1;
      this.mesh.count = this.highWater;
    }
    // visible from the very next render
    this.writeInstance(idx, s, 1);
    this.dirty = true;
  }

  update(dt: number): void {
    for (let i = this.activeCount - 1; i >= 0; i -= 1) {
      const idx = this.active[i];
      if (idx === undefined) {
        continue;
      }
      const s = this.slots[idx];
      if (!s) {
        continue;
      }
      s.life -= dt;
      if (s.life <= 0) {
        this.mesh.setMatrixAt(idx, ZERO_MAT);
        const last = this.active[(this.activeCount -= 1)];
        if (last !== undefined) {
          this.active[i] = last;
        }
        this.free.push(idx);
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
    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      if (this.alphaAttr) {
        this.alphaAttr.needsUpdate = true;
      }
      this.dirty = this.activeCount > 0;
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
