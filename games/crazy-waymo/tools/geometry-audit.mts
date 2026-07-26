// Deterministic geometry audit of the SHIPPED world: does anything stand in a
// street, interpenetrate a neighbour, float over its surface, or squat on a
// landmark parcel? Every answer here is measured, not eyeballed.
//
// Two data sources, both headless:
//   * the baked artifacts in public/world (`loadBakedRest`) — the world players
//     actually get: every collision solid (44.8k oriented boxes) and every
//     batched prop instance with its world matrix and source GLB;
//   * a live regeneration of the planar world (plan + network + terrain +
//     drape), which is what the placement passes consulted when they ran.
//
// tools/test-world.mts imports the report functions and asserts bounds on them,
// so a regression fails `pnpm test` instead of waiting to be spotted in a
// screenshot. For the full listing (histograms, every offender, per-landmark
// parcel census) run the module with the report flag set — vite-node does not
// pass the entry path through argv, hence an env flag rather than an argv one:
//   AUDIT_REPORT=1 pnpm vite-node tools/geometry-audit.mts
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { GRID_X, GRID_Z, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../src/shared/constants.ts";
import type { Solid } from "../src/shared/types.ts";
import type { CityRestPayload } from "../src/world/city.ts";
import { generateCity } from "../src/world/grid.ts";
import {
  makeGroundOffset,
  makeStandingSurface,
  makeTerracedDrapeField,
} from "../src/world/ground.ts";
import { freewayPillars } from "../src/world/freeways.ts";
import { landmarkMarkers, landmarkProtection } from "../src/world/landmarks.ts";
import { RoadNetwork } from "../src/world/network.ts";
import { SF_FOOTPRINTS } from "../src/world/sf-footprints.ts";
import { prismSpec } from "../src/world/sf-prisms.ts";
import { makeTerrain } from "../src/world/sf-map.ts";
import type { Terrain } from "../src/world/terrain.ts";
import { deserializeWorldBin, unpackRest, WORLD_REV } from "../src/world/world-bin.ts";

// --- baked artifacts --------------------------------------------------------

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/**
 * A shipped artifact, gunzipped and rejoined — the bake writes them gzipped
 * (world-fetch.ts inflates in the browser) and splits anything over 9MB into
 * `.0..N` parts with a `.parts` count (tools/split-world-bin.mjs).
 */
function readArtifact(name: string): ArrayBuffer {
  const whole = `public/world/${name}.bin`;
  if (existsSync(whole)) return toArrayBuffer(gunzipSync(readFileSync(whole)));
  const parts = Number(readFileSync(`public/world/${name}.parts`, "utf8").trim());
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < parts; i++) chunks.push(readFileSync(`public/world/${name}.bin.${i}`));
  return toArrayBuffer(gunzipSync(Buffer.concat(chunks)));
}

export type BakedRest = { readonly rev: number; readonly rest: CityRestPayload };

/** The shipped rest.bin: solids, batched prop instances, parked cars, decks. */
export async function loadBakedRest(): Promise<BakedRest> {
  const back = deserializeWorldBin(readArtifact("rest"));
  if (back.rest === undefined) throw new Error("rest.bin carries no rest payload");
  return { rev: back.rev, rest: await unpackRest(back.rest) };
}

export const BAKED_WORLD_REV = WORLD_REV;

// --- oriented boxes ---------------------------------------------------------

export type Obb = {
  readonly cx: number;
  readonly cz: number;
  readonly hx: number; // half extent along local X
  readonly hz: number; // half extent along local Z
  readonly yaw: number;
};

export function solidObb(s: Solid): Obb {
  return {
    cx: (s.minX + s.maxX) / 2,
    cz: (s.minZ + s.maxZ) / 2,
    hx: (s.maxX - s.minX) / 2,
    hz: (s.maxZ - s.minZ) / 2,
    yaw: s.yaw ?? 0,
  };
}

/**
 * Corners in world space. `yaw` is the three.js `rotation.y` the Solid docs
 * name, so local +X maps to world (cos, −sin) in XZ — the SAME basis
 * `car.ts collideOne` inverts. Mirroring it (the easy mistake: +sin) rotates
 * every avenue-aligned box the wrong way and invents defects wholesale.
 */
export function obbCorners(o: Obb): readonly (readonly [number, number])[] {
  const c = Math.cos(o.yaw);
  const s = Math.sin(o.yaw);
  const out: [number, number][] = [];
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const lx = sx * o.hx;
    const lz = sz * o.hz;
    out.push([o.cx + lx * c + lz * s, o.cz - lx * s + lz * c]);
  }
  return out;
}

export function obbArea(o: Obb): number {
  return 4 * o.hx * o.hz;
}

function obbContains(o: Obb, x: number, z: number): boolean {
  const c = Math.cos(o.yaw);
  const s = Math.sin(o.yaw);
  const dx = x - o.cx;
  const dz = z - o.cz;
  // world → local, exactly as car.ts collideOne inverts the rotation.
  return Math.abs(dx * c - dz * s) <= o.hx && Math.abs(dx * s + dz * c) <= o.hz;
}

/** Separating-axis penetration depth (0 = disjoint or touching). */
export function obbPenetration(a: Obb, b: Obb): number {
  const axes: [number, number][] = [];
  for (const o of [a, b]) {
    const c = Math.cos(o.yaw);
    const s = Math.sin(o.yaw);
    axes.push([c, s], [-s, c]);
  }
  const ca = obbCorners(a);
  const cb = obbCorners(b);
  let depth = Infinity;
  for (const [ax, az] of axes) {
    let aMin = Infinity;
    let aMax = -Infinity;
    for (const [x, z] of ca) {
      const p = x * ax + z * az;
      if (p < aMin) aMin = p;
      if (p > aMax) aMax = p;
    }
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const [x, z] of cb) {
      const p = x * ax + z * az;
      if (p < bMin) bMin = p;
      if (p > bMax) bMax = p;
    }
    const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
    if (overlap <= 0) return 0;
    if (overlap < depth) depth = overlap;
  }
  return depth === Infinity ? 0 : depth;
}

