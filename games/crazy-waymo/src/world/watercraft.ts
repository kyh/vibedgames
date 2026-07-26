import * as THREE from "three";

import { Rng } from "../shared/rng";
import { SF_DOCKS } from "./sf-piers";

// The port's mesh kit and its fleet.
//
// Everything the waterfront draws — hulls, pier sheds, cranes, bollards,
// pilings — is flat-shaded and VERTEX-COLOURED through one shared material, so
// the whole lot merges into a handful of draws instead of the ~85 the old
// per-pier meshes cost. Colour variety is free (it rides the vertices), which
// is what lets 55 piers stop being 55 copies of the same beige box.
//
// Vessels are procedural: no boat model exists in assets/manifest.ts, and a
// lofted hull is both cheaper and easier to vary than a GLB would be. Each is
// authored in its own frame — +Z bow, +X starboard, waterline at y = 0, the
// same convention fx/vehicle-lights.ts uses for cars — so the caller only has
// to place it at WATER_Y and yaw it down its heading.

/** The ocean plane's height (scenes/game-scene.ts builds it at this y). */
export const WATER_Y = -0.5;

/**
 * One material for the entire port. Flat shading keeps the stylised facet
 * language of the city kit; vertex colours are what make one draw call enough.
 */
export const PORT_MATERIAL = new THREE.MeshStandardMaterial({
  vertexColors: true,
  flatShading: true,
  roughness: 0.85,
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
  get triCount(): number {
    return this.pos.length / 9;
  }

  /** Transformed copy of `src` in one flat colour. */
  addGeometry(src: THREE.BufferGeometry, color: number, m: THREE.Matrix4): void {
    const position = src.getAttribute("position");
    const normal = src.getAttribute("normal");
    const index = src.getIndex();
    const count = index ? index.count : position.count;
    this.nmat.getNormalMatrix(m);
    this.rgb.setHex(color);
    const { r, g, b } = this.rgb;
    for (let i = 0; i < count; i++) {
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
  addColored(src: THREE.BufferGeometry, m: THREE.Matrix4): void {
    const position = src.getAttribute("position");
    const normal = src.getAttribute("normal");
    const color = src.getAttribute("color");
    const index = src.getIndex();
    const count = index ? index.count : position.count;
    this.nmat.getNormalMatrix(m);
    for (let i = 0; i < count; i++) {
      const vi = index ? index.getX(i) : i;
      this.v.fromBufferAttribute(position, vi).applyMatrix4(m);
      this.pos.push(this.v.x, this.v.y, this.v.z);
      this.n.fromBufferAttribute(normal, vi).applyMatrix3(this.nmat).normalize();
      this.nor.push(this.n.x, this.n.y, this.n.z);
      this.col.push(color.getX(vi), color.getY(vi), color.getZ(vi));
    }
  }

  /** Axis-aligned box (optionally yawed), sized and centred in world space. */
  box(
    color: number,
    sx: number,
    sy: number,
    sz: number,
    x: number,
    y: number,
    z: number,
    ry = 0,
  ): void {
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
  ): void {
    this.mat
      .makeRotationY(ry)
      .multiply(PITCH.makeRotationX(rx))
      .scale(SCRATCH.set(sx, sy, sz))
      .setPosition(x, y, z);
    this.addGeometry(UNIT_BOX, color, this.mat);
  }

  /** Upright cylinder — pilings, bollards, masts, funnels. */
  cylinder(color: number, r: number, h: number, x: number, y: number, z: number): void {
    this.mat.makeScale(r * 2, h, r * 2).setPosition(x, y + h / 2, z);
    this.addGeometry(UNIT_CYL, color, this.mat);
  }

  /** Upright cone — buoy tops, crane finials, the odd conical roof. */
  cone(color: number, r: number, h: number, x: number, y: number, z: number): void {
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
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
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
  ): void {
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
    if (len < 1e-9) return; // degenerate (the bow taper collapses to a point)
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
  ): void {
    this.tri(color, a, b, c);
    this.tri(color, a, c, d);
  }

  /** Everything pushed so far, or null when nothing was. */
  geometry(): THREE.BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.col), 3));
    geo.computeBoundingSphere();
    return geo;
  }
}

// --- Hulls ----------------------------------------------------------------

