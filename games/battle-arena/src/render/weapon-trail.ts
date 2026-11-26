import * as THREE from "three";
import { uploadPrefix } from "./buffer-upload";
import { fxTex } from "./fx-textures";

const MAX_SEG = 28;
const SUBDIV = 4;
const MAX_ROWS = (MAX_SEG - 1) * SUBDIV + 1;
const FADE_MS = 260;
const TIP_EXT = 1.1;
const BASE_FRAC = 0.34;

/** Per-weapon override for blades whose bbox longest-axis heuristic degenerates
 *  (2H/hammer heads are wider than the shaft). `axis` = the swing axis of the
 *  blade in the weapon's local space; `base` = fraction of the weapon's length
 *  where the ribbon starts (0 = grip butt — keep it past the handle); `tip` =
 *  extension past the tip (× half-length); optional `opacity` bumps peak alpha. */
export interface TrailOverride {
  axis: "x" | "y" | "z";
  base: number;
  tip: number;
  opacity?: number;
}

const VERT = `
attribute float aAge;    // 0 fresh → 1 expired
attribute float aAcross; // 0 base edge → 1 blade tip edge
varying float vAge;
varying float vAcross;
varying float vAlong;    // arc-length coordinate for the panning noise
attribute float aAlong;
void main() {
  vAge = aAge;
  vAcross = aAcross;
  vAlong = aAlong;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const COVERAGE_GLSL = `
uniform sampler2D uNoise;
float coverage(float age, float across, float along) {
  // CRESCENT taper: near-LINEAR narrowing from the blade to the tail — the
  // arc is full-width at the blade line and ends in a long sharp point.
  float cut = 1.05 * pow(age, 0.85);
  float body = smoothstep(cut, cut + 0.34, across);
  float n = texture2D(uNoise, vec2(along * 0.18, across * 0.8)).r;
  // tail roughing (authored noise) — the fade-out edge stays organic
  float tail = 1.0 - smoothstep(0.74, 1.0, age + (n - 0.5) * 0.14);
  // erosion dissolve past mid-age: threshold climbs, streaks tear open
  float er = smoothstep(0.0, 0.35, n + 0.85 - age * 1.35);
  return body * tail * er * (1.0 - 0.4 * age);
}`;

const FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAge;
varying float vAcross;
varying float vAlong;
${""}
COVERAGE
void main() {
  // NORMAL blending keeps the champ color TRUE (additive summed toward white
  // over the bright floor); the blade line alone runs HDR so bloom catches it
  float edge = smoothstep(0.8, 0.98, vAcross);
  vec3 c = mix(uColor, vec3(1.0), edge * 0.4) * (0.9 + 0.8 * edge * (1.0 - vAge));
  float a = coverage(vAge, vAcross, vAlong) * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(c, a);
}`.replace("COVERAGE", COVERAGE_GLSL);

const FRAG_DEPTH = `
uniform float uOpacity;
varying float vAge;
varying float vAcross;
varying float vAlong;
${""}
COVERAGE
void main() {
  float a = coverage(vAge, vAcross, vAlong) * uOpacity;
  if (a < 0.05) discard; // near-invisible texels must not claim depth
  gl_FragColor = vec4(0.0);
}`.replace("COVERAGE", COVERAGE_GLSL);

const crCentripetal = (
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
  k0: number,
  k1: number,
  k2: number,
) => {
  const t1 = k0;
  const t2 = k0 + k1;
  const t3 = k0 + k1 + k2;
  const tt = t1 + t * k1;
  const a1 = p0 + ((p1 - p0) * (tt - 0)) / t1;
  const a2 = p1 + ((p2 - p1) * (tt - t1)) / k1;
  const a3 = p2 + ((p3 - p2) * (tt - t2)) / k2;
  const b1 = a1 + ((a2 - a1) * (tt - 0)) / t2;
  const b2 = a2 + ((a3 - a2) * (tt - t1)) / (t3 - t1);

  return b1 + ((b2 - b1) * (tt - t1)) / k1;
};

