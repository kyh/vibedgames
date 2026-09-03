import { CITY_SEED, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import type { Solid } from "../shared/types";
import { nearFreeway } from "./freeways";
import { isParkLand } from "./land-class";
import type { RoadNetwork } from "./network";
import {
  type FabricChar,
  type ParcelKind,
  resolveKind,
  storeysOf,
  visualHeight,
} from "./parcel-style";
import { walkFor } from "./roads";
import { lotRhythmFor, parcelAt } from "./sf-adjacency";
import { SF_FOOTPRINTS } from "./sf-footprints";
import { districtAt, isLandCell } from "./sf-map";
import type { Terrain } from "./terrain";

// THE PARCEL PLAN: every real footprint (sf-footprints.ts) resolved into a
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
const STRADDLE_STEP = 1.5;
/** Consecutive ring vertices closer than this collapse into one after the clip. */
const MERGE_EPS = 0.08;
/** Collision wall thickness for a non-rectangular ring (city.ts wallOBB). */
const WALL_T = 1.6;
/** Blocks are ~2 tiles; one dominant colour per block (city.ts BLOCK_SPAN). */
const BLOCK_SPAN = 26;

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
  /** Index into SF_FOOTPRINTS. */
  readonly id: number;
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

export type ParcelPlanStats = {
  built: number;
  water: number;
  stacked: number;
  reserved: number;
  park: number;
  freeway: number;
  /** Rejected after the clip: too small or too thin to be a building. */
  clipped: number;
  /** The clip folded the ring over itself (a rectangle drawn across a street). */
  folded: number;
  /** A wall still crosses a roadway — the ring spanned a street the clip could not resolve. */
  straddle: number;
  /** Centroid still in a lane after the clip. */
  onRoad: number;
  cliff: number;
  /** Ring vertices the clip moved. */
  movedVerts: number;
  /** Parcels stretched back into the block to keep MIN_DEPTH. */
  stretched: number;
};

export type ParcelPlanContext = {
  readonly network: RoadNetwork;
  readonly terrain: Terrain;
  /** "gx,gz" cells no procedural mass may touch (landmarks, depots, editor clears). */
  readonly reserved: ReadonlySet<string>;
  /** Why a footprint did not become a building — the harness tallies these. */
  readonly onReject?: (id: number, reason: keyof ParcelPlanStats, detail: string) => void;
};

export type ParcelPlanResult = {
  readonly plans: readonly ParcelPlan[];
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
  network: RoadNetwork,
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
  // One street per edge id the parcel's vertices are nearest to, with the
  // parcel's side of it. Signed distance of any vertex to the street is then
  // measured against that one local line — a street is straight over the
  // ~10u a parcel spans.
  const streets = new Map<number, Street>();
  for (let i = 0; i < n; i++) {
    const hit = network.nearest(ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0, ROAD_TILE * 1.4);
    if (hit === null || streets.has(hit.edge.id)) continue;
    let px = -hit.tz;
    let pz = hit.tx;
    if ((cx - hit.x) * px + (cz - hit.z) * pz < 0) {
      px = -px;
      pz = -pz;
    }
    streets.set(hit.edge.id, {
      ox: hit.x,
      oz: hit.z,
      px,
      pz,
      setback: hit.edge.half + walkFor(hit.edge.half) + FACADE_MARGIN,
    });
  }
  let moved = 0;
  for (const st of streets.values()) {
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

/** Does any wall run through the drawn asphalt between its two (clear) endpoints? */
function straddlesStreet(ring: Float32Array, n: number, network: RoadNetwork): boolean {
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
      const hit = network.nearest(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, ROAD_TILE);
      if (hit !== null && hit.dist < hit.edge.half - 0.15) return true;
    }
  }
  return false;
}

export function planParcels(ctx: ParcelPlanContext): ParcelPlanResult {
  const { network, terrain, reserved } = ctx;
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
  };
  const plans: ParcelPlan[] = [];
  const covered = new Set<number>();
  const onAsphalt = (x: number, z: number, margin: number): boolean => {
    const hit = network.nearest(x, z, ROAD_TILE * 1.4);
    return hit !== null && hit.dist < hit.edge.half + margin;
  };

  for (let id = 0; id < SF_FOOTPRINTS.length; id++) {
    const flat = SF_FOOTPRINTS[id];
    if (flat === undefined) continue;
    const realH = flat[0] ?? 0;
    const n0 = (flat.length - 1) >> 1;
    if (realH <= 0 || n0 < 3) continue;
    const adjacency = parcelAt(id);
    if (adjacency?.stacked === true) {
      stats.stacked++;
      continue;
    }
    // Orient positive (interior to the left of each edge) — party-wall edge
    // indices follow the reversal.
    let n = n0;
    let ring = new Float32Array(n * 2);
    let blind = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      ring[i * 2] = flat[1 + i * 2] ?? 0;
      ring[i * 2 + 1] = flat[2 + i * 2] ?? 0;
    }
    if (signedArea(ring, n) < 0) {
      const rev = new Float32Array(n * 2);
      for (let k = 0; k < n; k++) {
        rev[k * 2] = ring[(n - 1 - k) * 2] ?? 0;
        rev[k * 2 + 1] = ring[(n - 1 - k) * 2 + 1] ?? 0;
      }
      ring.set(rev);
      if (adjacency) for (const e of adjacency.blind) blind[(n - 2 - e + 2 * n) % n] = 1;
    } else if (adjacency) {
      for (const e of adjacency.blind) blind[e] = 1;
    }
    const original = Float32Array.from(ring);
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      cx += ring[i * 2] ?? 0;
      cz += ring[i * 2 + 1] ?? 0;
    }
    cx /= n;
    cz /= n;
    const gx = gridXOf(cx);
    const gz = gridZOf(cz);
    if (!isLandCell(gx, gz)) {
      stats.water++;
      continue;
    }
    // Coverage is the SOURCE data's footprint, not the built one: a block the
    // survey mapped is this fabric's to fill, and a parcel it then rejects
    // (a freeway corridor, a ring across a street) leaves a lot, not a kit
    // house in the middle of a real terrace.
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
    let fwHit = nearFreeway(cx, cz, 0.5);
    for (let i = 0; i < n && !fwHit; i++) {
      if (nearFreeway(ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0, 0.3)) fwHit = true;
    }
    if (fwHit) {
      stats.freeway++;
      continue;
    }

    // --- The kerb clip ---
    let movedAny = false;
    for (let iter = 0; iter < 3; iter++) {
      const moved = clipToKerb(ring, n, network, cx, cz);
      stats.movedVerts += moved;
      if (moved === 0) break;
      movedAny = true;
    }
    if (movedAny) {
      // Stacked vertices change the ring's vertex count; the party-wall edge
      // indices only survive if nothing merged, so a merge drops them (the
      // walls are still coincident — only the window rule loses them).
      const m = mergeClose(ring, n);
      if (m !== n) {
        n = m;
        ring = ring.slice(0, n * 2);
        blind = new Uint8Array(n);
      }
      if (n < 3) {
        stats.clipped++;
        ctx.onReject?.(id, "clipped", "n<3");
        continue;
      }
      if (!isSimple(ring, n)) {
        stats.folded++;
        ctx.onReject?.(id, "folded", `n=${n} n0=${n0}`);
        continue;
      }
      if (straddlesStreet(ring, n, network)) {
        stats.straddle++;
        ctx.onReject?.(id, "straddle", `n=${n}`);
        continue;
      }
    }
    let area = signedArea(ring, n);
    if (area < 0.05) {
      stats.clipped++;
      ctx.onReject?.(id, "clipped", `area=${area.toFixed(2)} moved=${movedAny}`);
      continue;
    }
    cx = 0;
    cz = 0;
    for (let i = 0; i < n; i++) {
      cx += ring[i * 2] ?? 0;
      cz += ring[i * 2 + 1] ?? 0;
    }
    cx /= n;
    cz /= n;
    if (onAsphalt(cx, cz, 0.4)) {
      stats.onRoad++;
      continue;
    }
    // The clip works one street at a time; a vertex it moved clear of a minor
    // street can land inside the boulevard that street joins. Nothing here is
    // allowed to stand in a lane, so the last word is a plain test of every
    // vertex against the drawn asphalt.
    let vertInLane = false;
    for (let i = 0; i < n && !vertInLane; i++) {
      if (onAsphalt(ring[i * 2] ?? 0, ring[i * 2 + 1] ?? 0, -0.45)) vertInLane = true;
    }
    if (vertInLane) {
      stats.onRoad++;
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
      const hit = network.nearest((x0 + x1) / 2, (z0 + z1) / 2, ROAD_TILE * 1.6);
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

    // --- Kind, storeys, rhythm ---
    const district = districtAt(gx, gz);
    const character: FabricChar =
      district.character === "park" ? "residential" : district.character;
    const seed = hash32(id * 2654435761 + CITY_SEED);
    const storeys = storeysOf(realH);
    const kind = resolveKind({
      character,
      district: district.name,
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
  }
  return { plans, stats, covered };
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