/** Intersection AREA of two convex boxes (Sutherland–Hodgman clip). */
export function obbOverlapArea(a: Obb, b: Obb): number {
  let poly: (readonly [number, number])[] = [...obbCorners(a)];
  const clip = obbCorners(b);
  for (let i = 0; i < clip.length && poly.length > 0; i++) {
    const p0 = clip[i];
    const p1 = clip[(i + 1) % clip.length];
    if (!p0 || !p1) continue;
    // Clip polygon is wound consistently by obbCorners; inside = left of edge.
    const ex = p1[0] - p0[0];
    const ez = p1[1] - p0[1];
    const side = (p: readonly [number, number]): number =>
      ex * (p[1] - p0[1]) - ez * (p[0] - p0[0]);
    const next: (readonly [number, number])[] = [];
    for (let k = 0; k < poly.length; k++) {
      const cur = poly[k];
      const prv = poly[(k + poly.length - 1) % poly.length];
      if (!cur || !prv) continue;
      const dCur = side(cur);
      const dPrv = side(prv);
      if (dCur >= 0) {
        if (dPrv < 0) {
          const t = dPrv / (dPrv - dCur);
          next.push([prv[0] + (cur[0] - prv[0]) * t, prv[1] + (cur[1] - prv[1]) * t]);
        }
        next.push(cur);
      } else if (dPrv >= 0) {
        const t = dPrv / (dPrv - dCur);
        next.push([prv[0] + (cur[0] - prv[0]) * t, prv[1] + (cur[1] - prv[1]) * t]);
      }
    }
    poly = next;
  }
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    if (!p || !q) continue;
    area += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(area) / 2;
}

// --- u/v addressing (matches the __taxi dev hooks) --------------------------

export function uOf(x: number): number {
  return x / (WORLD_HALF_X * 2) + 0.5;
}
export function vOf(z: number): number {
  return z / (WORLD_HALF_Z * 2) + 0.5;
}
/** 4 decimals ≈ 0.3u — precise enough to park a freecam on the offender. */
export function uv(x: number, z: number): string {
  return `u${uOf(x).toFixed(4)} v${vOf(z).toFixed(4)}`;
}
export function gridXOf(x: number): number {
  return Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
}
export function gridZOf(z: number): number {
  return Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);
}
export function inGrid(gx: number, gz: number): boolean {
  return gx >= 0 && gz >= 0 && gx < GRID_X && gz < GRID_Z;
}

// --- spatial pairing --------------------------------------------------------

type Aabb = { minX: number; maxX: number; minZ: number; maxZ: number };

function obbAabb(o: Obb): Aabb {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of obbCorners(o)) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * Every AABB-overlapping pair of boxes, once each, via a uniform bucket grid.
 * 45k solids is 1e9 naive pairs and ~200k real neighbours.
 */
export function forEachNeighbourPair(
  boxes: readonly Obb[],
  visit: (i: number, j: number) => void,
): void {
  const CELL = 12;
  const buckets = new Map<number, number[]>();
  const aabbs = boxes.map(obbAabb);
  const key = (bx: number, bz: number): number => bx * 100003 + bz;
  for (let i = 0; i < boxes.length; i++) {
    const bb = aabbs[i];
    if (!bb) continue;
    for (let bx = Math.floor(bb.minX / CELL); bx <= Math.floor(bb.maxX / CELL); bx++) {
      for (let bz = Math.floor(bb.minZ / CELL); bz <= Math.floor(bb.maxZ / CELL); bz++) {
        const k = key(bx, bz);
        const list = buckets.get(k);
        if (list) list.push(i);
        else buckets.set(k, [i]);
      }
    }
  }
  const seen = new Set<number>();
  for (const list of buckets.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a];
        const j = list[b];
        if (i === undefined || j === undefined) continue;
        const lo = Math.min(i, j);
        const hi = Math.max(i, j);
        const pk = lo * 65536 + hi;
        if (seen.has(pk)) continue;
        seen.add(pk);
        const A = aabbs[lo];
        const B = aabbs[hi];
        if (!A || !B) continue;
        if (A.maxX <= B.minX || B.maxX <= A.minX || A.maxZ <= B.minZ || B.maxZ <= A.minZ) continue;
        visit(lo, hi);
      }
    }
  }
}

// --- 1. solid-vs-solid interpenetration ------------------------------------

/**
 * Buildings in this city are DELIBERATELY ATTACHED (the lot-line fabric walks
 * real party-wall data), so touching — and a shared wall band — is correct.
 * A defect is a box that eats a MEANINGFUL share of its neighbour's plan:
 * either overlap area over `areaShare` of the smaller box, or one box's centre
 * inside the other. Depth alone cannot separate the two: a 1.6u-thick party
 * wall strip legitimately overlaps its neighbour's OBB by its whole thickness.
 */
export type OverlapDefect = {
  readonly i: number;
  readonly j: number;
  readonly depth: number;
  readonly area: number;
  readonly share: number; // area / smaller box area
  readonly centreInside: boolean;
  readonly x: number;
  readonly z: number;
};

export type OverlapReport = {
  readonly pairs: number; // AABB-overlapping pairs tested
  readonly touching: number; // any positive penetration
  readonly depthHistogram: readonly (readonly [string, number])[];
  readonly shareHistogram: readonly (readonly [string, number])[];
  readonly defects: readonly OverlapDefect[];
};

