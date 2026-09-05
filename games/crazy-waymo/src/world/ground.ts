import * as THREE from "three";

import { GRID_X, GRID_Z, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import { DRAPE_MAX_ERROR, type DrapeField } from "./conform";
import { CUSTOM_MAP, type FloorKind, loadLocalOverrides } from "./custom-map";
import type { CityPlan } from "./grid";
import {
  dominantCover,
  type GroundCover,
  type LandClass,
  type LandClassAt,
  makeLandClassAt,
} from "./land-class";
import type { RoadNetwork } from "./network";
import { SIDEWALK_W, walkFor } from "./roads";
import type { GroundCeiling, Terrain } from "./terrain";

// Ground shading + street-depression callbacks, extracted so the gen worker
// and the main thread run EXACTLY the same code (a fork here would paint two
// different cities). WHAT the ground is lives in land-class.ts — this file only
// decides what each ground class LOOKS like.

// The Mediterranean palette. San Francisco's built ground is warm grey concrete
// and its wild hills are STRAW eight months a year — the kart-greens this table
// replaced (PARK 0x5fb163, MEADOW 0x86c46a, FOREST 0x4c9b57) turned half the
// peninsula into a golf course. Greens here are muted and olive-leaning: park
// turf is irrigated and darker than grass reads in a cartoon, canopy is nearly
// black-green, and anything unirrigated goes gold.
//
// GROUND IS THE BOTTOM BAND (value pass 2026-07-26). The target is ground <
// buildings < sky, and every hard cover here used to break it: `plaza` sat at
// luminance 0.72 and `sand` at 0.82, against a pastel building fabric averaging
// ~0.6. Ground is also the LARGEST area in almost every frame, so when it is
// also the brightest thing after the sky, silhouettes die against it and the
// aerials read as one flat sheet. Measured from Pacific Heights at noon: kerb
// aprons L133, building walls L108, road L105 — the walls and the road were
// three luma apart and the aprons were second only to the sky.
//
// Hard covers therefore came down ~18% in value (the greens moved much less —
// they were already the darkest band and are what the districts read by). This
// changes VERTEX OUTPUT: it is baked, and needs a WORLD_REV bump plus
// `pnpm bake:world`.
const COVER_COLOR = {
  pavement: new THREE.Color(0x8b887c),
  yard: new THREE.Color(0x86816f),
  rearYard: new THREE.Color(0x757161),
  plaza: new THREE.Color(0x9b968a),
  parking: new THREE.Color(0x77756f),
  court: new THREE.Color(0x6e6d68),
  industrial: new THREE.Color(0x8a806a),
  railyard: new THREE.Color(0x736c62),
  quay: new THREE.Color(0x938e82),
  path: new THREE.Color(0xa2916f),
  lawn: new THREE.Color(0x718d4b),
  meadow: new THREE.Color(0x8a9556),
  grove: new THREE.Color(0x586c43),
  conifer: new THREE.Color(0x3f513a),
  woodland: new THREE.Color(0x52663f),
  grassland: new THREE.Color(0xb0a26a),
  cemetery: new THREE.Color(0x849060),
  rock: new THREE.Color(0x847b70),
  sand: new THREE.Color(0xc7b78e),
  dune: new THREE.Color(0xb5a87b),
  water: new THREE.Color(0x2f4d5c),
} satisfies Readonly<Record<GroundCover, THREE.Color>>;

const WET_SAND = new THREE.Color(0xa9946b); // darker band right at the waterline
const TURF_SUN = new THREE.Color(0x9caa66); // sunlit two-tone partner for turf
const STRAW_PALE = new THREE.Color(0xc2b586); // bleached crest of a dry flank
const STRAW_DAMP = new THREE.Color(0x94955e); // the gullies that stay green

// Editor "Floor" paint. Hand-painted cells win outright — no shore, no flank,
// no patches — so what the editor shows is what ships.
const PAINTED_FLOOR = {
  plaza: COVER_COLOR.plaza,
  grass: COVER_COLOR.lawn,
  sand: COVER_COLOR.sand,
} satisfies Readonly<Record<FloorKind, THREE.Color>>;

// How a cover varies across a patch: irrigated turf drifts toward sunlit
// yellow-green, dry ground between bleached crest and damp gully.
function patchTreatment(cover: GroundCover): "turf" | "dry" | "none" {
  switch (cover) {
    case "lawn":
    case "meadow":
    case "grove":
    case "conifer":
    case "woodland":
    case "cemetery":
      return "turf";
    case "grassland":
    case "dune":
      return "dry";
    default:
      return "none";
  }
}

// Low-frequency organic patches (~40–90u) so ground reads as rolling two-tone
// cover instead of one flat fill — the Mario Kart grass trick.
function meadowPatch(x: number, z: number): number {
  const a = Math.sin(x * 0.043 + Math.sin(z * 0.051) * 1.9);
  const b = Math.sin(z * 0.037 + Math.sin(x * 0.029) * 1.6);
  return 0.5 + 0.5 * a * b;
}

const gridX = (x: number): number => Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
const gridZ = (z: number): number => Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);

