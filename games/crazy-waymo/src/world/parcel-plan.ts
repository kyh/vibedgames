import polygonClipping from "polygon-clipping";

import { CITY_SEED, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import type { Solid } from "../shared/types";
import { freewayPillars, freewaySoffitAt } from "./freeways";
import { isParkLand } from "./land-class";
import type { NetEdge, RoadNetwork } from "./network";
import { fallbackStoreys, resolveKind, storeysOf, visualHeight } from "./parcel-style";
import type { FabricChar, ParcelKind } from "./parcel-style";
import { walkFor } from "./roads";
import { hintOf } from "./parcel-source";
import type { ParcelHint, ParcelSource } from "./parcel-source";
import { lotRhythmFor } from "./sf-adjacency";
import { districtAt, isLandCell } from "./sf-map";
import type { Terrain } from "./terrain";

const FACADE_MARGIN = 0.45;
const CLIFF = 9;
const STEP_INTO_SLOPE = 0.62;
const STEP_BURY_MAX = 1.6;
const MIN_AREA = 1.5;
const MIN_SIDE = 1.1;
const MIN_DEPTH = 2.6;
const STRADDLE_STEP = 2.4;
const MERGE_EPS = 0.08;
const WALL_T = 1.6;
const BLOCK_SPAN = 26;
const DECK_CLEAR = 0.5;
const PILLAR_MARGIN = 0.3;
const KERB_STRIP = 0.9;
const LOT_MIN_AREA = 6;
const LOT_MIN_SIDE = 2.2;
const SPLIT_KEEP_SHARE = 0.4;
const SPLIT_LOW_STOREYS = 2;

export interface Obb {
  readonly cx: number;
  readonly cz: number;
  /** Unit +A axis; +B is its left normal (-ez, ex). */
  readonly ex: number;
  readonly ez: number;
  readonly halfA: number;
  readonly halfB: number;
}

export interface ParcelPlan {
  /** Index into the parcel source. */
  readonly id: number;
  /** From the downtown survey: measured heights and exact party walls. */
  readonly hero: boolean;
  readonly hint: ParcelHint;
  readonly kind: ParcelKind;
  readonly character: FabricChar;
  readonly district: string;
  readonly seed: number;
  readonly blockHash: number;
  /** World xz ring after the kerb clip, oriented so its signed area is positive. */
  readonly ring: Float32Array;
  readonly n: number;
  /** 1 where ring edge e (vertex e -> e+1) is a party wall. */
  readonly blind: Uint8Array;
  /** The street-facing edge, or -1 when every edge is a party wall. */
  readonly front: number;
  readonly seatY: number;
  /** Walls run down to here so a hillside parcel never shows open air. */
  readonly footY: number;
  readonly storeys: number;
  /** Visual height above seatY. */
  readonly height: number;
  /** Terrace units along the front edge (each gets its own bay, door, colour step). */
  readonly units: number;
  readonly obb: Obb;
  /** The ring is (near enough) its own OBB — one collision box, one shaft. */
  readonly rect: boolean;
  readonly solids: readonly Solid[];
}

/** A surveyed parcel that is a surface lot: asphalt, bay lines, parked cars. */
export interface ParcelLot {
  readonly id: number;
  readonly seed: number;
  readonly ring: Float32Array;
  readonly n: number;
  /** Terrain height under each ring vertex. */
  readonly ys: Float32Array;
  readonly obb: Obb;
  /** Pillar footings standing in the lot — cars keep clear of them. */
  readonly pillars: readonly { readonly x: number; readonly z: number; readonly half: number }[];
}

export interface ParcelPlanStats {
  built: number;
  water: number;
  stacked: number;
  reserved: number;
  park: number;
  /** Under a deck with no room for even one storey, or a pillar in the plan — now a lot. */
  freeway: number;
  /** Rejected after the clip: too small or too thin to be a building. */
  clipped: number;
  /** The clip folded the ring over itself and the box fallback could not stand either. */
  folded: number;
  /** A wall still crosses a roadway after the street split. */
  straddle: number;
  /** Centroid or a vertex still in a lane after the clip. */
  onRoad: number;
  cliff: number;
  /** Ring vertices the clip moved. */
  movedVerts: number;
  /** Parcels stretched back into the block to keep MIN_DEPTH. */
  stretched: number;
  /** Built with storeys capped to fit under a viaduct. */
  underDeck: number;
  /** Folded rings rebuilt as their own box. */
  boxed: number;
  /** Street-spanning rings cut at the street and kept. */
  split: number;
  /** Parcels emitted as surface lots. */
  lots: number;
}

export interface ParcelPlanContext {
  readonly source: ParcelSource;
  readonly network: RoadNetwork;
  readonly terrain: Terrain;
  /** "gx,gz" cells no procedural mass may touch (landmarks, depots, editor clears). */
  readonly reserved: ReadonlySet<string>;
  /**
   * Height of the ground AS DRAWN (ground.ts makeStandingSurface). Buildings
   * seat on the raw field and sink their walls to it; a lot is a decal on the
   * drawn surface and would be buried under the tessellated ground beside
   * every kerb if it used the field (CLAUDE.md, "nothing sits on the raw
   * height field").
   */
  readonly standAt: (x: number, z: number) => number;
  /** Why a footprint did not become a building — the harness tallies these. */
  readonly onReject?: (id: number, reason: keyof ParcelPlanStats, detail: string) => void;
}

export interface ParcelPlanResult {
  readonly plans: readonly ParcelPlan[];
  readonly lots: readonly ParcelLot[];
  readonly stats: ParcelPlanStats;
  /** Grid cells (see cellKey) the SURVEYED parcels cover, dilated one cell — built or not. */
  readonly covered: ReadonlySet<number>;
}

export const cellKey = (gx: number, gz: number) => gx * 1024 + gz;
const gridXOf = (x: number) => Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
const gridZOf = (z: number) => Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);