export function overlapReport(
  boxes: readonly Obb[],
  opts: { readonly areaShare: number; readonly minArea: number },
): OverlapReport {
  const depthBands = [0.1, 0.25, 0.5, 1, 2, 4, 8, Infinity];
  const shareBands = [0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, Infinity];
  const depthCount = new Array<number>(depthBands.length).fill(0);
  const shareCount = new Array<number>(shareBands.length).fill(0);
  const defects: OverlapDefect[] = [];
  let pairs = 0;
  let touching = 0;
  forEachNeighbourPair(boxes, (i, j) => {
    pairs++;
    const a = boxes[i];
    const b = boxes[j];
    if (!a || !b) return;
    const depth = obbPenetration(a, b);
    if (depth <= 0) return;
    touching++;
    const area = obbOverlapArea(a, b);
    const smaller = Math.min(obbArea(a), obbArea(b));
    const share = smaller > 0 ? area / smaller : 0;
    for (let k = 0; k < depthBands.length; k++) {
      if (depth < (depthBands[k] ?? Infinity)) {
        depthCount[k] = (depthCount[k] ?? 0) + 1;
        break;
      }
    }
    for (let k = 0; k < shareBands.length; k++) {
      if (share < (shareBands[k] ?? Infinity)) {
        shareCount[k] = (shareCount[k] ?? 0) + 1;
        break;
      }
    }
    const centreInside = obbContains(a, b.cx, b.cz) || obbContains(b, a.cx, a.cz);
    if (area < opts.minArea) return;
    if (share < opts.areaShare && !centreInside) return;
    defects.push({
      i,
      j,
      depth,
      area,
      share,
      centreInside,
      x: (a.cx + b.cx) / 2,
      z: (a.cz + b.cz) / 2,
    });
  });
  defects.sort((p, q) => q.share * q.area - p.share * p.area);
  const label = (bands: readonly number[], k: number): string => {
    const lo = k === 0 ? 0 : (bands[k - 1] ?? 0);
    const hi = bands[k] ?? Infinity;
    return hi === Infinity ? `>=${lo}` : `${lo}-${hi}`;
  };
  return {
    pairs,
    touching,
    depthHistogram: depthBands.map((_, k) => [label(depthBands, k), depthCount[k] ?? 0] as const),
    shareHistogram: shareBands.map((_, k) => [label(shareBands, k), shareCount[k] ?? 0] as const),
    defects,
  };
}

// --- 2/3. anything standing in the travel surface ---------------------------

export type OnAsphalt = (x: number, z: number, margin: number) => boolean;

/** city.ts's own asphalt test, rebuilt against the same network. */
export function makeOnAsphalt(network: RoadNetwork): OnAsphalt {
  return (x: number, z: number, margin: number): boolean => {
    const hit = network.nearest(x, z, ROAD_TILE * 1.4);
    return hit !== null && hit.dist < hit.edge.half + margin;
  };
}

/** Depth of a point INSIDE the drawn asphalt (0 outside / on the kerb). */
export function asphaltDepth(network: RoadNetwork, x: number, z: number): number {
  const hit = network.nearest(x, z, ROAD_TILE * 1.4);
  if (!hit) return 0;
  return Math.max(0, hit.edge.half - hit.dist);
}

export type RoadIntrusion = {
  readonly index: number;
  readonly depth: number; // metres inside the asphalt edge
  readonly x: number;
  readonly z: number;
  readonly obb: Obb;
};

/**
 * Corners AND edge midpoints of every box against the asphalt. Midpoints
 * matter: a long wall can cross a narrow street between its corners.
 * `minDepth` is the "genuinely in the travel surface, not merely touching the
 * kerb" threshold — the passes themselves clear the kerb by 0.2-0.6u.
 */
export function roadIntrusions(
  boxes: readonly Obb[],
  network: RoadNetwork,
  minDepth: number,
): readonly RoadIntrusion[] {
  const out: RoadIntrusion[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const o = boxes[i];
    if (!o) continue;
    const corners = obbCorners(o);
    let worst = 0;
    let wx = o.cx;
    let wz = o.cz;
    for (let k = 0; k < corners.length; k++) {
      const p = corners[k];
      const q = corners[(k + 1) % corners.length];
      if (!p || !q) continue;
      for (const [x, z] of [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as const]) {
        const d = asphaltDepth(network, x, z);
        if (d > worst) {
          worst = d;
          wx = x;
          wz = z;
        }
      }
    }
    if (worst > minDepth) out.push({ index: i, depth: worst, x: wx, z: wz, obb: o });
  }
  out.sort((a, b) => b.depth - a.depth);
  return out;
}

// --- prop instances (the batched world) ------------------------------------

export type PropInstance = {
  readonly url: string; // source GLB, or "raw:<n>" for procedural geometry
  readonly x: number;
  readonly y: number; // the instance's own origin height
  readonly z: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
};

/**
 * Every batched instance with its world origin and scale, named by source.
 * Procedural geometry has no url, so it is labelled by its rawGeo slot plus its
 * material colour and vertex count — enough to identify it in roads.ts /
 * furniture.ts / city.ts (e.g. `raw:0 #b3aca0 v24` is the shared PLINTH box).
 */
export function propInstances(rest: CityRestPayload): readonly PropInstance[] {
  const rawLabel = rest.rawGeos.map((g, i) => {
    const hex = g.mat.color.toString(16).padStart(6, "0");
    return `raw:${i} #${hex} v${g.position.length / 3}`;
  });
  const out: PropInstance[] = [];
  for (const it of rest.batchItems) {
    const m = it.m;
    const col = (k: number): number =>
      Math.hypot(m[k * 4] ?? 0, m[k * 4 + 1] ?? 0, m[k * 4 + 2] ?? 0);
    out.push({
      url: it.url ?? rawLabel[it.raw ?? -1] ?? `raw:${it.raw ?? -1}`,
      x: m[12] ?? 0,
      y: m[13] ?? 0,
      z: m[14] ?? 0,
      sx: col(0),
      sy: col(1),
      sz: col(2),
    });
  }
  return out;
}

/** Last path segment of a model url, minus the extension ("prop-bench"). */
export function propName(url: string): string {
  if (url.startsWith("raw:")) return url;
  const tail = url.split("/").pop() ?? url;
  return tail.replace(/\.(glb|gltf)$/, "");
}

