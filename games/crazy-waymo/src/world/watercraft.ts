import * as THREE from "three";

import { Rng } from "../shared/rng";
import { SF_DOCKS } from "./sf-piers";

/** The ocean plane's height (scenes/game-scene.ts builds it at this y). */
export const WATER_Y = -0.5;

/**
 * One material for the entire port. Flat shading keeps the stylised facet
 * language of the city kit; vertex colours are what make one draw call enough.
 */
export const PORT_MATERIAL = new THREE.MeshStandardMaterial({
  flatShading: true,
  roughness: 0.85,
  vertexColors: true,
});

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const PITCH = new THREE.Matrix4();
const SCRATCH = new THREE.Vector3();
const UNIT_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
const UNIT_CONE = new THREE.ConeGeometry(0.5, 1, 8);

/**
 * Accumulates transformed, coloured triangles into one buffer.
 *
 * It expands indexed sources instead of merging BufferGeometries so that a
 * couple of thousand parts cost a couple of thousand array pushes rather than
 * a couple of thousand throwaway geometries.
 */
export class PortBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly mat = new THREE.Matrix4();
  private readonly nmat = new THREE.Matrix3();
  private readonly v = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  private readonly rgb = new THREE.Color();

  /** Triangles pushed so far — the budget line every caller is spending on. */
  get triCount() {
    return this.pos.length / 9;
  }

  /** Transformed copy of `src` in one flat colour. */
  addGeometry(src: THREE.BufferGeometry, color: number, m: THREE.Matrix4) {
    const position = src.getAttribute("position");
    const normal = src.getAttribute("normal");
    const index = src.getIndex();
    const count = index ? index.count : position.count;
    this.nmat.getNormalMatrix(m);
    this.rgb.setHex(color);
    const { r, g, b } = this.rgb;

    for (let i = 0; i < count; i += 1) {
      const vi = index ? index.getX(i) : i;
      this.v.fromBufferAttribute(position, vi).applyMatrix4(m);
      this.pos.push(this.v.x, this.v.y, this.v.z);

      if (normal) {
        this.n.fromBufferAttribute(normal, vi).applyMatrix3(this.nmat).normalize();
        this.nor.push(this.n.x, this.n.y, this.n.z);
      } else {
        this.nor.push(0, 1, 0);
      }

      this.col.push(r, g, b);
    }
  }

  /** Transformed copy of `src` KEEPING its own vertex colours (a whole boat). */
  addColored(src: THREE.BufferGeometry, m: THREE.Matrix4) {
    const position = src.getAttribute("position");
    const normal = src.getAttribute("normal");
    const color = src.getAttribute("color");
    const index = src.getIndex();
    const count = index ? index.count : position.count;
    this.nmat.getNormalMatrix(m);

    for (let i = 0; i < count; i += 1) {
      const vi = index ? index.getX(i) : i;
      this.v.fromBufferAttribute(position, vi).applyMatrix4(m);
      this.pos.push(this.v.x, this.v.y, this.v.z);
      this.n.fromBufferAttribute(normal, vi).applyMatrix3(this.nmat).normalize();
      this.nor.push(this.n.x, this.n.y, this.n.z);
      this.col.push(color.getX(vi), color.getY(vi), color.getZ(vi));
    }
  }

  /** Axis-aligned box (optionally yawed), sized and centred in world space. */
  box(color: number, sx: number, sy: number, sz: number, x: number, y: number, z: number, ry = 0) {
    this.mat
      .makeRotationY(ry)
      .scale(SCRATCH.set(sx, sy, sz))
      .setPosition(x, y, z);
    this.addGeometry(UNIT_BOX, color, this.mat);
  }

  /** Box yawed about Y and then pitched about its own long axis — roof slabs. */
  pitchedBox(
    color: number,
    sx: number,
    sy: number,
    sz: number,
    x: number,
    y: number,
    z: number,
    ry: number,
    rx: number,
  ) {
    this.mat
      .makeRotationY(ry)
      .multiply(PITCH.makeRotationX(rx))
      .scale(SCRATCH.set(sx, sy, sz))
      .setPosition(x, y, z);
    this.addGeometry(UNIT_BOX, color, this.mat);
  }

  /** Upright cylinder — pilings, bollards, masts, funnels. */
  cylinder(color: number, r: number, h: number, x: number, y: number, z: number) {
    this.mat.makeScale(r * 2, h, r * 2).setPosition(x, y + h / 2, z);
    this.addGeometry(UNIT_CYL, color, this.mat);
  }

  /** Upright cone — buoy tops, crane finials, the odd conical roof. */
  cone(color: number, r: number, h: number, x: number, y: number, z: number) {
    this.mat.makeScale(r * 2, h, r * 2).setPosition(x, y + h / 2, z);
    this.addGeometry(UNIT_CONE, color, this.mat);
  }

  /** Box from (x0,z0) to (x1,z1) — braces, wales, gangways, crane booms. */
  beam(
    color: number,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    thick: number,
  ) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);

    if (len < 1e-4) {
      return;
    }

    this.mat
      .makeRotationY(Math.atan2(dx, dz))
      .multiply(PITCH.makeRotationX(-Math.asin(dy / len)))
      .scale(SCRATCH.set(thick, thick, len))
      .setPosition((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.addGeometry(UNIT_BOX, color, this.mat);
  }

  /** One triangle, wound so (b-a)×(c-a) faces the viewer. */
  tri(
    color: number,
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
  ) {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);

    if (len < 1e-9) {
      return;
    }

    nx /= len;
    ny /= len;
    nz /= len;
    this.rgb.setHex(color);

    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(this.rgb.r, this.rgb.g, this.rgb.b);
    }
  }

  /** Planar quad a→b→c→d, same winding rule as `tri`. */
  quad(
    color: number,
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
  ) {
    this.tri(color, a, b, c);
    this.tri(color, a, c, d);
  }

  /** Everything pushed so far, or null when nothing was. */
  geometry() {
    if (this.pos.length === 0) {
      return null;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.col), 3));
    geo.computeBoundingSphere();

    return geo;
  }
}