/** One floor-override lookup for both baked color and runtime material weights. */
export function makePaintedFloorAt(): (x: number, z: number) => FloorKind | undefined {
  const floorAt = new Map<string, FloorKind>();
  const local = loadLocalOverrides();
  for (const [gx, gz, kind] of [...CUSTOM_MAP.floor, ...local.floor]) {
    floorAt.set(`${gx},${gz}`, kind);
  }
  return (x, z) => {
    const gx = Math.min(GRID_X - 1, Math.max(0, gridX(x)));
    const gz = Math.min(GRID_Z - 1, Math.max(0, gridZ(z)));
    return floorAt.get(`${gx},${gz}`);
  };
}

/** Non-color material weights. The unused remainder is paved ground. */
export type GroundBlend = { turf: number; sand: number; stone: number; loose: number };
export type GroundBlendAt = (x: number, z: number, into: GroundBlend) => void;
const TURF_BLEND: Readonly<GroundBlend> = { turf: 1, sand: 0, stone: 0, loose: 0 };
const SAND_BLEND: Readonly<GroundBlend> = { turf: 0, sand: 1, stone: 0, loose: 0 };
const PAVED_BLEND: Readonly<GroundBlend> = { turf: 0, sand: 0, stone: 0, loose: 0 };
const GRAVEL_BLEND: Readonly<GroundBlend> = { turf: 0, sand: 0, stone: 0.7, loose: 0.3 };

const COVER_BLEND = {
  pavement: PAVED_BLEND,
  yard: PAVED_BLEND,
  rearYard: PAVED_BLEND,
  plaza: PAVED_BLEND,
  parking: PAVED_BLEND,
  court: PAVED_BLEND,
  industrial: { turf: 0, sand: 0, stone: 0, loose: 1 },
  railyard: GRAVEL_BLEND,
  quay: PAVED_BLEND,
  path: GRAVEL_BLEND,
  lawn: TURF_BLEND,
  meadow: TURF_BLEND,
  grove: TURF_BLEND,
  conifer: TURF_BLEND,
  woodland: TURF_BLEND,
  grassland: TURF_BLEND,
  cemetery: TURF_BLEND,
  rock: { turf: 0, sand: 0, stone: 1, loose: 0 },
  sand: SAND_BLEND,
  dune: { turf: 0.15, sand: 0.85, stone: 0, loose: 0 },
  water: PAVED_BLEND,
} satisfies Readonly<Record<GroundCover, Readonly<GroundBlend>>>;

const FLOOR_BLEND = {
  plaza: PAVED_BLEND,
  grass: TURF_BLEND,
  sand: SAND_BLEND,
} satisfies Readonly<Record<FloorKind, Readonly<GroundBlend>>>;

/** Match the painter's cover/under transition, independently of its palette. */
export function groundBlendInto(land: LandClass, into: GroundBlend): void {
  const under = COVER_BLEND[land.under];
  const cover = COVER_BLEND[land.cover];
  const weight = land.strength;
  into.turf = under.turf + (cover.turf - under.turf) * weight;
  into.sand = under.sand + (cover.sand - under.sand) * weight;
  into.stone = under.stone + (cover.stone - under.stone) * weight;
  into.loose = under.loose + (cover.loose - under.loose) * weight;
}