// --- 4. seat height: floating and buried -----------------------------------

export type SeatOutlier = {
  readonly url: string;
  readonly x: number;
  readonly z: number;
  readonly offset: number; // y − standing surface
  readonly deviation: number; // offset − what this url's own baseline predicts
};

export type SeatGroup = {
  readonly url: string;
  readonly count: number;
  readonly medianOffset: number; // origin height above the standing surface, per unit of Y scale
  readonly medianTerrainOffset: number; // the same against the RAW height field
  /**
   * Median absolute deviation of the offset, in world units — how tightly this
   * kind tracks the surface at all. A kerbside prop sits at 0.0-0.1u; a rooftop
   * watertower or a chimney is placed on a building and scatters by metres, so
   * it has no ground seat to be wrong about and is excluded from the counts.
   */
  readonly seatSpread: number;
  /** Relative spread of the Y scale: a kit prop is fitted to a fixed height. */
  readonly scaleVariation: number;
  readonly seated: boolean; // a fixed-scale prop that tracks the drawn surface
  readonly wrongSurface: boolean; // tracks the raw field better than the drawn one
  readonly floating: number;
  readonly buried: number;
};

export type SeatReport = {
  readonly groups: readonly SeatGroup[];
  readonly outliers: readonly SeatOutlier[];
  readonly floating: number;
  readonly buried: number;
  readonly wrongSurfaceInstances: number;
};

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Nothing in this world sits on `terrain.heightAt` (see CLAUDE.md): props seat
 * on `makeStandingSurface`. A model's own origin may sit anywhere in its
 * bounds, so the absolute offset says nothing — what a defect looks like is an
 * instance that disagrees with the REST of its own kind. Each url is therefore
 * its own baseline, and a whole url whose baseline tracks the raw field instead
 * of the drawn surface is the "seated on the wrong surface" bug in one number.
 *
 * The baseline is per unit of Y SCALE, because that is what an origin offset
 * scales with: a kit house fitted to 3 storeys carries its pivot three times as
 * far above its own feet as the same model fitted to one, and comparing the two
 * in raw world units would call every tall instance "floating".
 */
export function seatReport(
  props: readonly PropInstance[],
  standAt: (x: number, z: number) => number,
  terrainAt: (x: number, z: number) => number,
  opts: {
    readonly floatGap: number;
    readonly buryDepth: number;
    readonly minCount: number;
    readonly groundSpread: number;
  },
): SeatReport {
  const byUrl = new Map<string, { off: number[]; terr: number[]; items: PropInstance[] }>();
  for (const p of props) {
    const bucket = byUrl.get(p.url) ?? { off: [], terr: [], items: [] };
    const sy = Math.max(p.sy, 0.02);
    bucket.off.push((p.y - standAt(p.x, p.z)) / sy);
    bucket.terr.push((p.y - terrainAt(p.x, p.z)) / sy);
    bucket.items.push(p);
    byUrl.set(p.url, bucket);
  }
  const groups: SeatGroup[] = [];
  const outliers: SeatOutlier[] = [];
  let floating = 0;
  let buried = 0;
  let wrongSurfaceInstances = 0;
  for (const [url, bucket] of byUrl) {
    const med = median(bucket.off);
    const medTerr = median(bucket.terr);
    const scale = median(bucket.items.map((p) => Math.max(p.sy, 0.02)));
    const spread = (v: readonly number[], m: number): number =>
      median(v.map((x) => Math.abs(x - m))) * scale;
    const seatSpread = spread(bucket.off, med);
    const scaleVariation =
      median(bucket.items.map((p) => Math.abs(Math.max(p.sy, 0.02) - scale))) / scale;
    // Buildings and their foundations are exempt: the fabric pass owns its own
    // grade rule (STEP_INTO_SLOPE cuts in, a plinth fills what is left under the
    // low corner), so a mass legitimately sits metres above its downhill kerb.
    // What is left is the fixed-scale kit furniture — the class CLAUDE.md's
    // "seated on the raw field" bug actually buried and floated.
    const seated =
      seatSpread <= opts.groundSpread && scaleVariation <= 0.25 && !url.includes("/buildings/");
    let fl = 0;
    let bu = 0;
    if (seated) {
      for (let i = 0; i < bucket.items.length; i++) {
        const item = bucket.items[i];
        const ratio = bucket.off[i];
        if (!item || ratio === undefined) continue;
        const sy = Math.max(item.sy, 0.02);
        const dev = (ratio - med) * sy; // back into world units
        if (dev > opts.floatGap) fl++;
        else if (dev < -opts.buryDepth) bu++;
        else continue;
        outliers.push({ url, x: item.x, z: item.z, offset: ratio * sy, deviation: dev });
      }
    }
    // A ground prop whose spread against the RAW field is TIGHTER than against
    // the drawn one was seated on the raw field: the terrace/drape delta shows
    // up as scatter on whichever surface it was not seated on. (Buildings are
    // exempt by design — a mass cuts into its own grade, see STEP_INTO_SLOPE.)
    const wrongSurface =
      seated &&
      bucket.items.length >= opts.minCount &&
      spread(bucket.terr, medTerr) + 0.05 < seatSpread;
    if (wrongSurface) wrongSurfaceInstances += bucket.items.length;
    floating += fl;
    buried += bu;
    groups.push({
      url,
      count: bucket.items.length,
      medianOffset: med,
      medianTerrainOffset: medTerr,
      seatSpread,
      scaleVariation,
      seated,
      wrongSurface,
      floating: fl,
      buried: bu,
    });
  }
  outliers.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));
  groups.sort((a, b) => b.floating + b.buried - (a.floating + a.buried));
  return { groups, outliers, floating, buried, wrongSurfaceInstances };
}

// --- 5. landmark parcels ---------------------------------------------------

