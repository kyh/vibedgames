import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { geoLayoutKey, type ModelCache } from "../assets/loader";
import {
  BUILDINGS_COMMERCIAL,
  BUILDINGS_INDUSTRIAL,
  BUILDINGS_SKYSCRAPER,
  BUILDINGS_SUBURBAN,
  KK_BUILDINGS,
  modelUrl,
  TREE_LARGE,
  TREE_SMALL,
  GARAGE_MODEL,
} from "../assets/manifest";
import { registerBeacons } from "../fx/beacon-lights";
import {
  CHUNK,
  CITY_SEED,
  DRAW_DISTANCE,
  GRID_X,
  GRID_Z,
  ROAD_TILE,
  WORLD_H,
  WORLD_HALF_X,
  WORLD_HALF_Z,
  WORLD_W,
} from "../shared/constants";
import { Rng } from "../shared/rng";
import { type Dir, DIR_DELTA, E, N, S, W } from "../shared/types";
import { type DrapeField, toFloat32Attributes } from "./conform";
import { activeMapProps } from "./map-file";
import { buildFurniture, type LampHead, type ParkedSpec } from "./furniture";
import { buildGoldenGate, goldenGateBeacons, goldenGatePlan } from "./golden-gate";
import { type NetEdge, RoadNetwork } from "./network";
import { type CityPlan, generateCity } from "./grid";
import { CUSTOM_MAP, editorMode, loadLocalOverrides } from "./custom-map";
import {
  applyGrassMottle,
  makeGroundColorAt,
  makeGroundOffset,
  makeStandingSurface,
  makeTerracedDrapeField,
  parkCellHeight,
} from "./ground";
import { landuseSandAt } from "./sf-landuse";
import {
  type LandClassAt,
  isParkLand,
  makeLandClassAt,
  wheelSurface,
  type WheelSurface,
} from "./land-class";
import { buildGridNetwork } from "./grid-network";
import {
  bakeConstantColor,
  buildJunctionMap,
  buildRoads,
  type JunctionMap,
  ROAD_MATERIALS,
  roadCollapseTarget,
  roadPartsToMeshes,
  walkFor,
} from "./roads";
import type { CityGenPayload } from "./gen-worker";
import { buildFreeways, nearFreeway } from "./freeways";
import { buildPiers } from "./piers";
import { buildLandmarks, landmarkProtection } from "./landmarks";
import { SF_FOOTPRINTS } from "./sf-footprints";
import { frontEdgeOf, type LotRhythm, lotRhythmFor, parcelAt } from "./sf-adjacency";
import { prismSpec } from "./sf-prisms";
import {
  type District,
  type DistrictChar,
  districtAt,
  isLandCell,
  makeTerrain,
  paletteFor,
  tintAmountFor,
} from "./sf-map";
import type { Terrain } from "./terrain";
import type { Solid, SurfaceDeck } from "../shared/types";
import { DriveSurface } from "./surface";

// Re-exported for the many existing import sites; the definitions live in
// shared/types so physics/solid-index/furniture need not reach into this
// 2k-line module for a data type.
export type { Solid, SurfaceDeck };

export type RoadCell = { readonly gx: number; readonly gz: number };

const HALF_PI = Math.PI / 2;

// Building front faces +Z in the native model; this offset rotates it to face
// the street. Tune if entrances point the wrong way. Because the model's Z
// faces the kerb, its X runs ALONG the street: X is the lot frontage and Z is
// the lot depth, and the two scale independently (see fitLotScale).
const HALF_PI_CITY = Math.PI / 2;
const BUILDING_FRONT_OFFSET = Math.PI;
// Commercial districts whose real fabric is wall-to-wall mid-rise — frontage
// rows pack shoulder-to-shoulder here instead of the gapped commercial step.
const PACKED_COMMERCIAL = new Set(["Chinatown", "North Beach", "Union Square"]);

// Hillside foundations: concrete plinth under buildings on a grade, with a
// tuck-under garage cut into its downhill face (the single most-repeated hill
// element in SF, and in this map).
const PLINTH_GEO = new THREE.BoxGeometry(1, 1, 1);
const PLINTH_MAT = new THREE.MeshStandardMaterial({ color: 0xb3aca0, roughness: 1 });
// One extra material, so the door reads as an opening rather than as paint.
// The stair and the jamb reuse PLINTH_MAT — same batch, no extra draw call.
const GARAGE_DOOR_MAT = new THREE.MeshStandardMaterial({ color: 0x5c6165, roughness: 0.85 });
const PLINTH_GARAGE_MIN = 1.7; // below this the door is shorter than a car
// The mid-rise KayKit blocks (aspect ~0.8-1.2); c/d/g/h are 3-story towers
// that would loom over a suburban row.
const KK_BUILDINGS_MID = KK_BUILDINGS.filter((k) => /[abef]$/.test(k));
// The only three flat-topped suburban models. Butting 18 gables shoulder to
// shoulder reads as a sawtooth, so attached rows are biased onto these plus
// the flat commercial blocks — the continuous cornice line IS the SF row read.
const SUBURBAN_FLAT_TOP = BUILDINGS_SUBURBAN.filter((k) => /[brs]$/.test(k));

// --- Lot rhythm ---------------------------------------------------------
// SF_LOT_RHYTHM (sf-adjacency.ts) is measured in REAL world units: the
// citywide median lot is 3.15u = 14 m of frontage, a Castro lot 2.37u = 10.5 m.
// This map's fabric is an arcade exaggeration of that — a shipped "row house"
// is ~6.5u/29 m wide and ~5.5u/24 m tall, about four times a real one — and
// walking true lot widths would take the frontage models from ~37k to ~108k
// (measured over the 281,000u of walkable frontage), at 700-5,200 tris each.
// So the measured band drives the RHYTHM, not the absolute size: every width is
// a measured draw times LOT_EXAGGERATION. The ratios that read survive (a SoMa
// or Embarcadero lot is 2.6x a Castro lot) at the scale the world is modelled
// in, and the two halves of the city stay consistent because the band comes
// from lotRhythmFor() for EVERY district — measured for 27, donor-borrowed for
// the 25 the source model never covered, one code path, no seam.
const LOT_EXAGGERATION = 2.1;
const LOT_MIN = 3.4; // narrower than this and the kit model reads as a shed
const LOT_MAX = 12.5; // wider and one model is a stretched billboard: split it
// Facade to kerb: the sidewalk plus a stoop. Was a flat 2.4u regardless of
// street class, which left ~1.1u of bare ground past a minor street's 1.3u walk
// and pushed facade-to-facade to 11.2u (~50 m) against SF's ~25 m.
const FACADE_MARGIN = 0.45;
/**
 * Distance from a street's CENTRELINE to the front wall of its frontage row.
 * furniture.ts hangs awnings, murals, fire escapes and shutters on that plane
 * without being able to see the buildings, so this is the one definition of it —
 * import it there rather than restating the arithmetic (its `FRONT_PLANE = 2.4`
 * predates per-class sidewalks and now floats those props off every minor
 * street's wall).
 */
export function facadeOffset(half: number): number {
  return half + walkFor(half) + FACADE_MARGIN;
}
// Row houses are narrow AND DEEP; shops are boxy. Depth is scaled on Z only,
// so it never touches the frontage — the old uniform scale made a narrow lot
// a shallow one too.
const LOT_DEPTH_DEEP = 1.85;
const LOT_DEPTH_SHALLOW = 1.15;
// Rear slack worth another row rather than a yard.
const BACK_ROW_MIN = 6;
// Height is a storey count, not a multiple of the frontage. Tuned so the median
// of each character lands on the height the old footprint-normalized scale
// produced (residential ~5.5u, downtown ~12u) — narrowing the lots must not
// squash the skyline with them.
const FABRIC_STOREY = 1.85;
// Hillsides: how far up its own fall a building is seated, and the most of it
// the grade is allowed to bury. SF cuts in and stilts out; it does not stop
// building at a 5u fall, which is what the old `drop > 5` tree fallback did to
// 55-75% of the near-summit lots.
const STEP_INTO_SLOPE = 0.62;
const STEP_BURY_MAX = 1.6;
// Fall one mass can absorb: ~2.6u of plinth (one garage storey) plus ~1.6u of
// cut. More than that and the building is SPLIT into stepped sections.
const FALL_PER_STEP = 4.2;
/**
 * Per SECTION, after stepping: a genuine cliff face, left green. Exported
 * because furniture.ts's `steepLot` has to skip lot dressing on exactly the
 * lots this pass refuses to build — it was still using the OLD pre-stepping
 * delete threshold (5u), so every hillside lot the stepper now builds stood
 * with no fence, path or yard.
 */
export const STEEP_CLIFF = 6.5;
// The real-footprint pass sinks a prism's walls to its lowest ring vertex
// instead of stepping it, so it tolerates more fall than a kit section can.
const PRISM_CLIFF = 9;
// Above this a building stops being one flat prism, measured on the source
// model: the flat-prism share is 54.9% through the 9-20u band, 21.7% at 20-40u
// and 0% above 40u, with the median plan tapering 1.00 -> 0.72 -> 0.57 up the
// height. Anything over this gets a podium + inset shaft + crown instead.
const TOWER_MIN_H = 14;
const TOWER_PODIUM = 0.22; // podium share of the height
const TOWER_INSET = 0.78; // shaft plan against the lot line
// tintNode lerps the model's own (white) base colour toward the palette and the
// batcher MULTIPLIES the result over the atlas, so the amount is really
// "distance from white" — at the shipped amounts a pale palette moved the
// atlas by nothing (measured mean saturation 0.076, nothing above 0.35). The
// atlases were recoloured to near-neutral in wave 0 precisely so the tint could
// bite; this is the gain that lets it, clamped so 1.0 = the palette colour
// itself. Note three.js lerps in LINEAR space, which washes a pastel further
// than sRGB arithmetic suggests.
const TINT_GAIN = 1.7;
// One dominant facade colour and one roof family per BLOCK, not per building:
// rng.pick is uniform, which gave every district the same average colour and no
// block any identity. ~2 tiles is an SF block face.
const BLOCK_SPAN = 26;
function blockHash(x: number, z: number): number {
  const bx = Math.floor((x + WORLD_HALF_X) / BLOCK_SPAN);
  const bz = Math.floor((z + WORLD_HALF_Z) / BLOCK_SPAN);
  let h = Math.imul(bx, 374761393) + Math.imul(bz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function dirToYaw(d: Dir): number {
  // Yaw that points "toward" the given grid direction (about +Y).
  switch (d) {
    case N:
      return Math.PI;
    case S:
      return 0;
    case E:
      return -HALF_PI;
    case W:
      return HALF_PI;
    default:
      return 0;
  }
}

// Grid cell of a world position. The City methods delegate here so the fabric
// planner (module scope, no instance) and the class cannot drift.
const gridXOf = (x: number): number => Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
const gridZOf = (z: number): number => Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);

// --- Occupancy: rotated RECTANGLES, and a row can never reject itself.
// Buildings are boxes, and the circle this used to keep made a 6u-wide lot claim
// a 3u radius in every direction — two lots meant to share a party wall passed
// the test by a hair and failed the instant either one shrank, and on the real-
// footprint pass one circle per placed segment deleted ~10k parcels whose only
// sin was standing next to their neighbour, which is what a party wall IS.
// A `row` token exempts intentional neighbours: every lot of one frontage walk
// (and every segment of one parcel) shares a token, and its own walk already
// guarantees they do not overlap.
type OccBox = {
  readonly x: number;
  readonly z: number;
  readonly hw: number;
  readonly hd: number;
  readonly cos: number;
  readonly sin: number;
  readonly row: number;
};
const OCC = 26;
const OCC_COLS = Math.ceil(WORLD_W / OCC) + 4;
const OCC_SLOP = 0.4; // touching walls must pass; only a real overlap counts
const occBox = (
  x: number,
  z: number,
  hw: number,
  hd: number,
  yaw: number,
  row: number,
): OccBox => ({ x, z, hw, hd, cos: Math.cos(yaw), sin: Math.sin(yaw), row });
// A box lands in every bucket its AABB touches — inserting only at the centre
// loses a 30u parcel on a 26u lattice.
function occSpan(b: OccBox, visit: (key: number) => void): void {
  const rx = Math.abs(b.cos * b.hw) + Math.abs(b.sin * b.hd);
  const rz = Math.abs(b.sin * b.hw) + Math.abs(b.cos * b.hd);
  const x0 = Math.floor((b.x - rx + WORLD_HALF_X) / OCC);
  const x1 = Math.floor((b.x + rx + WORLD_HALF_X) / OCC);
  const z0 = Math.floor((b.z - rz + WORLD_HALF_Z) / OCC);
  const z1 = Math.floor((b.z + rz + WORLD_HALF_Z) / OCC);
  for (let ix = x0; ix <= x1; ix++) {
    for (let iz = z0; iz <= z1; iz++) visit(ix + OCC_COLS * iz);
  }
}
/** Separating-axis overlap of two rectangles, each shrunk by OCC_SLOP. */
function boxesOverlap(a: OccBox, b: OccBox): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const ahw = Math.max(a.hw - OCC_SLOP, 0.05);
  const ahd = Math.max(a.hd - OCC_SLOP, 0.05);
  const bhw = Math.max(b.hw - OCC_SLOP, 0.05);
  const bhd = Math.max(b.hd - OCC_SLOP, 0.05);
  const ca = Math.abs(a.cos * b.cos + a.sin * b.sin);
  const sa = Math.abs(a.cos * b.sin - a.sin * b.cos);
  if (Math.abs(dx * a.cos + dz * a.sin) > ahw + bhw * ca + bhd * sa) return false;
  if (Math.abs(-dx * a.sin + dz * a.cos) > ahd + bhw * sa + bhd * ca) return false;
  if (Math.abs(dx * b.cos + dz * b.sin) > bhw + ahw * ca + ahd * sa) return false;
  if (Math.abs(-dx * b.sin + dz * b.cos) > bhd + ahw * sa + ahd * ca) return false;
  return true;
}

// Park lots go green, so no fabric pass can ever be handed one: narrowing the
// type is what deletes the dead "park" arms of poolFor/storeysFor instead of
// leaving unreachable branches behind.
type FabricChar = Exclude<DistrictChar, "park">;

function fabricCharAt(x: number, z: number): FabricChar | null {
  const gx = gridXOf(x);
  const gz = gridZOf(z);
  if (!isLandCell(gx, gz)) return null;
  const c = districtAt(gx, gz).character;
  return c === "park" ? null : c;
}

/**
 * One lot on a street frontage — the unit one kit model is fitted to. Both
 * front-face corners ride along so a consumer (and tools/test-world.mts)
 * measures the walls the walk actually produced rather than reconstructing
 * them from trigonometry.
 */
export type FabricLot = {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  /** Frontage along the street: scales the model's X only. */
  readonly width: number;
  /** Depth away from the street: scales the model's Z only. */
  readonly depth: number;
  readonly character: FabricChar;
  /**
   * Buildable depth still free BEHIND this lot, on this lot's half of the
   * block. A wide block is two rows deep with rear yards; a narrow one is one
   * row that already reaches the middle. Without this the interior of every
   * wide block came out as bare ground.
   */
  readonly rear: number;
  /** Wall-to-wall with the previous lot in this row — a party wall, no gap. */
  readonly attached: boolean;
  /** Lots of one run share a facade line and a dominant colour. */
  readonly run: number;
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
};

// A measured quartile band, sampled with its tails and lifted to the map's
// arcade scale. A lot wider than one model can carry is SPLIT (a 6.2u SoMa lot
// becomes two fused models, never one stretched 3:1).
function lotWidth(rng: Rng, band: LotRhythm): number {
  const r = rng.range(0, 1);
  const raw =
    (r < 0.2
      ? rng.range(band.p25 * 0.72, band.p25)
      : r < 0.5
        ? rng.range(band.p25, band.p50)
        : r < 0.8
          ? rng.range(band.p50, band.p75)
          : rng.range(band.p75, band.p75 * 1.35)) * LOT_EXAGGERATION;
  const parts = Math.max(1, Math.ceil(raw / LOT_MAX));
  return Math.max(LOT_MIN, raw / parts);
}

// A slice of a lot, k of n, along its frontage (`axis` 0) or its depth
// (`axis` 1). Slices keep the parent's facing and setback, so a stepped
// building still butts its neighbours and still faces the same kerb.
function sliceLot(lot: FabricLot, axis: 0 | 1, k: number, n: number): FabricLot {
  const t0 = k / n;
  const t1 = (k + 1) / n;
  if (axis === 0) {
    const x0 = lot.x0 + (lot.x1 - lot.x0) * t0;
    const z0 = lot.z0 + (lot.z1 - lot.z0) * t0;
    const x1 = lot.x0 + (lot.x1 - lot.x0) * t1;
    const z1 = lot.z0 + (lot.z1 - lot.z0) * t1;
    const shift = (t0 + t1) / 2 - 0.5;
    return {
      ...lot,
      width: lot.width / n,
      x: lot.x + (lot.x1 - lot.x0) * shift,
      z: lot.z + (lot.z1 - lot.z0) * shift,
      attached: true,
      x0,
      z0,
      x1,
      z1,
    };
  }
  // Depth: k = 0 is the street-most slice. The normal points at the kerb.
  const nx = (lot.x0 + lot.x1) / 2 - lot.x;
  const nz = (lot.z0 + lot.z1) / 2 - lot.z;
  const nl = Math.max(Math.hypot(nx, nz), 0.001);
  const depth = lot.depth / n;
  const back = (0.5 - (t0 + t1) / 2) * lot.depth;
  const x = lot.x + (nx / nl) * back;
  const z = lot.z + (nz / nl) * back;
  return {
    ...lot,
    depth,
    x,
    z,
    attached: true,
    x0: lot.x0 - (nx / nl) * (t0 * lot.depth),
    z0: lot.z0 - (nz / nl) * (t0 * lot.depth),
    x1: lot.x1 - (nx / nl) * (t0 * lot.depth),
    z1: lot.z1 - (nz / nl) * (t0 * lot.depth),
  };
}