type HullSpec = {
  readonly len: number;
  readonly beam: number;
  /** Deck height above the waterline amidships. */
  readonly freeboard: number;
  readonly draft: number;
  readonly topside: number;
  /** Anti-fouling band below the waterline. */
  readonly boot: number;
  readonly deck: number;
  /** 0.25 = fine canoe stern, 1 = full transom. */
  readonly transom: number;
  /** Extra deck height at the bow — the sheer line. */
  readonly sheer: number;
};

const STATIONS: readonly number[] = [0, 0.12, 0.3, 0.52, 0.72, 0.87, 0.96, 1];

/**
 * A lofted hull: eight stations from transom (t=0) to stem (t=1), each a
 * three-row section (deck edge, waterline, keel). Splitting the side at the
 * waterline is what gives every boat its boot-top stripe for free.
 *
 * Returns the deck height at each station so superstructure can sit on it.
 */
function hull(b: PortBuilder, s: HullSpec): (t: number) => number {
  const deckY = (t: number): number => s.freeboard + s.sheer * Math.max(0, (t - 0.45) / 0.55) ** 2;
  const halfBeam = (t: number): number => {
    const aft = t < 0.45 ? s.transom + (1 - s.transom) * (t / 0.45) ** 0.7 : 1;
    const fwd = t > 0.55 ? 1 - ((t - 0.55) / 0.45) ** 1.9 : 1;
    return Math.max(0.02, (s.beam / 2) * aft * fwd);
  };
  const keelY = (t: number): number => -s.draft * (0.4 + 0.6 * Math.sin(Math.PI * t) ** 0.5);
  const zAt = (t: number): number => (t - 0.5) * s.len;

  for (let i = 0; i + 1 < STATIONS.length; i++) {
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
      // Wound bow-first on starboard and stern-first to port, so both faces
      // point outboard.
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
    // Deck and bottom close the section.
    b.quad(s.deck, [-w0, d0, z0], [w0, d0, z0], [w1, d1, z1], [-w1, d1, z1]);
    b.quad(s.boot, [kw0, k0, z0], [-kw0, k0, z0], [-kw1, k1, z1], [kw1, k1, z1]);
  }
  // Transom: the flat stern face.
  const w = halfBeam(0);
  const kw = w * 0.34;
  const z = zAt(0);
  b.quad(s.topside, [-w, deckY(0), z], [w, deckY(0), z], [w * 0.97, 0, z], [-w * 0.97, 0, z]);
  b.quad(s.boot, [-w * 0.97, 0, z], [w * 0.97, 0, z], [kw, keelY(0), z], [-kw, keelY(0), z]);
  return deckY;
}

// --- Vessels --------------------------------------------------------------

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
export type VesselLight = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly color: number;
  readonly size: number;
  readonly blinkS?: number;
};

export type Vessel = {
  readonly geometry: THREE.BufferGeometry;
  readonly lights: readonly VesselLight[];
  readonly length: number;
  /** Half-width of the wake ribbon at the stern. */
  readonly wakeHalf: number;
};

const NAV_RED = 0xff2a1e;
const NAV_GREEN = 0x2bff6a;
const NAV_WHITE = 0xfff3d6;
const CABIN_WARM = 0xffce7a;

/** Port/starboard sidelights plus a masthead — every vessel carries these. */
function navLights(len: number, beam: number, mast: number): VesselLight[] {
  return [
    { x: -beam * 0.5, y: 1, z: len * 0.22, color: NAV_RED, size: 1.5 },
    { x: beam * 0.5, y: 1, z: len * 0.22, color: NAV_GREEN, size: 1.5 },
    { x: 0, y: mast, z: 0, color: NAV_WHITE, size: 2.2 },
  ];
}