export type LandmarkIntruder = {
  readonly landmark: string;
  readonly what: string;
  readonly x: number;
  readonly z: number;
};

export type LandmarkReport = {
  readonly landmarks: readonly { readonly name: string; readonly cells: number }[];
  readonly reservedCells: number;
  readonly intruders: readonly LandmarkIntruder[];
};

/**
 * Wave 0 shipped a procedural skyscraper standing inside Oracle Park's bowl
 * because the reservations had not been re-baked. The reservation is a CELL
 * set, so this asks the shipped artifacts the direct question: does any baked
 * building instance, or any collision box the landmark pass did not itself
 * emit, stand in a reserved cell?
 */
export function landmarkReport(
  props: readonly PropInstance[],
  solids: readonly Solid[],
  network: RoadNetwork,
  plan: ReturnType<typeof generateCity>,
): LandmarkReport {
  const prot = landmarkProtection(plan, network);
  const markers = landmarkMarkers(network);
  const own = new Set<string>();
  for (const s of prot.solids) {
    own.add(`${s.minX.toFixed(2)},${s.maxX.toFixed(2)},${s.minZ.toFixed(2)},${s.maxZ.toFixed(2)}`);
  }
  const nearestLandmark = (x: number, z: number): string => {
    let best = "?";
    let bestD = Infinity;
    for (const m of markers) {
      const d = (m.x - x) ** 2 + (m.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = m.name;
      }
    }
    return best;
  };
  const cellsPer = new Map<string, number>();
  for (const key of prot.reserved) {
    const [gxs, gzs] = key.split(",");
    const gx = Number(gxs);
    const gz = Number(gzs);
    const x = (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
    const z = (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
    const name = nearestLandmark(x, z);
    cellsPer.set(name, (cellsPer.get(name) ?? 0) + 1);
  }
  const intruders: LandmarkIntruder[] = [];
  for (const p of props) {
    if (!p.url.includes("/buildings/")) continue;
    const key = `${gridXOf(p.x)},${gridZOf(p.z)}`;
    if (!prot.reserved.has(key)) continue;
    intruders.push({
      landmark: nearestLandmark(p.x, p.z),
      what: `building instance ${propName(p.url)}`,
      x: p.x,
      z: p.z,
    });
  }
  for (const s of solids) {
    const w = s.maxX - s.minX;
    const d = s.maxZ - s.minZ;
    if (w < 2 && d < 2) continue; // trees/furniture: not a building mass
    if (w > 200 || d > 200) continue; // map-edge walls
    const cx = (s.minX + s.maxX) / 2;
    const cz = (s.minZ + s.maxZ) / 2;
    if (!prot.reserved.has(`${gridXOf(cx)},${gridZOf(cz)}`)) continue;
    if (
      own.has(`${s.minX.toFixed(2)},${s.maxX.toFixed(2)},${s.minZ.toFixed(2)},${s.maxZ.toFixed(2)}`)
    ) {
      continue; // the landmark pass's own collision box
    }
    intruders.push({
      landmark: nearestLandmark(cx, cz),
      what: `solid ${w.toFixed(1)}x${d.toFixed(1)}u`,
      x: cx,
      z: cz,
    });
  }
  return {
    landmarks: markers.map((m) => ({ name: m.name, cells: cellsPer.get(m.name) ?? 0 })),
    reservedCells: prot.reserved.size,
    intruders,
  };
}

// --- 6. street grade -------------------------------------------------------

export type GradeReport = {
  readonly edges: number;
  readonly worstChord: number;
  readonly worstChordAt: string;
  readonly worstLocal: number;
  readonly worstLocalAt: string;
  readonly overChord: number; // edges whose end-to-end grade exceeds the cap
  readonly overLocal: number;
  readonly histogram: readonly (readonly [string, number])[];
};

/**
 * Measured on the surface that is DRAWN (the terraced road drape), not on the
 * raw height field: `MAX_RAMP_GRADE` is what the terrace pass aims for, and
 * what it actually achieves is the only thing a car has to climb. Local grade
 * is sampled over a `window`-long chord so a single landing lip (deliberately
 * hard — cresting an intersection is the SF hop) does not read as a cliff.
 */
export function gradeReport(
  network: RoadNetwork,
  drapeHeightAt: (x: number, z: number) => number,
  cap: number,
  window = 8,
): GradeReport {
  const bands = [0.1, 0.2, 0.3, 0.42, 0.6, 0.8, Infinity];
  const counts = new Array<number>(bands.length).fill(0);
  let worstChord = 0;
  let worstChordAt = "";
  let worstLocal = 0;
  let worstLocalAt = "";
  let overChord = 0;
  let overLocal = 0;
  for (const e of network.edges) {
    if (e.len < 1) continue;
    const a = network.sample(e, 0);
    const b = network.sample(e, e.len);
    const chord = Math.abs(drapeHeightAt(b.x, b.z) - drapeHeightAt(a.x, a.z)) / e.len;
    if (chord > worstChord) {
      worstChord = chord;
      worstChordAt = `edge ${e.id} ${uv(a.x, a.z)} len ${e.len.toFixed(0)}u`;
    }
    if (chord > cap) overChord++;
    for (let k = 0; k < bands.length; k++) {
      if (chord < (bands[k] ?? Infinity)) {
        counts[k] = (counts[k] ?? 0) + 1;
        break;
      }
    }
    let local = 0;
    let localAt = "";
    for (let s = 0; s + window <= e.len; s += window / 2) {
      const p = network.sample(e, s);
      const q = network.sample(e, s + window);
      const g = Math.abs(drapeHeightAt(q.x, q.z) - drapeHeightAt(p.x, p.z)) / window;
      if (g > local) {
        local = g;
        localAt = `edge ${e.id} ${uv(p.x, p.z)}`;
      }
    }
    if (local > cap) overLocal++;
    if (local > worstLocal) {
      worstLocal = local;
      worstLocalAt = localAt;
    }
  }
  return {
    edges: network.edges.length,
    worstChord,
    worstChordAt,
    worstLocal,
    worstLocalAt,
    overChord,
    overLocal,
    histogram: bands.map((_, k) => {
      const lo = k === 0 ? 0 : (bands[k - 1] ?? 0);
      const hi = bands[k] ?? Infinity;
      return [hi === Infinity ? `>=${lo}` : `${lo}-${hi}`, counts[k] ?? 0] as const;
    }),
  };
}

// --- the regenerated planar world ------------------------------------------

/** Below this a solid is street furniture, not a building mass. */
export const BUILDING_MIN_SIDE = 2.2;

export type AuditWorld = {
  readonly plan: ReturnType<typeof generateCity>;
  readonly network: RoadNetwork;
  readonly terrain: Terrain;
  readonly drapeAt: (x: number, z: number) => number;
  readonly standAt: (x: number, z: number) => number;
  readonly terrainAt: (x: number, z: number) => number;
};

/** Plan + network + the two surfaces that actually get drawn (~2s). */
export function buildAuditWorld(): AuditWorld {
  const plan = generateCity();
  const network = new RoadNetwork();
  const terrain = makeTerrain();
  const drape = makeTerracedDrapeField(network, terrain);
  const groundOffset = makeGroundOffset(network, terrain);
  const standAt = makeStandingSurface(network, terrain, groundOffset, drape);
  return {
    plan,
    network,
    terrain,
    drapeAt: (x, z) => drape.heightAt(x, z),
    standAt,
    terrainAt: (x, z) => terrain.heightAt(x, z),
  };
}

// --- which pass placed this box --------------------------------------------

/**
 * Solids carry no provenance tag, so attribution is by RECONSTRUCTION: the
 * passes whose geometry is pure data (landmark reservations, freeway pillars,
 * the seawall ring, the real-footprint prisms) are recomputed and matched by
 * position, and the kit fabric is recognised by the batched building instance
 * standing in the same spot. Only the frontage/back-row/infill walk shares one
 * rng stream with the rest of city.ts, which is why it is identified through
 * its model instance rather than by replaying the walk.
 */
export type SolidClass =
  | "landmark"
  | "map-border"
  | "freeway-pillar"
  | "seawall"
  | "garage"
  | "tree"
  | "furniture"
  | "real-footprint"
  | "kit-building"
  | "unclassified";

class PointIndex {
  private readonly cells = new Map<number, [number, number][]>();
  constructor(private readonly cell: number) {}
  add(x: number, z: number): void {
    const k = Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell);
    const list = this.cells.get(k);
    if (list) list.push([x, z]);
    else this.cells.set(k, [[x, z]]);
  }
  has(x: number, z: number, radius: number): boolean {
    const gx = Math.floor(x / this.cell);
    const gz = Math.floor(z / this.cell);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const [px, pz] of this.cells.get((gx + i) * 100003 + gz + j) ?? []) {
          if (Math.hypot(px - x, pz - z) <= radius) return true;
        }
      }
    }
    return false;
  }
}