/* oxlint-disable no-bitwise -- integer hash mixing (xorshift-multiply) */
export const blockHash = (x: number, z: number) => {
  const bx = Math.floor((x + WORLD_HALF_X) / BLOCK_SPAN);
  const bz = Math.floor((z + WORLD_HALF_Z) / BLOCK_SPAN);
  let h = Math.imul(bx, 374_761_393) + Math.imul(bz, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);

  return (h ^ (h >>> 16)) >>> 0;
};

const hash32 = (a: number) => {
  let h = (a ^ 0x9e_37_79_b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85_eb_ca_6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2_b2_ae_35);

  return (h ^ (h >>> 16)) >>> 0;
};
/* oxlint-enable no-bitwise */

const signedArea = (ring: Float32Array, n: number) => {
  let a = 0;

  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    a += (ring[i * 2] ?? 0) * (ring[j * 2 + 1] ?? 0) - (ring[j * 2] ?? 0) * (ring[i * 2 + 1] ?? 0);
  }

  return a / 2;
};

interface Footprint {
  readonly ring: Float32Array;
  readonly n: number;
  readonly blind: Uint8Array;
}

// oxlint-disable-next-line no-bitwise -- the blind mask is a bit set, one bit per edge
const hasBit = (mask: number, bit: number) => (mask & (1 << bit)) !== 0;

const reversedRing = (ring: Float32Array, n: number) => {
  const rev = new Float32Array(n * 2);

  for (let k = 0; k < n; k += 1) {
    rev[k * 2] = ring[(n - 1 - k) * 2] ?? 0;
    rev[k * 2 + 1] = ring[(n - 1 - k) * 2 + 1] ?? 0;
  }

  return rev;
};

const centroidOf: (ring: Float32Array, n: number) => readonly [number, number] = (ring, n) => {
  let cx = 0;
  let cz = 0;

  for (let i = 0; i < n; i += 1) {
    cx += ring[i * 2] ?? 0;
    cz += ring[i * 2 + 1] ?? 0;
  }

  return [cx / n, cz / n];
};

const segmentsCross = (
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
) => {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);

  return d1 * d2 < 0 && d3 * d4 < 0;
};

const isSimple = (ring: Float32Array, n: number) => {
  for (let i = 0; i < n; i += 1) {
    const i1 = (i + 1) % n;

    for (let j = i + 2; j < n; j += 1) {
      const j1 = (j + 1) % n;

      if (j1 === i) {
        continue;
      }

      if (
        segmentsCross(
          ring[i * 2] ?? 0,
          ring[i * 2 + 1] ?? 0,
          ring[i1 * 2] ?? 0,
          ring[i1 * 2 + 1] ?? 0,
          ring[j * 2] ?? 0,
          ring[j * 2 + 1] ?? 0,
          ring[j1 * 2] ?? 0,
          ring[j1 * 2 + 1] ?? 0,
        )
      ) {
        return false;
      }
    }
  }

  return true;
};

export const pointInRing = (ring: Float32Array, n: number, x: number, z: number) => {
  let inside = false;

  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const xi = ring[i * 2] ?? 0;
    const zi = ring[i * 2 + 1] ?? 0;
    const xj = ring[j * 2] ?? 0;
    const zj = ring[j * 2 + 1] ?? 0;

    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }

  return inside;
};

export const distToRing = (ring: Float32Array, n: number, x: number, z: number) => {
  let best = Infinity;

  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const ax = ring[i * 2] ?? 0;
    const az = ring[i * 2 + 1] ?? 0;
    const bx = ring[j * 2] ?? 0;
    const bz = ring[j * 2 + 1] ?? 0;
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-8 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / l2, 0), 1) : 0;
    const d = Math.hypot(ax + dx * t - x, az + dz * t - z);

    if (d < best) {
      best = d;
    }
  }

  return best;
};

const obbOf = (ring: Float32Array, n: number, ex: number, ez: number) => {
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;

  for (let i = 0; i < n; i += 1) {
    const x = ring[i * 2] ?? 0;
    const z = ring[i * 2 + 1] ?? 0;
    const a = x * ex + z * ez;
    const b = -x * ez + z * ex;

    if (a < minA) {
      minA = a;
    }

    if (a > maxA) {
      maxA = a;
    }

    if (b < minB) {
      minB = b;
    }

    if (b > maxB) {
      maxB = b;
    }
  }

  const midA = (minA + maxA) / 2;
  const midB = (minB + maxB) / 2;

  return {
    cx: midA * ex - midB * ez,
    cz: midA * ez + midB * ex,
    ex,
    ez,
    halfA: (maxA - minA) / 2,
    halfB: (maxB - minB) / 2,
  };
};

const rectRing = (o: Obb) => {
  const ring = new Float32Array(8);

  const corners: readonly (readonly [number, number])[] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];

  for (const [i, [a, b]] of corners.entries()) {
    ring[i * 2] = o.cx + a * o.halfA * o.ex - b * o.halfB * o.ez;
    ring[i * 2 + 1] = o.cz + a * o.halfA * o.ez + b * o.halfB * o.ex;
  }

  return signedArea(ring, 4) < 0 ? reversedRing(ring, 4) : ring;
};

