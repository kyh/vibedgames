import { CHUNK, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import { drawDistance } from "../render/quality";
import { Rng } from "../shared/rng";
import { pointInRing } from "./parcel-plan";
import type { ParcelLot, ParcelPlan } from "./parcel-plan";
import {
  FACADE_FLAG_BLANK,
  FACADE_FLAG_BRICK,
  FACADE_FLAG_HOUSE,
  FACADE_FLAG_SHED,
  FACADE_FLAG_SHOP,
  FACADE_FLAG_SIDING,
  FacadeBuf,
  GeoBuf,
  SignBuf,
} from "./parcel-geo-buf";
import type { FacadeParams } from "./parcel-geo-buf";
import { shopSignIndex, SIGN_LABEL_ASPECT } from "./parcel-signs";
import { roofVariantOf } from "./parcel-roofs";
import type { RoofVariant } from "./parcel-roofs";
import { distantFootprint } from "./parcel-lod";
import {
  colorsFor,
  GROUND_MIN,
  hasFireEscape,
  litShare,
  shade,
  towerFacadeFor,
} from "./parcel-style";
import type { ParcelColors, ParcelKind, TowerFacade } from "./parcel-style";

export { FACADE_SCALE, FUV_V_BIAS } from "./parcel-geo-buf";

/** 0 = distant shader silhouettes; 1 = street openings/cornices; 2 = full dimensional fronts. */
export type DetailLevel = 0 | 1 | 2;

export type ParcelMaterial = "wall" | "glassLit" | "glassDark" | "facade" | "sign";

/** Cull band of a buffer: bodies by silhouette height, detail on the near band. */
export type MeshTier = "far" | "mid" | "near" | "detail";

type ParcelPositions =
  | { readonly encoding: "float"; readonly position: Float32Array }
  | {
      readonly encoding: "quantized";
      readonly position: Uint16Array;
      readonly origin: readonly [number, number, number];
      /** Uniform scale preserves the original packed normals. */
      readonly scale: number;
    };

export type ParcelGeo = ParcelPositions & {
  readonly tier: MeshTier;
  readonly mat: ParcelMaterial;
  readonly cx: number;
  readonly cz: number;
  readonly radius: number;
  readonly normal: Int8Array;
  readonly color: Uint8Array;
  readonly index: Uint16Array | Uint32Array;
  /** Facade-shader walls only (parcel-build.ts FACADE): see FacadeBuf. */
  readonly fuv?: Uint16Array;
  readonly facade?: Uint16Array;
  readonly facade2?: Uint8Array;
  /** Normalized shared-atlas coordinates for shop lettering only. */
  readonly uv?: Uint16Array;
};

export interface ParcelGeoStats {
  readonly vertices: number;
  readonly triangles: number;
  readonly buffers: number;
}

export interface ParcelGeometry {
  readonly geos: readonly ParcelGeo[];
  readonly stats: ParcelGeoStats;
}

const OFF = 0.045;
const OFF2 = 0.07;
const PARAPET = 0.24;
const CORNICE_H = 0.3;
const CORNICE_D = 0.24;
const BAY_D = 0.48;
const DETAIL_CELL = 160;
const BIG_H = 13;
const MID_H = 5;

const DETAIL_TIERS: readonly MeshTier[] = ["far", "mid", "near", "detail"];

interface Bucket {
  wall: GeoBuf;
  glassLit: GeoBuf;
  glassDark: GeoBuf;
  facade: FacadeBuf;
  sign: SignBuf;
}

const storePositions: (
  source: Float32Array,
  count: number,
  quantize: boolean,
) => ParcelPositions = (source, count, quantize) => {
  if (!quantize) {
    return { encoding: "float", position: source.slice(0, count * 3) };
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < count * 3; i += 3) {
    const x = source[i] ?? 0;
    const y = source[i + 1] ?? 0;
    const z = source[i + 2] ?? 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  const scale = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
  const position = new Uint16Array(count * 3);

  for (let i = 0; i < count * 3; i += 3) {
    position[i] = Math.round((((source[i] ?? 0) - minX) / scale) * 65_535);
    position[i + 1] = Math.round((((source[i + 1] ?? 0) - minY) / scale) * 65_535);
    position[i + 2] = Math.round((((source[i + 2] ?? 0) - minZ) / scale) * 65_535);
  }

  return { encoding: "quantized", origin: [minX, minY, minZ], position, scale };
};

const bucketKey = (tier: MeshTier, x: number, z: number) => {
  const cell = tier === "detail" ? DETAIL_CELL : CHUNK;
  const cx = Math.floor((x + WORLD_HALF_X) / cell);
  const cz = Math.floor((z + WORLD_HALF_Z) / cell);

  return DETAIL_TIERS.indexOf(tier) * 1_000_000 + (cx + 8) * 1000 + (cz + 8);
};

const geoOf = (
  tier: MeshTier,
  mat: ParcelMaterial,
  cx: number,
  cz: number,
  radius: number,
  g: GeoBuf,
  quantize: boolean,
) => {
  const rec: ParcelGeo = {
    cx,
    cz,
    mat,
    radius,
    tier,
    ...storePositions(g.pos, g.nv, quantize),
    color: g.col.slice(0, g.nv * 3),
    index: g.nv <= 65_535 ? Uint16Array.from(g.idx.subarray(0, g.ni)) : g.idx.slice(0, g.ni),
    normal: g.nor.slice(0, g.nv * 3),
  };

  if (g instanceof FacadeBuf) {
    return {
      ...rec,
      facade: g.fac.slice(0, g.nv * 4),
      facade2: g.fac2.slice(0, g.nv * 3),
      fuv: g.fuv.slice(0, g.nv * 2),
    };
  }

  if (g instanceof SignBuf) {
    return {
      ...rec,
      uv: Uint16Array.from(g.coordinates, (value) => Math.round(value * 65_535)),
    };
  }

  return rec;
};

class Buckets {
  private readonly map = new Map<number, Bucket>();

  at(tier: MeshTier, x: number, z: number) {
    const k = bucketKey(tier, x, z);
    let b = this.map.get(k);

    if (!b) {
      b = {
        facade: new FacadeBuf(),
        glassDark: new GeoBuf(),
        glassLit: new GeoBuf(),
        sign: new SignBuf(),
        wall: new GeoBuf(),
      };
      this.map.set(k, b);
    }

    return b;
  }

  flush(quantize: boolean) {
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

      const buffers: readonly (readonly [ParcelMaterial, GeoBuf])[] = [
        ["wall", b.wall],
        ["glassLit", b.glassLit],
        ["glassDark", b.glassDark],
        ["facade", b.facade],
        ["sign", b.sign],
      ];

      for (const [mat, g] of buffers) {
        if (g.nv === 0) {
          continue;
        }

        vertices += g.nv;
        triangles += g.ni / 3;
        geos.push(geoOf(tier, mat, cx, cz, radius, g, quantize));
      }
    }

    return { geos, stats: { buffers: geos.length, triangles, vertices } };
  }
}

interface Wall {
  readonly x0: number;
  readonly z0: number;
  readonly tx: number;
  readonly tz: number;
  readonly nx: number;
  readonly nz: number;
  readonly len: number;
  readonly blind: boolean;
  readonly front: boolean;
}

const canMerge = (a: Wall, b: Wall) => a.blind === b.blind && a.tx * b.tx + a.tz * b.tz > 0.99999;

const merge = (a: Wall, b: Wall) => ({
  ...a,
  front: a.front || b.front,
  len: a.len + b.len,
});

const wallsOf = (p: ParcelPlan) => {
  const out: Wall[] = [];

  for (let e = 0; e < p.n; e += 1) {
    const j = (e + 1) % p.n;
    const x0 = p.ring[e * 2] ?? 0;
    const z0 = p.ring[e * 2 + 1] ?? 0;
    const dx = (p.ring[j * 2] ?? 0) - x0;
    const dz = (p.ring[j * 2 + 1] ?? 0) - z0;
    const len = Math.hypot(dx, dz);

    if (len < 1e-4) {
      continue;
    }

    const tx = dx / len;
    const tz = dz / len;
    out.push({
      blind: p.blind[e] === 1,
      front: e === p.front,
      len,
      nx: tz,
      nz: -tx,
      tx,
      tz,
      x0,
      z0,
    });
  }

  const merged: Wall[] = [];

  for (const w of out) {
    const previous = merged.at(-1);

    if (previous && canMerge(previous, w)) {
      merged[merged.length - 1] = merge(previous, w);
    } else {
      merged.push(w);
    }
  }

  const [first] = merged;
  const last = merged.at(-1);

  if (merged.length > 2 && first && last && canMerge(last, first)) {
    merged[0] = merge(last, first);
    merged.pop();
  }

  return merged;
};

const decal = (
  g: GeoBuf,
  w: Wall,
  a: number,
  width: number,
  y0: number,
  h: number,
  off: number,
  color: number,
) => {
  const ox = w.nx * off;
  const oz = w.nz * off;
  const ax = w.x0 + w.tx * a + ox;
  const az = w.z0 + w.tz * a + oz;
  const bx = w.x0 + w.tx * (a + width) + ox;
  const bz = w.z0 + w.tz * (a + width) + oz;
  g.quad(ax, y0, az, bx, y0, bz, bx, y0 + h, bz, ax, y0 + h, az, w.nx, 0, w.nz, color);
};

const ledge = (
  g: GeoBuf,
  w: Wall,
  a0: number,
  a1: number,
  y0: number,
  h: number,
  depth: number,
  color: number,
  underside: boolean,
) => {
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
};

const windowOn = (
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
) => {
  const paneOff = OFF;

  if (frame > 0) {
    const proud = 0.13;
    const reveal = shade(frameColor, 0.7);
    decal(b.wall, w, a - frame, frame, y0 - frame, h + frame * 2, proud, frameColor);
    decal(b.wall, w, a + width, frame, y0 - frame, h + frame * 2, proud, frameColor);
    decal(b.wall, w, a, width, y0 + h, frame, proud, frameColor);
    decal(b.wall, w, a, width, y0 - frame, frame, proud, frameColor);

    for (const edge of [a, a + width]) {
      const x = w.x0 + w.tx * edge;
      const z = w.z0 + w.tz * edge;
      const dir = edge === a ? 1 : -1;
      b.wall.quad(
        x + w.nx * paneOff,
        y0,
        z + w.nz * paneOff,
        x + w.nx * proud,
        y0,
        z + w.nz * proud,
        x + w.nx * proud,
        y0 + h,
        z + w.nz * proud,
        x + w.nx * paneOff,
        y0 + h,
        z + w.nz * paneOff,
        w.tx * dir,
        0,
        w.tz * dir,
        reveal,
      );
    }

    ledge(
      b.wall,
      w,
      a - frame * 1.6,
      a + width + frame * 1.6,
      y0 - frame - 0.035,
      0.065,
      0.18,
      frameColor,
      false,
    );
    decal(b.wall, w, a, width, y0 + h * 0.5 - 0.018, 0.036, paneOff + 0.018, frameColor);
  }

  decal(lit ? b.glassLit : b.glassDark, w, a, width, y0, h, paneOff, glass);
};

const box = (
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
) => {
  const px = (a: number, bb: number) => cx + a * ex - bb * ez;
  const pz = (a: number, bb: number) => cz + a * ez + bb * ex;
  const c0x = px(-halfA, -halfB);
  const c0z = pz(-halfA, -halfB);
  const c1x = px(halfA, -halfB);
  const c1z = pz(halfA, -halfB);
  const c2x = px(halfA, halfB);
  const c2z = pz(halfA, halfB);
  const c3x = px(-halfA, halfB);
  const c3z = pz(-halfA, halfB);

  if (faces.top === true) {
    g.quad(c0x, y1, c0z, c1x, y1, c1z, c2x, y1, c2z, c3x, y1, c3z, 0, 1, 0, color);
  }

  if (faces.bottom === true) {
    g.quad(c0x, y0, c0z, c1x, y0, c1z, c2x, y0, c2z, c3x, y0, c3z, 0, -1, 0, color);
  }

  if (faces.sides === true) {
    g.quad(c0x, y0, c0z, c1x, y0, c1z, c1x, y1, c1z, c0x, y1, c0z, ez, 0, -ex, color);
    g.quad(c1x, y0, c1z, c2x, y0, c2z, c2x, y1, c2z, c1x, y1, c1z, ex, 0, ez, color);
    g.quad(c2x, y0, c2z, c3x, y0, c3z, c3x, y1, c3z, c2x, y1, c2z, -ez, 0, ex, color);
    g.quad(c3x, y0, c3z, c0x, y0, c0z, c0x, y1, c0z, c3x, y1, c3z, -ex, 0, -ez, color);
  }
};

const EYE_H = 6.5;
const STOOP_RAIL = 0x2e_31_34;

interface Storeys {
  readonly groundH: number;
  readonly upperH: number;
  readonly count: number;
}

const storeysOf = (p: ParcelPlan) => {
  const groundH = Math.max(GROUND_MIN, Math.min(p.height * 0.6, p.height / p.storeys + 0.15));
  const upper = Math.max(0, p.storeys - 1);
  const upperH = upper > 0 ? (p.height - groundH) / upper : 0;

  return { count: p.storeys, groundH, upperH };
};

const bodyTier: (height: number) => MeshTier = (height) => {
  if (height >= BIG_H) {
    return "far";
  }

  return height >= MID_H ? "mid" : "near";
};

interface Ctx {
  readonly p: ParcelPlan;
  readonly rng: Rng;
  readonly walls: readonly Wall[];
  readonly st: Storeys;
  readonly topY: number;
  readonly detail: DetailLevel;
  readonly bodyBucket: Bucket;
  readonly detailAt: (x: number, z: number) => Bucket;
  readonly colors: readonly ParcelColors[];
  readonly litFloor: readonly boolean[];
  readonly lit: (storey: number) => boolean;
}

const TOWER_CLADDING: Readonly<Record<TowerFacade, number>> = {
  curtain: 64,
  masonry: 192,
  ribbon: 128,
};

const leanPitch = (kind: ParcelKind) => {
  switch (kind) {
    case "stucco": {
      return 2;
    }

    case "rowhouse": {
      return 1.25;
    }

    case "midrise": {
      return 1.5;
    }

    case "tower": {
      return 1.3;
    }

    case "warehouse": {
      return 2.6;
    }

    case "shed": {
      return 0;
    }

    default: {
      return kind satisfies never;
    }
  }
};

const claddingFlags = (p: ParcelPlan) => {
  if (p.kind === "tower") {
    return TOWER_CLADDING[towerFacadeFor(p.blockHash)];
  }

  if (p.kind === "rowhouse") {
    return FACADE_FLAG_SIDING;
  }

  if (
    p.kind === "warehouse" ||
    (p.kind === "midrise" &&
      (p.district === "SoMa" ||
        p.district === "Dogpatch" ||
        p.district === "Jackson Square" ||
        p.district === "North Beach" ||
        p.district === "Chinatown"))
  ) {
    return FACADE_FLAG_BRICK;
  }

  return 0;
};

/* oxlint-disable no-bitwise -- facade flags are bits, composed with OR */
const bodyWallFlags = (p: ParcelPlan, w: Wall) =>
  (w.front || p.kind === "tower" ? FACADE_FLAG_BLANK : 0) | claddingFlags(p);
/* oxlint-enable no-bitwise */

const bodyWall = (
  c: Ctx,
  w: Wall,
  unit0: ParcelColors,
  y0: number,
  foundation: boolean,
  shader: boolean,
) => {
  const { p, st, topY } = c;
  const g = c.bodyBucket.wall;
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

  if (shader && !w.blind && (!w.front || p.units === 1)) {
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
        flags: bodyWallFlags(p, w),
        groundH: st.groundH,
        pitch: leanPitch(p.kind) || 1.4,
        seed: Math.floor(p.seed / 8) % 256,
        storeyH: st.upperH,
        storeys: st.count,
        wallLen: w.len,
      },
      yb - p.seatY,
    );

    return;
  }

  if (w.front && p.units > 1) {
    const unitW = w.len / p.units;

    for (let u = 0; u < p.units; u += 1) {
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
};

const parapet = (
  g: GeoBuf,
  walls: readonly Wall[],
  ring: Float32Array,
  n: number,
  topY: number,
  unit0: ParcelColors,
) => {
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

    if (!w.blind) {
      g.quad(w.x0, topY, w.z0, x1, topY, z1, ix1, topY, iz1, ix0, topY, iz0, 0, 1, 0, lipColor);
    }
  }
};