export class WeaponTrail {
  /** Add/remove THIS from the scene — holds the depth prepass + color pass. */
  readonly mesh: THREE.Group;
  private readonly matPre: THREE.ShaderMaterial;
  private readonly matColor: THREE.ShaderMaterial;
  private readonly geom: THREE.BufferGeometry;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly ageAttr: THREE.BufferAttribute;
  private readonly acrossAttr: THREE.BufferAttribute;
  private readonly alongAttr: THREE.BufferAttribute;
  private readonly posArr = new Float32Array(MAX_ROWS * 2 * 3);
  private readonly ageArr = new Float32Array(MAX_ROWS * 2);
  private readonly acrossArr = new Float32Array(MAX_ROWS * 2);
  private readonly alongArr = new Float32Array(MAX_ROWS * 2);
  private readonly segs: {
    bx: number;
    by: number;
    bz: number;
    tx: number;
    ty: number;
    tz: number;
    t: number;
    s: number;
  }[] = [];
  private arc = 0;
  private activeUntil = 0;
  private clock = 0;
  private readonly baseLocal: THREE.Vector3;
  private readonly tipLocal: THREE.Vector3;
  private readonly v = new THREE.Vector3();

  constructor(weapon: THREE.Object3D, color: number, override?: TrailOverride) {
    const box = new THREE.Box3().setFromObject(weapon);
    const size = new THREE.Vector3();
    box.getSize(size);
    const ctr = new THREE.Vector3();
    box.getCenter(ctr);

    const longestAxis: () => "x" | "y" | "z" = () => {
      if (size.x >= size.y && size.x >= size.z) {
        return "x";
      }

      return size.y >= size.z ? "y" : "z";
    };

    const axis = override?.axis ?? longestAxis();
    const baseFrac = override ? override.base : BASE_FRAC;
    const tipExt = override ? override.tip : TIP_EXT;
    this.baseLocal = ctr.clone();
    this.tipLocal = ctr.clone();
    const half = (box.max[axis] - box.min[axis]) / 2;
    this.baseLocal[axis] = box.min[axis] + half * 2 * baseFrac;
    this.tipLocal[axis] = ctr[axis] + half * (1 + tipExt);

    this.geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.posArr, 3).setUsage(THREE.DynamicDrawUsage);
    this.ageAttr = new THREE.BufferAttribute(this.ageArr, 1).setUsage(THREE.DynamicDrawUsage);

    for (let r = 0; r < MAX_ROWS; r += 1) {
      this.acrossArr[r * 2 + 1] = 1;
    }

    this.acrossAttr = new THREE.BufferAttribute(this.acrossArr, 1);
    this.alongAttr = new THREE.BufferAttribute(this.alongArr, 1).setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute("position", this.posAttr);
    this.geom.setAttribute("aAge", this.ageAttr);
    this.geom.setAttribute("aAcross", this.acrossAttr);
    this.geom.setAttribute("aAlong", this.alongAttr);
    const idx: number[] = [];