interface HullSpec {
  readonly len: number;
  readonly beam: number;
  readonly freeboard: number;
  readonly draft: number;
  readonly topside: number;
  readonly boot: number;
  readonly deck: number;
  readonly transom: number;
  readonly sheer: number;
}

const STATIONS: readonly number[] = [0, 0.12, 0.3, 0.52, 0.72, 0.87, 0.96, 1];

const hull = (b: PortBuilder, s: HullSpec) => {
  const deckY = (t: number) => s.freeboard + s.sheer * Math.max(0, (t - 0.45) / 0.55) ** 2;

  const halfBeam = (t: number) => {
    const aft = t < 0.45 ? s.transom + (1 - s.transom) * (t / 0.45) ** 0.7 : 1;
    const fwd = t > 0.55 ? 1 - ((t - 0.55) / 0.45) ** 1.9 : 1;

    return Math.max(0.02, (s.beam / 2) * aft * fwd);
  };

  const keelY = (t: number) => -s.draft * (0.4 + 0.6 * Math.sin(Math.PI * t) ** 0.5);
  const zAt = (t: number) => (t - 0.5) * s.len;

  for (let i = 0; i + 1 < STATIONS.length; i += 1) {
    const t0 = STATIONS[i] ?? 0;
    const t1 = STATIONS[i + 1] ?? 1;
    const z0 = zAt(t0);
    const z1 = zAt(t1);
    const w0 = halfBeam(t0);
    const w1 = halfBeam(t1);
    const d0 = deckY(t0);
    const d1 = deckY(t1);
    const k0 = keelY(t0);
    const k1 = keelY(t1);
    const kw0 = w0 * 0.34;
    const kw1 = w1 * 0.34;

    for (const side of [1, -1] as const) {
      const [a0, a1] = side > 0 ? [0, 1] : [1, 0];
      const zz = [z0, z1];
      const ww = [w0, w1];
      const dd = [d0, d1];
      const kk = [k0, k1];
      const kws = [kw0, kw1];
      const za = zz[a0] ?? 0;
      const zb = zz[a1] ?? 0;
      const wa = (ww[a0] ?? 0) * side;
      const wb = (ww[a1] ?? 0) * side;
      const da = dd[a0] ?? 0;
      const db = dd[a1] ?? 0;
      const ka = kk[a0] ?? 0;
      const kb = kk[a1] ?? 0;
      const kwa = (kws[a0] ?? 0) * side;
      const kwb = (kws[a1] ?? 0) * side;
      b.quad(s.topside, [wa, da, za], [wb, db, zb], [wb * 0.97, 0, zb], [wa * 0.97, 0, za]);
      b.quad(s.boot, [wa * 0.97, 0, za], [wb * 0.97, 0, zb], [kwb, kb, zb], [kwa, ka, za]);
    }

    b.quad(s.deck, [-w0, d0, z0], [w0, d0, z0], [w1, d1, z1], [-w1, d1, z1]);
    b.quad(s.boot, [kw0, k0, z0], [-kw0, k0, z0], [-kw1, k1, z1], [kw1, k1, z1]);
  }

  const w = halfBeam(0);
  const kw = w * 0.34;
  const z = zAt(0);
  b.quad(s.topside, [-w, deckY(0), z], [w, deckY(0), z], [w * 0.97, 0, z], [-w * 0.97, 0, z]);
  b.quad(s.boot, [-w * 0.97, 0, z], [w * 0.97, 0, z], [kw, keelY(0), z], [-kw, keelY(0), z]);

  return deckY;
};

