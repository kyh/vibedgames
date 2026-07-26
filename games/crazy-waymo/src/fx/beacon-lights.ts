import * as THREE from "three";

import { radialGlowTexture } from "./lamp-glow";

// Night lights for anything that is NOT a street lamp: pier lanterns, dock
// floods, bridge deck strings, the aviation beacons on the tower tops — and,
// through the shared GlowLayer below, the headlights and tail lights of the
// traffic fleet (fx/vehicle-lights.ts).
//
// Street lamps ride `city.lampHeads`, which is packed into the baked world bin
// — so adding a field to it (colour, blink) would force a world rebake. The
// waterfront geometry is rebuilt live on every load instead, so its lights get
// this runtime-only registry: a builder calls `registerBeacons` while it builds,
// GameScene drains the registry once the world's streamed tail resolves and
// turns the whole lot into ONE additive instanced draw (plus one for the deck
// pools).
//
// Registration is keyed by source so a rebuild replaces its own entries rather
// than doubling them — the landmark/pier/bridge builders all run again on every
// load, and dev HMR runs them more than that.

export type Beacon = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Lamp colour; the halo is additive so this reads as the emitted light. */
  readonly color: number;
  /** Halo diameter in world units. */
  readonly size: number;
  /** Seconds per blink cycle. Omit for a steady lamp. */
  readonly blinkS?: number;
  /** Deck/pavement height under the lamp — adds a flat pool of light there. */
  readonly groundY?: number;
  /**
   * Pool diameter, when POOL_SCALE x `size` is the wrong shape for this lamp.
   * A pier lantern is a fat glow over a small patch of deck; a STREET
   * luminaire is the opposite — a small hot head 5 metres up over a pool wide
   * enough to cross the roadway. Tying the two together is what made the
   * first pass of mast luminaires read as floating blobs with no light under
   * them.
   */
  readonly poolSize?: number;
  /**
   * Extra HDR gain on this lamp's POOL only. The layer's house gain is tuned
   * for a lantern on a dark deck; asphalt under a street luminaire is the
   * brightest thing in a night street and has to clear the bloom cut the way
   * fx/lamp-glow.ts POOL_GAIN does.
   */
  readonly poolBoost?: number;
};

const registry = new Map<string, readonly Beacon[]>();

/**
 * Publish (or replace) one builder's night lights. Call it while the world is
 * being generated — GameScene reads the registry once, after the load tail.
 */
export function registerBeacons(source: string, beacons: readonly Beacon[]): void {
  registry.set(source, beacons);
}

/** Every registered beacon, flattened. Order follows registration order. */
export function collectBeacons(): readonly Beacon[] {
  const all: Beacon[] = [];
  for (const list of registry.values()) all.push(...list);
  return all;
}

const HALO_ALPHA = 0.62;
const POOL_ALPHA = 0.32;
const POOL_SCALE = 3.2; // pool diameter relative to the halo
const POOL_LIFT = 0.06; // clear of the deck it is drawn on
const FADE_NEAR = 420;
const FADE_FAR = 760;
// HDR gain on every beacon colour. Additive layers write colour*alpha, so an
// ordinary 0..1 colour tops out below the night bloom cut (render/post.ts) and
// a navigation light renders as a flat dot with no bleed. See fx/lamp-glow.ts,
// where the same change is spelled out at length.
const HALO_GAIN = 3.0;
const POOL_GAIN = 1.8;

/** Billboard halo at the lamp, or a flat pool of light on the ground under it. */
export type GlowKind = "halo" | "pool";

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

const HALO_VERT = /* glsl */ `
  ${COMMON_PARS}
  void main() {
    setup(aCenter);
    vec4 view = viewMatrix * vec4(aCenter, 1.0);
    view.xy += position.xy * aPulse.x;
    gl_Position = projectionMatrix * view;
  }
`;

