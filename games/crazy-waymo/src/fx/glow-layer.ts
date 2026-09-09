import * as THREE from "three";

import { poolGlowTexture, radialGlowTexture } from "./lamp-glow";

const FADE_NEAR = 420;
const FADE_FAR = 760;
// HDR gain on every beacon colour. Additive layers write colour*alpha, so an
// ordinary 0..1 colour tops out below the night bloom cut (render/post.ts) and
// a navigation light renders as a flat dot with no bleed. See fx/lamp-glow.ts,
// where the same change is spelled out at length.
export const HALO_GAIN = 3;
export const POOL_GAIN = 1.8;

/** Billboard halo at the lamp, or a flat pool of light on the ground under it. */
export type GlowKind = "halo" | "pool";

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const COMMON_PARS = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec3 aColor;
  attribute vec2 aPulse; // size, blink rate (rad/s; 0 = steady)
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vFade;
  void setup(vec3 c) {
    vUv = uv;
    vColor = aColor;
    float d = distance(cameraPosition, c);
    // A blink is a sharp on with a soft decay, not a sine — navigation lights
    // read as pulses.
    float beat = aPulse.y > 0.0 ? pow(0.5 + 0.5 * sin(uTime * aPulse.y), 6.0) : 1.0;
    vFade = (1.0 - smoothstep(${FADE_NEAR.toFixed(1)}, ${FADE_FAR.toFixed(1)}, d))
      * mix(1.0, 0.15 + 0.85 * beat, step(0.001, aPulse.y));
  }
`;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const HALO_VERT = /* glsl */ `
  ${COMMON_PARS}
  void main() {
    setup(aCenter);
    vec4 view = viewMatrix * vec4(aCenter, 1.0);
    view.xy += position.xy * aPulse.x;
    gl_Position = projectionMatrix * view;
  }
`;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const POOL_VERT = /* glsl */ `
  ${COMMON_PARS}
  attribute vec3 aNormal;
  void main() {
    setup(aCenter);
    vec3 n = normalize(aNormal);
    vec3 right = normalize(vec3(n.y, -n.x, 0.0));
    vec3 back = cross(n, right);
    vec3 world = aCenter + (right * position.x + back * position.y) * aPulse.x;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uIntensity;
  uniform float uAlpha;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vFade;
  void main() {
    float a = texture2D(uMap, vUv).a * uAlpha * uIntensity * vFade;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

export interface GlowLayerOpts {
  readonly capacity: number;
  readonly kind: GlowKind;
  readonly alpha: number;
  /**
   * Multiplies every pushed colour into HDR so the core blooms. Omit and the
   * layer takes its kind's house gain — a point source is a point source
   * whoever is drawing it, and a caller that never thought about bloom should
   * get the same night as the rest of the city rather than a flat decal.
   */
  readonly gain?: number;
  /** Shared 0..1 night ramp; the layer never owns it. */
  readonly intensity: { value: number };
  /** Shared seconds counter, for blinking lamps. */
  readonly time: { value: number };
}

/**
 * One additive instanced draw of soft glow quads. Fill it with
 * `begin()` → `push()`… → `commit()`; a static layer does that once at build
 * time, a dynamic one (traffic) does it every frame — the arrays are sized to
 * `capacity` up front and never reallocate.
 */
export class GlowLayer {
  readonly mesh: THREE.Mesh;
  private readonly centers: Float32Array;
  private readonly colors: Float32Array;
  private readonly pulses: Float32Array;
  private readonly normals: Float32Array;
  private readonly attrs: readonly THREE.InstancedBufferAttribute[];
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly capacity: number;
  private readonly gain: number;
  private cursor = 0;

  constructor(opts: GlowLayerOpts) {
    this.capacity = opts.capacity;
    this.gain = opts.gain ?? (opts.kind === "halo" ? HALO_GAIN : POOL_GAIN);
    this.centers = new Float32Array(opts.capacity * 3);
    this.colors = new Float32Array(opts.capacity * 3);
    this.pulses = new Float32Array(opts.capacity * 2);
    this.normals = new Float32Array(opts.capacity * 3);
    const centerAttr = new THREE.InstancedBufferAttribute(this.centers, 3);
    const colorAttr = new THREE.InstancedBufferAttribute(this.colors, 3);
    const pulseAttr = new THREE.InstancedBufferAttribute(this.pulses, 2);
    const normalAttr = new THREE.InstancedBufferAttribute(this.normals, 3);
    this.attrs =
      opts.kind === "pool"
        ? [centerAttr, colorAttr, pulseAttr, normalAttr]
        : [centerAttr, colorAttr, pulseAttr];
    for (const a of this.attrs) {
      a.setUsage(THREE.DynamicDrawUsage);
    }

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute("position", quad.getAttribute("position"));
    geo.setAttribute("uv", quad.getAttribute("uv"));
    geo.setAttribute("aCenter", centerAttr);
    geo.setAttribute("aColor", colorAttr);
    geo.setAttribute("aPulse", pulseAttr);
    if (opts.kind === "pool") {
      geo.setAttribute("aNormal", normalAttr);
    }
    geo.instanceCount = 0;
    this.geo = geo;

    const mat = new THREE.ShaderMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fragmentShader: FRAG,
      // Pools are flat quads drawn on decks and roads that slope under them;
      // a depth-space bias is what keeps the uphill half from being rejected
      // (fx/lamp-glow.ts POOL_LIFT carries the long version).
      polygonOffset: opts.kind === "pool",
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      transparent: true,
      uniforms: {
        uAlpha: { value: opts.alpha },
        uIntensity: opts.intensity,
        uMap: { value: opts.kind === "pool" ? poolGlowTexture() : radialGlowTexture() },
        uTime: opts.time,
      },
      vertexShader: opts.kind === "halo" ? HALO_VERT : POOL_VERT,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    // instances move independently of the mesh
    this.mesh.frustumCulled = false;
    // with the other glow passes
    this.mesh.renderOrder = 6;
  }

  begin(): void {
    this.cursor = 0;
  }

  /** Add one light. Silently drops anything past `capacity`. */
  push(
    x: number,
    y: number,
    z: number,
    color: THREE.Color,
    size: number,
    blinkRate = 0,
    normal?: THREE.Vector3,
  ): void {
    const i = this.cursor;
    if (i >= this.capacity) {
      return;
    }
    this.cursor = i + 1;
    this.centers[i * 3] = x;
    this.centers[i * 3 + 1] = y;
    this.centers[i * 3 + 2] = z;
    this.colors[i * 3] = color.r * this.gain;
    this.colors[i * 3 + 1] = color.g * this.gain;
    this.colors[i * 3 + 2] = color.b * this.gain;
    this.pulses[i * 2] = size;
    this.pulses[i * 2 + 1] = blinkRate;
    this.normals[i * 3] = normal?.x ?? 0;
    this.normals[i * 3 + 1] = normal?.y ?? 1;
    this.normals[i * 3 + 2] = normal?.z ?? 0;
  }

  commit(): void {
    this.geo.instanceCount = this.cursor;
    for (const a of this.attrs) {
      a.needsUpdate = true;
    }
  }
}