export type VesselKind =
  | "ferry"
  | "container"
  | "tanker"
  | "tug"
  | "fireboat"
  | "fishing"
  | "sailboat"
  | "yacht"
  | "kayak";

/** A lamp in the vessel's own frame. Mirrors fx/beacon-lights.ts `Beacon`. */
export interface VesselLight {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly color: number;
  readonly size: number;
  readonly blinkS?: number;
}

export interface Vessel {
  readonly geometry: THREE.BufferGeometry;
  readonly lights: readonly VesselLight[];
  readonly length: number;
  /** Half-width of the wake ribbon at the stern. */
  readonly wakeHalf: number;
}

const NAV_RED = 0xff_2a_1e;
const NAV_GREEN = 0x2b_ff_6a;
const NAV_WHITE = 0xff_f3_d6;
const CABIN_WARM = 0xff_ce_7a;

const navLights = (len: number, beam: number, mast: number) => [
  { color: NAV_RED, size: 1.5, x: -beam * 0.5, y: 1, z: len * 0.22 },
  { color: NAV_GREEN, size: 1.5, x: beam * 0.5, y: 1, z: len * 0.22 },
  { color: NAV_WHITE, size: 2.2, x: 0, y: mast, z: 0 },
];

const geo = (b: PortBuilder) => {
  const g = b.geometry();

  if (!g) {
    throw new Error("vessel produced no geometry");
  }

  return g;
};