export function classifySolids(
  solids: readonly Solid[],
  world: AuditWorld,
  props: readonly PropInstance[],
): readonly SolidClass[] {
  const prot = landmarkProtection(world.plan, world.network);
  const landmarkBoxes = new Set<string>();
  const boxKey = (s: Solid): string =>
    `${s.minX.toFixed(2)},${s.maxX.toFixed(2)},${s.minZ.toFixed(2)},${s.maxZ.toFixed(2)}`;
  for (const s of prot.solids) landmarkBoxes.add(boxKey(s));

  const pillars = new PointIndex(16);
  for (const p of freewayPillars(world.terrain, world.network)) pillars.add(p.x, p.z);

  // Real footprints: the rectangle case is one box on the parcel centroid, an
  // irregular ring is one thin OBB per wall (city.ts wallOBB).
  const parcels = new PointIndex(8);
  for (const flat of SF_FOOTPRINTS) {
    const spec = prismSpec(flat);
    if (!spec) continue;
    parcels.add(spec.cx, spec.cz);
    const n = spec.rel.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      parcels.add(
        spec.cx + ((spec.rel[i * 2] ?? 0) + (spec.rel[j * 2] ?? 0)) / 2,
        spec.cz + ((spec.rel[i * 2 + 1] ?? 0) + (spec.rel[j * 2 + 1] ?? 0)) / 2,
      );
    }
  }

  const kitBuildings = new PointIndex(8);
  for (const p of props) {
    if (p.url.includes("/buildings/")) kitBuildings.add(p.x, p.z);
  }

  const SEAWALL_SIDE = ROAD_TILE * 0.92;
  const GARAGE_SIDE = ROAD_TILE * 0.84;
  return solids.map((s): SolidClass => {
    const w = s.maxX - s.minX;
    const d = s.maxZ - s.minZ;
    const cx = (s.minX + s.maxX) / 2;
    const cz = (s.minZ + s.maxZ) / 2;
    if (Math.max(w, d) > 200) return "map-border";
    if (landmarkBoxes.has(boxKey(s))) return "landmark";
    if (s.noBody === true && w < 1.5 && d < 1.5) return "tree";
    if (
      s.yaw === undefined &&
      Math.abs(w - SEAWALL_SIDE) < 0.2 &&
      Math.abs(d - SEAWALL_SIDE) < 0.2 &&
      world.plan.cells[gridXOf(cx)]?.[gridZOf(cz)] === "water"
    ) {
      return "seawall";
    }
    if (s.yaw === undefined && Math.abs(w - GARAGE_SIDE) < 0.2 && Math.abs(d - GARAGE_SIDE) < 0.2) {
      return "garage";
    }
    if (pillars.has(cx, cz, 1.2)) return "freeway-pillar";
    if (parcels.has(cx, cz, 0.6)) return "real-footprint";
    if (kitBuildings.has(cx, cz, 0.8)) return "kit-building";
    if (Math.min(w, d) < BUILDING_MIN_SIDE) return "furniture";
    return "unclassified";
  });
}

