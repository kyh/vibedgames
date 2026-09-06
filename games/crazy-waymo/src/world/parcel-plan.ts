import polygonClipping from "polygon-clipping";

import { CITY_SEED, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import type { Solid } from "../shared/types";
import { freewayPillars, freewaySoffitAt } from "./freeways";
import { isParkLand } from "./land-class";
import type { NetEdge, RoadNetwork } from "./network";
import {
  type FabricChar,
  fallbackStoreys,
  type ParcelKind,
  resolveKind,
  storeysOf,
  visualHeight,
} from "./parcel-style";
import { walkFor } from "./roads";
import { hintOf, type ParcelHint, type ParcelSource } from "./parcel-source";
import { lotRhythmFor } from "./sf-adjacency";
import { districtAt, isLandCell } from "./sf-map";
import type { Terrain } from "./terrain";

// THE PARCEL PLAN: every footprint in the parcel source (parcel-source.ts:
// the downtown survey plus OpenStreetMap for the rest of the city) resolved into a
// buildable lot — clipped back to the kerb, seated on its hill, given a kind,
// a storey count and a terrace rhythm, and a collision box. Pure and
// deterministic: no shared rng, no THREE, no dependence on what any other
// pass placed — so both load paths (cold gen and the baked bins) and the
// harness compute the identical city from the same inputs.
//
// WHY CLIP INSTEAD OF REJECT. The previous pass threw away any parcel with a
// ring vertex deeper than 1.2u inside the drawn asphalt: 9,358 of 21,023 —
// 44% of downtown — because the streets here are arcade-wide (a residential
// facade line sits 4.5u off the centreline against SF's real 2.25u) and every
// parcel that fronts one loses its first few metres to the roadway. The real
// lot pattern survives that loss with room to spare (a 100 ft lot is 6.8u
// deep), so the fix is to move the vertex, not the building: each ring vertex
// inside a street's setback is pushed out to the setback line along the
// perpendicular from the centreline, which keeps party walls exactly
// coincident (both neighbours push the shared vertex to the same point) and
// keeps L-shapes L-shaped.
//
// WHAT STILL CANNOT BE A BUILDING BECOMES A LOT. A ring the clip folds, a
// group ring that spans a street, a parcel under a viaduct too low for even
// one storey, a parcel with a pillar in it — each used to leave bare ground,
// and the kit walk that once filled those gaps no longer runs inside the
// survey. They are recovered where geometry allows (a folded ring becomes its
// own box, a street-spanning ring is cut at the street and the larger side
// kept, a parcel under a deck is built to the storeys that fit) and the rest
// are emitted as surface parking lots (`lots`), which the mesh pass paints
// and parks cars on. Nothing in the survey is left as raw ground.
//
// The ~500 that still fail the straddle test are MEDIAN parcels: a divided
// boulevard is two parallel edges in the network, and the game's arcade
// widths cover the strip between them where the survey has a row of shops.
// The clip slides such a ring out of one carriageway into the other, the cut
// leaves nothing, and the road is drawn over the spot — there is no ground to
// leave bare. `pnpm test` carries them as a baseline, not a defect.

/** Facade to kerb: the sidewalk plus a stoop (city.ts FACADE_MARGIN). */
const FACADE_MARGIN = 0.45;
/** Past this fall across one parcel the face is a cliff and stays green. */
const CLIFF = 9;
const STEP_INTO_SLOPE = 0.62;
const STEP_BURY_MAX = 1.6;
const MIN_AREA = 1.5;
const MIN_SIDE = 1.1;
/**
 * A parcel the clip left shallower than this is stretched back into its block
 * to this depth. On an arterial the game's setback (7u of asphalt + 2u of
 * walk) reaches 9.5u from the centreline against SF's real ~3u, which is more
 * than the whole depth of a 100 ft lot — the old pass simply lost every
 * arterial frontage. Two and a half units is a facade with a room behind it;
 * the rear yards it borrows from are 4-6u deep in the source data.
 */
const MIN_DEPTH = 2.6;
/** Sample spacing for the wall-crosses-a-street test. */
const STRADDLE_STEP = 2.4;
/** Consecutive ring vertices closer than this collapse into one after the clip. */
const MERGE_EPS = 0.08;
/** Collision wall thickness for a non-rectangular ring (city.ts wallOBB). */
const WALL_T = 1.6;
/** Blocks are ~2 tiles; one dominant colour per block (city.ts BLOCK_SPAN). */
const BLOCK_SPAN = 26;
/** A roof has to clear the deck underside by this much. */
const DECK_CLEAR = 0.5;
/** A pillar footing this close to a wall is inside the building. */
const PILLAR_MARGIN = 0.3;
/**
 * Where a street CUTS a ring (splitOffStreets) the cut runs at the kerb plus
 * this, not at the full sidewalk setback: the rings that need cutting are
 * the ones wedged between two arcade-wide streets, and at the setback the
 * second street's band swallows what the first one left. A building flush
 * with the kerb is a thing San Francisco has.
 */
const KERB_STRIP = 0.9;
/** A lot needs this much plan to read as parking rather than a gap. */
const LOT_MIN_AREA = 6;
const LOT_MIN_SIDE = 2.2;
/**
 * A piece the street cut left is a building only if it is still most of the
 * ring: a sliver keeps the GROUP's surveyed height, and a 2u-wide piece of a
 * 17u warehouse outline is a chimney. Below this share the piece is built low.
 */
const SPLIT_KEEP_SHARE = 0.4;
const SPLIT_LOW_STOREYS = 2;

export type Obb = {
  readonly cx: number;
  readonly cz: number;
  /** Unit +A axis; +B is its left normal (-ez, ex). */
  readonly ex: number;
  readonly ez: number;
  readonly halfA: number;
  readonly halfB: number;
};

export type ParcelPlan = {
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
};

/** A surveyed parcel that is a surface lot: asphalt, bay lines, parked cars. */
export type ParcelLot = {
  readonly id: number;
  readonly seed: number;
  readonly ring: Float32Array;
  readonly n: number;
  /** Terrain height under each ring vertex. */
  readonly ys: Float32Array;
  readonly obb: Obb;
  /** Pillar footings standing in the lot — cars keep clear of them. */
  readonly pillars: readonly { readonly x: number; readonly z: number; readonly half: number }[];
};

export type ParcelPlanStats = {
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
};

export type ParcelPlanContext = {
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
};

export type ParcelPlanResult = {
  readonly plans: readonly ParcelPlan[];
  readonly lots: readonly ParcelLot[];
  readonly stats: ParcelPlanStats;
  /** Grid cells (see cellKey) the SURVEYED parcels cover, dilated one cell — built or not. */
  readonly covered: ReadonlySet<number>;
};

export const cellKey = (gx: number, gz: number): number => gx * 1024 + gz;
const gridXOf = (x: number): number => Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
const gridZOf = (z: number): number => Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);