/**
 * Walk one side of one street edge as a LOT LINE: roll a width, place the lot
 * centred at s + w/2, advance s by exactly w. The previous walk re-rolled the
 * width every iteration but advanced by the PREVIOUS roll, so consecutive lots
 * gapped (or overlapped) by half the difference of two draws — up to 1.3u of
 * daylight between walls that were meant to be attached, which is what made the
 * dense districts read as gapped suburbia.
 *
 * Every narrowing happens HERE, so the width the walk advances by is the width
 * that gets built. placeBuilding is handed a finished lot and may only accept or
 * reject it; it can no longer shrink a building after the line has moved on.
 * Lots of one run share ONE facade line, which is also what makes their walls
 * meet exactly on a curve: neighbours read the same offset polyline, so the far
 * corner of one lot IS the near corner of the next.
 */
export function planFabricRow(
  network: RoadNetwork,
  junctions: JunctionMap,
  edge: NetEdge,
  side: 1 | -1,
  rng: Rng,
): readonly FabricLot[] {
  const lots: FabricLot[] = [];
  // Corner buildings are real — the cross-street clearance below is the guard,
  // so row trims stay small even at wide junctions.
  const trimA = Math.min(network.nodeTrim(edge.a) * 0.6 + 1.5, edge.len * 0.4);
  const trimB = Math.min(network.nodeTrim(edge.b) * 0.6 + 1.5, edge.len * 0.4);
  const end = edge.len - trimB;
  if (end - trimA < 5) return lots;
  const frontOff = facadeOffset(edge.half);
  const face = (s: number, off: number): { readonly x: number; readonly z: number } => {
    const smp = network.sample(edge, s);
    return { x: smp.x - smp.tz * off * side, z: smp.z + smp.tx * off * side };
  };
  // Clear of every OTHER street; our own edge is cleared by frontOff itself.
  // The JUNCTION PATCH has to be tested separately: it is the drawn asphalt at
  // an intersection and it is wider than any of its arms, so a nearest-edge
  // distance cannot see it and corner lots stood on the apron.
  const clear = (p: { readonly x: number; readonly z: number }): boolean => {
    if (junctions.near(p.x, p.z, 0.3)) return false;
    const hit = network.nearest(p.x, p.z, ROAD_TILE * 1.6);
    return hit === null || hit.dist >= hit.edge.half + 0.4;
  };
  let s = trimA + rng.range(0, 2);
  let run = 0;
  let attached = false;
  while (s < end) {
    run++;
    const head = network.sample(edge, s);
    const district = districtAt(gridXOf(head.x), gridZOf(head.z));
    const band = lotRhythmFor(district.name);
    const packed = PACKED_COMMERCIAL.has(district.name);
    const dense =
      district.character === "residential" || district.character === "victorian" || packed;
    // One depth (hence one facade line) per run, drawn from the run's own band.
    const depthRun = lotWidth(rng, band) * (dense ? LOT_DEPTH_DEEP : LOT_DEPTH_SHALLOW);
    const runLen = Math.max(1, Math.round(band.runSize * rng.range(0.7, 1.5)));
    for (let k = 0; k < runLen && s < end; k++) {
      const p0 = face(s, frontOff);
      if (!clear(p0)) {
        // Still inside a junction apron — step past it, don't build a sliver.
        s += LOT_MIN;
        attached = false;
        continue;
      }
      let w = Math.min(lotWidth(rng, band), end - s);
      // Narrow until the FAR wall clears the cross street it is walking into.
      for (let i = 0; i < 3 && w >= LOT_MIN; i++) {
        if (clear(face(s + w, frontOff))) break;
        w *= 0.62;
      }
      if (w < LOT_MIN) {
        s += LOT_MIN;
        attached = false;
        continue;
      }
      // How deep the block is: facade line to the facade line of the row facing
      // the other way. Both rows fill toward each other and their rear property
      // lines meet in the MIDDLE, so HALF of that is this row's to build on.
      // Testing only "is the back wall on a street" is not enough — a deep row
      // then crosses a narrow block and the row on the far kerb is rejected
      // wholesale by its occupancy, leaving one side built and the other bare.
      const probe = face(s + w * 0.5, frontOff + depthRun);
      const far = network.nearest(probe.x, probe.z, ROAD_TILE * 2.4);
      const halfBlock =
        far === null || far.edge.id === edge.id
          ? ROAD_TILE * 1.2
          : (depthRun + far.dist - facadeOffset(far.edge.half)) / 2;
      let depth = Math.max(w * 0.9, Math.min(depthRun, halfBlock));
      // Backstop for cross streets the midpoint rule cannot see.
      for (let i = 0; i < 2 && depth > w * 0.9; i++) {
        if (clear(face(s, frontOff + depth)) && clear(face(s + w, frontOff + depth))) break;
        depth *= 0.72;
      }
      // At a convex kink the facade line is longer than the centreline it is
      // offset from, so an arclength step of w can span a chord well past it
      // (measured: up to 19u for a 12.5u step). Pull the step back rather than
      // stretch one model across the corner.
      let p1 = face(s + w, frontOff);
      for (let i = 0; i < 3; i++) {
        const chord = Math.hypot(p1.x - p0.x, p1.z - p0.z);
        if (chord <= LOT_MAX || w <= LOT_MIN) break;
        w = Math.max(LOT_MIN, w * (LOT_MAX / chord));
        p1 = face(s + w, frontOff);
      }
      const b0 = face(s, frontOff + depth);
      const b1 = face(s + w, frontOff + depth);
      const x = (p0.x + p1.x + b0.x + b1.x) / 4;
      const z = (p0.z + p1.z + b0.z + b1.z) / 4;
      const character = fabricCharAt(x, z);
      s += w;
      if (character === null) {
        attached = false;
        continue;
      }
      // The chord between the shared corners, not the arclength: on a curve the
      // chord is what the two walls actually have in common.
      const ex = p1.x - p0.x;
      const ez = p1.z - p0.z;
      const width = Math.hypot(ex, ez);
      if (width < LOT_MIN) {
        attached = false;
        continue;
      }
      lots.push({
        x,
        z,
        yaw: Math.atan2((ex / width) * side, (ez / width) * side) + HALF_PI_CITY,
        width,
        depth,
        rear: Math.max(0, halfBlock - depth),
        character,
        attached,
        run,
        x0: p0.x,
        z0: p0.z,
        x1: p1.x,
        z1: p1.z,
      });
      attached = true;
    }
    // The break between runs — an alley or a driveway on a dense row, a side
    // yard on a detached one. This IS the vacancy: the old walk holed every
    // ~25th slot at random, which on a dense row is a missing tooth.
    s += dense ? rng.range(0.9, 2.2) : rng.range(2.4, 5.0);
    attached = false;
  }
  return lots;
}

// A streamed tile of static city geometry: its own merged meshes under one
// group, tagged with a centre + cull radius so it can be hidden when far away.
type MatRec = {
  color: number;
  roughness: number;
  metalness: number;
  vertexColors: boolean;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
  transparent: boolean;
  opacity: number;
};
export type MergedChunkRec = {
  cx: number;
  cz: number;
  dist: number;
  position: Float32Array;
  normal: Float32Array | null;
  uv: Float32Array | null;
  color: Float32Array | null;
  index: Uint16Array | Uint32Array | null;
  mat: MatRec;
  srcMat: { url: string; idx: number } | null;
};
export type BatchItemRec = {
  url: string | null; // GLB source ref…
  idx: number;
  raw: number | null; // …or an index into rawGeos
  m: Float32Array; // 16 elements
  tint: number | null;
  big: boolean;
};
export type RawGeoRec = {
  position: Float32Array;
  normal: Float32Array | null;
  uv: Float32Array | null;
  index: Uint16Array | Uint32Array | null;
  mat: MatRec;
};
export type CityRestPayload = {
  mergedChunks: MergedChunkRec[];
  rawGeos: RawGeoRec[];
  batchItems: BatchItemRec[];
  solids: Solid[];
  parkedCars: ParkedSpec[];
  lampHeads: LampHead[];
  decks: readonly SurfaceDeck[];
};

type ChunkMeshGroup = {
  readonly group: THREE.Group;
  readonly cx: number;
  readonly cz: number;
  readonly dist: number;
};

function materialFactory(): (m: MatRec) => THREE.MeshStandardMaterial {
  // Material descriptors are the cache key. Omitting any field makes old rest
  // payloads alias materials that render differently.
  const mats = new Map<string, THREE.MeshStandardMaterial>();
  return (m: MatRec): THREE.MeshStandardMaterial => {
    const k = JSON.stringify(m);
    let mat = mats.get(k);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color: m.color,
        roughness: m.roughness,
        metalness: m.metalness,
        vertexColors: m.vertexColors,
        polygonOffset: m.polygonOffset,
        polygonOffsetFactor: m.polygonOffsetFactor,
        polygonOffsetUnits: m.polygonOffsetUnits,
        transparent: m.transparent,
        opacity: m.opacity,
      });
      mats.set(k, mat);
    }
    return mat;
  };
}

function geometryFromMergedChunk(rec: MergedChunkRec): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(rec.position, 3));
  if (rec.uv) geo.setAttribute("uv", new THREE.BufferAttribute(rec.uv, 2));
  if (rec.color) geo.setAttribute("color", new THREE.BufferAttribute(rec.color, 3));
  if (rec.index) geo.setIndex(new THREE.BufferAttribute(rec.index, 1));
  if (rec.normal) geo.setAttribute("normal", new THREE.BufferAttribute(rec.normal, 3));
  else geo.computeVertexNormals();
  return geo;
}

async function buildMergedChunkGroups(options: {
  readonly records: readonly MergedChunkRec[];
  readonly cache: ModelCache;
  readonly materialFor: (m: MatRec) => THREE.MeshStandardMaterial;
  readonly runtimeMaterials?: ReadonlyMap<MergedChunkRec, THREE.Material>;
  readonly breathe?: () => Promise<void>;
  readonly onRecord?: (done: number, total: number) => void;
}): Promise<ChunkMeshGroup[]> {
  const groups = new Map<string, ChunkMeshGroup>();
  // Legacy baked/cached rest payloads carry SIX flat road materials per
  // chunk (captured before the vertex-color collapse in roads.ts). Rewrite
  // those recs onto the two collapsed materials and merge per (chunk, tier,
  // material) so old artifacts render with the same draw count as a fresh
  // build. New captures arrive already collapsed and pass straight through.
  type RoadMerge = {
    readonly gk: string;
    readonly mat: THREE.Material;
    readonly geos: THREE.BufferGeometry[];
  };
  const roadMerges = new Map<string, RoadMerge>();
  let n = 0;
  for (const rec of options.records) {
    // breathe() self-throttles to ~12ms slices — check every chunk, because
    // one computeVertexNormals over a big legacy chunk can eat a frame.
    const breathe = options.breathe;
    if (breathe) await breathe();
    n++;
    options.onRecord?.(n, options.records.length);
    const geo = geometryFromMergedChunk(rec);
    const gk = `${rec.cx},${rec.cz},${rec.dist}`;
    let g = groups.get(gk);
    if (!g) {
      g = { group: new THREE.Group(), cx: rec.cx, cz: rec.cz, dist: rec.dist };
      groups.set(gk, g);
    }
    const runtimeMat = options.runtimeMaterials?.get(rec);
    if (runtimeMat) {
      const mesh = new THREE.Mesh(geo, runtimeMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.group.add(mesh);
      continue;
    }
    const road = rec.srcMat
      ? null
      : roadCollapseTarget(rec.mat.color, rec.mat.polygonOffset, rec.mat.vertexColors);
    if (road) {
      // Already-collapsed captures ship their own vertex colors — baking
      // the uniform white over them would erase the paint.
      if (!rec.color) bakeConstantColor(geo, road.color);
      const mk = `${gk}|${road.mat.uuid}|${rec.uv ? "u" : "x"}|${geo.index ? "i" : "n"}`;
      const rm = roadMerges.get(mk);
      if (rm) rm.geos.push(geo);
      else roadMerges.set(mk, { gk, mat: road.mat, geos: [geo] });
      continue;
    }
    const srcM = rec.srcMat ? options.cache.srcMesh(rec.srcMat.url, rec.srcMat.idx) : null;
    const srcMatOk = srcM && !Array.isArray(srcM.material) ? srcM.material : null;
    const mesh = new THREE.Mesh(geo, srcMatOk ?? options.materialFor(rec.mat));
    mesh.receiveShadow = true;
    g.group.add(mesh);
  }
  for (const rm of roadMerges.values()) {
    const g = groups.get(rm.gk);
    if (!g) continue;
    const first = rm.geos[0];
    const merged = rm.geos.length === 1 && first ? first : mergeGeometries(rm.geos, false);
    // Merge failure (mismatched attrs): draw the pieces individually —
    // exactly what the un-collapsed path did.
    const geos = merged ? [merged] : rm.geos;
    for (const geo of geos) {
      const mesh = new THREE.Mesh(geo, rm.mat);
      mesh.receiveShadow = true;
      g.group.add(mesh);
    }
  }
  return [...groups.values()];
}

type BatchBucket = {
  material: THREE.Material;
  geoVerts: Map<THREE.BufferGeometry, number>;
  items: {
    geo: THREE.BufferGeometry;
    matrix: THREE.Matrix4;
    tint?: THREE.Color;
    src?: { url: string; idx: number };
  }[];
  verts: number;
  indices: number;
};

type Chunk = { cx: number; cz: number; radius: number; dist: number; group: THREE.Object3D };

// Batched-instance streaming scratch (per-frame, allocation-free).
const NEAR_ALWAYS = 170; // chunks this close are always on (off-screen shadow casters)
const DETAIL_DISTANCE = 360; // trees/cars/props cull here; buildings at DRAW_DISTANCE
const BIG_SILHOUETTE_H = 13; // world-space HEIGHT that counts as skyline
// Two imposter tiers. The skyline alone left the middle distance EMPTY: the
// row-house fabric is 60% of the city's buildings and none of it is 13u tall,
// so past the detail ring downtown floated over bare ground. Ordinary
// buildings get an imposter too, but only one chunk ring further out than the
// detail tier — past MID_IMPOSTER_DISTANCE the night fog has swallowed them
// and 20k extra boxes would be paying for nothing.
const MID_SILHOUETTE_H = 5; // ordinary buildings that still read at distance
const MID_IMPOSTER_DISTANCE = 620;
const SCRATCH_SCALE = new THREE.Vector3();
const STREAM_MAT = new THREE.Matrix4();
const STREAM_FRUSTUM = new THREE.Frustum();
const STREAM_SPHERE = new THREE.Sphere();

// Only BUILDINGS get the mid tier — a box imposter for a tree is a cube in a
// field, and trees/props are exactly the 5-9u band the gate would otherwise
// sweep up. Matched on the asset CATEGORY, not a list of pools, so a pool
// added to the manifest can't silently lose its imposters.
const BUILDINGS_PREFIX = modelUrl("buildings", "").slice(0, -".glb".length);

// --- Imposter albedo -------------------------------------------------------
// A box has no atlas, so it needs the AVERAGE of what the model showed. The
// per-instance tint can't be that average on its own: kit tints are near-white
// MULTIPLIERS over the atlas (measured mean saturation 0.20, luminance 0.85),
// so feeding one to a white box painted downtown-from-the-Sunset as a field of
// white cubes. Sample the model's own atlas instead, area-weighted — a facade
// quad and a doorframe quad have the same vertex count and wildly different
// screen area — then multiply the tint back in as the district shading it is.
const IMPOSTER_FALLBACK = new THREE.Color(0x97a1ae); // no atlas, no material colour: SF blue-grey
const ATLAS_SAMPLE = 128; // readback resolution; kit colormaps are small palettes
const IMPOSTER_COLOR = new THREE.Color();
const ATLAS_TEXEL = new THREE.Color();
const ALBEDO_A = new THREE.Vector3();
const ALBEDO_B = new THREE.Vector3();
const ALBEDO_C = new THREE.Vector3();

type AtlasPixels = { data: Uint8ClampedArray; w: number; h: number };
const atlasPixelCache = new Map<string, AtlasPixels | null>();
const meanAlbedoCache = new Map<string, THREE.Color | null>();

function drawableImage(img: unknown): ImageBitmap | HTMLImageElement | HTMLCanvasElement | null {
  if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) return img;
  if (typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement) return img;
  if (typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement) return img;
  return null;
}

