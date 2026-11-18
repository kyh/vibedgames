import * as THREE from "three";

import { WATER_Y } from "../world/watercraft";

const WAKE_LIFE = 7;
const WAKE_STEP = 3;
const WAKE_SAMPLES = 22;
const WAKE_LIFT = 0.06;
const WAKE_SPREAD = 3.4;
const WAKE_ALPHA = 0.52;
const WAKE_CORE = 0.42;
const WAKE_SIDES = 4;
const WAKE_QUADS = WAKE_SIDES - 1;
const WAKE_JITTER = 0.24;
const WAKE_DAY: readonly [number, number, number] = [0.95, 0.98, 1];
const WAKE_NIGHT: readonly [number, number, number] = [0.3, 0.36, 0.46];

interface WakeSample {
  x: number;
  z: number;
  px: number;
  pz: number;
  half: number;
  age: number;
  jl: number;
  jr: number;
}

const wakeJitter = () => 1 + (Math.random() * 2 - 1) * WAKE_JITTER;

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
    this.mesh.frustumCulled = false;
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
    trail.push({ age: 0, half, jl: wakeJitter(), jr: wakeJitter(), px: -dirZ, pz: dirX, x, z });

    if (trail.length > WAKE_SAMPLES) {
      trail.shift();
    }
  }

  /** Night ramp (0 day .. 1 night) — foam is only as bright as its light. */
  setNight(f: number) {
    for (let c = 0; c < 3; c += 1) {
      const day = WAKE_DAY[c] ?? 1;
      const night = WAKE_NIGHT[c] ?? 1;
      this.rgb[c] = day + (night - day) * f;
    }
  }

  update(dt: number) {
    let v = 0;
    let idx = 0;

    for (const trail of this.trails) {
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
        const a = (1 - k) ** 3 * WAKE_ALPHA * Math.min(1, s.age / 0.5);
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