const POOL_VERT = /* glsl */ `
  ${COMMON_PARS}
  void main() {
    setup(aCenter);
    vec3 world = aCenter + vec3(position.x * aPulse.x, 0.0, -position.y * aPulse.x);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

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

export type GlowLayerOpts = {
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
};

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
    const centerAttr = new THREE.InstancedBufferAttribute(this.centers, 3);
    const colorAttr = new THREE.InstancedBufferAttribute(this.colors, 3);
    const pulseAttr = new THREE.InstancedBufferAttribute(this.pulses, 2);
    for (const a of [centerAttr, colorAttr, pulseAttr]) a.setUsage(THREE.DynamicDrawUsage);
    this.attrs = [centerAttr, colorAttr, pulseAttr];

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute("position", quad.getAttribute("position"));
    geo.setAttribute("uv", quad.getAttribute("uv"));
    geo.setAttribute("aCenter", centerAttr);
    geo.setAttribute("aColor", colorAttr);
    geo.setAttribute("aPulse", pulseAttr);
    geo.instanceCount = 0;
    this.geo = geo;

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: radialGlowTexture() },
        uAlpha: { value: opts.alpha },
        uIntensity: opts.intensity,
        uTime: opts.time,
      },
      vertexShader: opts.kind === "halo" ? HALO_VERT : POOL_VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // Pools are flat quads drawn on decks and roads that slope under them;
      // a depth-space bias is what keeps the uphill half from being rejected
      // (fx/lamp-glow.ts POOL_LIFT carries the long version).
      polygonOffset: opts.kind === "pool",
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false; // instances move independently of the mesh
    this.mesh.renderOrder = 6; // with the other glow passes
  }

  begin(): void {
    this.cursor = 0;
  }

  /** Add one light. Silently drops anything past `capacity`. */
  push(x: number, y: number, z: number, color: THREE.Color, size: number, blinkRate = 0): void {
    const i = this.cursor;
    if (i >= this.capacity) return;
    this.cursor = i + 1;
    this.centers[i * 3] = x;
    this.centers[i * 3 + 1] = y;
    this.centers[i * 3 + 2] = z;
    this.colors[i * 3] = color.r * this.gain;
    this.colors[i * 3 + 1] = color.g * this.gain;
    this.colors[i * 3 + 2] = color.b * this.gain;
    this.pulses[i * 2] = size;
    this.pulses[i * 2 + 1] = blinkRate;
  }

  commit(): void {
    this.geo.instanceCount = this.cursor;
    for (const a of this.attrs) a.needsUpdate = true;
  }
}

/** Blink period in seconds → the shader's angular rate. 0 stays steady. */
export function blinkRate(blinkS: number | undefined): number {
  return blinkS !== undefined && blinkS > 0 ? (Math.PI * 2) / blinkS : 0;
}

export class BeaconLights {
  readonly group = new THREE.Group();
  private intensity = { value: 0 };
  private time = { value: 0 };

  constructor(beacons: readonly Beacon[]) {
    if (beacons.length === 0) return;
    const pooled = beacons.filter((b) => b.groundY !== undefined).length;
    const halo = new GlowLayer({
      capacity: beacons.length,
      kind: "halo",
      alpha: HALO_ALPHA,
      gain: HALO_GAIN,
      intensity: this.intensity,
      time: this.time,
    });
    halo.begin();
    const col = new THREE.Color();
    for (const b of beacons) {
      halo.push(b.x, b.y, b.z, col.setHex(b.color), b.size, blinkRate(b.blinkS));
    }
    halo.commit();
    this.group.add(halo.mesh);

    if (pooled > 0) {
      const pool = new GlowLayer({
        capacity: pooled,
        kind: "pool",
        alpha: POOL_ALPHA,
        gain: POOL_GAIN,
        intensity: this.intensity,
        time: this.time,
      });
      pool.begin();
      for (const b of beacons) {
        if (b.groundY === undefined) continue;
        const c = col.setHex(b.color).multiplyScalar(b.poolBoost ?? 1);
        pool.push(
          b.x,
          b.groundY + POOL_LIFT,
          b.z,
          c,
          b.poolSize ?? b.size * POOL_SCALE,
          blinkRate(b.blinkS),
        );
      }
      pool.commit();
      this.group.add(pool.mesh);
    }
    this.group.visible = false;
  }

  setIntensity(night: number): void {
    this.intensity.value = night;
    this.group.visible = night > 0.01; // no draw at all in daylight
  }

  update(dt: number): void {
    if (this.group.visible) this.time.value += dt;
  }
}