const body = (c: Ctx, ringOverride?: { ring: Float32Array; n: number; walls: readonly Wall[] }) => {
  const { p, st, topY } = c;
  const walls = ringOverride?.walls ?? c.walls;
  const [unit0] = c.colors;

  if (unit0 === undefined) {
    return;
  }

  const y0 = ringOverride ? p.seatY + st.groundH : p.footY;
  const foundation = !ringOverride && p.seatY - p.footY > 0.7;
  const shader = !ringOverride && p.kind !== "shed";

  for (const w of walls) {
    bodyWall(c, w, unit0, y0, foundation, shader);
  }

  parapet(
    c.bodyBucket.wall,
    walls,
    ringOverride?.ring ?? p.ring,
    ringOverride?.n ?? p.n,
    topY,
    unit0,
  );
};

const cornice = (c: Ctx, w: Wall, double: boolean) => {
  if (w.blind || c.detail < 1 || (!w.front && c.detail < 2)) {
    return;
  }

  const col = c.colors[0]?.trim ?? 0xff_ff_ff;
  const b = c.detailAt(w.x0 + (w.tx * w.len) / 2, w.z0 + (w.tz * w.len) / 2);
  const under = c.topY - c.p.seatY > EYE_H;
  ledge(b.wall, w, 0, w.len, c.topY - CORNICE_H - 0.02, CORNICE_H, CORNICE_D, col, under);

  if (double && w.front && c.detail >= 2) {
    ledge(b.wall, w, 0.1, w.len - 0.1, c.topY - CORNICE_H - 0.42, 0.14, 0.14, col, under);
  }
};