/** Golden Gate ferry: white twin-deck, orange trim, the Bay's commuter icon. */
function ferry(b: PortBuilder): Vessel {
  const len = 22;
  const beam = 7;
  const deckY = hull(b, {
    len,
    beam,
    freeboard: 1.5,
    draft: 1.1,
    topside: 0xf2f4f6,
    boot: 0x2a3b4a,
    deck: 0x8f9aa2,
    transom: 0.85,
    sheer: 0.5,
  });
  const d = deckY(0.5);
  // Lower saloon, upper sun deck, wheelhouse on top — the twin-deck read.
  b.box(0xf6f7f8, beam - 1.2, 2.2, len * 0.74, 0, d + 1.1, -0.6);
  b.box(0x2b6f9c, beam - 1.0, 0.75, len * 0.72, 0, d + 1.5, -0.6); // window band
  b.box(0xe8ebee, beam - 2.2, 1.9, len * 0.56, 0, d + 3.15, -1.2);
  b.box(0x2b6f9c, beam - 2.0, 0.6, len * 0.54, 0, d + 3.4, -1.2);
  b.box(0xf6f7f8, beam - 3.6, 1.5, 3.6, 0, d + 4.85, 2.2); // wheelhouse
  b.box(0x1d2b36, beam - 3.4, 0.28, 3.8, 0, d + 5.7, 2.2);
  b.box(0xd8531f, 1.5, 1.9, 1.5, 0, d + 5.6, -3.4); // stack
  b.cylinder(0xdfe3e6, 0.12, 3.2, 0, d + 5.9, 2.2); // mast
  b.box(0xd8531f, beam - 0.6, 0.3, 0.4, 0, d + 0.35, len * 0.36); // bow rail band
  return {
    geometry: geo(b),
    lights: [
      ...navLights(len, beam, d + 8.4),
      { x: 0, y: d + 2, z: 0, color: CABIN_WARM, size: 9 },
      { x: 0, y: d + 5.4, z: 2.2, color: CABIN_WARM, size: 4 },
    ],
    length: len,
    wakeHalf: beam * 0.6,
  };
}

/**
 * Feeder container ship. Air draft is the hard constraint: the Bay Bridge's
 * lower deck undersides sit at y≈8.3, so nothing on this ship may rise past
 * AIR_DRAFT_MAX or the crossing under the bridge clips it.
 */
const AIR_DRAFT_MAX = 7.6;

function container(b: PortBuilder, rng: Rng): Vessel {
  const len = 62;
  const beam = 11;
  const deckY = hull(b, {
    len,
    beam,
    freeboard: 2.3,
    draft: 2.2,
    topside: 0x9c3327,
    boot: 0x2b1b18,
    deck: 0x6d5a4a,
    transom: 0.9,
    sheer: 0.7,
  });
  const d = deckY(0.5);
  // Container stacks: two rows of blocks with a hatch gangway down the middle.
  const hues = [0xc4562f, 0x2f6ea8, 0x3d7a4a, 0xb8a03a, 0x8a4d86, 0x9aa2a8];
  for (let i = 0; i < 7; i++) {
    const z = -len * 0.18 + i * 4.6;
    for (const side of [-1, 1] as const) {
      const tiers = 1 + rng.int(2);
      for (let k = 0; k < tiers; k++) {
        b.box(rng.pick(hues), 4.2, 1.5, 4.2, side * 2.4, d + 0.85 + k * 1.55, z);
      }
    }
  }
  b.box(0x6d5a4a, beam - 1.4, 0.35, len * 0.62, 0, d + 0.18, len * 0.02); // hatch covers
  // House and funnel aft — the whole silhouette stays under AIR_DRAFT_MAX.
  b.box(0xe6e3dc, beam - 3, 3.1, 6, 0, d + 1.55, -len * 0.33);
  b.box(0x24343f, beam - 2.8, 0.5, 5.6, 0, d + 2.4, -len * 0.33);
  b.box(0xe6e3dc, beam - 5, 1.4, 4, 0, d + 3.8, -len * 0.33);
  b.box(0x1c2a33, 2.2, 1.8, 2, 0, d + 4.1, -len * 0.42); // funnel
  b.box(0xc4392b, 2.3, 0.5, 2.1, 0, AIR_DRAFT_MAX - 0.55, -len * 0.42); // funnel cap = air draft
  return {
    geometry: geo(b),
    lights: [
      ...navLights(len, beam, d + 5.1),
      { x: 0, y: d + 3.6, z: -len * 0.33, color: CABIN_WARM, size: 7 },
      { x: 0, y: d + 1, z: len * 0.3, color: 0xdfe8ff, size: 5 },
    ],
    length: len,
    wakeHalf: beam * 0.7,
  };
}