const ferry = (b: PortBuilder) => {
  const len = 22;
  const beam = 7;

  const deckY = hull(b, {
    beam,
    boot: 0x2a_3b_4a,
    deck: 0x8f_9a_a2,
    draft: 1.1,
    freeboard: 1.5,
    len,
    sheer: 0.5,
    topside: 0xf2_f4_f6,
    transom: 0.85,
  });

  const d = deckY(0.5);
  b.box(0xf6_f7_f8, beam - 1.2, 2.2, len * 0.74, 0, d + 1.1, -0.6);
  b.box(0x2b_6f_9c, beam - 1, 0.75, len * 0.72, 0, d + 1.5, -0.6);
  b.box(0xe8_eb_ee, beam - 2.2, 1.9, len * 0.56, 0, d + 3.15, -1.2);
  b.box(0x2b_6f_9c, beam - 2, 0.6, len * 0.54, 0, d + 3.4, -1.2);
  b.box(0xf6_f7_f8, beam - 3.6, 1.5, 3.6, 0, d + 4.85, 2.2);
  b.box(0x1d_2b_36, beam - 3.4, 0.28, 3.8, 0, d + 5.7, 2.2);
  b.box(0xd8_53_1f, 1.5, 1.9, 1.5, 0, d + 5.6, -3.4);
  b.cylinder(0xdf_e3_e6, 0.12, 3.2, 0, d + 5.9, 2.2);
  b.box(0xd8_53_1f, beam - 0.6, 0.3, 0.4, 0, d + 0.35, len * 0.36);

  return {
    geometry: geo(b),
    length: len,
    lights: [
      ...navLights(len, beam, d + 8.4),
      { color: CABIN_WARM, size: 9, x: 0, y: d + 2, z: 0 },
      { color: CABIN_WARM, size: 4, x: 0, y: d + 5.4, z: 2.2 },
    ],
    wakeHalf: beam * 0.6,
  };
};

const AIR_DRAFT_MAX = 7.6;

const container = (b: PortBuilder, rng: Rng) => {
  const len = 62;
  const beam = 11;

  const deckY = hull(b, {
    beam,
    boot: 0x2b_1b_18,
    deck: 0x6d_5a_4a,
    draft: 2.2,
    freeboard: 2.3,
    len,
    sheer: 0.7,
    topside: 0x9c_33_27,
    transom: 0.9,
  });

  const d = deckY(0.5);
  const hues = [0xc4_56_2f, 0x2f_6e_a8, 0x3d_7a_4a, 0xb8_a0_3a, 0x8a_4d_86, 0x9a_a2_a8];

  for (let i = 0; i < 7; i += 1) {
    const z = -len * 0.18 + i * 4.6;

    for (const side of [-1, 1] as const) {
      const tiers = 1 + rng.int(2);

      for (let k = 0; k < tiers; k += 1) {
        b.box(rng.pick(hues), 4.2, 1.5, 4.2, side * 2.4, d + 0.85 + k * 1.55, z);
      }
    }
  }

  b.box(0x6d_5a_4a, beam - 1.4, 0.35, len * 0.62, 0, d + 0.18, len * 0.02);
  b.box(0xe6_e3_dc, beam - 3, 3.1, 6, 0, d + 1.55, -len * 0.33);
  b.box(0x24_34_3f, beam - 2.8, 0.5, 5.6, 0, d + 2.4, -len * 0.33);
  b.box(0xe6_e3_dc, beam - 5, 1.4, 4, 0, d + 3.8, -len * 0.33);
  b.box(0x1c_2a_33, 2.2, 1.8, 2, 0, d + 4.1, -len * 0.42);
  b.box(0xc4_39_2b, 2.3, 0.5, 2.1, 0, AIR_DRAFT_MAX - 0.55, -len * 0.42);

  return {
    geometry: geo(b),
    length: len,
    lights: [
      ...navLights(len, beam, d + 5.1),
      { color: CABIN_WARM, size: 7, x: 0, y: d + 3.6, z: -len * 0.33 },
      { color: 0xdf_e8_ff, size: 5, x: 0, y: d + 1, z: len * 0.3 },
    ],
    wakeHalf: beam * 0.7,
  };
};