const residentialCrown = (c: Ctx, w: Wall, stucco: boolean) => {
  if (c.detail < 2 || w.blind || w.len < 1.1) {
    return;
  }

  const [col] = c.colors;

  if (!col) {
    return;
  }

  const g = c.detailAt(w.x0, w.z0).wall;
  const y = c.topY - 0.03;
  const center = w.len / 2;

  if (stucco) {
    if (c.p.seed % 3 !== 0) {
      return;
    }

    ledge(g, w, w.len * 0.18, w.len * 0.82, y, 0.16, 0.12, col.body, true);
    ledge(g, w, w.len * 0.34, w.len * 0.66, y + 0.16, 0.11, 0.12, col.body, true);

    return;
  }

  const brackets = Math.min(12, Math.max(2, Math.round(w.len / 0.65)));

  for (let k = 0; k < brackets; k += 1) {
    const a = 0.16 + ((w.len - 0.32) * k) / Math.max(1, brackets - 1);
    const x = w.x0 + w.tx * a + w.nx * 0.1;
    const z = w.z0 + w.tz * a + w.nz * 0.1;
    box(g, x, z, w.tx, w.tz, 0.045, 0.11, y - 0.57, y - 0.27, col.trim, { sides: true });
  }

  if (c.p.seed % 3 === 0) {
    return;
  }

  const half = Math.min(1.1, w.len * 0.35);
  const peak = Math.min(0.5, half * 0.45);
  const px = (a: number, d: number) => w.x0 + w.tx * a + w.nx * d;
  const pz = (a: number, d: number) => w.z0 + w.tz * a + w.nz * d;
  const left = center - half;
  const right = center + half;
  const d = 0.25;
  g.triangle(
    px(left, d),
    y,
    pz(left, d),
    px(right, d),
    y,
    pz(right, d),
    px(center, d),
    y + peak,
    pz(center, d),
    w.nx,
    0,
    w.nz,
    col.trim,
  );
  g.triangle(
    px(left + 0.14, d + 0.006),
    y + 0.05,
    pz(left + 0.14, d + 0.006),
    px(right - 0.14, d + 0.006),
    y + 0.05,
    pz(right - 0.14, d + 0.006),
    px(center, d + 0.006),
    y + peak * 0.72,
    pz(center, d + 0.006),
    w.nx,
    0,
    w.nz,
    shade(col.body, 0.83),
  );

  for (const a of [left, right]) {
    g.quad(
      px(a, 0),
      y,
      pz(a, 0),
      px(a, d),
      y,
      pz(a, d),
      px(center, d),
      y + peak,
      pz(center, d),
      px(center, 0),
      y + peak,
      pz(center, 0),
      0,
      1,
      0,
      col.trim,
    );
  }
};

const windowGrid = (
  c: Ctx,
  w: Wall,
  pitch: number,
  width: number,
  frame: number,
  fromStorey = 1,
) => {
  if (w.blind || c.detail < 1 || !w.front) {
    return;
  }

  const { st } = c;
  const [col] = c.colors;

  if (col === undefined) {
    return;
  }

  const p = w.front ? pitch : pitch * 1.35;
  const usable = w.len - 0.5;
  const count = Math.floor(usable / p);

  if (count < 1) {
    return;
  }

  const start = (w.len - count * p) / 2 + (p - width) / 2;
  const winH = st.upperH * 0.52;
  const sill = st.upperH * 0.26;

  for (let s = fromStorey; s < st.count; s += 1) {
    const y0 = c.p.seatY + st.groundH + (s - 1) * st.upperH + sill;

    for (let k = 0; k < count; k += 1) {
      const a = start + k * p;
      const b = c.detailAt(w.x0 + w.tx * a, w.z0 + w.tz * a);
      windowOn(b, w, a, width, y0, winH, frame, col.trim, col.glass, c.lit(s));
    }
  }
};

const STRIP_SHARE: Readonly<Record<TowerFacade, number>> = {
  curtain: 0.86,
  masonry: 0.62,
  ribbon: 0.42,
};

