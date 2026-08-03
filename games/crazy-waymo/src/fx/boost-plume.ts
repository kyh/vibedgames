import * as THREE from "three";

import { REINHARD_CLIP, REINHARD_GLSL } from "./reinhard";

// Boost flame as a MESH, not particles: two crossed ribbons per exhaust that
// pivot about the exhaust axis in the vertex shader (billboard clouds lose the
// axis under a chase cam; a rigid oriented tongue never does). The fragment
// ramp is the kart-racer 3-stop flame: the hot end is a COLOR (#ff9d2e), white
// is confined to a blue-white root kiss on <=7.5% of the tongue. Also home to
// the shared instanced ground-ring pool (ignition stacks, drift promotion,
// tier pulse) — rings are always ground-plane, thin, fast, and inherit the
// car's velocity.

// Flame ramp (kart-racer art bible). FLAME_MID deliberately equals the tier-2
// orange so a sustained burn and the tier ladder share one orange.
export const FLAME_EMBER = "#c4331a";
export const FLAME_MID = "#ff9d2e";
export const FLAME_ROOT = "#dcefff";
export const FLAME_HOT = "#fff2d4";

// Cone clamp: the AXIS (not the length) is what keeps the flame behind the
// car — 18 degree half-angle about straight-back.
export const PLUME_CONE_COS = Math.cos((18 * Math.PI) / 180);
const PLUME_CONE_SIN = Math.sin((18 * Math.PI) / 180);

// Size / radiance knobs (hand-tune pass: all screen reads live here).
// Spine composites ~3.4 pre-shoulder at full burn — clears the ~1.6 day bloom
// gate through the 0.13 max-channel shoulder with margin.
const PLUME_LEN_BASE = 1.7;
const PLUME_LEN_BURN = 0.8;
const PLUME_RAD_BASE = 0.3;
const PLUME_RAD_BURN = 0.12;
const PLUME_INT_BASE = 2.1;
const PLUME_INT_BURN = 0.8;
const PLUME_IGNITE_LEN = 0.3;
const PLUME_IGNITE_RAD = 0.18;
const PLUME_IGNITE_INT = 0.55;
const PLUME_IGNITE_DECAY = 2.9; // 1/s — onset spike over plateau
const PLUME_ALPHA = 0.88;
// Screen-space budget as fractions of frame height, evaluated per frame in
// the VS from the true view depth — waymo's chase cam sits closer than the
// reference rig, so the clamp self-derives instead of hardcoding a distance.
const PLUME_W_BUDGET = 0.16;
const PLUME_L_BUDGET = 0.36;
// Camera-alignment response: shorten and widen as the axis turns to face the
// eye (the head-on afterburner read).
const PLUME_SHORTEN = 0.26;
const PLUME_WIDEN = 0.7;
const PLUME_SEGS = 11;
const PLUME_BURN_ATTACK = 12; // 1/s ease toward the drive target
const PLUME_BURN_RELEASE = 8;

/** Clamp unit vector (ax,ay,az) into the cone about unit (bx,by,bz). */
export function clampAxisToCone(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  out: { x: number; y: number; z: number },
): void {
  const d = ax * bx + ay * by + az * bz;
  if (d >= PLUME_CONE_COS) {
    out.x = ax;
    out.y = ay;
    out.z = az;
    return;
  }
  let px = ax - bx * d;
  let py = ay - by * d;
  let pz = az - bz * d;
  const pl = Math.hypot(px, py, pz);
  if (pl < 1e-6) {
    out.x = bx;
    out.y = by;
    out.z = bz;
    return;
  }
  px /= pl;
  py /= pl;
  pz /= pl;
  out.x = bx * PLUME_CONE_COS + px * PLUME_CONE_SIN;
  out.y = by * PLUME_CONE_COS + py * PLUME_CONE_SIN;
  out.z = bz * PLUME_CONE_COS + pz * PLUME_CONE_SIN;
}