export function makeGroundBlendAt(
  landClassAt: LandClassAt,
  paintedFloorAt: (x: number, z: number) => FloorKind | undefined = makePaintedFloorAt(),
): GroundBlendAt {
  return (x, z, into) => {
    const painted = paintedFloorAt(x, z);
    if (painted === undefined) {
      groundBlendInto(landClassAt(x, z), into);
      return;
    }
    const blend = FLOOR_BLEND[painted];
    into.turf = blend.turf;
    into.sand = blend.sand;
    into.stone = blend.stone;
    into.loose = blend.loose;
  };
}

/**
 * The ground painter. `landClassAt` defaults to a resolver built for this world;
 * a caller that already has one (city.ts's wheel FX needs the same rule) can
 * pass it in so the ~600 KB of fabric/wildness fields are built once.
 */
export function makeGroundColorAt(
  plan: CityPlan,
  terrain: Terrain,
  landClassAt: LandClassAt = makeLandClassAt(plan, terrain),
): (x: number, z: number, into: THREE.Color) => void {
  const paintedFloorAt = makePaintedFloorAt();
  return (x, z, into) => {
    const painted = paintedFloorAt(x, z);
    if (painted !== undefined) {
      into.copy(PAINTED_FLOOR[painted]);
      return;
    }
    const land = landClassAt(x, z);
    // `cover` fades into `under` so soft terms — a hill flank thinning out at
    // the tree line, a beach apron running inland — feather into the ground
    // they sit on instead of ending on a line.
    into.copy(COVER_COLOR[land.under]);
    if (land.cover !== land.under) into.lerp(COVER_COLOR[land.cover], land.strength);
    // The darker wet-sand band right at the waterline: the Mario Kart shore
    // read, and the water shader laps its foam against exactly this band.
    if (land.shore.kind === "beach" && land.shore.wet > 0) {
      into.lerp(WET_SAND, land.shore.wet * 0.7);
    }
    const patch = meadowPatch(x, z);
    switch (patchTreatment(dominantCover(land))) {
      case "turf":
        into.lerp(TURF_SUN, patch * 0.32);
        break;
      case "dry":
        // Straw is never uniform: bleached where the sun sits on the crest,
        // still green down the gullies. This is the read that makes a golden
        // hill look like a hill and not a flat gold decal.
        into.lerp(STRAW_PALE, patch * 0.34);
        into.lerp(STRAW_DAMP, (1 - patch) * 0.26);
        break;
      case "none":
        break;
    }
  };
}

// Park cells are TILE territory: the ground flattens each park cell to one
// terraced height (sampled at the cell centre) so KayKit park tiles seat on it
// exactly — the "grid for tiles, curves for roads" rule. That question is
// `isParkLand` in land-class.ts (park land of ANY kind, the Presidio included,
// as opposed to park-clear's car-free `parkCell`), and this module no longer
// keeps a second copy of it: `parkCellHeight` below is the only park-specific
// thing the ground itself owns.

export function parkCellHeight(terrain: Terrain, gx: number, gz: number): number {
  // Seat at the HIGHEST corner. No quantization: tiles only go on flat
  // cells now, where neighbours land within centimetres of each other —
  // no visible layering. Sunk 0.3 below the high corner: seated fully proud,
  // every park edge read as a cliff off the sidewalk; the tile's thick base
  // absorbs the embed on the high side.
  const x0 = gx * ROAD_TILE - WORLD_HALF_X;
  const z0 = gz * ROAD_TILE - WORLD_HALF_Z;
  const h = Math.max(
    terrain.heightAt(x0, z0),
    terrain.heightAt(x0 + ROAD_TILE, z0),
    terrain.heightAt(x0, z0 + ROAD_TILE),
    terrain.heightAt(x0 + ROAD_TILE, z0 + ROAD_TILE),
    terrain.heightAt(x0 + ROAD_TILE / 2, z0 + ROAD_TILE / 2),
  );
  return h - 0.25;
}