export function blockHash(x: number, z: number): number {
  const bx = Math.floor((x + WORLD_HALF_X) / BLOCK_SPAN);
  const bz = Math.floor((z + WORLD_HALF_Z) / BLOCK_SPAN);
  let h = Math.imul(bx, 374761393) + Math.imul(bz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function hash32(a: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function signedArea(ring: Float32Array, n: number): number {
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += (ring[i * 2] ?? 0) * (ring[j * 2 + 1] ?? 0) - (ring[j * 2] ?? 0) * (ring[i * 2 + 1] ?? 0);
  }
  return a / 2;
}

function centroidOf(ring: Float32Array, n: number): readonly [number, number] {
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i * 2] ?? 0;
    cz += ring[i * 2 + 1] ?? 0;
  }
  return [cx / n, cz / n];
}

function segmentsCross(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): boolean {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** A polygon whose non-adjacent edges never cross. */
function isSimple(ring: Float32Array, n: number): boolean {
  for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n;
    for (let j = i + 2; j < n; j++) {
      const j1 = (j + 1) % n;
      if (j1 === i) continue;
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
}

export function pointInRing(ring: Float32Array, n: number, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2] ?? 0;
    const zi = ring[i * 2 + 1] ?? 0;
    const xj = ring[j * 2] ?? 0;
    const zj = ring[j * 2 + 1] ?? 0;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function distToRing(ring: Float32Array, n: number, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
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
    if (d < best) best = d;
  }
  return best;
}

function obbOf(ring: Float32Array, n: number, ex: number, ez: number): Obb {
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = ring[i * 2] ?? 0;
    const z = ring[i * 2 + 1] ?? 0;
    const a = x * ex + z * ez;
    const b = -x * ez + z * ex;
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
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
}

/** The OBB as a positive-area 4-ring. */
function rectRing(o: Obb): Float32Array {
  const ring = new Float32Array(8);
  const corners: readonly (readonly [number, number])[] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  corners.forEach(([a, b], i) => {
    ring[i * 2] = o.cx + a * o.halfA * o.ex - b * o.halfB * o.ez;
    ring[i * 2 + 1] = o.cz + a * o.halfA * o.ez + b * o.halfB * o.ex;
  });
  if (signedArea(ring, 4) < 0) {
    const rev = new Float32Array(8);
    for (let k = 0; k < 4; k++) {
      rev[k * 2] = ring[(3 - k) * 2] ?? 0;
      rev[k * 2 + 1] = ring[(3 - k) * 2 + 1] ?? 0;
    }
    return rev;
  }
  return ring;
}

/** Frame of the ring's longest edge — the axis a box fallback is laid on. */
function longestEdgeFrame(ring: Float32Array, n: number): readonly [number, number] {
  let ex = 1;
  let ez = 0;
  let best = 0;
  for (let i = 0; i < n; i++) {
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
}

/** One solid per wall for an irregular ring — an AABB over an L walls off a street corner. */
function wallSolids(ring: Float32Array, n: number): Solid[] {
  const out: Solid[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = ring[i * 2] ?? 0;
    const z0 = ring[i * 2 + 1] ?? 0;
    const x1 = ring[j * 2] ?? 0;
    const z1 = ring[j * 2 + 1] ?? 0;
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 2.2) continue;
    const ex = (x1 - x0) / len;
    const ez = (z1 - z0) / len;
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    out.push({
      minX: mx - len / 2,
      maxX: mx + len / 2,
      minZ: mz - WALL_T / 2,
      maxZ: mz + WALL_T / 2,
      yaw: Math.atan2(-ez, ex),
    });
  }
  return out;
}

function obbSolid(o: Obb, shrink: number): Solid {
  return {
    minX: o.cx - o.halfA * shrink,
    maxX: o.cx + o.halfA * shrink,
    minZ: o.cz - o.halfB * shrink,
    maxZ: o.cz + o.halfB * shrink,
    yaw: Math.atan2(-o.ez, o.ex),
  };
}

function setbackFor(half: number): number {
  return half + walkFor(half) + FACADE_MARGIN;
}

/** What the plan needs from a nearest-street query. */
type Hit = {
  readonly edge: NetEdge;
  readonly dist: number;
  readonly x: number;
  readonly z: number;
  readonly tx: number;
  readonly tz: number;
};
type NearestFn = (x: number, z: number, maxDist: number) => Hit | null;

/**
 * The streets around ONE parcel, fetched once, so every query the parcel
 * makes — some forty of them — walks a handful of edges instead of the
 * network's bucket hash. Same answer as `RoadNetwork.nearest` for any point
 * within the fetch radius of the centre.
 */
/** Closest point on one edge's polyline, with the tangent there. */
function closestOnEdge(e: NetEdge, x: number, z: number): Hit {
  let bd = Infinity;
  let best: Hit = { edge: e, dist: Infinity, x, z, tx: 1, tz: 0 };
  const pts = e.pts;
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
      best = { edge: e, dist: Math.sqrt(d2), x: px, z: pz, tx: dx / dl, tz: dz / dl };
    }
  }
  return best;
}