const windowStrips = (
  c: Ctx,
  w: Wall,
  fromStorey: number,
  toStorey: number,
  y0Base: number,
  storeyH: number,
  inset = 0.3,
) => {
  if (w.blind || c.detail < 1 || w.len < inset * 2 + 0.6) {
    return;
  }

  const [col] = c.colors;

  if (col === undefined) {
    return;
  }

  const stripH = storeyH * STRIP_SHARE[towerFacadeFor(c.p.blockHash)];
  const sill = (storeyH - stripH) / 2;

  for (let s = fromStorey; s < toStorey; s += 1) {
    const y0 = y0Base + (s - fromStorey) * storeyH + sill;
    const b = c.bodyBucket;
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
};

const bay = (c: Ctx, w: Wall, ac: number, bw: number, colors: ParcelColors, depth = BAY_D) => {
  const { p, st } = c;
  const y0 = p.seatY + st.groundH;
  const y1 = c.topY - CORNICE_H - 0.08;

  if (y1 - y0 < 0.8) {
    return;
  }

  const b = c.detailAt(w.x0 + w.tx * ac, w.z0 + w.tz * ac);
  const g = b.wall;
  const d = Math.min(depth, ac - bw / 2 - 0.06, w.len - ac - bw / 2 - 0.06);

  if (d < 0.06) {
    return;
  }

  const wlx = w.x0 + w.tx * (ac - bw / 2 - d);
  const wlz = w.z0 + w.tz * (ac - bw / 2 - d);
  const wrx = w.x0 + w.tx * (ac + bw / 2 + d);
  const wrz = w.z0 + w.tz * (ac + bw / 2 + d);
  const flx = w.x0 + w.tx * (ac - bw / 2) + w.nx * d;
  const flz = w.z0 + w.tz * (ac - bw / 2) + w.nz * d;
  const frx = w.x0 + w.tx * (ac + bw / 2) + w.nx * d;
  const frz = w.z0 + w.tz * (ac + bw / 2) + w.nz * d;
  const bodyCol = colors.body;
  const ln = { x: (w.nx - w.tx) * Math.SQRT1_2, z: (w.nz - w.tz) * Math.SQRT1_2 };
  const rn = { x: (w.nx + w.tx) * Math.SQRT1_2, z: (w.nz + w.tz) * Math.SQRT1_2 };
  g.quad(wlx, y0, wlz, flx, y0, flz, flx, y1, flz, wlx, y1, wlz, ln.x, 0, ln.z, bodyCol);
  g.quad(flx, y0, flz, frx, y0, frz, frx, y1, frz, flx, y1, flz, w.nx, 0, w.nz, bodyCol);
  g.quad(frx, y0, frz, wrx, y0, wrz, wrx, y1, wrz, frx, y1, frz, rn.x, 0, rn.z, bodyCol);
  g.quad(wlx, y1, wlz, flx, y1, flz, frx, y1, frz, wrx, y1, wrz, 0, 1, 0, colors.trim);
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

  const sideLen = d * Math.SQRT2;

  const faces: Wall[] = [
    {
      blind: false,
      front: false,
      len: sideLen,
      nx: ln.x,
      nz: ln.z,
      tx: (flx - wlx) / sideLen,
      tz: (flz - wlz) / sideLen,
      x0: wlx,
      z0: wlz,
    },
    {
      blind: false,
      front: false,
      len: bw,
      nx: w.nx,
      nz: w.nz,
      tx: w.tx,
      tz: w.tz,
      x0: flx,
      z0: flz,
    },
    {
      blind: false,
      front: false,
      len: sideLen,
      nx: rn.x,
      nz: rn.z,
      tx: (wrx - frx) / sideLen,
      tz: (wrz - frz) / sideLen,
      x0: frx,
      z0: frz,
    },
  ];

  for (const f of faces) {
    decal(b.wall, f, 0, f.len, y1 - 0.14, 0.14, OFF, colors.trim);
  }

  const sill = st.upperH * 0.2;

  for (let s = 1; s < st.count; s += 1) {
    const wy = p.seatY + st.groundH + (s - 1) * st.upperH + sill;
    const winH = Math.min(st.upperH * 0.56, y1 - 0.12 - wy);

    if (winH < 0.25) {
      continue;
    }

    const lit = c.lit(s);

    for (const f of faces) {
      const ww = f.len - 0.24;

      if (ww < 0.2) {
        continue;
      }

      windowOn(b, f, 0.12, ww, wy, winH, c.detail >= 2 ? 0.05 : 0, colors.trim, colors.glass, lit);
    }
  }
};

const groundResidential = (
  c: Ctx,
  w: Wall,
  a0: number,
  unitW: number,
  colors: ParcelColors,
  wideGarage: boolean,
) => {
  const { p, st } = c;
  const b = c.detailAt(w.x0 + w.tx * (a0 + unitW / 2), w.z0 + w.tz * (a0 + unitW / 2));
  const y0 = p.seatY;
  const garageW = Math.min(wideGarage ? 1.7 : 1.25, unitW * (wideGarage ? 0.58 : 0.5));
  const garageH = Math.min(st.groundH - 0.32, 1.35);
  const doorW = Math.min(0.5, Math.max(0.23, unitW * 0.21));
  const doorH = Math.min(st.groundH - 0.3, 1.15);
  const gap = Math.min(0.14, unitW * 0.05);
  const total = garageW + gap + doorW;

  if (total > unitW - 0.16) {
    decal(b.wall, w, a0 + (unitW - doorW) / 2, doorW, y0, doorH, OFF, colors.door);

    return;
  }

  const a = a0 + (unitW - total) / 2;
  decal(b.wall, w, a, garageW, y0, garageH, OFF, colors.garage);
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
    decal(b.glassDark, w, da + 0.06, doorW - 0.12, y0 + doorH + 0.14, 0.22, OFF, colors.glass);
    const sx = w.x0 + w.tx * (da + doorW / 2) + w.nx * 0.28;
    const sz = w.z0 + w.tz * (da + doorW / 2) + w.nz * 0.28;
    box(b.wall, sx, sz, w.tx, w.tz, doorW / 2 + 0.12, 0.28, y0 - 0.05, y0 + 0.22, colors.trim, {
      sides: true,
      top: true,
    });
    const rx = w.x0 + w.tx * (da - 0.04) + w.nx * 0.28;
    const rz = w.z0 + w.tz * (da - 0.04) + w.nz * 0.28;
    box(b.wall, rx, rz, w.tx, w.tz, 0.025, 0.26, y0 + 0.22, y0 + 0.92, STOOP_RAIL, { sides: true });
  }
};

const shopLantern = (g: GeoBuf, w: Wall, a: number, y: number, depth: number) => {
  const cx = w.x0 + w.tx * a + w.nx * depth;
  const cz = w.z0 + w.tz * a + w.nz * depth;

  const profile: readonly (readonly [number, number])[] = [
    [-0.19, 0.065],
    [-0.12, 0.135],
    [0.12, 0.135],
    [0.19, 0.065],
  ];

  for (let ring = 0; ring < profile.length - 1; ring += 1) {
    const lo = profile[ring];
    const hi = profile[ring + 1];

    if (!lo || !hi) {
      continue;
    }

    for (let k = 0; k < 8; k += 1) {
      const a0 = (k / 8) * Math.PI * 2;
      const a1 = ((k + 1) / 8) * Math.PI * 2;
      const color = k % 2 === 0 ? 0xcc_3b_24 : 0xe7_54_2d;
      g.quad(
        cx + Math.cos(a0) * lo[1],
        y + lo[0],
        cz + Math.sin(a0) * lo[1],
        cx + Math.cos(a1) * lo[1],
        y + lo[0],
        cz + Math.sin(a1) * lo[1],
        cx + Math.cos(a1) * hi[1],
        y + hi[0],
        cz + Math.sin(a1) * hi[1],
        cx + Math.cos(a0) * hi[1],
        y + hi[0],
        cz + Math.sin(a0) * hi[1],
        Math.cos((a0 + a1) / 2),
        0,
        Math.sin((a0 + a1) / 2),
        color,
      );
    }
  }

  box(g, cx, cz, w.tx, w.tz, 0.06, 0.06, y + 0.18, y + 0.23, 0xd8_ae_52, {
    sides: true,
    top: true,
  });
  box(g, cx, cz, w.tx, w.tz, 0.02, 0.02, y - 0.3, y - 0.18, 0xd8_ae_52, { sides: true });
};