/** Product tanker: long low deck, a forest of manifold pipework, house aft. */
function tanker(b: PortBuilder): Vessel {
  const len = 54;
  const beam = 10;
  const deckY = hull(b, {
    len,
    beam,
    freeboard: 2,
    draft: 2.4,
    topside: 0x1f2a33,
    boot: 0x7a2b22,
    deck: 0x3f5b45,
    transom: 0.92,
    sheer: 0.55,
  });
  const d = deckY(0.5);
  b.box(0x3f5b45, beam - 1.6, 0.3, len * 0.66, 0, d + 0.15, 2); // deck plating
  // Cargo manifold: a spine of pipe with cross runs and tank domes.
  b.beam(0xb9bec2, 0, d + 1.1, -len * 0.2, 0, d + 1.1, len * 0.34, 0.5);
  for (let i = 0; i < 5; i++) {
    const z = -len * 0.16 + i * 6.4;
    b.beam(0xb9bec2, -beam * 0.36, d + 0.9, z, beam * 0.36, d + 0.9, z, 0.34);
    b.cylinder(0xd6d2c6, 1.1, 0.9, 0, d + 0.15, z + 3.2);
  }
  b.box(0xf0ede4, beam - 3.2, 3.4, 6.4, 0, d + 1.7, -len * 0.34);
  b.box(0x22323c, beam - 3.0, 0.55, 6.0, 0, d + 2.6, -len * 0.34);
  b.box(0xf0ede4, beam - 5, 1.3, 4.2, 0, d + 4.05, -len * 0.34);
  b.box(0x21313a, 2, 1.6, 1.8, 0, d + 4.2, -len * 0.43);
  b.cylinder(0xd8dbde, 0.11, 0.9, 0, AIR_DRAFT_MAX - 0.9, -len * 0.34); // stub mast = air draft
  return {
    geometry: geo(b),
    lights: [
      ...navLights(len, beam, d + 5.6),
      { x: 0, y: d + 3.9, z: -len * 0.34, color: CABIN_WARM, size: 6 },
      { x: 0, y: d + 1.6, z: 4, color: 0xdfe8ff, size: 5 },
    ],
    length: len,
    wakeHalf: beam * 0.7,
  };
}

/** Harbour tug — or, in red with monitors on the roof, the fireboat. */
function tug(b: PortBuilder, fire: boolean): Vessel {
  const len = fire ? 12.5 : 11;
  const beam = fire ? 4.4 : 4.2;
  const deckY = hull(b, {
    len,
    beam,
    freeboard: 1.1,
    draft: 1.2,
    topside: fire ? 0xc2352a : 0x1d2830,
    boot: 0x5b2620,
    deck: 0x584a3c,
    transom: 0.8,
    sheer: 0.45,
  });
  const d = deckY(0.5);
  b.box(fire ? 0xe8ebee : 0xc9542f, beam - 1.1, 1.7, 4.6, 0, d + 0.85, -0.4);
  b.box(0x1f2c36, beam - 0.9, 0.55, 4.4, 0, d + 1.25, -0.4);
  b.box(0xe8ebee, beam - 2.2, 1.4, 2.6, 0, d + 2.4, 0.4); // wheelhouse
  b.box(0x1a2530, beam - 2.0, 0.22, 2.8, 0, d + 3.2, 0.4);
  b.box(fire ? 0xc2352a : 0x2c3a44, 1.1, 1.5, 1.1, 0, d + 2.4, -2.8); // stack
  b.cylinder(0xdfe3e6, 0.1, 2.4, 0, d + 3.3, 0.4);
  // Tyre fenders down both sides — the detail that says "working boat".
  for (let i = 0; i < 4; i++) {
    const z = -len * 0.26 + i * (len * 0.17);
    for (const side of [-1, 1] as const) {
      b.box(0x22201e, 0.35, 0.7, 0.7, (side * beam) / 2, d - 0.5, z);
    }
  }
  if (fire) {
    // Deck monitors: the twin water cannon that make a fireboat readable.
    for (const side of [-1, 1] as const) {
      b.cylinder(0xd8dbde, 0.16, 0.8, side * 1.1, d + 3.2, 0.4);
      b.beam(0xd8dbde, side * 1.1, d + 3.9, 0.4, side * 1.7, d + 4.5, 2.1, 0.22);
    }
  }
  return {
    geometry: geo(b),
    lights: [
      ...navLights(len, beam, d + 3.6),
      { x: 0, y: d + 2.4, z: 0.4, color: CABIN_WARM, size: 3 },
      ...(fire ? [{ x: 0, y: d + 3.6, z: 0.4, color: NAV_RED, size: 2.4, blinkS: 1.1 }] : []),
    ],
    length: len,
    wakeHalf: beam * 0.75,
  };
}

