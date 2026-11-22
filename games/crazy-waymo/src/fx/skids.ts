import * as THREE from "three";

import { DRAPE_MAX_ERROR } from "../world/conform";
import { ASPHALT_LIFT } from "../world/roads";

const MAX_QUADS = 600;
const LIFE = 10;
const HALF_W = 0.14;
const HALF_L = 0.25;
export const SKID_LIFT = ASPHALT_LIFT + DRAPE_MAX_ERROR + 0.02;

const RUBBER_TINT = { b: 0.19, g: 0.16, r: 0.17 } as const;

const SCORCH_LIFT = 0.34;
const SCORCH_BASE = { b: 0.06, g: 0.065, r: 0.07 } as const;

export const scorchTint = (color: THREE.Color, out: THREE.Color) => {
  const mx = Math.max(color.r, Math.max(color.g, color.b), 1e-4);
  const k = SCORCH_LIFT / mx;
  out.setRGB(SCORCH_BASE.r + color.r * k, SCORCH_BASE.g + color.g * k, SCORCH_BASE.b + color.b * k);

  return out;
};

const SKID_VERT = `
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

const SKID_FRAG = `
  varying vec4 vTint;
  varying float vFade;
  void main() {
    float a = vTint.a * vFade;
    gl_FragColor = vec4(vTint.rgb * a, a);
  }
`;

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private heightAt: (x: number, z: number) => number;
  private positions: Float32Array;
  private colors: Float32Array;
  private births: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private birthAttr: THREE.BufferAttribute;
  private cursor = 0;
  private time = 0;
  private timeU = { value: 0 };

  constructor(heightAt: (x: number, z: number) => number) {
    this.heightAt = heightAt;
    this.positions = new Float32Array(MAX_QUADS * 4 * 3);
    this.colors = new Float32Array(MAX_QUADS * 4 * 4);
    this.births = new Float32Array(MAX_QUADS * 4);

    const index = new Uint16Array(MAX_QUADS * 6);

    for (let q = 0; q < MAX_QUADS; q += 1) {
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
      blending: THREE.MultiplyBlending,
      depthWrite: false,
      fragmentShader: SKID_FRAG,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -4,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
      transparent: true,
      uniforms: { uTime: this.timeU },
      vertexShader: SKID_VERT,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
  }

  stamp(x: number, z: number, yaw: number, alpha = 0.7) {
    const fx = Math.sin(yaw) * HALF_L;
    const fz = Math.cos(yaw) * HALF_L;
    this.stampSegment(x - fx, z - fz, x + fx, z + fz, alpha);
  }

  stampSegment(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    alpha = 0.7,
    tint: { r: number; g: number; b: number } = RUBBER_TINT,
    halfW = HALF_W,
  ) {
    const dx = x1 - x0;
    const dz = z1 - z0;

    if (dx * dx + dz * dz < 0.002) {
      return;
    }

    const yaw = Math.atan2(dx, dz);
    const q = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_QUADS;

    const rx = Math.cos(yaw) * halfW;
    const rz = -Math.sin(yaw) * halfW;

    const p = q * 4 * 3;
    this.writeVert(p, x0 - rx, z0 - rz);
    this.writeVert(p + 3, x0 + rx, z0 + rz);
    this.writeVert(p + 6, x1 - rx, z1 - rz);
    this.writeVert(p + 9, x1 + rx, z1 + rz);
    this.posAttr.addUpdateRange(p, 12);
    this.posAttr.needsUpdate = true;

    const b = q * 4;
    this.births[b] = this.time;
    this.births[b + 1] = this.time;
    this.births[b + 2] = this.time;
    this.births[b + 3] = this.time;
    this.birthAttr.addUpdateRange(b, 4);
    this.birthAttr.needsUpdate = true;

    this.writeQuadColor(q, alpha, tint);
    this.colAttr.addUpdateRange(q * 16, 16);
    this.colAttr.needsUpdate = true;
  }

  update(dt: number) {
    this.time += dt;
    this.timeU.value = this.time;
  }

  private writeVert(offset: number, x: number, z: number) {
    this.positions[offset] = x;
    this.positions[offset + 1] = this.heightAt(x, z) + SKID_LIFT;
    this.positions[offset + 2] = z;
  }

  private writeQuadColor(q: number, alpha: number, tint: { r: number; g: number; b: number }) {
    const c = q * 4 * 4;

    for (let v = 0; v < 4; v += 1) {
      const o = c + v * 4;
      this.colors[o] = tint.r;
      this.colors[o + 1] = tint.g;
      this.colors[o + 2] = tint.b;
      this.colors[o + 3] = alpha;
    }
  }
}