const storefront = (
  c: Ctx,
  w: Wall,
  a0: number,
  unitW: number,
  colors: ParcelColors,
  awning: boolean,
) => {
  const { p, st } = c;
  const b = c.detailAt(w.x0 + w.tx * (a0 + unitW / 2), w.z0 + w.tz * (a0 + unitW / 2));
  const margin = 0.2;
  const glassW = unitW - margin * 2;

  if (glassW < 0.6) {
    return;
  }

  const signH = 0.34;
  const glassY0 = p.seatY + 0.14;
  const glassH = st.groundH - 0.14 - signH - 0.12;

  if (glassH < 0.5) {
    return;
  }

  decal(b.glassLit, w, a0 + margin, glassW, glassY0, glassH, OFF, colors.glass);
  const mullion = shade(colors.body, 0.55);

  for (let k = 1; k <= 2; k += 1) {
    decal(b.wall, w, a0 + margin + (glassW * k) / 3 - 0.03, 0.06, glassY0, glassH, OFF2, mullion);
  }

  const signY = glassY0 + glassH + 0.06;
  const signWidth = glassW + 0.12;
  const signStart = a0 + margin - 0.06;

  if (c.detail >= 1 && signWidth >= 2.35) {
    ledge(
      b.wall,
      w,
      signStart,
      signStart + signWidth,
      signY,
      signH,
      0.11,
      shade(colors.awning, 0.45),
      true,
    );
    const labelWidth = Math.min(signWidth - 0.16, (signH - 0.05) * SIGN_LABEL_ASPECT);
    decal(
      b.sign,
      w,
      signStart + (signWidth - labelWidth) / 2,
      labelWidth,
      signY + 0.025,
      signH - 0.05,
      0.126,
      0xff_ff_ff,
    );
    b.sign.label(shopSignIndex(p.district, p.seed, Math.round(a0 / unitW)));
    decal(b.wall, w, signStart, signWidth, signY, 0.035, 0.13, colors.trim);
    decal(b.wall, w, signStart, signWidth, signY + signH - 0.035, 0.035, 0.13, colors.trim);
  } else {
    decal(b.wall, w, signStart, signWidth, signY, signH, OFF, shade(colors.awning, 0.45));
  }

  if (awning && c.detail >= 2) {
    const ay = glassY0 + glassH + 0.06;
    const depth = Math.min(0.72, unitW * 0.24);
    const start = a0 + margin;
    const end = start + glassW;
    const chinese = p.district === "Chinatown";
    const stripes = chinese ? 1 : Math.max(4, Math.min(14, Math.round(glassW / 0.24)));

    for (let k = 0; k < stripes; k += 1) {
      const left = start + (glassW * k) / stripes;
      const right = start + (glassW * (k + 1)) / stripes;
      const stripe = k % 2 === 0 ? colors.awning : 0xee_e2_c1;
      const color = chinese ? 0x28_64_5b : stripe;
      const ax = w.x0 + w.tx * left;
      const az = w.z0 + w.tz * left;
      const bx = w.x0 + w.tx * right;
      const bz = w.z0 + w.tz * right;
      b.wall.quad(
        ax,
        ay + 0.03,
        az,
        bx,
        ay + 0.03,
        bz,
        bx + w.nx * depth,
        ay - 0.12,
        bz + w.nz * depth,
        ax + w.nx * depth,
        ay - 0.12,
        az + w.nz * depth,
        0,
        1,
        0,
        color,
      );
      decal(b.wall, w, left, right - left, ay - 0.25, 0.13, depth, color);
    }

    if (chinese && unitW >= 1.6) {
      for (const a of [start + glassW * 0.18, end - glassW * 0.18]) {
        shopLantern(b.wall, w, a, ay - 0.46, depth * 0.8);
      }
    }

    for (const a of [start, end]) {
      const x = w.x0 + w.tx * a;
      const z = w.z0 + w.tz * a;
      const dir = a === start ? -1 : 1;
      b.wall.triangle(
        x,
        ay - 0.12,
        z,
        x,
        ay + 0.03,
        z,
        x + w.nx * depth,
        ay - 0.12,
        z + w.nz * depth,
        w.tx * dir,
        0,
        w.tz * dir,
        shade(colors.awning, 0.7),
      );
    }
  }
};

const roofPlant = (c: Ctx, count: number, bulkhead: boolean) => {
  if (c.detail < 2) {
    return;
  }

  const { p, rng } = c;
  const [col] = c.colors;

  if (col === undefined) {
    return;
  }

  const o = p.obb;
  const b = c.detailAt(o.cx, o.cz);
  const capY = c.topY - PARAPET;

  const spot: (fa: number, fb: number) => readonly [number, number] = (fa, fb) => [
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
      rng.range(0.7, 1),
      capY,
      capY + rng.range(1, 1.5),
      shade(col.roof, 0.82),
      {
        sides: true,
        top: true,
      },
    );
  }

  for (let k = 0; k < count; k += 1) {
    if (o.halfA < 1.6 || o.halfB < 1.6) {
      break;
    }

    const [ax, az] = spot(rng.range(-0.6, 0.6), rng.range(-0.6, 0.6));
    const s = rng.range(0.3, 0.5);
    box(b.wall, ax, az, o.ex, o.ez, s, s, capY, capY + s * 1.4, 0xc4_c8_cb, {
      sides: true,
      top: true,
    });
  }
};