const longestEdgeFrame: (ring: Float32Array, n: number) => readonly [number, number] = (
  ring,
  n,
) => {
  let ex = 1;
  let ez = 0;
  let best = 0;

  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const dx = (ring[j * 2] ?? 0) - (ring[i * 2] ?? 0);
    const dz = (ring[j * 2 + 1] ?? 0) - (ring[i * 2 + 1] ?? 0);
    const len = Math.hypot(dx, dz);

    if (len > best) {
      best = len;
      ex = dx / len;
      ez = dz / len;
    }
  }

  return [ex, ez];
};

const wallSolids = (ring: Float32Array, n: number) => {
  const out: Solid[] = [];

  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const x0 = ring[i * 2] ?? 0;
    const z0 = ring[i * 2 + 1] ?? 0;
    const x1 = ring[j * 2] ?? 0;
    const z1 = ring[j * 2 + 1] ?? 0;
    const len = Math.hypot(x1 - x0, z1 - z0);

    if (len < 2.2) {
      continue;
    }

    const ex = (x1 - x0) / len;
    const ez = (z1 - z0) / len;
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    out.push({
      maxX: mx + len / 2,
      maxZ: mz + WALL_T / 2,
      minX: mx - len / 2,
      minZ: mz - WALL_T / 2,
      yaw: Math.atan2(-ez, ex),
    });
  }

  return out;
};

const obbSolid = (o: Obb, shrink: number) => ({
  maxX: o.cx + o.halfA * shrink,
  maxZ: o.cz + o.halfB * shrink,
  minX: o.cx - o.halfA * shrink,
  minZ: o.cz - o.halfB * shrink,
  yaw: Math.atan2(-o.ez, o.ex),
});

const setbackFor = (half: number) => half + walkFor(half) + FACADE_MARGIN;

interface Hit {
  readonly edge: NetEdge;
  readonly dist: number;
  readonly x: number;
  readonly z: number;
  readonly tx: number;
  readonly tz: number;
}

type NearestFn = (x: number, z: number, maxDist: number) => Hit | null;

const closestOnEdge = (e: NetEdge, x: number, z: number) => {
  let bd = Infinity;
  let best: Hit = { dist: Infinity, edge: e, tx: 1, tz: 0, x, z };
  const { pts } = e;

  for (let k = 0; k + 2 < pts.length; k += 2) {
    const ax = pts[k] ?? 0;
    const az = pts[k + 1] ?? 0;
    const dx = (pts[k + 2] ?? 0) - ax;
    const dz = (pts[k + 3] ?? 0) - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-8 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / l2, 0), 1) : 0;
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d2 = (px - x) * (px - x) + (pz - z) * (pz - z);

    if (d2 < bd) {
      bd = d2;
      const dl = Math.sqrt(l2) || 1;
      best = { dist: Math.sqrt(d2), edge: e, tx: dx / dl, tz: dz / dl, x: px, z: pz };
    }
  }

  return best;
};

interface Nearby {
  readonly edges: readonly NetEdge[];
  readonly nearest: NearestFn;
}

const nearbyStreets: (network: RoadNetwork, cx: number, cz: number, r: number) => Nearby = (
  network,
  cx,
  cz,
  r,
) => {
  const edges = network.edgesWithin(cx, cz, r);

  return {
    edges,
    nearest: (x, z, maxDist) => {
      let best: Hit | null = null;

      for (const e of edges) {
        const h = closestOnEdge(e, x, z);

        if (h.dist < maxDist && (best === null || h.dist < best.dist)) {
          best = h;
        }
      }

      return best;
    },
  };
};

interface Street {
  readonly ox: number;
  readonly oz: number;
  readonly px: number;
  readonly pz: number;
  readonly setback: number;
}

const streetsInReach = (
  ring: Float32Array,
  n: number,
  edges: readonly NetEdge[],
  cx: number,
  cz: number,
) => {
  const streets: Street[] = [];
  let reach = 0;

  for (let i = 0; i < n; i += 1) {
    const d = Math.hypot((ring[i * 2] ?? 0) - cx, (ring[i * 2 + 1] ?? 0) - cz);

    if (d > reach) {
      reach = d;
    }
  }

  for (const e of edges) {
    const hit = closestOnEdge(e, cx, cz);
    const setback = setbackFor(e.half);

    if (hit.dist > setback + reach + 0.5) {
      continue;
    }

    let px = -hit.tz;
    let pz = hit.tx;

    if ((cx - hit.x) * px + (cz - hit.z) * pz < 0) {
      px = -px;
      pz = -pz;
    }

    streets.push({ ox: hit.x, oz: hit.z, px, pz, setback });
  }

  return streets;
};

const clearSetback = (ring: Float32Array, n: number, st: Street) => {
  let dMin = Infinity;
  let dMax = -Infinity;

  for (let i = 0; i < n; i += 1) {
    const d = ((ring[i * 2] ?? 0) - st.ox) * st.px + ((ring[i * 2 + 1] ?? 0) - st.oz) * st.pz;

    if (d < dMin) {
      dMin = d;
    }

    if (d > dMax) {
      dMax = d;
    }
  }

  if (dMin >= st.setback - 0.02) {
    return 0;
  }

  if (dMax <= st.setback + 1) {
    const shift = st.setback - dMin;

    for (let i = 0; i < n; i += 1) {
      ring[i * 2] = (ring[i * 2] ?? 0) + st.px * shift;
      ring[i * 2 + 1] = (ring[i * 2 + 1] ?? 0) + st.pz * shift;
    }

    return n;
  }

  let moved = 0;

  for (let i = 0; i < n; i += 1) {
    const x = ring[i * 2] ?? 0;
    const z = ring[i * 2 + 1] ?? 0;
    const d = (x - st.ox) * st.px + (z - st.oz) * st.pz;

    if (d >= st.setback - 0.02) {
      continue;
    }

    ring[i * 2] = x + st.px * (st.setback - d);
    ring[i * 2 + 1] = z + st.pz * (st.setback - d);
    moved += 1;
  }

  return moved;
};