const tanker = (b: PortBuilder) => {
  const len = 54;
  const beam = 10;

  const deckY = hull(b, {
    beam,
    boot: 0x7a_2b_22,
    deck: 0x3f_5b_45,
    draft: 2.4,
    freeboard: 2,
    len,
    sheer: 0.55,
    topside: 0x1f_2a_33,
    transom: 0.92,
  });

  const d = deckY(0.5);
  b.box(0x3f_5b_45, beam - 1.6, 0.3, len * 0.66, 0, d + 0.15, 2);
  b.beam(0xb9_be_c2, 0, d + 1.1, -len * 0.2, 0, d + 1.1, len * 0.34, 0.5);

  for (let i = 0; i < 5; i += 1) {
    const z = -len * 0.16 + i * 6.4;
    b.beam(0xb9_be_c2, -beam * 0.36, d + 0.9, z, beam * 0.36, d + 0.9, z, 0.34);
    b.cylinder(0xd6_d2_c6, 1.1, 0.9, 0, d + 0.15, z + 3.2);
  }

  b.box(0xf0_ed_e4, beam - 3.2, 3.4, 6.4, 0, d + 1.7, -len * 0.34);
  b.box(0x22_32_3c, beam - 3, 0.55, 6, 0, d + 2.6, -len * 0.34);
  b.box(0xf0_ed_e4, beam - 5, 1.3, 4.2, 0, d + 4.05, -len * 0.34);
  b.box(0x21_31_3a, 2, 1.6, 1.8, 0, d + 4.2, -len * 0.43);
  b.cylinder(0xd8_db_de, 0.11, 0.9, 0, AIR_DRAFT_MAX - 0.9, -len * 0.34);

  return {
    geometry: geo(b),
    length: len,
    lights: [
      ...navLights(len, beam, d + 5.6),
      { color: CABIN_WARM, size: 6, x: 0, y: d + 3.9, z: -len * 0.34 },
      { color: 0xdf_e8_ff, size: 5, x: 0, y: d + 1.6, z: 4 },
    ],
    wakeHalf: beam * 0.7,
  };
};

const tug = (b: PortBuilder, fire: boolean) => {
  const len = fire ? 12.5 : 11;
  const beam = fire ? 4.4 : 4.2;

  const deckY = hull(b, {
    beam,
    boot: 0x5b_26_20,
    deck: 0x58_4a_3c,
    draft: 1.2,
    freeboard: 1.1,
    len,
    sheer: 0.45,
    topside: fire ? 0xc2_35_2a : 0x1d_28_30,
    transom: 0.8,
  });

  const d = deckY(0.5);
  b.box(fire ? 0xe8_eb_ee : 0xc9_54_2f, beam - 1.1, 1.7, 4.6, 0, d + 0.85, -0.4);
  b.box(0x1f_2c_36, beam - 0.9, 0.55, 4.4, 0, d + 1.25, -0.4);
  b.box(0xe8_eb_ee, beam - 2.2, 1.4, 2.6, 0, d + 2.4, 0.4);
  b.box(0x1a_25_30, beam - 2, 0.22, 2.8, 0, d + 3.2, 0.4);
  b.box(fire ? 0xc2_35_2a : 0x2c_3a_44, 1.1, 1.5, 1.1, 0, d + 2.4, -2.8);
  b.cylinder(0xdf_e3_e6, 0.1, 2.4, 0, d + 3.3, 0.4);

  for (let i = 0; i < 4; i += 1) {
    const z = -len * 0.26 + i * (len * 0.17);

    for (const side of [-1, 1] as const) {
      b.box(0x22_20_1e, 0.35, 0.7, 0.7, (side * beam) / 2, d - 0.5, z);
    }
  }

  if (fire) {
    for (const side of [-1, 1] as const) {
      b.cylinder(0xd8_db_de, 0.16, 0.8, side * 1.1, d + 3.2, 0.4);
      b.beam(0xd8_db_de, side * 1.1, d + 3.9, 0.4, side * 1.7, d + 4.5, 2.1, 0.22);
    }
  }

  return {
    geometry: geo(b),
    length: len,
    lights: [
      ...navLights(len, beam, d + 3.6),
      { color: CABIN_WARM, size: 3, x: 0, y: d + 2.4, z: 0.4 },
      ...(fire ? [{ blinkS: 1.1, color: NAV_RED, size: 2.4, x: 0, y: d + 3.6, z: 0.4 }] : []),
    ],
    wakeHalf: beam * 0.75,
  };
};