export function parkCellFloor(terrain: Terrain, gx: number, gz: number): number {
  const x0 = gx * ROAD_TILE - WORLD_HALF_X;
  const z0 = gz * ROAD_TILE - WORLD_HALF_Z;
  return Math.min(
    terrain.heightAt(x0, z0),
    terrain.heightAt(x0 + ROAD_TILE, z0),
    terrain.heightAt(x0, z0 + ROAD_TILE),
    terrain.heightAt(x0 + ROAD_TILE, z0 + ROAD_TILE),
  );
}

// --- SF step-ladder streets -------------------------------------------------
// Real SF hill streets are ENGINEERED: constant-grade ramps block to block
// with flat landings at every intersection — not surfaces draped over a
// smooth hill. This field stores, for every point near a steep street, the
// delta between that engineered profile and the raw height field. ONE field
// feeds all three height consumers (road drape, ground mesh, drive surface),
// so they cannot disagree.
const TERRACE_RES = ROAD_TILE / 4;
const LANDING_R = 6; // flat pad radius around each intersection node
const TERRACE_FEATHER = 7; // world units past the sidewalk to fade the delta
const TERRACE_CAP = 2.4; // max |delta| — beyond this reads as a broken cliff
const MAX_RAMP_GRADE = 0.42; // steepest engineered pitch (≈ real SF's 22nd St)
// Chord grade where terracing starts/saturates. Below the low end the smooth
// drape is indistinguishable from the engineered profile anyway.
const TERRACE_GRADE_LO = 0.07;
const TERRACE_GRADE_HI = 0.13;
// Blocks shorter than this stay on the smooth drape: with landings at both
// ends there is no room for a ramp — the profile degenerates into a cliff.
const TERRACE_MIN_LEN = 15;

function smooth01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Delta between the engineered street profile and the raw field, for every
 *  point within a steep street's corridor (0 elsewhere). EVERY edge whose
 *  corridor covers a point contributes, blended by corridor weight — any
 *  winner-takes-N scheme puts hard height cliffs inside junction aprons
 *  wherever the winning set flips between neighboring samples (the drape
 *  renders the cliff AND the physics heightfield beaches the car on it).
 *  Landings pin every edge to the shared node height, so the blend converges
 *  there. Each edge contributes once per point (nearest of its segments),
 *  via a per-edge scratch pass. */