const clipToKerb = (
  ring: Float32Array,
  n: number,
  edges: readonly NetEdge[],
  cx: number,
  cz: number,
) => {
  let moved = 0;

  for (const st of streetsInReach(ring, n, edges, cx, cz)) {
    moved += clearSetback(ring, n, st);
  }

  return moved;
};

const mergeClose = (ring: Float32Array, n: number) => {
  let m = 0;

  for (let i = 0; i < n; i += 1) {
    const x = ring[i * 2] ?? 0;
    const z = ring[i * 2 + 1] ?? 0;

    if (
      m > 0 &&
      Math.hypot(x - (ring[(m - 1) * 2] ?? 0), z - (ring[(m - 1) * 2 + 1] ?? 0)) < MERGE_EPS
    ) {
      continue;
    }

    ring[m * 2] = x;
    ring[m * 2 + 1] = z;
    m += 1;
  }

  if (
    m > 1 &&
    Math.hypot(
      (ring[0] ?? 0) - (ring[(m - 1) * 2] ?? 0),
      (ring[1] ?? 0) - (ring[(m - 1) * 2 + 1] ?? 0),
    ) < MERGE_EPS
  ) {
    m -= 1;
  }

  return m;
};

const straddledStreets = (ring: Float32Array, n: number, nearest: NearestFn) => {
  const ids = new Set<number>();

  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const x0 = ring[i * 2] ?? 0;
    const z0 = ring[i * 2 + 1] ?? 0;
    const x1 = ring[j * 2] ?? 0;
    const z1 = ring[j * 2 + 1] ?? 0;
    const len = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.ceil(len / STRADDLE_STEP);

    for (let k = 1; k < steps; k += 1) {
      const t = k / steps;
      const hit = nearest(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, ROAD_TILE);

      if (hit !== null && hit.dist < hit.edge.half - 0.15) {
        ids.add(hit.edge.id);
      }
    }
  }

  return [...ids];
};

type PolyRing = [number, number][];

const streetStrips = (edgeIds: readonly number[], network: RoadNetwork) => {
  const strips: PolyRing[][] = [];

  for (const id of edgeIds) {
    const edge = network.edges.find((e) => e.id === id);

    if (!edge) {
      continue;
    }

    const w = edge.half + KERB_STRIP;
    const { pts } = edge;

    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i] ?? 0;
      const az = pts[i + 1] ?? 0;
      const bx = pts[i + 2] ?? 0;
      const bz = pts[i + 3] ?? 0;
      const len = Math.hypot(bx - ax, bz - az);

      if (len < 1e-3) {
        continue;
      }

      const tx = (bx - ax) / len;
      const tz = (bz - az) / len;
      const nx = -tz;
      const nz = tx;
      const ax2 = ax - tx * w;
      const az2 = az - tz * w;
      const bx2 = bx + tx * w;
      const bz2 = bz + tz * w;
      strips.push([
        [
          [ax2 + nx * w, az2 + nz * w],
          [bx2 + nx * w, bz2 + nz * w],
          [bx2 - nx * w, bz2 - nz * w],
          [ax2 - nx * w, az2 - nz * w],
          [ax2 + nx * w, az2 + nz * w],
        ],
      ]);
    }
  }

  return strips;
};

const widestPiece = (pieces: readonly PolyRing[][]) => {
  let best: PolyRing | null = null;
  let bestArea = 0;

  for (const poly of pieces) {
    const [outer] = poly;

    if (!outer) {
      continue;
    }

    let a = 0;

    for (let i = 0; i + 1 < outer.length; i += 1) {
      const p = outer[i];
      const q = outer[i + 1];

      if (!p || !q) {
        continue;
      }

      a += p[0] * q[1] - q[0] * p[1];
    }

    a = Math.abs(a) / 2;

    if (a > bestArea) {
      bestArea = a;
      best = outer;
    }
  }

  return bestArea < MIN_AREA ? null : best;
};

const splitOffStreets = (
  ring: Float32Array,
  n: number,
  edgeIds: readonly number[],
  network: RoadNetwork,
) => {
  const strips = streetStrips(edgeIds, network);

  if (strips.length === 0) {
    return null;
  }

  const outline: PolyRing = [];

  for (let i = 0; i < n; i += 1) {
    outline.push([ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0]);
  }

  const [first] = outline;

  if (first) {
    outline.push([first[0], first[1]]);
  }

  let pieces: PolyRing[][];

  try {
    const cut = polygonClipping.union([], ...strips);
    pieces = polygonClipping.difference([outline], cut);
  } catch {
    return null;
  }

  const best = widestPiece(pieces);

  if (!best) {
    return null;
  }

  const m = best.length - 1;
  const out = new Float32Array(m * 2);

  for (let i = 0; i < m; i += 1) {
    const p = best[i];
    out[i * 2] = p?.[0] ?? 0;
    out[i * 2 + 1] = p?.[1] ?? 0;
  }

  return signedArea(out, m) < 0 ? reversedRing(out, m) : out;
};

interface PillarSpot {
  readonly x: number;
  readonly z: number;
  readonly half: number;
}