const fishing = (b: PortBuilder, rng: Rng) => {
  const len = 8.5;
  const beam = 3;
  const hullColor = rng.pick([0xf0_ef_e8, 0x2f_6e_a8, 0x3d_7a_4a, 0xc4_56_2f, 0xd9_c6_5a]);

  const deckY = hull(b, {
    beam,
    boot: 0x2b_3a_44,
    deck: 0x8d_7a_5e,
    draft: 0.8,
    freeboard: 0.85,
    len,
    sheer: 0.4,
    topside: hullColor,
    transom: 0.7,
  });

  const d = deckY(0.5);
  b.box(0xee_ea_e0, beam - 0.9, 1.3, 2.4, 0, d + 0.65, 1.4);
  b.box(0x22_32_3c, beam - 0.7, 0.42, 2.2, 0, d + 0.95, 1.4);
  b.cylinder(0xda_d3_c4, 0.09, 3.2, 0, d + 1.3, 1.2);
  b.beam(0xda_d3_c4, 0, d + 3.6, 1.2, 0, d + 1.4, -2.6, 0.14);
  b.box(0x4a_3f_33, beam - 1.4, 0.5, 1.2, 0, d + 0.25, -2.2);

  return {
    geometry: geo(b),
    length: len,
    lights: [
      ...navLights(len, beam, d + 4.6),
      { color: CABIN_WARM, size: 2.4, x: 0, y: d + 1.2, z: 1.4 },
    ],
    wakeHalf: beam * 0.7,
  };
};

const sailPrism = (
  b: PortBuilder,
  color: number,
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
) => {
  const th = 0.05;
  const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
  const c: readonly (readonly [number, number])[] = area > 0 ? [p0, p1, p2] : [p0, p2, p1];

  const at: (i: number, x: number) => [number, number, number] = (i, x) => {
    const p = c[i] ?? [0, 0];

    return [x, p[1], p[0]];
  };

  b.tri(color, at(0, th), at(2, th), at(1, th));
  b.tri(color, at(0, -th), at(1, -th), at(2, -th));

  for (let i = 0; i < 3; i += 1) {
    const j = (i + 1) % 3;
    b.quad(color, at(i, -th), at(i, th), at(j, th), at(j, -th));
  }
};

const sailboat = (b: PortBuilder, rng: Rng, furled: boolean) => {
  const len = 7.5;
  const beam = 2.3;

  const deckY = hull(b, {
    beam,
    boot: 0x1d_2b_36,
    deck: 0xd9_cd_b4,
    draft: 1.1,
    freeboard: 0.7,
    len,
    sheer: 0.3,
    topside: rng.pick([0xf2_f2_ee, 0xe8_e4_d8, 0x25_44_5e]),
    transom: 0.55,
  });

  const d = deckY(0.5);
  const mastH = 8.4;
  b.box(0xf4_f2_ec, beam - 0.9, 0.55, 2.2, 0, d + 0.28, 0.4);
  b.cylinder(0xe6_e2_d6, 0.08, mastH, 0, d + 0.3, 0.6);
  b.beam(0xe6_e2_d6, 0, d + 1.1, 0.4, 0, d + 1.1, -2.6, 0.12);

  if (!furled) {
    sailPrism(b, 0xfb_fa_f6, [0.6, d + 1.2], [-2.6, d + 1.2], [0.6, d + mastH * 0.92]);
    sailPrism(b, 0xf1_ef_e6, [0.6, d + 0.9], [0.6, d + mastH * 0.7], [3.4, d + 0.9]);
  }

  return {
    geometry: geo(b),
    length: len,
    lights: [
      { color: NAV_WHITE, size: 1.6, x: 0, y: d + mastH, z: 0.6 },
      { color: NAV_RED, size: 1, x: -beam * 0.45, y: d + 0.5, z: len * 0.3 },
      { color: NAV_GREEN, size: 1, x: beam * 0.45, y: d + 0.5, z: len * 0.3 },
    ],
    wakeHalf: beam * 0.6,
  };
};

