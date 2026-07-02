// Instanced particle pools — replaces Fx's per-particle Meshes (up to 320 draw
// calls at fight peaks) with TWO InstancedMeshes = 2 draw calls total, always.
//  - ADD pool (512): energy — sparks/flashes/embers. Additive blending fades by
//    lerping instanceColor toward black (black is invisible under ADD, no alpha
//    needed). HDR brights pass `bright: HDR_BRIGHT` to push past bloom's 0.82.
//  - NORMAL pool (160): matter — smoke/dust/debris. Per-instance alpha via an
//    `aAlpha` InstancedBufferAttribute patched into `#include <color_fragment>`.
// Free-lists, preallocated slots, module scratch math: zero per-frame allocs in
// update(). Spawns copy their options object immediately, so callers may reuse
// a scratch options object.
import * as THREE from "three";

export type ParticleKind = "add" | "normal";

/** Standard HDR multiplier for bloom-worthy cores (bloom threshold is 0.82). */
export const HDR_BRIGHT = 2.2;

export type SpawnOptions = {
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
};

export type BurstOptions = {
  x: number;
  y: number;
  z: number;
  color: number;
  /** Base radial speed — each particle rolls 0.5–1.5×. */
  speed: number;
  /** Base life — each particle rolls 0.7–1.3×. */
  life: number;
  /** Base size — each particle rolls 0.7–1.3× (default 0.6). */
  size?: number;
  /** Vertical fraction of the rolled speed (default 0.6, matches fx.burst). */
  upBias?: number;
  gravity?: number;
  drag?: number;
  stretch?: boolean;
  bright?: number;
  alpha?: number;
};

// ── module scratch (single-threaded render path) ────────────────────────────
const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchMat = new THREE.Matrix4();
const scratchDir = new THREE.Vector3();
const scratchCol = new THREE.Color();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const ZERO_MAT = new THREE.Matrix4().makeScale(0, 0, 0);
const scratchBurst: SpawnOptions = { x: 0, y: 0, z: 0, size: 0.6, life: 0.3 };

type Slot = {
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
  r: number; // base color (bright-premultiplied)
  g: number;
  b: number;
  alpha: number; // NORMAL start alpha
};

function makeSlot(): Slot {
  return {
    px: 0,
    py: 0,
    pz: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    life: 0,
    maxLife: 1,
    s0: 1,
    gravity: 0,
    drag: 0,
    stretch: false,
    r: 1,
    g: 1,
    b: 1,
    alpha: 1,
  };
}

/** One InstancedMesh + free-list. `fadeColor` = ADD-style fade (color→black);
 *  otherwise the pool fades its `aAlpha` attribute (NORMAL-style). */