export function makeStreetTerrace(
  network: RoadNetwork,
  terrain: Terrain,
): (x: number, z: number) => number {
  const FW = Math.ceil((WORLD_HALF_X * 2) / TERRACE_RES) + 2;
  const FH = Math.ceil((WORLD_HALF_Z * 2) / TERRACE_RES) + 2;
  const sumW = new Float32Array(FW * FH);
  const sumWV = new Float32Array(FW * FH);
  // Per-edge scratch: nearest-segment dist/value/weight + touched list.
  const sd = new Float32Array(FW * FH).fill(1e9);
  const sv = new Float32Array(FW * FH);
  const sw = new Float32Array(FW * FH);
  const touched: number[] = [];
  for (const e of network.edges) {
    const pts = e.pts;
    if (pts.length < 4) continue;
    // Arclength table + chord grade from the endpoint node heights.
    const n = pts.length / 2;
    const arc = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const dx = (pts[i * 2] ?? 0) - (pts[i * 2 - 2] ?? 0);
      const dz = (pts[i * 2 + 1] ?? 0) - (pts[i * 2 - 1] ?? 0);
      arc[i] = (arc[i - 1] ?? 0) + Math.hypot(dx, dz);
    }
    const len = arc[n - 1] ?? 0;
    if (len < TERRACE_MIN_LEN) continue; // no room for a ramp between landings
    const hA = terrain.heightAt(pts[0] ?? 0, pts[1] ?? 0);
    const hB = terrain.heightAt(pts[n * 2 - 2] ?? 0, pts[n * 2 - 1] ?? 0);
    const dh = Math.abs(hB - hA);
    const steep =
      smooth01((dh / len - TERRACE_GRADE_LO) / (TERRACE_GRADE_HI - TERRACE_GRADE_LO)) *
      smooth01((len - TERRACE_MIN_LEN) / 8);
    if (steep <= 0) continue;
    // Engineered profile along arclength s: flat landing at each node, then
    // a constant-grade ramp between the landing edges. Landings SHRINK when
    // the block is short enough that a full-size pair would push the ramp
    // past MAX_RAMP_GRADE — the pitch caps at real-SF steep, never a cliff.
    // The grade break at the landing edge stays HARD on purpose: cresting an
    // intersection at speed is the SF car-chase hop.
    let landing = LANDING_R;
    const needRamp = dh / MAX_RAMP_GRADE;
    if (len - 2 * landing < needRamp) landing = Math.max(2, (len - needRamp) / 2);
    const rampLen = Math.max(1, len - landing * 2);
    const profile = (s: number): number => {
      const sr = Math.min(Math.max((s - landing) / rampLen, 0), 1);
      return hA + (hB - hA) * sr;
    };
    const band = e.half + walkFor(e.half) + TERRACE_FEATHER;
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const ax = pts[k] ?? 0;
      const az = pts[k + 1] ?? 0;
      const bx = pts[k + 2] ?? 0;
      const bz = pts[k + 3] ?? 0;
      const s0 = arc[k / 2] ?? 0;
      const s1 = arc[k / 2 + 1] ?? 0;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - band + WORLD_HALF_X) / TERRACE_RES));
      const i1 = Math.min(
        FW - 1,
        Math.ceil((Math.max(ax, bx) + band + WORLD_HALF_X) / TERRACE_RES),
      );
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - band + WORLD_HALF_Z) / TERRACE_RES));
      const j1 = Math.min(
        FH - 1,
        Math.ceil((Math.max(az, bz) + band + WORLD_HALF_Z) / TERRACE_RES),
      );
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      for (let i = i0; i <= i1; i++) {
        const px = i * TERRACE_RES - WORLD_HALF_X;
        for (let j = j0; j <= j1; j++) {
          const pz = j * TERRACE_RES - WORLD_HALF_Z;
          let t = ((px - ax) * dx + (pz - az) * dz) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
          if (d > band) continue;
          const idx = i * FH + j;
          if (d >= (sd[idx] ?? 1e9)) continue; // a closer segment of THIS edge won
          if ((sd[idx] ?? 1e9) === 1e9) touched.push(idx);
          const feather = 1 - smooth01((d - e.half - walkFor(e.half)) / TERRACE_FEATHER);
          const want = profile(s0 + (s1 - s0) * t) - terrain.heightAt(px, pz);
          const capped = Math.min(TERRACE_CAP, Math.max(-TERRACE_CAP, want));
          sd[idx] = d;
          sv[idx] = capped * steep;
          sw[idx] = feather;
        }
      }
    }
    // Merge this edge's contribution and reset the scratch.
    for (const idx of touched) {
      const w = sw[idx] ?? 0;
      sumW[idx] = (sumW[idx] ?? 0) + w;
      sumWV[idx] = (sumWV[idx] ?? 0) + w * (sv[idx] ?? 0);
      sd[idx] = 1e9;
    }
    touched.length = 0;
  }
  // Collapse into one field, then sample it BILINEARLY. A nearest-cell
  // lookup quantized the profile into 3.25u plateaus — the whole hill became
  // a washboard of ankle-high risers that pinned the car. max(1, sum):
  // fringe weights fade the delta (feather), overlaps average, never stack.
  const field = new Float32Array(FW * FH);
  for (let idx = 0; idx < field.length; idx++) {
    const w = sumW[idx] ?? 0;
    if (w <= 0.0001) continue;
    field[idx] = (sumWV[idx] ?? 0) / Math.max(1, w);
  }
  return (x: number, z: number): number => {
    const fx = (x + WORLD_HALF_X) / TERRACE_RES;
    const fz = (z + WORLD_HALF_Z) / TERRACE_RES;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= FW - 1 || j >= FH - 1) return 0;
    const tx = fx - i;
    const tz = fz - j;
    const a = field[i * FH + j] ?? 0;
    const b = field[(i + 1) * FH + j] ?? 0;
    const c = field[i * FH + j + 1] ?? 0;
    const d = field[(i + 1) * FH + j + 1] ?? 0;
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };
}