const yacht = (b: PortBuilder, rng: Rng) => {
  const len = rng.range(8, 12);
  const beam = len * 0.31;

  const deckY = hull(b, {
    beam,
    boot: rng.pick([0x1d_2b_36, 0x2b_3a_44, 0x6a_2f_28]),
    deck: 0xd9_cd_b4,
    draft: 0.85,
    freeboard: 1,
    len,
    sheer: 0.42,
    topside: rng.pick([0xf6_f6_f2, 0xee_ea_e0, 0xdf_e4_e6, 0xf2_ed_e2]),
    transom: 0.85,
  });

  const d = deckY(0.5);
  b.box(0xf7_f7_f3, beam - 0.8, 1.15, len * 0.42, 0, d + 0.58, len * 0.04);
  b.box(0x2c_4a_5e, beam - 0.6, 0.44, len * 0.4, 0, d + 0.86, len * 0.04);
  b.box(0xf7_f7_f3, beam - 1.7, 0.85, len * 0.2, 0, d + 1.58, len * 0.1);
  b.cylinder(0xdf_e3_e6, 0.07, 1.9, 0, d + 2, len * 0.06);

  if (rng.chance(0.4)) {
    for (const side of [-1, 1] as const) {
      b.beam(0xdf_e3_e6, side * 0.6, d + 2, len * 0.06, side * 2.6, d + 4.2, -len * 0.2, 0.1);
    }
  }

  return {
    geometry: geo(b),
    length: len,
    lights: [{ color: CABIN_WARM, size: 2.2, x: 0, y: d + 1.4, z: len * 0.06 }],
    wakeHalf: beam * 0.6,
  };
};

const kayak: (b: PortBuilder, rng: Rng) => Vessel = (b, rng) => {
  const len = 2.8;
  const beam = 0.62;
  const shell = rng.pick([0xe8_70_3a, 0xf2_c3_41, 0x3f_a8_c4, 0x8a_c4_4a]);

  const deckY = hull(b, {
    beam,
    boot: shell,
    deck: 0x2c_33_39,
    draft: 0.16,
    freeboard: 0.16,
    len,
    sheer: 0.1,
    topside: shell,
    transom: 0.35,
  });

  const d = deckY(0.5);
  b.box(0x2a_3b_46, 0.34, 0.42, 0.34, 0, d + 0.21, -0.1);
  b.box(0xf2_b8_77, 0.24, 0.24, 0.24, 0, d + 0.54, -0.1);
  b.beam(0xda_d3_c4, -0.75, d + 0.5, -0.5, 0.75, d + 0.2, 0.3, 0.07);

  return {
    geometry: geo(b),
    length: len,
    lights: [],
    wakeHalf: 0.5,
  };
};

/**
 * Build one vessel in its own frame (+Z bow, waterline y=0). `seed` picks the
 * hull colour, container mix and rig, so a fleet of the same kind still varies.
 */
export const buildVessel = (kind: VesselKind, seed: number) => {
  const b = new PortBuilder();
  const rng = new Rng(seed);

  switch (kind) {
    case "ferry": {
      return ferry(b);
    }

    case "container": {
      return container(b, rng);
    }

    case "tanker": {
      return tanker(b);
    }

    case "tug": {
      return tug(b, false);
    }

    case "fireboat": {
      return tug(b, true);
    }

    case "fishing": {
      return fishing(b, rng);
    }

    case "sailboat": {
      return sailboat(b, rng, seed % 2 === 0);
    }

    case "yacht": {
      return yacht(b, rng);
    }

    case "kayak": {
      return kayak(b, rng);
    }
  }
};

/** A berthed boat: a vessel kind placed and yawed on the water. */
export interface Mooring {
  readonly kind: VesselKind;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly seed: number;
}

const BERTH_OFFSET = 2.6;
const SLOT = 11;
const MIN_BERTH = 5;
const OCCUPANCY = 0.68;

const isWharf = (x: number, z: number) => z < -1100 && x > 220;

const berthKind: (rng: Rng, wharf: boolean) => VesselKind = (rng, wharf) => {
  if (wharf) {
    return rng.chance(0.78) ? "fishing" : "tug";
  }

  return rng.chance(0.45) ? "sailboat" : "yacht";
};