class PillarIndex {
  private readonly cells = new Map<number, PillarSpot[]>();
  constructor(spots: readonly PillarSpot[]) {
    for (const p of spots) {
      const k = cellKey(gridXOf(p.x), gridZOf(p.z));
      const arr = this.cells.get(k);

      if (arr) {
        arr.push(p);
      } else {
        this.cells.set(k, [p]);
      }
    }
  }
  inside(ring: Float32Array, n: number) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < n; i += 1) {
      const x = ring[i * 2] ?? 0;
      const z = ring[i * 2 + 1] ?? 0;

      if (x < minX) {
        minX = x;
      }

      if (x > maxX) {
        maxX = x;
      }

      if (z < minZ) {
        minZ = z;
      }

      if (z > maxZ) {
        maxZ = z;
      }
    }

    const out: PillarSpot[] = [];

    for (let gx = gridXOf(minX) - 1; gx <= gridXOf(maxX) + 1; gx += 1) {
      for (let gz = gridZOf(minZ) - 1; gz <= gridZOf(maxZ) + 1; gz += 1) {
        for (const p of this.cells.get(cellKey(gx, gz)) ?? []) {
          const reach = p.half + PILLAR_MARGIN;

          if (
            p.x < minX - reach ||
            p.x > maxX + reach ||
            p.z < minZ - reach ||
            p.z > maxZ + reach
          ) {
            continue;
          }

          if (pointInRing(ring, n, p.x, p.z) || distToRing(ring, n, p.x, p.z) < reach) {
            out.push(p);
          }
        }
      }
    }

    return out;
  }
}

const orientedRing = (source: ParcelSource, id: number, v0: number, v1: number) => {
  const n = v1 - v0;
  const blindMask = source.blind[id] ?? 0;
  let ring: Float32Array = source.coords.slice(v0 * 2, v1 * 2);
  const blind = new Uint8Array(n);
  const reversed = signedArea(ring, n) < 0;

  if (reversed) {
    ring = reversedRing(ring, n);
  }

  for (let e = 0; e < n && e < 32; e += 1) {
    if (hasBit(blindMask, e)) {
      blind[reversed ? (n - 2 - e + 2 * n) % n : e] = 1;
    }
  }

  return { blind, n, ring };
};

const reachOf = (ring: Float32Array, n: number, cx: number, cz: number) => {
  let reach = 0;

  for (let i = 0; i < n; i += 1) {
    const d = Math.hypot((ring[i * 2] ?? 0) - cx, (ring[i * 2 + 1] ?? 0) - cz);

    if (d > reach) {
      reach = d;
    }
  }

  return reach;
};

const coverCells = (covered: Set<number>, ring: Float32Array, n: number) => {
  for (let i = 0; i < n; i += 1) {
    const vgx = gridXOf(ring[i * 2] ?? 0);
    const vgz = gridZOf(ring[i * 2 + 1] ?? 0);

    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        covered.add(cellKey(vgx + dx, vgz + dz));
      }
    }
  }
};

const touchesReserved = (
  reserved: ReadonlySet<string>,
  ring: Float32Array,
  n: number,
  gx: number,
  gz: number,
) => {
  if (reserved.has(`${gx},${gz}`)) {
    return true;
  }

  for (let i = 0; i < n; i += 1) {
    if (reserved.has(`${gridXOf(ring[i * 2] ?? 0)},${gridZOf(ring[i * 2 + 1] ?? 0)}`)) {
      return true;
    }
  }

  return false;
};

interface Planner {
  readonly ctx: ParcelPlanContext;
  readonly stats: ParcelPlanStats;
  readonly plans: ParcelPlan[];
  readonly lots: ParcelLot[];
  readonly covered: Set<number>;
  readonly pillars: PillarIndex;
  nearest: NearestFn;
  nearEdges: readonly NetEdge[];
}

const onAsphalt = (p: Planner, x: number, z: number, margin: number) => {
  const hit = p.nearest(x, z, ROAD_TILE * 1.4);

  return hit !== null && hit.dist < hit.edge.half + margin;
};

const anyVertexInLane = (p: Planner, ring: Float32Array, n: number) => {
  for (let i = 0; i < n; i += 1) {
    if (onAsphalt(p, ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0, -0.45)) {
      return true;
    }
  }

  return false;
};

const soffitOver = (p: Planner, ring: Float32Array, n: number, cx: number, cz: number) => {
  const { terrain, network } = p.ctx;
  let soffit = freewaySoffitAt(terrain, network, cx, cz, 0.5);

  for (let i = 0; i < n; i += 1) {
    const s = freewaySoffitAt(terrain, network, ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0, 0.3);

    if (s !== null && (soffit === null || s < soffit)) {
      soffit = s;
    }
  }

  return soffit;
};

const emitLot = (
  p: Planner,
  id: number,
  seed: number,
  footprint: Footprint,
  obb: Obb,
  spots: readonly PillarSpot[],
) => {
  const { ring, n } = footprint;

  if (Math.min(obb.halfA, obb.halfB) * 2 < LOT_MIN_SIDE || signedArea(ring, n) < LOT_MIN_AREA) {
    return false;
  }

  const ys = new Float32Array(n);

  for (let i = 0; i < n; i += 1) {
    ys[i] = p.ctx.standAt(ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0);
  }

  p.lots.push({ id, n, obb, pillars: spots, ring, seed, ys });
  p.stats.lots += 1;

  return true;
};

const kerbClip = (p: Planner, footprint: Footprint, cx: number, cz: number) => {
  let movedAny = false;

  for (let iter = 0; iter < 3; iter += 1) {
    const moved = clipToKerb(footprint.ring, footprint.n, p.nearEdges, cx, cz);
    p.stats.movedVerts += moved;

    if (moved === 0) {
      break;
    }

    movedAny = true;
  }

  if (!movedAny) {
    return { footprint, movedAny };
  }

  const m = mergeClose(footprint.ring, footprint.n);

  if (m === footprint.n) {
    return { footprint, movedAny };
  }

  return {
    footprint: { blind: new Uint8Array(m), n: m, ring: footprint.ring.slice(0, m * 2) },
    movedAny,
  };
};