// --- standalone report ------------------------------------------------------

/** Solids big enough to be a building mass (and not a map-edge wall). */
export function buildingSolids(solids: readonly Solid[]): readonly Solid[] {
  return solids.filter((s) => {
    const w = s.maxX - s.minX;
    const d = s.maxZ - s.minZ;
    return Math.min(w, d) >= BUILDING_MIN_SIDE && Math.max(w, d) < 200 && s.unseen === undefined;
  });
}

/**
 * On the asphalt BY DESIGN: furniture.ts's construction pockets opt in
 * explicitly ("chicanes live on the asphalt by design") and park a work vehicle
 * behind each chicane. Anything else standing in a lane is a defect.
 */
export const ROADWORKS_PROPS: ReadonlySet<string> = new Set([
  "construction-cone",
  "construction-barrier",
  "construction-light",
  "tractor",
  "tractor-shovel",
]);

/**
 * Height above the standing surface past which an instance is OVERHEAD rather
 * than an obstruction: catenary spans, signal arms, awnings and fire escapes
 * reach out over the roadway on purpose, and only their origin's x/z would ever
 * suggest otherwise.
 */
export const GROUND_LEVEL_MAX = 2.5;

/** Ground-level instances standing deeper than `minDepth` inside the asphalt. */
export function propsInRoadway(
  props: readonly PropInstance[],
  network: RoadNetwork,
  standAt: (x: number, z: number) => number,
  minDepth: number,
): readonly { readonly prop: PropInstance; readonly depth: number }[] {
  const out: { prop: PropInstance; depth: number }[] = [];
  for (const p of props) {
    if (ROADWORKS_PROPS.has(propName(p.url))) continue;
    const depth = asphaltDepth(network, p.x, p.z);
    if (depth <= minDepth) continue;
    if (p.y - standAt(p.x, p.z) > GROUND_LEVEL_MAX) continue;
    out.push({ prop: p, depth });
  }
  out.sort((a, b) => b.depth - a.depth);
  return out;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const { rev, rest } = await loadBakedRest();
  const world = buildAuditWorld();
  const props = propInstances(rest);
  const cls = classifySolids(rest.solids, world, props);
  const tally = new Map<SolidClass, number>();
  for (const c of cls) tally.set(c, (tally.get(c) ?? 0) + 1);
  console.log(
    `rest.bin rev ${rev} (code ${WORLD_REV}): ${rest.solids.length} solids, ` +
      `${props.length} batched instances, ${rest.parkedCars.length} parked cars, ` +
      `${rest.mergedChunks.length} merged chunks — loaded in ${Date.now() - t0}ms`,
  );
  console.log(
    `  solids by pass: ${[...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join("  ")}`,
  );

  // Masses = everything with a building-scale footprint. Trees, furniture and
  // the map border are audited separately; the seawall ring is a mass.
  const massIdx: number[] = [];
  for (let i = 0; i < rest.solids.length; i++) {
    const c = cls[i];
    if (c === "map-border" || c === "tree" || c === "furniture") continue;
    massIdx.push(i);
  }
  const massBoxes = massIdx.map((i) =>
    solidObb(rest.solids[i] ?? { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }),
  );
  const classOf = (k: number): SolidClass => cls[massIdx[k] ?? 0] ?? "unclassified";

  const ov = overlapReport(massBoxes, { areaShare: 0.28, minArea: 2 });
  console.log(`\n--- 1. solid interpenetration (${massBoxes.length} building-scale boxes)`);
  console.log(`  ${ov.pairs} neighbour pairs, ${ov.touching} with positive penetration`);
  console.log(`  depth histogram: ${ov.depthHistogram.map(([k, v]) => `${k}:${v}`).join("  ")}`);
  console.log(`  share histogram: ${ov.shareHistogram.map(([k, v]) => `${k}:${v}`).join("  ")}`);
  console.log(
    `  defects (share >= 28% of the smaller box, or a centre inside): ${ov.defects.length}`,
  );
  const pairTally = new Map<string, number>();
  for (const d of ov.defects) {
    const key = [classOf(d.i), classOf(d.j)].sort().join(" x ");
    pairTally.set(key, (pairTally.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...pairTally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k}: ${v}`);
  }
  for (const d of ov.defects.slice(0, 24)) {
    console.log(
      `    ${uv(d.x, d.z)} ${classOf(d.i)} x ${classOf(d.j)} depth ${d.depth.toFixed(2)}u ` +
        `area ${d.area.toFixed(1)}u2 share ${(d.share * 100).toFixed(0)}%` +
        `${d.centreInside ? " CENTRE-INSIDE" : ""}`,
    );
  }

  console.log(`\n--- 2. masses in the roadway (>0.5u past the kerb)`);
  const inRoad = roadIntrusions(massBoxes, world.network, 0.5);
  const roadTally = new Map<SolidClass, { n: number; worst: number; at: string }>();
  for (const r of inRoad) {
    const c = classOf(r.index);
    const rec = roadTally.get(c) ?? { n: 0, worst: 0, at: "" };
    rec.n++;
    if (r.depth > rec.worst) {
      rec.worst = r.depth;
      rec.at = uv(r.x, r.z);
    }
    roadTally.set(c, rec);
  }
  console.log(`  ${inRoad.length}/${massBoxes.length} boxes reach inside the asphalt`);
  for (const [k, v] of [...roadTally.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${k}: ${v.n}, worst ${v.worst.toFixed(1)}u @ ${v.at}`);
  }
  for (const r of inRoad.slice(0, 24)) {
    console.log(
      `    ${uv(r.x, r.z)} ${classOf(r.index)} depth ${r.depth.toFixed(2)}u ` +
        `box ${(r.obb.hx * 2).toFixed(1)}x${(r.obb.hz * 2).toFixed(1)}u`,
    );
  }

  console.log(`\n--- 3. props, furniture and parked cars in the roadway`);
  const furnIdx: number[] = [];
  for (let i = 0; i < rest.solids.length; i++) {
    if (cls[i] === "furniture" || cls[i] === "tree") furnIdx.push(i);
  }
  const furnBoxes = furnIdx.map((i) =>
    solidObb(rest.solids[i] ?? { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }),
  );
  const furnIn = roadIntrusions(furnBoxes, world.network, 0.5);
  console.log(`  furniture/tree solids inside the asphalt: ${furnIn.length}/${furnBoxes.length}`);
  for (const r of furnIn.slice(0, 16)) {
    const c = cls[furnIdx[r.index] ?? 0] ?? "?";
    console.log(`    ${uv(r.x, r.z)} ${c} depth ${r.depth.toFixed(2)}u`);
  }
  const totals = new Map<string, number>();
  for (const p of props) {
    const name = propName(p.url);
    totals.set(name, (totals.get(name) ?? 0) + 1);
  }
  const inLane = propsInRoadway(props, world.network, world.standAt, 0.5);
  const propByName = new Map<string, { inRoad: number; worst: number; at: string }>();
  for (const { prop, depth } of inLane) {
    const name = propName(prop.url);
    const rec = propByName.get(name) ?? { inRoad: 0, worst: 0, at: "" };
    rec.inRoad++;
    if (depth > rec.worst) {
      rec.worst = depth;
      rec.at = uv(prop.x, prop.z);
    }
    propByName.set(name, rec);
  }
  console.log(
    `  ground-level instances past the kerb (roadworks + overhead excluded): ${inLane.length}`,
  );
  for (const [name, r] of [...propByName.entries()].sort((a, b) => b[1].worst - a[1].worst)) {
    console.log(
      `    ${name}: ${r.inRoad}/${totals.get(name) ?? 0} worst ${r.worst.toFixed(1)}u @ ${r.at}`,
    );
  }
  // Parked cars sit 1.05u inside the asphalt BY DESIGN (furniture.ts: off =
  // half − 1.05). Anything much deeper has drifted into a travel lane.
  const carDepths = rest.parkedCars.map((c) => asphaltDepth(world.network, c.x, c.z));
  const carBands = [1.5, 2.5, 3.5, 5, Infinity];
  const carCount = new Array<number>(carBands.length).fill(0);
  let carWorst = 0;
  let carWorstAt = "";
  for (let i = 0; i < rest.parkedCars.length; i++) {
    const d = carDepths[i] ?? 0;
    const car = rest.parkedCars[i];
    for (let k = 0; k < carBands.length; k++) {
      if (d < (carBands[k] ?? Infinity)) {
        carCount[k] = (carCount[k] ?? 0) + 1;
        break;
      }
    }
    if (d > carWorst && car) {
      carWorst = d;
      carWorstAt = uv(car.x, car.z);
    }
  }
  console.log(
    `  parked-car depth into the asphalt: ${carBands
      .map((b, k) => `<${b}:${carCount[k] ?? 0}`)
      .join("  ")} worst ${carWorst.toFixed(1)}u @ ${carWorstAt}`,
  );

  console.log(`\n--- 4. seat heights`);
  const seat = seatReport(props, world.standAt, world.terrainAt, {
    floatGap: 0.35,
    buryDepth: 0.6,
    minCount: 40,
    groundSpread: 0.3,
  });
  console.log(
    `  ${seat.floating} floating (>0.35u over its kind's baseline), ` +
      `${seat.buried} buried (>0.6u under), ` +
      `${seat.wrongSurfaceInstances} instances on a url that tracks the RAW field`,
  );
  console.log(
    `  ${seat.groups.filter((g) => g.seated).length}/${seat.groups.length} kinds are ` +
      `fixed-scale ground props (the rest are masses, foundations or roof/wall dressing)`,
  );
  for (const g of seat.groups.filter((g) => g.seated).slice(0, 20)) {
    console.log(
      `    ${propName(g.url)} n=${g.count} spread ${g.seatSpread.toFixed(2)}u ` +
        `base ${g.medianOffset.toFixed(2)}/scale (raw ${g.medianTerrainOffset.toFixed(2)}) ` +
        `float ${g.floating} bury ${g.buried}` +
        (g.wrongSurface ? " WRONG-SURFACE" : ""),
    );
  }
  for (const o of seat.outliers.slice(0, 16)) {
    console.log(`    worst ${propName(o.url)} ${uv(o.x, o.z)} dev ${o.deviation.toFixed(2)}u`);
  }

  console.log(`\n--- 5. landmark parcels`);
  const lm = landmarkReport(props, rest.solids, world.network, world.plan);
  console.log(`  ${lm.reservedCells} reserved cells across ${lm.landmarks.length} landmarks`);
  for (const l of lm.landmarks) console.log(`    ${l.name}: ${l.cells} cells`);
  console.log(`  intruders: ${lm.intruders.length}`);
  for (const i of lm.intruders) {
    console.log(`    ${i.landmark}: ${i.what} @ ${uv(i.x, i.z)}`);
  }

  console.log(`\n--- 6. street grade`);
  const grade = gradeReport(world.network, world.drapeAt, 0.42);
  console.log(
    `  worst chord ${(grade.worstChord * 100).toFixed(1)}% @ ${grade.worstChordAt}\n` +
      `  worst local ${(grade.worstLocal * 100).toFixed(1)}% @ ${grade.worstLocalAt}\n` +
      `  over 42%: ${grade.overChord} edges by chord, ${grade.overLocal} by local window\n` +
      `  chord histogram: ${grade.histogram.map(([k, v]) => `${k}:${v}`).join("  ")}`,
  );
  console.log(`\ndone in ${Date.now() - t0}ms`);
}

if (process.env.AUDIT_REPORT === "1") await main();