const flatFront = (
  c: Ctx,
  w: Wall,
  a0: number,
  unitW: number,
  colors: ParcelColors,
  stucco: boolean,
) => {
  const { p, st } = c;
  const b = c.detailAt(w.x0 + w.tx * (a0 + unitW / 2), w.z0 + w.tz * (a0 + unitW / 2));
  const winH = st.upperH * (stucco ? 0.48 : 0.55);
  const sill = st.upperH * 0.26;

  for (let s = 1; s < st.count; s += 1) {
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
};

const roofClutter = (c: Ctx) => {
  if (c.detail < 2) {
    return;
  }

  const { p, rng } = c;
  const [col] = c.colors;

  if (col === undefined) {
    return;
  }

  const o = p.obb;

  if (o.halfA < 1.4 || o.halfB < 1.4) {
    return;
  }

  const g = c.detailAt(o.cx, o.cz).wall;
  const capY = c.topY - PARAPET;

  const spot: (fa: number, fb: number) => readonly [number, number] = (fa, fb) => [
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
    box(g, vx, vz, o.ex, o.ez, sz, sz, capY, capY + sz * 2.2, 0xb9_bc_bf, {
      sides: true,
      top: true,
    });
  }
};

const buildRowhouse = (c: Ctx, stucco: boolean) => {
  const { p, st, rng } = c;
  body(c);

  for (const w of c.walls) {
    if (w.front) {
      const unitW = w.len / p.units;

      for (let u = 0; u < p.units; u += 1) {
        const colors = c.colors[u] ?? c.colors[0];

        if (colors === undefined) {
          continue;
        }

        const a0 = u * unitW;

        if (c.detail >= 1) {
          groundResidential(c, w, a0, unitW, colors, stucco);
        }

        if (st.count < 2) {
          continue;
        }

        if (unitW >= 1.1 && c.detail >= 2) {
          const bayW = Math.min(stucco ? 2.2 : 1.5, unitW * (stucco ? 0.68 : 0.52));
          bay(c, w, a0 + unitW / 2, bayW, colors, Math.min(stucco ? 0.18 : BAY_D, unitW * 0.2));
        } else if (c.detail >= 1) {
          flatFront(c, w, a0, unitW, colors, stucco);
        }
      }

      cornice(c, w, !stucco);
      residentialCrown(c, w, stucco);
    } else {
      windowGrid(c, w, 1.25 + rng.range(0, 0.25), 0.62, 0);

      if (!w.blind && st.count >= 2) {
        cornice(c, w, false);
      }
    }
  }

  if (!roofVariantOf(p)) {
    roofClutter(c);
  }
};

const fireEscape = (c: Ctx, w: Wall) => {
  if (c.detail < 2 || !hasFireEscape(c.p.district, c.p.seed) || w.len < 3.2 || c.st.count < 3) {
    return;
  }

  const g = c.detailAt(w.x0, w.z0).wall;
  const a0 = w.len * 0.5 - 0.7;
  const a1 = a0 + 1.4;
  const depth = 0.47;
  const metal = 0x39_44_40;
  const x = (a: number, d: number) => w.x0 + w.tx * a + w.nx * d;
  const z = (a: number, d: number) => w.z0 + w.tz * a + w.nz * d;

  for (let s = 1; s < Math.min(c.st.count, 8); s += 1) {
    const y = c.p.seatY + c.st.groundH + (s - 1) * c.st.upperH + 0.02;
    ledge(g, w, a0, a1, y, 0.06, depth, metal, true);
    decal(g, w, a0, a1 - a0, y + 0.47, 0.045, depth, metal);

    for (let k = 0; k <= 5; k += 1) {
      const a = a0 + ((a1 - a0) * k) / 5;
      decal(g, w, a - 0.016, 0.032, y + 0.06, 0.42, depth, metal);
    }

    if (s >= c.st.count - 1) {
      continue;
    }

    const start = s % 2 === 0 ? a0 + 0.1 : a1 - 0.1;
    const end = s % 2 === 0 ? a1 - 0.1 : a0 + 0.1;
    const rise = c.st.upperH;

    for (const d of [0.16, depth - 0.04]) {
      g.quad(
        x(start, d),
        y,
        z(start, d),
        x(end, d),
        y + rise,
        z(end, d),
        x(end, d),
        y + rise + 0.055,
        z(end, d),
        x(start, d),
        y + 0.055,
        z(start, d),
        w.nx,
        0,
        w.nz,
        metal,
      );
    }

    for (let k = 1; k < 8; k += 1) {
      const a = start + ((end - start) * k) / 8;
      const sy = y + (rise * k) / 8;
      g.quad(
        x(a - 0.04, 0.16),
        sy,
        z(a - 0.04, 0.16),
        x(a + 0.04, 0.16),
        sy,
        z(a + 0.04, 0.16),
        x(a + 0.04, depth),
        sy,
        z(a + 0.04, depth),
        x(a - 0.04, depth),
        sy,
        z(a - 0.04, depth),
        0,
        1,
        0,
        metal,
      );
    }
  }
};

const buildMidrise = (c: Ctx) => {
  const { p, rng } = c;
  body(c);
  const pitch = 1.45 + rng.range(0, 0.35);

  for (const w of c.walls) {
    if (w.front) {
      const unitW = w.len / p.units;

      for (let u = 0; u < p.units; u += 1) {
        const colors = c.colors[u] ?? c.colors[0];

        if (colors === undefined) {
          continue;
        }

        storefront(c, w, u * unitW, unitW, colors, rng.chance(0.7));
      }

      windowGrid(c, w, pitch, 0.82, c.detail >= 2 ? 0.05 : 0);
      fireEscape(c, w);
    } else {
      windowGrid(c, w, pitch, 0.82, 0);
    }

    cornice(c, w, false);
  }

  roofPlant(c, rng.chance(0.5) ? 2 : 1, rng.chance(0.55));
};

const podiumShops = (c: Ctx, w: Wall) => {
  const { p, st } = c;
  const [col] = c.colors;

  if (col === undefined) {
    return;
  }

  if (w.blind || w.len < 3.2 || c.detail < 1) {
    windowStrips(c, w, 0, 1, p.seatY + 0.1, st.groundH - 0.2, 0.4);

    return;
  }

  const units = Math.max(1, Math.round(w.len / 4.5));
  const unitW = w.len / units;

  for (let u = 0; u < units; u += 1) {
    storefront(c, w, u * unitW, unitW, col, c.rng.chance(0.6));
  }
};

const towerRibs = (c: Ctx, w: Wall, y0: number) => {
  if (c.detail < 2 || w.blind || w.len < 2.5) {
    return;
  }

  const [col] = c.colors;

  if (!col) {
    return;
  }

  const g = c.detailAt(w.x0, w.z0).wall;
  const facade = towerFacadeFor(c.p.blockHash);
  const stone = facade === "masonry";
  const columns = Math.max(2, Math.min(9, Math.round(w.len / (stone ? 2.4 : 1.7))));
  const width = stone ? 0.13 : 0.045;

  for (let k = 0; k <= columns; k += 1) {
    if (facade === "ribbon" && k > 0 && k < columns) {
      continue;
    }

    const a = 0.18 + ((w.len - 0.36) * k) / columns;
    const x = w.x0 + w.tx * a + w.nx * 0.09;
    const z = w.z0 + w.tz * a + w.nz * 0.09;
    box(g, x, z, w.tx, w.tz, width, 0.09, y0, c.topY, col.trim, { sides: true });
  }
};

const crown = (
  c: Ctx,
  _ring: Float32Array,
  o: { cx: number; cz: number; ex: number; ez: number; halfA: number; halfB: number },
  inset: number,
) => {
  if (c.detail < 1) {
    return;
  }

  const [col] = c.colors;

  if (col === undefined) {
    return;
  }

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
      sides: true,
      top: true,
    },
  );

  if (c.p.seed % 3 === 0 && c.p.height >= 20) {
    box(
      b.wall,
      o.cx,
      o.cz,
      o.ex,
      o.ez,
      o.halfA * inset * taper * 0.66,
      o.halfB * inset * taper * 0.66,
      c.topY + crownH,
      c.topY + crownH * 1.65,
      col.body,
      { sides: true, top: true },
    );
  }
};

const buildTower = (c: Ctx) => {
  const { p, st } = c;
  const [col] = c.colors;

  if (col === undefined) {
    return;
  }

  const o = p.obb;
  const podiumStoreys = Math.min(3, 1 + Math.floor(st.count * 0.12));
  const setback = p.rect && o.halfA > 3 && o.halfB > 3 && st.count >= 10;

  if (setback) {
    const podiumTop = p.seatY + st.groundH + (podiumStoreys - 1) * st.upperH;
    const savedTop = c.topY;
    const podium: Ctx = { ...c, st: { ...st, count: podiumStoreys }, topY: podiumTop };
    body(podium);

    for (const w of c.walls) {
      podiumShops(podium, w);
      windowGrid(podium, w, 1.15, 0.6, 0);
      cornice(podium, w, false);
    }

    const inset = 0.8;
    const ring = new Float32Array(8);

    const px = (a: number, b: number) =>
      o.cx + a * o.halfA * inset * o.ex - b * o.halfB * inset * o.ez;

    const pz = (a: number, b: number) =>
      o.cz + a * o.halfA * inset * o.ez + b * o.halfB * inset * o.ex;

    const corners: readonly (readonly [number, number])[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];

    for (const [i, [a, b]] of corners.entries()) {
      ring[i * 2] = px(a, b);
      ring[i * 2 + 1] = pz(a, b);
    }

    const shaftPlan: ParcelPlan = {
      ...p,
      blind: new Uint8Array(4),
      footY: podiumTop,
      front: -1,
      n: 4,
      ring,
      seatY: podiumTop - st.groundH,
    };

    const shaftWalls = wallsOf(shaftPlan);
    const shaft: Ctx = { ...c, topY: savedTop, walls: shaftWalls };
    body(shaft, { n: 4, ring, walls: shaftWalls });

    for (const w of shaftWalls) {
      windowStrips(shaft, w, podiumStoreys, st.count, podiumTop, st.upperH);
      towerRibs(shaft, w, podiumTop);
    }

    crown(shaft, ring, o, inset);
  } else {
    body(c);

    for (const w of c.walls) {
      podiumShops(c, w);
      windowStrips(c, w, 1, st.count, p.seatY + st.groundH, st.upperH);
      towerRibs(c, w, p.seatY + st.groundH);
    }

    crown(c, p.ring, o, 1);
  }

  roofPlant(c, 1, false);
};