const boxedFootprint = (ring: Float32Array, n: number) => {
  const [ex, ez] = longestEdgeFrame(ring, n);

  return { blind: new Uint8Array(4), n: 4, ring: rectRing(obbOf(ring, n, ex, ez)) };
};

interface Recovered {
  readonly footprint: Footprint;
  readonly cx: number;
  readonly cz: number;
  readonly boxed: boolean;
  readonly split: boolean;
  readonly crossing: readonly number[];
}

const recoverFootprint = (p: Planner, footprint0: Footprint, cx0: number, cz0: number) => {
  let footprint = footprint0;
  let cx = cx0;
  let cz = cz0;
  let boxed = false;
  let split = false;

  if (!isSimple(footprint.ring, footprint.n)) {
    footprint = boxedFootprint(footprint.ring, footprint.n);
    boxed = true;
  }

  let crossing = straddledStreets(footprint.ring, footprint.n, p.nearest);

  for (let round = 0; crossing.length > 0 && round < 4; round += 1) {
    const piece = splitOffStreets(footprint.ring, footprint.n, crossing, p.ctx.network);

    if (piece === null) {
      break;
    }

    const n = piece.length / 2;
    footprint = { blind: new Uint8Array(n), n, ring: piece };
    [cx, cz] = centroidOf(piece, n);
    split = true;

    if (n >= 3 && !isSimple(piece, n)) {
      footprint = boxedFootprint(piece, n);
      boxed = true;
    }

    crossing = footprint.n >= 3 ? straddledStreets(footprint.ring, footprint.n, p.nearest) : [];
  }

  return { boxed, crossing, cx, cz, footprint, split };
};

const chooseFront = (footprint: Footprint, nearest: NearestFn) => {
  const { ring, n, blind } = footprint;
  let front = -1;
  let frontDist = Infinity;
  let frontLen = 0;
  let longest = -1;
  let longestLen = 0;

  for (let e = 0; e < n; e += 1) {
    if (blind[e] === 1) {
      continue;
    }

    const j = (e + 1) % n;
    const x0 = ring[e * 2] ?? 0;
    const z0 = ring[e * 2 + 1] ?? 0;
    const x1 = ring[j * 2] ?? 0;
    const z1 = ring[j * 2 + 1] ?? 0;
    const len = Math.hypot(x1 - x0, z1 - z0);

    if (len > longestLen) {
      longestLen = len;
      longest = e;
    }

    if (len < 1) {
      continue;
    }

    const hit = nearest((x0 + x1) / 2, (z0 + z1) / 2, ROAD_TILE * 1.6);

    if (hit === null) {
      continue;
    }

    const d = hit.dist - hit.edge.half;

    if (d < frontDist - 0.3 || (Math.abs(d - frontDist) <= 0.3 && len > frontLen)) {
      frontDist = d;
      frontLen = len;
      front = e;
    }
  }

  if (front < 0) {
    return { front: longest, frontLen: longestLen };
  }

  return { front, frontLen };
};

const frontFrame: (ring: Float32Array, n: number, front: number) => readonly [number, number] = (
  ring,
  n,
  front,
) => {
  if (front < 0) {
    return [1, 0];
  }

  const j = (front + 1) % n;
  const dx = (ring[j * 2] ?? 0) - (ring[front * 2] ?? 0);
  const dz = (ring[j * 2 + 1] ?? 0) - (ring[front * 2 + 1] ?? 0);
  const len = Math.hypot(dx, dz) || 1;

  return [dx / len, dz / len];
};

const stretchRear = (
  p: Planner,
  ring: Float32Array,
  n: number,
  original: Float32Array,
  n0: number,
  frame: readonly [number, number],
  obb: Obb,
) => {
  const [ex, ez] = frame;
  const orig = obbOf(original, n0, ex, ez);
  const want = Math.min(MIN_DEPTH, orig.halfB * 2);
  const deficit = want - obb.halfB * 2;

  if (deficit <= 0.05) {
    return null;
  }

  let minB = Infinity;

  for (let i = 0; i < n; i += 1) {
    const b = -(ring[i * 2] ?? 0) * ez + (ring[i * 2 + 1] ?? 0) * ex;

    if (b < minB) {
      minB = b;
    }
  }

  const stretched = Float32Array.from(ring);
  let clear = true;

  for (let i = 0; i < n && clear; i += 1) {
    const b = -(ring[i * 2] ?? 0) * ez + (ring[i * 2 + 1] ?? 0) * ex;

    if (b <= minB + 0.2) {
      continue;
    }

    const x = (ring[i * 2] ?? 0) - deficit * ez;
    const z = (ring[i * 2 + 1] ?? 0) + deficit * ex;

    if (onAsphalt(p, x, z, 0.3)) {
      clear = false;
    }

    stretched[i * 2] = x;
    stretched[i * 2 + 1] = z;
  }

  if (!clear) {
    return null;
  }

  ring.set(stretched);

  return obbOf(ring, n, ex, ez);
};

const seatOf = (terrain: Terrain, ring: Float32Array, n: number, cx: number, cz: number) => {
  let hiY = terrain.heightAt(cx, cz);
  let loY = hiY;

  for (let i = 0; i < n; i += 1) {
    const y = terrain.heightAt(ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0);

    if (y > hiY) {
      hiY = y;
    }

    if (y < loY) {
      loY = y;
    }
  }

  const fall = hiY - loY;
  const seatY = fall > 1 ? Math.max(loY + fall * STEP_INTO_SLOPE, hiY - STEP_BURY_MAX) : hiY;

  return { fall, footY: loY - 0.35, seatY };
};