type Nearby = { readonly edges: readonly NetEdge[]; readonly nearest: NearestFn };

function nearbyStreets(network: RoadNetwork, cx: number, cz: number, r: number): Nearby {
  const edges = network.edgesWithin(cx, cz, r);
  return {
    edges,
    nearest: (x, z, maxDist) => {
      let best: Hit | null = null;
      for (const e of edges) {
        const h = closestOnEdge(e, x, z);
        if (h.dist < maxDist && (best === null || h.dist < best.dist)) best = h;
      }
      return best;
    },
  };
}

/**
 * Push every ring vertex inside a street's setback out to the setback line,
 * on the PARCEL'S side of that street — the side its centroid is on. A vertex
 * that started across the centreline (a rectangle drawn over a street) comes
 * back to this side too, so the ring can never end up straddling the road
 * with its centroid in the lane. Returns the number of vertices moved; a
 * vertex near a junction may land inside the cross street's setback on the
 * first pass, so the caller iterates.
 */
function clipToKerb(
  ring: Float32Array,
  n: number,
  edges: readonly NetEdge[],
  cx: number,
  cz: number,
): number {
  type Street = {
    readonly ox: number;
    readonly oz: number;
    readonly px: number;
    readonly pz: number;
    readonly setback: number;
  };
  // EVERY street within reach, each as the local line through the centroid's
  // projection onto it (a street is straight over the ~10u a parcel spans),
  // with the parcel's side of it. Asking only each vertex's single nearest
  // edge missed the boulevard at a corner: every vertex was nearer the side
  // street, so the boulevard never entered the set and the ring stayed in
  // its lane.
  const streets: Street[] = [];
  let reach = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot((ring[i * 2] ?? 0) - cx, (ring[i * 2 + 1] ?? 0) - cz);
    if (d > reach) reach = d;
  }
  for (const e of edges) {
    const hit = closestOnEdge(e, cx, cz);
    const setback = setbackFor(e.half);
    if (hit.dist > setback + reach + 0.5) continue;
    let px = -hit.tz;
    let pz = hit.tx;
    if ((cx - hit.x) * px + (cz - hit.z) * pz < 0) {
      px = -px;
      pz = -pz;
    }
    streets.push({ ox: hit.x, oz: hit.z, px, pz, setback });
  }
  let moved = 0;
  for (const st of streets) {
    let dMin = Infinity;
    let dMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const d = ((ring[i * 2] ?? 0) - st.ox) * st.px + ((ring[i * 2 + 1] ?? 0) - st.oz) * st.pz;
      if (d < dMin) dMin = d;
      if (d > dMax) dMax = d;
    }
    if (dMin >= st.setback - 0.02) continue;
    if (dMax <= st.setback + 1.0) {
      // The whole parcel (or all but a sliver of it) lies inside the setback
      // band: a real building that stands where this map draws its
      // boulevard. Slide it back to the setback line intact — shape, depth
      // and party walls all survive, and the street keeps its frontage
      // instead of losing a whole side.
      const shift = st.setback - dMin;
      for (let i = 0; i < n; i++) {
        ring[i * 2] = (ring[i * 2] ?? 0) + st.px * shift;
        ring[i * 2 + 1] = (ring[i * 2 + 1] ?? 0) + st.pz * shift;
      }
      moved += n;
      continue;
    }
    // Partly inside: only the vertices in the band move, out to its line.
    for (let i = 0; i < n; i++) {
      const x = ring[i * 2] ?? 0;
      const z = ring[i * 2 + 1] ?? 0;
      const d = (x - st.ox) * st.px + (z - st.oz) * st.pz;
      if (d >= st.setback - 0.02) continue;
      ring[i * 2] = x + st.px * (st.setback - d);
      ring[i * 2 + 1] = z + st.pz * (st.setback - d);
      moved++;
    }
  }
  return moved;
}