// Atlas texels, once per texture (the loader already dedupes kit colormaps
// down to one canonical texture, so this is a handful of readbacks).
function atlasPixels(tex: THREE.Texture): AtlasPixels | null {
  const cached = atlasPixelCache.get(tex.uuid);
  if (cached !== undefined) return cached;
  let out: AtlasPixels | null = null;
  const img = drawableImage(tex.image);
  if (img) {
    try {
      const w = Math.max(1, Math.min(ATLAS_SAMPLE, img.width));
      const h = Math.max(1, Math.min(ATLAS_SAMPLE, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.imageSmoothingEnabled = false; // palettes must not blur across swatches
        ctx.drawImage(img, 0, 0, w, h);
        out = { data: ctx.getImageData(0, 0, w, h).data, w, h };
      }
    } catch {
      // tainted or undrawable image — the caller falls back
    }
  }
  atlasPixelCache.set(tex.uuid, out);
  return out;
}

// Area-weighted mean of a geometry's atlas texels, in the working (linear)
// colour space so it averages the way the renderer does. Cached per geometry:
// one pass over a few hundred kit models, not per instance.
function meanAlbedo(geo: THREE.BufferGeometry, tex: THREE.Texture): THREE.Color | null {
  const cacheKey = `${geo.uuid}|${tex.uuid}`;
  const cached = meanAlbedoCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let out: THREE.Color | null = null;
  const px = atlasPixels(tex);
  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");
  if (px && pos && uv) {
    const idx = geo.index;
    const count = idx ? idx.count : pos.count;
    let wSum = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let t = 0; t + 2 < count; t += 3) {
      const i0 = idx ? idx.getX(t) : t;
      const i1 = idx ? idx.getX(t + 1) : t + 1;
      const i2 = idx ? idx.getX(t + 2) : t + 2;
      ALBEDO_A.fromBufferAttribute(pos, i0);
      ALBEDO_B.fromBufferAttribute(pos, i1).sub(ALBEDO_A);
      ALBEDO_C.fromBufferAttribute(pos, i2).sub(ALBEDO_A);
      const area = ALBEDO_B.cross(ALBEDO_C).length() * 0.5;
      if (area <= 0) continue;
      // Centroid UV through the texture transform (kit GLBs carry
      // KHR_texture_transform), wrapped into the atlas.
      const su = ((uv.getX(i0) + uv.getX(i1) + uv.getX(i2)) / 3) * tex.repeat.x + tex.offset.x;
      const sv = ((uv.getY(i0) + uv.getY(i1) + uv.getY(i2)) / 3) * tex.repeat.y + tex.offset.y;
      const fu = su - Math.floor(su);
      const fv0 = sv - Math.floor(sv);
      const fv = tex.flipY ? 1 - fv0 : fv0;
      const col = Math.min(px.w - 1, Math.floor(fu * px.w));
      const row = Math.min(px.h - 1, Math.floor(fv * px.h));
      const o = (row * px.w + col) * 4;
      ATLAS_TEXEL.setRGB(
        (px.data[o] ?? 0) / 255,
        (px.data[o + 1] ?? 0) / 255,
        (px.data[o + 2] ?? 0) / 255,
        tex.colorSpace,
      );
      wSum += area;
      r += ATLAS_TEXEL.r * area;
      g += ATLAS_TEXEL.g * area;
      b += ATLAS_TEXEL.b * area;
    }
    if (wSum > 0) out = new THREE.Color().setRGB(r / wSum, g / wSum, b / wSum);
  }
  meanAlbedoCache.set(cacheKey, out);
  return out;
}

// What the model averages to on screen: atlas mean (or the flat material
// colour) × the material colour × the per-instance district tint.
function imposterColorInto(
  out: THREE.Color,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  tint: THREE.Color | undefined,
): THREE.Color {
  if (mat instanceof THREE.MeshStandardMaterial) {
    const albedo = mat.map ? meanAlbedo(geo, mat.map) : null;
    // Unmapped geometry (plinths, prisms) IS its material colour; a mapped
    // material whose atlas can't be read falls through to the blue-grey.
    if (albedo) out.copy(albedo).multiply(mat.color);
    else if (mat.map) out.copy(IMPOSTER_FALLBACK);
    else out.copy(mat.color);
  } else {
    out.copy(IMPOSTER_FALLBACK);
  }
  if (tint) out.multiply(tint);
  return out;
}

// A robotaxi garage: the depot building plus the drive-in pad in front where
// the skin-swap UI opens. Spots are derived deterministically from the plan,
// so BOTH the generated and the baked-artifact boot paths agree on them.
export type Garage = { x: number; z: number; yaw: number; padX: number; padZ: number };

const GARAGE_COUNT = 7;
const GARAGE_MIN_DIST = 350;