const storeysUnderDeck = (storeys0: number, seatY: number, soffit: number) => {
  let storeys = storeys0;

  while (storeys > 1 && seatY + visualHeight(storeys) > soffit - DECK_CLEAR) {
    storeys -= 1;
  }

  return storeys;
};

const unitsFor = (kind: ParcelKind, front: number, frontLen: number, p50: number) => {
  if (front < 0 || !(kind === "rowhouse" || kind === "stucco" || kind === "midrise")) {
    return 1;
  }

  const unitW = kind === "midrise" ? p50 * 1.5 : p50;

  return Math.max(1, Math.min(12, Math.round(frontLen / unitW)));
};

interface Admitted {
  readonly footprint: Footprint;
  readonly cx: number;
  readonly cz: number;
  readonly gx: number;
  readonly gz: number;
}

const admitParcel: (p: Planner, id: number, footprint: Footprint) => Admitted | null = (
  p,
  id,
  footprint,
) => {
  const { ring, n } = footprint;
  const [cx, cz] = centroidOf(ring, n);

  const near = nearbyStreets(
    p.ctx.network,
    cx,
    cz,
    reachOf(ring, n, cx, cz) + ROAD_TILE * 2.6 + MIN_DEPTH,
  );

  p.nearest = near.nearest;
  p.nearEdges = near.edges;
  const gx = gridXOf(cx);
  const gz = gridZOf(cz);

  if (!isLandCell(gx, gz)) {
    p.stats.water += 1;

    return null;
  }

  coverCells(p.covered, ring, n);

  if (touchesReserved(p.ctx.reserved, ring, n, gx, gz)) {
    p.stats.reserved += 1;

    return null;
  }

  if (isParkLand(gx, gz)) {
    p.stats.park += 1;

    return null;
  }

  return { cx, cz, footprint, gx, gz };
};

interface Fitted extends Recovered {
  readonly movedAny: boolean;
  readonly area: number;
}

const fitParcel: (p: Planner, id: number, admitted: Admitted) => Fitted | null = (
  p,
  id,
  admitted,
) => {
  const reject = (reason: keyof ParcelPlanStats, detail: string) => {
    p.stats[reason] += 1;
    p.ctx.onReject?.(id, reason, detail);

    return null;
  };

  const clipped = kerbClip(p, admitted.footprint, admitted.cx, admitted.cz);
  const { movedAny } = clipped;

  if (clipped.footprint.n < 3) {
    return reject("clipped", "n<3");
  }

  const recovered = recoverFootprint(p, clipped.footprint, admitted.cx, admitted.cz);
  const { boxed, split } = recovered;
  const { n } = recovered.footprint;

  if (recovered.crossing.length > 0) {
    return reject("straddle", `n=${n} split=${split} boxed=${boxed}`);
  }

  if (n < 3) {
    return reject("clipped", "n<3 after split");
  }

  const area = signedArea(recovered.footprint.ring, n);

  if (area < 0.05) {
    return reject("clipped", `area=${area.toFixed(2)} moved=${movedAny}`);
  }

  const [cx, cz] = centroidOf(recovered.footprint.ring, n);

  if (boxed || split) {
    const { network } = p.ctx;
    p.nearest = (x, z, maxDist) => network.nearest(x, z, maxDist);
  }

  if (onAsphalt(p, cx, cz, 0.4) || anyVertexInLane(p, recovered.footprint.ring, n)) {
    return reject("onRoad", `boxed=${boxed} split=${split}`);
  }

  return { ...recovered, area, cx, cz, movedAny };
};

interface Massed {
  readonly front: number;
  readonly frontLen: number;
  readonly obb: Obb;
  readonly area: number;
  readonly rect: boolean;
}

const massParcel = (p: Planner, id: number, fitted: Fitted, original: Float32Array, n0: number) => {
  const { ring, n } = fitted.footprint;
  const { front, frontLen } = chooseFront(fitted.footprint, p.nearest);
  const frame = frontFrame(ring, n, front);
  let obb = obbOf(ring, n, frame[0], frame[1]);
  let { area } = fitted;

  if (fitted.movedAny && front >= 0 && obb.halfB * 2 < MIN_DEPTH - 0.05) {
    const stretched = stretchRear(p, ring, n, original, n0, frame, obb);

    if (stretched !== null) {
      obb = stretched;
      area = signedArea(ring, n);
      p.stats.stretched += 1;
    }
  }

  if (Math.min(obb.halfA, obb.halfB) * 2 < MIN_SIDE || area < MIN_AREA) {
    p.stats.clipped += 1;
    p.ctx.onReject?.(
      id,
      "clipped",
      `A=${(obb.halfA * 2).toFixed(2)} B=${(obb.halfB * 2).toFixed(2)} area=${area.toFixed(2)} front=${front} moved=${fitted.movedAny} n=${n}`,
    );

    return null;
  }

  const rect = n === 4 && (obb.halfA * obb.halfB * 4) / area < 1.08;

  return { area, front, frontLen, obb, rect };
};