const chainLength = (chain: readonly number[]) => {
  let total = 0;

  for (let i = 0; i + 3 < chain.length; i += 2) {
    total += Math.hypot(
      (chain[i + 2] ?? 0) - (chain[i] ?? 0),
      (chain[i + 3] ?? 0) - (chain[i + 1] ?? 0),
    );
  }

  return total;
};

/**
 * Berth boats ALONGSIDE every marina float that is long enough. Alongside
 * rather than bow-in: the finger spacing in SF_DOCKS is not known to this
 * module, and a perpendicular berth would reach into the neighbouring finger.
 */
export const planMoorings = (
  seed: number,
  isWater: (x: number, z: number) => boolean = () => true,
) => {
  const rng = new Rng(seed);
  const out: Mooring[] = [];

  for (const dock of SF_DOCKS) {
    const total = chainLength(dock);

    if (total < MIN_BERTH) {
      continue;
    }

    const slots = Math.max(1, Math.round(total / SLOT));
    let walked = 0;
    let next = 0;

    for (let i = 0; i + 3 < dock.length; i += 2) {
      const ax = dock[i] ?? 0;
      const az = dock[i + 1] ?? 0;
      const bx = dock[i + 2] ?? 0;
      const bz = dock[i + 3] ?? 0;
      const len = Math.hypot(bx - ax, bz - az);

      if (len < 1e-3) {
        continue;
      }

      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;

      while (next < slots && walked + len > ((next + 0.5) / slots) * total) {
        const t = ((next + 0.5) / slots) * total - walked;
        next += 1;

        if (!rng.chance(OCCUPANCY)) {
          continue;
        }

        const side = rng.chance(0.5) ? 1 : -1;
        const px = ax + dx * t - dz * side * BERTH_OFFSET;
        const pz = az + dz * t + dx * side * BERTH_OFFSET;

        if (!isWater(px, pz)) {
          continue;
        }

        const kind = berthKind(rng, isWharf(px, pz));
        out.push({
          kind,
          // oxlint-disable-next-line no-bitwise -- >>> 0 is the uint32 wrap of the Knuth hash
          seed: Math.imul(seed + out.length, 2_654_435_761) >>> 0,
          x: px,
          yaw: Math.atan2(dx, dz) + (side > 0 ? 0 : Math.PI),
          z: pz,
        });
      }

      walked += len;
    }
  }

  return out;
};

const VARIANTS = 6;

/**
 * Bake the moored fleet through `into` (which picks the right geometry bucket
 * for a position) and return the lamps that were lit (a cabin
 * light in roughly one boat in six — a marina at night is not a light show).
 */
export const addMoorings = (
  into: (x: number, z: number) => PortBuilder,
  moorings: readonly Mooring[],
) => {
  const lit: MooredLamp[] = [];
  const cache = new Map<string, Vessel>();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();

  for (const mo of moorings) {
    const variant = mo.seed % VARIANTS;
    const key = `${mo.kind}:${variant}`;
    let vessel = cache.get(key);

    if (!vessel) {
      vessel = buildVessel(mo.kind, variant * 7918 + mo.kind.length * 2);
      cache.set(key, vessel);
    }

    q.setFromAxisAngle(up, mo.yaw);
    p.set(mo.x, WATER_Y, mo.z);
    into(mo.x, mo.z).addColored(vessel.geometry, m.compose(p, q, one));

    if (variant !== 0) {
      continue;
    }

    const s = Math.sin(mo.yaw);
    const c = Math.cos(mo.yaw);

    for (const l of vessel.lights) {
      if (l.color !== CABIN_WARM) {
        continue;
      }

      lit.push({
        color: l.color,
        size: l.size,
        x: mo.x + l.x * c + l.z * s,
        y: WATER_Y + l.y,
        z: mo.z - l.x * s + l.z * c,
      });
    }
  }

  return lit;
};

/** A moored boat's cabin lamp, already in world space. */
export interface MooredLamp {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly color: number;
  readonly size: number;
}
