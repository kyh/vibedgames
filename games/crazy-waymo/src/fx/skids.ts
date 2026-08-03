import * as THREE from "three";

import { DRAPE_MAX_ERROR } from "../world/conform";
import { ASPHALT_LIFT } from "../world/roads";

// Tire skid marks: a single mesh holding a ring buffer of quads stamped onto
// the road. One draw call, zero allocation per stamp, per-quad age fade.
//
// The material MULTIPLIES the framebuffer (r185 requires premultipliedAlpha
// for MultiplyBlending: src DST_COLOR / dst ONE_MINUS_SRC_ALPHA, so the
// effective multiplier is mix(1, tint, a)). A mark darkens whatever it lands
// on — correct on sunlit and night asphalt alike, and it can never float like
// black paint. Output is a multiplier, not radiance: no tone map, no fog.

const MAX_QUADS = 600;
const LIFE = 10; // seconds until a mark fully fades
const HALF_W = 0.14; // 0.28u wide
const HALF_L = 0.25; // ~0.5u long
// The asphalt drape sits at terrain + ASPHALT_LIFT and its coarse
// tessellation can bow up to DRAPE_MAX_ERROR above the height field between
// verts — marks must clear the worst-case road SURFACE, not the terrain, or
// the road swallows them. Exported so trails layer above skids by contract.
export const SKID_LIFT = ASPHALT_LIFT + DRAPE_MAX_ERROR + 0.02; // 0.18

// Plain rubber: near-black, slightly cool (multiplier target at full alpha).
const RUBBER_TINT = { r: 0.17, g: 0.16, b: 0.19 } as const;

// A multiply layer cannot show an emissive tier color, so the tier hue becomes
// a tint OF the darkening: normalize the color's max channel to a fixed lift
// so every tier darkens equally and the hue lives only in the channel ratios —
// reads as burnt road (cool / warm / violet scorch), never glowing paint.
const SCORCH_LIFT = 0.34;
const SCORCH_BASE = { r: 0.07, g: 0.065, b: 0.06 } as const;

export function scorchTint(color: THREE.Color, out: THREE.Color): THREE.Color {
  const mx = Math.max(color.r, Math.max(color.g, color.b), 1e-4);
  const k = SCORCH_LIFT / mx;
  out.setRGB(SCORCH_BASE.r + color.r * k, SCORCH_BASE.g + color.g * k, SCORCH_BASE.b + color.b * k);
  return out;
}

// Age fade runs on the GPU: each vertex carries its stamp time and the shader
// compares it to a clock uniform — update() advances ONE float instead of
// rewriting the whole color buffer every frame. Fade holds, then dissolves
// over the back half of LIFE.
const SKID_VERT = /* glsl */ `
  attribute vec4 aTint;
  attribute float aBirth;
  uniform float uTime;
  varying vec4 vTint;
  varying float vFade;
  void main() {
    vTint = aTint;
    float age = (uTime - aBirth) / ${LIFE.toFixed(1)};
    vFade = 1.0 - smoothstep(0.5, 1.0, age);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKID_FRAG = /* glsl */ `
  varying vec4 vTint;
  varying float vFade;
  void main() {
    float a = vTint.a * vFade;
    gl_FragColor = vec4(vTint.rgb * a, a);
  }
`;

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private positions: Float32Array;
  private colors: Float32Array;
  private births: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private birthAttr: THREE.BufferAttribute;
  private cursor = 0;
  private time = 0;
  private timeU = { value: 0 };

  constructor(private heightAt: (x: number, z: number) => number) {
    this.positions = new Float32Array(MAX_QUADS * 4 * 3);
    this.colors = new Float32Array(MAX_QUADS * 4 * 4); // RGBA, starts all-zero
    this.births = new Float32Array(MAX_QUADS * 4);

    const index = new Uint16Array(MAX_QUADS * 6);
    for (let q = 0; q < MAX_QUADS; q++) {
      const v = q * 4;
      const t = q * 6;
      index[t] = v;
      index[t + 1] = v + 2;
      index[t + 2] = v + 1;
      index[t + 3] = v + 2;
      index[t + 4] = v + 3;
      index[t + 5] = v + 1;
    }

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4);
    this.birthAttr = new THREE.BufferAttribute(this.births, 1);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("aTint", this.colAttr);
    geo.setAttribute("aBirth", this.birthAttr);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.timeU },
      vertexShader: SKID_VERT,
      fragmentShader: SKID_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.MultiplyBlending,
      premultipliedAlpha: true,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
  }

  // Stamp one rubber quad aligned to `yaw` (forward = (sin yaw, cos yaw)) at
  // terrain height + SKID_LIFT. Ring buffer: the oldest mark is overwritten.
  stamp(x: number, z: number, yaw: number, alpha = 0.7): void {
    const fx = Math.sin(yaw) * HALF_L;
    const fz = Math.cos(yaw) * HALF_L;
    this.stampSegment(x - fx, z - fz, x + fx, z + fz, alpha);
  }

  // Stamp a quad spanning (x0,z0) → (x1,z1) — consecutive segments share
  // their endpoints, so a braking line reads continuous, never dashed.
  // `tint` is the multiplier target (default plain rubber); `halfW` widens
  // one-shot scorch stamps (promotion kisses) past the tyre width.
  stampSegment(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    alpha = 0.7,
    tint: { r: number; g: number; b: number } = RUBBER_TINT,
    halfW = HALF_W,
  ): void {
    const dx = x1 - x0;
    const dz = z1 - z0;
    if (dx * dx + dz * dz < 0.002) return;
    const yaw = Math.atan2(dx, dz);
    const q = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_QUADS;

    const rx = Math.cos(yaw) * halfW;
    const rz = -Math.sin(yaw) * halfW;

    const p = q * 4 * 3;
    // Vertex order: back-left, back-right, front-left, front-right.
    this.writeVert(p, x0 - rx, z0 - rz);
    this.writeVert(p + 3, x0 + rx, z0 + rz);
    this.writeVert(p + 6, x1 - rx, z1 - rz);
    this.writeVert(p + 9, x1 + rx, z1 + rz);
    this.posAttr.needsUpdate = true;

    const b = q * 4;
    this.births[b] = this.time;
    this.births[b + 1] = this.time;
    this.births[b + 2] = this.time;
    this.births[b + 3] = this.time;
    this.birthAttr.needsUpdate = true;

    this.writeQuadColor(q, alpha, tint);
    this.colAttr.needsUpdate = true;
  }

  update(dt: number): void {
    // The fade is computed per-fragment from (uTime - birth) — expired quads
    // clamp to alpha 0 on the GPU and just sit in the ring until overwritten.
    this.time += dt;
    this.timeU.value = this.time;
  }

  private writeVert(offset: number, x: number, z: number): void {
    this.positions[offset] = x;
    this.positions[offset + 1] = this.heightAt(x, z) + SKID_LIFT;
    this.positions[offset + 2] = z;
  }

  private writeQuadColor(
    q: number,
    alpha: number,
    tint: { r: number; g: number; b: number },
  ): void {
    const c = q * 4 * 4;
    for (let v = 0; v < 4; v++) {
      const o = c + v * 4;
      this.colors[o] = tint.r;
      this.colors[o + 1] = tint.g;
      this.colors[o + 2] = tint.b;
      this.colors[o + 3] = alpha;
    }
  }
}