// Terrain + street terrace as ONE drape target for the road builder — roads
// must render exactly the engineered profile the drive surface reports.
export function makeTerracedDrapeField(network: RoadNetwork, terrain: Terrain): DrapeField {
  const terraceAt = makeStreetTerrace(network, terrain);
  const heightAt = (x: number, z: number): number => terrain.heightAt(x, z) + terraceAt(x, z);
  const EPS = 1.6;
  return {
    heightAt,
    normalInto: (out: THREE.Vector3, x: number, z: number): THREE.Vector3 => {
      const hx = heightAt(x + EPS, z) - heightAt(x - EPS, z);
      const hz = heightAt(x, z + EPS) - heightAt(x, z - EPS);
      return out.set(-hx, 2 * EPS, -hz).normalize();
    },
  };
}

/**
 * Height of the surface a static prop STANDS ON — the two things that are
 * actually drawn, not the field they sample. Inside the paved corridor that is
 * the road drape (terrain + terrace); outside it, the ground mesh as
 * tessellated, which smears both the street depression and the terrace over
 * its ~9u lattice. Seating on `terrain.heightAt` buried or floated props by up
 * to the full terrace cap — half a lamp post underground, hydrants in the air.
 */
export function makeStandingSurface(
  network: RoadNetwork,
  terrain: Terrain,
  groundOffset: (x: number, z: number) => number,
  roadDrape: DrapeField,
): (x: number, z: number) => number {
  return (x: number, z: number): number => {
    const hit = network.nearest(x, z, ROAD_TILE * 1.4);
    if (hit && hit.dist <= hit.edge.half + walkFor(hit.edge.half)) return roadDrape.heightAt(x, z);
    return terrain.renderedHeightAt(x, z, groundOffset);
  };
}

// Street depression profile: the ground drops −0.35 under the pavement
// (clearance v < 1.6 beyond the asphalt edge) and feathers back to the
// natural field by v = 4.6.
function streetDepression(v: number): number {
  if (v > 4.6) return 0;
  return v < 1.6 ? -0.35 : -0.35 * Math.max(0, 1 - (v - 1.6) / 3);
}

// Clearance field: for every ~3.25u cell, (distance to nearest edge
// centreline − that edge's half width; 1e9 far from any street). Stamped once
// along each edge — O(street length) — then lookups are O(1).
function makeClearanceAt(network: RoadNetwork): (x: number, z: number) => number {
  const RES = ROAD_TILE / 4;
  const FW = Math.ceil((WORLD_HALF_X * 2) / RES) + 2;
  const FH = Math.ceil((WORLD_HALF_Z * 2) / RES) + 2;
  const field = new Float32Array(FW * FH).fill(1e9);
  const BAND = 5.2; // pave apron 1.6 + feather 3 + slack
  for (const e of network.edges) {
    const band = e.half + BAND;
    for (let k = 0; k + 3 < e.pts.length; k += 2) {
      const ax = e.pts[k] ?? 0;
      const az = e.pts[k + 1] ?? 0;
      const bx = e.pts[k + 2] ?? 0;
      const bz = e.pts[k + 3] ?? 0;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - band + WORLD_HALF_X) / RES));
      const i1 = Math.min(FW - 1, Math.ceil((Math.max(ax, bx) + band + WORLD_HALF_X) / RES));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - band + WORLD_HALF_Z) / RES));
      const j1 = Math.min(FH - 1, Math.ceil((Math.max(az, bz) + band + WORLD_HALF_Z) / RES));
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      for (let i = i0; i <= i1; i++) {
        const px = i * RES - WORLD_HALF_X;
        for (let j = j0; j <= j1; j++) {
          const pz = j * RES - WORLD_HALF_Z;
          let t = ((px - ax) * dx + (pz - az) * dz) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(px - (ax + dx * t), pz - (az + dz * t)) - e.half;
          const idx = i * FH + j;
          const cur = field[idx];
          if (cur === undefined || d < cur) field[idx] = d;
        }
      }
    }
  }
  return (x: number, z: number): number => {
    const i = Math.round((x + WORLD_HALF_X) / RES);
    const j = Math.round((z + WORLD_HALF_Z) / RES);
    if (i >= 0 && j >= 0 && i < FW && j < FH) {
      const v = field[i * FH + j];
      if (v !== undefined) return v;
    }
    return 1e9;
  };
}