const warehouseRoof = (c: Ctx) => {
  if (c.detail < 2) {
    return;
  }

  const { p } = c;
  const [col] = c.colors;

  if (!col || p.obb.halfA < 2.2 || p.obb.halfB < 2.2) {
    return;
  }

  const o = p.obb;
  const halfA = o.halfA * 0.72;
  const halfB = o.halfB * 0.72;
  const px = (a: number, b: number) => o.cx + a * o.ex - b * o.ez;
  const pz = (a: number, b: number) => o.cz + a * o.ez + b * o.ex;

  for (const a of [-halfA, halfA]) {
    for (const b of [-halfB, halfB]) {
      if (!pointInRing(p.ring, p.n, px(a, b), pz(a, b))) {
        return;
      }
    }
  }

  const bucket = c.detailAt(o.cx, o.cz);
  const teeth = Math.max(2, Math.min(4, Math.floor(halfA / 1.5)));
  const pitch = (halfA * 2) / teeth;
  const y = c.topY - PARAPET + 0.02;
  const h = Math.min(0.7, pitch * 0.38);

  for (let k = 0; k < teeth; k += 1) {
    const a0 = -halfA + k * pitch;
    const a1 = a0 + pitch;
    bucket.wall.quad(
      px(a0, -halfB),
      y + h,
      pz(a0, -halfB),
      px(a1, -halfB),
      y,
      pz(a1, -halfB),
      px(a1, halfB),
      y,
      pz(a1, halfB),
      px(a0, halfB),
      y + h,
      pz(a0, halfB),
      0,
      1,
      0,
      shade(col.roof, 0.76),
    );
    bucket.glassDark.quad(
      px(a0, -halfB),
      y,
      pz(a0, -halfB),
      px(a0, halfB),
      y,
      pz(a0, halfB),
      px(a0, halfB),
      y + h,
      pz(a0, halfB),
      px(a0, -halfB),
      y + h,
      pz(a0, -halfB),
      -o.ex,
      0,
      -o.ez,
      col.glass,
    );

    for (const b of [-halfB, halfB]) {
      const side = b < 0 ? -1 : 1;
      bucket.wall.triangle(
        px(a0, b),
        y,
        pz(a0, b),
        px(a1, b),
        y,
        pz(a1, b),
        px(a0, b),
        y + h,
        pz(a0, b),
        -o.ez * side,
        0,
        o.ex * side,
        col.body,
      );
    }
  }
};