class Pool {
  readonly mesh: THREE.InstancedMesh;
  private readonly slots: Slot[] = [];
  private readonly active: number[] = []; // packed index list (swap-remove)
  private activeCount = 0;
  private readonly free: number[] = [];
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly alphaAttr: THREE.InstancedBufferAttribute | null;
  private highWater = 0;
  private dirty = false;

  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    private readonly cap: number,
    private readonly fadeColor: boolean,
    renderOrder: number,
    alphaAttr: THREE.InstancedBufferAttribute | null,
  ) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = this.colorAttr;
    this.alphaAttr = alphaAttr;
    for (let i = cap - 1; i >= 0; i--) this.free.push(i); // pop order 0,1,2… keeps count low
    for (let i = 0; i < cap; i++) {
      this.slots.push(makeSlot());
      this.active.push(0); // preallocated packed list (activeCount is the live length)
    }
  }

  spawn(o: SpawnOptions): void {
    const idx = this.free.pop();
    if (idx === undefined) return; // saturated — drop (scale-of-importance budget)
    const s = this.slots[idx];
    if (!s) return;
    s.px = o.x;
    s.py = o.y;
    s.pz = o.z;
    s.vx = o.vx ?? 0;
    s.vy = o.vy ?? 0;
    s.vz = o.vz ?? 0;
    s.life = s.maxLife = Math.max(0.016, o.life);
    s.s0 = o.size;
    s.gravity = o.gravity ?? 0;
    s.drag = o.drag ?? 0;
    s.stretch = o.stretch ?? false;
    s.alpha = o.alpha ?? 1;
    const bright = o.bright ?? 1;
    if (o.cr !== undefined || o.cg !== undefined || o.cb !== undefined)
      scratchCol.setRGB(o.cr ?? 1, o.cg ?? 1, o.cb ?? 1);
    else scratchCol.setHex(o.color ?? 0xffffff);
    s.r = scratchCol.r * bright;
    s.g = scratchCol.g * bright;
    s.b = scratchCol.b * bright;
    this.active[this.activeCount++] = idx;
    if (idx >= this.highWater) {
      this.highWater = idx + 1;
      this.mesh.count = this.highWater;
    }
    this.writeInstance(idx, s, 1); // visible from the very next render
    this.dirty = true;
  }

  update(dt: number): void {
    for (let i = this.activeCount - 1; i >= 0; i--) {
      const idx = this.active[i];
      if (idx === undefined) continue;
      const s = this.slots[idx];
      if (!s) continue;
      s.life -= dt;
      if (s.life <= 0) {
        this.mesh.setMatrixAt(idx, ZERO_MAT);
        const last = this.active[--this.activeCount];
        if (last !== undefined) this.active[i] = last;
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
      if (this.alphaAttr) this.alphaAttr.needsUpdate = true;
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
      this.colorAttr.setXYZ(idx, s.r * t, s.g * t, s.b * t); // → black = invisible (ADD)
    } else {
      this.colorAttr.setXYZ(idx, s.r, s.g, s.b);
      this.alphaAttr?.setX(idx, s.alpha * t);
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    const m = this.mesh.material;
    if (Array.isArray(m)) for (const mm of m) mm.dispose();
    else m.dispose();
    this.mesh.dispose();
  }
}

const ADD_CAP = 512;
const NORMAL_CAP = 160;

export class ParticlePools {
  private readonly add: Pool;
  private readonly normal: Pool;

  constructor(private scene: THREE.Scene) {
    // ADD pool — energy. instanceColor drives everything; fade = color→black.
    const addGeo = new THREE.SphereGeometry(0.16, 6, 5);
    const addMat = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      toneMapped: true,
    });
    this.add = new Pool(addGeo, addMat, ADD_CAP, true, 11, null);

    // NORMAL pool — matter. Per-instance alpha rides an aAlpha attribute that a
    // typed onBeforeCompile patch multiplies into diffuseColor.a.
    const normalGeo = new THREE.SphereGeometry(0.16, 6, 5);
    const alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(NORMAL_CAP), 1);
    alphaAttr.setUsage(THREE.DynamicDrawUsage);
    normalGeo.setAttribute("aAlpha", alphaAttr);
    const normalMat = new THREE.MeshBasicMaterial({
      blending: THREE.NormalBlending,
      depthWrite: false,
      transparent: true,
    });
    normalMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute float aAlpha;\nvarying float vPAlpha;",
        )
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPAlpha = aAlpha;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vPAlpha;")
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\ndiffuseColor.a *= vPAlpha;",
        );
    };
    normalMat.customProgramCacheKey = () => "fx-particles-alpha";
    this.normal = new Pool(normalGeo, normalMat, NORMAL_CAP, false, 10, alphaAttr);

    // NORMAL under ADD (bright energy composites over smoke — value contrast).
    scene.add(this.normal.mesh);
    scene.add(this.add.mesh);
  }

  /** Spawn one particle. Copies `o` immediately — callers may reuse a scratch. */
  spawn(kind: ParticleKind, o: SpawnOptions): void {
    (kind === "add" ? this.add : this.normal).spawn(o);
  }

  /** Convenience: omnidirectional burst with fx.ts-style jitter (fire/magic pops). */
  burst(kind: ParticleKind, n: number, o: BurstOptions): void {
    const upBias = o.upBias ?? 0.6;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * 0.8 + 0.2;
      const sp = o.speed * (0.5 + Math.random());
      scratchBurst.x = o.x;
      scratchBurst.y = o.y;
      scratchBurst.z = o.z;
      scratchBurst.vx = Math.cos(a) * sp;
      scratchBurst.vz = Math.sin(a) * sp;
      scratchBurst.vy = up * sp * upBias;
      scratchBurst.color = o.color;
      scratchBurst.cr = undefined;
      scratchBurst.cg = undefined;
      scratchBurst.cb = undefined;
      scratchBurst.size = (o.size ?? 0.6) * (0.7 + Math.random() * 0.6);
      scratchBurst.life = o.life * (0.7 + Math.random() * 0.6);
      scratchBurst.gravity = o.gravity ?? -10;
      scratchBurst.drag = o.drag ?? 0;
      scratchBurst.stretch = o.stretch ?? true;
      scratchBurst.bright = o.bright ?? 1;
      scratchBurst.alpha = o.alpha ?? 1;
      this.spawn(kind, scratchBurst);
    }
  }

  /** Step both pools. Zero allocations. 2 draw calls total regardless of load. */
  update(dt: number): void {
    this.add.update(dt);
    this.normal.update(dt);
  }

  dispose(): void {
    this.add.dispose(this.scene);
    this.normal.dispose(this.scene);
  }
}