const storeysFor = (
  p: Planner,
  id: number,
  seed: number,
  fitted: Fitted,
  massed: Massed,
  seatY: number,
  storeys0: number,
) => {
  const { ring, n } = fitted.footprint;
  const soffit = soffitOver(p, ring, n, fitted.cx, fitted.cz);
  const pillarHits = p.pillars.inside(ring, n);

  if (soffit === null) {
    if (pillarHits.length > 0) {
      p.stats.freeway += 1;
      emitLot(p, id, seed, fitted.footprint, massed.obb, pillarHits);

      return null;
    }

    return storeys0;
  }

  const storeys = storeysUnderDeck(storeys0, seatY, soffit);

  if (seatY + visualHeight(storeys) > soffit - DECK_CLEAR || pillarHits.length > 0) {
    p.stats.freeway += 1;
    emitLot(p, id, seed, fitted.footprint, massed.obb, pillarHits);

    return null;
  }

  p.stats.underDeck += 1;

  return storeys;
};

const planOne = (p: Planner, id: number) => {
  const { source, terrain } = p.ctx;
  const v0 = source.offsets[id] ?? 0;
  const v1 = source.offsets[id + 1] ?? v0;
  const n0 = v1 - v0;

  if (n0 < 3) {
    return;
  }

  const realH = source.heights[id] ?? 0;
  const hint = hintOf(source, id);
  const hero = (source.hero[id] ?? 0) === 1;
  const footprint0 = orientedRing(source, id, v0, v1);
  const original = Float32Array.from(footprint0.ring);
  const area0 = signedArea(footprint0.ring, n0);
  const admitted = admitParcel(p, id, footprint0);

  if (admitted === null) {
    return;
  }

  const fitted = fitParcel(p, id, admitted);

  if (fitted === null) {
    return;
  }

  const massed = massParcel(p, id, fitted, original, n0);

  if (massed === null) {
    return;
  }

  const { ring, n, blind } = fitted.footprint;
  const { cx, cz } = fitted;
  const seat = seatOf(terrain, ring, n, cx, cz);

  if (seat.fall > CLIFF) {
    p.stats.cliff += 1;

    return;
  }

  const district = districtAt(admitted.gx, admitted.gz);
  const character: FabricChar = district.character === "park" ? "residential" : district.character;
  const seed = hash32(id * 2_654_435_761 + CITY_SEED);
  let storeys0 = realH > 0 ? storeysOf(realH) : fallbackStoreys(character, hint, seed);

  if (fitted.split && massed.area < area0 * SPLIT_KEEP_SHARE) {
    storeys0 = Math.min(storeys0, SPLIT_LOW_STOREYS);
  }

  const storeys = storeysFor(p, id, seed, fitted, massed, seat.seatY, storeys0);

  if (storeys === null) {
    return;
  }

  const kind = resolveKind({
    area: massed.area,
    character,
    district: district.name,
    frontage: massed.frontLen,
    hint,
    roll: (seed % 0x1_00_00) / 0x1_00_00,
    storeys,
  });

  const units = unitsFor(kind, massed.front, massed.frontLen, lotRhythmFor(district.name).p50);

  const solids = massed.rect ? [obbSolid(massed.obb, 0.96)] : wallSolids(ring, n);

  if (solids.length === 0) {
    solids.push(obbSolid(massed.obb, 0.9));
  }

  p.plans.push({
    blind,
    blockHash: blockHash(cx, cz),
    character,
    district: district.name,
    footY: seat.footY,
    front: massed.front,
    height: visualHeight(storeys),
    hero,
    hint,
    id,
    kind,
    n,
    obb: massed.obb,
    rect: massed.rect,
    ring,
    seatY: seat.seatY,
    seed,
    solids,
    storeys,
    units,
  });
  p.stats.built += 1;

  if (fitted.boxed) {
    p.stats.boxed += 1;
  }

  if (fitted.split) {
    p.stats.split += 1;
  }
};

export const planParcels = (ctx: ParcelPlanContext) => {
  const { network, terrain } = ctx;

  const p: Planner = {
    covered: new Set<number>(),
    ctx,
    lots: [],
    nearEdges: network.edges,
    nearest: (x, z, maxDist) => network.nearest(x, z, maxDist),
    pillars: new PillarIndex(freewayPillars(terrain, network)),
    plans: [],
    stats: {
      boxed: 0,
      built: 0,
      cliff: 0,
      clipped: 0,
      folded: 0,
      freeway: 0,
      lots: 0,
      movedVerts: 0,
      onRoad: 0,
      park: 0,
      reserved: 0,
      split: 0,
      stacked: 0,
      straddle: 0,
      stretched: 0,
      underDeck: 0,
      water: 0,
    },
  };

  for (let id = 0; id < ctx.source.count; id += 1) {
    planOne(p, id);
  }

  return { covered: p.covered, lots: p.lots, plans: p.plans, stats: p.stats };
};

/** What a city without a parcel source gets: nothing, and every stat at zero. */
export const emptyParcelPlan: () => ParcelPlanResult = () => ({
  covered: new Set(),
  lots: [],
  plans: [],
  stats: {
    boxed: 0,
    built: 0,
    cliff: 0,
    clipped: 0,
    folded: 0,
    freeway: 0,
    lots: 0,
    movedVerts: 0,
    onRoad: 0,
    park: 0,
    reserved: 0,
    split: 0,
    stacked: 0,
    straddle: 0,
    stretched: 0,
    underDeck: 0,
    water: 0,
  },
});

/** The front edge's endpoints, for the facade stamp furniture dresses. */
export const frontSegment: (p: ParcelPlan) => readonly [number, number, number, number] | null = (
  p,
) => {
  if (p.front < 0) {
    return null;
  }

  const j = (p.front + 1) % p.n;

  return [
    p.ring[p.front * 2] ?? 0,
    p.ring[p.front * 2 + 1] ?? 0,
    p.ring[j * 2] ?? 0,
    p.ring[j * 2 + 1] ?? 0,
  ];
};
