import * as THREE from "three";

import { WATER_Y } from "../world/watercraft";

// seconds a wake sample survives
const WAKE_LIFE = 7;
// world units between samples
const WAKE_STEP = 3;
// per vessel
const WAKE_SAMPLES = 22;
// over the ocean plane
const WAKE_LIFT = 0.06;
// how much wider the ribbon gets by end of life
const WAKE_SPREAD = 3.4;
const WAKE_ALPHA = 0.52;
// A ribbon two vertices wide is a flat-alpha polygon: over dark navy it reads
// as a white geometric wedge with a drawn edge. Four vertices per sample give
// the strip a soft shoulder — the outer pair sits at full width with alpha 0,
// the inner pair at WAKE_CORE with the sample's alpha — so the foam dissolves
// sideways into the water instead of ending on a line.
const WAKE_CORE = 0.42;
// vertices per sample
const WAKE_SIDES = 4;
// quads per segment
const WAKE_QUADS = WAKE_SIDES - 1;
// Per-sample width jitter (±): a wake whose edges are exactly parallel is the
// other half of the "geometric" read.
const WAKE_JITTER = 0.24;
// Foam is froth, not paint: a touch off pure white by day, and at night lit by
// nothing but the moon and the boat's own lamps.
const WAKE_DAY: readonly [number, number, number] = [0.95, 0.98, 1];
const WAKE_NIGHT: readonly [number, number, number] = [0.3, 0.36, 0.46];

interface WakeSample {
  x: number;
  z: number;
  /** Unit perpendicular captured at the time of the sample. */
  px: number;
  pz: number;
  half: number;
  age: number;
  /** Per-side width jitter, 1 ± WAKE_JITTER. */
  jl: number;
  jr: number;
}

/**
 * One ribbon per vessel in a single dynamic buffer: white foam that widens and
 * fades astern. Normal-blended, not additive — wake is opaque froth on the
 * water, and additive white blows out over the bright bay.
 */
export class Wakes {
  readonly mesh: THREE.Mesh;
  private readonly trails: WakeSample[][];
  private readonly heads: { x: number; z: number }[];
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly indices: Uint16Array;
  private readonly idxAttr: THREE.BufferAttribute;
  private readonly rgb: [number, number, number] = [...WAKE_DAY];