const PLUME_VERT = /* glsl */ `
  attribute vec3 aMeta; // x: exhaust stack (0|1), y: roll (0 tongue | 1 fin), z: seed
  uniform float uTime;
  uniform vec3 uOriginL;
  uniform vec3 uOriginR;
  uniform vec3 uAxis;
  uniform float uLen;
  uniform float uRad;
  varying float vU;
  varying float vSide;
  varying float vAlign;
  varying float vFade;
  void main() {
    float u = position.x;
    float side = position.y;
    vec3 origin = mix(uOriginL, uOriginR, aMeta.x);
    vec3 toEye = cameraPosition - origin;
    float dist = max(length(toEye), 0.001);
    toEye /= dist;
    float align = abs(dot(uAxis, toEye));
    // Ribbon frame: tongue widens perpendicular to the view, the crossed fin
    // sits 90 degrees around the axis and fades in as align^2 (head-on read).
    vec3 s = cross(uAxis, toEye);
    float sl = length(s);
    vec3 fb = abs(uAxis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    s = sl > 0.001 ? s / sl : normalize(cross(uAxis, fb));
    vec3 fin = normalize(cross(uAxis, s));
    vec3 sideDir = mix(s, fin, aMeta.y);
    float L = uLen * (1.0 - ${PLUME_SHORTEN.toFixed(2)} * align);
    float W = uRad * (1.0 + ${PLUME_WIDEN.toFixed(2)} * align);
    // Screen budget: scale DOWN (never up) so the flame stays smaller than
    // its subject at any camera distance.
    float viewZ = max(-(viewMatrix * vec4(origin, 1.0)).z, 0.5);
    float pxPer = projectionMatrix[1][1] / (2.0 * viewZ); // frame-height fraction per metre
    float budget = min(
      1.0,
      min(${PLUME_W_BUDGET} / max(2.0 * W * pxPer, 0.0001),
          ${PLUME_L_BUDGET} / max(L * pxPer, 0.0001)));
    L *= budget;
    W *= budget;
    // Pinched at the mouth, widest at ~1/4, never a cone.
    float prof = pow(1.0 - u, 0.62) * (0.34 + 0.66 * smoothstep(0.0, 0.26, u));
    // Flicker + lateral lick are both * u: the root stays welded to the pipe.
    float flick = 1.0 + 0.26 * sin(u * 9.3 + uTime * (14.0 + 8.0 * aMeta.z)) * u;
    float lick = sin(uTime * (9.0 + 6.0 * aMeta.z) + u * 4.0 + aMeta.z * 17.0) * 0.16 * u;
    float w = W * prof * flick;
    vec3 wp = origin + uAxis * (u * L) + sideDir * (side * w + lick * W);
    vU = u;
    vSide = side;
    vAlign = align;
    float finFade = mix(1.0, align * align, aMeta.y);
    float distFade = clamp(1.25 - dist / 90.0, 0.15, 1.0);
    vFade = finFade * distFade;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

// Coverage-driven knee: overlapping tongues saturate toward orange instead of
// paper — the knee widens with alpha so dense coverage compresses harder.
const PLUME_FRAG = /* glsl */ `
  uniform float uIntensity;
  uniform float uGain;
  uniform vec3 uTint;
  varying float vU;
  varying float vSide;
  varying float vAlign;
  varying float vFade;
  void main() {
    float spine = exp(-vSide * vSide * 4.0);
    float body = pow(max(1.0 - abs(vSide), 0.0), 0.62);
    float axial = pow(1.0 - vU, 1.15) * smoothstep(0.0, 0.09, vU);
    vec3 ember = vec3(0.769, 0.200, 0.102); // ${FLAME_EMBER}
    vec3 mid   = vec3(1.000, 0.616, 0.180); // ${FLAME_MID}
    vec3 root  = vec3(0.863, 0.937, 1.000); // ${FLAME_ROOT}
    float temp = clamp((1.0 - vU * 1.15) * (0.28 + 0.72 * spine), 0.0, 1.0);
    vec3 rgb = mix(ember, mid, smoothstep(0.0, 0.55, temp));
    float kiss = spine * (1.0 - smoothstep(0.0, 0.075, vU)); // root kiss <= 7.5%
    rgb = mix(rgb, root, kiss * 0.55);
    // Tier owns the sheath and tail, with a floor so it reads on the spine too.
    rgb = mix(rgb, uTint, clamp(0.26 + (1.0 - spine) * 0.50 + vU * 0.36, 0.0, 0.88));
    float a = axial * (0.42 * body + 0.74 * spine) * mix(1.0, 0.80, vAlign) * vFade
      * ${PLUME_ALPHA};
    rgb *= uIntensity * uGain;
    float mx = max(rgb.r, max(rgb.g, rgb.b));
    float knee = ${REINHARD_CLIP} * (1.0 + 1.6 * a);
    rgb *= 1.0 / (1.0 + mx * knee);
    gl_FragColor = vec4(rgb, a);
  }