function pickGarageSpots(plan: CityPlan, terrain: Terrain, network: RoadNetwork): Garage[] {
  const cells = plan.cells;
  const dirs: readonly (readonly [number, number])[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const cellAt = (gx: number, gz: number): string | undefined => cells[gx]?.[gz];
  type Cand = { gx: number; gz: number; dx: number; dz: number };
  const cands: Cand[] = [];
  for (let gx = 4; gx < GRID_X - 4; gx += 2) {
    for (let gz = 4; gz < GRID_Z - 4; gz += 2) {
      if (cellAt(gx, gz) !== "lot") continue;
      for (const [dx, dz] of dirs) {
        if (cellAt(gx + dx, gz + dz) !== "road") continue;
        // depth: the cell behind must be lot too (the depot is deep)
        if (cellAt(gx - dx, gz - dz) !== "lot") continue;
        const wx = (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
        const wz = (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
        const r = ROAD_TILE;
        const hs = [
          terrain.heightAt(wx - r, wz - r),
          terrain.heightAt(wx + r, wz - r),
          terrain.heightAt(wx - r, wz + r),
          terrain.heightAt(wx + r, wz + r),
        ];
        if (Math.max(...hs) - Math.min(...hs) > 1.4) continue; // flat pads only
        cands.push({ gx, gz, dx, dz });
        break;
      }
    }
  }
  // Seeded shuffle, then greedy max-spread accept.
  const rng = new Rng(424242);
  for (let i = cands.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const a = cands[i];
    const b = cands[j];
    if (a && b) {
      cands[i] = b;
      cands[j] = a;
    }
  }
  const picked: Garage[] = [];
  for (const c of cands) {
    if (picked.length >= GARAGE_COUNT) break;
    const wx = (c.gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
    const wz = (c.gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
    if (picked.some((g) => Math.hypot(g.x - wx, g.z - wz) < GARAGE_MIN_DIST)) continue;
    // Depot footprint must not clip a vector lane: the grid says "lot" but
    // straightened OSM centrelines cut lot cells, and a depot corner in the
    // roadway is an (invisible from the lane) wall.
    const dh = ROAD_TILE * 0.42 + 0.3;
    let clipsLane = false;
    for (const [ox, oz] of [
      [-dh, -dh],
      [dh, -dh],
      [-dh, dh],
      [dh, dh],
    ] as const) {
      const hit = network.nearest(wx + ox, wz + oz, ROAD_TILE * 1.4);
      if (hit && hit.dist < hit.edge.half + 0.2) {
        clipsLane = true;
        break;
      }
    }
    if (clipsLane) continue;
    picked.push({
      x: wx,
      z: wz,
      yaw: Math.atan2(c.dx, c.dz), // model faces +Z — turn it toward the road
      padX: wx + c.dx * ROAD_TILE * 1.15,
      padZ: wz + c.dz * ROAD_TILE * 1.15,
    });
  }
  return picked;
}

export class CityModel {
  readonly group = new THREE.Group();
  readonly solids: Solid[] = [];
  readonly roadCells: RoadCell[] = [];
  plan: CityPlan; // mutable: live street rebuild replaces it
  readonly terrain: Terrain;
  network: RoadNetwork; // vector road graph (rendering/traffic/alignment); live rebuild replaces it
  parkedCarSpecs: readonly ParkedSpec[] = []; // punt-able parked cars (built by furniture)
  readonly garages: readonly Garage[]; // robotaxi skin-swap depots (+ drive-in pads)
  lampHeads: readonly LampHead[] = []; // streetlight glow anchors (night pass)
  private chunks: Chunk[] = [];
  // Road drape target (terrain + step-ladder street terrace), cached per
  // network so live street edits rebuild it exactly once.
  // makeGroundOffset rasterizes a clearance field AND a full street terrace —
  // furniture and buildGround must share one, not build two.
  private groundOffsetCache: ((x: number, z: number) => number) | null = null;
  private groundOffsetNet: RoadNetwork | null = null;
  private groundOffset(): (x: number, z: number) => number {
    if (!this.groundOffsetCache || this.groundOffsetNet !== this.network) {
      this.groundOffsetCache = makeGroundOffset(this.network, this.terrain);
      this.groundOffsetNet = this.network;
    }
    return this.groundOffsetCache;
  }
  // Resolved ground class (world/land-class.ts): the ONE rule the ground paint
  // and the wheel-surface FX both read, so the tyres can never report concrete
  // on a beach the painter drew as sand. Cached per PLAN — a live street edit
  // replaces the plan and the resolver reads its street/frontage fabric.
  private landClassCache: LandClassAt | null = null;
  private landClassPlan: CityPlan | null = null;
  private get landClassAt(): LandClassAt {
    if (!this.landClassCache || this.landClassPlan !== this.plan) {
      this.landClassCache = makeLandClassAt(this.plan, this.terrain);
      this.landClassPlan = this.plan;
    }
    return this.landClassCache;
  }
  // Height of the surface a prop stands on (road drape inside the paved
  // corridor, ground mesh as tessellated outside it) — see makeStandingSurface.
  private standCache: ((x: number, z: number) => number) | null = null;
  private standNet: RoadNetwork | null = null;
  private standAt(x: number, z: number): number {
    if (!this.standCache || this.standNet !== this.network) {
      this.standCache = makeStandingSurface(
        this.network,
        this.terrain,
        this.groundOffset(),
        this.roadDrape(),
      );
      this.standNet = this.network;
    }
    return this.standCache(x, z);
  }
  private roadDrapeCache: DrapeField | null = null;
  private roadDrapeNet: RoadNetwork | null = null;
  private roadDrape(): DrapeField {
    if (!this.roadDrapeCache || this.roadDrapeNet !== this.network) {
      this.roadDrapeCache = makeTerracedDrapeField(this.network, this.terrain);
      this.roadDrapeNet = this.network;
    }
    return this.roadDrapeCache;
  }
  // Global model batches; instances flip visibility by chunk on transitions.
  private batches: { mesh: THREE.BatchedMesh; chunkIds: Uint16Array }[] = [];
  private batchChunkGrid = { nx: 1, nz: 1 };
  private chunkVisible: Uint8Array | null = null;
  // chunk key → [batchIndex, instanceId] pairs, so a chunk transition touches
  // only its own instances (a moving camera transitions chunks every frame).
  // Two tiers: big silhouettes (buildings) draw to the fog line; detail
  // (trees, parked cars, props) only needs DETAIL_DISTANCE — the far city
  // stays a skyline instead of 36k full-detail instances.
  private chunkInstancesNear = new Map<number, [number, number][]>();
  // Imposters share ONE BatchedMesh (one draw call) but flip on two different
  // bands: skyline instances to the fog line, the mid-tier fabric one chunk
  // ring less.
  private imposterInstances = new Map<number, number[]>();
  private imposterMidInstances = new Map<number, number[]>();
  private imposterMesh: THREE.BatchedMesh | null = null;
  private imposterVisible: Uint8Array | null = null;
  private imposterMidVisible: Uint8Array | null = null;
  // City-rest cache: everything phases 2+3 produce, in serializable form.
  restCapture: CityRestPayload | null = null;
  private capturedMerged: MergedChunkRec[] = [];
  private capturedMergedMats = new Map<MergedChunkRec, THREE.Material>();
  private restItems: BatchItemRec[] = [];
  private restComplete = true;
  private rawGeos: RawGeoRec[] = [];
  private rawGeoIds = new Map<string, number>();
  private restSkipLogged = new Set<string>();

  private captureMerged(
    mesh: THREE.Mesh,
    cx: number,
    cz: number,
    dist: number,
  ): MergedChunkRec | null {
    const geo = mesh.geometry;
    const mat = mesh.material;
    if (Array.isArray(mat) || !(mat instanceof THREE.MeshStandardMaterial)) return null;
    const srcMat =
      (mesh.userData.srcMat as { url: string; idx: number } | undefined) ??
      (mat.map ? this.cache.srcOfMaterial(mat) : null);
    // A mapped material normally cannot survive serialization — its texture is
    // not in the payload and only a model URL can bring one back. The ROAD
    // materials are the exception: the rebuild re-resolves them from the live
    // table by the colour the capture serialized (roadCollapseTarget), so the
    // paint-stencil atlas — generated in code, zero payload — comes back for
    // free. Without this exception the stencil chunks counted as unserializable,
    // which cleared restComplete and threw away the ENTIRE rest capture: the
    // bake then emitted world.bin only and sat waiting for a rest.bin that was
    // never packed.
    const restorable =
      srcMat !== null ||
      roadCollapseTarget(mat.color.getHex(), mat.polygonOffset, mat.vertexColors) !== null;
    const serializable = !mat.map || restorable;
    if (mat.map && !restorable) {
      this.restComplete = false;
      if (!this.restSkipLogged.has(mat.uuid)) {
        this.restSkipLogged.add(mat.uuid);
        console.log(`[city] merged mesh untagged texture: ${mat.name || mat.uuid}`);
      }
    }
    const pos = geo.getAttribute("position");
    if (!pos) return null;
    const nor = geo.getAttribute("normal");
    const uv = geo.getAttribute("uv");
    const col = geo.getAttribute("color");
    const rec: MergedChunkRec = {
      cx,
      cz,
      dist,
      position: pos.array as Float32Array,
      normal: nor ? (nor.array as Float32Array) : null,
      uv: uv ? (uv.array as Float32Array) : null,
      color: col ? (col.array as Float32Array) : null,
      index: geo.index ? (geo.index.array as Uint16Array | Uint32Array) : null,
      mat: {
        color: mat.color.getHex(),
        roughness: mat.roughness,
        metalness: mat.metalness,
        vertexColors: mat.vertexColors,
        polygonOffset: mat.polygonOffset,
        polygonOffsetFactor: mat.polygonOffsetFactor,
        polygonOffsetUnits: mat.polygonOffsetUnits,
        transparent: mat.transparent,
        opacity: mat.opacity,
      },
      srcMat,
    };
    this.capturedMergedMats.set(rec, mat);
    if (serializable) this.capturedMerged.push(rec);
    return rec;
  }

  private async addMergedChunkRecords(
    records: readonly MergedChunkRec[],
    fallbacks: readonly THREE.Mesh[],
    cx: number,
    cz: number,
    dist: number,
    cullRadius: number,
  ): Promise<void> {
    const builtGroups = await buildMergedChunkGroups({
      records,
      cache: this.cache,
      materialFor: materialFactory(),
      runtimeMaterials: this.capturedMergedMats,
    });
    const chunkGroups = [...builtGroups];
    if (fallbacks.length > 0) {
      const first = chunkGroups[0];
      let target: ChunkMeshGroup;
      if (first) {
        target = first;
      } else {
        target = { group: new THREE.Group(), cx, cz, dist };
        chunkGroups.push(target);
      }
      for (const mesh of fallbacks) target.group.add(mesh);
    }
    for (const chunk of chunkGroups) {
      this.group.add(chunk.group);
      this.chunks.push({
        cx: chunk.cx,
        cz: chunk.cz,
        radius: cullRadius,
        dist: chunk.dist,
        group: chunk.group,
      });
    }
  }
  private chunkVisibleNear: Uint8Array | null = null;

  private restPayload: CityRestPayload | null = null;
  private lateRoadFallback: (() => void) | null = null;

  // The rest payload can arrive AFTER construction (it streams behind the
  // title on the baked path) — set before initLate().
  setRestPayload(p: CityRestPayload | null): void {
    this.restPayload = p;
  }

  constructor(
    private cache: ModelCache,
    private genPayload: CityGenPayload | null = null,
    private rng = new Rng(CITY_SEED),
  ) {
    this.terrain = makeTerrain();
    this.plan = generateCity();
    // Pristine cities drive the BAKED VECTOR network — exact OSM centrelines,
    // no raster quantisation, per-class widths, true diagonals and curves.
    // Cities with painted street edits fall back to the grid-derived graph so
    // the editor's changes stay real everywhere (sim + render).
    const local = loadLocalOverrides();
    const streetEdits =
      CUSTOM_MAP.add.length > 0 ||
      CUSTOM_MAP.remove.length > 0 ||
      local.add.length > 0 ||
      local.remove.length > 0;
    if (streetEdits) {
      const gridNet = buildGridNetwork(
        this.plan,
        (gx) => this.worldX(gx),
        (gz) => this.worldZ(gz),
      );
      this.network = new RoadNetwork(gridNet.nodes, gridNet.edges);
    } else {
      this.network = new RoadNetwork();
    }
    // Garage spots come AFTER the network: candidates whose depot footprint
    // clips vector asphalt are rejected (grid lots ≠ vector lanes).
    this.garages = pickGarageSpots(this.plan, this.terrain, this.network);
    // build happens in init() so the loading bar can breathe between phases
  }

  // Live street rebuild (editor): regenerate the plan + grid network from the
  // CURRENT overrides, strip every mesh that uses a road material, and lay
  // fresh roads. Buildings/props stay as-is (the CLEAR brush + reload handle
  // those); terrain street-depressions stay stale, which the drape absorbs.
  rebuildStreetsLive(root: THREE.Object3D): void {
    this.plan = generateCity();
    const gridNet = buildGridNetwork(
      this.plan,
      (gx) => this.worldX(gx),
      (gz) => this.worldZ(gz),
    );
    this.network = new RoadNetwork(gridNet.nodes, gridNet.edges);
    const roadMats = new Set(Object.values(ROAD_MATERIALS));
    const doomed: THREE.Mesh[] = [];
    root.traverse((o) => {
      if (
        o instanceof THREE.Mesh &&
        o.material instanceof THREE.Material &&
        roadMats.has(o.material)
      ) {
        doomed.push(o);
      }
    });
    for (const m of doomed) {
      m.parent?.remove(m);
      m.geometry.dispose();
    }
    for (const m of buildRoads(this.network, this.roadDrape())) root.add(m);
  }

  worldX(gx: number): number {
    return (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
  }
  worldZ(gz: number): number {
    return (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
  }
  gridX(x: number): number {
    return Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
  }
  gridZ(z: number): number {
    return Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);
  }

  // Grid-cell placement vs the vector asphalt disagree along diagonal spines
  // and junction aprons — ground-seated placements must check the real
  // asphalt or they stand in the roadway (trees/buildings on avenues).
  private onAsphalt(x: number, z: number, margin = 0.2): boolean {
    const hit = this.network.nearest(x, z, ROAD_TILE * 1.4);
    return hit !== null && hit.dist < hit.edge.half + margin;
  }

  private poolFor(c: FabricChar): readonly string[] {
    switch (c) {
      case "downtown":
      case "highrise":
        return this.rng.chance(0.55) ? BUILDINGS_SKYSCRAPER : BUILDINGS_COMMERCIAL;
      case "commercial":
      case "wharf":
        // KayKit blocks carry their own storefront color — a strong mix here
        // breaks up the Kenney-commercial repetition.
        return this.rng.chance(0.35) ? KK_BUILDINGS : BUILDINGS_COMMERCIAL;
      case "industrial":
        return BUILDINGS_INDUSTRIAL;
      case "victorian":
      case "residential":
        // Occasional KayKit mid-rise = the SF corner store/apartment block.
        return this.rng.chance(0.12) ? KK_BUILDINGS_MID : BUILDINGS_SUBURBAN;
    }
  }

  // Pool for a lot that BUTTS its neighbours. 18 of the 21 suburban models are
  // gabled, and a butted gable row is a sawtooth; the flat three plus the
  // commercial blocks give the continuous cornice an attached row needs. The
  // roof family is chosen per BLOCK so a row agrees with itself instead of
  // alternating gable/flat/gable.
  private fabricPool(c: FabricChar, lot: FabricLot): readonly string[] {
    if (!lot.attached) return this.poolFor(c);
    switch (c) {
      case "residential":
      case "victorian":
        return blockHash(lot.x, lot.z) % 4 === 0 ? BUILDINGS_SUBURBAN : SUBURBAN_FLAT_TOP;
      case "downtown":
      case "highrise":
      case "commercial":
      case "wharf":
      case "industrial":
        return this.poolFor(c); // already flat-topped blocks
    }
  }

  private storeysFor(c: FabricChar): number {
    switch (c) {
      case "highrise":
        return 7 + this.rng.int(4);
      case "downtown":
        return 6 + this.rng.int(3);
      case "commercial":
        return 4 + this.rng.int(3);
      case "industrial":
        return 2 + this.rng.int(3);
      case "victorian":
        return 3 + this.rng.int(2);
      case "residential":
        return this.rng.chance(0.75) ? 3 : 4;
      case "wharf":
        return 2 + this.rng.int(2);
    }
  }

  // The facade colour: one dominant per block, two or three accents around it.
  private blockColorAt(x: number, z: number, district: District): number {
    const pal = paletteFor(district);
    const h = blockHash(x, z);
    const dominant = pal[h % pal.length];
    if (dominant === undefined) return 0xffffff;
    if (pal.length < 2 || this.rng.chance(0.66)) return dominant;
    return pal[(h + 1 + this.rng.int(pal.length - 1)) % pal.length] ?? dominant;
  }

  // Tuck-under garage on the DOWNHILL face of a hillside plinth: a dark door
  // under a header band, and a stoop back up to the raised entry. Skipped when
  // the street face is the uphill one — then the garage is round the back,
  // where nobody driving past can see it.
  private garageFronts = 0;
  private addGarageFront(
    collect: (obj: THREE.Object3D) => void,
    lot: FabricLot,
    seatY: number,
    plinthH: number,
  ): void {
    const fx = (lot.x0 + lot.x1) / 2;
    const fz = (lot.z0 + lot.z1) / 2;
    const faceY = this.terrain.heightAt(fx, fz);
    if (faceY > seatY - 1.4) return; // the front is level or uphill
    const nx = (fx - lot.x) / Math.max(Math.hypot(fx - lot.x, fz - lot.z), 0.001);
    const nz = (fz - lot.z) / Math.max(Math.hypot(fx - lot.x, fz - lot.z), 0.001);
    const doorW = Math.min(4.2, lot.width * 0.44);
    const doorH = Math.min(plinthH - 0.5, 3.0);
    if (doorH < 1.2) return;
    const skin = 0.14; // proud of the plinth face so it can't z-fight it
    const door = new THREE.Mesh(PLINTH_GEO, GARAGE_DOOR_MAT);
    door.scale.set(doorW, doorH, 0.5);
    door.rotation.y = lot.yaw;
    door.position.set(
      lot.x + nx * (lot.depth / 2 + skin),
      faceY + doorH / 2,
      lot.z + nz * (lot.depth / 2 + skin),
    );
    door.updateMatrixWorld(true);
    collect(door);
    const head = new THREE.Mesh(PLINTH_GEO, PLINTH_MAT);
    head.scale.set(doorW + 0.7, 0.42, 0.62);
    head.rotation.y = lot.yaw;
    head.position.set(
      lot.x + nx * (lot.depth / 2 + skin + 0.06),
      faceY + doorH + 0.2,
      lot.z + nz * (lot.depth / 2 + skin + 0.06),
    );
    head.updateMatrixWorld(true);
    collect(head);
    // Stoop: three steps beside the door, ground to the raised entry. A single
    // tilted slab was cheaper by two boxes and read as a plank leaning on the
    // wall — steps are what makes the raised entry legible.
    const rise = seatY - faceY;
    const sideX = -nz * (doorW / 2 + 1.2);
    const sideZ = nx * (doorW / 2 + 1.2);
    const treads = 3;
    for (let i = 0; i < treads; i++) {
      const stepH = (rise * (i + 1)) / treads;
      const out = 1.5 - (i * 1.5) / treads; // the bottom step reaches furthest
      const step = new THREE.Mesh(PLINTH_GEO, PLINTH_MAT);
      step.scale.set(1.9, stepH, out + 0.35);
      step.rotation.y = lot.yaw;
      step.position.set(
        lot.x + nx * (lot.depth / 2 + (out + 0.35) / 2) + sideX,
        faceY + stepH / 2 - 0.1,
        lot.z + nz * (lot.depth / 2 + (out + 0.35) / 2) + sideZ,
      );
      step.updateMatrixWorld(true);
      collect(step);
    }
    this.garageFronts++;
  }

  // District-tinted material clones, cached so tinted buildings still merge.
  // Tint via per-INSTANCE color (BatchedMesh.setColorAt): the batcher
  // multiplies it with the material map exactly like the old cloned-material
  // lerp did for white-based kit materials — and tint variants stop
  // multiplying batch count (and material count).
  private tintNode(node: THREE.Object3D, hex: number, amt: number): void {
    node.traverse((c) => {
      if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial) {
        c.userData.tint = c.material.color.clone().lerp(new THREE.Color(hex), amt);
      }
    });
  }

  // Build in yielded phases so the loading bar paints during city gen.
  async init(onProgress?: (f: number) => void): Promise<void> {
    await this.initEarly(onProgress);
    await this.initLate(onProgress);
  }

  // Phase 1 only: terrain + streets + network — enough world for the title
  // screen. The heavy passes (buildings, furniture, batching) run in
  // initLate BEHIND the title, so time-to-title is a third of full gen.
  async initEarly(onProgress?: (f: number) => void): Promise<void> {
    const tick = async (f: number): Promise<void> => {
      onProgress?.(f);
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    };
    const t0 = performance.now();
    await tick(0.87);
    this.buildPhase1();
    console.log(`[city] phase1 ${Math.round(performance.now() - t0)}ms`);
    await tick(0.95);
  }

  async initLate(onProgress?: (f: number) => void): Promise<void> {
    const tick = async (f: number): Promise<void> => {
      onProgress?.(f);
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    };
    if (this.restPayload) {
      const tR = performance.now();
      await this.rebuildRest(this.restPayload, onProgress);
      console.log(`[city] rest rebuild ${Math.round(performance.now() - tR)}ms`);
      await tick(0.97);
      return;
    }
    this.lateRoadFallback?.();
    const t0 = performance.now();
    await this.phase2();
    const t1 = performance.now();
    await tick(0.9);
    await this.phase3();
    console.log(
      `[city] phase2 ${Math.round(t1 - t0)}ms phase3 ${Math.round(performance.now() - t1)}ms`,
    );
    await tick(0.97);
  }

  private phase2!: () => Promise<void>;
  private phase3!: () => Promise<void>;
  // Yield to the event loop so the title screen stays interactive while the
  // city finishes building behind it.
  private lastBreathe = 0;
  private async breathe(): Promise<void> {
    if (performance.now() - this.lastBreathe < 12) return;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    this.lastBreathe = performance.now();
  }

  private buildPhase1(): void {
    const staticMeshes: THREE.Mesh[] = [];
    const collect = (obj: THREE.Object3D): void => {
      obj.updateMatrixWorld(true);
      obj.traverse((c) => {
        if (c instanceof THREE.Mesh) staticMeshes.push(c);
      });
    };

    // Large tree trunks are REAL (arcade collision, no physics body) — the
    // taxi bounces off a tree instead of ghosting through the canopy.
    const treeSolid = (tx: number, tz: number): void => {
      const h = 0.55;
      this.solids.push({ minX: tx - h, maxX: tx + h, minZ: tz - h, maxZ: tz + h, noBody: true });
    };

    // Grass patch + scattered trees on a cell (parks + block interiors).
    const placeGreen = (gx: number, gz: number): void => {
      // The Marin headland (v < 0.03) is the Golden Gate module's domain: it
      // plants its own trees CLEAR of the bridge-landing corridor. Generic
      // green-lot scatter here put tree solids right on the crossing path.
      if ((gz + 0.5) / GRID_Z < 0.03) return;
      const wx = this.worldX(gx);
      const wz = this.worldZ(gz);
      // The lawn itself is painted by the ground mesh's vertex grading (see
      // colorAt below) — a draped quad per green cell was ~half the map's
      // conform geometry for something vertex colors do for free.
      if (this.rng.chance(0.55)) {
        const count = 1 + this.rng.int(2);
        for (let i = 0; i < count; i++) {
          const large = this.rng.chance(0.6);
          const treeUrl = modelUrl("props", large ? TREE_LARGE : TREE_SMALL);
          const tb = this.cache.bounds(treeUrl);
          const tsc = (ROAD_TILE * 0.42) / Math.max(tb.size.y, 0.001);
          const tree = this.cache.instance(treeUrl);
          tree.scale.setScalar(tsc);
          const tx = wx + this.rng.range(-2.6, 2.6);
          const tz = wz + this.rng.range(-2.6, 2.6);
          if (this.onAsphalt(tx, tz, 0.6)) continue;
          if (nearFreeway(tx, tz, 0.5)) continue; // canopy pierces the deck
          tree.position.set(tx, this.standAt(tx, tz), tz);
          tree.rotation.y = this.rng.range(0, Math.PI * 2);
          collect(tree);
          if (large) treeSolid(tx, tz);
        }
      }
    };

    // --- Roads: procedural street geometry generated straight from the
    // network graph (world/roads.ts) — asphalt/curbs/sidewalks/markings can
    // never disagree with the connections. ---
    for (let gx = 0; gx < GRID_X; gx++) {
      for (let gz = 0; gz < GRID_Z; gz++) {
        if (this.plan.roads[gx]?.[gz]) this.roadCells.push({ gx, gz });
      }
    }

    const pushRoads = (meshes: THREE.Mesh[]): void => {
      for (const mesh of meshes) {
        mesh.userData.merge = true; // road ribbons are unique conformed buffers
        staticMeshes.push(mesh);
      }
    };
    if (this.genPayload && this.genPayload.roadParts.length > 0) {
      pushRoads(roadPartsToMeshes(this.genPayload.roadParts));
    } else if (!this.genPayload) {
      pushRoads(buildRoads(this.network, this.roadDrape()));
    }
    // Baked world payloads carry no roadParts (rest.bin's merged chunks have
    // the roads). If rest FAILS to arrive, initLate generates them here.
    this.lateRoadFallback = () => {
      if (this.genPayload && this.genPayload.roadParts.length === 0) {
        pushRoads(buildRoads(this.network, this.roadDrape()));
      }
    };

    // --- Landmark footprints: cells the procedural city leaves alone.
    // Editor "clear" cells join the reservation, so every placement pass
    // (buildings, furniture, park tiles) skips them. ---
    const lmBase = landmarkProtection(this.plan, this.network);
    const reservedAll = new Set(lmBase.reserved);
    for (const [cgx, cgz] of loadLocalOverrides().clear ?? []) {
      reservedAll.add(`${cgx},${cgz}`);
    }
    // Garages claim their two cells before anything else builds there.
    for (const g of this.garages) {
      const ggx = Math.floor((g.x + WORLD_HALF_X) / ROAD_TILE);
      const ggz = Math.floor((g.z + WORLD_HALF_Z) / ROAD_TILE);
      reservedAll.add(`${ggx},${ggz}`);
    }
    const lm = { ...lmBase, reserved: reservedAll };
    // Landmark monuments have visuals but are NOT batch items (built as
    // one-off meshes in buildLandmarks), so the e2e sightless census cannot
    // vouch for them — tag the reason instead of relying on batched
    // neighbours to cover them by coincidence.
    for (const s of lm.solids) this.solids.push({ ...s, unseen: "landmark (unbatched monument)" });
    // The depot buildings themselves (orange roller-door warehouse).
    for (const g of this.garages) {
      const url = modelUrl("buildings", GARAGE_MODEL);
      const node = this.cache.instance(url);
      const b = this.cache.bounds(url);
      const sc = (ROAD_TILE * 0.78) / Math.max(b.size.x, b.size.z, 0.001); // house-sized
      node.scale.setScalar(sc);
      node.rotation.y = g.yaw;
      node.position.set(g.x, this.standAt(g.x, g.z), g.z);
      node.updateMatrixWorld(true);
      collect(node);
      const half = ROAD_TILE * 0.42;
      this.solids.push({
        minX: g.x - half,
        maxX: g.x + half,
        minZ: g.z - half,
        maxZ: g.z + half,
      });
    }

    const placedHash = new Map<number, OccBox[]>();
    let occRow = 0;
    const occupiedBy = (b: OccBox): boolean => {
      let hit = false;
      occSpan(b, (key) => {
        if (hit) return;
        for (const o of placedHash.get(key) ?? []) {
          if (o.row === b.row) continue; // same walk — an intentional neighbour
          if (boxesOverlap(o, b)) {
            hit = true;
            return;
          }
        }
      });
      return hit;
    };
    const occupy = (b: OccBox): void => {
      occSpan(b, (key) => {
        const arr = placedHash.get(key);
        if (arr) arr.push(b);
        else placedHash.set(key, [b]);
      });
    };

    // A block-INTERIOR lot on a grid cell, facing the same street its frontage
    // neighbour does. The shrink lives here rather than inside placeBuilding
    // because the caller has to know the width it got: this is the cell-based
    // twin of planFabricRow, and like it, it hands back a finished lot.
    const fitCellLot = (gx: number, gz: number, faceDir: Dir, frac: number): FabricLot | null => {
      const wx = this.worldX(gx);
      const wz = this.worldZ(gz);
      const character = fabricCharAt(wx, wz);
      if (character === null) return null;
      if (this.onAsphalt(wx, wz, 1)) return null;
      const yaw = dirToYaw(faceDir);
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      const cornersClear = (f: number): boolean => {
        const h = ROAD_TILE * f * 0.46;
        return !(
          this.onAsphalt(wx - h, wz - h, 0.4) ||
          this.onAsphalt(wx + h, wz - h, 0.4) ||
          this.onAsphalt(wx - h, wz + h, 0.4) ||
          this.onAsphalt(wx + h, wz + h, 0.4)
        );
      };
      let fit = frac;
      if (!cornersClear(fit)) {
        const near = this.network.nearest(wx, wz, ROAD_TILE * 1.6);
        fit = near
          ? Math.min(fit, ((near.dist - near.edge.half - 0.5) * 2) / ROAD_TILE)
          : fit * 0.75;
        // Corner lots see a second street the nearest-edge shrink can't: one
        // more step down before giving the lot to grass.
        if (ROAD_TILE * fit < LOT_MIN || !cornersClear(fit)) {
          fit *= 0.78;
          if (ROAD_TILE * fit < LOT_MIN || !cornersClear(fit)) return null;
        }
      }
      const width = ROAD_TILE * fit;
      // Interior lots read from the side, so they stay near-square: the deep
      // plan belongs to the street row whose flanks its neighbours hide.
      const depth = width * LOT_DEPTH_SHALLOW;
      return {
        x: wx,
        z: wz,
        yaw,
        width,
        depth,
        rear: 0, // an interior cell IS the block interior; nothing behind it
        character,
        attached: false,
        run: 0,
        x0: wx - (width / 2) * cos - (depth / 2) * sin,
        z0: wz - (width / 2) * sin + (depth / 2) * cos,
        x1: wx + (width / 2) * cos - (depth / 2) * sin,
        z1: wz + (width / 2) * sin + (depth / 2) * cos,
      };
    };

    // Why a planned lot did not get built — the fabric pass is the biggest
    // consumer of gen time and has no other visibility into its own losses.
    const rejects = { freeway: 0, occupied: 0, cliff: 0, reserved: 0 };

    // One building on one finished lot. The lot's width, depth, facing and
    // setback are decided by the caller (planFabricRow for frontage rows,
    // fitCellLot for block-interior infill) and are FINAL here: this used to
    // narrow the building itself, after the walk had already stepped by the
    // un-narrowed width, which put the gap somewhere no caller could see.
    // Returns the lot it built, or null when the lot is unbuildable.
    const placeOne = (
      lot: FabricLot,
      row: number,
      dressing: boolean, // rooftop towers + curbside trees (frontage only)
    ): FabricLot | null => {
      const wx = lot.x;
      const wz = lot.z;
      const district = districtAt(gridXOf(wx), gridZOf(wz));
      if (nearFreeway(wx, wz, 1.5)) {
        rejects.freeway++;
        return null; // no lots inside the viaduct ROW
      }
      const halfW = lot.width / 2;
      const halfD = lot.depth / 2;
      const cos = Math.cos(lot.yaw);
      const sin = Math.sin(lot.yaw);
      if (occupiedBy(occBox(wx, wz, halfW, halfD, lot.yaw, row))) {
        rejects.occupied++;
        return null;
      }
      // Attached rows want a continuous cornice, not 18 gables in a sawtooth.
      const key = this.rng.pick(this.fabricPool(lot.character, lot));
      const url = modelUrl("buildings", key);
      const bounds = this.cache.bounds(url);
      const node = this.cache.instance(url);
      // Frontage on X, depth on Z, height on its own storey count: the old
      // single `sxz` tied depth to frontage, so a narrow row house was also a
      // shallow one — the opposite of what SF row houses are.
      const storeys = this.storeysFor(lot.character);
      const worldH = FABRIC_STOREY * storeys;
      // Tall enough to stop being one box: podium at the lot line, shaft inset,
      // crown at the measured taper. One prism the whole way up is what makes a
      // kit skyscraper read as an extruded rectangle.
      const tall = worldH >= TOWER_MIN_H;
      const podiumH = tall ? worldH * TOWER_PODIUM : 0;
      const inset = tall ? TOWER_INSET : 1;
      node.scale.set(
        (lot.width * inset) / Math.max(bounds.size.x, 0.001),
        (worldH - podiumH) / Math.max(bounds.size.y, 0.001),
        (lot.depth * inset) / Math.max(bounds.size.z, 0.001),
      );
      node.rotation.y = lot.yaw + BUILDING_FRONT_OFFSET;
      // Buildings stay vertical. SF cuts the uphill wall INTO the grade and
      // stilts the downhill side on a garage plinth; seating every lot at its
      // high corner (the old rule) floated whole hillside rows on a plinth as
      // tall as the fall, and anything past a 5u fall was deleted outright and
      // replaced with three trees — 55-75% of the near-summit lots, on the hills
      // San Francisco is famous for building on.
      const corners = [
        this.terrain.heightAt(wx, wz),
        this.terrain.heightAt(wx - halfW * cos - halfD * sin, wz - halfW * sin + halfD * cos),
        this.terrain.heightAt(wx + halfW * cos - halfD * sin, wz + halfW * sin + halfD * cos),
        this.terrain.heightAt(wx - halfW * cos + halfD * sin, wz - halfW * sin - halfD * cos),
        this.terrain.heightAt(wx + halfW * cos + halfD * sin, wz + halfW * sin - halfD * cos),
      ];
      const loY = Math.min(...corners);
      let hiY = Math.max(...corners);
      // Park/landuse-green cells carry a flat terrace TILE seated at the
      // cell's highest corner — a house seated on the raw field there gets
      // buried by its own lawn. Seat on the terrace instead.
      const cgx = gridXOf(wx);
      const cgz = gridZOf(wz);
      if (isParkLand(cgx, cgz)) {
        hiY = Math.max(hiY, parkCellHeight(this.terrain, cgx, cgz));
      }
      const fall = hiY - loY;
      if (fall > STEEP_CLIFF) {
        rejects.cliff++;
        // A genuine cliff face — real SF leaves these green.
        for (let i = 0; i < 3; i++) {
          const steepTreeUrl = modelUrl("props", this.rng.chance(0.5) ? TREE_LARGE : TREE_SMALL);
          const stb = this.cache.bounds(steepTreeUrl);
          const sts = (ROAD_TILE * 0.3) / Math.max(stb.size.y, 0.001);
          const steepTree = this.cache.instance(steepTreeUrl);
          steepTree.scale.setScalar(sts);
          const stx = wx + this.rng.range(-3.5, 3.5);
          const stz = wz + this.rng.range(-3.5, 3.5);
          if (this.onAsphalt(stx, stz, 0.6)) continue;
          if (nearFreeway(stx, stz, 0.5)) continue;
          steepTree.position.set(stx, this.standAt(stx, stz), stz);
          steepTree.rotation.y = this.rng.range(0, Math.PI * 2);
          collect(steepTree);
        }
        return null;
      }
      // Step INTO the slope: the uphill wall is cut in, the downhill one rides
      // a plinth that is now only part of the fall instead of all of it.
      const seatY = fall > 1.0 ? Math.max(loY + fall * STEP_INTO_SLOPE, hiY - STEP_BURY_MAX) : hiY;
      const plinthH = seatY - loY + 0.8;
      if (fall > 0.7) {
        const plinth = new THREE.Mesh(PLINTH_GEO, PLINTH_MAT);
        plinth.scale.set(lot.width * 0.98, plinthH, lot.depth * 0.98);
        plinth.rotation.y = lot.yaw;
        plinth.position.set(wx, seatY - 0.1 - plinthH / 2, wz);
        plinth.updateMatrixWorld(true);
        collect(plinth);
        // The plinth's downhill face is the most-repeated hill element in the
        // map; give it the tuck-under garage SF actually builds there.
        if (plinthH >= PLINTH_GARAGE_MIN) this.addGarageFront(collect, lot, seatY, plinthH);
      }
      node.position.set(wx, seatY - 0.15 + podiumH, wz);
      // KayKit blocks ship with authored storefront colors — a light kiss of
      // district tint keeps rows cohesive without muddying them.
      const tintAmt = key.startsWith("kk-building")
        ? tintAmountFor(district) * 0.25 * TINT_GAIN
        : Math.min(1, tintAmountFor(district) * TINT_GAIN);
      const bodyColor = this.blockColorAt(wx, wz, district);
      this.tintNode(node, bodyColor, tintAmt);
      collect(node);
      if (tall) {
        const podium = new THREE.Mesh(PLINTH_GEO, PLINTH_MAT);
        podium.scale.set(lot.width, podiumH + 0.3, lot.depth);
        podium.rotation.y = lot.yaw;
        podium.position.set(wx, seatY + podiumH / 2 - 0.3, wz);
        podium.updateMatrixWorld(true);
        this.tintNode(podium, bodyColor, tintAmt * 0.7);
        collect(podium);
        const taper = worldH >= 40 ? 0.57 : 0.72;
        const crownH = Math.min(2.4, worldH * 0.07);
        const crown = new THREE.Mesh(PLINTH_GEO, PLINTH_MAT);
        crown.scale.set(lot.width * inset * taper, crownH, lot.depth * inset * taper);
        crown.rotation.y = lot.yaw;
        crown.position.set(wx, seatY + worldH + crownH / 2 - 0.4, wz);
        crown.updateMatrixWorld(true);
        this.tintNode(crown, bodyColor, tintAmt * 0.8);
        collect(crown);
      }

      // Solid footprint (a touch smaller than the visual so curbs are
      // forgiving), carried as an OBB so rotated rows collide truthfully.
      this.solids.push({
        minX: wx - halfW * 0.96,
        maxX: wx + halfW * 0.96,
        minZ: wz - halfD * 0.96,
        maxZ: wz + halfD * 0.96,
        yaw: lot.yaw,
      });
      occupy(occBox(wx, wz, halfW, halfD, lot.yaw, row));

      if (!dressing) return lot;

      // Rooftop watertower — the classic city-builder silhouette — on some
      // mid-rise commercial roofs.
      if (
        (district.character === "commercial" || district.character === "downtown") &&
        this.rng.chance(0.09)
      ) {
        const towerUrl = modelUrl("props", "kk-watertower");
        const twb = this.cache.bounds(towerUrl);
        // Actual world-space roof of the placed building — bulletproof against
        // any model origin/height quirk that made towers float.
        node.updateMatrixWorld(true);
        const roofBox = new THREE.Box3().setFromObject(node);
        const roofY = roofBox.max.y;
        const tws = 3.4 / Math.max(twb.size.y, 0.001);
        const tower = this.cache.instance(towerUrl);
        tower.scale.setScalar(tws);
        tower.rotation.y = this.rng.range(0, Math.PI * 2);
        // Dead-centre on the roof so it never reads as hanging off an edge.
        tower.position.set(wx, roofY - 0.15, wz);
        collect(tower);
      }

      // Occasional curbside tree, in front of the facade. The old version
      // stepped along DIR_DELTA[faceDir], which every frontage row passed as
      // north — so half of them planted their street tree in the back yard.
      if (this.rng.chance(0.3)) {
        const fx = (lot.x0 + lot.x1) / 2 - wx;
        const fz = (lot.z0 + lot.z1) / 2 - wz;
        const fl = Math.max(Math.hypot(fx, fz), 0.001);
        const large = this.rng.chance(0.5);
        const treeUrl = modelUrl("props", large ? TREE_LARGE : TREE_SMALL);
        const tb = this.cache.bounds(treeUrl);
        const ts = (ROAD_TILE * 0.32) / Math.max(tb.size.y, 0.001);
        const tree = this.cache.instance(treeUrl);
        tree.scale.setScalar(ts);
        const reach = fl + 1.1;
        const tx = wx + (fx / fl) * reach + this.rng.range(-0.8, 0.8);
        const tz = wz + (fz / fl) * reach + this.rng.range(-0.8, 0.8);
        if (!this.onAsphalt(tx, tz, 0.6)) {
          tree.position.set(tx, this.standAt(tx, tz), tz);
          tree.rotation.y = this.rng.range(0, Math.PI * 2);
          collect(tree);
          if (large) treeSolid(tx, tz);
        }
      }
      return lot;
    };

    // One lot, STEPPED into its slope if it has to be. A single box can only
    // absorb about FALL_PER_STEP of fall — beyond that it is either floating on
    // a plinth as tall as a tower (which is what a 9u "hillside foundation"
    // looked like) or buried to its eaves. SF splits the building instead, into
    // sections that each take part of the drop, which is what the stepped rows
    // on Nob Hill and Potrero are. Only a genuine cliff is left green.
    const placeBuilding = (lot: FabricLot, row: number, dressing: boolean): FabricLot | null => {
      const halfW = lot.width / 2;
      const halfD = lot.depth / 2;
      const cos = Math.cos(lot.yaw);
      const sin = Math.sin(lot.yaw);
      // Corner heights, in the lot's own frame: (±width, ±depth).
      const h = (a: number, b: number): number =>
        this.terrain.heightAt(
          lot.x + a * halfW * cos - b * halfD * sin,
          lot.z + a * halfW * sin + b * halfD * cos,
        );
      const hmm = h(-1, -1);
      const hpm = h(1, -1);
      const hmp = h(-1, 1);
      const hpp = h(1, 1);
      const fall = Math.max(hmm, hpm, hmp, hpp) - Math.min(hmm, hpm, hmp, hpp);
      if (fall <= FALL_PER_STEP) return placeOne(lot, row, dressing);
      const steps = Math.min(3, Math.ceil(fall / FALL_PER_STEP));
      // Step along whichever axis the ground actually falls down.
      const alongWidth = Math.abs(hpm + hpp - hmm - hmp);
      const alongDepth = Math.abs(hmp + hpp - hmm - hpm);
      const axis: 0 | 1 = alongWidth >= alongDepth ? 0 : 1;
      // A slice thinner than this is a wall, not a building.
      if ((axis === 0 ? lot.width : lot.depth) / steps < 2.6) {
        return placeOne(lot, row, dressing);
      }
      let first: FabricLot | null = null;
      for (let k = 0; k < steps; k++) {
        const built = placeOne(sliceLot(lot, axis, k, steps), row, k === 0 && dressing);
        if (first === null) first = built;
      }
      return first;
    };

    // --- Buildings (district-driven pool, palette tint, height) ---
    for (const b of this.plan.buildingCells) {
      const cellId = `${b.gx},${b.gz}`;
      if (lm.reserved.has(cellId)) continue; // a landmark stands here
      if (districtAt(b.gx, b.gz).character === "park" || lm.parkGreen.has(cellId)) {
        placeGreen(b.gx, b.gz); // park frontage → green, drivable (no solid)
      }
    }

    this.phase2 = async () => {
      // --- REAL downtown fabric: footprint POLYGONS + heights from the
      // licensed SF model (tools/sf-data/extract-footprints.mjs), extruded as
      // flat-shaded prisms — the actual massing at the actual addresses.
      // Kit models only fill in where the real data thins out (occupancy
      // marks make the frontage pass skip real parcels). ---
      {
        let placed = 0;
        let roadSkip = 0;
        let stackSkip = 0;
        let parkSkip = 0;
        let towers = 0;
        for (let pid = 0; pid < SF_FOOTPRINTS.length; pid++) {
          if (pid % 500 === 0) await this.breathe();
          const flat = SF_FOOTPRINTS[pid];
          if (flat === undefined) continue;
          const spec = prismSpec(flat);
          if (!spec) continue;
          const { cx, cz, h: bh, rel } = spec;
          const bgx = this.gridX(cx);
          const bgz = this.gridZ(cz);
          if (!isLandCell(bgx, bgz)) continue;
          if (lm.reserved.has(`${bgx},${bgz}`)) continue; // landmark parcel
          // A parcel whose centroid falls inside another one is a height-band
          // or building-part DUPLICATE of it (2,570 of them, measured in
          // sf-adjacency.ts). Extruding both is what made downtown grey mush,
          // and it is exactly what the old blanket 3.2u occupancy circle was
          // really suppressing — at the cost of ~10k parcels whose only sin was
          // standing next to their neighbour, which is what a party wall IS.
          const parcel = parcelAt(pid);
          if (parcel !== null && parcel.stacked) {
            stackSkip++;
            continue;
          }
          // Both fabric passes now agree on park LAND rather than on park
          // NAMES: the frontage walk skips park-character districts, and this
          // one used to skip nothing at all, so ~330 real parcels landed inside
          // Dolores Park and the Panhandle. A real parcel in a park-named
          // district box is real (it is the block across the street); a parcel
          // standing on an actual park tile is not.
          if (isParkLand(bgx, bgz)) {
            parkSkip++;
            continue;
          }
          // Real parcels + real streets agree to calibration error (~5u);
          // only a parcel genuinely IN a lane gets skipped — nudging one
          // building of a wall-to-wall row just makes it collide with the
          // next one.
          if (this.onAsphalt(cx, cz, 0.4)) {
            roadSkip++;
            continue;
          }
          // Corridor guard checks every ring vertex — a 30u building whose
          // CENTROID clears the ramp can still lay a corner across the deck.
          let fwHit = nearFreeway(cx, cz, 0.5);
          for (let i = 0; i < rel.length && !fwHit; i += 2) {
            if (nearFreeway(cx + (rel[i] ?? 0), cz + (rel[i + 1] ?? 0), 0.3)) fwHit = true;
          }
          if (fwHit) {
            roadSkip++;
            continue;
          }
          let deep = false;
          for (let i = 0; i < rel.length && !deep; i += 2) {
            if (this.onAsphalt(cx + (rel[i] ?? 0), cz + (rel[i + 1] ?? 0), -1.2)) deep = true;
          }
          if (deep) {
            roadSkip++;
            continue;
          }
          // Seat at the highest ring vertex; sink the walls to the lowest so
          // hillside parcels never show open air under the low side.
          let hiY = this.terrain.heightAt(cx, cz);
          let loY = hiY;
          for (let i = 0; i < rel.length; i += 2) {
            const y = this.terrain.heightAt(cx + (rel[i] ?? 0), cz + (rel[i + 1] ?? 0));
            if (y > hiY) hiY = y;
            if (y < loY) loY = y;
          }
          const fall = hiY - loY;
          if (fall > PRISM_CLIFF) continue; // cliff-steep — leave the face green
          // Same rule as the kit fabric: cut into the uphill grade instead of
          // floating the whole parcel at its high corner.
          const seatY =
            fall > 1.0 ? Math.max(loY + fall * STEP_INTO_SLOPE, hiY - STEP_BURY_MAX) : hiY;
          const drop = seatY - loY;

          // KIT MODELS fitted to the real parcel: bare extruded prisms read
          // as colored blocks, not buildings. Fit the footprint's OBB; long
          // parcels get a ROW of models (real blocks are several buildings,
          // and one model stretched 5:1 is worse than none).
          // The along-axis is the parcel's FRONTAGE — its longest edge that is
          // not a party wall (sf-adjacency.ts). The plain longest edge often IS
          // a party wall on an attached parcel, which turned the model (and its
          // entrance) to face the neighbour it shares that wall with.
          const nPts = rel.length / 2;
          const front = frontEdgeOf(pid);
          let obbLen = 0;
          let ex = 1;
          let ez = 0;
          const ringEdge = (i: number): { dx: number; dz: number; len: number } => {
            const j = (i + 1) % nPts;
            const dx = (rel[j * 2] ?? 0) - (rel[i * 2] ?? 0);
            const dz = (rel[j * 2 + 1] ?? 0) - (rel[i * 2 + 1] ?? 0);
            return { dx, dz, len: Math.hypot(dx, dz) };
          };
          const frontEdge = front === null ? null : ringEdge(front);
          if (frontEdge !== null && frontEdge.len > 0.001) {
            obbLen = frontEdge.len;
            ex = frontEdge.dx / frontEdge.len;
            ez = frontEdge.dz / frontEdge.len;
          } else {
            for (let i = 0; i < nPts; i++) {
              const e = ringEdge(i);
              if (e.len > obbLen) {
                obbLen = e.len;
                ex = e.dx / e.len;
                ez = e.dz / e.len;
              }
            }
          }
          let minA = Infinity;
          let maxA = -Infinity;
          let minB = Infinity;
          let maxB = -Infinity;
          for (let i = 0; i < nPts; i++) {
            const dx = rel[i * 2] ?? 0;
            const dz = rel[i * 2 + 1] ?? 0;
            const a = dx * ex + dz * ez;
            const b = -dx * ez + dz * ex;
            if (a < minA) minA = a;
            if (a > maxA) maxA = a;
            if (b < minB) minB = b;
            if (b > maxB) maxB = b;
          }
          const lenA = maxA - minA;
          const lenB = maxB - minB;
          if (lenA < 2.6 || lenB < 2.6) continue; // sliver — nothing fits
          const yaw = Math.atan2(-ez, ex);
          // The parcel's own rectangle against everything already standing.
          // The old test was a 3.2u circle on the centroid against a 5u circle
          // per placed segment, which rejected any parcel within ~8u of a
          // neighbour — i.e. every attached parcel in the city.
          const midA = (minA + maxA) / 2;
          const midB = (minB + maxB) / 2;
          const obbX = cx + midA * ex - midB * ez;
          const obbZ = cz + midA * ez + midB * ex;
          const parcelRow = ++occRow;
          if (occupiedBy(occBox(obbX, obbZ, lenA / 2, lenB / 2, yaw, parcelRow))) continue;
          const bhV = Math.max(bh, 4.0); // below this the kit models squash into pancakes
          const pool =
            bhV > 28 ? BUILDINGS_SKYSCRAPER : bhV > 9 ? BUILDINGS_COMMERCIAL : BUILDINGS_SUBURBAN;
          const district = districtAt(bgx, bgz);
          // Towers own their whole parcel; low/mid parcels split into a grid
          // of near-square cells — one model pancaked across a 25u lot reads
          // as a squashed shed, a row of houses reads as a block.
          const TARGET = 9;
          const segA = bhV > 28 ? 1 : Math.min(6, Math.max(1, Math.round(lenA / TARGET)));
          const segB = bhV > 28 ? 1 : Math.min(3, Math.max(1, Math.round(lenB / TARGET)));
          // Podium + shaft + crown. The podium is emitted ONCE for the whole
          // parcel and the shafts are inset about their own centres, so a long
          // tall block reads as shafts standing on a shared podium rather than
          // as a row of wedding cakes. Only a single-mass parcel gets a crown.
          const tall = bhV >= TOWER_MIN_H;
          const single = segA * segB === 1;
          const segLen = lenA / segA;
          const segWid = lenB / segB;
          let placedSeg = 0;
          for (let k = 0; k < segA * segB; k++) {
            const ka = k % segA;
            const kb = Math.floor(k / segA);
            const a0 = minA + segLen * (ka + 0.5);
            const bb0 = minB + segWid * (kb + 0.5);
            const px = cx + a0 * ex - bb0 * ez;
            const pz = cz + a0 * ez + bb0 * ex;
            // The OBB covers more than an L-shaped ring: every segment
            // re-checks its own corners against the streets (and shrinks
            // once before giving up).
            let fw = segLen * 0.94;
            let fd = segWid * 0.92;
            const cornersClear = (): boolean => {
              for (const [sa, sb] of [
                [-fw / 2, -fd / 2],
                [fw / 2, -fd / 2],
                [fw / 2, fd / 2],
                [-fw / 2, fd / 2],
              ] as const) {
                const qx = px + sa * ex - sb * ez;
                const qz = pz + sa * ez + sb * ex;
                if (this.onAsphalt(qx, qz, 0.2)) return false;
              }
              return true;
            };
            if (!cornersClear()) {
              fw *= 0.78;
              fd *= 0.78;
              if (fw < 2.4 || fd < 2.4 || !cornersClear()) continue;
            }
            const key = this.rng.pick(pool);
            const url = modelUrl("buildings", key);
            const bounds = this.cache.bounds(url);
            const node = this.cache.instance(url);
            // A tower is a PODIUM + SHAFT + CROWN, not one prism: measured on
            // the source model, the flat-prism share collapses from 99.5% at
            // 1-2u to 21.7% at 20-40u and 0% above 40u, with the median plan
            // tapering 1.00 -> 0.72 -> 0.57 up the height. The shaft is inset
            // about the parcel centre and the podium keeps the full lot line,
            // which is what gives the street a continuous wall under a tower.
            const podiumH = tall ? bhV * 0.22 : 0;
            const shaftInset = tall ? 0.78 : 1;
            const bodyBase = seatY + podiumH;
            node.scale.set(
              (fw * shaftInset) / Math.max(bounds.size.x, 0.001),
              (bhV - podiumH) / Math.max(bounds.size.y, 0.001),
              (fd * shaftInset) / Math.max(bounds.size.z, 0.001),
            );
            node.rotation.y = yaw + BUILDING_FRONT_OFFSET;
            const bodyColor = this.blockColorAt(px, pz, district);
            const bodyTint = Math.min(1, tintAmountFor(district) * TINT_GAIN);
            if (tall && single) {
              // Crown: the mechanical box every SF tower wears, at the measured
              // taper for its band.
              const crownTaper = bhV >= 40 ? 0.57 : 0.72;
              const crownH = Math.min(2.4, bhV * 0.07);
              const crown = new THREE.Mesh(PLINTH_GEO, PLINTH_MAT);
              crown.scale.set(fw * shaftInset * crownTaper, crownH, fd * shaftInset * crownTaper);
              crown.rotation.y = yaw;
              crown.position.set(px, seatY + bhV + crownH / 2 - 0.3, pz);
              crown.updateMatrixWorld(true);
              this.tintNode(crown, bodyColor, bodyTint * 0.8);
              collect(crown);
            }
            if (drop > 0.7) {
              const plinth = new THREE.Mesh(PLINTH_GEO, PLINTH_MAT);
              const ph = drop + 0.8;
              plinth.scale.set(fw * 0.98, ph, fd * 0.98);
              plinth.rotation.y = yaw;
              plinth.position.set(px, seatY - 0.1 - ph / 2, pz);
              plinth.updateMatrixWorld(true);
              collect(plinth);
            }
            node.position.set(px, bodyBase - 0.15, pz);
            this.tintNode(node, bodyColor, bodyTint);
            collect(node);
            occupy(occBox(px, pz, fw / 2, fd / 2, yaw, parcelRow));
            placedSeg++;
          }
          if (placedSeg === 0) continue; // nothing fit — no solids either
          if (tall) {
            // One podium for the parcel: the continuous wall a tower needs at
            // street level, under whichever shafts fitted above it.
            towers++;
            const podiumH = bhV * 0.22;
            const podium = new THREE.Mesh(PLINTH_GEO, PLINTH_MAT);
            podium.scale.set(lenA * 0.96, podiumH, lenB * 0.96);
            podium.rotation.y = yaw;
            podium.position.set(obbX, seatY + podiumH / 2 - 0.15, obbZ);
            podium.updateMatrixWorld(true);
            this.tintNode(
              podium,
              this.blockColorAt(obbX, obbZ, district),
              Math.min(1, tintAmountFor(district) * TINT_GAIN) * 0.7,
            );
            collect(podium);
          }

          // Collision: rectangles get one OBB; complex outlines get one thin
          // OBB per wall segment (an AABB over an L-shape or a diagonal row
          // would wall off half a street corner).
          const n = rel.length / 2;
          const wallOBB = (x0: number, z0: number, x1: number, z1: number, t: number): void => {
            const len = Math.hypot(x1 - x0, z1 - z0);
            if (len < 2.2) return;
            const ex = (x1 - x0) / len;
            const ez = (z1 - z0) / len;
            const mx = (x0 + x1) / 2;
            const mz = (z0 + z1) / 2;
            this.solids.push({
              minX: mx - len / 2,
              maxX: mx + len / 2,
              minZ: mz - t / 2,
              maxZ: mz + t / 2,
              yaw: Math.atan2(-ez, ex),
            });
          };
          if (n === 4) {
            const ax = cx + (rel[0] ?? 0);
            const az = cz + (rel[1] ?? 0);
            const bx = cx + (rel[2] ?? 0);
            const bz = cz + (rel[3] ?? 0);
            const dxx = cx + (rel[4] ?? 0);
            const dzz = cz + (rel[5] ?? 0);
            const lenA = Math.hypot(bx - ax, bz - az);
            const lenB = Math.hypot(dxx - bx, dzz - bz);
            const ex = (bx - ax) / (lenA || 1);
            const ez = (bz - az) / (lenA || 1);
            this.solids.push({
              minX: cx - (lenA / 2) * 0.96,
              maxX: cx + (lenA / 2) * 0.96,
              minZ: cz - (lenB / 2) * 0.96,
              maxZ: cz + (lenB / 2) * 0.96,
              yaw: Math.atan2(-ez, ex),
            });
          } else {
            for (let i = 0; i < n; i++) {
              const j = (i + 1) % n;
              wallOBB(
                cx + (rel[i * 2] ?? 0),
                cz + (rel[i * 2 + 1] ?? 0),
                cx + (rel[j * 2] ?? 0),
                cz + (rel[j * 2 + 1] ?? 0),
                1.6,
              );
            }
          }
          // Occupancy is claimed per placed SEGMENT above — ring-vertex
          // claims over-blocked the frontage/infill passes around parcels
          // whose corners didn't fit, leaving voids in the blocks.
          placed++;
        }
        console.log(
          `[city] real footprints placed: ${placed} (${roadSkip} on asphalt, ` +
            `${stackSkip} stacked duplicates, ${parkSkip} on park land, ${towers} towers)`,
        );
      }

      // --- FRONTAGE ROWS along the network edges: a LOT-LINE walk down each
      // street (planFabricRow), facing the kerb at one setback per run — rows
      // follow diagonals and curves exactly, which cell-based lots never could.
      // The walk owns every width decision; this loop only rejects lots that
      // stand on something else (a landmark, another building). ---
      const junctions = buildJunctionMap(this.network);
      let walkN = 0;
      let lotsPlanned = 0;
      let lotsBuilt = 0;
      for (const edge of this.network.edges) {
        if (++walkN % 40 === 0) await this.breathe();
        for (const side of [1, -1] as const) {
          const row = ++occRow;
          const lots = planFabricRow(this.network, junctions, edge, side, this.rng);
          lotsPlanned += lots.length;
          for (const lot of lots) {
            if (lm.reserved.has(`${gridXOf(lot.x)},${gridZOf(lot.z)}`)) {
              rejects.reserved++;
              continue;
            }
            const cardinal = Math.abs(Math.sin(2 * lot.yaw)) < 0.18;
            if (placeBuilding(lot, row, cardinal) === null) continue;
            lotsBuilt++;
            // BACK ROWS fill this lot's half of the block behind it. A narrow
            // block's front row already reaches the middle and gets none; a wide
            // one gets a second (rarely third) row with a rear yard between, the
            // way SF blocks actually are. The old walk rolled an unconditional
            // 80% back-row chance at a fixed depth instead, which both missed
            // wide-block interiors and needed the occupancy test loose enough to
            // let party walls through.
            const nx = (lot.x0 + lot.x1) / 2 - lot.x;
            const nz = (lot.z0 + lot.z1) / 2 - lot.z;
            const nl = Math.max(Math.hypot(nx, nz), 0.001);
            let behind = lot.depth / 2; // offset from the lot centre, backwards
            let rear = lot.rear;
            for (let r = 0; r < 2 && rear > BACK_ROW_MIN; r++) {
              const yard = this.rng.range(1.4, 3.0);
              const depth = Math.min(lot.depth, rear - yard);
              if (depth < lot.width * 0.7) break;
              behind += yard + depth / 2;
              rear -= yard + depth;
              const width = lot.width * this.rng.range(0.86, 0.96);
              const bx = lot.x - (nx / nl) * behind;
              const bz = lot.z - (nz / nl) * behind;
              const character = fabricCharAt(bx, bz);
              if (character === null) break;
              // Front face of a back lot: still toward the same street.
              const fx = bx + (nx / nl) * (depth / 2);
              const fz = bz + (nz / nl) * (depth / 2);
              const back: FabricLot = {
                ...lot,
                x: bx,
                z: bz,
                character,
                attached: false,
                width,
                depth,
                rear,
                x0: fx + (nz / nl) * (width / 2),
                z0: fz - (nx / nl) * (width / 2),
                x1: fx - (nz / nl) * (width / 2),
                z1: fz + (nx / nl) * (width / 2),
              };
              // Its own occupancy token: a back row must not be exempted from
              // the front row it stands behind, nor from the lot beside it.
              placeBuilding(back, ++occRow, false);
              behind += depth / 2;
            }
          }
        }
      }
      console.log(
        `[city] frontage lots: ${lotsBuilt} built of ${lotsPlanned} planned ` +
          `(${rejects.occupied} occupied, ${rejects.reserved} reserved, ` +
          `${rejects.cliff} cliff, ${rejects.freeway} freeway), ` +
          `${this.garageFronts} hill garages`,
      );

      // --- Green block interiors: real SF blocks are packed back-to-back, so
      // the row directly behind a frontage gets infill houses (slightly smaller,
      // facing the same street). Deeper cells and parks stay green. ---
      const frontageDirs = new Map<string, Dir>();
      for (const b of this.plan.buildingCells) frontageDirs.set(`${b.gx},${b.gz}`, b.faceDir);
      for (const g of this.plan.greenCells) {
        const cellId = `${g.gx},${g.gz}`;
        if (!lm.reserved.has(cellId) && !lm.parkGreen.has(cellId)) {
          const district = districtAt(g.gx, g.gz);
          if (district.character !== "park") {
            let face: Dir | null = null;
            for (const d of [N, E, S, W] as const) {
              const [dx, dz] = DIR_DELTA[d];
              const f = frontageDirs.get(`${g.gx + dx},${g.gz + dz}`);
              if (f !== undefined) {
                face = f;
                break;
              }
            }
            if (face !== null && this.rng.chance(0.6)) {
              const lot = fitCellLot(g.gx, g.gz, face, this.rng.range(0.6, 0.74));
              if (lot !== null && placeBuilding(lot, ++occRow, false) !== null) continue;
            }
          }
        }
        placeGreen(g.gx, g.gz);
      }
    };
    this.phase3 = async () => {
      // --- Street furniture: lights, parked cars, yards, awnings, smokestacks,
      // construction chicanes, park allées, wharf piers + seawall. ---
      const tFurn = performance.now();
      const fr = await buildFurniture({
        plan: this.plan,
        network: this.network,
        terrain: this.terrain,
        roadDrape: this.roadDrape(),
        groundOffset: this.groundOffset(),
        cache: this.cache,
        rng: this.rng,
        reserved: lm.reserved,
        worldX: (g) => this.worldX(g),
        worldZ: (g) => this.worldZ(g),
      });
      console.log(`[city] furniture ${Math.round(performance.now() - tFurn)}ms`);
      await this.breathe();
      for (const o of fr.objects) collect(o);
      for (const s of fr.solids) this.solids.push(s);
      this.addDecks(fr.pierDecks);
      this.parkedCarSpecs = fr.parkedCars;
      this.lampHeads = fr.lampHeads;

      // --- The drivable Golden Gate: ramp off the Presidio coast road onto an
      // orange deck over the strait, out to a railed vista turnaround. ---
      const gg = buildGoldenGate({
        plan: this.plan,
        terrain: this.terrain,
        cache: this.cache,
        worldX: (g) => this.worldX(g),
        worldZ: (g) => this.worldZ(g),
      });
      for (const o of gg.objects) collect(o);
      for (const s of gg.solids) this.solids.push(s);
      this.addDecks(gg.decks);

      // --- Shoreline: wall off each water cell that borders land, and emit
      // the seawall VISUAL in the same breath — a wall the player can hit
      // must be a wall they can see; pairing them in one loop makes the
      // invisible-shore-wall class unrepresentable. Concrete lip on urban
      // shores, low sand berm on beaches. ---
      const seawallMat = new THREE.MeshStandardMaterial({ color: 0x9aa2a6, roughness: 1 });
      const bermMat = new THREE.MeshStandardMaterial({ color: 0xcbb98d, roughness: 1 });
      const lipGeo = new THREE.BoxGeometry(1, 1, 1);
      for (let gx = 0; gx < GRID_X; gx++) {
        for (let gz = 0; gz < GRID_Z; gz++) {
          if (this.plan.cells[gx]?.[gz] !== "water") continue;
          const waterKey = `${gx},${gz}`;
          if (fr.openWaterCells.has(waterKey)) continue; // pier runs out here
          if (gg.openWaterCells.has(waterKey)) continue; // Golden Gate span
          const wx = this.worldX(gx);
          const wz = this.worldZ(gz);
          let coastal = false;
          for (const d of [N, E, S, W] as const) {
            const [dx, dz] = DIR_DELTA[d];
            const nb = this.plan.cells[gx + dx]?.[gz + dz];
            if (nb !== "road" && nb !== "lot") continue;
            coastal = true;
            const ex = wx + dx * (ROAD_TILE / 2);
            const ez = wz + dz * (ROAD_TILE / 2);
            // OSM sand cells AND natural shore-gradient beaches (ground.ts
            // paints sand where landAt < ~0.45) get the low berm; only truly
            // urban hard shores keep the concrete seawall.
            const beach = landuseSandAt(gx + dx, gz + dz) || this.terrain.landAt(ex, ez) < 0.45;
            const h = beach ? 0.8 : 1.0;
            const th = beach ? 1.6 : 0.6;
            const groundY = this.terrain.heightAt(
              wx + dx * ROAD_TILE * 0.62,
              wz + dz * ROAD_TILE * 0.62,
            );
            const lip = new THREE.Mesh(lipGeo, beach ? bermMat : seawallMat);
            if (dx !== 0) lip.scale.set(th, h, ROAD_TILE);
            else lip.scale.set(ROAD_TILE, h, th);
            lip.position.set(ex, groundY + 0.15, ez);
            lip.updateMatrixWorld(true);
            collect(lip);
          }
          if (!coastal) continue;
          const half = ROAD_TILE * 0.46;
          this.solids.push({ minX: wx - half, maxX: wx + half, minZ: wz - half, maxZ: wz + half });
        }
      }

      // --- Outer border walls (close the south/inland map edge) ---
      const t = 3;
      const LX = WORLD_HALF_X;
      const LZ = WORLD_HALF_Z;
      const edge = { unseen: "map border" } as const;
      this.solids.push({ ...edge, minX: -LX - t, maxX: -LX, minZ: -LZ - t, maxZ: LZ + t }); // west
      this.solids.push({ ...edge, minX: LX, maxX: LX + t, minZ: -LZ - t, maxZ: LZ + t }); // east
      this.solids.push({ ...edge, minX: -LX - t, maxX: LX + t, minZ: -LZ - t, maxZ: -LZ }); // north
      this.solids.push({ ...edge, minX: -LX - t, maxX: LX + t, minZ: LZ, maxZ: LZ + t }); // south

      this.buildGround();

      // --- Hand-placed decorations from the map editor (world/custom-props.ts,
      // this browser's editor props, or a runtime ?map= file) ---
      for (const p of activeMapProps(editorMode())) {
        const parts = p.model.split("/");
        const cat = parts[0];
        const name = parts[1];
        if (!cat || !name) continue;
        const node = this.cache.instance(modelUrl(cat, name));
        node.scale.setScalar(p.s);
        node.rotation.y = p.yaw;
        const x = (p.u - 0.5) * WORLD_W;
        const z = (p.v - 0.5) * WORLD_H;
        node.position.set(x, this.heightAt(x, z), z);
        collect(node);
        if (p.solid) {
          const b = this.cache.bounds(modelUrl(cat, name));
          const hx = (b.size.x * p.s) / 2;
          const hz = (b.size.z * p.s) / 2;
          this.solids.push({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz });
        }
      }

      // --- Two render paths for the static city ---
      // 1) Unique conformed buffers (roads, drapes; userData.merge): merged by
      //    material into spatial CHUNK tiles the streamer shows/hides.
      // 2) Everything else (buildings, trees, props — repeated models): ONE
      //    global BatchedMesh per (material, attribute layout). Geometry is
      //    uploaded once per unique mesh; placements are 64B matrices. Streaming
      //    is per-instance (setVisibleAt on a slow cadence) — per-chunk batches
      //    would re-copy each model's geometry into every chunk that uses it.
      const nx = Math.ceil(WORLD_W / CHUNK);
      const nz = Math.ceil(WORLD_H / CHUNK);
      const mergeBuckets = new Map<number, THREE.Mesh[]>();
      const batchBuckets = new Map<string, BatchBucket>();
      const centroid = new THREE.Vector3();
      for (const mesh of staticMeshes) {
        if (!(mesh.geometry instanceof THREE.BufferGeometry)) continue;
        const mat = mesh.material;
        if (mesh.userData.merge === true || Array.isArray(mat)) {
          mesh.geometry.computeBoundingBox();
          const bb = mesh.geometry.boundingBox;
          const spanX = bb ? bb.max.x - bb.min.x : 0;
          const spanZ = bb ? bb.max.z - bb.min.z : 0;
          if (!Array.isArray(mat) && Math.max(spanX, spanZ) > CHUNK * 1.5) {
            // Whole-map surface (planar-map asphalt/walk/curb): split by chunk
            // so culling and the rest cache both work per-tile.
            mesh.updateMatrixWorld(true);
            const world = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
            for (const [key, g] of splitGeoByChunk(world, nx, nz)) {
              const piece = new THREE.Mesh(g, mat);
              piece.userData.merge = true;
              if (mesh.userData.srcMat) piece.userData.srcMat = mesh.userData.srcMat;
              const list = mergeBuckets.get(key);
              if (list) list.push(piece);
              else mergeBuckets.set(key, [piece]);
            }
            continue;
          }
          bb?.getCenter(centroid);
          centroid.applyMatrix4(mesh.matrixWorld);
          const cx = Math.min(nx - 1, Math.max(0, Math.floor((centroid.x + WORLD_HALF_X) / CHUNK)));
          const cz = Math.min(nz - 1, Math.max(0, Math.floor((centroid.z + WORLD_HALF_Z) / CHUNK)));
          const key = cz * nx + cx;
          const list = mergeBuckets.get(key);
          if (list) list.push(mesh);
          else mergeBuckets.set(key, [mesh]);
          continue;
        }
        // Batches must share an attribute layout — key on material + attrs.
        const geo = mesh.geometry;
        const bKey = `${mat.uuid}|${geoLayoutKey(geo)}`;
        let bucket = batchBuckets.get(bKey);
        if (!bucket) {
          bucket = { material: mat, geoVerts: new Map(), items: [], verts: 0, indices: 0 };
          batchBuckets.set(bKey, bucket);
        }
        if (!bucket.geoVerts.has(geo)) {
          const vCount = geo.attributes.position?.count ?? 0;
          bucket.geoVerts.set(geo, vCount);
          bucket.verts += vCount;
          bucket.indices += geo.index ? geo.index.count : vCount;
        }
        const tint = mesh.userData.tint instanceof THREE.Color ? mesh.userData.tint : undefined;
        const src = mesh.userData.src as { url: string; idx: number } | undefined;
        bucket.items.push({
          geo,
          matrix: mesh.matrixWorld.clone(),
          ...(tint ? { tint } : {}),
          ...(src ? { src } : {}),
        });
      }

      // Chunked merges (roads + drapes). Thin paint (markings, curb lips) is
      // sub-pixel beyond DETAIL_DISTANCE — it culls there instead of the fog line.
      const DETAIL_HEXES = new Set(["dfe3e3", "d8a13c", "d8a23c", "8f938c"]);
      const cullRadius = CHUNK * 0.71 + ROAD_TILE * 2;
      const tMerge = performance.now();
      let mergeN = 0;
      for (const [key, meshes] of mergeBuckets) {
        if (++mergeN % 2 === 0) await this.breathe();
        const cx = key % nx;
        const cz = Math.floor(key / nx);
        const isDetail = (m: THREE.Mesh): boolean => {
          const mat = m.material;
          if (Array.isArray(mat)) return false;
          // Collapsed road paint is a polygon-offset decal — always detail-tier.
          if (mat.polygonOffset) return true;
          return (
            mat instanceof THREE.MeshStandardMaterial && DETAIL_HEXES.has(mat.color.getHexString())
          );
        };
        const main = meshes.filter((m) => !isDetail(m));
        const detail = meshes.filter(isDetail);
        const ccx = (cx + 0.5) * CHUNK - WORLD_HALF_X;
        const ccz = (cz + 0.5) * CHUNK - WORLD_HALF_Z;
        const publishMerged = async (src: readonly THREE.Mesh[], dist: number): Promise<void> => {
          const records: MergedChunkRec[] = [];
          const fallbacks: THREE.Mesh[] = [];
          for (const merged of mergeByMaterial(src)) {
            const rec = this.captureMerged(merged, ccx, ccz, dist);
            if (rec) records.push(rec);
            else fallbacks.push(merged);
          }
          await this.addMergedChunkRecords(records, fallbacks, ccx, ccz, dist, cullRadius);
        };
        if (main.length > 0) await publishMerged(main, DRAW_DISTANCE);
        if (detail.length > 0) await publishMerged(detail, DETAIL_DISTANCE);
      }

      console.log(`[city] merges ${Math.round(performance.now() - tMerge)}ms`);
      await this.buildBatchesFrom(batchBuckets, nx, nz);

      // --- Iconic landmarks (procedural; kept separate — always visible) ---
      this.group.add(buildLandmarks(this.terrain, this.cache, this.network));
      this.group.add(buildFreeways(this.terrain, this.network));
      this.group.add(buildPiers(this.terrain));
      this.lightGoldenGate();

      // City-rest cache capture: phases 2+3 output in serializable form. Only
      // stored when every batch item is source-tagged (else a rebuild would
      // drop geometry silently).
      if (this.restComplete) {
        this.restCapture = {
          mergedChunks: this.capturedMerged,
          rawGeos: this.rawGeos,
          batchItems: [...this.restItems],
          solids: this.solids,
          parkedCars: [...this.parkedCarSpecs],
          lampHeads: [...this.lampHeads],
          decks: this.getDecks(),
        };
        console.log(
          `[city] rest capture: ${this.capturedMerged.length} merged, ${this.restItems.length} items`,
        );
      } else {
        console.log("[city] rest capture skipped: untagged batch items");
      }
    };
  }

  // Terrain ground tiles (worker buffers or live gen) — called by phase 3 on
  // cold builds AND by the city-rest rebuild (the rest cache stores merged
  // city geometry, not the ground).
  private buildGround(): void {
    // --- Displaced terrain ground (hills + island; ocean plane sits below),
    // vertex-graded: concrete in the city, Ocean Beach sand along the west
    // shore (half-strength on other shores), park green under the big parks. ---
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 1,
    });
    applyGrassMottle(groundMat);
    let ground: THREE.Group;
    if (this.genPayload) {
      ground = new THREE.Group();
      for (const t of this.genPayload.tiles) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(t.position, 3));
        if (t.color) geo.setAttribute("color", new THREE.BufferAttribute(t.color, 3));
        if (t.index) geo.setIndex(new THREE.BufferAttribute(t.index, 1));
        if (t.normal) geo.setAttribute("normal", new THREE.BufferAttribute(t.normal, 3));
        else geo.computeVertexNormals(); // baked artifacts ship without normals
        const mesh = new THREE.Mesh(geo, groundMat);
        mesh.position.set(t.x, 0, t.z);
        mesh.rotation.x = -Math.PI / 2;
        mesh.receiveShadow = true;
        mesh.name = "terrain-ground";
        ground.add(mesh);
      }
    } else {
      ground = this.terrain.buildMesh(
        groundMat,
        makeGroundColorAt(this.plan, this.terrain, this.landClassAt),
        this.groundOffset(),
      );
    }
    ground.name = "terrain-ground"; // the map editor raycasts against this
    this.group.add(ground);
    // Ground tiles distance-cull like any chunk (half-diagonal as radius).
    for (const tile of ground.children) {
      this.chunks.push({
        cx: tile.position.x,
        cz: tile.position.z,
        radius: 660,
        dist: DRAW_DISTANCE,
        group: tile,
      });
    }
  }

  // Rebuild phases 2+3 from the city-rest cache: merged chunk meshes from
  // raw buffers, model batches from source-tagged records. Skips ALL
  // placement, furniture and merge compute.
  private async rebuildRest(
    rest: CityRestPayload,
    onProgress?: (f: number) => void,
  ): Promise<void> {
    const nx = Math.ceil(WORLD_W / CHUNK);
    const nz = Math.ceil(WORLD_H / CHUNK);
    const cullRadius = CHUNK * 0.71 + ROAD_TILE * 2;
    const matFor = materialFactory();
    const groups = await buildMergedChunkGroups({
      records: rest.mergedChunks,
      cache: this.cache,
      materialFor: matFor,
      breathe: () => this.breathe(),
      onRecord: (done, total) => {
        if (done % 16 === 0) onProgress?.((done / total) * 0.55);
      },
    });
    for (const g of groups) {
      this.group.add(g.group);
      this.chunks.push({ cx: g.cx, cz: g.cz, radius: cullRadius, dist: g.dist, group: g.group });
    }
    // Model batches from source tags (or the raw-geo table).
    const rawBuilt: { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial }[] = [];
    for (const rg of rest.rawGeos) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(rg.position, 3));
      if (rg.uv) geo.setAttribute("uv", new THREE.BufferAttribute(rg.uv, 2));
      if (rg.index) geo.setIndex(new THREE.BufferAttribute(rg.index, 1));
      if (rg.normal) geo.setAttribute("normal", new THREE.BufferAttribute(rg.normal, 3));
      else geo.computeVertexNormals();
      rawBuilt.push({ geo, mat: matFor(rg.mat) });
    }
    const buckets = new Map<string, BatchBucket>();
    let dropSrc = 0;
    let dropRaw = 0;
    let okN = 0;
    for (const rec of rest.batchItems) {
      let geo: THREE.BufferGeometry;
      let mat: THREE.Material;
      if (rec.url !== null) {
        const srcMesh = this.cache.srcMesh(rec.url, rec.idx);
        if (!srcMesh || Array.isArray(srcMesh.material)) {
          if (dropSrc++ < 3) console.log(`[city] rest drop src: ${rec.url}#${rec.idx}`);
          continue;
        }
        geo = srcMesh.geometry;
        mat = srcMesh.material;
      } else if (rec.raw !== null && rawBuilt[rec.raw]) {
        const rb = rawBuilt[rec.raw];
        if (!rb) continue;
        geo = rb.geo;
        mat = rb.mat;
      } else {
        dropRaw++;
        continue;
      }
      okN++;
      const bKey = `${mat.uuid}|${geoLayoutKey(geo)}`;
      let bucket = buckets.get(bKey);
      if (!bucket) {
        bucket = { material: mat, geoVerts: new Map(), items: [], verts: 0, indices: 0 };
        buckets.set(bKey, bucket);
      }
      if (!bucket.geoVerts.has(geo)) {
        const vCount = geo.attributes.position?.count ?? 0;
        bucket.geoVerts.set(geo, vCount);
        bucket.verts += vCount;
        bucket.indices += geo.index ? geo.index.count : vCount;
      }
      bucket.items.push({
        geo,
        matrix: new THREE.Matrix4().fromArray(rec.m),
        ...(rec.tint !== null ? { tint: new THREE.Color(rec.tint) } : {}),
        ...(rec.url !== null ? { src: { url: rec.url, idx: rec.idx } } : {}),
      });
    }
    console.log(`[city] rest items ok ${okN} dropSrc ${dropSrc} dropRaw ${dropRaw}`);
    await this.buildBatchesFrom(buckets, nx, nz, (f) => onProgress?.(0.55 + f * 0.4));
    // Game data.
    this.solids.length = 0;
    for (const so of rest.solids) this.solids.push(so);
    this.parkedCarSpecs = rest.parkedCars;
    this.lampHeads = rest.lampHeads;
    this.addDecks(rest.decks);
    this.buildGround();
    // Landmarks are procedural + cheap — always rebuilt live.
    this.group.add(buildLandmarks(this.terrain, this.cache, this.network));
    this.group.add(buildFreeways(this.terrain, this.network));
    this.group.add(buildPiers(this.terrain));
    this.lightGoldenGate();
  }

  // The Golden Gate's MESHES are baked (buildGoldenGate runs on cold gen only,
  // its output lands in rest.bin), but beacons are a runtime registry — so the
  // bridge would be dark on every load that hits the bins, i.e. all of them.
  // Re-solving the placement is a grid scan plus arithmetic; both paths call it.
  private lightGoldenGate(): void {
    const gg = goldenGatePlan({
      plan: this.plan,
      terrain: this.terrain,
      worldX: (g) => this.worldX(g),
      worldZ: (g) => this.worldZ(g),
    });
    if (gg) registerBeacons("golden-gate", goldenGateBeacons(gg));
  }

  // Build BatchedMeshes (+ box imposters + chunk instance maps) from filled
  // buckets — called by phase 3 (from staticMeshes) AND the city-rest cache
  // rebuild (from serialized records).
  private async buildBatchesFrom(
    batchBuckets: Map<string, BatchBucket>,
    nx: number,
    nz: number,
    onProgress?: (f: number) => void,
  ): Promise<void> {
    // Global batches (models). Each instance is assigned to a spatial chunk;
    // updateStreaming() flips whole chunks of instances on visibility
    // transitions, so per-frame cost is ~chunk count, not instance count.
    const pos = new THREE.Vector3();
    const tBatch = performance.now();
    type ImposterSpec = {
      key: number;
      mid: boolean; // mid tier = ordinary building, drops out one ring sooner
      mat: THREE.Material;
      item: { geo: THREE.BufferGeometry; matrix: THREE.Matrix4; tint?: THREE.Color };
    };
    const imposters: ImposterSpec[] = [];
    const restItems = this.restItems;
    restItems.length = 0;
    const untagged = new Map<string, number>();
    let batchN = 0;
    for (const bucket of batchBuckets.values()) {
      await this.breathe();
      onProgress?.(batchN / batchBuckets.size);
      batchN++;
      const batched = new THREE.BatchedMesh(
        bucket.items.length,
        bucket.verts,
        bucket.indices,
        bucket.material,
      );
      batched.castShadow = true;
      batched.receiveShadow = true;
      // Chunk streaming (below) is the coarse cull, but per-instance frustum
      // culling stays ON: BatchedMesh rebuilds its multidraw list per PASS
      // against that pass's camera (onBeforeShadow feeds the shadow camera),
      // so the ~116u sun-shadow pass draws only instances inside its frustum
      // instead of re-submitting the whole visible city every frame. (A
      // flip-only-during-shadow scheme breaks in r184: onBeforeRender
      // early-returns when culling is off and nothing changed, so the main
      // pass would reuse the shadow-culled list.)
      batched.perObjectFrustumCulled = true;
      batched.sortObjects = false;
      const geoIds = new Map<THREE.BufferGeometry, number>();
      const chunkIds = new Uint16Array(bucket.items.length);
      // no-op marker retained for rebuild parity
      for (let i = 0; i < bucket.items.length; i++) {
        // Buckets can hold thousands of instances — yield inside the loop too
        // (safe: the chunk grid publishes only at the very end, see below).
        if (i % 512 === 0) await this.breathe();
        const item = bucket.items[i];
        if (!item) continue;
        let gid = geoIds.get(item.geo);
        if (gid === undefined) {
          gid = batched.addGeometry(item.geo);
          geoIds.set(item.geo, gid);
        }
        const iid = batched.addInstance(gid);
        batched.setMatrixAt(iid, item.matrix);
        if (item.src) {
          restItems.push({
            url: item.src.url,
            idx: item.src.idx,
            raw: null,
            m: new Float32Array(item.matrix.elements),
            tint: item.tint ? item.tint.getHex() : null,
            big: false,
          });
        } else {
          const mat = bucket.material;
          if (mat instanceof THREE.MeshStandardMaterial && !mat.map) {
            // Shared generated geometry (plinths, seawall, lake…): serialize
            // once into the raw-geo table, reference by index.
            let rawId = this.rawGeoIds.get(item.geo.uuid);
            if (rawId === undefined) {
              const pos2 = item.geo.getAttribute("position");
              const nor2 = item.geo.getAttribute("normal");
              const uv2 = item.geo.getAttribute("uv");
              rawId = this.rawGeos.length;
              this.rawGeoIds.set(item.geo.uuid, rawId);
              this.rawGeos.push({
                position: pos2.array as Float32Array,
                normal: nor2 ? (nor2.array as Float32Array) : null,
                uv: uv2 ? (uv2.array as Float32Array) : null,
                index: item.geo.index ? (item.geo.index.array as Uint16Array | Uint32Array) : null,
                mat: {
                  color: mat.color.getHex(),
                  roughness: mat.roughness,
                  metalness: mat.metalness,
                  vertexColors: mat.vertexColors,
                  polygonOffset: mat.polygonOffset,
                  polygonOffsetFactor: mat.polygonOffsetFactor,
                  polygonOffsetUnits: mat.polygonOffsetUnits,
                  transparent: mat.transparent,
                  opacity: mat.opacity,
                },
              });
            }
            restItems.push({
              url: null,
              idx: 0,
              raw: rawId,
              m: new Float32Array(item.matrix.elements),
              tint: item.tint ? item.tint.getHex() : null,
              big: false,
            });
          } else {
            this.restComplete = false;
            const tag =
              mat instanceof THREE.MeshStandardMaterial
                ? `${mat.name || "?"}#${mat.color.getHexString()}`
                : mat.type;
            untagged.set(tag, (untagged.get(tag) ?? 0) + 1);
          }
        }
        if (item.tint) batched.setColorAt(iid, item.tint);
        pos.setFromMatrixPosition(item.matrix);
        const ccx = Math.min(nx - 1, Math.max(0, Math.floor((pos.x + WORLD_HALF_X) / CHUNK)));
        const ccz = Math.min(nz - 1, Math.max(0, Math.floor((pos.z + WORLD_HALF_Z) / CHUNK)));
        chunkIds[iid] = ccz * nx + ccx;
      }
      batched.computeBoundingSphere();
      this.group.add(batched);
      const bIndex = this.batches.length;
      this.batches.push({ mesh: batched, chunkIds });
      let anyBig = false;
      for (let iid = 0; iid < chunkIds.length; iid++) {
        const key = chunkIds[iid] ?? 0;
        const item = bucket.items[iid];
        let worldH = 3;
        if (item) {
          if (!item.geo.boundingBox) item.geo.computeBoundingBox();
          const sc = SCRATCH_SCALE.setFromMatrixScale(item.matrix);
          const bb = item.geo.boundingBox;
          worldH = bb ? (bb.max.y - bb.min.y) * sc.y : 3;
        }
        // Skyline = TALL: only buildings that read above the fog at distance
        // keep the far tier; row-houses and low-rises cull with the detail set.
        const big = worldH >= BIG_SILHOUETTE_H;
        if (big) anyBig = true;
        // …and the fabric UNDER the skyline: an ordinary building, tall enough
        // to still be a few pixels out there, gets the shorter-range mid tier.
        const mid =
          !big &&
          worldH >= MID_SILHOUETTE_H &&
          (item?.src?.url.startsWith(BUILDINGS_PREFIX) ?? false);
        // LOD: tall buildings render the FULL model only within
        // DETAIL_DISTANCE; beyond that a tinted box imposter carries the
        // skyline to the fog line (fog hides the swap).
        const map = this.chunkInstancesNear;
        const list = map.get(key);
        if (list) list.push([bIndex, iid]);
        else map.set(key, [[bIndex, iid]]);
        if ((big || mid) && item) {
          imposters.push({ key, mid, mat: bucket.material, item });
        }
      }
      // Small-prop shadows don't read at chase-cam scale; skip their pass.
      if (!anyBig) batched.castShadow = false;
    }
    if (imposters.length > 0) {
      const boxGeo = new THREE.BoxGeometry(1, 1, 1);
      boxGeo.translate(0, 0.5, 0); // origin at the base, like buildings
      const boxMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
      const imp = new THREE.BatchedMesh(imposters.length, 24, 36, boxMat);
      imp.castShadow = false;
      imp.frustumCulled = false;
      // Both OFF, unlike the model batches: the imposter tier is already
      // frustum-culled per CHUNK by updateStreaming (visImp requires the chunk
      // sphere to be in view) and opaque boxes gain nothing from a depth sort.
      // With neither on, BatchedMesh.onBeforeRender early-returns unless a
      // chunk actually flipped — so the mid tier's ~20k instances cost one
      // list rebuild per transition instead of a per-frame sphere test each.
      imp.perObjectFrustumCulled = false;
      imp.sortObjects = false;
      const gid = imp.addGeometry(boxGeo);
      const m4 = new THREE.Matrix4();
      const box = new THREE.Box3();
      const sizeV = new THREE.Vector3();
      const ctrV = new THREE.Vector3();
      let impN = 0;
      for (const { key, mid, mat, item } of imposters) {
        if (impN++ % 1024 === 0) await this.breathe();
        if (!item.geo.boundingBox) item.geo.computeBoundingBox();
        if (!item.geo.boundingBox) continue;
        box.copy(item.geo.boundingBox);
        box.getSize(sizeV);
        box.getCenter(ctrV);
        // unit box (base-origin) -> local bbox -> world
        m4.makeScale(Math.max(sizeV.x, 0.1), Math.max(sizeV.y, 0.1), Math.max(sizeV.z, 0.1));
        m4.setPosition(ctrV.x, box.min.y, ctrV.z);
        m4.premultiply(item.matrix);
        const iid = imp.addInstance(gid);
        imp.setMatrixAt(iid, m4);
        imp.setColorAt(iid, imposterColorInto(IMPOSTER_COLOR, item.geo, mat, item.tint));
        imp.setVisibleAt(iid, false);
        const tier = mid ? this.imposterMidInstances : this.imposterInstances;
        const list = tier.get(key);
        if (list) list.push(iid);
        else tier.set(key, [iid]);
      }
      imp.computeBoundingSphere();
      this.group.add(imp);
      this.imposterMesh = imp;
      let midN = 0;
      for (const spec of imposters) if (spec.mid) midN++;
      console.log(`[city] imposters ${imposters.length} (mid ${midN})`);
    }
    if (untagged.size > 0) {
      console.log("[city] untagged batch items:", JSON.stringify([...untagged.entries()]));
    }
    // Publish the chunk grid ONLY now, after chunkInstancesNear is fully mapped.
    // Both callers reach here (cold gen AND the baked-rest rebuild); the rebuild
    // path used to skip this, leaving the grid at 1×1 so updateStreaming culled
    // only chunk 0 and the whole map's props drew every frame. It must be the
    // LAST step because buildBatchesFrom yields (await breathe) mid-loop: if the
    // grid went live earlier, an updateStreaming during a yield would mark far
    // chunks hidden in the array before their instances were mapped, skip the
    // setVisibleAt, and never re-fire — stranding those props visible forever.
    // Nulling the arrays forces a clean re-alloc + full cull on the next pass.
    this.batchChunkGrid = { nx, nz };
    this.chunkVisible = null;
    this.chunkVisibleNear = null;
    console.log(`[city] batches ${Math.round(performance.now() - tBatch)}ms`);
  }

  // The city never moves after build: compose every matrix once, then stop
  // the per-frame recompose (updateMatrixWorld still walks the subtree, but
  // each visit is two boolean checks instead of a position/quat/scale
  // compose). Chunk streaming only flips `visible`, and BatchedMesh instance
  // matrices live in a texture — neither needs object matrices. Skipped in
  // editor mode, where props get dragged around live.
  freezeStatic(): void {
    this.group.updateMatrixWorld(true); // compose every local+world matrix once
    this.group.traverse((o) => {
      o.matrixAutoUpdate = false;
    });
  }

  // Chunked visibility: merged road/drape tiles show/hide as whole groups
  // (three frustum-culls them per mesh); batched model instances flip by chunk
  // — distance AND view frustum, near chunks always on so shadow casters just
  // off-screen keep their shadows. Flips apply only on TRANSITIONS, so the
  // steady-state per-frame cost is one sphere test per chunk.
  updateStreaming(camera: THREE.Camera, showAll = false): void {
    const camX = camera.position.x;
    const camZ = camera.position.z;
    for (const c of this.chunks) {
      const d = Math.hypot(camX - c.cx, camZ - c.cz) - c.radius;
      const visible = showAll || d < c.dist;
      if (c.group.visible !== visible) c.group.visible = visible;
    }
    const { nx, nz } = this.batchChunkGrid;
    const total = nx * nz;
    if (!this.chunkVisible) this.chunkVisible = new Uint8Array(total).fill(1);
    if (!this.chunkVisibleNear) this.chunkVisibleNear = new Uint8Array(total).fill(1);
    STREAM_MAT.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    STREAM_FRUSTUM.setFromProjectionMatrix(STREAM_MAT);
    const pad = CHUNK * 0.71 + ROAD_TILE * 2;
    for (let key = 0; key < total; key++) {
      const cx = ((key % nx) + 0.5) * CHUNK - WORLD_HALF_X;
      const cz = (Math.floor(key / nx) + 0.5) * CHUNK - WORLD_HALF_Z;
      const dist = Math.hypot(camX - cx, camZ - cz);
      let inFrustum = false;
      if (dist - pad < DRAW_DISTANCE) {
        STREAM_SPHERE.center.set(cx, 14, cz);
        STREAM_SPHERE.radius = pad + 30; // tall roofs/trees overhang the tile
        inFrustum = STREAM_FRUSTUM.intersectsSphere(STREAM_SPHERE);
      }
      const near = dist < NEAR_ALWAYS;
      const visFar: 0 | 1 = showAll || near || (inFrustum && dist - pad < DRAW_DISTANCE) ? 1 : 0;
      const visNear: 0 | 1 = showAll || near || (inFrustum && dist - pad < DETAIL_DISTANCE) ? 1 : 0;
      // visFar has no instance list of its own (every batch instance lives in
      // the near tier; the far band renders imposters only) — it's tracked
      // purely to drive the imposter flips below.
      if (this.chunkVisible[key] !== visFar) this.chunkVisible[key] = visFar;
      if (this.chunkVisibleNear[key] !== visNear) {
        this.chunkVisibleNear[key] = visNear;
        const list = this.chunkInstancesNear.get(key);
        if (list)
          for (const [b, iid] of list) this.batches[b]?.mesh.setVisibleAt(iid, visNear === 1);
      }
      // Imposters live in the far band only: full models take over up close.
      if (this.imposterMesh) {
        if (!this.imposterVisible) this.imposterVisible = new Uint8Array(total).fill(0);
        if (!this.imposterMidVisible) this.imposterMidVisible = new Uint8Array(total).fill(0);
        const visImp: 0 | 1 = visFar === 1 && visNear === 0 ? 1 : 0;
        if (this.imposterVisible[key] !== visImp) {
          this.imposterVisible[key] = visImp;
          const list = this.imposterInstances.get(key);
          if (list) for (const iid of list) this.imposterMesh.setVisibleAt(iid, visImp === 1);
        }
        const visMid: 0 | 1 = visImp === 1 && dist - pad < MID_IMPOSTER_DISTANCE ? 1 : 0;
        if (this.imposterMidVisible[key] !== visMid) {
          this.imposterMidVisible[key] = visMid;
          const list = this.imposterMidInstances.get(key);
          if (list) for (const iid of list) this.imposterMesh.setVisibleAt(iid, visMid === 1);
        }
      }
    }
  }

  // Is the world position over a road cell (vs a building lot)?
  isOnRoad(x: number, z: number): boolean {
    const gx = this.gridX(x);
    const gz = this.gridZ(z);
    if (gx < 0 || gz < 0 || gx >= GRID_X || gz >= GRID_Z) return false;
    return this.plan.cells[gx]?.[gz] === "road";
  }

  // What the wheels are running on — drives the off-road kick-up FX. ONE rule
  // with the ground paint (world/land-class.ts): this used to be a second,
  // drifting copy of the grading, which is how the tyres came to report
  // concrete on Ocean Beach.
  surfaceKindAt(x: number, z: number): WheelSurface {
    return wheelSurface(this.landClassAt(x, z));
  }

  // --- Drive surface (world/surface.ts): decks + park terraces + depressed
  // ground. Lazily constructed — plan/terrain exist from the constructor, and
  // the network getter tracks live street-edit swaps. City keeps thin
  // delegates because every consumer (car, traffic, fares, camera, editor)
  // already talks to city.heightAt.
  private surfaceImpl: DriveSurface | null = null;
  private get surface(): DriveSurface {
    this.surfaceImpl ??= new DriveSurface(this.terrain, this.plan, () => this.network);
    return this.surfaceImpl;
  }

  addDecks(decks: readonly SurfaceDeck[]): void {
    this.surface.addDecks(decks);
  }

  getDecks(): readonly SurfaceDeck[] {
    return this.surface.getDecks();
  }

  heightAt(x: number, z: number): number {
    return this.surface.heightAt(x, z);
  }

  normalInto(out: THREE.Vector3, x: number, z: number): THREE.Vector3 {
    return this.surface.normalInto(out, x, z);
  }
}