  constructor(count: number) {
    this.trails = Array.from({ length: count }, () => []);
    this.heads = Array.from({ length: count }, () => ({ x: 0, z: 0 }));
    const maxVerts = count * WAKE_SAMPLES * WAKE_SIDES;
    const maxTris = count * (WAKE_SAMPLES - 1) * WAKE_QUADS * 2;
    this.positions = new Float32Array(maxVerts * 3);
    this.colors = new Float32Array(maxVerts * 4);
    this.indices = new Uint16Array(maxTris * 3);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4);
    this.idxAttr = new THREE.BufferAttribute(this.indices, 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.idxAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colAttr);
    geo.setIndex(this.idxAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        depthWrite: false,
        side: THREE.DoubleSide,
        transparent: true,
        vertexColors: true,
      }),
    );
    // samples live in world space
    this.mesh.frustumCulled = false;
    // over the ocean, under the glow passes
    this.mesh.renderOrder = 1;
  }

  /**
   * Feed one vessel's stern position. `half` is the ribbon's width at birth;
   * `live` false lets the existing wake age out without adding to it (a vessel
   * far from the camera, or one sitting at its berth).
   */
  push(i: number, x: number, z: number, dirX: number, dirZ: number, half: number, live: boolean) {
    const trail = this.trails[i];
    const head = this.heads[i];
    if (!trail || !head) {
      return;
    }
    if (!live) {
      return;
    }
    if (trail.length > 0 && Math.hypot(x - head.x, z - head.z) < WAKE_STEP) {
      return;
    }
    head.x = x;
    head.z = z;
    const jitter = (): number => 1 + (Math.random() * 2 - 1) * WAKE_JITTER;
    trail.push({ age: 0, half, jl: jitter(), jr: jitter(), px: -dirZ, pz: dirX, x, z });
    if (trail.length > WAKE_SAMPLES) {
      trail.shift();
    }
  }

  /** Night ramp (0 day .. 1 night) — foam is only as bright as its light. */
  setNight(f: number): void {
    for (let c = 0; c < 3; c += 1) {
      const day = WAKE_DAY[c] ?? 1;
      const night = WAKE_NIGHT[c] ?? 1;
      this.rgb[c] = day + (night - day) * f;
    }
  }

  update(dt: number): void {
    let v = 0;
    let idx = 0;
    for (const trail of this.trails) {
      // Samples are oldest-first, so age rises toward index 0: one scan finds
      // the cut, and the whole expired head goes in one splice.
      let cut = 0;
      for (let i = 0; i < trail.length; i += 1) {
        const s = trail[i];
        if (!s) {
          continue;
        }
        s.age += dt;
        if (s.age > WAKE_LIFE) {
          cut = i + 1;
        }
      }
      if (cut > 0) {
        trail.splice(0, cut);
      }
      const base = v / 3;
      const [cr, cg, cb] = this.rgb;
      for (let i = 0; i < trail.length; i += 1) {
        const s = trail[i];
        if (!s) {
          continue;
        }
        const k = s.age / WAKE_LIFE;
        const w = s.half * (1 + WAKE_SPREAD * k);
        // Cubic tail so the oldest samples are gone well before they expire (a
        // linear fade still leaves a visible cut where they drop), and a
        // half-second birth ramp on the newest ones. The ribbon has to fade in
        // at BOTH ends: a sample at full alpha the instant it is pushed ends
        // the strip on a hard line across the water right behind the stern,
        // which is most of what read as "geometric". Ramping on AGE (not on the
        // sample index) keeps that head steady while samples come and go.
        const a = (1 - k) ** 3 * WAKE_ALPHA * Math.min(1, s.age / 0.5);
        // Outer pair transparent, inner pair carries the foam: the strip has a
        // gradient across its width, and the jitter keeps the two outer rails
        // from tracing a pair of straight lines.
        const offs = [-s.jl, -WAKE_CORE * s.jl, WAKE_CORE * s.jr, s.jr] as const;
        for (let e = 0; e < WAKE_SIDES; e += 1) {
          const off = (offs[e] ?? 0) * w;
          this.positions[v] = s.x + s.px * off;
          this.positions[v + 1] = WATER_Y + WAKE_LIFT;
          this.positions[v + 2] = s.z + s.pz * off;
          v += 3;
          const ci = (v / 3 - 1) * 4;
          this.colors[ci] = cr ?? 1;
          this.colors[ci + 1] = cg ?? 1;
          this.colors[ci + 2] = cb ?? 1;
          this.colors[ci + 3] = e === 0 || e === WAKE_SIDES - 1 ? 0 : a;
        }
        if (i > 0) {
          const q = base + i * WAKE_SIDES;
          for (let e = 0; e < WAKE_QUADS; e += 1) {
            const p0 = q - WAKE_SIDES + e;
            this.indices[idx] = p0;
            this.indices[idx + 1] = p0 + 1;
            this.indices[idx + 2] = q + e;
            this.indices[idx + 3] = p0 + 1;
            this.indices[idx + 4] = q + e + 1;
            this.indices[idx + 5] = q + e;
            idx += 6;
          }
        }
      }
    }
    this.mesh.geometry.setDrawRange(0, idx);
    // Only the live samples travel; an empty fleet sends nothing at all.
    this.mesh.visible = v > 0;
    if (v === 0) {
      return;
    }
    this.posAttr.clearUpdateRanges();
    this.posAttr.addUpdateRange(0, v);
    this.colAttr.clearUpdateRanges();
    this.colAttr.addUpdateRange(0, (v / 3) * 4);
    this.idxAttr.clearUpdateRanges();
    this.idxAttr.addUpdateRange(0, idx);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.idxAttr.needsUpdate = true;
  }
}