    for (let i = 0; i < MAX_ROWS - 1; i += 1) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (i + 1) * 2;
      const d = (i + 1) * 2 + 1;
      idx.push(a, b, c, b, d, c);
    }

    this.geom.setIndex(idx);
    this.geom.setDrawRange(0, 0);

    const uniforms = {
      uColor: { value: new THREE.Color(color) },
      uNoise: { value: fxTex("noise-streak", { wrap: true }) },
      uOpacity: { value: override?.opacity ?? 0.5 },
    };

    this.matPre = new THREE.ShaderMaterial({
      colorWrite: false,
      depthWrite: true,
      fragmentShader: FRAG_DEPTH,
      side: THREE.DoubleSide,
      transparent: true,
      uniforms,
      vertexShader: VERT,
    });
    this.matColor = new THREE.ShaderMaterial({
      blending: THREE.NormalBlending,
      depthWrite: false,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      uniforms,
      vertexShader: VERT,
    });
    const pre = new THREE.Mesh(this.geom, this.matPre);
    pre.renderOrder = 1;
    pre.frustumCulled = false;
    const color3 = new THREE.Mesh(this.geom, this.matColor);
    color3.renderOrder = 2;
    color3.frustumCulled = false;
    this.mesh = new THREE.Group();
    this.mesh.add(pre, color3);
    this.weapon = weapon;
  }

  private readonly weapon: THREE.Object3D;

  /** Begin trailing for the next `durMs` of animation. */
  emit(durMs: number) {
    this.activeUntil = this.clock + durMs;
  }

  /** Sample the blade (while active) and rebuild the ribbon. `dt` is the
   *  hit-stop-scaled render delta — the trail freezes with the rest of the fx. */
  update(dt: number) {
    this.clock += dt * 1000;
    const now = this.clock;

    if (now < this.activeUntil) {
      this.weapon.updateWorldMatrix(true, false);
      const m = this.weapon.matrixWorld;
      this.v.copy(this.baseLocal).applyMatrix4(m);
      const bx = this.v.x;
      const by = this.v.y;
      const bz = this.v.z;
      this.v.copy(this.tipLocal).applyMatrix4(m);
      const tx = this.v.x;
      const ty = this.v.y;
      const tz = this.v.z;
      const prev = this.segs.at(-1);

      if (prev) {
        this.arc += Math.hypot(tx - prev.tx, ty - prev.ty, tz - prev.tz) * 0.22;
      }

      this.segs.push({ bx, by, bz, s: this.arc, t: now, tx, ty, tz });

      if (this.segs.length > MAX_SEG) {
        this.segs.shift();
      }
    }

    while (this.segs.length > 0) {
      const [head] = this.segs;

      if (!head || now - head.t <= FADE_MS) {
        break;
      }

      this.segs.shift();
    }

    const n = this.segs.length;
    const [oldest] = this.segs;

    if (n < 2 || !oldest) {
      this.geom.setDrawRange(0, 0);

      return;
    }

    const pos = this.posArr;
    const age = this.ageArr;
    const along = this.alongArr;
    let row = 0;
    const { segs } = this;

    const putRow = (
      bx: number,
      by: number,
      bz: number,
      tx: number,
      ty: number,
      tz: number,
      a: number,
      s: number,
    ) => {
      const o = row * 6;
      pos[o] = bx;
      pos[o + 1] = by;
      pos[o + 2] = bz;
      pos[o + 3] = tx;
      pos[o + 4] = ty;
      pos[o + 5] = tz;
      const o2 = row * 2;
      age[o2] = a;
      age[o2 + 1] = a;
      along[o2] = s;
      along[o2 + 1] = s;
      row += 1;
    };

    const cr = crCentripetal;
    const aOldest = Math.max(0.25, Math.min(1, (now - oldest.t) / FADE_MS));

    const sm = (i: number) => {
      const p = segs[Math.max(0, i - 1)] ?? oldest;
      const c = segs[Math.min(n - 1, Math.max(0, i))] ?? oldest;
      const q = segs[Math.min(n - 1, i + 1)] ?? oldest;

      return {
        bx: (p.bx + 2 * c.bx + q.bx) / 4,
        by: (p.by + 2 * c.by + q.by) / 4,
        bz: (p.bz + 2 * c.bz + q.bz) / 4,
        s: c.s,
        t: c.t,
        tx: (p.tx + 2 * c.tx + q.tx) / 4,
        ty: (p.ty + 2 * c.ty + q.ty) / 4,
        tz: (p.tz + 2 * c.tz + q.tz) / 4,
      };
    };

    for (let i = 0; i < n - 1; i += 1) {
      const s0 = sm(i - 1);
      const s1 = sm(i);
      const s2 = sm(i + 1);
      const s3 = sm(i + 2);
      const a1 = Math.min(1, (now - s1.t) / FADE_MS) / aOldest;
      const a2 = Math.min(1, (now - s2.t) / FADE_MS) / aOldest;
      const k0 = Math.max(0.02, Math.sqrt(Math.hypot(s1.tx - s0.tx, s1.ty - s0.ty, s1.tz - s0.tz)));
      const k1 = Math.max(0.02, Math.sqrt(Math.hypot(s2.tx - s1.tx, s2.ty - s1.ty, s2.tz - s1.tz)));
      const k2 = Math.max(0.02, Math.sqrt(Math.hypot(s3.tx - s2.tx, s3.ty - s2.ty, s3.tz - s2.tz)));
      const steps = i === n - 2 ? SUBDIV + 1 : SUBDIV;

      for (let k = 0; k < steps; k += 1) {
        const t = k / SUBDIV;
        putRow(
          cr(s0.bx, s1.bx, s2.bx, s3.bx, t, k0, k1, k2),
          cr(s0.by, s1.by, s2.by, s3.by, t, k0, k1, k2),
          cr(s0.bz, s1.bz, s2.bz, s3.bz, t, k0, k1, k2),
          cr(s0.tx, s1.tx, s2.tx, s3.tx, t, k0, k1, k2),
          cr(s0.ty, s1.ty, s2.ty, s3.ty, t, k0, k1, k2),
          cr(s0.tz, s1.tz, s2.tz, s3.tz, t, k0, k1, k2),
          Math.min(1, Math.max(0, a1 + (a2 - a1) * t)),
          s1.s + (s2.s - s1.s) * t,
        );
      }
    }

    const verts = row * 2;
    uploadPrefix(this.posAttr, verts * 3);
    uploadPrefix(this.ageAttr, verts);
    uploadPrefix(this.alongAttr, verts);
    this.geom.setDrawRange(0, (row - 1) * 6);
  }

  dispose() {
    this.geom.dispose();
    this.matPre.dispose();
    this.matColor.dispose();
  }
}
