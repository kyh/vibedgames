import * as THREE from "three";

import { REINHARD_CLIP } from "./reinhard";

// Boost flame as a MESH, not particles: two crossed ribbons per exhaust that
// pivot about the exhaust axis in the vertex shader (billboard clouds lose the
// axis under a chase cam; a rigid oriented tongue never does). The fragment
// ramp is the kart-racer 3-stop flame: the hot end is a COLOR (#ff9d2e), white
// is confined to a blue-white root kiss on <=7.5% of the tongue.

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
// 1/s — onset spike over plateau
const PLUME_IGNITE_DECAY = 2.9;
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
// 1/s ease toward the drive target
const PLUME_BURN_ATTACK = 12;
const PLUME_BURN_RELEASE = 8;

/** Clamp unit vector (ax,ay,az) into the cone about unit (bx,by,bz). */
export const clampAxisToCone = (
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  out: { x: number; y: number; z: number },
): void => {
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
};

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
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
// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
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
    // Dead-astern the widened ribbons stack across the whole car and read as
    // a wall of fire (every rear-chase trailer camera found this) — keep the
    // 3/4 afterburner but collapse the last 20 degrees toward the axis hard.
    float headOn = 1.0 - 0.68 * smoothstep(0.75, 0.97, vAlign);
    float a = axial * (0.42 * body + 0.74 * spine) * mix(1.0, 0.80, vAlign) * headOn * vFade
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
    // 2 exhaust stacks x (tongue + fin)
    const ribs = 4;
    const rows = PLUME_SEGS + 1;
    const verts = ribs * rows * 2;
    const pos = new Float32Array(verts * 3);
    const meta = new Float32Array(verts * 3);
    const index = new Uint16Array(ribs * PLUME_SEGS * 6);
    const seeds = [0.13, 0.61, 0.37, 0.89];
    let ii = 0;
    for (let r = 0; r < ribs; r += 1) {
      const stack = Math.trunc(r / 2);
      const roll = r % 2;
      const seed = seeds[r] ?? 0.5;
      for (let i = 0; i < rows; i += 1) {
        const u = i / PLUME_SEGS;
        for (let sIdx = 0; sIdx < 2; sIdx += 1) {
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
          index[ii] = a;
          ii += 1;
          index[ii] = b;
          ii += 1;
          index[ii] = a + 1;
          ii += 1;
          index[ii] = b;
          ii += 1;
          index[ii] = b + 1;
          ii += 1;
          index[ii] = a + 1;
          ii += 1;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aMeta", new THREE.BufferAttribute(meta, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fragmentShader: PLUME_FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      uniforms: {
        uAxis: this.uAxis,
        uGain: gain,
        uIntensity: this.uIntensity,
        uLen: this.uLen,
        uOriginL: this.uOriginL,
        uOriginR: this.uOriginR,
        uRad: this.uRad,
        uTime: this.uTime,
        uTint: this.uTint,
      },
      vertexShader: PLUME_VERT,
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
      (PLUME_INT_BASE + PLUME_INT_BURN * this.burn) *
      (1 + PLUME_IGNITE_INT * ig) *
      Math.min(1, this.burn / 0.25);
    this.mesh.visible = this.burn > 0.02;
  }
}