/** Wharf fishing boat: cabin forward, open working deck aft, boom mast. */
function fishing(b: PortBuilder, rng: Rng): Vessel {
  const len = 8.5;
  const beam = 3;
  const hullColor = rng.pick([0xf0efe8, 0x2f6ea8, 0x3d7a4a, 0xc4562f, 0xd9c65a]);
  const deckY = hull(b, {
    len,
    beam,
    freeboard: 0.85,
    draft: 0.8,
    topside: hullColor,
    boot: 0x2b3a44,
    deck: 0x8d7a5e,
    transom: 0.7,
    sheer: 0.4,
  });
  const d = deckY(0.5);
  b.box(0xeeeae0, beam - 0.9, 1.3, 2.4, 0, d + 0.65, 1.4);
  b.box(0x22323c, beam - 0.7, 0.42, 2.2, 0, d + 0.95, 1.4);
  b.cylinder(0xdad3c4, 0.09, 3.2, 0, d + 1.3, 1.2); // mast
  b.beam(0xdad3c4, 0, d + 3.6, 1.2, 0, d + 1.4, -2.6, 0.14); // boom aft
  b.box(0x4a3f33, beam - 1.4, 0.5, 1.2, 0, d + 0.25, -2.2); // fish hold hatch
  return {
    geometry: geo(b),
    lights: [
      ...navLights(len, beam, d + 4.6),
      { x: 0, y: d + 1.2, z: 1.4, color: CABIN_WARM, size: 2.4 },
    ],
    length: len,
    wakeHalf: beam * 0.7,
  };
}

/**
 * A sail: a triangle in the boat's centreline plane (z, y), given 0.1u of
 * thickness so it is a solid, correctly-lit body from either side. Corners are
 * wound so the +X face comes out front-facing.
 */
function sailPrism(
  b: PortBuilder,
  color: number,
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
): void {
  const th = 0.05;
  // Signed area in the (z, y) plane decides which winding faces +X.
  const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
  const c: readonly (readonly [number, number])[] = area > 0 ? [p0, p1, p2] : [p0, p2, p1];
  const at = (i: number, x: number): [number, number, number] => {
    const p = c[i] ?? [0, 0];
    return [x, p[1], p[0]];
  };
  b.tri(color, at(0, th), at(2, th), at(1, th));
  b.tri(color, at(0, -th), at(1, -th), at(2, -th));
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    b.quad(color, at(i, -th), at(i, th), at(j, th), at(j, -th));
  }
}

/** Bay sailboat: sloop rig, sails as thin solid prisms (no double-siding). */
function sailboat(b: PortBuilder, rng: Rng, furled: boolean): Vessel {
  const len = 7.5;
  const beam = 2.3;
  const deckY = hull(b, {
    len,
    beam,
    freeboard: 0.7,
    draft: 1.1,
    topside: rng.pick([0xf2f2ee, 0xe8e4d8, 0x25445e]),
    boot: 0x1d2b36,
    deck: 0xd9cdb4,
    transom: 0.55,
    sheer: 0.3,
  });
  const d = deckY(0.5);
  const mastH = 8.4;
  b.box(0xf4f2ec, beam - 0.9, 0.55, 2.2, 0, d + 0.28, 0.4); // coachroof
  b.cylinder(0xe6e2d6, 0.08, mastH, 0, d + 0.3, 0.6);
  b.beam(0xe6e2d6, 0, d + 1.1, 0.4, 0, d + 1.1, -2.6, 0.12); // boom
  if (!furled) {
    // Mainsail abaft the mast, jib forward. Thin PRISMS rather than planes:
    // the port's shared material is single-sided, and a plane would vanish on
    // one tack.
    sailPrism(b, 0xfbfaf6, [0.6, d + 1.2], [-2.6, d + 1.2], [0.6, d + mastH * 0.92]);
    sailPrism(b, 0xf1efe6, [0.6, d + 0.9], [0.6, d + mastH * 0.7], [3.4, d + 0.9]);
  }
  return {
    geometry: geo(b),
    lights: [
      { x: 0, y: d + mastH, z: 0.6, color: NAV_WHITE, size: 1.6 },
      { x: -beam * 0.45, y: d + 0.5, z: len * 0.3, color: NAV_RED, size: 1 },
      { x: beam * 0.45, y: d + 0.5, z: len * 0.3, color: NAV_GREEN, size: 1 },
    ],
    length: len,
    wakeHalf: beam * 0.6,
  };
}