/** Collapse consecutive vertices the clip stacked onto one point. Returns the new count. */
function mergeClose(ring: Float32Array, n: number): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
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
    m++;
  }
  if (
    m > 1 &&
    Math.hypot(
      (ring[0] ?? 0) - (ring[(m - 1) * 2] ?? 0),
      (ring[1] ?? 0) - (ring[(m - 1) * 2 + 1] ?? 0),
    ) < MERGE_EPS
  ) {
    m--;
  }
  return m;
}

/** Ids of the streets whose asphalt a wall runs through between its (clear) endpoints. */
function straddledStreets(ring: Float32Array, n: number, nearest: NearestFn): number[] {
  const ids = new Set<number>();
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = ring[i * 2] ?? 0;
    const z0 = ring[i * 2 + 1] ?? 0;
    const x1 = ring[j * 2] ?? 0;
    const z1 = ring[j * 2 + 1] ?? 0;
    const len = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.ceil(len / STRADDLE_STEP);
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const hit = nearest(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, ROAD_TILE);
      if (hit !== null && hit.dist < hit.edge.half - 0.15) ids.add(hit.edge.id);
    }
  }
  return [...ids];
}

type PolyRing = [number, number][];

/**
 * Cut the streets out of a ring and keep the largest piece. A survey ring
 * that spans a street is a GROUP outline (several buildings the extractor
 * could not separate); the piece on the far side is another building's, and
 * this parcel is the one its centroid is nearest.
 */
function splitOffStreets(
  ring: Float32Array,
  n: number,
  edgeIds: readonly number[],
  network: RoadNetwork,
): Float32Array | null {
  const strips: PolyRing[][] = [];
  for (const id of edgeIds) {
    const edge = network.edges.find((e) => e.id === id);
    if (!edge) continue;
    const w = edge.half + KERB_STRIP;
    const pts = edge.pts;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i] ?? 0;
      const az = pts[i + 1] ?? 0;
      const bx = pts[i + 2] ?? 0;
      const bz = pts[i + 3] ?? 0;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      const tx = (bx - ax) / len;
      const tz = (bz - az) / len;
      const nx = -tz;
      const nz = tx;
      // Extended by w along the tangent so consecutive quads overlap and the
      // union has no notch at a bend.
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
  if (strips.length === 0) return null;
  const outline: PolyRing = [];
  for (let i = 0; i < n; i++) outline.push([ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0]);
  const first = outline[0];
  if (first) outline.push([first[0], first[1]]);
  let pieces: PolyRing[][];
  try {
    const cut = polygonClipping.union([], ...strips);
    pieces = polygonClipping.difference([outline], cut);
  } catch {
    return null;
  }
  let best: PolyRing | null = null;
  let bestArea = 0;
  for (const poly of pieces) {
    const outer = poly[0];
    if (!outer) continue;
    let a = 0;
    for (let i = 0; i + 1 < outer.length; i++) {
      const p = outer[i];
      const q = outer[i + 1];
      if (!p || !q) continue;
      a += p[0] * q[1] - q[0] * p[1];
    }
    a = Math.abs(a) / 2;
    if (a > bestArea) {
      bestArea = a;
      best = outer;
    }
  }
  if (!best || bestArea < MIN_AREA) return null;
  const m = best.length - 1; // closed ring
  const out = new Float32Array(m * 2);
  for (let i = 0; i < m; i++) {
    const p = best[i];
    out[i * 2] = p?.[0] ?? 0;
    out[i * 2 + 1] = p?.[1] ?? 0;
  }
  if (signedArea(out, m) < 0) {
    const rev = new Float32Array(m * 2);
    for (let k = 0; k < m; k++) {
      rev[k * 2] = out[(m - 1 - k) * 2] ?? 0;
      rev[k * 2 + 1] = out[(m - 1 - k) * 2 + 1] ?? 0;
    }
    return rev;
  }
  return out;
}