// Bake world transforms and merge geometries that share a material, producing a
// handful of static meshes instead of hundreds of draw calls.
// Split a world-space geometry into per-chunk geometries (triangles bucketed
// by centroid, vertices remapped). Whole-map surfaces (the planar-map asphalt
// is ONE geometry) would otherwise defeat chunk culling AND the rest cache.
function splitGeoByChunk(
  geo: THREE.BufferGeometry,
  nx: number,
  nz: number,
): Map<number, THREE.BufferGeometry> {
  const pos = geo.getAttribute("position");
  const nor = geo.getAttribute("normal");
  const uv = geo.getAttribute("uv");
  const col = geo.getAttribute("color");
  const idx = geo.index;
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const vid = (k: number): number => (idx ? idx.getX(k) : k);
  type Piece = {
    map: Map<number, number>;
    pos: number[];
    nor: number[];
    uv: number[];
    col: number[];
    index: number[];
  };
  const pieces = new Map<number, Piece>();
  for (let t = 0; t < triCount; t++) {
    const a = vid(t * 3);
    const b = vid(t * 3 + 1);
    const c = vid(t * 3 + 2);
    const mx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const mz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const cx = Math.min(nx - 1, Math.max(0, Math.floor((mx + WORLD_HALF_X) / CHUNK)));
    const cz = Math.min(nz - 1, Math.max(0, Math.floor((mz + WORLD_HALF_Z) / CHUNK)));
    const key = cz * nx + cx;
    let piece = pieces.get(key);
    if (!piece) {
      piece = { map: new Map(), pos: [], nor: [], uv: [], col: [], index: [] };
      pieces.set(key, piece);
    }
    for (const v of [a, b, c]) {
      let nid = piece.map.get(v);
      if (nid === undefined) {
        nid = piece.pos.length / 3;
        piece.map.set(v, nid);
        piece.pos.push(pos.getX(v), pos.getY(v), pos.getZ(v));
        if (nor) piece.nor.push(nor.getX(v), nor.getY(v), nor.getZ(v));
        if (uv) piece.uv.push(uv.getX(v), uv.getY(v));
        if (col) piece.col.push(col.getX(v), col.getY(v), col.getZ(v));
      }
      piece.index.push(nid);
    }
  }
  const out = new Map<number, THREE.BufferGeometry>();
  for (const [key, piece] of pieces) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(piece.pos), 3));
    if (nor) g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(piece.nor), 3));
    if (uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(piece.uv), 2));
    if (col) g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(piece.col), 3));
    const IndexArr = piece.pos.length / 3 > 65535 ? Uint32Array : Uint16Array;
    g.setIndex(new THREE.BufferAttribute(new IndexArr(piece.index), 1));
    out.set(key, g);
  }
  return out;
}

