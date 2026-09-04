import { CHUNK, DRAW_DISTANCE, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import { Rng } from "../shared/rng";
import { type ParcelLot, type ParcelPlan, pointInRing } from "./parcel-plan";
import {
  colorsFor,
  GROUND_MIN,
  litShare,
  type ParcelColors,
  type ParcelKind,
  shade,
} from "./parcel-style";

// Facade geometry for the parcel fabric: flat-shaded, vertex-coloured, one
// merged buffer per (stream tile, tier, material). No textures, no instancing,
// no per-building objects — a row house is ~40 quads and downtown is ~15k of
// them, and the whole thing regenerates in well under a second on every load,
// which is what keeps it OUT of the world bins (see parcel-build.ts).
//
// Vertex budget is the design constraint. Windows are decals — a quad proud of
// the wall — because a recessed window is five quads; towers get one strip per
// storey per face instead of punched windows; the detail tier (everything but
// the body and roof) culls at DETAIL_DISTANCE on a fine 160u grid, and the
// mobile levels drop it further (see DetailLevel).

/**
 * 0 = bodies + storefront glass; 1 = + the street face's windows, cornice and
 * doors; 2 = + the flanks' and rears' windows, bays, awnings, stoops, roof plant.
 */
export type DetailLevel = 0 | 1 | 2;

export type ParcelMaterial = "wall" | "glassLit" | "glassDark" | "facade";

/** Cull band of a buffer: bodies by silhouette height, detail on the near band. */
export type MeshTier = "far" | "mid" | "near" | "detail";

export type ParcelGeo = {
  readonly tier: MeshTier;
  readonly mat: ParcelMaterial;
  readonly cx: number;
  readonly cz: number;
  readonly radius: number;
  readonly position: Float32Array;
  readonly normal: Int8Array;
  readonly color: Uint8Array;
  readonly index: Uint16Array | Uint32Array;
  /** Facade-shader walls only (parcel-build.ts FACADE): see FacadeBuf. */
  readonly fuv?: Uint16Array;
  readonly facade?: Uint16Array;
  readonly facade2?: Uint8Array;
};

export type ParcelGeoStats = {
  readonly vertices: number;
  readonly triangles: number;
  readonly buffers: number;
};

export type ParcelGeometry = {
  readonly geos: readonly ParcelGeo[];
  readonly stats: ParcelGeoStats;
};

/**
 * Ear-clipping triangulation of a simple xz ring (positive signed area).
 * Rings here are 4-60 vertices, so the O(n²) walk is nothing, and it keeps
 * this module free of three — the harness triangulates the same roofs in
 * node to count the budget.
 */
function earClip(ring: Float32Array, n: number): number[] {
  const tris: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const px = (i: number): number => ring[i * 2] ?? 0;
  const pz = (i: number): number => ring[i * 2 + 1] ?? 0;
  const turn = (a: number, b: number, c: number): number =>
    (px(b) - px(a)) * (pz(c) - pz(a)) - (pz(b) - pz(a)) * (px(c) - px(a));
  const inside = (a: number, b: number, c: number, p: number): boolean =>
    turn(a, b, p) >= 0 && turn(b, c, p) >= 0 && turn(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 4 * n) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length] ?? 0;
      const b = idx[k] ?? 0;
      const c = idx[(k + 1) % idx.length] ?? 0;
      if (turn(a, b, c) <= 1e-9) continue; // reflex or degenerate
      let ear = true;
      for (const p of idx) {
        if (p === a || p === b || p === c) continue;
        if (inside(a, b, c, p)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      tris.push(a, b, c);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // not simple after all: leave what we have
  }
  if (idx.length === 3) tris.push(idx[0] ?? 0, idx[1] ?? 0, idx[2] ?? 0);
  return tris;
}

// Sizes, in world units. The car is 2.75u long and 1.5u wide; every ground-
// floor opening is sized against it, not against a person.
const OFF = 0.045; // decal lift off the wall
const OFF2 = 0.07; // glass over its frame
const PARAPET = 0.24;
const CORNICE_H = 0.3;
const CORNICE_D = 0.24;
const BAY_D = 0.32;
const DETAIL_CELL = 160;
/** Silhouette bands (city.ts): the skyline draws to the fog line, the fabric one ring less. */
const BIG_H = 13;
const MID_H = 5;

const DETAIL_TIERS: readonly MeshTier[] = ["far", "mid", "near", "detail"];

class GeoBuf {
  pos = new Float32Array(3 * 1024);
  nor = new Int8Array(3 * 1024);
  col = new Uint8Array(3 * 1024);
  idx = new Uint32Array(6 * 1024);
  nv = 0;
  ni = 0;

  protected reserve(verts: number, indices: number): void {
    if ((this.nv + verts) * 3 > this.pos.length) {
      const cap = Math.max(this.pos.length * 2, (this.nv + verts) * 3);
      const p = new Float32Array(cap);
      p.set(this.pos);
      this.pos = p;
      const n = new Int8Array(cap);
      n.set(this.nor);
      this.nor = n;
      const c = new Uint8Array(cap);
      c.set(this.col);
      this.col = c;
    }
    if (this.ni + indices > this.idx.length) {
      const i = new Uint32Array(Math.max(this.idx.length * 2, this.ni + indices));
      i.set(this.idx);
      this.idx = i;
    }
  }

  protected vert(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    c: number,
  ): void {
    const o = this.nv * 3;
    this.pos[o] = x;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z;
    this.nor[o] = Math.round(nx * 127);
    this.nor[o + 1] = Math.round(ny * 127);
    this.nor[o + 2] = Math.round(nz * 127);
    this.col[o] = (c >> 16) & 0xff;
    this.col[o + 1] = (c >> 8) & 0xff;
    this.col[o + 2] = c & 0xff;
    this.nv++;
  }

  /**
   * A quad a-b-c-d, wound so its face normal agrees with (nx, ny, nz) —
   * the caller hands over the OUTWARD direction and never thinks about winding.
   */
  quad(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
    nx: number,
    ny: number,
    nz: number,
    color: number,
  ): void {
    this.reserve(4, 6);
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    const len = Math.hypot(fx, fy, fz) || 1;
    let onx = fx / len;
    let ony = fy / len;
    let onz = fz / len;
    const flip = onx * nx + ony * ny + onz * nz < 0;
    if (flip) {
      onx = -onx;
      ony = -ony;
      onz = -onz;
    }
    const base = this.nv;
    this.vert(ax, ay, az, onx, ony, onz, color);
    this.vert(bx, by, bz, onx, ony, onz, color);
    this.vert(cx, cy, cz, onx, ony, onz, color);
    this.vert(dx, dy, dz, onx, ony, onz, color);
    const i = this.ni;
    if (flip) {
      this.idx[i] = base;
      this.idx[i + 1] = base + 2;
      this.idx[i + 2] = base + 1;
      this.idx[i + 3] = base;
      this.idx[i + 4] = base + 3;
      this.idx[i + 5] = base + 2;
    } else {
      this.idx[i] = base;
      this.idx[i + 1] = base + 1;
      this.idx[i + 2] = base + 2;
      this.idx[i + 3] = base;
      this.idx[i + 4] = base + 2;
      this.idx[i + 5] = base + 3;
    }
    this.ni += 6;
  }

  /** A polygon draped on per-vertex heights, facing up — the surface lots. */
  capDraped(ring: Float32Array, n: number, ys: Float32Array, lift: number, color: number): void {
    const tris = earClip(ring, n);
    this.reserve(n, tris.length);
    const base = this.nv;
    for (let i = 0; i < n; i++) {
      this.vert(ring[i * 2] ?? 0, (ys[i] ?? 0) + lift, ring[i * 2 + 1] ?? 0, 0, 1, 0, color);
    }
    for (let t = 0; t < tris.length; t += 3) {
      const i = this.ni;
      this.idx[i] = base + (tris[t] ?? 0);
      this.idx[i + 1] = base + (tris[t + 2] ?? 0);
      this.idx[i + 2] = base + (tris[t + 1] ?? 0);
      this.ni += 3;
    }
  }

  /** A horizontal polygon (positive-area xz ring at height y) facing up (+1) or down (-1). */
  cap(ring: Float32Array, n: number, y: number, up: 1 | -1, color: number): void {
    const tris = earClip(ring, n);
    this.reserve(n, tris.length);
    const base = this.nv;
    for (let i = 0; i < n; i++)
      this.vert(ring[i * 2] ?? 0, y, ring[i * 2 + 1] ?? 0, 0, up, 0, color);
    // Ears come out with a positive (x,z) turn, which with y up faces DOWN.
    for (let t = 0; t < tris.length; t += 3) {
      const i = this.ni;
      this.idx[i] = base + (tris[t] ?? 0);
      if (up === 1) {
        this.idx[i + 1] = base + (tris[t + 2] ?? 0);
        this.idx[i + 2] = base + (tris[t + 1] ?? 0);
      } else {
        this.idx[i + 1] = base + (tris[t + 1] ?? 0);
        this.idx[i + 2] = base + (tris[t + 2] ?? 0);
      }
      this.ni += 3;
    }
  }
}

/**
 * Walls the FACADE SHADER dresses (the lean, non-survey fabric): every vertex
 * also carries its along-wall / above-seat coordinate and the wall's storey
 * rhythm, and the shader draws the windows, doors and shopfronts from those.
 * Zero extra geometry per opening — which is the only way 130k parcels fit.
 *
 * facade (u16 ×4, normalized, ×FACADE_SCALE): storeyH, pitch, groundH, wallLen
 * facade2 (u8 ×4, raw): storeys, seed, flags, 0
 */
export const FACADE_SCALE = 512;
/** Metres the v coordinate is lifted by so a foundation band below the seat stays unsigned. */
export const FUV_V_BIAS = 8;
export const FACADE_FLAG_SHOP = 1;
export const FACADE_FLAG_HOUSE = 2;
export const FACADE_FLAG_SHED = 4;
export const FACADE_FLAG_BLANK = 8;

export type FacadeParams = {
  readonly storeyH: number;
  readonly pitch: number;
  readonly groundH: number;
  readonly wallLen: number;
  readonly storeys: number;
  readonly seed: number;
  readonly flags: number;
};

class FacadeBuf extends GeoBuf {
  fuv = new Uint16Array(2 * 1024);
  fac = new Uint16Array(4 * 1024);
  fac2 = new Uint8Array(4 * 1024);

  protected override reserve(verts: number, indices: number): void {
    super.reserve(verts, indices);
    const cap = this.pos.length / 3;
    if (cap * 2 > this.fuv.length) {
      const u = new Uint16Array(cap * 2);
      u.set(this.fuv);
      this.fuv = u;
      const f = new Uint16Array(cap * 4);
      f.set(this.fac);
      this.fac = f;
      const g = new Uint8Array(cap * 4);
      g.set(this.fac2);
      this.fac2 = g;
    }
  }

  /** A wall quad from (x0, z0) along (tx, tz) for len, seat y0 to top y1, with its facade data. */
  wall(
    x0: number,
    z0: number,
    tx: number,
    tz: number,
    len: number,
    y0: number,
    y1: number,
    nx: number,
    nz: number,
    color: number,
    fp: FacadeParams,
    vBase: number,
  ): void {
    const base = this.nv;
    const x1 = x0 + tx * len;
    const z1 = z0 + tz * len;
    this.quad(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0, nx, 0, nz, color);
    const q = (v: number): number =>
      Math.max(0, Math.min(65535, Math.round((v / FACADE_SCALE) * 65535)));
    const us = [0, len, len, 0];
    const vs = [vBase, vBase, vBase + (y1 - y0), vBase + (y1 - y0)];
    for (let k = 0; k < 4; k++) {
      const i = base + k;
      // Centimetres, unsigned: v is measured from the seat and the foundation
      // band dips below it, so the shader subtracts FUV_V_BIAS back out.
      this.fuv[i * 2] = Math.max(0, Math.min(65535, Math.round((us[k] ?? 0) * 100)));
      this.fuv[i * 2 + 1] = Math.max(
        0,
        Math.min(65535, Math.round(((vs[k] ?? 0) + FUV_V_BIAS) * 100)),
      );
      this.fac[i * 4] = q(fp.storeyH);
      this.fac[i * 4 + 1] = q(fp.pitch);
      this.fac[i * 4 + 2] = q(fp.groundH);
      this.fac[i * 4 + 3] = q(fp.wallLen);
      this.fac2[i * 4] = Math.min(255, fp.storeys);
      this.fac2[i * 4 + 1] = fp.seed & 0xff;
      this.fac2[i * 4 + 2] = fp.flags & 0xff;
      this.fac2[i * 4 + 3] = 0;
    }
  }
}

type Bucket = { wall: GeoBuf; glassLit: GeoBuf; glassDark: GeoBuf; facade: FacadeBuf };

class Buckets {
  private readonly map = new Map<number, Bucket>();

  private key(tier: MeshTier, x: number, z: number): number {
    const cell = tier === "detail" ? DETAIL_CELL : CHUNK;
    const cx = Math.floor((x + WORLD_HALF_X) / cell);
    const cz = Math.floor((z + WORLD_HALF_Z) / cell);
    return DETAIL_TIERS.indexOf(tier) * 1_000_000 + (cx + 8) * 1000 + (cz + 8);
  }

  at(tier: MeshTier, x: number, z: number): Bucket {
    const k = this.key(tier, x, z);
    let b = this.map.get(k);
    if (!b) {
      b = {
        wall: new GeoBuf(),
        glassLit: new GeoBuf(),
        glassDark: new GeoBuf(),
        facade: new FacadeBuf(),
      };
      this.map.set(k, b);
    }
    return b;
  }

  flush(): ParcelGeometry {
    const geos: ParcelGeo[] = [];
    let vertices = 0;
    let triangles = 0;
    for (const [k, b] of this.map) {
      const tier = DETAIL_TIERS[Math.floor(k / 1_000_000)] ?? "near";
      const rem = k % 1_000_000;
      const cell = tier === "detail" ? DETAIL_CELL : CHUNK;
      const cx = (Math.floor(rem / 1000) - 8 + 0.5) * cell - WORLD_HALF_X;
      const cz = ((rem % 1000) - 8 + 0.5) * cell - WORLD_HALF_Z;
      const radius = cell * 0.71 + ROAD_TILE * 2;
      const push = (mat: ParcelMaterial, g: GeoBuf): void => {
        if (g.nv === 0) return;
        vertices += g.nv;
        triangles += g.ni / 3;
        const rec: ParcelGeo = {
          tier,
          mat,
          cx,
          cz,
          radius,
          position: g.pos.slice(0, g.nv * 3),
          normal: g.nor.slice(0, g.nv * 3),
          color: g.col.slice(0, g.nv * 3),
          index: g.nv <= 65535 ? Uint16Array.from(g.idx.subarray(0, g.ni)) : g.idx.slice(0, g.ni),
        };
        geos.push(
          g instanceof FacadeBuf
            ? {
                ...rec,
                fuv: g.fuv.slice(0, g.nv * 2),
                facade: g.fac.slice(0, g.nv * 4),
                facade2: g.fac2.slice(0, g.nv * 4),
              }
            : rec,
        );
      };
      push("wall", b.wall);
      push("glassLit", b.glassLit);
      push("glassDark", b.glassDark);
      push("facade", b.facade);
    }
    return { geos, stats: { vertices, triangles, buffers: geos.length } };
  }
}

/** One wall of a parcel in world space: endpoints, unit along-vector, outward normal. */
type Wall = {
  readonly x0: number;
  readonly z0: number;
  readonly tx: number;
  readonly tz: number;
  readonly nx: number;
  readonly nz: number;
  readonly len: number;
  readonly blind: boolean;
  readonly front: boolean;
};

function wallsOf(p: ParcelPlan): Wall[] {
  const out: Wall[] = [];
  for (let e = 0; e < p.n; e++) {
    const j = (e + 1) % p.n;
    const x0 = p.ring[e * 2] ?? 0;
    const z0 = p.ring[e * 2 + 1] ?? 0;
    const dx = (p.ring[j * 2] ?? 0) - x0;
    const dz = (p.ring[j * 2 + 1] ?? 0) - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    const tx = dx / len;
    const tz = dz / len;
    // Positive-area ring: interior is to the LEFT (-tz, tx), so outward is (tz, -tx).
    out.push({
      x0,
      z0,
      tx,
      tz,
      nx: tz,
      nz: -tx,
      len,
      blind: p.blind[e] === 1,
      front: e === p.front,
    });
  }
  return out;
}

/** A rectangle on a wall: along [a, a+w], up [y0, y0+h], lifted `off` off the face. */
function decal(
  g: GeoBuf,
  w: Wall,
  a: number,
  width: number,
  y0: number,
  h: number,
  off: number,
  color: number,
): void {
  const ox = w.nx * off;
  const oz = w.nz * off;
  const ax = w.x0 + w.tx * a + ox;
  const az = w.z0 + w.tz * a + oz;
  const bx = w.x0 + w.tx * (a + width) + ox;
  const bz = w.z0 + w.tz * (a + width) + oz;
  g.quad(ax, y0, az, bx, y0, bz, bx, y0 + h, bz, ax, y0 + h, az, w.nx, 0, w.nz, color);
}

/** A window: frame decal under a glass decal (frame skipped when `frame` is 0). */
function windowOn(
  b: Bucket,
  w: Wall,
  a: number,
  width: number,
  y0: number,
  h: number,
  frame: number,
  frameColor: number,
  glass: number,
  lit: boolean,
): void {
  if (frame > 0)
    decal(b.wall, w, a - frame, width + frame * 2, y0 - frame, h + frame * 2, OFF, frameColor);
  decal(lit ? b.glassLit : b.glassDark, w, a, width, y0, h, frame > 0 ? OFF2 : OFF, glass);
}

/**
 * An axis-aligned box in the frame (ex, ez): centre (cx, cz), half extents,
 * from y0 to y1. Only the faces asked for.
 */
function box(
  g: GeoBuf,
  cx: number,
  cz: number,
  ex: number,
  ez: number,
  halfA: number,
  halfB: number,
  y0: number,
  y1: number,
  color: number,
  faces: { top?: boolean; bottom?: boolean; sides?: boolean },
): void {
  // Corners in the box frame: A along (ex, ez), B along (-ez, ex).
  const px = (a: number, bb: number): number => cx + a * ex - bb * ez;
  const pz = (a: number, bb: number): number => cz + a * ez + bb * ex;
  const c0x = px(-halfA, -halfB);
  const c0z = pz(-halfA, -halfB);
  const c1x = px(halfA, -halfB);
  const c1z = pz(halfA, -halfB);
  const c2x = px(halfA, halfB);
  const c2z = pz(halfA, halfB);
  const c3x = px(-halfA, halfB);
  const c3z = pz(-halfA, halfB);
  if (faces.top) g.quad(c0x, y1, c0z, c1x, y1, c1z, c2x, y1, c2z, c3x, y1, c3z, 0, 1, 0, color);
  if (faces.bottom) g.quad(c0x, y0, c0z, c1x, y0, c1z, c2x, y0, c2z, c3x, y0, c3z, 0, -1, 0, color);
  if (faces.sides) {
    g.quad(c0x, y0, c0z, c1x, y0, c1z, c1x, y1, c1z, c0x, y1, c0z, ez, 0, -ex, color);
    g.quad(c1x, y0, c1z, c2x, y0, c2z, c2x, y1, c2z, c1x, y1, c1z, ex, 0, ez, color);
    g.quad(c2x, y0, c2z, c3x, y0, c3z, c3x, y1, c3z, c2x, y1, c2z, -ez, 0, ex, color);
    g.quad(c3x, y0, c3z, c0x, y0, c0z, c0x, y1, c0z, c3x, y1, c3z, -ex, 0, -ez, color);
  }
}

/**
 * A cornice / ledge along a wall: its outward face and top, plus the underside
 * when the camera can get below it (the chase rig rides at ~7u, so a row
 * house's cornice is seen from above and a mid-rise's from below). The end
 * caps are never drawn — a 0.24u return is a pixel at any distance that
 * matters, and every wall of the city carries one of these.
 */
function ledge(
  g: GeoBuf,
  w: Wall,
  a0: number,
  a1: number,
  y0: number,
  h: number,
  depth: number,
  color: number,
  underside: boolean,
): void {
  const ax = w.x0 + w.tx * a0;
  const az = w.z0 + w.tz * a0;
  const bx = w.x0 + w.tx * a1;
  const bz = w.z0 + w.tz * a1;
  const ox = w.nx * depth;
  const oz = w.nz * depth;
  const y1 = y0 + h;
  g.quad(
    ax + ox,
    y0,
    az + oz,
    bx + ox,
    y0,
    bz + oz,
    bx + ox,
    y1,
    bz + oz,
    ax + ox,
    y1,
    az + oz,
    w.nx,
    0,
    w.nz,
    color,
  );
  g.quad(ax, y1, az, bx, y1, bz, bx + ox, y1, bz + oz, ax + ox, y1, az + oz, 0, 1, 0, color);
  if (underside) {
    g.quad(ax, y0, az, bx, y0, bz, bx + ox, y0, bz + oz, ax + ox, y0, az + oz, 0, -1, 0, color);
  }
}

/** The chase camera's eye height: a ledge above it shows its underside. */
const EYE_H = 6.5;
const STOOP_RAIL = 0x2e3134;

type Storeys = {
  readonly groundH: number;
  readonly upperH: number;
  readonly count: number;
};

function storeysOf(p: ParcelPlan): Storeys {
  const groundH = Math.max(GROUND_MIN, Math.min(p.height * 0.6, p.height / p.storeys + 0.15));
  const upper = Math.max(0, p.storeys - 1);
  const upperH = upper > 0 ? (p.height - groundH) / upper : 0;
  return { groundH, upperH, count: p.storeys };
}

function bodyTier(height: number): MeshTier {
  return height >= BIG_H ? "far" : height >= MID_H ? "mid" : "near";
}

type Ctx = {
  readonly p: ParcelPlan;
  readonly rng: Rng;
  readonly walls: readonly Wall[];
  readonly st: Storeys;
  readonly topY: number;
  readonly detail: DetailLevel;
  readonly bodyBucket: Bucket;
  readonly detailAt: (x: number, z: number) => Bucket;
  readonly colors: readonly ParcelColors[]; // per unit
  /** Per-storey lit band, rolled once so a floor lights up together. */
  readonly litFloor: readonly boolean[];
  readonly lit: (storey: number) => boolean;
};

// --- Body ---------------------------------------------------------------------

function body(
  c: Ctx,
  ringOverride?: { ring: Float32Array; n: number; walls: readonly Wall[] },
): void {
  const { p, st, topY } = c;
  const g = c.bodyBucket.wall;
  const walls = ringOverride?.walls ?? c.walls;
  const unit0 = c.colors[0];
  if (unit0 === undefined) return;
  const y0 = ringOverride ? p.seatY + st.groundH : p.footY;
  // A foundation band only where the hill exposes one; on a flat lot the wall
  // runs straight to the ground.
  const foundation = !ringOverride && p.seatY - p.footY > 0.7;
  for (const w of walls) {
    const bodyColor = w.blind ? shade(unit0.body, 0.9) : unit0.body;
    const x1 = w.x0 + w.tx * w.len;
    const z1 = w.z0 + w.tz * w.len;
    if (foundation) {
      g.quad(
        w.x0,
        y0,
        w.z0,
        x1,
        y0,
        z1,
        x1,
        p.seatY,
        z1,
        w.x0,
        p.seatY,
        w.z0,
        w.nx,
        0,
        w.nz,
        unit0.base,
      );
    }
    const yb = foundation ? p.seatY : y0;
    // Below the full detail tier the flanks and rears get no window geometry
    // (windowGrid gates them) — on the facade shader they get their windows
    // for the cost of the wall quad they already were. The street face keeps
    // its bays and frames.
    if (c.detail < 2 && !w.front && !w.blind && !ringOverride && p.kind !== "shed") {
      c.bodyBucket.facade.wall(
        w.x0,
        w.z0,
        w.tx,
        w.tz,
        w.len,
        yb,
        topY,
        w.nx,
        w.nz,
        bodyColor,
        {
          storeyH: st.upperH,
          pitch: leanPitch(p.kind) || 1.4,
          groundH: st.groundH,
          wallLen: w.len,
          storeys: st.count,
          seed: (p.seed >>> 3) & 0xff,
          flags: 0,
        },
        yb - p.seatY,
      );
      continue;
    }
    if (w.front && p.units > 1) {
      // The terrace: each unit its own colour on one continuous wall.
      const unitW = w.len / p.units;
      for (let u = 0; u < p.units; u++) {
        const col = c.colors[u]?.body ?? bodyColor;
        const ax = w.x0 + w.tx * (u * unitW);
        const az = w.z0 + w.tz * (u * unitW);
        const bx = w.x0 + w.tx * ((u + 1) * unitW);
        const bz = w.z0 + w.tz * ((u + 1) * unitW);
        g.quad(ax, yb, az, bx, yb, bz, bx, topY, bz, ax, topY, az, w.nx, 0, w.nz, col);
      }
    } else {
      g.quad(w.x0, yb, w.z0, x1, yb, z1, x1, topY, z1, w.x0, topY, w.z0, w.nx, 0, w.nz, bodyColor);
    }
  }
  // Flat roof: membrane cap behind a parapet, the parapet's inner face and lip.
  const ring = ringOverride?.ring ?? p.ring;
  const n = ringOverride?.n ?? p.n;
  const capY = topY - PARAPET;
  g.cap(ring, n, capY, 1, unit0.roof);
  const lipColor = shade(unit0.body, 0.96);
  for (const w of walls) {
    const x1 = w.x0 + w.tx * w.len;
    const z1 = w.z0 + w.tz * w.len;
    const ix0 = w.x0 - w.nx * 0.2;
    const iz0 = w.z0 - w.nz * 0.2;
    const ix1 = x1 - w.nx * 0.2;
    const iz1 = z1 - w.nz * 0.2;
    g.quad(
      ix0,
      capY,
      iz0,
      ix1,
      capY,
      iz1,
      ix1,
      topY,
      iz1,
      ix0,
      topY,
      iz0,
      -w.nx,
      0,
      -w.nz,
      lipColor,
    );
    // The lip's top: a party wall's is under the neighbour's parapet.
    if (!w.blind) {
      g.quad(w.x0, topY, w.z0, x1, topY, z1, ix1, topY, iz1, ix0, topY, iz0, 0, 1, 0, lipColor);
    }
  }
}

// --- Facade elements ------------------------------------------------------------

function cornice(c: Ctx, w: Wall, double: boolean): void {
  if (w.blind || c.detail < 1 || (!w.front && c.detail < 2)) return;
  const col = c.colors[0]?.trim ?? 0xffffff;
  const b = c.detailAt(w.x0 + (w.tx * w.len) / 2, w.z0 + (w.tz * w.len) / 2);
  const under = c.topY - c.p.seatY > EYE_H;
  ledge(b.wall, w, 0, w.len, c.topY - CORNICE_H - 0.02, CORNICE_H, CORNICE_D, col, under);
  if (double && w.front && c.detail >= 2) {
    ledge(b.wall, w, 0.1, w.len - 0.1, c.topY - CORNICE_H - 0.42, 0.14, 0.14, col, under);
  }
}

/** Windows across a wall for every upper storey, at a pitch; frames on the hero faces only. */
function windowGrid(
  c: Ctx,
  w: Wall,
  pitch: number,
  width: number,
  frame: number,
  fromStorey = 1,
): void {
  if (w.blind || c.detail < 1 || (!w.front && c.detail < 2)) return;
  const { st } = c;
  const col = c.colors[0];
  if (col === undefined) return;
  // Flanks and rears are seen obliquely, over a fence, from the next street:
  // a sparser rhythm reads the same and costs a third less.
  const p = w.front ? pitch : pitch * 1.35;
  const usable = w.len - 0.5;
  const count = Math.floor(usable / p);
  if (count < 1) return;
  const start = (w.len - count * p) / 2 + (p - width) / 2;
  const winH = st.upperH * 0.52;
  const sill = st.upperH * 0.26;
  for (let s = fromStorey; s < st.count; s++) {
    const y0 = c.p.seatY + st.groundH + (s - 1) * st.upperH + sill;
    for (let k = 0; k < count; k++) {
      const a = start + k * p;
      const b = c.detailAt(w.x0 + w.tx * a, w.z0 + w.tz * a);
      windowOn(b, w, a, width, y0, winH, frame, col.trim, col.glass, c.lit(s));
    }
  }
}

/** One strip per storey per face — the tower's curtain wall / ribbon windows. */
function windowStrips(
  c: Ctx,
  w: Wall,
  fromStorey: number,
  toStorey: number,
  y0Base: number,
  storeyH: number,
  inset = 0.3,
): void {
  if (w.blind || c.detail < 1 || w.len < inset * 2 + 0.6) return;
  const col = c.colors[0];
  if (col === undefined) return;
  const stripH = storeyH * 0.5;
  const sill = storeyH * 0.28;
  for (let s = fromStorey; s < toStorey; s++) {
    const y0 = y0Base + (s - fromStorey) * storeyH + sill;
    const mid = w.len / 2;
    const b = c.detailAt(w.x0 + w.tx * mid, w.z0 + w.tz * mid);
    decal(
      c.lit(s) ? b.glassLit : b.glassDark,
      w,
      inset,
      w.len - inset * 2,
      y0,
      stripH,
      OFF,
      col.glass,
    );
  }
}

/** The SF bay: three faces stacked from the first floor to just under the cornice, a window on each per storey. */
function bay(c: Ctx, w: Wall, ac: number, bw: number, colors: ParcelColors): void {
  const { p, st } = c;
  const y0 = p.seatY + st.groundH;
  const y1 = c.topY - CORNICE_H - 0.5;
  if (y1 - y0 < 0.8) return;
  const b = c.detailAt(w.x0 + w.tx * ac, w.z0 + w.tz * ac);
  const g = b.wall;
  const d = BAY_D;
  // Wall points (left/right of the bay footprint) and the two front corners.
  const wlx = w.x0 + w.tx * (ac - bw / 2 - d);
  const wlz = w.z0 + w.tz * (ac - bw / 2 - d);
  const wrx = w.x0 + w.tx * (ac + bw / 2 + d);
  const wrz = w.z0 + w.tz * (ac + bw / 2 + d);
  const flx = w.x0 + w.tx * (ac - bw / 2) + w.nx * d;
  const flz = w.z0 + w.tz * (ac - bw / 2) + w.nz * d;
  const frx = w.x0 + w.tx * (ac + bw / 2) + w.nx * d;
  const frz = w.z0 + w.tz * (ac + bw / 2) + w.nz * d;
  const bodyCol = colors.body;
  // Left angled face, front, right angled face — outward normals from the wall normal turned ±45°.
  const ln = { x: (w.nx - w.tx) * Math.SQRT1_2, z: (w.nz - w.tz) * Math.SQRT1_2 };
  const rn = { x: (w.nx + w.tx) * Math.SQRT1_2, z: (w.nz + w.tz) * Math.SQRT1_2 };
  g.quad(wlx, y0, wlz, flx, y0, flz, flx, y1, flz, wlx, y1, wlz, ln.x, 0, ln.z, bodyCol);
  g.quad(flx, y0, flz, frx, y0, frz, frx, y1, frz, flx, y1, flz, w.nx, 0, w.nz, bodyCol);
  g.quad(frx, y0, frz, wrx, y0, wrz, wrx, y1, wrz, frx, y1, frz, rn.x, 0, rn.z, bodyCol);
  g.quad(wlx, y1, wlz, flx, y1, flz, frx, y1, frz, wrx, y1, wrz, 0, 1, 0, colors.trim);
  // The bracketed base the bay stands on, and the cap it wears: a skirt
  // under the footprint (sides only — its underside faces the stoop) and a
  // lip proud of the top ribbon, two-sided so the chase cam sees it from the
  // street. These are what separate a bay from a box glued to a wall.
  {
    const bcx = w.x0 + w.tx * ac + w.nx * (d / 2);
    const bcz = w.z0 + w.tz * ac + w.nz * (d / 2);
    box(g, bcx, bcz, w.tx, w.tz, bw / 2 + d * 0.7, d / 2 + 0.04, y0 - 0.32, y0, colors.trim, {
      sides: true,
    });
    const o = 0.12;
    const yl = y1 + 0.02;
    const lx0 = wlx - w.tx * o;
    const lz0 = wlz - w.tz * o;
    const lx1 = flx + w.nx * o - w.tx * o;
    const lz1 = flz + w.nz * o - w.tz * o;
    const lx2 = frx + w.nx * o + w.tx * o;
    const lz2 = frz + w.nz * o + w.tz * o;
    const lx3 = wrx + w.tx * o;
    const lz3 = wrz + w.tz * o;
    g.quad(lx0, yl, lz0, lx1, yl, lz1, lx2, yl, lz2, lx3, yl, lz3, 0, 1, 0, colors.trim);
    g.quad(
      lx0,
      yl - 0.06,
      lz0,
      lx1,
      yl - 0.06,
      lz1,
      lx2,
      yl - 0.06,
      lz2,
      lx3,
      yl - 0.06,
      lz3,
      0,
      -1,
      0,
      colors.trim,
    );
  }
  // Trim edge along the top of the bay, the ribbon a painted lady wears.
  g.quad(
    wlx,
    y1 - 0.14,
    wlz,
    flx,
    y1 - 0.14,
    flz,
    flx,
    y1,
    flz,
    wlx,
    y1,
    wlz,
    ln.x,
    0,
    ln.z,
    colors.trim,
  );
  g.quad(
    flx,
    y1 - 0.14,
    flz,
    frx,
    y1 - 0.14,
    frz,
    frx,
    y1,
    frz,
    flx,
    y1,
    flz,
    w.nx,
    0,
    w.nz,
    colors.trim,
  );
  g.quad(
    frx,
    y1 - 0.14,
    frz,
    wrx,
    y1 - 0.14,
    wrz,
    wrx,
    y1,
    wrz,
    frx,
    y1,
    frz,
    rn.x,
    0,
    rn.z,
    colors.trim,
  );
  // Windows: the three bay faces as pseudo-walls.
  const sideLen = d * Math.SQRT2;
  const faces: Wall[] = [
    {
      x0: wlx,
      z0: wlz,
      tx: (flx - wlx) / sideLen,
      tz: (flz - wlz) / sideLen,
      nx: ln.x,
      nz: ln.z,
      len: sideLen,
      blind: false,
      front: false,
    },
    {
      x0: flx,
      z0: flz,
      tx: w.tx,
      tz: w.tz,
      nx: w.nx,
      nz: w.nz,
      len: bw,
      blind: false,
      front: false,
    },
    {
      x0: frx,
      z0: frz,
      tx: (wrx - frx) / sideLen,
      tz: (wrz - frz) / sideLen,
      nx: rn.x,
      nz: rn.z,
      len: sideLen,
      blind: false,
      front: false,
    },
  ];
  const winH = st.upperH * 0.55;
  const sill = st.upperH * 0.24;
  for (let s = 1; s < st.count; s++) {
    const wy = p.seatY + st.groundH + (s - 1) * st.upperH + sill;
    if (wy + winH > y1 - 0.2) break;
    const lit = c.lit(s);
    for (const f of faces) {
      const ww = f.len - 0.24;
      if (ww < 0.2) continue;
      windowOn(b, f, 0.12, ww, wy, winH, c.detail >= 2 ? 0.05 : 0, colors.trim, colors.glass, lit);
    }
  }
}

/** Garage door + entry door (+ stoop) on one terrace unit's ground floor. */
function groundResidential(
  c: Ctx,
  w: Wall,
  a0: number,
  unitW: number,
  colors: ParcelColors,
  wideGarage: boolean,
): void {
  const { p, st } = c;
  const b = c.detailAt(w.x0 + w.tx * (a0 + unitW / 2), w.z0 + w.tz * (a0 + unitW / 2));
  const y0 = p.seatY;
  const garageW = Math.min(wideGarage ? 1.7 : 1.25, unitW * (wideGarage ? 0.58 : 0.5));
  const garageH = Math.min(st.groundH - 0.32, 1.35);
  const doorW = 0.5;
  const doorH = Math.min(st.groundH - 0.3, 1.15);
  const gap = 0.14;
  const total = garageW + gap + doorW;
  if (total > unitW - 0.3) {
    // Too narrow for both: a door only.
    decal(b.wall, w, a0 + (unitW - doorW) / 2, doorW, y0, doorH, OFF, colors.door);
    return;
  }
  const a = a0 + (unitW - total) / 2;
  decal(b.wall, w, a, garageW, y0, garageH, OFF, colors.garage);
  // Header over the garage, and the panel line — the two strokes that make a
  // grey rectangle read as a roller door.
  decal(b.wall, w, a - 0.06, garageW + 0.12, y0 + garageH, 0.12, OFF, colors.trim);
  decal(
    b.wall,
    w,
    a + 0.06,
    garageW - 0.12,
    y0 + garageH * 0.48,
    0.05,
    OFF2,
    shade(colors.garage, 0.8),
  );
  if (c.detail >= 2) {
    decal(
      b.wall,
      w,
      a + 0.06,
      garageW - 0.12,
      y0 + garageH * 0.74,
      0.05,
      OFF2,
      shade(colors.garage, 0.8),
    );
  }
  const da = a + garageW + gap;
  decal(b.wall, w, da, doorW, y0, doorH, OFF, colors.door);
  decal(b.wall, w, da - 0.05, doorW + 0.1, y0 + doorH, 0.1, OFF, colors.trim);
  if (c.detail >= 2 && st.groundH > 1.7) {
    // Transom over the door.
    decal(b.glassDark, w, da + 0.06, doorW - 0.12, y0 + doorH + 0.14, 0.22, OFF, colors.glass);
    // Stoop: one chunky step at the door.
    const sx = w.x0 + w.tx * (da + doorW / 2) + w.nx * 0.28;
    const sz = w.z0 + w.tz * (da + doorW / 2) + w.nz * 0.28;
    box(b.wall, sx, sz, w.tx, w.tz, doorW / 2 + 0.12, 0.28, y0 - 0.05, y0 + 0.22, colors.trim, {
      top: true,
      sides: true,
    });
    // Iron rail up the garage side of the stoop.
    const rx = w.x0 + w.tx * (da - 0.04) + w.nx * 0.28;
    const rz = w.z0 + w.tz * (da - 0.04) + w.nz * 0.28;
    box(b.wall, rx, rz, w.tx, w.tz, 0.025, 0.26, y0 + 0.22, y0 + 0.92, STOOP_RAIL, { sides: true });
  }
}

function storefront(
  c: Ctx,
  w: Wall,
  a0: number,
  unitW: number,
  colors: ParcelColors,
  awning: boolean,
): void {
  const { p, st } = c;
  const b = c.detailAt(w.x0 + w.tx * (a0 + unitW / 2), w.z0 + w.tz * (a0 + unitW / 2));
  const margin = 0.2;
  const glassW = unitW - margin * 2;
  if (glassW < 0.6) return;
  const signH = 0.34;
  const glassY0 = p.seatY + 0.14;
  const glassH = st.groundH - 0.14 - signH - 0.12;
  if (glassH < 0.5) return;
  decal(b.glassLit, w, a0 + margin, glassW, glassY0, glassH, OFF, colors.glass);
  // Mullions: two verticals so the glass reads as a shopfront, not a hole.
  const mullion = shade(colors.body, 0.55);
  for (let k = 1; k <= 2; k++) {
    decal(b.wall, w, a0 + margin + (glassW * k) / 3 - 0.03, 0.06, glassY0, glassH, OFF2, mullion);
  }
  // Sign band.
  decal(
    b.wall,
    w,
    a0 + margin - 0.06,
    glassW + 0.12,
    glassY0 + glassH + 0.06,
    signH,
    OFF,
    shade(colors.awning, 0.85),
  );
  if (awning && c.detail >= 2) {
    const ay = glassY0 + glassH + 0.02;
    const cx = w.x0 + w.tx * (a0 + unitW / 2) + w.nx * 0.42;
    const cz = w.z0 + w.tz * (a0 + unitW / 2) + w.nz * 0.42;
    box(b.wall, cx, cz, w.tx, w.tz, glassW / 2 - 0.05, 0.42, ay - 0.1, ay, colors.awning, {
      top: true,
      sides: true,
    });
  }
}

function roofPlant(c: Ctx, count: number, bulkhead: boolean): void {
  if (c.detail < 2) return;
  const { p, rng } = c;
  const col = c.colors[0];
  if (col === undefined) return;
  const o = p.obb;
  const b = c.detailAt(o.cx, o.cz);
  const capY = c.topY - PARAPET;
  const spot = (fa: number, fb: number): readonly [number, number] => [
    o.cx + fa * o.halfA * o.ex - fb * o.halfB * o.ez,
    o.cz + fa * o.halfA * o.ez + fb * o.halfB * o.ex,
  ];
  if (bulkhead && o.halfA > 2.2 && o.halfB > 2.2) {
    const [bx, bz] = spot(rng.range(-0.4, 0.4), rng.range(-0.4, 0.4));
    box(
      b.wall,
      bx,
      bz,
      o.ex,
      o.ez,
      rng.range(0.8, 1.2),
      rng.range(0.7, 1.0),
      capY,
      capY + rng.range(1.0, 1.5),
      shade(col.roof, 0.82),
      {
        top: true,
        sides: true,
      },
    );
  }
  for (let k = 0; k < count; k++) {
    if (o.halfA < 1.6 || o.halfB < 1.6) break;
    const [ax, az] = spot(rng.range(-0.6, 0.6), rng.range(-0.6, 0.6));
    const s = rng.range(0.3, 0.5);
    box(b.wall, ax, az, o.ex, o.ez, s, s, capY, capY + s * 1.4, 0xc4c8cb, {
      top: true,
      sides: true,
    });
  }
}

// --- Kinds ----------------------------------------------------------------------

function buildRowhouse(c: Ctx, stucco: boolean): void {
  const { p, st, rng } = c;
  body(c);
  for (const w of c.walls) {
    if (w.front) {
      const unitW = w.len / p.units;
      for (let u = 0; u < p.units; u++) {
        const colors = c.colors[u] ?? c.colors[0];
        if (colors === undefined) continue;
        const a0 = u * unitW;
        if (c.detail >= 1) groundResidential(c, w, a0, unitW, colors, stucco);
        if (st.count < 2) continue;
        if (!stucco && unitW >= 1.5 && c.detail >= 2) {
          bay(c, w, a0 + unitW / 2, Math.min(1.5, Math.max(0.8, unitW * 0.5)), colors);
        } else if (c.detail >= 1) {
          // Flat front: one wide band per storey (stucco), or a pair of sashes.
          const b = c.detailAt(w.x0 + w.tx * (a0 + unitW / 2), w.z0 + w.tz * (a0 + unitW / 2));
          const winH = st.upperH * (stucco ? 0.48 : 0.55);
          const sill = st.upperH * 0.26;
          for (let s = 1; s < st.count; s++) {
            const y0 = p.seatY + st.groundH + (s - 1) * st.upperH + sill;
            const lit = c.lit(s);
            if (stucco || unitW < 1.2) {
              const ww = Math.min(unitW * 0.62, 2.2);
              windowOn(
                b,
                w,
                a0 + (unitW - ww) / 2,
                ww,
                y0,
                winH,
                c.detail >= 2 ? 0.06 : 0,
                colors.trim,
                colors.glass,
                lit,
              );
            } else {
              const ww = Math.min(0.68, unitW * 0.32);
              windowOn(
                b,
                w,
                a0 + unitW * 0.28 - ww / 2,
                ww,
                y0,
                winH,
                0.06,
                colors.trim,
                colors.glass,
                lit,
              );
              windowOn(
                b,
                w,
                a0 + unitW * 0.72 - ww / 2,
                ww,
                y0,
                winH,
                0.06,
                colors.trim,
                colors.glass,
                lit,
              );
            }
          }
        }
      }
      cornice(c, w, !stucco);
    } else {
      // Rear and exposed flanks: plain sashes, no frames, no ledges.
      windowGrid(c, w, 1.25 + rng.range(0, 0.25), 0.62, 0);
      if (!w.blind && st.count >= 2) cornice(c, w, false);
    }
  }
  roofClutter(c);
}

/** A skylight and the odd vent on a residential roof — the aerial reads the roof plane first. */
function roofClutter(c: Ctx): void {
  if (c.detail < 2) return;
  const { p, rng } = c;
  const col = c.colors[0];
  if (col === undefined) return;
  const o = p.obb;
  if (o.halfA < 1.4 || o.halfB < 1.4) return;
  const g = c.detailAt(o.cx, o.cz).wall;
  const capY = c.topY - PARAPET;
  const spot = (fa: number, fb: number): readonly [number, number] => [
    o.cx + fa * o.halfA * o.ex - fb * o.halfB * o.ez,
    o.cz + fa * o.halfA * o.ez + fb * o.halfB * o.ex,
  ];
  if (rng.chance(0.55)) {
    const [sx, sz] = spot(rng.range(-0.45, 0.45), rng.range(-0.45, 0.45));
    const hw = 0.45;
    const hd = 0.3;
    const y = capY + 0.03;
    const ax = o.ex * hw;
    const az = o.ez * hw;
    const bx = -o.ez * hd;
    const bz = o.ex * hd;
    g.quad(
      sx - ax - bx,
      y,
      sz - az - bz,
      sx + ax - bx,
      y,
      sz + az - bz,
      sx + ax + bx,
      y,
      sz + az + bz,
      sx - ax + bx,
      y,
      sz - az + bz,
      0,
      1,
      0,
      col.glass,
    );
  }
  if (rng.chance(0.3)) {
    const [vx, vz] = spot(rng.range(-0.5, 0.5), rng.range(-0.5, 0.5));
    const sz = rng.range(0.2, 0.3);
    box(g, vx, vz, o.ex, o.ez, sz, sz, capY, capY + sz * 2.2, 0xb9bcbf, { top: true, sides: true });
  }
}

function buildMidrise(c: Ctx): void {
  const { p, rng } = c;
  body(c);
  // Big and few: a kart-racer window is a third of the storey wide.
  const pitch = 1.45 + rng.range(0, 0.35);
  for (const w of c.walls) {
    if (w.front) {
      const unitW = w.len / p.units;
      for (let u = 0; u < p.units; u++) {
        const colors = c.colors[u] ?? c.colors[0];
        if (colors === undefined) continue;
        storefront(c, w, u * unitW, unitW, colors, rng.chance(0.7));
      }
      windowGrid(c, w, pitch, 0.82, c.detail >= 2 ? 0.05 : 0);
    } else {
      windowGrid(c, w, pitch, 0.82, 0);
    }
    cornice(c, w, false);
  }
  roofPlant(c, rng.chance(0.5) ? 2 : 1, rng.chance(0.55));
}

/**
 * A tower's ground floor is shops, not a lobby band: SF keeps retail under
 * its glass, and a street of blank podiums is what made downtown read as a
 * model. Blind and short faces keep the strip.
 */
function podiumShops(c: Ctx, w: Wall): void {
  const { p, st } = c;
  const col = c.colors[0];
  if (col === undefined) return;
  if (w.blind || w.len < 3.2 || c.detail < 1) {
    windowStrips(c, w, 0, 1, p.seatY + 0.1, st.groundH - 0.2, 0.4);
    return;
  }
  const units = Math.max(1, Math.round(w.len / 4.5));
  const unitW = w.len / units;
  for (let u = 0; u < units; u++) storefront(c, w, u * unitW, unitW, col, c.rng.chance(0.6));
}

function buildTower(c: Ctx): void {
  const { p, st } = c;
  const col = c.colors[0];
  if (col === undefined) return;
  const o = p.obb;
  const podiumStoreys = Math.min(3, 1 + Math.floor(st.count * 0.12));
  const setback = p.rect && o.halfA > 3 && o.halfB > 3 && st.count >= 10;
  if (setback) {
    // Podium at the lot line to the podium top, then the inset shaft on top —
    // the continuous street wall SF towers keep under their glass.
    const podiumTop = p.seatY + st.groundH + (podiumStoreys - 1) * st.upperH;
    const savedTop = c.topY;
    const podium: Ctx = { ...c, topY: podiumTop };
    body(podium);
    for (const w of c.walls) {
      podiumShops(podium, w);
      windowGrid(podium, w, 1.15, 0.6, 0);
      cornice(podium, w, false);
    }
    const inset = 0.8;
    const ring = new Float32Array(8);
    const px = (a: number, b: number): number =>
      o.cx + a * o.halfA * inset * o.ex - b * o.halfB * inset * o.ez;
    const pz = (a: number, b: number): number =>
      o.cz + a * o.halfA * inset * o.ez + b * o.halfB * inset * o.ex;
    const corners: readonly (readonly [number, number])[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    corners.forEach(([a, b], i) => {
      ring[i * 2] = px(a, b);
      ring[i * 2 + 1] = pz(a, b);
    });
    // Orient positive like every plan ring, then build the shaft as its own body.
    const shaftPlan: ParcelPlan = {
      ...p,
      ring,
      n: 4,
      blind: new Uint8Array(4),
      front: -1,
      seatY: podiumTop - st.groundH,
      footY: podiumTop,
    };
    const shaftWalls = wallsOf(shaftPlan);
    const shaft: Ctx = { ...c, topY: savedTop, walls: shaftWalls };
    body(shaft, { ring, n: 4, walls: shaftWalls });
    for (const w of shaftWalls)
      windowStrips(shaft, w, podiumStoreys, st.count, podiumTop, st.upperH);
    crown(shaft, ring, o, inset);
  } else {
    body(c);
    for (const w of c.walls) {
      podiumShops(c, w);
      windowStrips(c, w, 1, st.count, p.seatY + st.groundH, st.upperH);
    }
    crown(c, p.ring, o, 1);
  }
  roofPlant(c, 1, false);
}

function crown(
  c: Ctx,
  _ring: Float32Array,
  o: { cx: number; cz: number; ex: number; ez: number; halfA: number; halfB: number },
  inset: number,
): void {
  if (c.detail < 1) return;
  const col = c.colors[0];
  if (col === undefined) return;
  const b = c.detailAt(o.cx, o.cz);
  const taper = c.p.height >= 40 ? 0.58 : 0.7;
  const crownH = Math.min(2.4, c.p.height * 0.06);
  box(
    b.wall,
    o.cx,
    o.cz,
    o.ex,
    o.ez,
    o.halfA * inset * taper,
    o.halfB * inset * taper,
    c.topY - 0.02,
    c.topY + crownH,
    col.trim,
    {
      top: true,
      sides: true,
    },
  );
}

function buildWarehouse(c: Ctx): void {
  const { p, st, rng } = c;
  const col = c.colors[0];
  if (col === undefined) return;
  body(c);
  for (const w of c.walls) {
    if (w.blind) continue;
    if (w.front && c.detail >= 1) {
      const b = c.detailAt(w.x0 + (w.tx * w.len) / 2, w.z0 + (w.tz * w.len) / 2);
      const doorW = 1.7;
      const doorH = Math.min(st.groundH - 0.25, 1.6);
      const doors = Math.max(1, Math.min(4, Math.floor((w.len - 0.6) / (doorW + 0.9))));
      const span = doors * doorW + (doors - 1) * 0.9;
      const a0 = (w.len - span) / 2;
      for (let k = 0; k < doors; k++) {
        const a = a0 + k * (doorW + 0.9);
        decal(b.wall, w, a, doorW, p.seatY, doorH, OFF, col.garage);
        decal(b.wall, w, a - 0.06, doorW + 0.12, p.seatY + doorH, 0.12, OFF, col.trim);
      }
    }
    // Clerestory band under the roof line on every open face.
    if (c.detail >= 1 && w.len > 2.5) {
      const b = c.detailAt(w.x0 + (w.tx * w.len) / 2, w.z0 + (w.tz * w.len) / 2);
      const h = Math.min(0.5, p.height * 0.14);
      decal(
        c.lit(1) ? b.glassLit : b.glassDark,
        w,
        0.4,
        w.len - 0.8,
        c.topY - PARAPET - 0.2 - h,
        h,
        OFF,
        col.glass,
      );
    }
  }
  roofPlant(c, rng.chance(0.6) ? 2 : 1, false);
}

function buildShed(c: Ctx): void {
  const { p, st } = c;
  const col = c.colors[0];
  if (col === undefined) return;
  body(c);
  if (c.detail < 1) return;
  for (const w of c.walls) {
    if (!w.front || w.len < 1.2) continue;
    const b = c.detailAt(w.x0 + (w.tx * w.len) / 2, w.z0 + (w.tz * w.len) / 2);
    const doorW = Math.min(1.2, w.len * 0.5);
    decal(
      b.wall,
      w,
      (w.len - doorW) / 2,
      doorW,
      p.seatY,
      Math.min(st.groundH - 0.25, 1.3),
      OFF,
      col.garage,
    );
  }
}

// --- Entry ------------------------------------------------------------------------

/**
 * Geometry for every planned parcel, bucketed for the streamer. Deterministic
 * per parcel (its own seeded rng), so a plan always produces the same city.
 * `onBreathe` is called every few hundred parcels for the caller to yield.
 */
export async function buildParcelGeometry(
  plans: readonly ParcelPlan[],
  detail: DetailLevel,
  onBreathe?: () => Promise<void>,
  lots: readonly ParcelLot[] = [],
): Promise<ParcelGeometry> {
  const buckets = new Buckets();
  let k = 0;
  for (const p of plans) {
    if (onBreathe && ++k % 400 === 0) await onBreathe();
    buildOne(buckets, p, detail);
  }
  for (const lot of lots) buildLot(buckets, lot);
  return buckets.flush();
}

// --- Surface lots ------------------------------------------------------------
// A surveyed parcel with no building on it: asphalt draped on the ground with
// bay lines, so a block face reads as parking rather than as a gap. Cars are
// the build pass's (parcel-build.ts parkOnLots) — they are physics bodies.
const LOT_ASPHALT = 0x4b5058;
const LOT_LINE = 0xd6dad6;
const LOT_LIFT = 0.06;
const BAY_PITCH = 2.2;
const BAY_DEPTH = 2.6;

function buildLot(buckets: Buckets, lot: ParcelLot): void {
  const g = buckets.at("near", lot.obb.cx, lot.obb.cz).wall;
  g.capDraped(lot.ring, lot.n, lot.ys, LOT_LIFT, LOT_ASPHALT);
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  for (let i = 0; i < lot.n; i++) {
    const y = lot.ys[i] ?? 0;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
    sum += y;
  }
  // Bay lines are flat quads; on a lot that falls more than a kerb they would
  // float or bury, and a sloped lot in SF has no bays painted anyway.
  if (hi - lo > 1.2) return;
  const y = sum / lot.n + LOT_LIFT + 0.02;
  const o = lot.obb;
  const long = o.halfA >= o.halfB;
  const lx = long ? o.ex : -o.ez;
  const lz = long ? o.ez : o.ex;
  const sx = long ? -o.ez : o.ex;
  const sz = long ? o.ex : o.ez;
  const halfL = long ? o.halfA : o.halfB;
  const halfS = long ? o.halfB : o.halfA;
  if (halfS * 2 < 3.4) return;
  const rows: number[] = halfS * 2 >= 5.6 ? [-1, 1] : [halfS > 0 ? -1 : 1];
  for (const side of rows) {
    const edge = side * (halfS - 0.5);
    const inner = side * (halfS - 0.5 - Math.min(BAY_DEPTH, halfS - 0.6));
    for (let a = -halfL + 1.2; a <= halfL - 1.2; a += BAY_PITCH) {
      const ax = o.cx + lx * a + sx * edge;
      const az = o.cz + lz * a + sz * edge;
      const bx = o.cx + lx * a + sx * inner;
      const bz = o.cz + lz * a + sz * inner;
      if (!pointInRing(lot.ring, lot.n, ax, az) || !pointInRing(lot.ring, lot.n, bx, bz)) continue;
      const wx = lx * 0.05;
      const wz = lz * 0.05;
      g.quad(
        ax - wx,
        y,
        az - wz,
        ax + wx,
        y,
        az + wz,
        bx + wx,
        y,
        bz + wz,
        bx - wx,
        y,
        bz - wz,
        0,
        1,
        0,
        LOT_LINE,
      );
    }
  }
}

// --- The lean fabric --------------------------------------------------------
// Every parcel outside the downtown survey: walls on the facade shader, a
// roof cap, nothing else. ~5 vertices per ring vertex against ~250 for a
// survey parcel, and the shader draws what the survey gets as geometry.

/** Window pitch per kind, in world units: the stucco box's wide band, the Victorian's sashes. */
function leanPitch(kind: ParcelKind): number {
  switch (kind) {
    case "stucco":
      return 2.0;
    case "rowhouse":
      return 1.25;
    case "midrise":
      return 1.5;
    case "tower":
      return 1.3;
    case "warehouse":
      return 2.6;
    case "shed":
      return 0;
  }
}

function leanFlags(kind: ParcelKind): number {
  switch (kind) {
    case "stucco":
    case "rowhouse":
      return FACADE_FLAG_HOUSE;
    case "midrise":
    case "tower":
      return FACADE_FLAG_SHOP;
    case "warehouse":
    case "shed":
      return FACADE_FLAG_SHED;
  }
}

function buildLean(buckets: Buckets, p: ParcelPlan): void {
  const rng = new Rng(p.seed);
  const walls = wallsOf(p);
  if (walls.length < 3) return;
  const st = storeysOf(p);
  const topY = p.seatY + p.height;
  const b = buckets.at(bodyTier(p.height), p.obb.cx, p.obb.cz);
  const colors = colorsFor(p.kind, p.character, p.blockHash, rng.next());
  const unitColors: number[] = [colors.body];
  for (let u = 1; u < p.units; u++) {
    unitColors.push(colorsFor(p.kind, p.character, p.blockHash, rng.next()).body);
  }
  const pitch = leanPitch(p.kind);
  const flags = leanFlags(p.kind);
  const seedByte = (p.seed >>> 3) & 0xff;
  const y0 = p.footY;
  for (const w of walls) {
    const blank = w.blind || pitch === 0;
    const fp: FacadeParams = {
      storeyH: st.upperH,
      pitch: pitch || 1,
      groundH: st.groundH,
      wallLen: w.len,
      storeys: st.count,
      seed: seedByte,
      flags: blank ? FACADE_FLAG_BLANK | (w.blind ? 0 : flags) : w.front ? flags : 0,
    };
    if (w.front && p.units > 1) {
      // The terrace: each unit its own colour, its own door.
      const unitW = w.len / p.units;
      for (let u = 0; u < p.units; u++) {
        b.facade.wall(
          w.x0 + w.tx * (u * unitW),
          w.z0 + w.tz * (u * unitW),
          w.tx,
          w.tz,
          unitW,
          y0,
          topY,
          w.nx,
          w.nz,
          unitColors[u] ?? colors.body,
          { ...fp, wallLen: unitW, seed: (seedByte + u * 37) & 0xff },
          y0 - p.seatY,
        );
      }
    } else {
      b.facade.wall(
        w.x0,
        w.z0,
        w.tx,
        w.tz,
        w.len,
        y0,
        topY,
        w.nx,
        w.nz,
        w.blind ? shade(colors.body, 0.9) : colors.body,
        fp,
        y0 - p.seatY,
      );
    }
  }
  b.wall.cap(p.ring, p.n, topY, 1, colors.roof);
}

function buildOne(buckets: Buckets, p: ParcelPlan, detail: DetailLevel): void {
  if (!p.hero) {
    buildLean(buckets, p);
    return;
  }
  const rng = new Rng(p.seed);
  const walls = wallsOf(p);
  if (walls.length < 3) return;
  const st = storeysOf(p);
  const topY = p.seatY + p.height;
  const colors: ParcelColors[] = [];
  for (let u = 0; u < p.units; u++) {
    colors.push(colorsFor(p.kind, p.character, p.blockHash, rng.next()));
  }
  // Night: a third of buildings are dark, the rest light up by floor band —
  // office floors with the cleaners in, a dark storey between.
  const share = rng.chance(0.33) ? 0 : litShare(p.kind) * 1.5;
  const litFloor: boolean[] = [];
  for (let s = 0; s <= st.count; s++) litFloor.push(rng.chance(share > 0 ? 0.55 : 0));
  const perWindow = share > 0 ? Math.min(1, share * 1.4) : 0;
  const lit = (storey: number): boolean => litFloor[storey] === true && rng.chance(perWindow);
  const bodyTierName = bodyTier(p.height);
  const bodyBucket = buckets.at(bodyTierName, p.obb.cx, p.obb.cz);
  const c: Ctx = {
    p,
    rng,
    walls,
    st,
    topY,
    detail,
    bodyBucket,
    detailAt: (x, z) => buckets.at("detail", x, z),
    colors,
    litFloor,
    lit,
  };
  const kind: ParcelKind = p.kind;
  switch (kind) {
    case "rowhouse":
      buildRowhouse(c, false);
      break;
    case "stucco":
      buildRowhouse(c, true);
      break;
    case "midrise":
      buildMidrise(c);
      break;
    case "tower":
      buildTower(c);
      break;
    case "warehouse":
      buildWarehouse(c);
      break;
    case "shed":
      buildShed(c);
      break;
  }
}

/** Cull distance of a tier, in world units (city.ts bands). */
export function tierDistance(
  tier: MeshTier,
  imposter: number,
  midImposter: number,
  detail: number,
): number {
  switch (tier) {
    case "far":
      return imposter;
    case "mid":
      return midImposter;
    case "near":
      return DRAW_DISTANCE;
    case "detail":
      return detail;
  }
}