type PillarSpot = { readonly x: number; readonly z: number; readonly half: number };

/** Pillars bucketed on the block lattice, so a parcel asks only its own neighbourhood. */
class PillarIndex {
  private readonly cells = new Map<number, PillarSpot[]>();
  constructor(spots: readonly PillarSpot[]) {
    for (const p of spots) {
      const k = cellKey(gridXOf(p.x), gridZOf(p.z));
      const arr = this.cells.get(k);
      if (arr) arr.push(p);
      else this.cells.set(k, [p]);
    }
  }
  /** Pillars whose footing touches the ring. */
  inside(ring: Float32Array, n: number): PillarSpot[] {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = ring[i * 2] ?? 0;
      const z = ring[i * 2 + 1] ?? 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const out: PillarSpot[] = [];
    for (let gx = gridXOf(minX) - 1; gx <= gridXOf(maxX) + 1; gx++) {
      for (let gz = gridZOf(minZ) - 1; gz <= gridZOf(maxZ) + 1; gz++) {
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
          if (pointInRing(ring, n, p.x, p.z) || distToRing(ring, n, p.x, p.z) < reach) out.push(p);
        }
      }
    }
    return out;
  }
}

export function planParcels(ctx: ParcelPlanContext): ParcelPlanResult {
  const { source, network, terrain, reserved, standAt } = ctx;
  const stats: ParcelPlanStats = {
    built: 0,
    water: 0,
    stacked: 0,
    reserved: 0,
    park: 0,
    freeway: 0,
    clipped: 0,
    folded: 0,
    straddle: 0,
    onRoad: 0,
    cliff: 0,
    movedVerts: 0,
    stretched: 0,
    underDeck: 0,
    boxed: 0,
    split: 0,
    lots: 0,
  };
  const plans: ParcelPlan[] = [];
  const lots: ParcelLot[] = [];
  const covered = new Set<number>();
  const pillars = new PillarIndex(freewayPillars(terrain, network));
  // Rebound per parcel from the parcel's own street subset (nearbyStreets).
  let nearest: NearestFn = (x, z, maxDist) => network.nearest(x, z, maxDist);
  let nearEdges: readonly NetEdge[] = network.edges;
  const onAsphalt = (x: number, z: number, margin: number): boolean => {
    const hit = nearest(x, z, ROAD_TILE * 1.4);
    return hit !== null && hit.dist < hit.edge.half + margin;
  };
  const anyVertexInLane = (ring: Float32Array, n: number): boolean => {
    for (let i = 0; i < n; i++) {
      if (onAsphalt(ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0, -0.45)) return true;
    }
    return false;
  };
  const soffitOver = (ring: Float32Array, n: number, cx: number, cz: number): number | null => {
    let soffit = freewaySoffitAt(terrain, network, cx, cz, 0.5);
    for (let i = 0; i < n; i++) {
      const s = freewaySoffitAt(terrain, network, ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0, 0.3);
      if (s !== null && (soffit === null || s < soffit)) soffit = s;
    }
    return soffit;
  };
  /** A parcel that cannot be a building but can be a lot: paint + cars. */
  const emitLot = (
    id: number,
    seed: number,
    ring: Float32Array,
    n: number,
    obb: Obb,
    spots: readonly PillarSpot[],
  ): boolean => {
    if (Math.min(obb.halfA, obb.halfB) * 2 < LOT_MIN_SIDE || signedArea(ring, n) < LOT_MIN_AREA) {
      return false;
    }
    const ys = new Float32Array(n);
    for (let i = 0; i < n; i++) ys[i] = standAt(ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0);
    lots.push({ id, seed, ring, n, ys, obb, pillars: spots });
    stats.lots++;
    return true;
  };

  for (let id = 0; id < source.count; id++) {
    const v0 = source.offsets[id] ?? 0;
    const v1 = source.offsets[id + 1] ?? v0;
    const n0 = v1 - v0;
    if (n0 < 3) continue;
    const realH = source.heights[id] ?? 0;
    const hint = hintOf(source, id);
    const hero = (source.hero[id] ?? 0) === 1;
    const blindMask = source.blind[id] ?? 0;
    // Orient positive (interior to the left of each edge) — party-wall edge
    // indices follow the reversal.
    let n = n0;
    let ring: Float32Array = source.coords.slice(v0 * 2, v1 * 2);
    let blind = new Uint8Array(n);
    if (signedArea(ring, n) < 0) {
      const rev = new Float32Array(n * 2);
      for (let k = 0; k < n; k++) {
        rev[k * 2] = ring[(n - 1 - k) * 2] ?? 0;
        rev[k * 2 + 1] = ring[(n - 1 - k) * 2 + 1] ?? 0;
      }
      ring.set(rev);
      for (let e = 0; e < n && e < 32; e++) {
        if (blindMask & (1 << e)) blind[(n - 2 - e + 2 * n) % n] = 1;
      }
    } else {
      for (let e = 0; e < n && e < 32; e++) if (blindMask & (1 << e)) blind[e] = 1;
    }
    const original = Float32Array.from(ring);
    const area0 = signedArea(ring, n);
    let [cx, cz] = centroidOf(ring, n);
    {
      // Fetch radius: the ring's reach plus the widest query any step makes
      // (the front-edge search at 1.6 tiles), so no answer below can differ
      // from the network's own.
      let reach = 0;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot((ring[i * 2] ?? 0) - cx, (ring[i * 2 + 1] ?? 0) - cz);
        if (d > reach) reach = d;
      }
      const near = nearbyStreets(network, cx, cz, reach + ROAD_TILE * 2.6 + MIN_DEPTH);
      nearest = near.nearest;
      nearEdges = near.edges;
    }
    const gx = gridXOf(cx);
    const gz = gridZOf(cz);
    if (!isLandCell(gx, gz)) {
      stats.water++;
      continue;
    }
    // Coverage is the SOURCE data's footprint, not the built one: a block the
    // survey mapped is this fabric's to fill, and a parcel it then rejects
    // leaves a lot, not a kit house in the middle of a real terrace.
    for (let i = 0; i < n; i++) {
      const vgx = gridXOf(ring[i * 2] ?? 0);
      const vgz = gridZOf(ring[i * 2 + 1] ?? 0);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) covered.add(cellKey(vgx + dx, vgz + dz));
      }
    }
    // A landmark parcel is a FOOTPRINT question, not a centroid one: a 13u
    // cell is smaller than a parcel.
    let onReserved = reserved.has(`${gx},${gz}`);
    for (let i = 0; i < n && !onReserved; i++) {
      if (reserved.has(`${gridXOf(ring[i * 2] ?? 0)},${gridZOf(ring[i * 2 + 1] ?? 0)}`)) {
        onReserved = true;
      }
    }
    if (onReserved) {
      stats.reserved++;
      continue;
    }
    if (isParkLand(gx, gz)) {
      stats.park++;
      continue;
    }

    // --- The kerb clip ---
    let movedAny = false;
    const clip = (): void => {
      for (let iter = 0; iter < 3; iter++) {
        const moved = clipToKerb(ring, n, nearEdges, cx, cz);
        stats.movedVerts += moved;
        if (moved === 0) break;
        movedAny = true;
      }
      if (movedAny) {
        // Stacked vertices change the ring's vertex count; the party-wall
        // edge indices only survive if nothing merged, so a merge drops them
        // (the walls are still coincident — only the window rule loses them).
        const m = mergeClose(ring, n);
        if (m !== n) {
          n = m;
          ring = ring.slice(0, n * 2);
          blind = new Uint8Array(n);
        }
      }
    };
    clip();
    if (n < 3) {
      stats.clipped++;
      ctx.onReject?.(id, "clipped", "n<3");
      continue;
    }
    // --- Recovery: a folded ring becomes its box; a ring across a street is
    // cut there and the larger side kept. Each recovery re-runs the tests
    // that the previous shape failed.
    let boxed = false;
    let split = false;
    if (!isSimple(ring, n)) {
      const [ex, ez] = longestEdgeFrame(ring, n);
      ring = rectRing(obbOf(ring, n, ex, ez));
      n = 4;
      blind = new Uint8Array(4);
      boxed = true;
    }
    let crossing = straddledStreets(ring, n, nearest);
    for (let round = 0; crossing.length > 0 && round < 4; round++) {
      const piece = splitOffStreets(ring, n, crossing, network);
      if (piece === null) break;
      ring = piece;
      n = piece.length / 2;
      blind = new Uint8Array(n);
      [cx, cz] = centroidOf(ring, n);
      split = true;
      // No re-clip: the clip would slide the piece back into the band it was
      // just cut out of. The piece is clear of asphalt by construction.
      if (n >= 3 && !isSimple(ring, n)) {
        const [ex, ez] = longestEdgeFrame(ring, n);
        ring = rectRing(obbOf(ring, n, ex, ez));
        n = 4;
        blind = new Uint8Array(4);
        boxed = true;
      }
      crossing = n >= 3 ? straddledStreets(ring, n, nearest) : [];
    }
    if (crossing.length > 0) {
      stats.straddle++;
      ctx.onReject?.(id, "straddle", `n=${n} split=${split} boxed=${boxed}`);
      continue;
    }
    if (n < 3) {
      stats.clipped++;
      ctx.onReject?.(id, "clipped", "n<3 after split");
      continue;
    }
    let area = signedArea(ring, n);
    if (area < 0.05) {
      stats.clipped++;
      ctx.onReject?.(id, "clipped", `area=${area.toFixed(2)} moved=${movedAny}`);
      continue;
    }
    [cx, cz] = centroidOf(ring, n);
    // A recovered ring (boxed, split) is a new shape; its last word is the
    // whole network's, not the subset fetched for the ring it replaced.
    if (boxed || split) nearest = (x, z, maxDist) => network.nearest(x, z, maxDist);
    if (onAsphalt(cx, cz, 0.4) || anyVertexInLane(ring, n)) {
      // The clip works one street at a time; a vertex it moved clear of a
      // minor street can land inside the boulevard that street joins.
      // Nothing here is allowed to stand in a lane.
      stats.onRoad++;
      ctx.onReject?.(id, "onRoad", `boxed=${boxed} split=${split}`);
      continue;
    }

    // --- Front edge: the non-blind edge nearest a street (longer wins a tie) ---
    let front = -1;
    let frontDist = Infinity;
    let frontLen = 0;
    let longest = -1;
    let longestLen = 0;
    for (let e = 0; e < n; e++) {
      if (blind[e] === 1) continue;
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
      if (len < 1.0) continue;
      const hit = nearest((x0 + x1) / 2, (z0 + z1) / 2, ROAD_TILE * 1.6);
      if (hit === null) continue;
      const d = hit.dist - hit.edge.half;
      if (d < frontDist - 0.3 || (Math.abs(d - frontDist) <= 0.3 && len > frontLen)) {
        frontDist = d;
        frontLen = len;
        front = e;
      }
    }
    if (front < 0) {
      front = longest;
      frontLen = longestLen;
    }

    // --- OBB in the front edge's frame ---
    let ex = 1;
    let ez = 0;
    if (front >= 0) {
      const j = (front + 1) % n;
      const dx = (ring[j * 2] ?? 0) - (ring[front * 2] ?? 0);
      const dz = (ring[j * 2 + 1] ?? 0) - (ring[front * 2 + 1] ?? 0);
      const len = Math.hypot(dx, dz) || 1;
      ex = dx / len;
      ez = dz / len;
    }
    let obb = obbOf(ring, n, ex, ez);
    if (movedAny && front >= 0 && obb.halfB * 2 < MIN_DEPTH - 0.05) {
      // The clip ate the depth (an arterial frontage): stretch the rear back
      // into the block, never past the depth the parcel really had.
      const orig = obbOf(original, n0, ex, ez);
      const want = Math.min(MIN_DEPTH, orig.halfB * 2);
      const deficit = want - obb.halfB * 2;
      if (deficit > 0.05) {
        // B measured inward from the front edge: minB is the street line.
        let minB = Infinity;
        for (let i = 0; i < n; i++) {
          const b = -(ring[i * 2] ?? 0) * ez + (ring[i * 2 + 1] ?? 0) * ex;
          if (b < minB) minB = b;
        }
        // Into a copy: the rear may back onto the next street, and a parcel
        // that cannot stretch stays shallow rather than standing in that lane.
        const stretched = Float32Array.from(ring);
        let clear = true;
        for (let i = 0; i < n && clear; i++) {
          const b = -(ring[i * 2] ?? 0) * ez + (ring[i * 2 + 1] ?? 0) * ex;
          if (b <= minB + 0.2) continue;
          const x = (ring[i * 2] ?? 0) - deficit * ez;
          const z = (ring[i * 2 + 1] ?? 0) + deficit * ex;
          if (onAsphalt(x, z, 0.3)) clear = false;
          stretched[i * 2] = x;
          stretched[i * 2 + 1] = z;
        }
        if (clear) {
          ring.set(stretched);
          obb = obbOf(ring, n, ex, ez);
          area = signedArea(ring, n);
          stats.stretched++;
        }
      }
    }
    if (Math.min(obb.halfA, obb.halfB) * 2 < MIN_SIDE || area < MIN_AREA) {
      stats.clipped++;
      ctx.onReject?.(
        id,
        "clipped",
        `A=${(obb.halfA * 2).toFixed(2)} B=${(obb.halfB * 2).toFixed(2)} area=${area.toFixed(2)} front=${front} moved=${movedAny} n=${n}`,
      );
      continue;
    }
    const rect = n === 4 && (obb.halfA * obb.halfB * 4) / area < 1.08;

    // --- Seat: cut into the uphill grade, sink the walls to the low corner ---
    let hiY = terrain.heightAt(cx, cz);
    let loY = hiY;
    for (let i = 0; i < n; i++) {
      const y = terrain.heightAt(ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0);
      if (y > hiY) hiY = y;
      if (y < loY) loY = y;
    }
    const fall = hiY - loY;
    if (fall > CLIFF) {
      stats.cliff++;
      continue;
    }
    const seatY = fall > 1.0 ? Math.max(loY + fall * STEP_INTO_SLOPE, hiY - STEP_BURY_MAX) : hiY;
    const footY = loY - 0.35;

    // --- Storeys, capped under a viaduct; kind; rhythm ---
    const district = districtAt(gx, gz);
    const character: FabricChar =
      district.character === "park" ? "residential" : district.character;
    const seed = hash32(id * 2654435761 + CITY_SEED);
    let storeys = realH > 0 ? storeysOf(realH) : fallbackStoreys(character, hint, seed);
    if (split && area < area0 * SPLIT_KEEP_SHARE) storeys = Math.min(storeys, SPLIT_LOW_STOREYS);
    const soffit = soffitOver(ring, n, cx, cz);
    const pillarHits = pillars.inside(ring, n);
    if (soffit !== null) {
      // Build what fits under the deck — SF's freeways run over two- and
      // three-storey fabric for most of their length — and a parcel with no
      // room for one storey, or a footing in its plan, is a lot.
      while (storeys > 1 && seatY + visualHeight(storeys) > soffit - DECK_CLEAR) storeys--;
      if (seatY + visualHeight(storeys) > soffit - DECK_CLEAR || pillarHits.length > 0) {
        stats.freeway++;
        emitLot(id, seed, ring, n, obb, pillarHits);
        continue;
      }
      stats.underDeck++;
    } else if (pillarHits.length > 0) {
      stats.freeway++;
      emitLot(id, seed, ring, n, obb, pillarHits);
      continue;
    }
    const kind = resolveKind({
      character,
      district: district.name,
      hint,
      storeys,
      area,
      frontage: frontLen,
      roll: (seed & 0xffff) / 0x10000,
    });
    const height = visualHeight(storeys);
    const rhythm = lotRhythmFor(district.name);
    let units = 1;
    if (front >= 0 && (kind === "rowhouse" || kind === "stucco" || kind === "midrise")) {
      const unitW = kind === "midrise" ? rhythm.p50 * 1.5 : rhythm.p50;
      units = Math.max(1, Math.min(12, Math.round(frontLen / unitW)));
    }

    const solids = rect ? [obbSolid(obb, 0.96)] : wallSolids(ring, n);
    if (solids.length === 0) solids.push(obbSolid(obb, 0.9));

    plans.push({
      id,
      hero,
      hint,
      kind,
      character,
      district: district.name,
      seed,
      blockHash: blockHash(cx, cz),
      ring,
      n,
      blind,
      front,
      seatY,
      footY,
      storeys,
      height,
      units,
      obb,
      rect,
      solids,
    });
    stats.built++;
    if (boxed) stats.boxed++;
    if (split) stats.split++;
  }
  return { plans, lots, stats, covered };
}

/** What a city without a parcel source gets: nothing, and every stat at zero. */
export function emptyParcelPlan(): ParcelPlanResult {
  return {
    plans: [],
    lots: [],
    covered: new Set(),
    stats: {
      built: 0,
      water: 0,
      stacked: 0,
      reserved: 0,
      park: 0,
      freeway: 0,
      clipped: 0,
      folded: 0,
      straddle: 0,
      onRoad: 0,
      cliff: 0,
      movedVerts: 0,
      stretched: 0,
      underDeck: 0,
      boxed: 0,
      split: 0,
      lots: 0,
    },
  };
}

/** The front edge's endpoints, for the facade stamp furniture dresses. */
export function frontSegment(p: ParcelPlan): readonly [number, number, number, number] | null {
  if (p.front < 0) return null;
  const j = (p.front + 1) % p.n;
  return [
    p.ring[p.front * 2] ?? 0,
    p.ring[p.front * 2 + 1] ?? 0,
    p.ring[j * 2] ?? 0,
    p.ring[j * 2 + 1] ?? 0,
  ];
}
