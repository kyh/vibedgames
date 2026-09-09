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
export type ParticlePriority = "ambient" | "impact" | "major";
const PRIORITY = { ambient: 0, impact: 1, major: 2 } satisfies Readonly<
  Record<ParticlePriority, number>
>;
const RANKED: readonly ParticlePriority[] = ["ambient", "impact", "major"];
const emptyList = (): number[] => [];

/** Standard HDR multiplier for bloom-worthy cores (bloom threshold is 0.82). */
export const HDR_BRIGHT = 2.2;

export type SpawnOptions = {
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
};

export type BurstOptions = {
  priority?: ParticlePriority;
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
  r: number; // base color (bright-premultiplied)
  g: number;
  b: number;
  alpha: number; // NORMAL start alpha
};

function makeSlot(): Slot {
  return {
    priority: "impact",
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
  // live indices packed per priority (swap-remove), so a saturated spawn only
  // scans the lowest-ranked bucket instead of everything alive
  private readonly live = {
    ambient: emptyList(),
    impact: emptyList(),
    major: emptyList(),
  } satisfies Record<ParticlePriority, number[]>;
  private readonly livePos: number[] = []; // slot → index in its priority list
  private readonly free: number[] = [];
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly alphaAttr: THREE.InstancedBufferAttribute | null;
  private highWater = 0;
  private dirty = false;

  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    private readonly cap: number,
    private readonly reserve: number,
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
      this.livePos.push(0);
    }
  }

  spawn(o: SpawnOptions): void {
    const priority = o.priority ?? "impact";
    if (priority === "ambient" && this.free.length <= this.reserve) return;
    const freeIndex = this.free.pop();
    const idx = freeIndex ?? this.replaceable(priority);
    if (idx === undefined) return;
    const s = this.slots[idx];
    if (!s) return;
    if (freeIndex === undefined) this.unlink(idx, s.priority);
    this.link(idx, priority);
    s.priority = priority;
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
    if (idx >= this.highWater) {
      this.highWater = idx + 1;
      this.mesh.count = this.highWater;
    }
    this.writeInstance(idx, s, 1); // visible from the very next render
    this.dirty = true;
  }

  /** Lowest-ranked live particle below `priority`, closest to expiring. */
  private replaceable(priority: ParticlePriority): number | undefined {
    for (const rank of RANKED) {
      if (PRIORITY[rank] >= PRIORITY[priority]) return undefined;
      let candidate: number | undefined;
      let fraction = Infinity;
      for (const idx of this.live[rank]) {
        const slot = this.slots[idx];
        if (!slot) continue;
        const remaining = slot.life / slot.maxLife;
        if (remaining < fraction) {
          candidate = idx;
          fraction = remaining;
        }
      }
      if (candidate !== undefined) return candidate;
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
      capacity: this.cap,
      ambient: this.live.ambient.length,
      impact: this.live.impact.length,
      major: this.live.major.length,
    };
  }

  update(dt: number): void {
    for (const rank of RANKED) {
      const list = this.live[rank];
      for (let i = list.length - 1; i >= 0; i--) {
        const idx = list[i];
        const s = idx === undefined ? undefined : this.slots[idx];
        if (idx === undefined || !s) continue;
        s.life -= dt;
        if (s.life <= 0) {
          this.mesh.setMatrixAt(idx, ZERO_MAT);
          this.unlink(idx, rank);
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
    }
    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      if (this.alphaAttr) this.alphaAttr.needsUpdate = true;
      this.dirty = this.liveCount() > 0;
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

  clear(): void {
    for (const slot of this.slots) slot.life = 0;
    this.update(0); // release through the same free-list path as natural expiry
    this.mesh.count = 0;
    this.highWater = 0;
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
  private readonly addMat: THREE.MeshBasicMaterial;

  constructor(private scene: THREE.Scene) {
    // ADD pool — energy. instanceColor drives everything; fade = color→black.
    const addGeo = new THREE.SphereGeometry(0.16, 6, 5);
    const addMat = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      toneMapped: true,
    });
    this.addMat = addMat;
    this.add = new Pool(addGeo, addMat, ADD_CAP, 96, true, 11, null);

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
    this.normal = new Pool(normalGeo, normalMat, NORMAL_CAP, 32, false, 10, alphaAttr);

    // NORMAL under ADD (bright energy composites over smoke — value contrast).
    scene.add(this.normal.mesh);
    scene.add(this.add.mesh);
  }

  /**
   * Scale every ADD particle at once (1 = untouched). The ADD material's own
   * color is a constant white that instanceColor multiplies, so it is the one
   * place a gain can ride without being clobbered by the next spawn — and under
   * additive blending a color scale IS an energy scale.
   *
   * Written only by Fx.setFlashGain (trailer-only); see the note there.
   */
  setAddGain(gain: number): void {
    this.addMat.color.setScalar(gain);
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
      scratchBurst.priority = o.priority ?? "impact";
      this.spawn(kind, scratchBurst);
    }
  }

  /** Step both pools. Zero allocations. 2 draw calls total regardless of load. */
  update(dt: number): void {
    this.add.update(dt);
    this.normal.update(dt);
  }

  /** On-demand primitive telemetry; never scans pools during the render loop. */
  counts() {
    return { add: this.add.counts(), normal: this.normal.counts() };
  }

  clear(): void {
    this.add.clear();
    this.normal.clear();
  }

  dispose(): void {
    this.add.dispose(this.scene);
    this.normal.dispose(this.scene);
  }
}