const buildWarehouse = (c: Ctx) => {
  const { p, st, rng } = c;
  const [col] = c.colors;

  if (col === undefined) {
    return;
  }

  body(c);

  for (const w of c.walls) {
    if (w.blind) {
      continue;
    }

    if (w.front && c.detail >= 1) {
      const b = c.detailAt(w.x0 + (w.tx * w.len) / 2, w.z0 + (w.tz * w.len) / 2);
      const doorW = 1.7;
      const doorH = Math.min(st.groundH - 0.25, 1.6);
      const doors = Math.max(1, Math.min(4, Math.floor((w.len - 0.6) / (doorW + 0.9))));
      const span = doors * doorW + (doors - 1) * 0.9;
      const a0 = (w.len - span) / 2;

      for (let k = 0; k < doors; k += 1) {
        const a = a0 + k * (doorW + 0.9);
        decal(b.wall, w, a, doorW, p.seatY, doorH, OFF, col.garage);
        decal(b.wall, w, a - 0.06, doorW + 0.12, p.seatY + doorH, 0.12, OFF, col.trim);
      }
    }

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

  warehouseRoof(c);
  roofPlant(c, rng.chance(0.6) ? 2 : 1, false);
};

const buildShed = (c: Ctx) => {
  const { p, st } = c;
  const [col] = c.colors;

  if (col === undefined) {
    return;
  }

  body(c);

  if (c.detail < 1) {
    return;
  }

  for (const w of c.walls) {
    if (!w.front || w.len < 1.2) {
      continue;
    }

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
};

const historicRoof = (b: Bucket, p: ParcelPlan, roof: RoofVariant, detail: DetailLevel) => {
  const top = p.seatY + p.height;
  const base = top - roof.rise;
  const colors = colorsFor(p.kind, p.character, p.blockHash, new Rng(p.seed).next(), p.district);
  const slate = shade(colors.roof, 0.63);

  if (roof.kind === "mansard") {
    for (let i = 0; i < p.n; i += 1) {
      const j = (i + 1) % p.n;
      const ax = p.ring[i * 2] ?? 0;
      const az = p.ring[i * 2 + 1] ?? 0;
      const bx = p.ring[j * 2] ?? 0;
      const bz = p.ring[j * 2 + 1] ?? 0;
      b.wall.quad(
        ax,
        base,
        az,
        bx,
        base,
        bz,
        roof.inset[j * 2] ?? 0,
        top,
        roof.inset[j * 2 + 1] ?? 0,
        roof.inset[i * 2] ?? 0,
        top,
        roof.inset[i * 2 + 1] ?? 0,
        bz - az,
        1,
        ax - bx,
        slate,
      );
    }

    b.wall.cap(roof.inset, p.n, top, 1, colors.roof);

    return;
  }

  const count = 8;
  const ring = new Float32Array(count * 2);
  const drum = base + roof.rise * 0.48;

  for (let i = 0; i < count; i += 1) {
    const angle = (i * Math.PI * 2) / count;
    ring[i * 2] = roof.cx + Math.cos(angle) * roof.radius;
    ring[i * 2 + 1] = roof.cz + Math.sin(angle) * roof.radius;
  }

  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count;
    const ax = ring[i * 2] ?? 0;
    const az = ring[i * 2 + 1] ?? 0;
    const bx = ring[j * 2] ?? 0;
    const bz = ring[j * 2 + 1] ?? 0;
    const length = Math.hypot(bx - ax, bz - az);

    const w: Wall = {
      blind: false,
      front: false,
      len: length,
      nx: (bz - az) / length,
      nz: (ax - bx) / length,
      tx: (bx - ax) / length,
      tz: (bz - az) / length,
      x0: ax,
      z0: az,
    };

    decal(b.wall, w, 0, length, base - 0.1, drum - base + 0.1, 0, colors.body);
    decal(b.wall, w, 0, length, drum - 0.08, 0.08, 0.015, colors.trim);

    if (detail > 0) {
      windowOn(
        b,
        w,
        length * 0.24,
        length * 0.52,
        base + 0.12,
        drum - base - 0.24,
        0.025,
        colors.trim,
        colors.glass,
        false,
      );
    }

    const inner = 0.09;
    const iax = roof.cx + (ax - roof.cx) * inner;
    const iaz = roof.cz + (az - roof.cz) * inner;
    const ibx = roof.cx + (bx - roof.cx) * inner;
    const ibz = roof.cz + (bz - roof.cz) * inner;
    b.wall.quad(ax, drum, az, bx, drum, bz, ibx, top, ibz, iax, top, iaz, w.nx, 1, w.nz, slate);
  }

  const summit = ring.map((value, index) => {
    const center = index % 2 === 0 ? roof.cx : roof.cz;

    return center + (value - center) * 0.09;
  });

  b.wall.cap(summit, count, top, 1, slate);
};

const LOT_ASPHALT = 0x4b_50_58;
const LOT_LINE = 0xd6_da_d6;
const LOT_LIFT = 0.06;
const BAY_PITCH = 2.2;
const BAY_DEPTH = 2.6;

const buildLot = (buckets: Buckets, lot: ParcelLot) => {
  const g = buckets.at("near", lot.obb.cx, lot.obb.cz).wall;
  g.capDraped(lot.ring, lot.n, lot.ys, LOT_LIFT, LOT_ASPHALT);
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;

  for (let i = 0; i < lot.n; i += 1) {
    const y = lot.ys[i] ?? 0;

    if (y < lo) {
      lo = y;
    }

    if (y > hi) {
      hi = y;
    }

    sum += y;
  }

  if (hi - lo > 1.2) {
    return;
  }

  const y = sum / lot.n + LOT_LIFT + 0.02;
  const o = lot.obb;
  const long = o.halfA >= o.halfB;
  const lx = long ? o.ex : -o.ez;
  const lz = long ? o.ez : o.ex;
  const sx = long ? -o.ez : o.ex;
  const sz = long ? o.ex : o.ez;
  const halfL = long ? o.halfA : o.halfB;
  const halfS = long ? o.halfB : o.halfA;

  if (halfS * 2 < 3.4) {
    return;
  }

  const rows: number[] = halfS * 2 >= 5.6 ? [-1, 1] : [halfS > 0 ? -1 : 1];

  for (const side of rows) {
    const edge = side * (halfS - 0.5);
    const inner = side * (halfS - 0.5 - Math.min(BAY_DEPTH, halfS - 0.6));

    for (let a = -halfL + 1.2; a <= halfL - 1.2; a += BAY_PITCH) {
      const ax = o.cx + lx * a + sx * edge;
      const az = o.cz + lz * a + sz * edge;
      const bx = o.cx + lx * a + sx * inner;
      const bz = o.cz + lz * a + sz * inner;

      if (!pointInRing(lot.ring, lot.n, ax, az) || !pointInRing(lot.ring, lot.n, bx, bz)) {
        continue;
      }

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
};

const leanFlags = (kind: ParcelKind) => {
  switch (kind) {
    case "stucco":
    case "rowhouse": {
      return FACADE_FLAG_HOUSE;
    }

    case "midrise":
    case "tower": {
      return FACADE_FLAG_SHOP;
    }

    case "warehouse":
    case "shed": {
      return FACADE_FLAG_SHED;
    }

    default: {
      return kind satisfies never;
    }
  }
};

/* oxlint-disable no-bitwise -- facade flags are bits, composed with OR */
const leanWallFlags = (w: Wall, blank: boolean, flags: number, cladding: number) => {
  if (blank) {
    return FACADE_FLAG_BLANK | (w.blind ? 0 : flags) | cladding;
  }

  return (w.front ? flags : 0) | cladding;
};
/* oxlint-enable no-bitwise */

const buildLean = (buckets: Buckets, p: ParcelPlan, silhouetteHeight: number) => {
  const rng = new Rng(p.seed);
  const walls = wallsOf(p);

  if (walls.length < 3) {
    return;
  }

  const st = storeysOf(p);
  const topY = p.seatY + p.height;
  const b = buckets.at(bodyTier(silhouetteHeight), p.obb.cx, p.obb.cz);
  const colors = colorsFor(p.kind, p.character, p.blockHash, rng.next(), p.district);
  const unitColors: number[] = [colors.body];

  for (let u = 1; u < p.units; u += 1) {
    unitColors.push(colorsFor(p.kind, p.character, p.blockHash, rng.next(), p.district).body);
  }

  const pitch = leanPitch(p.kind);
  const flags = leanFlags(p.kind);
  const cladding = claddingFlags(p);
  const seedByte = Math.floor(p.seed / 8) % 256;
  const y0 = p.footY;

  for (const w of walls) {
    const blank = w.blind || pitch === 0;

    const fp: FacadeParams = {
      flags: leanWallFlags(w, blank, flags, cladding),
      groundH: st.groundH,
      pitch: pitch || 1,
      seed: seedByte,
      storeyH: st.upperH,
      storeys: st.count,
      wallLen: w.len,
    };

    if (w.front && p.units > 1) {
      const unitW = w.len / p.units;

      for (let u = 0; u < p.units; u += 1) {
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
          { ...fp, seed: (seedByte + u * 37) % 256, wallLen: unitW },
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
};

const buildOne = (buckets: Buckets, source: ParcelPlan, detail: DetailLevel) => {
  const roof = roofVariantOf(source);
  const p = roof ? { ...source, height: source.height - roof.rise } : source;

  if (detail === 0) {
    buildLean(buckets, { ...p, ...distantFootprint(p) }, source.height);

    if (roof) {
      historicRoof(buckets.at(bodyTier(source.height), p.obb.cx, p.obb.cz), source, roof, 0);
    }

    return;
  }

  const rng = new Rng(p.seed);
  const walls = wallsOf(p);

  if (walls.length < 3) {
    return;
  }

  const st = storeysOf(p);
  const topY = p.seatY + p.height;
  const colors: ParcelColors[] = [];

  for (let u = 0; u < p.units; u += 1) {
    colors.push(colorsFor(p.kind, p.character, p.blockHash, rng.next(), p.district));
  }

  const share = rng.chance(0.33) ? 0 : litShare(p.kind) * 1.5;
  const litFloor: boolean[] = [];

  for (let s = 0; s <= st.count; s += 1) {
    litFloor.push(rng.chance(share > 0 ? 0.55 : 0));
  }

  const perWindow = share > 0 ? Math.min(1, share * 1.4) : 0;
  const lit = (storey: number) => litFloor[storey] === true && rng.chance(perWindow);
  const bodyTierName = bodyTier(source.height);
  const bodyBucket = buckets.at(bodyTierName, p.obb.cx, p.obb.cz);

  const c: Ctx = {
    bodyBucket,
    colors,
    detail,
    detailAt: (x, z) => buckets.at("detail", x, z),
    lit,
    litFloor,
    p,
    rng,
    st,
    topY,
    walls,
  };

  const kind: ParcelKind = p.kind;

  if (roof) {
    historicRoof(bodyBucket, source, roof, detail);
  }

  switch (kind) {
    case "rowhouse": {
      buildRowhouse(c, false);
      break;
    }

    case "stucco": {
      buildRowhouse(c, true);
      break;
    }

    case "midrise": {
      buildMidrise(c);
      break;
    }

    case "tower": {
      buildTower(c);
      break;
    }

    case "warehouse": {
      buildWarehouse(c);
      break;
    }

    case "shed": {
      buildShed(c);
      break;
    }

    default: {
      kind satisfies never;
    }
  }
};

/**
 * Geometry for every planned parcel, bucketed for the streamer. Deterministic
 * per parcel (its own seeded rng), so a plan always produces the same city.
 * `onBreathe` is called every few hundred parcels for the caller to yield.
 */
export const buildParcelGeometry = async (
  plans: readonly ParcelPlan[],
  detail: DetailLevel,
  onBreathe?: () => Promise<void>,
  lots: readonly ParcelLot[] = [],
) => {
  const buckets = new Buckets();
  let k = 0;

  for (const p of plans) {
    k += 1;

    if (onBreathe && k % 400 === 0) {
      await onBreathe();
    }

    buildOne(buckets, p, detail);
  }

  for (const lot of lots) {
    buildLot(buckets, lot);
  }

  return buckets.flush(detail === 0);
};

/** Resume between parcels; shared buckets preserve exactly the synchronous output. */
export const buildParcelGeometrySteps = function* buildParcelGeometrySteps(
  plans: readonly ParcelPlan[],
  detail: DetailLevel,
  lots: readonly ParcelLot[] = [],
) {
  const buckets = new Buckets();

  for (const p of plans) {
    buildOne(buckets, p, detail);
    yield;
  }

  for (const lot of lots) {
    buildLot(buckets, lot);
    yield;
  }

  return buckets.flush(detail === 0);
};

/** Loading/editor callers can drain the same construction without yielding. */
export const buildParcelGeometrySync = (
  plans: readonly ParcelPlan[],
  detail: DetailLevel,
  lots: readonly ParcelLot[] = [],
) => {
  const steps = buildParcelGeometrySteps(plans, detail, lots);
  let next = steps.next();

  while (next.done !== true) {
    next = steps.next();
  }

  return next.value;
};

/** Cull distance of a tier, in world units (city.ts bands). */
export const tierDistance = (
  tier: MeshTier,
  imposter: number,
  midImposter: number,
  detail: number,
) => {
  switch (tier) {
    case "far": {
      return imposter;
    }

    case "mid": {
      return midImposter;
    }

    case "near": {
      return drawDistance();
    }

    case "detail": {
      return detail;
    }

    default: {
      return tier satisfies never;
    }
  }
};