/** Moored motor yacht — the thing 671 empty marina floats were missing. */
function yacht(b: PortBuilder, rng: Rng): Vessel {
  const len = rng.range(8, 12);
  const beam = len * 0.31;
  const deckY = hull(b, {
    len,
    beam,
    freeboard: 1,
    draft: 0.85,
    topside: rng.pick([0xf6f6f2, 0xeeeae0, 0xdfe4e6, 0xf2ede2]),
    boot: rng.pick([0x1d2b36, 0x2b3a44, 0x6a2f28]),
    deck: 0xd9cdb4,
    transom: 0.85,
    sheer: 0.42,
  });
  const d = deckY(0.5);
  b.box(0xf7f7f3, beam - 0.8, 1.15, len * 0.42, 0, d + 0.58, len * 0.04);
  b.box(0x2c4a5e, beam - 0.6, 0.44, len * 0.4, 0, d + 0.86, len * 0.04); // glazing
  b.box(0xf7f7f3, beam - 1.7, 0.85, len * 0.2, 0, d + 1.58, len * 0.1); // flybridge
  b.cylinder(0xdfe3e6, 0.07, 1.9, 0, d + 2, len * 0.06);
  if (rng.chance(0.4)) {
    // Sportfisher: a pair of outriggers, raked aft.
    for (const side of [-1, 1] as const) {
      b.beam(0xdfe3e6, side * 0.6, d + 2, len * 0.06, side * 2.6, d + 4.2, -len * 0.2, 0.1);
    }
  }
  return {
    geometry: geo(b),
    lights: [{ x: 0, y: d + 1.4, z: len * 0.06, color: CABIN_WARM, size: 2.2 }],
    length: len,
    wakeHalf: beam * 0.6,
  };
}

/** Sea kayak with a paddler — Aquatic Park's tour cluster. */
function kayak(b: PortBuilder, rng: Rng): Vessel {
  const len = 2.8;
  const beam = 0.62;
  const shell = rng.pick([0xe8703a, 0xf2c341, 0x3fa8c4, 0x8ac44a]);
  const deckY = hull(b, {
    len,
    beam,
    freeboard: 0.16,
    draft: 0.16,
    topside: shell,
    boot: shell,
    deck: 0x2c3339,
    transom: 0.35,
    sheer: 0.1,
  });
  const d = deckY(0.5);
  b.box(0x2a3b46, 0.34, 0.42, 0.34, 0, d + 0.21, -0.1); // torso
  b.box(0xf2b877, 0.24, 0.24, 0.24, 0, d + 0.54, -0.1); // head
  b.beam(0xdad3c4, -0.75, d + 0.5, -0.5, 0.75, d + 0.2, 0.3, 0.07); // paddle
  return {
    geometry: geo(b),
    lights: [],
    length: len,
    wakeHalf: 0.5,
  };
}

function geo(b: PortBuilder): THREE.BufferGeometry {
  const g = b.geometry();
  if (!g) throw new Error("vessel produced no geometry");
  return g;
}

/**
 * Build one vessel in its own frame (+Z bow, waterline y=0). `seed` picks the
 * hull colour, container mix and rig, so a fleet of the same kind still varies.
 */
export function buildVessel(kind: VesselKind, seed: number): Vessel {
  const b = new PortBuilder();
  const rng = new Rng(seed);
  switch (kind) {
    case "ferry":
      return ferry(b);
    case "container":
      return container(b, rng);
    case "tanker":
      return tanker(b);
    case "tug":
      return tug(b, false);
    case "fireboat":
      return tug(b, true);
    case "fishing":
      return fishing(b, rng);
    case "sailboat":
      // Even seeds are furled: the moored fleet builds variants 0..5, so a
      // marina reads as bare masts and the boats out sailing carry canvas.
      return sailboat(b, rng, seed % 2 === 0);
    case "yacht":
      return yacht(b, rng);
    case "kayak":
      return kayak(b, rng);
  }
}

// --- The moored fleet -----------------------------------------------------

/** A berthed boat: a vessel kind placed and yawed on the water. */
export type Mooring = {
  readonly kind: VesselKind;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly seed: number;
};

const SLOT = 11; // metres of dock per berth
const MIN_BERTH = 5; // a shorter float is a dinghy tie-up, not a berth
const OCCUPANCY = 0.68;

/** Wharf water: north shore, east of Aquatic Park — this is the fishing fleet. */
function isWharf(x: number, z: number): boolean {
  return z < -1100 && x > 220;
}

