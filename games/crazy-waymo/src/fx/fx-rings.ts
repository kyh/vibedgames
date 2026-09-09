import * as THREE from "three";

import { REINHARD_GLSL } from "./reinhard";

// Instanced ground-ring pool. Grammar: ground-plane, thin (3.5-9% of radius),
// fast (0.20-0.42 s), and the centre inherits the car's velocity with drag —
// a world-pinned ring is metres adrift of the car by the time it fades.

const RING_COUNT = 16;
const RING_SEGS = 48;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
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
// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
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
  private profile: Float32Array;
  private color: Float32Array;
  private drift: Float32Array;
  private centerAttr: THREE.InstancedBufferAttribute;
  private profileAttr: THREE.InstancedBufferAttribute;
  private colorAttr: THREE.InstancedBufferAttribute;
  private driftAttr: THREE.InstancedBufferAttribute;
  private cursor = 0;
  private lastDeath = 0;

  constructor(gain: THREE.IUniform<number>) {
    const rows = RING_SEGS + 1;
    const pos = new Float32Array(rows * 2 * 3);
    const index = new Uint16Array(RING_SEGS * 6);
    let ii = 0;
    for (let i = 0; i < rows; i += 1) {
      const ang = (i / RING_SEGS) * Math.PI * 2;
      const co = Math.cos(ang);
      const so = Math.sin(ang);
      for (let e = 0; e < 2; e += 1) {
        const v = i * 2 + e;
        pos[v * 3] = co;
        pos[v * 3 + 1] = so;
        // 0 inner rim, 1 outer rim
        pos[v * 3 + 2] = e;
      }
      if (i > 0) {
        const a = (i - 1) * 2;
        const b = i * 2;
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
    const geo = new THREE.InstancedBufferGeometry();
    geo.instanceCount = RING_COUNT;
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.center = new Float32Array(RING_COUNT * 4);
    this.profile = new Float32Array(RING_COUNT * 4);
    this.color = new Float32Array(RING_COUNT * 4);
    this.drift = new Float32Array(RING_COUNT * 4);
    // Dead until spawned: birth 0 with life epsilon collapses in the VS.
    this.centerAttr = new THREE.InstancedBufferAttribute(this.center, 4);
    this.profileAttr = new THREE.InstancedBufferAttribute(this.profile, 4);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.color, 4);
    this.driftAttr = new THREE.InstancedBufferAttribute(this.drift, 4);
    for (const a of [this.centerAttr, this.profileAttr, this.colorAttr, this.driftAttr]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    geo.setAttribute("aCenter", this.centerAttr);
    geo.setAttribute("aShape", this.profileAttr);
    geo.setAttribute("aColor", this.colorAttr);
    geo.setAttribute("aDrift", this.driftAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fragmentShader: RING_FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      uniforms: { uGain: gain, uTime: this.uTime },
      vertexShader: RING_VERT,
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
    this.profile[b] = r0;
    this.profile[b + 1] = r1;
    this.profile[b + 2] = life;
    this.profile[b + 3] = thickness;
    this.color[b] = color.r * intensity;
    this.color[b + 1] = color.g * intensity;
    this.color[b + 2] = color.b * intensity;
    this.color[b + 3] = alpha;
    this.drift[b] = velX;
    this.drift[b + 1] = velZ;
    this.drift[b + 2] = drag;
    this.centerAttr.needsUpdate = true;
    this.profileAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.driftAttr.needsUpdate = true;
    this.lastDeath = Math.max(this.lastDeath, t + life);
    this.mesh.visible = true;
  }

  update(dt: number): void {
    this.uTime.value += dt;
    if (this.mesh.visible && this.uTime.value > this.lastDeath) {
      this.mesh.visible = false;
    }
  }
}