// Ground-mesh vertex offset: the street depression plus the step-ladder
// street terracing (the ground shoulders track the engineered profile and
// feather back to the raw field — the retaining-wall read). Under the PAVED
// band of a terraced street the ground sinks a full extra unit: the ground
// mesh's ~9.5u vertices interpolate straight through the profile's landing
// kinks, and with only the 0.35 depression of headroom the bow pokes up
// through the draped asphalt (the m22 bug class, at terrace magnitude).
export function makeGroundOffset(
  network: RoadNetwork,
  terrain?: Terrain,
): (x: number, z: number) => number {
  const clearanceAt = makeClearanceAt(network);
  const terraceAt = terrain ? makeStreetTerrace(network, terrain) : null;
  const offsetAt = (x: number, z: number): number => {
    const v = clearanceAt(x, z);
    const t = terraceAt ? terraceAt(x, z) : 0;
    // Full burial mid-asphalt, tapering to zero at the sidewalk's outer edge
    // so the pavement lip never shows a void from a low camera.
    const cover = 1 - THREE.MathUtils.smoothstep(v, SIDEWALK_W * 0.5, SIDEWALK_W);
    const bury = 1.1 * cover * THREE.MathUtils.smoothstep(Math.abs(t), 0.05, 0.3);
    return streetDepression(v) + t - bury;
  };
  if (!terrain) return offsetAt;
  // A 9u ground triangle can bridge over the street trench even when every
  // sampled offset is correct. Cap its supporting vertices against the road,
  // leaving the rest of the terrain alone. The dense corridor probes include
  // both kerbs and reserve the road drape's full sag tolerance.
  function* ceilings(): Generator<GroundCeiling> {
    if (!terrain) return;
    for (const edge of network.edges) {
      const half = edge.half + walkFor(edge.half);
      const along = Math.max(1, Math.ceil(edge.len / 1.5));
      const across = Math.max(1, Math.ceil((half * 2) / 1.5));
      for (let i = 0; i <= along; i++) {
        const p = network.sample(edge, (i / along) * edge.len);
        for (let j = 0; j <= across; j++) {
          const lateral = ((j / across) * 2 - 1) * half;
          const x = p.x - p.tz * lateral;
          const z = p.z + p.tx * lateral;
          yield {
            x,
            z,
            y: terrain.heightAt(x, z) + (terraceAt ? terraceAt(x, z) : 0) - DRAPE_MAX_ERROR,
          };
        }
      }
    }
  }
  return terrain.capGroundOffset(offsetAt, ceilings());
}

// Offset of the RENDERED top surface relative to the raw height field, for
// the driving/height queries (city.heightAt). The paved band — curb +
// sidewalk, SIDEWALK_W beyond the asphalt edge — rides at field level like
// the asphalt does; past its outer edge the exposed ground is the
// street-depressed mesh. Without this the car hovers on the invisible raw
// field next to downhill kerbs (the visible ground there sits up to 0.35
// lower). Terraced streets add their profile delta in BOTH zones so the car
// rides exactly what the road drape renders.
export function makeDriveSurfaceOffset(
  network: RoadNetwork,
  terrain?: Terrain,
): (x: number, z: number) => number {
  const clearanceAt = makeClearanceAt(network);
  const terraceAt = terrain ? makeStreetTerrace(network, terrain) : null;
  const groundOffset = terrain ? makeGroundOffset(network, terrain) : null;
  return (x, z) => {
    const t = terraceAt ? terraceAt(x, z) : 0;
    const v = clearanceAt(x, z);
    if (v <= SIDEWALK_W) return t; // asphalt / curb / sidewalk
    if (terrain && groundOffset) {
      return terrain.renderedHeightAt(x, z, groundOffset) - terrain.heightAt(x, z);
    }
    return streetDepression(v) + t;
  };
}