`;

export class BoostPlume {
  readonly mesh: THREE.Mesh;
  private uTime = { value: 0 };
  private uOriginL = { value: new THREE.Vector3() };
  private uOriginR = { value: new THREE.Vector3() };
  private uAxis = { value: new THREE.Vector3(0, 0, -1) };
  private uLen = { value: 0 };
  private uRad = { value: 0 };
  private uIntensity = { value: 0 };
  private uTint = { value: new THREE.Color(FLAME_MID) };
  private burn = 0;
  private burnTarget = 0;
  private igniteT = 0;

  constructor(gain: THREE.IUniform<number>) {
    const ribs = 4; // 2 exhaust stacks x (tongue + fin)
    const rows = PLUME_SEGS + 1;
    const verts = ribs * rows * 2;
    const pos = new Float32Array(verts * 3);
    const meta = new Float32Array(verts * 3);
    const index = new Uint16Array(ribs * PLUME_SEGS * 6);
    const seeds = [0.13, 0.61, 0.37, 0.89];
    let ii = 0;
    for (let r = 0; r < ribs; r++) {
      const stack = r >> 1;
      const roll = r & 1;
      const seed = seeds[r] ?? 0.5;
      for (let i = 0; i < rows; i++) {
        const u = i / PLUME_SEGS;
        for (let sIdx = 0; sIdx < 2; sIdx++) {
          const v = (r * rows + i) * 2 + sIdx;
          pos[v * 3] = u;
          pos[v * 3 + 1] = sIdx === 0 ? -1 : 1;
          meta[v * 3] = stack;
          meta[v * 3 + 1] = roll;
          meta[v * 3 + 2] = seed;
        }
        if (i > 0) {
          const a = (r * rows + i - 1) * 2;
          const b = (r * rows + i) * 2;
          index[ii++] = a;
          index[ii++] = b;
          index[ii++] = a + 1;
          index[ii++] = b;
          index[ii++] = b + 1;
          index[ii++] = a + 1;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aMeta", new THREE.BufferAttribute(meta, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uTime,
        uOriginL: this.uOriginL,
        uOriginR: this.uOriginR,
        uAxis: this.uAxis,
        uLen: this.uLen,
        uRad: this.uRad,
        uIntensity: this.uIntensity,
        uTint: this.uTint,
        uGain: gain,
      },
      vertexShader: PLUME_VERT,
      fragmentShader: PLUME_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
  }

  /** Per-frame pose while boosting (burnTarget 0 hides after the ease-out).
   *  The axis must already be cone-clamped (clampAxisToCone). */
  drive(
    lx: number,
    ly: number,
    lz: number,
    rx: number,
    ry: number,
    rz: number,
    ax: number,
    ay: number,
    az: number,
    burnTarget: number,
  ): void {
    this.uOriginL.value.set(lx, ly, lz);
    this.uOriginR.value.set(rx, ry, rz);
    this.uAxis.value.set(ax, ay, az);
    this.burnTarget = burnTarget;
  }

  setTint(c: THREE.Color): void {
    this.uTint.value.copy(c);
  }

  /** Ignition spike: added on top of the smoothed burn so frame 1 of a boost
   *  is visibly different from frame 20 — the eye reads onsets. */
  ignite(strength: number): void {
    this.igniteT = Math.max(this.igniteT, strength);
  }

  update(dt: number): void {
    this.uTime.value += dt;
    this.igniteT *= Math.exp(-PLUME_IGNITE_DECAY * dt);
    const rate = this.burnTarget > this.burn ? PLUME_BURN_ATTACK : PLUME_BURN_RELEASE;
    this.burn += (this.burnTarget - this.burn) * Math.min(1, dt * rate);
    const ig = this.igniteT;
    this.uLen.value = (PLUME_LEN_BASE + PLUME_LEN_BURN * this.burn) * (1 + PLUME_IGNITE_LEN * ig);
    this.uRad.value = (PLUME_RAD_BASE + PLUME_RAD_BURN * this.burn) * (1 + PLUME_IGNITE_RAD * ig);
    this.uIntensity.value =
      (PLUME_INT_BASE + PLUME_INT_BURN * this.burn) * (1 + PLUME_IGNITE_INT * ig);
    this.mesh.visible = this.burn > 0.02;
  }
}

// ---------------------------------------------------------------------------
// Instanced ground-ring pool. Grammar: ground-plane, thin (3.5-9% of radius),
// fast (0.20-0.42 s), and the centre inherits the car's velocity with drag —
// a world-pinned ring is metres adrift of the car by the time it fades.

const RING_COUNT = 16;
const RING_SEGS = 48;

const RING_VERT = /* glsl */ `
  attribute vec4 aCenter; // xyz + birth
  attribute vec4 aShape;  // r0, r1, life, thickness (fraction of radius)
  attribute vec4 aColor;  // rgb premultiplied by intensity, w = alpha
  attribute vec4 aDrift;  // vx, vz, drag
  uniform float uTime;
  varying float vR;
  varying float vA;
  varying vec3 vCol;
  void main() {
    float age = uTime - aCenter.w;
    float life = max(aShape.z, 0.001);
    float u = age / life;
    if (u < 0.0 || u > 1.0) {
      vR = 0.0; vA = 0.0; vCol = vec3(0.0);
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float e = 1.0 - pow(1.0 - u, 2.8); // fastest the instant it is born
    float r = mix(aShape.x, aShape.y, e);
    float k = max(aDrift.z, 0.001);
    float slide = (1.0 - exp(-k * age)) / k;
    vec3 c = aCenter.xyz + vec3(aDrift.x, 0.0, aDrift.y) * slide;
    float rad = r * (1.0 + (position.z * 2.0 - 1.0) * aShape.w);
    vec3 wp = c + vec3(position.x, 0.0, position.y) * rad;
    vR = position.z;
    vA = aColor.w * (1.0 - u) * (1.0 - u) * smoothstep(0.0, 0.10, u);
    vCol = aColor.rgb;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

// Radial profile reaches zero at BOTH rims — a plateau profile plus additive
// color reads as an opaque matte torus, not a wave.
const RING_FRAG = /* glsl */ `
  uniform float uGain;
  varying float vR;
  varying float vA;
  varying vec3 vCol;
  ${REINHARD_GLSL}
  void main() {
    float e = sin(vR * 3.14159265);
    float a = vA * (0.34 * pow(e, 1.7) + 0.66 * pow(e, 5.5));
    vec3 rgb = reinhardClip(vCol * uGain);
    gl_FragColor = vec4(rgb, a);
  }
`;

export class FxRings {
  readonly mesh: THREE.Mesh;
  private uTime = { value: 0 };
  private center: Float32Array;
  private shape: Float32Array;
  private color: Float32Array;
  private drift: Float32Array;
  private centerAttr: THREE.InstancedBufferAttribute;
  private shapeAttr: THREE.InstancedBufferAttribute;
  private colorAttr: THREE.InstancedBufferAttribute;
  private driftAttr: THREE.InstancedBufferAttribute;
  private cursor = 0;
  private lastDeath = 0;

  constructor(gain: THREE.IUniform<number>) {
    const rows = RING_SEGS + 1;
    const pos = new Float32Array(rows * 2 * 3);
    const index = new Uint16Array(RING_SEGS * 6);
    let ii = 0;
    for (let i = 0; i < rows; i++) {
      const ang = (i / RING_SEGS) * Math.PI * 2;
      const co = Math.cos(ang);
      const so = Math.sin(ang);
      for (let e = 0; e < 2; e++) {
        const v = i * 2 + e;
        pos[v * 3] = co;
        pos[v * 3 + 1] = so;
        pos[v * 3 + 2] = e; // 0 inner rim, 1 outer rim
      }
      if (i > 0) {
        const a = (i - 1) * 2;
        const b = i * 2;
        index[ii++] = a;
        index[ii++] = b;
        index[ii++] = a + 1;
        index[ii++] = b;
        index[ii++] = b + 1;
        index[ii++] = a + 1;
      }
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.instanceCount = RING_COUNT;
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.center = new Float32Array(RING_COUNT * 4);
    this.shape = new Float32Array(RING_COUNT * 4);
    this.color = new Float32Array(RING_COUNT * 4);
    this.drift = new Float32Array(RING_COUNT * 4);
    // Dead until spawned: birth 0 with life epsilon collapses in the VS.
    this.centerAttr = new THREE.InstancedBufferAttribute(this.center, 4);
    this.shapeAttr = new THREE.InstancedBufferAttribute(this.shape, 4);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.color, 4);
    this.driftAttr = new THREE.InstancedBufferAttribute(this.drift, 4);
    for (const a of [this.centerAttr, this.shapeAttr, this.colorAttr, this.driftAttr]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    geo.setAttribute("aCenter", this.centerAttr);
    geo.setAttribute("aShape", this.shapeAttr);
    geo.setAttribute("aColor", this.colorAttr);
    geo.setAttribute("aDrift", this.driftAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uGain: gain },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
  }

  spawn(
    x: number,
    y: number,
    z: number,
    r0: number,
    r1: number,
    life: number,
    thickness: number,
    color: THREE.Color,
    intensity: number,
    alpha: number,
    velX: number,
    velZ: number,
    drag: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % RING_COUNT;
    const b = i * 4;
    const t = this.uTime.value;
    this.center[b] = x;
    this.center[b + 1] = y;
    this.center[b + 2] = z;
    this.center[b + 3] = t;
    this.shape[b] = r0;
    this.shape[b + 1] = r1;
    this.shape[b + 2] = life;
    this.shape[b + 3] = thickness;
    this.color[b] = color.r * intensity;
    this.color[b + 1] = color.g * intensity;
    this.color[b + 2] = color.b * intensity;
    this.color[b + 3] = alpha;
    this.drift[b] = velX;
    this.drift[b + 1] = velZ;
    this.drift[b + 2] = drag;
    this.centerAttr.needsUpdate = true;
    this.shapeAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.driftAttr.needsUpdate = true;
    this.lastDeath = Math.max(this.lastDeath, t + life);
    this.mesh.visible = true;
  }

  update(dt: number): void {
    this.uTime.value += dt;
    if (this.mesh.visible && this.uTime.value > this.lastDeath) this.mesh.visible = false;
  }
}