/**
 * Berth boats ALONGSIDE every marina float that is long enough. Alongside
 * rather than bow-in: the finger spacing in SF_DOCKS is not known to this
 * module, and a perpendicular berth would reach into the neighbouring finger.
 */
export function planMoorings(seed: number): readonly Mooring[] {
  const rng = new Rng(seed);
  const out: Mooring[] = [];
  for (const dock of SF_DOCKS) {
    // Walk the WHOLE float, not each vertex pair: the marina fingers come out
    // of OSM as chains of ~5u segments, and berthing per segment would leave
    // most of the harbour empty (the very "unfinished construction" read).
    let total = 0;
    for (let i = 0; i + 3 < dock.length; i += 2) {
      total += Math.hypot(
        (dock[i + 2] ?? 0) - (dock[i] ?? 0),
        (dock[i + 3] ?? 0) - (dock[i + 1] ?? 0),
      );
    }
    if (total < MIN_BERTH) continue;
    const slots = Math.max(1, Math.round(total / SLOT));
    let walked = 0;
    let next = 0;
    for (let i = 0; i + 3 < dock.length; i += 2) {
      const ax = dock[i] ?? 0;
      const az = dock[i + 1] ?? 0;
      const bx = dock[i + 2] ?? 0;
      const bz = dock[i + 3] ?? 0;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      while (next < slots && walked + len > ((next + 0.5) / slots) * total) {
        const t = ((next + 0.5) / slots) * total - walked;
        next++;
        if (!rng.chance(OCCUPANCY)) continue;
        const side = rng.chance(0.5) ? 1 : -1;
        // 2.6u off the float: the finger's own half-width plus a fender gap.
        const px = ax + dx * t - dz * side * BERTH_OFFSET;
        const pz = az + dz * t + dx * side * BERTH_OFFSET;
        const kind: VesselKind = isWharf(px, pz)
          ? rng.chance(0.78)
            ? "fishing"
            : "tug"
          : rng.chance(0.45)
            ? "sailboat"
            : "yacht";
        // Bow points along the float, flipping with the berth side so the
        // marina reads as parked boats rather than a shoal of clones.
        out.push({
          kind,
          x: px,
          z: pz,
          yaw: Math.atan2(dx, dz) + (side > 0 ? 0 : Math.PI),
          seed: Math.imul(seed + out.length, 2654435761) >>> 0,
        });
      }
      walked += len;
    }
  }
  return out;
}

const BERTH_OFFSET = 2.6;

/**
 * Bake the moored fleet through `into` (which picks the right geometry bucket
 * for a position) and return the lamps that were lit (a cabin
 * light in roughly one boat in six — a marina at night is not a light show).
 */
export function addMoorings(
  into: (x: number, z: number) => PortBuilder,
  moorings: readonly Mooring[],
): readonly MooredLamp[] {
  const lit: MooredLamp[] = [];
  const cache = new Map<string, Vessel>();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();
  for (const mo of moorings) {
    // VARIANTS hull shapes per kind: enough to break the pattern, few enough
    // that the geometry is built a handful of times, not two hundred.
    const variant = mo.seed % VARIANTS;
    const key = `${mo.kind}:${variant}`;
    let vessel = cache.get(key);
    if (!vessel) {
      // EVEN seeds only: sailboats read their seed parity as "furled", and a
      // marina is a forest of bare masts, not a regatta.
      vessel = buildVessel(mo.kind, variant * 7918 + mo.kind.length * 2);
      cache.set(key, vessel);
    }
    q.setFromAxisAngle(up, mo.yaw);
    p.set(mo.x, WATER_Y, mo.z);
    into(mo.x, mo.z).addColored(vessel.geometry, m.compose(p, q, one));
    if (variant !== 0) continue; // ~1 boat in VARIANTS keeps a light burning
    const s = Math.sin(mo.yaw);
    const c = Math.cos(mo.yaw);
    for (const l of vessel.lights) {
      if (l.color !== CABIN_WARM) continue;
      lit.push({
        x: mo.x + l.x * c + l.z * s,
        y: WATER_Y + l.y,
        z: mo.z - l.x * s + l.z * c,
        color: l.color,
        size: l.size,
      });
    }
  }
  return lit;
}

const VARIANTS = 6;

/** A moored boat's cabin lamp, already in world space. */
export type MooredLamp = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly color: number;
  readonly size: number;
};