function mergeByMaterial(meshes: readonly THREE.Mesh[]): THREE.Mesh[] {
  type Group = { material: THREE.Material; attrs: string; geometries: THREE.BufferGeometry[] };
  const groups = new Map<string, Group>();

  for (const mesh of meshes) {
    const mat = mesh.material;
    if (Array.isArray(mat)) continue; // multi-material meshes left un-merged (rare here)
    const geo = mesh.geometry;
    if (!(geo instanceof THREE.BufferGeometry)) continue;
    // Keep indices: conformed geometry is welded/indexed (~3x smaller) and
    // mergeGeometries handles all-indexed groups fine — the group key
    // includes indexedness so mixed sets never land in one merge call.
    const baked = geo.clone();
    toFloat32Attributes(baked); // dequantize meshopt attrs BEFORE baking world coords
    baked.applyMatrix4(mesh.matrixWorld);
    // Normalize attributes so merge never fails on a mismatched set.
    const wanted = new Set(["position", "normal", "uv", "color"]);
    for (const name of Object.keys(baked.attributes)) {
      if (!wanted.has(name)) baked.deleteAttribute(name);
    }
    if (!baked.getAttribute("uv") && baked.getAttribute("position")) {
      const count = baked.getAttribute("position").count;
      baked.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    // Deterministic signature in a fixed order (avoids a mutating sort).
    const attrs = ["position", "normal", "uv", "color"]
      .filter((n) => baked.getAttribute(n))
      .join(",");
    const key = `${mat.uuid}|${attrs}|${baked.index ? "i" : "n"}`;
    const g = groups.get(key);
    if (g) g.geometries.push(baked);
    else groups.set(key, { material: mat, attrs, geometries: [baked] });
  }

  const out: THREE.Mesh[] = [];
  for (const g of groups.values()) {
    const merged = mergeGeometries(g.geometries, false);
    if (!merged) {
      for (const geo of g.geometries) {
        const m = new THREE.Mesh(geo, g.material);
        m.castShadow = true;
        m.receiveShadow = true;
        out.push(m);
      }
      continue;
    }
    const mesh = new THREE.Mesh(merged, g.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}
