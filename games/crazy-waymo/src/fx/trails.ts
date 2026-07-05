import * as THREE from "three";

// Drift light-trails: two glowing ribbons laid onto the road behind the rear
// wheels while sliding or boosting — the arcade "light streak" that makes a
// drift read from across the screen. One mesh, one draw call, ring-buffered
// samples, additive blend so streaks pop over dark asphalt.
//
// Color is captured per sample (white slide → cyan charged → orange boost), so
// a drift that arms mid-corner leaves a visible white→cyan gradient down the
// ribbon.

const SAMPLES = 44; // per ribbon
const RIBBONS = 2;
const LIFE = 0.5; // seconds a sample stays lit
const HALF_W = 0.26;
const LIFT = 0.08; // above skid marks, below the car
const MIN_STEP = 0.45; // world units between samples

type Sample = {
  x: number;
  z: number;
  y: number;
  px: number; // perpendicular (unit) at capture time
  pz: number;
  age: number;
  r: number;
  g: number;
  b: number;
  a: number;
};

export class DriftTrails {
  readonly mesh: THREE.Mesh;
  private samples: Sample[][] = [];
  private heads: { x: number; z: number }[] = [];
  private positions: Float32Array;
  private colors: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private tmp = new THREE.Color();

  constructor(private heightAt: (x: number, z: number) => number) {
    for (let r = 0; r < RIBBONS; r++) {
      this.samples.push([]);
      this.heads.push({ x: 0, z: 0 });
    }
    const maxVerts = RIBBONS * SAMPLES * 2;
    const maxTris = RIBBONS * (SAMPLES - 1) * 2;
    this.positions = new Float32Array(maxVerts * 3);
    this.colors = new Float32Array(maxVerts * 4);
    const index = new Uint16Array(maxTris * 3);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colAttr);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.indexArray = index;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  private indexArray: Uint16Array;

  // Feed wheel positions while a trail-worthy state is active. `heading` gives
  // the ribbon's cross axis; hue: 0 = slide white, 1 = charged cyan, 2 = boost.
  emit(
    ribbon: number,
    x: number,
    z: number,
    heading: number,
    kind: 0 | 1 | 2,
    strength: number,
  ): void {
    const list = this.samples[ribbon];
    const head = this.heads[ribbon];
    if (!list || !head) return;
    const step = Math.hypot(x - head.x, z - head.z);
    if (list.length > 0 && step < MIN_STEP) return;
    // Cross axis follows the MOTION direction, not the nose: during a drift
    // (and countersteer) the two diverge, and heading-aligned quads render as
    // a jagged zigzag instead of a smooth streak.
    let px: number;
    let pz: number;
    if (list.length > 0 && step > 1e-4 && step < MIN_STEP * 8) {
      px = (z - head.z) / step;
      pz = -(x - head.x) / step;
    } else {
      px = Math.cos(heading);
      pz = -Math.sin(heading);
    }
    head.x = x;
    head.z = z;
    if (kind === 2) this.tmp.setRGB(1.0, 0.5, 0.14);
    else if (kind === 1) this.tmp.setRGB(0.25, 0.92, 1.0);
    else this.tmp.setRGB(0.8, 0.88, 1.0);
    const sample: Sample = {
      x,
      z,
      y: this.heightAt(x, z) + LIFT,
      px,
      pz,
      age: 0,
      r: this.tmp.r,
      g: this.tmp.g,
      b: this.tmp.b,
      a: (kind === 0 ? 0.45 : 0.75) * strength,
    };
    list.push(sample);
    if (list.length > SAMPLES) list.shift();
  }

  update(dt: number): void {
    let anyAlive = false;
    let vi = 0; // vertex cursor
    let ii = 0; // index cursor
    for (const list of this.samples) {
      // Age out dead samples from the tail.
      while (list.length > 0) {
        const first = list[0];
        if (first && first.age > LIFE) list.shift();
        else break;
      }
      const start = vi / 3 / 2; // first vertex PAIR index of this ribbon
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s) continue;
        s.age += dt;
        anyAlive = true;
        const fade = Math.max(0, 1 - s.age / LIFE);
        // Taper: fresh end full width, old end pinched.
        const w = HALF_W * (0.4 + 0.6 * fade);
        const vx = s.x + s.px * w;
        const vz = s.z + s.pz * w;
        const wx = s.x - s.px * w;
        const wz = s.z - s.pz * w;
        this.positions[vi] = vx;
        this.positions[vi + 1] = s.y;
        this.positions[vi + 2] = vz;
        this.positions[vi + 3] = wx;
        this.positions[vi + 4] = s.y;
        this.positions[vi + 5] = wz;
        const ci = (vi / 3) * 4;
        const a = s.a * fade * fade;
        for (const off of [0, 4]) {
          this.colors[ci + off] = s.r;
          this.colors[ci + off + 1] = s.g;
          this.colors[ci + off + 2] = s.b;
          this.colors[ci + off + 3] = a;
        }
        vi += 6;
        // Stitch to the previous pair.
        if (i > 0) {
          const p = start + (i - 1);
          const c = start + i;
          this.indexArray[ii++] = p * 2;
          this.indexArray[ii++] = c * 2;
          this.indexArray[ii++] = p * 2 + 1;
          this.indexArray[ii++] = c * 2;
          this.indexArray[ii++] = c * 2 + 1;
          this.indexArray[ii++] = p * 2 + 1;
        }
      }
    }
    const geo = this.mesh.geometry;
    geo.setDrawRange(0, ii);
    this.mesh.visible = anyAlive;
    if (anyAlive) {
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
      const idx = geo.getIndex();
      if (idx) idx.needsUpdate = true;
    }
  }
}

// Boost-ignition shockwave: a flat expanding ring at road level. Small pool;
// fire() recycles the oldest.
const RING_POOL = 4;
const RING_LIFE = 0.38;

export class Shockwaves {
  readonly group = new THREE.Group();
  private rings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number }[] = [];

  constructor() {
    const geo = new THREE.RingGeometry(0.82, 1, 40);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < RING_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.rings.push({ mesh, mat, age: RING_LIFE });
    }
  }

  fire(x: number, y: number, z: number, color: number): void {
    let oldest = this.rings[0];
    for (const r of this.rings) {
      if (oldest === undefined || r.age > oldest.age) oldest = r;
    }
    if (!oldest) return;
    oldest.age = 0;
    oldest.mesh.position.set(x, y + 0.12, z);
    oldest.mat.color.setHex(color);
    oldest.mesh.visible = true;
  }

  update(dt: number): void {
    for (const r of this.rings) {
      if (r.age >= RING_LIFE) {
        if (r.mesh.visible) r.mesh.visible = false;
        continue;
      }
      r.age += dt;
      const t = Math.min(1, r.age / RING_LIFE);
      const ease = 1 - (1 - t) * (1 - t); // fast start, soft finish
      const scale = 1.2 + ease * 8.5;
      r.mesh.scale.set(scale, 1, scale);
      r.mat.opacity = 0.85 * (1 - t);
    }
  }
}
