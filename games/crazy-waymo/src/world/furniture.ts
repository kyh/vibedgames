import { makeStandingSurface, parkCellFloor, parkCellHeight } from "./ground";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { ModelCache } from "../assets/loader";
import {
  BRIDGE_PILLAR,
  BUSHES,
  CONSTRUCTION_VEHICLES,
  LIGHT_CURVED,
  LIGHT_CURVED_CROSS,
  LIGHT_OLD,
  LIGHT_SQUARE,
  LIGHT_SQUARE_DOUBLE,
  modelUrl,
  PARK_TILE_PLAZAS,
  PARK_TREES,
  PARK_WALL,
  PROP_BARRIER,
  PROP_BENCH,
  PROP_BOX_A,
  PROP_BOX_B,
  PROP_CHIMNEY_LARGE,
  PROP_CHIMNEY_MEDIUM,
  PROP_CHIMNEY_SMALL,
  PROP_CONE,
  PROP_CONSTRUCTION_LIGHT,
  PROP_DUMPSTER,
  PROP_HYDRANT,
  PROP_PARASOL_A,
  PROP_PARASOL_B,
  PROP_PLANTER,
  PROP_TANK,
  PROP_TRAFFICLIGHT,
  PROP_TRASH_A,
  PROP_TRASH_B,
  PROP_WATERTOWER,
  TRAFFIC_CARS,
  TREE_LARGE,
  TREE_SMALL,
} from "../assets/manifest";
import { GRID_X, GRID_Z, ROAD_TILE, ROAD_Y, WORLD_H, WORLD_W } from "../shared/constants";
import type { Rng } from "../shared/rng";
import { type Dir, DIR_DELTA, E, N, S, W } from "../shared/types";
import { facadeOffset, type Solid, STEEP_CLIFF } from "./city";
import { GGP_LAKE, isParkDistrictLand } from "./land-class";
import { controlArms, junctionControl } from "./junction-control";
import { conformToTerrain, DRAPE_MAX_ERROR, type DrapeField } from "./conform";

import type { NetEdge, RoadNetwork } from "./network";
import type { CityPlan, RoadResolved } from "./grid";
import { type District, type DistrictChar, districtAt } from "./sf-map";
import { parkPathMaskAt } from "./sf-streets";
import { SF_TRANSIT, SF_TRANSIT_LINES, TRANSIT_MODES, type TransitMode } from "./sf-transit";
import type { Terrain } from "./terrain";

// Street-furniture pass: streetlights, parked cars, awnings, suburban yards,
// industrial smokestacks, construction chicanes, Golden Gate Park allées, the
// Fisherman's Wharf piers and the wharf seawall. Everything static is returned
// as world-baked objects for the caller to collect + merge by material; only a
// handful of collision Solids (parked cars, barriers, pier railings/buildings)
// are appended.

// Lifts for lot-draped pieces (BAKED into public/world — changes here only
// land via a rebake). These conform to the ground mesh AS DRAWN (groundDrape),
// so they only have to clear their own drape bow — not the coarse-lattice
// error the mesh adds on top of the field, which used to double the lift and
// leave the paths visibly hovering over the grass.
const LOT_DECAL_LIFT = DRAPE_MAX_ERROR * 0.5; // 0.045

export type FurnitureCtx = {
  readonly plan: CityPlan;
  readonly network: RoadNetwork;
  readonly terrain: Terrain;
  /** terrain + street terrace — the field the kerb/sidewalk/asphalt drape onto */
  readonly roadDrape: DrapeField;
  /** makeGroundOffset(network, terrain) — the ground mesh's per-vertex shift */
  readonly groundOffset: (x: number, z: number) => number;
  readonly cache: ModelCache;
  readonly rng: Rng;
  readonly reserved: ReadonlySet<string>; // "gx,gz" cells to leave alone (landmarks)
  /**
   * Did the frontage walk actually build a WALL on the facade plane here?
   * This module can COMPUTE the plane (facadeOffset) but has no view of the
   * buildings, so awnings, shutters, fire escapes and murals used to hang in
   * mid-air over every alley between runs, every lot a placement gate refused
   * and every block the real-footprint pass owns instead. city.ts stamps the
   * front face of each lot it builds; this is the question.
   */
  readonly facadeAt: (x: number, z: number) => boolean;
  readonly worldX: (gx: number) => number;
  readonly worldZ: (gz: number) => number;
};

export type PierDeck = { minX: number; maxX: number; minZ: number; maxZ: number; y: number };
export type ParkedSpec = { x: number; z: number; yaw: number; model: string };
// World position of a lamp's light source + the pavement under it — the
// night-time glow pass (fx/lamp-glow.ts) draws halos and light pools here.
export type LampHead = { x: number; y: number; z: number; ground: number };

export type FurnitureResult = {
  readonly objects: THREE.Object3D[]; // static, world-transform set; caller merges
  readonly solids: Solid[]; // collision boxes to append
  readonly openWaterCells: ReadonlySet<string>; // water cells the shoreline-wall pass must skip (piers)
  readonly pierDecks: readonly PierDeck[]; // drivable flat decks (caller overrides surface height)
  readonly parkedCars: readonly ParkedSpec[]; // punt-able parked cars (physics, not static)
  readonly lampHeads: readonly LampHead[]; // streetlight glow anchors
};

const HALF_PI = Math.PI / 2;
const DIRS: readonly Dir[] = [N, E, S, W];

// --- Tunables ---
const LIGHT_HEIGHT = 5; // streetlight world height
const PIER_DECK_Y = 0.55; // flat pier deck height over the water
const PIER_WIDTH = ROAD_TILE * 1.03; // decks scaled like road tiles
const PIER_RAMP_RUN = ROAD_TILE * 0.6; // horizontal run of the shore→deck ramp
const PIER_DECK_MAT = new THREE.MeshStandardMaterial({ color: 0x9c8158, roughness: 0.9 });
const CONSTRUCTION_POCKETS = 6;

// Model catalogs used only here.
const CHIMNEYS: readonly string[] = [PROP_CHIMNEY_SMALL, PROP_CHIMNEY_MEDIUM, PROP_CHIMNEY_LARGE];
// Pier 39 stand-ins at the middle pier's end (commercial kit, tinted brick-red).
const PIER_END_BUILDINGS: readonly string[] = ["com-building-a", "com-building-f"];
const PIER_BUILDING_TINT = 0xc45a3a;
// KayKit props run warmer than the Kenney kits — nudge them toward the Kenney
// paper tone so the street reads as one palette. Tints go through tintMaterial,
// so each (material, tint) pair clones exactly once and merged batches stay few.
const KK_TINT = 0xd8d2c4;
const KK_TINT_AMT = 0.15;
// KayKit pass caps + sizes. The old 40/50 covered a couple of blocks of a
// 244×200 city: most blocks got nothing at all. A kerbside prop is a ~38 B
// batch record, so these are cheap; the real limiter is the claim hash keeping
// them off each other.
const HYDRANT_CAP = 340;
const SEATING_CAP = 280; // benches + trash cans combined
const VICTORIAN_LAMP_HEIGHT = 4.2;
const PARK_SKIRT_DEPTH = 1.6; // stone skirt under a flat park tile

// Shared static geometry/materials at module scope so merged batches stay few.
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
// …but a shared box is also how three unrelated props become ONE prop.
// `city.ts`'s rest capture keys procedural geometry by object IDENTITY
// (`rawGeoIds` is a map on `geo.uuid`), so every kind that reuses UNIT_BOX
// lands in a single serialized "kind" — and every measurement that reasons per
// kind (tools/geometry-audit.mts's seat baseline, which is a MEDIAN over the
// kind) then compares a 0.2u-thick park skirt against a 2.4u gate pillar and
// calls both of them wrong — 1,074 phantom "floating" props from four kinds
// sharing one box. Each is its own prop, so each gets its own box: identical
// geometry, distinct identity, one extra 24-vertex record each in the bake and
// no extra draw call (a BatchedMesh holds many geometries per material). A new
// kind of box gets a new constant here rather than reaching for UNIT_BOX.
const PARK_SKIRT_BOX = new THREE.BoxGeometry(1, 1, 1);
const WALL_FOOTING_BOX = new THREE.BoxGeometry(1, 1, 1);
const GATE_POST_BOX = new THREE.BoxGeometry(1, 1, 1);
const BLADE_PLATE_BOX = new THREE.BoxGeometry(1, 1, 1);
// Stop signs are procedural (no kit model has one): an octagonal face on a
// pole. Flat-edge-up octagon, caps facing ±Z after the X-rotation.
const STOP_FACE = new THREE.CylinderGeometry(0.42, 0.42, 0.05, 8)
  .rotateY(Math.PI / 8)
  .rotateX(Math.PI / 2);
const STOP_RIM = new THREE.CylinderGeometry(0.48, 0.48, 0.04, 8)
  .rotateY(Math.PI / 8)
  .rotateX(Math.PI / 2);
const STOP_POLE = new THREE.CylinderGeometry(0.05, 0.05, 1, 6);
const STOP_RED_MAT = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.7 });
const STOP_WHITE_MAT = new THREE.MeshStandardMaterial({ color: 0xf4f7f4, roughness: 0.7 });
const POLE_MAT = new THREE.MeshStandardMaterial({ color: 0x8f979e, roughness: 0.9 });
const RAIL_MAT = new THREE.MeshStandardMaterial({ color: 0x8a6f4d, roughness: 0.9 }); // pier wood
const SEAWALL_MAT = new THREE.MeshStandardMaterial({ color: 0x9aa2a6, roughness: 1 }); // concrete lip
const LAKE_MAT = new THREE.MeshStandardMaterial({ color: 0x3f6f8f, roughness: 0.4 }); // Stow Lake
const PATH_MAT = new THREE.MeshStandardMaterial({ color: 0xd9c3a1, roughness: 1 }); // park paths
// SF street-dressing palette. Every material here is one BatchedMesh (one draw
// call) for the whole city, so the count is the draw-call budget: 6 additions
// dress ~35 distinct prop types because per-instance tint (userData.tint,
// picked up by the city batcher's setColorAt) supplies all colour variation.
const WIRE_MAT = new THREE.MeshStandardMaterial({
  color: 0x24262a,
  roughness: 0.5,
  metalness: 0.3,
}); // catenary, guys, fire escapes, shutters
const MUNI_MAT = new THREE.MeshStandardMaterial({ color: 0x5c4634, roughness: 0.8 }); // Muni brown
const GLASS_MAT = new THREE.MeshStandardMaterial({
  color: 0xa9c2cd,
  roughness: 0.12,
  metalness: 0.1,
}); // shelter glazing
const BLADE_MAT = new THREE.MeshStandardMaterial({ color: 0x25604a, roughness: 0.75 }); // street blades
const CANVAS_MAT = new THREE.MeshStandardMaterial({ color: 0xb5384a, roughness: 0.92 }); // awnings, news racks, murals
const FROND_MAT = new THREE.MeshStandardMaterial({ color: 0x4d7a4a, roughness: 0.85 }); // palm crowns

// ---------------------------------------------------------------------------
// PROCEDURAL STREET KIT
//
// No kit GLB ships a parking meter, a Muni shelter, a trolley pole or a street
// blade, and `assets/manifest.ts` is not this module's file — so everything new
// here is built from three primitives. That is also the cheaper choice for the
// baked world: `city.ts` uploads each unique geometry ONCE and stores a
// placement as a quantized TRS record (~38 B; a non-yaw rotation costs a 64 B
// exact matrix on top), so a kit shared by 2,000 sites costs 2,000 × 38 B, not
// 2,000 copies of its triangles.
//
// The rule that follows from that: a kit site costs one batch item PER
// MATERIAL, so `buildKit` merges its pieces per material up front. A shelter is
// 9 boxes but 3 items. Keep the piece list long and the material list short.
// ---------------------------------------------------------------------------
const UNIT_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
// PlaneGeometry shares BoxGeometry's attribute layout (position/normal/uv,
// indexed), so plane-based pieces land in the same batch bucket as box-based
// ones instead of forking a second draw call. Faces local +Z.
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);

type KitPiece = {
  readonly geo: THREE.BufferGeometry;
  readonly mat: THREE.MeshStandardMaterial;
  readonly at?: readonly [number, number, number];
  readonly size?: readonly [number, number, number];
  /** Euler radians, applied YXZ (yaw, then pitch, then roll). */
  readonly rot?: readonly [number, number, number];
};
type KitPart = { readonly geo: THREE.BufferGeometry; readonly mat: THREE.MeshStandardMaterial };

const KIT_M = new THREE.Matrix4();
const KIT_E = new THREE.Euler();
const KIT_Q = new THREE.Quaternion();
const KIT_V = new THREE.Vector3();
const KIT_S = new THREE.Vector3();

function buildKit(pieces: readonly KitPiece[]): readonly KitPart[] {
  const byMat = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>();
  for (const p of pieces) {
    const size = p.size ?? [1, 1, 1];
    const rot = p.rot ?? [0, 0, 0];
    const at = p.at ?? [0, 0, 0];
    KIT_E.set(rot[0], rot[1], rot[2], "YXZ");
    KIT_M.compose(
      KIT_V.set(at[0], at[1], at[2]),
      KIT_Q.setFromEuler(KIT_E),
      KIT_S.set(size[0], size[1], size[2]),
    );
    const geo = p.geo.clone().applyMatrix4(KIT_M);
    const list = byMat.get(p.mat);
    if (list) list.push(geo);
    else byMat.set(p.mat, [geo]);
  }
  const parts: KitPart[] = [];
  for (const [mat, geos] of byMat) {
    const first = geos[0];
    if (!first) continue;
    parts.push({ geo: geos.length === 1 ? first : mergeGeometries(geos, false), mat });
  }
  return parts;
}

// A lazily-built kit: nothing is uploaded for a prop type the city never
// places (the west-side utility poles never build on a downtown-only map).
function lazyKit(build: () => readonly KitPiece[]): () => readonly KitPart[] {
  let parts: readonly KitPart[] | null = null;
  return () => (parts ??= buildKit(build()));
}

const kBox = (
  mat: THREE.MeshStandardMaterial,
  at: readonly [number, number, number],
  size: readonly [number, number, number],
  rot?: readonly [number, number, number],
): KitPiece => (rot ? { geo: UNIT_BOX, mat, at, size, rot } : { geo: UNIT_BOX, mat, at, size });
const kTube = (
  mat: THREE.MeshStandardMaterial,
  at: readonly [number, number, number],
  size: readonly [number, number, number],
  rot?: readonly [number, number, number],
): KitPiece => (rot ? { geo: UNIT_CYL, mat, at, size, rot } : { geo: UNIT_CYL, mat, at, size });

// --- Overhead wire ----------------------------------------------------------
// One unit-length sagging span along +X, placed by aiming +X down the span and
// scaling UNIFORMLY by its length — so sag stays proportional to span the way
// a real catenary does, and thickness grows with span so a 130-metre wire is
// still a visible line at draw distance (a true 2 cm wire is sub-pixel and the
// city reads as if the wires were never there).
const WIRE_SAG = 0.055; // fraction of span
const WIRE_GAUGE = 0.0019; // fraction of span
const WIRE_SEGS = 4;
const wireKit = lazyKit(() => {
  const pieces: KitPiece[] = [];
  const yAt = (t: number): number => -WIRE_SAG * 4 * t * (1 - t);
  for (let i = 0; i < WIRE_SEGS; i++) {
    const t0 = i / WIRE_SEGS;
    const t1 = (i + 1) / WIRE_SEGS;
    const y0 = yAt(t0);
    const y1 = yAt(t1);
    const len = Math.hypot(t1 - t0, y1 - y0) * 1.06; // overlap the joints
    pieces.push(
      kBox(
        WIRE_MAT,
        [(t0 + t1) / 2, (y0 + y1) / 2, 0],
        [len, WIRE_GAUGE, WIRE_GAUGE],
        [0, 0, Math.atan2(y1 - y0, t1 - t0)],
      ),
    );
  }
  return pieces;
});
const X_AXIS = new THREE.Vector3(1, 0, 0);

// Trolleybus mast: SF hangs its trolley wire off plain steel masts with a
// short bracket arm reaching over the kerb lane. Origin at the pavement.
const TROLLEY_POLE_H = 7.2;
const trolleyPoleKit = lazyKit(() => [
  kTube(POLE_MAT, [0, TROLLEY_POLE_H / 2, 0], [0.26, TROLLEY_POLE_H, 0.26]),
  kTube(POLE_MAT, [0, 0.14, 0], [0.52, 0.28, 0.52]),
  // bracket arm reaching toward the roadway (local +Z)
  kTube(POLE_MAT, [0, TROLLEY_POLE_H - 0.5, 1.1], [0.14, 2.2, 0.14], [0, 0, Math.PI / 2]),
  kBox(POLE_MAT, [0, TROLLEY_POLE_H - 1.05, 0.75], [0.1, 1.3, 0.1], [Math.PI / 5, 0, 0]),
]);
const transformerKit = lazyKit(() => [
  kBox(WIRE_MAT, [0, 0, 0], [0.62, 0.9, 0.5]),
  kTube(WIRE_MAT, [0, 0.56, 0], [0.5, 0.22, 0.5]),
]);
// Wooden distribution pole for the west-side blocks: two crossarms, glass
// insulators, service drop bracket.
const POWER_POLE_H = 8.6;
const powerPoleKit = lazyKit(() => {
  const pieces: KitPiece[] = [
    kTube(RAIL_MAT, [0, POWER_POLE_H / 2, 0], [0.34, POWER_POLE_H, 0.34]),
    kBox(RAIL_MAT, [0, POWER_POLE_H - 0.45, 0], [0.16, 0.16, 2.9]),
    kBox(RAIL_MAT, [0, POWER_POLE_H - 1.7, 0], [0.14, 0.14, 2.1]),
  ];
  for (const z of [-1.25, 0, 1.25] as const) {
    pieces.push(kTube(RAIL_MAT, [0, POWER_POLE_H - 0.28, z], [0.16, 0.22, 0.16]));
  }
  return pieces;
});

// --- Muni ------------------------------------------------------------------
// Glass box, cantilever roof, bench, and the brown pole with a route flag.
const shelterKit = lazyKit(() => [
  // roof + frame (local +Z is the kerb side; the glass wall is at -Z)
  kBox(MUNI_MAT, [0, 2.62, 0], [4.4, 0.14, 1.9]),
  kBox(MUNI_MAT, [0, 2.72, -0.85], [4.4, 0.22, 0.2]),
  kBox(MUNI_MAT, [-2.05, 1.3, -0.8], [0.16, 2.6, 0.16]),
  kBox(MUNI_MAT, [2.05, 1.3, -0.8], [0.16, 2.6, 0.16]),
  kBox(MUNI_MAT, [-2.05, 1.3, 0.8], [0.16, 2.6, 0.16]),
  kBox(MUNI_MAT, [2.05, 1.3, 0.8], [0.16, 2.6, 0.16]),
  // glazing: back wall + two returns
  kBox(GLASS_MAT, [0, 1.42, -0.86], [4.0, 2.3, 0.05]),
  kBox(GLASS_MAT, [-2.02, 1.42, 0], [0.05, 2.3, 1.6]),
  kBox(GLASS_MAT, [2.02, 1.42, 0], [0.05, 2.3, 1.6]),
  // perch bench against the glass
  kBox(RAIL_MAT, [0, 0.66, -0.62], [3.4, 0.1, 0.42]),
  kBox(RAIL_MAT, [-1.5, 0.33, -0.62], [0.12, 0.66, 0.12]),
  kBox(RAIL_MAT, [1.5, 0.33, -0.62], [0.12, 0.66, 0.12]),
]);
const STOP_POLE_H = 3.4;
const stopPoleKit = lazyKit(() => [
  kTube(MUNI_MAT, [0, STOP_POLE_H / 2, 0], [0.14, STOP_POLE_H, 0.14]),
  kBox(MUNI_MAT, [0, STOP_POLE_H - 0.42, 0.02], [0.9, 0.84, 0.05]),
]);

// --- Cable-car turntable ----------------------------------------------------
// The Powell/Market and Hyde St terminals are the two places in the city where
// the track ends in a wooden disc the crew shoves the car around on.
const TURNTABLE_R = 4.6;
const turntableKit = lazyKit(() => {
  const pieces: KitPiece[] = [
    {
      geo: UNIT_CYL,
      mat: SEAWALL_MAT,
      at: [0, -0.08, 0],
      size: [TURNTABLE_R * 2, 0.3, TURNTABLE_R * 2],
    },
    {
      geo: UNIT_CYL,
      mat: RAIL_MAT,
      at: [0, 0.09, 0],
      size: [TURNTABLE_R * 1.82, 0.12, TURNTABLE_R * 1.82],
    },
  ];
  // the two rails across the disc, and a ring of bollards round the apron
  for (const z of [-0.26, 0.26] as const) {
    pieces.push(kBox(POLE_MAT, [0, 0.17, z], [TURNTABLE_R * 1.8, 0.08, 0.14]));
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    pieces.push(
      kTube(
        POLE_MAT,
        [Math.cos(a) * (TURNTABLE_R + 0.7), 0.42, Math.sin(a) * (TURNTABLE_R + 0.7)],
        [0.2, 0.84, 0.2],
      ),
    );
  }
  return pieces;
});

// --- Kerbside clutter -------------------------------------------------------
const meterKit = lazyKit(() => [
  kTube(POLE_MAT, [0, 0.6, 0], [0.09, 1.2, 0.09]),
  kBox(POLE_MAT, [0, 1.36, 0], [0.24, 0.34, 0.18]),
  kBox(WIRE_MAT, [0, 1.4, 0.1], [0.15, 0.2, 0.02]),
]);
const newsBoxKit = lazyKit(() => [
  kBox(CANVAS_MAT, [0, 0.62, 0], [0.62, 1.24, 0.52]),
  kBox(CANVAS_MAT, [0, 1.28, 0], [0.66, 0.1, 0.56]),
  kBox(WIRE_MAT, [0, 0.86, 0.27], [0.44, 0.5, 0.03]),
]);
const mailboxKit = lazyKit(() => [
  kBox(CANVAS_MAT, [0, 0.82, 0], [0.72, 0.78, 0.56]),
  {
    geo: UNIT_CYL,
    mat: CANVAS_MAT,
    at: [0, 1.21, 0],
    size: [0.72, 0.56, 0.56],
    rot: [0, 0, Math.PI / 2],
  },
  kBox(CANVAS_MAT, [0, 0.22, 0], [0.3, 0.44, 0.3]),
]);
const bikeRackKit = lazyKit(() => {
  const pieces: KitPiece[] = [];
  for (const x of [-0.9, 0.9] as const) {
    pieces.push(kTube(POLE_MAT, [x - 0.32, 0.4, 0], [0.09, 0.8, 0.09]));
    pieces.push(kTube(POLE_MAT, [x + 0.32, 0.4, 0], [0.09, 0.8, 0.09]));
    pieces.push(kBox(POLE_MAT, [x, 0.79, 0], [0.72, 0.09, 0.09]));
  }
  return pieces;
});
const scooterKit = lazyKit(() => [
  kBox(WIRE_MAT, [0, 0.16, 0], [0.9, 0.07, 0.18]),
  kTube(WIRE_MAT, [0.38, 0.6, 0], [0.06, 0.9, 0.06], [0, 0, -0.12]),
  kBox(WIRE_MAT, [0.44, 1.03, 0], [0.08, 0.06, 0.44]),
  {
    geo: UNIT_CYL,
    mat: WIRE_MAT,
    at: [0.42, 0.14, 0],
    size: [0.26, 0.07, 0.26],
    rot: [0, 0, Math.PI / 2],
  },
  {
    geo: UNIT_CYL,
    mat: WIRE_MAT,
    at: [-0.42, 0.14, 0],
    size: [0.26, 0.07, 0.26],
    rot: [0, 0, Math.PI / 2],
  },
]);
const cabinetKit = lazyKit(() => [
  kBox(SEAWALL_MAT, [0, 0.66, 0], [1.05, 1.32, 0.55]),
  kBox(SEAWALL_MAT, [0, 1.36, 0], [1.15, 0.1, 0.65]),
  kBox(WIRE_MAT, [0, 0.66, 0.29], [0.86, 1.06, 0.03]),
]);
const aBoardKit = lazyKit(() => [
  kBox(CANVAS_MAT, [0, 0.5, -0.16], [0.6, 1.0, 0.04], [0.28, 0, 0]),
  kBox(CANVAS_MAT, [0, 0.5, 0.16], [0.6, 1.0, 0.04], [-0.28, 0, 0]),
]);
// A frontage under repair: pavement gantry, plank deck, debris net.
const SCAFFOLD_RUN = 9;
const scaffoldKit = lazyKit(() => {
  const pieces: KitPiece[] = [];
  for (let i = 0; i <= 3; i++) {
    const x = -SCAFFOLD_RUN / 2 + (SCAFFOLD_RUN * i) / 3;
    for (const z of [-0.85, 0.85] as const) {
      pieces.push(kTube(POLE_MAT, [x, 3.1, z], [0.11, 6.2, 0.11]));
    }
    pieces.push(kBox(POLE_MAT, [x, 6.15, 0], [0.1, 0.1, 1.8]));
  }
  for (const y of [2.5, 6.1] as const) {
    for (const z of [-0.85, 0.85] as const) {
      pieces.push(kBox(POLE_MAT, [0, y, z], [SCAFFOLD_RUN, 0.09, 0.09]));
    }
  }
  pieces.push(kBox(RAIL_MAT, [0, 2.6, 0], [SCAFFOLD_RUN, 0.08, 1.7]));
  pieces.push(kBox(CANVAS_MAT, [0, 4.4, 0.9], [SCAFFOLD_RUN, 3.5, 0.03]));
  return pieces;
});

// --- Regulatory plate on a pole (no-parking / tow-away) ---------------------
const regulatoryKit = lazyKit(() => [
  kTube(POLE_MAT, [0, 1.15, 0], [0.07, 2.3, 0.07]),
  kBox(STOP_WHITE_MAT, [0, 2.02, 0.02], [0.44, 0.66, 0.04]),
  kBox(STOP_RED_MAT, [0, 2.24, 0.05], [0.4, 0.16, 0.02]),
]);

// --- Facade furniture -------------------------------------------------------
// The row walk's building front plane, as a LATERAL offset beyond edge.half
// (which is what kerbWalk wants). It is not a constant: city.ts seats a
// frontage row at `facadeOffset(edge.half)` — the street's own sidewalk width
// plus a stoop — so an arterial's wall stands 2.45u off the kerb line and a
// minor street's 1.75u. The flat 2.4 this replaced floated every facade prop
// 0.65u clear of the wall on the whole residential grid.
const frontPlane = (edge: NetEdge): number => facadeOffset(edge.half) - edge.half;

// Anchored on the row-walk's front plane (see frontPlane), local +Z
// pointing at the street.
const awningKit = lazyKit(() => [
  kBox(CANVAS_MAT, [0, 2.86, 0.62], [3.2, 0.06, 1.5], [-0.36, 0, 0]),
  kBox(CANVAS_MAT, [0, 2.52, 1.24], [3.2, 0.36, 0.05]),
  kTube(POLE_MAT, [-1.5, 2.95, 0.62], [0.06, 1.5, 0.06], [-1.2, 0, 0]),
  kTube(POLE_MAT, [1.5, 2.95, 0.62], [0.06, 1.5, 0.06], [-1.2, 0, 0]),
]);
// Two landings of the iron zig-zag every Chinatown and Tenderloin block wears.
const fireEscapeKit = lazyKit(() => {
  const pieces: KitPiece[] = [];
  for (const y of [3.6, 6.6] as const) {
    pieces.push(kBox(WIRE_MAT, [0, y, 0.55], [2.6, 0.08, 1.1]));
    pieces.push(kBox(WIRE_MAT, [0, y + 0.5, 1.08], [2.6, 0.06, 0.06]));
    pieces.push(kBox(WIRE_MAT, [0, y + 0.95, 1.08], [2.6, 0.06, 0.06]));
    for (const x of [-1.25, 0, 1.25] as const) {
      pieces.push(kBox(WIRE_MAT, [x, y + 0.5, 1.08], [0.06, 1.0, 0.06]));
    }
    // stair stringer down to the landing below
    pieces.push(kBox(WIRE_MAT, [0.9, y - 1.5, 0.75], [0.08, 3.4, 0.5], [0, 0, 0.62]));
  }
  return pieces;
});
const muralKit = lazyKit(() => [{ geo: UNIT_PLANE, mat: CANVAS_MAT, size: [5.2, 4.4, 1] }]);
const shutterKit = lazyKit(() => {
  const pieces: KitPiece[] = [kBox(WIRE_MAT, [0, 1.35, 0], [3.4, 2.7, 0.07])];
  for (let i = 0; i < 7; i++) {
    pieces.push(kBox(WIRE_MAT, [0, 0.24 + i * 0.37, 0.05], [3.4, 0.1, 0.04]));
  }
  return pieces;
});

// --- Trees -----------------------------------------------------------------
// A tree WELL, not a lawn: four kerb strips round an open square of soil. The
// open middle is the point — the ground shows through as dirt, which is what a
// street tree stands in.
const TREE_WELL_R = 0.82;
const treeWellKit = lazyKit(() => {
  const pieces: KitPiece[] = [];
  for (const s of [-1, 1] as const) {
    pieces.push(kBox(SEAWALL_MAT, [s * TREE_WELL_R, 0.06, 0], [0.2, 0.16, TREE_WELL_R * 2 + 0.2]));
    pieces.push(kBox(SEAWALL_MAT, [0, 0.06, s * TREE_WELL_R], [TREE_WELL_R * 2 - 0.2, 0.16, 0.2]));
  }
  return pieces;
});
// The Embarcadero / Dolores palm. No kit model has one and it is the single
// most recognisable planting in the city, so it is built: a leaning trunk of
// stacked drums under a crown of drooping fronds.
const palmKit = lazyKit(() => {
  const pieces: KitPiece[] = [];
  const H = 8.4;
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    pieces.push(
      kTube(
        RAIL_MAT,
        [t * 0.5, 0.35 + t * (H - 0.9), 0],
        [0.56 - t * 0.22, (H - 0.7) / 6.4, 0.56 - t * 0.22],
      ),
    );
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const droop = i % 2 === 0 ? 0.45 : 0.72;
    pieces.push({
      geo: UNIT_BOX,
      mat: FROND_MAT,
      at: [0.5 + Math.cos(a) * 1.3, H - 0.15 - droop * 0.9, Math.sin(a) * 1.3],
      size: [2.9, 0.07, 0.62],
      rot: [0, -a, droop],
    });
  }
  return pieces;
});

// ---------------------------------------------------------------------------
// GLYPH FONT — the game had no text in the world at all. 4×5 uppercase cells,
// one bit per pixel, MSB = leftmost column. Each row's runs of set bits merge
// into ONE quad, so a glyph is ~8 quads and a whole street name is a single
// merged geometry cached per string. No font file, no texture, no per-sign
// atlas: the baked world drops UVs on procedural geometry, so a textured sign
// could not survive the bake at all.
// ---------------------------------------------------------------------------
const GLYPHS: ReadonlyMap<string, readonly [number, number, number, number, number]> = new Map(
  Object.entries({
    A: [0b0110, 0b1001, 0b1111, 0b1001, 0b1001],
    B: [0b1110, 0b1001, 0b1110, 0b1001, 0b1110],
    C: [0b0111, 0b1000, 0b1000, 0b1000, 0b0111],
    D: [0b1110, 0b1001, 0b1001, 0b1001, 0b1110],
    E: [0b1111, 0b1000, 0b1110, 0b1000, 0b1111],
    F: [0b1111, 0b1000, 0b1110, 0b1000, 0b1000],
    G: [0b0111, 0b1000, 0b1011, 0b1001, 0b0111],
    H: [0b1001, 0b1001, 0b1111, 0b1001, 0b1001],
    I: [0b1111, 0b0110, 0b0110, 0b0110, 0b1111],
    J: [0b0011, 0b0001, 0b0001, 0b1001, 0b0110],
    K: [0b1001, 0b1010, 0b1100, 0b1010, 0b1001],
    L: [0b1000, 0b1000, 0b1000, 0b1000, 0b1111],
    M: [0b1001, 0b1111, 0b1111, 0b1001, 0b1001],
    N: [0b1001, 0b1101, 0b1111, 0b1011, 0b1001],
    O: [0b0110, 0b1001, 0b1001, 0b1001, 0b0110],
    P: [0b1110, 0b1001, 0b1110, 0b1000, 0b1000],
    Q: [0b0110, 0b1001, 0b1001, 0b1011, 0b0111],
    R: [0b1110, 0b1001, 0b1110, 0b1010, 0b1001],
    S: [0b0111, 0b1000, 0b0110, 0b0001, 0b1110],
    T: [0b1111, 0b0110, 0b0110, 0b0110, 0b0110],
    U: [0b1001, 0b1001, 0b1001, 0b1001, 0b0110],
    V: [0b1001, 0b1001, 0b1001, 0b0110, 0b0110],
    W: [0b1001, 0b1001, 0b1111, 0b1111, 0b1001],
    X: [0b1001, 0b1001, 0b0110, 0b1001, 0b1001],
    Y: [0b1001, 0b1001, 0b0110, 0b0110, 0b0110],
    Z: [0b1111, 0b0011, 0b0110, 0b1100, 0b1111],
    "0": [0b0110, 0b1011, 0b1101, 0b1001, 0b0110],
    "1": [0b0010, 0b0110, 0b0010, 0b0010, 0b0111],
    "2": [0b1110, 0b0001, 0b0110, 0b1000, 0b1111],
    "3": [0b1110, 0b0001, 0b0110, 0b0001, 0b1110],
    "4": [0b1010, 0b1010, 0b1111, 0b0010, 0b0010],
    "5": [0b1111, 0b1000, 0b1110, 0b0001, 0b1110],
    "6": [0b0111, 0b1000, 0b1110, 0b1001, 0b0110],
    "7": [0b1111, 0b0001, 0b0010, 0b0100, 0b0100],
    "8": [0b0110, 0b1001, 0b0110, 0b1001, 0b0110],
    "9": [0b0110, 0b1001, 0b0111, 0b0001, 0b1110],
    "-": [0b0000, 0b0000, 0b1110, 0b0000, 0b0000],
    ".": [0b0000, 0b0000, 0b0000, 0b0000, 0b0100],
    "'": [0b0100, 0b0100, 0b0000, 0b0000, 0b0000],
    " ": [0, 0, 0, 0, 0],
  } satisfies Record<string, readonly [number, number, number, number, number]>),
);
const GLYPH_PX = 0.075; // world units per font pixel
const GLYPH_ADVANCE = 5 * GLYPH_PX; // 4-wide cell + 1 gap
const GLYPH_H = 5 * GLYPH_PX;

/** Width of a rendered label, world units. */
function labelWidth(text: string): number {
  return Math.max(0, text.length * GLYPH_ADVANCE - GLYPH_PX);
}

const labelCache = new Map<string, THREE.BufferGeometry>();

/**
 * A label as ONE merged geometry, centred on the origin, facing local +Z.
 * Cached by string: a city with 240 blades across 40 named streets uploads 40
 * geometries, not 480.
 */
function labelGeo(text: string): THREE.BufferGeometry | null {
  const cached = labelCache.get(text);
  if (cached) return cached;
  const w = labelWidth(text);
  const quads: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  for (let c = 0; c < text.length; c++) {
    const rows = GLYPHS.get(text.charAt(c));
    if (!rows) continue;
    const x0 = -w / 2 + c * GLYPH_ADVANCE;
    for (let r = 0; r < 5; r++) {
      const bits = rows[r] ?? 0;
      let col = 0;
      while (col < 4) {
        if ((bits & (1 << (3 - col))) === 0) {
          col++;
          continue;
        }
        let run = 1;
        while (col + run < 4 && (bits & (1 << (3 - col - run))) !== 0) run++;
        m.makeScale(run * GLYPH_PX, GLYPH_PX, 1);
        m.setPosition(x0 + (col + run / 2) * GLYPH_PX, GLYPH_H / 2 - (r + 0.5) * GLYPH_PX, 0);
        quads.push(UNIT_PLANE.clone().applyMatrix4(m));
        col += run;
      }
    }
  }
  const first = quads[0];
  if (!first) return null;
  const geo = quads.length === 1 ? first : mergeGeometries(quads, false);
  labelCache.set(text, geo);
  return geo;
}

/** SF blade text: strip the way-type suffix, cap the length. */
function bladeText(street: string): string | null {
  let t = street.toUpperCase().replace(/^THE /, "");
  t = t
    .replace(/ STREET$/, "")
    .replace(/ AVENUE$/, " AVE")
    .replace(/ BOULEVARD$/, " BLVD")
    .replace(/ FREEWAY$/, " FWY")
    .replace(/ DRIVE$/, " DR")
    .replace(/ PLACE$/, " PL")
    .replace(/ ROAD$/, " RD")
    .replace(/ WAY$/, " WAY")
    .replace(/ TERRACE$/, " TER");
  t = t.replace(/[^A-Z0-9'. -]/g, "");
  if (t.length === 0 || t.length > 13) return null;
  for (const ch of t) if (!GLYPHS.has(ch)) return null;
  return t;
}

// Tint via per-instance color (picked up by the city batcher's setColorAt) —
// tint variants no longer clone materials or multiply batch count.
function tintNode(node: THREE.Object3D, hex: number, amt: number): void {
  node.traverse((c) => {
    if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial) {
      c.userData.tint = c.material.color.clone().lerp(new THREE.Color(hex), amt);
    }
  });
}

const cellKey = (gx: number, gz: number): string => `${gx},${gz}`;
const inBounds = (gx: number, gz: number): boolean =>
  gx >= 0 && gz >= 0 && gx < GRID_X && gz < GRID_Z;

/** Map fractions (0..1) — the coordinates every SF landmark note is written in. */
const uOf = (x: number): number => x / WORLD_W + 0.5;
const vOf = (z: number): number => z / WORLD_H + 0.5;
const toGx = (x: number): number => Math.floor((x + WORLD_W / 2) / ROAD_TILE);
const toGz = (z: number): number => Math.floor((z + WORLD_H / 2) / ROAD_TILE);

// Pavement claim hash (8u buckets): what stops two dressing passes putting a
// bench and a tree in the same square metre.
const claimKey = (x: number, z: number): string => `${Math.floor(x / 8)},${Math.floor(z / 8)}`;

/** A seated point on one kerb of one edge — what every dressing pass consumes. */
type KerbPoint = {
  readonly x: number;
  readonly z: number;
  readonly tx: number; // unit tangent along the edge
  readonly tz: number;
  readonly side: 1 | -1; // which kerb
  readonly half: number; // the edge's asphalt half-width
  readonly district: District;
};
/** Yaw that points a kit's local +Z at the roadway from a kerb point. */
const facingRoad = (p: KerbPoint): number => Math.atan2(-p.tz * p.side, -p.tx * p.side);

// Yaw that points local +Z toward the given grid direction (matches city.ts).
function dirToYaw(d: Dir): number {
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

// Streetlight model per district character.
function lightFor(c: DistrictChar): string {
  switch (c) {
    case "residential":
    case "victorian":
    case "park":
      return LIGHT_CURVED;
    case "downtown":
    case "highrise":
    case "industrial":
      return LIGHT_SQUARE;
    case "commercial":
      return LIGHT_SQUARE_DOUBLE;
    case "wharf":
      return LIGHT_CURVED_CROSS;
  }
}

export async function buildFurniture(ctx: FurnitureCtx): Promise<FurnitureResult> {
  // Painted yield, time-gated: only give up the thread when ~a frame's worth
  // of work has accumulated — per-iteration yields would add seconds of pure
  // frame-waiting across 195k-cell loops.
  let lastYield = performance.now();
  const breathe = async (): Promise<void> => {
    if (performance.now() - lastYield < 12) return;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    lastYield = performance.now();
  };
  const {
    plan,
    network,
    terrain,
    roadDrape,
    groundOffset,
    cache,
    rng,
    reserved,
    facadeAt,
    worldX,
    worldZ,
  } = ctx;
  const objects: THREE.Object3D[] = [];
  const solids: Solid[] = [];
  const openWaterCells = new Set<string>();
  const pierDecks: PierDeck[] = [];
  const parkedCars: ParkedSpec[] = [];
  const lampHeads: LampHead[] = [];

  const roadAt = (gx: number, gz: number): RoadResolved | null =>
    inBounds(gx, gz) ? (plan.roads[gx]?.[gz] ?? null) : null;
  // Lots on non-cardinal streets rotate their building to the edge tangent —
  // faceDir-relative dressing (fences, awnings, back-corner clutter) would
  // misalign there.
  // Would a prop at (x, z) stand on the asphalt of any nearby edge?
  const onAsphalt = (x: number, z: number, margin = 0.3): boolean => {
    const hit = network.nearest(x, z, ROAD_TILE * 1.4);
    return hit !== null && hit.dist < hit.edge.half + margin;
  };
  // The height of the surface a prop actually STANDS ON. The raw height field
  // is neither of the two things that get drawn: inside the paved corridor the
  // kerb/sidewalk drape through the street terrace (±2.4u on the hill grid),
  // and outside it the ground mesh linearly smears the street depression and
  // the terrace over its ~9u lattice. Seating on terrain.heightAt buried or
  // floated a prop by up to the full terrace cap — half a lamp post gone.
  const surfaceAt = makeStandingSurface(network, terrain, groundOffset, roadDrape);
  // Lot decals (front paths, fences, Stow Lake) conform to the GROUND MESH as
  // drawn rather than to the field it samples — the coarse lattice was the
  // second error LOT_DECAL_LIFT had to clear, and clearing it by floating is
  // what a decal must never do.
  const groundDrape: DrapeField = {
    heightAt: (x: number, z: number): number => terrain.renderedHeightAt(x, z, groundOffset),
    normalInto: (out: THREE.Vector3, x: number, z: number): THREE.Vector3 =>
      terrain.normalInto(out, x, z),
  };
  const nonCardinalStreet = (gx: number, gz: number): boolean => {
    const hit = network.nearest(worldX(gx), worldZ(gz), ROAD_TILE * 1.6);
    if (!hit) return false;
    return Math.abs(Math.sin(2 * Math.atan2(hit.tx, hit.tz))) >= 0.18;
  };
  const cellAt = (gx: number, gz: number): "road" | "lot" | "water" | null =>
    inBounds(gx, gz) ? (plan.cells[gx]?.[gz] ?? null) : null;
  // Road axis from actual neighbours — tile quarterTurns encode the tile set's
  // native orientation and flip when the set changes; neighbours never lie.
  const straightAlongX = (gx: number, gz: number): boolean =>
    cellAt(gx + 1, gz) === "road" || cellAt(gx - 1, gz) === "road";
  const centreX = (GRID_X - 1) / 2;
  const centreZ = (GRID_Z - 1) / 2;
  const nearCentre = (gx: number, gz: number, r: number): boolean =>
    Math.hypot(gx - centreX, gz - centreZ) <= r;

  // Place a cached model with world transform baked (caller merges).
  const place = (url: string, x: number, y: number, z: number, yaw: number, s: number): void => {
    const node = cache.instance(url);
    node.scale.setScalar(s);
    node.rotation.y = yaw;
    node.position.set(x, y, z);
    node.updateMatrixWorld(true);
    objects.push(node);
  };
  // WHERE A MODEL STANDS vs WHERE ITS INSTANCE MATRIX SAYS IT IS. Every kit
  // model this module seats is authored feet-at-origin — measured, all of
  // props/ and parks/: the horizontal centroid of each model's lowest slab of
  // geometry is within 2cm of its own origin — so seating the node on (x, z)
  // does put the trunk, the pole base or the bench legs on (x, z).
  //
  // What is NOT at (x, z) is the MESH NODE inside the GLB. kk-tree-b's mesh
  // node carries the authoring offset (0.387, 0.542, −0.065) and its vertices
  // carry the opposite, so the tree stands right while the mesh's world matrix
  // — the only thing the bake serializes per instance, and therefore the only
  // position any offline audit can see — sits ~1.7u away from the trunk once
  // the tree is fitted to a 5.6u crown. Nothing to correct HERE — shifting the
  // node would move the tree off the spot it is meant to stand on. The fix is
  // to bake that node transform into the geometry in assets/loader.ts, the one
  // place that runs on BOTH load paths (the baked path resolves each instance
  // back out of the GLB by url + mesh index, so a fix applied at generation
  // time would move every tree on a cache hit and nowhere else).
  // Grid-cell placement math and the vector asphalt disagree along diagonal
  // spines and wide junction aprons (~21% of edge length by design) — every
  // ground-seated prop must check the ACTUAL asphalt or it ends up standing
  // in the roadway (the "cardboard boxes on the street" report). Passes that
  // belong on asphalt (construction chicanes) opt in via allowAsphalt.
  const seat = (
    url: string,
    x: number,
    z: number,
    yaw: number,
    s: number,
    allowAsphalt = false,
  ): boolean => {
    if (!allowAsphalt && onAsphalt(x, z, 0.2)) return false;
    place(url, x, surfaceAt(x, z), z, yaw, s);
    return true;
  };
  // KayKit variants: same as place/seat but tinted toward the Kenney palette.
  const placeKK = (url: string, x: number, y: number, z: number, yaw: number, s: number): void => {
    const node = cache.instance(url);
    tintNode(node, KK_TINT, KK_TINT_AMT);
    node.scale.setScalar(s);
    node.rotation.y = yaw;
    node.position.set(x, y, z);
    node.updateMatrixWorld(true);
    objects.push(node);
  };
  const seatKK = (url: string, x: number, z: number, yaw: number, s: number): boolean => {
    if (onAsphalt(x, z, 0.2)) return false;
    placeKK(url, x, surfaceAt(x, z), z, yaw, s);
    return true;
  };
  // True when a 4-neighbor is a junction tile (crossroad or T).
  const nextToJunction = (gx: number, gz: number): boolean => {
    for (const d of DIRS) {
      const [dx, dz] = DIR_DELTA[d];
      const nb = roadAt(gx + dx, gz + dz);
      if (nb && (nb.kind === "cross" || nb.kind === "tee")) return true;
    }
    return false;
  };
  const scaleToHeight = (url: string, h: number): number =>
    h / Math.max(cache.bounds(url).size.y, 0.001);
  // Bake a node to world space, drape its geometry over the terrain, and emit
  // identity-transform meshes (thin ground pieces: fences, paths, the lake).
  const drape = (node: THREE.Object3D, lift: number): void => {
    node.updateMatrixWorld(true);
    node.traverse((c) => {
      if (!(c instanceof THREE.Mesh) || !(c.geometry instanceof THREE.BufferGeometry)) return;
      const mat = c.material;
      if (Array.isArray(mat)) return;
      const baked = c.geometry.clone();
      baked.applyMatrix4(c.matrixWorld);
      const mesh = new THREE.Mesh(conformToTerrain(baked, groundDrape, lift), mat);
      mesh.updateMatrixWorld(true);
      // Unique world-baked buffers belong in the chunk MERGE path (like road
      // ribbons) — as batch items they bloat buckets with one-off geometries.
      mesh.userData.merge = true;
      // Textured (colormap) material can't serialize as a descriptor — carry
      // the source ref so the city-rest cache resolves it from the GLB.
      if (c.userData.src) mesh.userData.srcMat = c.userData.src;
      objects.push(mesh);
    });
  };
  // World-baked box helper (pier railings, seawall lips).
  const box = (
    mat: THREE.Material,
    sx: number,
    sy: number,
    sz: number,
    x: number,
    y: number,
    z: number,
  ): void => {
    const mesh = new THREE.Mesh(UNIT_BOX, mat);
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(x, y, z);
    mesh.updateMatrixWorld(true);
    objects.push(mesh);
  };

  // A junction corner pad is real sidewalk only when the diagonal block is not
  // road (a road there merges the corner into an asphalt plaza).
  const cornerClean = (gx: number, gz: number, sx: 1 | -1, sz: 1 | -1): boolean =>
    cellAt(gx + sx, gz + sz) !== "road";

  // districtAt takes GRID coords — feeding it normalized 0..1 map fractions
  // (the old bug here) made every lookup land on the map's NW corner (a park
  // district), so inPark was constant-true and the streetlight walk placed
  // ZERO lamps on every build.
  const inPark = (x: number, z: number): boolean =>
    districtAt(Math.floor((x + WORLD_W / 2) / ROAD_TILE), Math.floor((z + WORLD_H / 2) / ROAD_TILE))
      .character === "park";

  // ------------------------------------------------------------------
  // KERB-ANCHORED DRESSING: shared machinery for passes 15-21.
  //
  // Everything here works off the VECTOR edges, never the grid cell centre —
  // that disagreement is what put the old suburban lot kit in the wrong place
  // and it is the same reason the frontage/awning work below measures from
  // `edge.half` rather than from `ROAD_TILE`.
  // ------------------------------------------------------------------
  // Nothing prevented two passes claiming the same square metre of pavement, so
  // lamps grew benches out of their poles. A claim hash fixes that once for
  // every pass that follows, and the existing passes retro-claim into it.
  const claims = new Map<string, [number, number][]>();
  const claim = (x: number, z: number): void => {
    const k = claimKey(x, z);
    const list = claims.get(k);
    if (list) list.push([x, z]);
    else claims.set(k, [[x, z]]);
  };
  const claimFree = (x: number, z: number, r: number): boolean => {
    const bx = Math.floor(x / 8);
    const bz = Math.floor(z / 8);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = claims.get(`${bx + i},${bz + j}`);
        if (!list) continue;
        for (const [px, pz] of list) {
          if (Math.hypot(px - x, pz - z) < r) return false;
        }
      }
    }
    return true;
  };
  /** Claim-and-place in one step: false when the spot is taken or on asphalt. */
  const claimSeat = (x: number, z: number, r: number): boolean => {
    if (!claimFree(x, z, r)) return false;
    if (onAsphalt(x, z, 0.25)) return false;
    claim(x, z);
    return true;
  };

  // Place a merged kit at a world spot. One batch item per material, TRS-
  // encodable (yaw + uniform scale), so the bake cost is ~38 B per item.
  const placeKit = (
    parts: readonly KitPart[],
    x: number,
    y: number,
    z: number,
    yaw: number,
    s = 1,
    tint?: THREE.Color,
  ): void => {
    for (const p of parts) {
      const mesh = new THREE.Mesh(p.geo, p.mat);
      mesh.position.set(x, y, z);
      mesh.rotation.y = yaw;
      mesh.scale.setScalar(s);
      if (tint) mesh.userData.tint = tint;
      mesh.updateMatrixWorld(true);
      objects.push(mesh);
    }
  };
  const WIRE_DIR = new THREE.Vector3();
  // One sagging span between two points. The aim quaternion is not yaw-only, so
  // these are the only props in this module that cost a 64 B exact matrix on
  // top of the item record — budgeted for in the corridor caps below.
  const placeWire = (
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ): void => {
    const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    if (len < 1) return;
    const mesh = new THREE.Mesh(wireKit()[0]?.geo ?? UNIT_BOX, WIRE_MAT);
    mesh.position.set(x0, y0, z0);
    mesh.quaternion.setFromUnitVectors(
      X_AXIS,
      WIRE_DIR.set((x1 - x0) / len, (y1 - y0) / len, (z1 - z0) / len),
    );
    mesh.scale.setScalar(len);
    mesh.updateMatrixWorld(true);
    objects.push(mesh);
  };

  // --- Real transit, resolved onto our own asphalt (src/world/sf-transit.ts).
  // Corridors are lists of SF_EDGES indices, so a wire, a rail stop or a blade
  // placed on them is on the real street BY CONSTRUCTION — nothing is traced.
  const edgeStreet = new Map<number, string>();
  const streetLength = new Map<string, number>();
  const modeEdges = new Map<TransitMode, Set<number>>();
  for (const mode of TRANSIT_MODES) {
    const set = new Set<number>();
    for (const corridor of SF_TRANSIT[mode]) {
      for (const id of corridor.edges) {
        set.add(id);
        if (corridor.street) edgeStreet.set(id, corridor.street);
      }
      if (corridor.street) {
        streetLength.set(
          corridor.street,
          (streetLength.get(corridor.street) ?? 0) + corridor.lengthU,
        );
      }
    }
    modeEdges.set(mode, set);
  }
  // `network.edges` is DENSE but SF_EDGES is sparse, so array position is not
  // the coverage-list index — `edge.id` is. Index by it.
  const byEdgeId = new Map<number, NetEdge>();
  for (const edge of network.edges) byEdgeId.set(edge.id, edge);
  const edgeById = (id: number): NetEdge | null => byEdgeId.get(id) ?? null;
  /** The longest corridors of one mode, longest first — the "top N" slice. */
  const topCorridors = (mode: TransitMode, n: number): readonly NetEdge[] => {
    const out: NetEdge[] = [];
    for (const corridor of SF_TRANSIT[mode].slice(0, n)) {
      for (const id of corridor.edges) {
        const edge = edgeById(id);
        if (edge) out.push(edge);
      }
    }
    return out;
  };

  // Walk one edge's kerb, skipping the junction trims, and hand back a seated
  // kerbside point on the requested side. This is the primitive every dressing
  // pass below shares — the streetlight walk's shape, extracted.
  const kerbWalk = (
    edge: NetEdge,
    spacing: number,
    lateral: number,
    visit: (p: KerbPoint) => void,
    sideOf?: (s: number) => 1 | -1,
  ): void => {
    const trimA = network.nodeTrim(edge.a) + 2.5;
    const trimB = network.nodeTrim(edge.b) + 2.5;
    if (edge.len - trimA - trimB < spacing * 0.5) return;
    for (let s = trimA + spacing * 0.5; s < edge.len - trimB; s += spacing) {
      const side: 1 | -1 = sideOf ? sideOf(s) : rng.chance(0.5) ? 1 : -1;
      const smp = network.sample(edge, s);
      const off = (edge.half + lateral) * side;
      const px = smp.x - smp.tz * off;
      const pz = smp.z + smp.tx * off;
      const gx = toGx(px);
      const gz = toGz(pz);
      if (!inBounds(gx, gz)) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      visit({
        x: px,
        z: pz,
        tx: smp.tx,
        tz: smp.tz,
        side,
        half: edge.half,
        district: districtAt(gx, gz),
      });
    }
  };
  // ------------------------------------------------------------------
  // 1. STREETLIGHTS — walked along network EDGES every ~2 tiles, alternating
  // sides, clear of junction trims. Works identically on axis streets,
  // diagonals and curves.
  // ------------------------------------------------------------------
  const lightSide = new Map<string, 1 | -1>(); // cell -> lamp side (bench clash check)
  const LAMP_SPACING = ROAD_TILE * 4.5;
  let lampFlip = false;
  for (const edge of network.edges) {
    await breathe();
    const mid = network.sample(edge, edge.len / 2);
    if (inPark(mid.x, mid.z)) continue; // park promenades stay unlit + unparked
    const trimA = network.nodeTrim(edge.a) + 2;
    const trimB = network.nodeTrim(edge.b) + 2;
    for (let s = trimA + LAMP_SPACING * 0.5; s < edge.len - trimB; s += LAMP_SPACING) {
      lampFlip = !lampFlip;
      const side: 1 | -1 = lampFlip ? 1 : -1;
      const smp = network.sample(edge, s);
      const off = (edge.half + 0.6) * side;
      const px = smp.x - smp.tz * off;
      const pz = smp.z + smp.tx * off;
      const gx = toGx(px);
      const gz = toGz(pz);
      if (reserved.has(cellKey(gx, gz))) continue;
      // Arm points back at the road centreline. The Kenney lamp arms run
      // along LOCAL -Z (bbox z -0.2..0.025) — the old +Z assumption swung
      // every arm out over the houses ("street lights face the wrong way").
      const yaw = Math.atan2(-smp.tz * side, smp.tx * side);
      const char = districtAt(gx, gz).character;
      const groundY = surfaceAt(px, pz);
      // A lamp 0.6 off ITS edge can still stand on a NEIGHBOUring edge's
      // asphalt (junction aprons, parallel diagonal spines) — seat() skips
      // there, and the glow head must skip with it or it floats unpoled.
      if (char === "victorian") {
        const url = modelUrl("props", LIGHT_OLD);
        if (!seatKK(url, px, pz, yaw, scaleToHeight(url, VICTORIAN_LAMP_HEIGHT))) continue;
        lampHeads.push({
          x: px,
          y: groundY + VICTORIAN_LAMP_HEIGHT * 0.85,
          z: pz,
          ground: groundY,
        });
      } else {
        const url = modelUrl("props", lightFor(char));
        const sc = scaleToHeight(url, LIGHT_HEIGHT);
        if (!seat(url, px, pz, yaw, sc)) continue;
        const reach = cache.bounds(url).size.z * sc * 0.5;
        // Head hangs along the arm (local -Z).
        lampHeads.push({
          x: px - Math.sin(yaw) * reach,
          y: groundY + LIGHT_HEIGHT * 0.92,
          z: pz - Math.cos(yaw) * reach,
          ground: groundY,
        });
      }
      lightSide.set(cellKey(gx, gz), side);
      claim(px, pz); // trees + kerb clutter grow off a lamp post otherwise
    }
  }

  // ------------------------------------------------------------------
  // 2. PARKED CARS — kerbs of residential/victorian/commercial edges,
  // parked with the flow of their side of the street.
  // ------------------------------------------------------------------
  for (const edge of network.edges) {
    await breathe();
    const trimA = network.nodeTrim(edge.a) + 3;
    const trimB = network.nodeTrim(edge.b) + 3;
    for (let s = trimA; s < edge.len - trimB; s += ROAD_TILE) {
      if (!rng.chance(0.3)) continue;
      const smp = network.sample(edge, s);
      const gx = toGx(smp.x);
      const gz = toGz(smp.z);
      if (reserved.has(cellKey(gx, gz))) continue;
      if (nearCentre(gx, gz, 2)) continue;
      const char = districtAt(gx, gz).character;
      if (char !== "residential" && char !== "victorian" && char !== "commercial") continue;
      const side: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const off = (edge.half - 1.05) * side;
      const px = smp.x - smp.tz * off;
      const pz = smp.z + smp.tx * off;
      // 1.05u inside THIS edge's kerb is the parking strip — but where a WIDER
      // street crosses, that same point is out in ITS travel lane, which is how
      // 31 cars came to be parked mid-junction (worst 6.8u deep). Park only
      // where no other edge claims the spot as roadway.
      const owner = network.nearest(px, pz, ROAD_TILE * 1.4);
      if (owner && owner.edge.id !== edge.id && owner.dist < owner.edge.half - 1.05) continue;
      // Nose along the travel direction of this kerb's lane.
      const yaw = Math.atan2(smp.tx, smp.tz) + (side > 0 ? 0 : Math.PI) + rng.range(-0.04, 0.04);
      parkedCars.push({ x: px, z: pz, yaw, model: rng.pick(TRAFFIC_CARS) });
    }
  }

  // ------------------------------------------------------------------
  // 3/4/5. LOT DRESSING — awnings + parasols (commercial/wharf), yards
  // (residential/victorian), smokestack yards (industrial). One sweep over
  // buildingCells keeps the rng stream deterministic and cache-friendly.
  // ------------------------------------------------------------------
  // Mirrors the building pass: lots too steep to build get greenery, so no
  // awnings/fences/yard bits should orphan there either.
  const steepLot = (gx: number, gz: number): boolean => {
    const wx = worldX(gx);
    const wz = worldZ(gz);
    const fh = ROAD_TILE * 0.4;
    const hs = [
      terrain.heightAt(wx - fh, wz - fh),
      terrain.heightAt(wx + fh, wz - fh),
      terrain.heightAt(wx - fh, wz + fh),
      terrain.heightAt(wx + fh, wz + fh),
    ];
    // Match the building pass exactly (city.ts STEEP_CLIFF): it no longer
    // DELETES a hillside lot at 5u of fall, it steps the building into the
    // slope and only leaves a genuine cliff green. Keeping the old 5 stripped
    // the fences, paths and yards off every stepped hill lot.
    return Math.max(...hs) - Math.min(...hs) > STEEP_CLIFF;
  };
  for (const b of plan.buildingCells) {
    if (reserved.has(cellKey(b.gx, b.gz))) continue;
    if (steepLot(b.gx, b.gz)) continue;
    const district = districtAt(b.gx, b.gz);
    const [dx, dz] = DIR_DELTA[b.faceDir]; // toward the street
    if (nonCardinalStreet(b.gx, b.gz)) continue; // rotated building, skip dressing
    const perpX = dz; // lot-side axis (perpendicular to faceDir)
    const perpZ = dx;
    const wx = worldX(b.gx);
    const wz = worldZ(b.gz);

    // Cell-centre lot dressing is DELIBERATELY down to two cases. Awnings and
    // overhangs moved to the facade pass, which anchors on the row walk's front
    // plane instead of a lot edge; residential/victorian get nothing at all.
    // San Francisco has no front lawns, and the suburban kit that used to run
    // here dressed a lot the house was never in — buildings come from the row
    // walk at VECTOR-edge offsets (city.ts, `pose`), not at the grid cell
    // centre this pass measures from, so its ±6.11u side fences ringed an empty
    // cell and its "front path" ran from the kerb straight THROUGH the house to
    // the cell centre. Kerb-anchored dressing lives in passes 15-21.
    if (district.character === "wharf" && rng.chance(0.2)) {
      // Parasols near wharf street corners.
      const corner: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const px = wx + dx * ROAD_TILE * 0.38 + perpX * corner * ROAD_TILE * 0.3;
      const pz = wz + dz * ROAD_TILE * 0.38 + perpZ * corner * ROAD_TILE * 0.3;
      const url = modelUrl("props", rng.chance(0.5) ? PROP_PARASOL_A : PROP_PARASOL_B);
      seat(url, px, pz, rng.range(0, Math.PI * 2), scaleToHeight(url, 2.4));
    } else if (district.character === "industrial" && rng.chance(0.5)) {
      // Dogpatch skyline: 1–2 smokestacks at the lot's back corners.
      const stacks = 1 + rng.int(2);
      const firstCorner: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      for (let i = 0; i < stacks; i++) {
        const corner = i === 0 ? firstCorner : -firstCorner;
        const url = modelUrl("props", rng.pick(CHIMNEYS));
        const px = wx - dx * ROAD_TILE * 0.32 + perpX * corner * ROAD_TILE * 0.3;
        const pz = wz - dz * ROAD_TILE * 0.32 + perpZ * corner * ROAD_TILE * 0.3;
        seat(url, px, pz, rng.range(0, Math.PI * 2), scaleToHeight(url, rng.range(6, 11)));
      }
      if (rng.chance(0.3)) {
        const url = modelUrl("props", PROP_TANK);
        const px = wx - dx * ROAD_TILE * 0.3;
        const pz = wz - dz * ROAD_TILE * 0.3;
        seat(url, px, pz, rng.range(0, Math.PI * 2), scaleToHeight(url, 4));
      }
    }
  }

  // ------------------------------------------------------------------
  // 6. CONSTRUCTION POCKETS — cone chicanes on real edge shoulders.
  // ------------------------------------------------------------------
  {
    const eligible = network.edges.filter((e) => e.len > 60);
    const coneUrl = modelUrl("props", PROP_CONE);
    const coneScale = scaleToHeight(coneUrl, 0.75);
    const barrierUrl = modelUrl("props", PROP_BARRIER);
    const lightUrl = modelUrl("props", PROP_CONSTRUCTION_LIGHT);
    for (let p = 0; p < CONSTRUCTION_POCKETS && eligible.length > 0; p++) {
      const edge = eligible[rng.int(eligible.length)];
      if (!edge) continue;
      const s0 = rng.range(edge.len * 0.25, edge.len * 0.7);
      const smp = network.sample(edge, s0);
      const gx = toGx(smp.x);
      const gz = toGz(smp.z);
      if (reserved.has(cellKey(gx, gz)) || nearCentre(gx, gz, 3)) continue;
      const side: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      // Diagonal from the lane edge in to the centreline — a chicane.
      const at = (t: number) => {
        const p2 = network.sample(edge, s0 + (t - 0.5) * 8);
        const lat = side * (edge.half - 1) * (1 - t);
        return { x: p2.x - p2.tz * lat, z: p2.z + p2.tx * lat };
      };
      const cones = 3 + rng.int(2);
      for (let i = 0; i < cones; i++) {
        const t = cones > 1 ? i / (cones - 1) : 0.5;
        const pos = at(t);
        seat(
          coneUrl,
          pos.x + rng.range(-0.3, 0.3),
          pos.z + rng.range(-0.3, 0.3),
          rng.range(0, Math.PI * 2),
          coneScale,
          true, // chicanes live on the asphalt by design
        );
      }
      const bPos = at(0.5);
      const bYaw = Math.atan2(smp.tz, -smp.tx); // long axis across the lane
      seat(barrierUrl, bPos.x, bPos.z, bYaw, scaleToHeight(barrierUrl, 1.1), true);
      solids.push({
        minX: bPos.x - 1,
        maxX: bPos.x + 1,
        minZ: bPos.z - 1,
        maxZ: bPos.z + 1,
        maxY: surfaceAt(bPos.x, bPos.z) + 1.6,
      });
      const lPos = at(0.08);
      seat(lightUrl, lPos.x, lPos.z, bYaw, scaleToHeight(lightUrl, 2), true);
      // A parked work vehicle behind the chicane sells the site: tractor or
      // shovel-loader on the coned-off shoulder, nose along the lane.
      if (rng.chance(0.75)) {
        const vUrl = modelUrl("cars", rng.pick(CONSTRUCTION_VEHICLES));
        const vPos = at(0.85);
        const vYaw = Math.atan2(smp.tx, smp.tz) + (rng.chance(0.5) ? 0 : Math.PI);
        seat(vUrl, vPos.x, vPos.z, vYaw + rng.range(-0.15, 0.15), scaleToHeight(vUrl, 1.9), true);
        solids.push({
          minX: vPos.x - 1.2,
          maxX: vPos.x + 1.2,
          minZ: vPos.z - 1.2,
          maxZ: vPos.z + 1.2,
          maxY: surfaceAt(vPos.x, vPos.z) + 1.9,
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // 7. GOLDEN GATE PARK — tree allées on the edge bands, planter flower
  // beds, and Stow Lake.
  // ------------------------------------------------------------------
  const isGGPark = (gx: number, gz: number): boolean =>
    inBounds(gx, gz) && districtAt(gx, gz).name === "Golden Gate Park";
  const treeUrl = modelUrl("props", TREE_LARGE);
  const planterUrl = modelUrl("props", PROP_PLANTER);
  const planterScale = 1.5 / Math.max(cache.bounds(planterUrl).size.x, 0.001);
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
      await breathe();
      if (!isGGPark(gx, gz)) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      if (cellAt(gx, gz) !== "lot") continue; // keep park roads + water clear
      const wx = worldX(gx);
      const wz = worldZ(gz);
      // Regular allées along the park's north/south edge bands (spacing T/2).
      const edges: number[] = [];
      if (!isGGPark(gx, gz - 1)) edges.push(-1);
      if (!isGGPark(gx, gz + 1)) edges.push(1);
      for (const edge of edges) {
        const tz = wz + edge * (ROAD_TILE * 0.5 - 0.9);
        for (const off of [-0.25, 0.25] as const) {
          const tx = wx + off * ROAD_TILE;
          if (onAsphalt(tx, tz, 1.6)) continue; // smoothed diagonals cut raster lots
          const planted = seat(
            treeUrl,
            tx,
            tz,
            rng.range(0, Math.PI * 2),
            scaleToHeight(treeUrl, rng.range(5, 6.5)),
          );
          if (planted) {
            solids.push({
              minX: tx - 0.55,
              maxX: tx + 0.55,
              minZ: tz - 0.55,
              maxZ: tz + 0.55,
              noBody: true,
            });
          }
        }
      }
      // Planter clusters as flower beds.
      if (rng.chance(0.25)) {
        const count = 3 + rng.int(3);
        for (let i = 0; i < count; i++) {
          const px = wx + rng.range(-2.6, 2.6);
          const pz = wz + rng.range(-2.6, 2.6);
          if (onAsphalt(px, pz, 1.2)) continue;
          seat(planterUrl, px, pz, rng.range(0, Math.PI * 2), planterScale);
        }
      }
    }
  }
  // Stow Lake: a flat blue ellipse draped into the park bowl. Its extent comes
  // from GGP_LAKE (world/land-class.ts), which is also the ellipse the ground
  // painter fills with water — one definition, so the mesh and the paint cannot
  // drift apart.
  const lakeGx = Math.round(GGP_LAKE.u * GRID_X - 0.5);
  const lakeGz = Math.round(GGP_LAKE.v * GRID_Z - 0.5);
  if (isGGPark(lakeGx, lakeGz) && !reserved.has(cellKey(lakeGx, lakeGz))) {
    const lake = new THREE.Mesh(new THREE.CircleGeometry(1, 48), LAKE_MAT);
    lake.scale.set(GGP_LAKE.ru, GGP_LAKE.rv, 1);
    lake.rotation.x = -HALF_PI;
    lake.position.set((GGP_LAKE.u - 0.5) * WORLD_W, 0, (GGP_LAKE.v - 0.5) * WORLD_H);
    drape(lake, LOT_DECAL_LIFT);
  }

  // ------------------------------------------------------------------
  // 7b. PARK BLOCKS (all park districts) — the KayKit-sample look: low
  // stone walls with entry gates on road-facing edges, fountains where
  // tan paths cross, benches + lamps around them, bushes and blobby
  // KayKit trees filling the lawns.
  // ------------------------------------------------------------------
  // Park land per world/land-class.ts — the ONE ground-class rule. Identical
  // in behaviour to the `districtAt(...).character === "park"` copy this
  // replaced; single-sourced so it cannot drift from the paint.
  const isParkCell = (gx: number, gz: number): boolean =>
    inBounds(gx, gz) && cellAt(gx, gz) === "lot" && isParkDistrictLand(gx, gz);
  // Park-cleared street corridors: the OLD OSM street lines through parks
  // (removed from the shipped mask by bake-time park clipping) become KayKit
  // pedestrian PATHS — JFK Drive as a promenade. PARK_PATH_MASK is exactly those
  // removed park-interior street cells. A path cell connects to sibling path
  // cells and to the street at the park edge (the old entrances).
  const isPathCell = (gx: number, gz: number): boolean =>
    inBounds(gx, gz) && cellAt(gx, gz) === "lot" && parkPathMaskAt(gx, gz);
  const pathMask = (gx: number, gz: number): number => {
    let mask = 0;
    for (const d of DIRS) {
      const [dx, dz] = DIR_DELTA[d];
      if (isPathCell(gx + dx, gz + dz) || cellAt(gx + dx, gz + dz) === "road") mask |= 1 << d;
    }
    return mask;
  };
  // KayKit park-road autotile. Native masks assume the kit's straight runs
  // along local Z (N|S), matching the wall pieces; corner S|W, tsplit E|S|W
  // (open toward +Z) — verified visually, adjust here if a piece reads wrong.
  const pathTileFor = (mask: number): { name: string; quarter: number } | null => {
    const bit = (d: Dir): boolean => (mask & (1 << d)) !== 0;
    const count = (mask & 1 ? 1 : 0) + (mask & 2 ? 1 : 0) + (mask & 4 ? 1 : 0) + (mask & 8 ? 1 : 0);
    if (count >= 4) return { name: "park-road-junction", quarter: 0 };
    if (count === 3) {
      // tsplit closed side: the missing direction.
      const missing = ([N, E, S, W] as const).find((d) => !bit(d)) ?? N;
      const q = { [N]: 0, [E]: 1, [S]: 2, [W]: 3 }[missing] ?? 0;
      return {
        name: rng.chance(0.5) ? "park-road-tsplit" : "park-road-tsplit-decorated",
        quarter: q,
      };
    }
    if (count === 2) {
      if (bit(N) && bit(S)) return { name: pathStraight(), quarter: 0 };
      if (bit(E) && bit(W)) return { name: pathStraight(), quarter: 1 };
      // corners: base S|W, rotate CCW-order N,E,S,W
      if (bit(S) && bit(W)) return { name: cornerName(), quarter: 0 };
      if (bit(W) && bit(N)) return { name: cornerName(), quarter: 1 };
      if (bit(N) && bit(E)) return { name: cornerName(), quarter: 2 };
      if (bit(E) && bit(S)) return { name: cornerName(), quarter: 3 };
    }
    if (count === 1) {
      // dead-end: run a straight toward the single neighbour.
      return { name: pathStraight(), quarter: bit(N) || bit(S) ? 0 : 1 };
    }
    return null;
  };
  const pathStraight = (): string =>
    rng.chance(0.5)
      ? "park-road-straight"
      : rng.chance(0.5)
        ? "park-road-straight-decorated-A"
        : "park-road-straight-decorated-B";
  const cornerName = (): string =>
    rng.chance(0.5) ? "park-road-corner" : "park-road-corner-decorated";
  const wallUrl = modelUrl("props", PARK_WALL);
  const wallBounds = cache.bounds(wallUrl);
  const wallH = 1.1 / Math.max(wallBounds.size.y, 0.001); // low stone wall
  const parkBenchUrl = modelUrl("props", PROP_BENCH);
  const parkLampUrl = modelUrl("props", LIGHT_OLD);
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
      await breathe();
      if (!isParkCell(gx, gz)) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      const wx = worldX(gx);
      const wz = worldZ(gz);
      // Smoothed diagonals cut through raster park lots — leave those as lawn.
      if (onAsphalt(wx, wz, ROAD_TILE * 0.55)) continue;

      // Walls + a centre entry on every edge that faces a road.
      for (const d of DIRS) {
        const [dx, dz] = DIR_DELTA[d];
        if (cellAt(gx + dx, gz + dz) !== "road") continue;
        const edgeOff = ROAD_TILE / 2 - 0.5;
        const along = dx === 0 ? "x" : "z"; // wall runs perpendicular to dir
        const runLen = ROAD_TILE / 2 - 2.2; // leave a 4.4u centre gap
        // The KayKit wall piece runs along its LOCAL Z — scale the run there
        // and yaw so that axis lies along the park edge (X-edges need the 90°).
        const wallRun = runLen / Math.max(wallBounds.size.z, 0.001);
        for (const side of [-1, 1] as const) {
          const mid = side * (2.2 + runLen / 2);
          const px = along === "x" ? wx + mid : wx + dx * edgeOff;
          const pz = along === "x" ? wz + dz * edgeOff : wz + mid;
          // A 4.3u run tested on its MIDPOINT alone put both ends of six of
          // these walls in the asphalt of a street the park corner meets at an
          // angle; the collision box is the whole run, so test the whole run.
          const halfRun = runLen / 2;
          const ax = along === "x" ? halfRun : 0;
          const az = along === "x" ? 0 : halfRun;
          if (
            onAsphalt(px, pz, 1) ||
            onAsphalt(px - ax, pz - az, 1) ||
            onAsphalt(px + ax, pz + az, 1)
          ) {
            continue;
          }
          const wall = cache.instance(wallUrl);
          wall.scale.set(wallH, wallH, wallRun);
          wall.rotation.y = along === "x" ? HALF_PI : 0;
          // A rigid run seated on its MIDPOINT leaves an end in the air on any
          // slope — but seating it on the LOWEST of its ends, which is what
          // this did, sank 80 of them out of sight: a 4.3u run down a park
          // flank falls further than the wall is tall (1.1u), so the whole
          // piece ends up under the lawn. Seat on the midpoint, which is where
          // the run visually is and the only sample that tracks the surface
          // drawn beneath it, and give the downhill end something to stand on.
          const endA = along === "x" ? [px - runLen / 2, pz] : [px, pz - runLen / 2];
          const endB = along === "x" ? [px + runLen / 2, pz] : [px, pz + runLen / 2];
          const wallY = surfaceAt(px, pz);
          const lowY = Math.min(
            wallY,
            surfaceAt(endA[0] ?? px, endA[1] ?? pz),
            surfaceAt(endB[0] ?? px, endB[1] ?? pz),
          );
          wall.position.set(px, wallY, pz);
          wall.updateMatrixWorld(true);
          objects.push(wall);
          // Stone footing under the fall. Flat ground needs none, so most park
          // walls in the city emit nothing here.
          if (wallY - lowY > 0.15) {
            const drop = wallY - lowY + 0.25;
            const footing = new THREE.Mesh(WALL_FOOTING_BOX, SEAWALL_MAT);
            footing.scale.set(along === "x" ? runLen : 0.72, drop, along === "x" ? 0.72 : runLen);
            footing.position.set(px, wallY + 0.1 - drop / 2, pz);
            footing.updateMatrixWorld(true);
            objects.push(footing);
          }
          // Matching low solid so the wall is real (enter via the gate).
          const t = 0.5;
          solids.push(
            along === "x"
              ? {
                  minX: px - runLen / 2,
                  maxX: px + runLen / 2,
                  minZ: pz - t,
                  maxZ: pz + t,
                  maxY: wallY + 1.4,
                }
              : {
                  minX: px - t,
                  maxX: px + t,
                  minZ: pz - runLen / 2,
                  maxZ: pz + runLen / 2,
                  maxY: wallY + 1.4,
                },
          );
        }
        // Gate posts flanking the 4.4u entry gap. Two simple stone pillars —
        // taller than the wall — read as a park entrance without the KayKit
        // arch's orientation ambiguity. Each post samples the surface under
        // ITSELF: one sample at the gap's centre served both, and the pair
        // stands 4.4u apart, so on any park flank one pillar floated by the
        // fall across the gate.
        for (const side of [-2.2, 2.2] as const) {
          const px = along === "x" ? wx + side : wx + dx * edgeOff;
          const pz = along === "x" ? wz + dz * edgeOff : wz + side;
          if (onAsphalt(px, pz, 1)) continue;
          const post = new THREE.Mesh(GATE_POST_BOX, SEAWALL_MAT);
          post.scale.set(0.9, 2.4, 0.9);
          post.position.set(px, surfaceAt(px, pz) + 1.2, pz);
          post.updateMatrixWorld(true);
          objects.push(post);
        }
      }

      // KayKit prebuilt park tiles: one per cell — grass, bush and tree
      // bases with occasional decorated fountain plazas. The kit's own
      // benches/lamps/planting ride along; our per-tree scatter is gone.
      {
        // Slope threshold decides the treatment: FLAT cells take a kit tile
        // seated flush (no visible layering — neighbours are near-coplanar);
        // SLOPED cells get kit-tree clusters conforming to the hillside, so
        // parks flow over hills with no terraces at all.
        const seatY = parkCellHeight(terrain, gx, gz);
        const spread = seatY - 0.05 - parkCellFloor(terrain, gx, gz);
        // …but a cell's OWN corners do not know it is perched on a lip. A
        // park's edge above a bank is flat in itself and the tile there hangs
        // over the fall on its skirt, which is how Buena Vista got a green
        // slab on a pedestal. A tile is only honest where its skirt still
        // reaches whatever is drawn just outside the cell, so ask that
        // directly — the two constants are one rule.
        let lip = 0;
        for (let a = 0; a < 8; a++) {
          const th = (a / 8) * Math.PI * 2;
          const drop =
            seatY -
            surfaceAt(wx + Math.cos(th) * ROAD_TILE * 0.62, wz + Math.sin(th) * ROAD_TILE * 0.62);
          if (drop > lip) lip = drop;
        }
        const roll = rng.range(0, 1);
        if (spread <= 0.8 && lip <= PARK_SKIRT_DEPTH) {
          const path = isPathCell(gx, gz) ? pathTileFor(pathMask(gx, gz)) : null;
          const name =
            path?.name ??
            (spread < 0.3 && roll < 0.015
              ? rng.pick(PARK_TILE_PLAZAS)
              : roll < 0.4
                ? "park-base-decorated-trees"
                : roll < 0.6
                  ? "park-base-decorated-bushes"
                  : "park-base");
          const url = modelUrl("parks", name);
          const b = cache.bounds(url);
          const sc = ROAD_TILE / Math.max(b.size.x, b.size.z, 0.001);
          const node = cache.instance(url);
          node.scale.setScalar(sc);
          node.rotation.y = HALF_PI * (path ? path.quarter : rng.int(4));
          node.position.set(wx, seatY, wz);
          node.updateMatrixWorld(true);
          objects.push(node);
          // Skirt so the flush tile never shows a sliver of daylight under its
          // edge. Depth is CONSTANT and generous rather than fitted to this
          // cell's own fall: the gap to hide is the drop to whatever is drawn
          // just OUTSIDE the tile — the neighbouring terrace, the lawn below a
          // bank — which the cell's own corner spread does not measure, and a
          // 0.2u skirt on a flat cell beside a lower one left exactly the
          // sliver it exists to prevent. Buried depth costs nothing; it is
          // also what makes this a fixed-scale prop rather than one whose
          // height is a function of the terrain, so a seat audit can hold it
          // to a real baseline.
          const skirt = new THREE.Mesh(PARK_SKIRT_BOX, SEAWALL_MAT);
          skirt.scale.set(ROAD_TILE * 1.02, PARK_SKIRT_DEPTH, ROAD_TILE * 1.02);
          skirt.position.set(wx, seatY - PARK_SKIRT_DEPTH / 2, wz);
          skirt.updateMatrixWorld(true);
          objects.push(skirt);
          if (name === "park-base-decorated-trees") {
            solids.push({
              minX: wx - 0.6,
              maxX: wx + 0.6,
              minZ: wz - 0.6,
              maxZ: wz + 0.6,
              noBody: true,
            });
          }
        } else {
          // hillside: blobby kit-tree cluster straight on the terrain.
          // Solids go on each tree that actually SEATED, at its real spot —
          // a cluster-center solid was an invisible wall whenever the trees
          // scattered away from it or failed to seat entirely (asphalt).
          const clusters = 1 + rng.int(2);
          for (let c = 0; c < clusters; c++) {
            const cx2 = wx + rng.range(-4, 4);
            const cz2 = wz + rng.range(-4, 4);
            const count = 2 + rng.int(4);
            for (let i = 0; i < count; i++) {
              const tUrl = modelUrl("props", rng.pick(PARK_TREES));
              const ptx = cx2 + rng.range(-2.4, 2.4);
              const ptz = cz2 + rng.range(-2.4, 2.4);
              const planted = seat(
                tUrl,
                ptx,
                ptz,
                rng.range(0, Math.PI * 2),
                scaleToHeight(tUrl, rng.range(3.6, 5.6)),
              );
              if (planted) {
                solids.push({
                  minX: ptx - 0.55,
                  maxX: ptx + 0.55,
                  minZ: ptz - 0.55,
                  maxZ: ptz + 0.55,
                  noBody: true,
                });
              }
            }
          }
          if (rng.chance(0.5)) {
            const bUrl = modelUrl("props", rng.pick(BUSHES));
            seat(
              bUrl,
              wx + rng.range(-4, 4),
              wz + rng.range(-4, 4),
              rng.range(0, Math.PI * 2),
              scaleToHeight(bUrl, rng.range(0.9, 1.4)),
            );
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 8. WHARF PIERS — three piers off the Fisherman's Wharf shoreline,
  // flat road-tile decks on bridge-pillar stilts, railed so the taxi can
  // drive out but not fall off. The middle pier gets Pier 39 buildings.
  // ------------------------------------------------------------------
  type PierColumn = { gx: number; landGz: number };
  const pierCandidates: PierColumn[] = [];
  for (let gx = 0; gx < GRID_X; gx++) {
    let landGz = -1;
    for (let gz = 0; gz < GRID_Z; gz++) {
      await breathe();
      if (cellAt(gx, gz) !== "water") {
        landGz = gz;
        break;
      }
    }
    if (landGz < 2) continue; // need at least two water cells to the north
    if (districtAt(gx, landGz).name !== "Fisherman's Wharf") continue;
    // The pier must connect to something drivable: a shore road, or at least
    // an unbuilt lot (built lots have a solid the ramp would dead-end into).
    const shoreKind = cellAt(gx, landGz);
    const shoreBuilt = plan.buildingCells.some((b) => b.gx === gx && b.gz === landGz);
    if (shoreKind !== "road" && shoreBuilt) continue;
    let anyReserved = reserved.has(cellKey(gx, landGz));
    for (let gz = 0; gz < landGz; gz++) {
      if (reserved.has(cellKey(gx, gz))) anyReserved = true;
    }
    if (anyReserved) continue;
    pierCandidates.push({ gx, landGz });
  }
  const chosenPiers: PierColumn[] = [];
  if (pierCandidates.length > 0) {
    const idxs = [0, Math.floor((pierCandidates.length - 1) / 2), pierCandidates.length - 1];
    for (const i of idxs) {
      const col = pierCandidates[i];
      if (col && !chosenPiers.includes(col)) chosenPiers.push(col);
    }
  }
  const pillarUrl = modelUrl("roads", BRIDGE_PILLAR);
  const pillarBounds = cache.bounds(pillarUrl);
  for (let pierIdx = 0; pierIdx < chosenPiers.length; pierIdx++) {
    const pier = chosenPiers[pierIdx];
    if (pier === undefined) continue;
    const deckY = PIER_DECK_Y + pierIdx * 0.02; // stagger so adjacent decks never z-fight
    const len = Math.min(2 + rng.int(2), pier.landGz); // 2–3 tiles over water
    const px = worldX(pier.gx);
    const boundary = worldZ(pier.landGz) - ROAD_TILE / 2; // shore edge (water is north = -Z)
    // Deck tiles + stilts, one per water cell, flat at deck height.
    for (let i = 1; i <= len; i++) {
      const gz = pier.landGz - i;
      openWaterCells.add(cellKey(pier.gx, gz));
      // Generated deck slab — top face exactly at deck height.
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(PIER_WIDTH, 0.5, PIER_WIDTH),
        PIER_DECK_MAT,
      );
      tile.castShadow = true;
      tile.receiveShadow = true;
      tile.position.set(px, deckY - 0.25, worldZ(gz));
      tile.updateMatrixWorld(true);
      objects.push(tile);
      const pScale = 5.5 / Math.max(pillarBounds.size.y, 0.001);
      const pillar = cache.instance(pillarUrl);
      pillar.scale.setScalar(pScale);
      pillar.position.set(
        px,
        deckY - (pillarBounds.min.y + pillarBounds.size.y) * pScale,
        worldZ(gz),
      );
      pillar.updateMatrixWorld(true);
      objects.push(pillar);
    }
    // Ramp slab connecting the shore grid to the deck (pitched box; the car
    // rides the stepped surface rects below, the slab just has to match).
    const shoreH = terrain.heightAt(px, boundary + PIER_RAMP_RUN) + ROAD_Y;
    const drop = deckY - shoreH;
    const rampLen = Math.hypot(PIER_RAMP_RUN, drop);
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(PIER_WIDTH, 0.5, rampLen), PIER_DECK_MAT);
    ramp.castShadow = true;
    ramp.receiveShadow = true;
    ramp.rotation.x = Math.atan(drop / PIER_RAMP_RUN);
    ramp.position.set(px, (deckY + shoreH) / 2 - 0.25, boundary + PIER_RAMP_RUN / 2);
    ramp.updateMatrixWorld(true);
    objects.push(ramp);
    // Drivable surface rects: the flat deck plus stepped slices down the ramp
    // (callers snap the car to rect y inside these).
    const halfW = PIER_WIDTH / 2;
    const zNorth = worldZ(pier.landGz - len) - PIER_WIDTH / 2;
    pierDecks.push({ minX: px - halfW, maxX: px + halfW, minZ: zNorth, maxZ: boundary, y: deckY });
    const rampSteps = 3;
    for (let i = 0; i < rampSteps; i++) {
      pierDecks.push({
        minX: px - halfW,
        maxX: px + halfW,
        minZ: boundary + (PIER_RAMP_RUN * i) / rampSteps,
        maxZ: boundary + (PIER_RAMP_RUN * (i + 1)) / rampSteps,
        y: deckY + (shoreH - deckY) * ((i + 0.5) / rampSteps),
      });
    }
    // Wood railings (visual box + matching Solid): both sides + the far end.
    const railLen = boundary - zNorth;
    const railMidZ = (boundary + zNorth) / 2;
    for (const sideSign of [1, -1] as const) {
      const rx = px + sideSign * (halfW - 0.13);
      box(RAIL_MAT, 0.26, 0.6, railLen, rx, deckY + 0.3, railMidZ);
      solids.push({ minX: rx - 0.3, maxX: rx + 0.3, minZ: zNorth, maxZ: boundary });
    }
    box(RAIL_MAT, PIER_WIDTH, 0.6, 0.26, px, deckY + 0.3, zNorth + 0.13);
    solids.push({ minX: px - halfW, maxX: px + halfW, minZ: zNorth - 0.1, maxZ: zNorth + 0.4 });
    // Pier 39: two tinted commercial buildings at the middle pier's end.
    if (pierIdx === 1) {
      for (let i = 0; i < PIER_END_BUILDINGS.length; i++) {
        const name = PIER_END_BUILDINGS[i];
        if (name === undefined) continue;
        const url = modelUrl("buildings", name);
        const bnd = cache.bounds(url);
        const s = (ROAD_TILE * 0.4) / Math.max(bnd.size.x, bnd.size.z, 0.001);
        const bx = px + (i === 0 ? -1 : 1) * ROAD_TILE * 0.24;
        const bz = zNorth + ROAD_TILE * 0.35;
        const node = cache.instance(url);
        tintNode(node, PIER_BUILDING_TINT, 0.5);
        node.scale.setScalar(s);
        node.rotation.y = Math.PI; // face back down the pier toward shore
        node.position.set(bx, deckY, bz);
        node.updateMatrixWorld(true);
        objects.push(node);
        const half = ROAD_TILE * 0.19;
        solids.push({ minX: bx - half, maxX: bx + half, minZ: bz - half, maxZ: bz + half });
      }
    }
  }

  // ------------------------------------------------------------------
  // 10. FIRE HYDRANTS — sidewalk corners of walkable streets that feed a
  // junction (where SF actually puts them).
  // ------------------------------------------------------------------
  const hydrantUrl = modelUrl("props", PROP_HYDRANT);
  const hydrantScale = scaleToHeight(hydrantUrl, 0.9);
  let hydrants = 0;
  for (let gx = 0; gx < GRID_X && hydrants < HYDRANT_CAP; gx++) {
    for (let gz = 0; gz < GRID_Z && hydrants < HYDRANT_CAP; gz++) {
      if (!roadAt(gx, gz)) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      // Every street in San Francisco has hydrants, not just the three
      // characters this used to gate on — only the car-free parks are exempt.
      const char = districtAt(gx, gz).character;
      if (char === "park") continue;
      if (!nextToJunction(gx, gz)) continue;
      if (!rng.chance(0.45)) continue;
      let sx: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      let sz: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      // Slide around the tile until the corner is real sidewalk.
      let ok = false;
      for (let c = 0; c < 4 && !ok; c++) {
        if (cornerClean(gx, gz, sx, sz)) ok = true;
        else if (c % 2 === 0) sx = sx > 0 ? -1 : 1;
        else sz = sz > 0 ? -1 : 1;
      }
      if (!ok) continue;
      const px = worldX(gx) + sx * ROAD_TILE * 0.42;
      const pz = worldZ(gz) + sz * ROAD_TILE * 0.42;
      if (onAsphalt(px, pz)) continue;
      if (!claimFree(px, pz, 1.6)) continue;
      claim(px, pz);
      seatKK(hydrantUrl, px, pz, rng.range(0, Math.PI * 2), hydrantScale);
      hydrants++;
    }
  }

  // ------------------------------------------------------------------
  // 11. JUNCTION CONTROL HARDWARE — signals + stop signs. WHICH junctions
  // get what comes from junction-control.ts: the same pure function
  // traffic.ts obeys at runtime, so the street furniture can never disagree
  // with the behavior at the junction.
  // ------------------------------------------------------------------
  const signalUrl = modelUrl("props", PROP_TRAFFICLIGHT);
  const signalScale = scaleToHeight(signalUrl, 5);
  for (let n = 0; n < network.nodes.length; n++) {
    const control = junctionControl(network, n);
    if (control === "none") continue;
    const node = network.nodes[n];
    if (!node) continue;
    const arms = controlArms(network, n);
    if (control === "signal") {
      for (const a of arms) {
        // Right side of INCOMING traffic, past the crosswalk + stop bar.
        const px = a.px + a.tx * 4.6 + a.tz * (a.half + 1.2);
        const pz = a.pz + a.tz * 4.6 - a.tx * (a.half + 1.2);
        if (onAsphalt(px, pz)) continue;
        // The arm hangs along local -X; point it back toward the junction.
        const dl = Math.hypot(node[0] - px, node[1] - pz) || 1;
        const yaw = Math.atan2((node[1] - pz) / dl, -(node[0] - px) / dl);
        claim(px, pz);
        seatKK(signalUrl, px, pz, yaw, signalScale);
      }
      continue;
    }
    // All-way stop: one sign on the right of each approach.
    for (const a of arms) {
      const px = a.px + a.tx * 1.6 + a.tz * (a.half + 0.8);
      const pz = a.pz + a.tz * 1.6 - a.tx * (a.half + 0.8);
      if (onAsphalt(px, pz, 0.2)) continue;
      const gy = surfaceAt(px, pz);
      // Face plane normal points outward along the arm — straight at the
      // driver approaching the junction.
      const yaw = Math.atan2(a.tx, a.tz);
      claim(px, pz);
      const pole = new THREE.Mesh(STOP_POLE, POLE_MAT);
      pole.scale.y = 2.3;
      pole.position.set(px, gy + 1.15, pz);
      pole.updateMatrixWorld(true);
      const rim = new THREE.Mesh(STOP_RIM, STOP_WHITE_MAT);
      rim.rotation.y = yaw;
      rim.position.set(px, gy + 2.2, pz);
      rim.updateMatrixWorld(true);
      const face = new THREE.Mesh(STOP_FACE, STOP_RED_MAT);
      face.rotation.y = yaw;
      face.position.set(px + Math.sin(yaw) * 0.03, gy + 2.2, pz + Math.cos(yaw) * 0.03);
      face.updateMatrixWorld(true);
      objects.push(pole, rim, face);
    }
  }

  // ------------------------------------------------------------------
  // 12. BENCHES + TRASH — kerbs that front a lot or green get a bench facing
  // the street with a trash can beside it. Every walkable character qualifies:
  // gating on wharf/park alone left the shopping streets — the ones with people
  // waiting on them — bare.
  // ------------------------------------------------------------------
  const benchUrl = modelUrl("props", PROP_BENCH);
  const benchScale = scaleToHeight(benchUrl, 0.85);
  let seating = 0;
  for (let gx = 0; gx < GRID_X && seating < SEATING_CAP; gx++) {
    for (let gz = 0; gz < GRID_Z && seating < SEATING_CAP; gz++) {
      const road = roadAt(gx, gz);
      if (!road) continue;
      if (reserved.has(cellKey(gx, gz))) continue;
      const char = districtAt(gx, gz).character;
      if (char === "industrial" || char === "highrise") continue;
      let lotDir: Dir | null = null;
      for (const d of DIRS) {
        const [dx, dz] = DIR_DELTA[d];
        if (cellAt(gx + dx, gz + dz) === "lot") {
          lotDir = d;
          break;
        }
      }
      if (lotDir === null) continue;
      if (!rng.chance(char === "wharf" || char === "park" ? 0.4 : 0.16)) continue;
      const [dx, dz] = DIR_DELTA[lotDir];
      // If this cell's streetlight took the same kerb, slide down the block.
      const lampSide = lightSide.get(cellKey(gx, gz));
      const alongX = road.kind === "straight" && straightAlongX(gx, gz);
      const clash = lampSide !== undefined && (alongX ? dz : dx) === lampSide;
      const slide = clash ? ROAD_TILE * 0.24 : 0;
      // perp (dz, dx) runs along the kerb; lotDir is the lateral axis.
      const bx = worldX(gx) + dx * ROAD_TILE * 0.42 + dz * slide;
      const bz = worldZ(gz) + dz * ROAD_TILE * 0.42 + dx * slide;
      if (onAsphalt(bx, bz)) continue;
      if (!claimFree(bx, bz, 2.4)) continue;
      claim(bx, bz);
      // Back to the lot: bench long axis (local X) runs parallel to the road.
      seatKK(benchUrl, bx, bz, dirToYaw(lotDir) + Math.PI, benchScale);
      seating++;
      if (seating >= SEATING_CAP) break;
      const along: 1 | -1 = clash ? 1 : rng.chance(0.5) ? 1 : -1;
      const trashUrl = modelUrl("props", rng.chance(0.5) ? PROP_TRASH_A : PROP_TRASH_B);
      const trashBounds = cache.bounds(trashUrl);
      // KayKit's "trash" is a low kerbside pile, not a can — size it by
      // footprint (scaling to a can's height would blow it up 17×).
      const trashScale = 0.55 / Math.max(trashBounds.size.x, trashBounds.size.z, 0.001);
      seatKK(
        trashUrl,
        bx + dz * along * 1.3,
        bz + dx * along * 1.3,
        rng.range(0, Math.PI * 2),
        trashScale,
      );
      seating++;
    }
  }

  // ------------------------------------------------------------------
  // 13. DUMPSTERS + CRATES — service clutter at industrial back corners
  // (offsets tucked inside the smokestack ring so the two passes coexist).
  // ------------------------------------------------------------------
  const dumpsterUrl = modelUrl("props", PROP_DUMPSTER);
  const dumpsterScale = scaleToHeight(dumpsterUrl, 1.5);
  for (const b of plan.buildingCells) {
    if (reserved.has(cellKey(b.gx, b.gz))) continue;
    if (districtAt(b.gx, b.gz).character !== "industrial") continue;
    const [dx, dz] = DIR_DELTA[b.faceDir];
    if (nonCardinalStreet(b.gx, b.gz)) continue; // rotated building
    const perpX = dz;
    const perpZ = dx;
    const wx = worldX(b.gx);
    const wz = worldZ(b.gz);
    if (rng.chance(0.4)) {
      const corner: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const px = wx - dx * ROAD_TILE * 0.4 + perpX * corner * ROAD_TILE * 0.16;
      const pz = wz - dz * ROAD_TILE * 0.4 + perpZ * corner * ROAD_TILE * 0.16;
      // Long axis (local X) parallel to the back wall, hand-shoved jitter.
      seatKK(dumpsterUrl, px, pz, dirToYaw(b.faceDir) + rng.range(-0.08, 0.08), dumpsterScale);
    }
    if (rng.chance(0.5)) {
      const crates = 1 + rng.int(2);
      for (let i = 0; i < crates; i++) {
        const url = modelUrl("props", rng.chance(0.5) ? PROP_BOX_A : PROP_BOX_B);
        const back = 0.28 + rng.range(0, 0.1);
        const lat = rng.range(-0.24, 0.24);
        const px = wx - dx * ROAD_TILE * back + perpX * lat * ROAD_TILE;
        const pz = wz - dz * ROAD_TILE * back + perpZ * lat * ROAD_TILE;
        seatKK(url, px, pz, rng.range(0, Math.PI * 2), scaleToHeight(url, 0.8));
      }
    }
  }

  // ------------------------------------------------------------------
  // 14. WATER TOWERS — 2–3 tank-on-legs landmarks for the Dogpatch skyline,
  // tall enough that the tank clears the host building's roofline.
  // ------------------------------------------------------------------
  const towerLots = plan.buildingCells.filter((b) => {
    if (reserved.has(cellKey(b.gx, b.gz))) return false;
    if (districtAt(b.gx, b.gz).character !== "industrial") return false;
    return !nonCardinalStreet(b.gx, b.gz); // rotated buildings opt out
  });
  const towerUrl = modelUrl("props", PROP_WATERTOWER);
  const towerScale = scaleToHeight(towerUrl, 13);
  const towerCount = Math.min(2 + rng.int(2), towerLots.length);
  for (let i = 0; i < towerCount; i++) {
    const idx = rng.int(towerLots.length);
    const lot = towerLots[idx];
    if (lot === undefined) continue;
    towerLots.splice(idx, 1);
    const [dx, dz] = DIR_DELTA[lot.faceDir];
    const px = worldX(lot.gx) - dx * ROAD_TILE * 0.18;
    const pz = worldZ(lot.gz) - dz * ROAD_TILE * 0.18;
    seatKK(towerUrl, px, pz, rng.range(0, Math.PI * 2), towerScale);
  }

  // ------------------------------------------------------------------
  // 15. OVERHEAD WIRE — the densest visual signature of a real SF street, and
  // until now there was not one wire in the city.
  //
  // Two systems, both walked on REAL corridors from sf-transit.ts:
  //  a) trolleybus catenary on the top corridors (Divisadero, Fillmore,
  //     Mission, Market, 16th…): a mast on each kerb, a span wire across, two
  //     running wires down the street, guys at the ends, transformers here and
  //     there.
  //  b) sagging utility drops on the residential west side, where SF still
  //     runs its distribution overhead on wooden poles.
  //
  // BUDGET. All 584 trolleybus edges are 22,128u = 11% of the network; wiring
  // them would be ~740 masts, ~1,500 spans and a wall of clutter. The caps
  // below take the top corridors only. Spans are the one prop here that needs a
  // non-yaw rotation (64 B exact matrix each), which is why they are capped
  // separately from the masts.
  // ------------------------------------------------------------------
  // Per-pass census. Every number below is a cap this file sets, and the only
  // way to know whether a cap or the claim hash is the binding constraint is to
  // print what actually landed.
  const census: Record<string, number> = {};
  const bump = (k: string, n = 1): void => {
    census[k] = (census[k] ?? 0) + n;
  };
  const TROLLEY_CORRIDOR_COUNT = 8; // top-8 by length ≈ 8,540u of 22,128u
  const TROLLEY_SPAN = 30; // mast pitch, world units
  const POWER_POLE_CAP = 320;
  const POWER_SPAN = 42;
  {
    const trolleyLateral = 1.05;
    const spanY = 6.6;
    const runY = 5.9;
    let stations = 0;
    let sinceTransformer = 0;
    for (const edge of topCorridors("trolleybus", TROLLEY_CORRIDOR_COUNT)) {
      await breathe();
      // Both kerbs are wired from ONE walk so the two masts of a station are
      // exactly opposite each other — a per-side walk drifts and the span wire
      // then crosses the street at an angle.
      const trimA = network.nodeTrim(edge.a) + 3;
      const trimB = network.nodeTrim(edge.b) + 3;
      if (edge.len - trimA - trimB < TROLLEY_SPAN) continue;
      let prev: { lx: number; lz: number; rx: number; rz: number; ly: number; ry: number } | null =
        null;
      for (let s = trimA; s <= edge.len - trimB; s += TROLLEY_SPAN) {
        const smp = network.sample(edge, s);
        const off = edge.half + trolleyLateral;
        const lx = smp.x - smp.tz * off;
        const lz = smp.z + smp.tx * off;
        const rx = smp.x + smp.tz * off;
        const rz = smp.z - smp.tx * off;
        const ly = surfaceAt(lx, lz);
        const ry = surfaceAt(rx, rz);
        const gx = toGx(smp.x);
        const gz = toGz(smp.z);
        const ok =
          !reserved.has(cellKey(gx, gz)) && !onAsphalt(lx, lz, 0.1) && !onAsphalt(rx, rz, 0.1);
        if (ok) {
          const kit = trolleyPoleKit();
          placeKit(kit, lx, ly, lz, Math.atan2(-smp.tz, -smp.tx) + HALF_PI);
          placeKit(kit, rx, ry, rz, Math.atan2(smp.tz, smp.tx) + HALF_PI);
          claim(lx, lz);
          claim(rx, rz);
          bump("trolleyMast", 2);
          stations++;
          // Span wire across the street, and the two running wires back to the
          // previous station.
          placeWire(lx, ly + spanY, lz, rx, ry + spanY, rz);
          if (prev) {
            for (const lat of [-0.85, 0.85] as const) {
              const ax = prev.lx + (prev.rx - prev.lx) * 0.5 - smp.tz * lat;
              const az = prev.lz + (prev.rz - prev.lz) * 0.5 + smp.tx * lat;
              const bx = (lx + rx) / 2 - smp.tz * lat;
              const bz = (lz + rz) / 2 + smp.tx * lat;
              placeWire(ax, Math.min(prev.ly, prev.ry) + runY, az, bx, Math.min(ly, ry) + runY, bz);
            }
          } else {
            // Corridor start: guy the mast back into the pavement.
            placeWire(lx, ly + spanY, lz, lx - smp.tx * 3.2, ly + 0.3, lz - smp.tz * 3.2);
          }
          bump("trolleySpan", prev ? 3 : 2);
          if (++sinceTransformer >= 7) {
            sinceTransformer = 0;
            placeKit(transformerKit(), lx, ly + 4.4, lz, Math.atan2(-smp.tz, -smp.tx));
          }
          prev = { lx, lz, rx, rz, ly, ry };
        } else {
          prev = null;
        }
      }
    }

    // (b) West-side overhead distribution. Residential/victorian blocks only,
    // and only west of the downtown grid where SF really is still on poles.
    let poles = 0;
    for (const edge of network.edges) {
      if (poles >= POWER_POLE_CAP) break;
      await breathe();
      const mid = network.sample(edge, edge.len / 2);
      if (uOf(mid.x) > 0.6) continue;
      if (inPark(mid.x, mid.z)) continue;
      const char = districtAt(toGx(mid.x), toGz(mid.z)).character;
      if (char !== "residential" && char !== "victorian") continue;
      if (edge.len < POWER_SPAN * 1.6) continue;
      if (!rng.chance(0.3)) continue;
      const side: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      let prev: { x: number; y: number; z: number } | null = null;
      kerbWalk(
        edge,
        POWER_SPAN,
        1.1,
        (p) => {
          if (poles >= POWER_POLE_CAP) return;
          if (!claimSeat(p.x, p.z, 2.2)) {
            prev = null;
            return;
          }
          const y = surfaceAt(p.x, p.z);
          placeKit(powerPoleKit(), p.x, y, p.z, Math.atan2(p.tx, p.tz));
          bump("powerPole");
          poles++;
          if (prev) bump("powerSpan", 2);
          if (prev) {
            for (const dyz of [
              [POWER_POLE_H - 0.28, -1.25],
              [POWER_POLE_H - 0.28, 1.25],
            ] as const) {
              const [dy, lat] = dyz;
              placeWire(
                prev.x + p.tz * lat,
                prev.y + dy,
                prev.z - p.tx * lat,
                p.x + p.tz * lat,
                y + dy,
                p.z - p.tx * lat,
              );
            }
          }
          prev = { x: p.x, y, z: p.z };
        },
        () => side,
      );
    }
  }

  // ------------------------------------------------------------------
  // 16. MUNI GETS A BODY — shelters, stop poles and route flags on the real
  // transit corridors. Every site sits on an edge that genuinely carries the
  // mode, so a shelter is never on a street no bus runs down.
  // ------------------------------------------------------------------
  const SHELTER_CAP = 140;
  const STOP_CAP = 260;
  const STOP_PITCH = 92; // ~3 SF blocks
  // Real route numbers for the corridors a player will recognise. Anything else
  // gets the system mark rather than a made-up number.
  const ROUTE_FOR: ReadonlyMap<string, string> = new Map(
    Object.entries({
      "Market Street": "F",
      "Mission Street": "14",
      "Divisadero Street": "24",
      "Fillmore Street": "22",
      "Sutter Street": "2",
      "Sacramento Street": "1",
      "Clay Street": "1",
      "Union Street": "45",
      "Castro Street": "24",
      "16th Street": "22",
      "Eddy Street": "31",
      "3rd Street": "T",
      "The Embarcadero": "E",
      "California Street": "1",
      "Hyde Street": "PH",
      "Powell Street": "PM",
      "Mason Street": "PM",
      "Columbus Avenue": "30",
      "Van Ness Avenue": "49",
      "Geary Street": "38",
    } satisfies Record<string, string>),
  );
  {
    let shelters = 0;
    let stops = 0;
    const shelterParts = shelterKit();
    const poleParts = stopPoleKit();
    const served = new Set<number>();
    for (const mode of ["trolleybus", "tram", "cable", "light_rail"] as const) {
      const take = mode === "trolleybus" ? TROLLEY_CORRIDOR_COUNT : SF_TRANSIT[mode].length;
      for (const edge of topCorridors(mode, take)) {
        if (stops >= STOP_CAP) break;
        if (served.has(edge.id)) continue;
        served.add(edge.id);
        await breathe();
        const street = edgeStreet.get(edge.id) ?? "";
        const route = ROUTE_FOR.get(street) ?? "MUNI";
        const routeGeo = labelGeo(route);
        kerbWalk(edge, STOP_PITCH, 1.4, (p) => {
          if (stops >= STOP_CAP) return;
          // A shelter is 4.4u wide — it needs a clear stretch of pavement, and
          // it has to sit BACK from the kerb far enough that its roof does not
          // overhang the traffic lane.
          const bx = p.x - p.tz * p.side * 1.15;
          const bz = p.z + p.tx * p.side * 1.15;
          const roomy =
            shelters < SHELTER_CAP &&
            claimFree(bx, bz, 5.2) &&
            !onAsphalt(bx - p.tx * 2.4, bz - p.tz * 2.4, 0.5) &&
            !onAsphalt(bx + p.tx * 2.4, bz + p.tz * 2.4, 0.5) &&
            !onAsphalt(bx, bz, 1.4);
          if (roomy) {
            claim(bx, bz);
            placeKit(shelterParts, bx, surfaceAt(bx, bz), bz, facingRoad(p) + HALF_PI);
            solids.push({
              minX: bx - 2.3,
              maxX: bx + 2.3,
              minZ: bz - 2.3,
              maxZ: bz + 2.3,
              noBody: true,
            });
            bump("shelter");
            shelters++;
          }
          // The flag pole goes at the kerb whether or not a shelter fitted.
          if (!claimSeat(p.x, p.z, 1.8)) return;
          const y = surfaceAt(p.x, p.z);
          const yaw = facingRoad(p);
          placeKit(poleParts, p.x, y, p.z, yaw);
          if (routeGeo) {
            const label = new THREE.Mesh(routeGeo, STOP_WHITE_MAT);
            label.position.set(
              p.x - Math.sin(yaw) * 0.05,
              y + STOP_POLE_H - 0.42,
              p.z - Math.cos(yaw) * 0.05,
            );
            label.rotation.y = yaw;
            label.scale.setScalar(1.55);
            label.updateMatrixWorld(true);
            objects.push(label);
          }
          bump("stopPole");
          stops++;
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // 17. CABLE-CAR TURNTABLES — the Powell/Market and Hyde St terminals, plus
  // Powell-Mason at Taylor/Bay. The line endpoints are the first and last
  // points of SF_TRANSIT_LINES.p, so these land on the real terminals rather
  // than on a guess; duplicates collapse because Powell-Hyde and Powell-Mason
  // share the Powell/Market end.
  // ------------------------------------------------------------------
  {
    const done: [number, number][] = [];
    const parts = turntableKit();
    for (const line of SF_TRANSIT_LINES) {
      if (line.mode !== "cable") continue;
      const p = line.p;
      const ends: readonly (readonly [number, number])[] = [
        [p[0] ?? 0, p[1] ?? 0],
        [p[p.length - 2] ?? 0, p[p.length - 1] ?? 0],
      ];
      for (const [ex, ez] of ends) {
        if (done.some(([dx2, dz2]) => Math.hypot(dx2 - ex, dz2 - ez) < 12)) continue;
        // Sit the disc on the pavement beside the terminal, not in the
        // junction: nudge it to the nearest spot clear of asphalt.
        let px = ex;
        let pz = ez;
        const hit = network.nearest(ex, ez, ROAD_TILE * 2);
        if (hit) {
          const nx = (ex - hit.x) / (hit.dist || 1);
          const nz = (ez - hit.z) / (hit.dist || 1);
          const push = hit.edge.half + TURNTABLE_R + 1.4;
          px = hit.x + (Math.abs(nx) + Math.abs(nz) < 0.5 ? -hit.tz : nx) * push;
          pz = hit.z + (Math.abs(nx) + Math.abs(nz) < 0.5 ? hit.tx : nz) * push;
        }
        if (onAsphalt(px, pz, TURNTABLE_R * 0.4)) continue;
        done.push([ex, ez]);
        claim(px, pz);
        bump("turntable");
        placeKit(parts, px, surfaceAt(px, pz), pz, rng.range(0, Math.PI * 2));
      }
    }
  }

  // ------------------------------------------------------------------
  // 18. STREET TREES BY DISTRICT, IN TREE WELLS. Monterey cypress and
  // eucalyptus on the west side and in the Presidio, palms on Dolores and the
  // Embarcadero, plane on Market, cherry in Japantown, mixed elsewhere. The
  // well is the point: a street tree stands in a square of open soil cut into
  // the pavement, not on a lawn.
  // ------------------------------------------------------------------
  // Japantown is not one of the 52 district boxes (it is inside Pacific
  // Heights / Alamo Square), so it gets its own u/v box, calibrated the same
  // way the shoreline trace is.
  const JAPANTOWN = { uMin: 0.5, uMax: 0.565, vMin: 0.222, vMax: 0.268 } as const;
  // The cap is a runaway guard, not the planting plan. At 1500 it WAS the
  // plan: the walk fills in edge-array order, so the first districts in the
  // list got a full canopy and everything after (most of the grid — the
  // Mission read completely bare) got none. The NYC street-tree census our
  // reference tile draws from plants ~1000 trees per km²; this map is ~8 km².
  // The pitch/chance below yield ~7k trees network-wide, comfortably under the
  // cap, so coverage is decided by geometry again instead of iteration order.
  const TREE_CAP = 9000;
  const TREE_PITCH = ROAD_TILE * 1.8;
  type TreeKind = "cypress" | "eucalyptus" | "palm" | "plane" | "cherry" | "mixed";
  const treeKindAt = (x: number, z: number, district: District, street: string): TreeKind => {
    if (district.name === "the Presidio") return rng.chance(0.5) ? "eucalyptus" : "cypress";
    if (street === "Market Street") return "plane";
    const u = uOf(x);
    const v = vOf(z);
    if (u >= JAPANTOWN.uMin && u <= JAPANTOWN.uMax && v >= JAPANTOWN.vMin && v <= JAPANTOWN.vMax) {
      return "cherry";
    }
    if (district.name === "the Embarcadero" || district.name === "Mission Dolores") return "palm";
    if (u < 0.42) return rng.chance(0.55) ? "cypress" : "eucalyptus";
    return "mixed";
  };
  {
    const wellParts = treeWellKit();
    const palmParts = palmKit();
    let trees = 0;
    for (const edge of network.edges) {
      if (trees >= TREE_CAP) break;
      await breathe();
      const mid = network.sample(edge, edge.len / 2);
      // Parks grow their own trees from the park-tile pass; the Presidio is the
      // one park district whose ROADS want a planted verge.
      const midDistrict = districtAt(toGx(mid.x), toGz(mid.z));
      if (midDistrict.character === "park" && midDistrict.name !== "the Presidio") continue;
      const street = edgeStreet.get(edge.id) ?? "";
      kerbWalk(edge, TREE_PITCH, 1.5, (p) => {
        if (trees >= TREE_CAP) return;
        if (!rng.chance(0.72)) return;
        if (!claimSeat(p.x, p.z, 3.2)) return;
        const y = surfaceAt(p.x, p.z);
        const kind = treeKindAt(p.x, p.z, p.district, street);
        placeKit(wellParts, p.x, y, p.z, Math.atan2(p.tx, p.tz));
        if (kind === "palm") {
          placeKit(palmParts, p.x, y, p.z, rng.range(0, Math.PI * 2), rng.range(0.82, 1.15));
        } else {
          // Species read as proportion + tint on the two kit trees: a cypress
          // is a tall narrow spire, a eucalyptus taller and greyer, a plane
          // broad, a cherry small and pink.
          const small = kind === "cherry";
          const url = modelUrl("props", small ? TREE_SMALL : TREE_LARGE);
          const bounds = cache.bounds(url);
          const height =
            kind === "eucalyptus"
              ? rng.range(9, 11.5)
              : kind === "cypress"
                ? rng.range(7, 9)
                : kind === "plane"
                  ? rng.range(5.6, 7)
                  : kind === "cherry"
                    ? rng.range(3.6, 4.6)
                    : rng.range(5, 7);
          const spread =
            kind === "eucalyptus" ? 0.58 : kind === "cypress" ? 0.66 : kind === "plane" ? 1.2 : 1;
          const sy = height / Math.max(bounds.size.y, 0.001);
          const node = cache.instance(url);
          node.scale.set(sy * spread, sy, sy * spread);
          node.rotation.y = rng.range(0, Math.PI * 2);
          node.position.set(p.x, y, p.z);
          if (kind === "eucalyptus") tintNode(node, 0xb9c4ae, 0.32);
          if (kind === "cherry") tintNode(node, 0xf2b8cc, 0.6);
          if (kind === "cypress") tintNode(node, 0x6f8a6b, 0.22);
          node.updateMatrixWorld(true);
          objects.push(node);
          solids.push({
            minX: p.x - 0.5,
            maxX: p.x + 0.5,
            minZ: p.z - 0.5,
            maxZ: p.z + 0.5,
            noBody: true,
          });
        }
        bump(`tree.${kind}`);
        trees++;
      });
    }
  }

  // ------------------------------------------------------------------
  // 19. KERBSIDE CLUTTER — meters, news racks, mailboxes, bike racks,
  // scooters, cabinets, A-boards, planters, dumpsters and scaffolding, mixed
  // per district character. Dense and everywhere: before this pass most blocks
  // in the city carried nothing but a lamp post.
  // ------------------------------------------------------------------
  const CLUTTER_CAP = 4200;
  const CLUTTER_PITCH = ROAD_TILE * 1.15;
  type ClutterKind =
    | "meter"
    | "news"
    | "mailbox"
    | "bike"
    | "scooter"
    | "cabinet"
    | "aboard"
    | "planter"
    | "dumpster"
    | "scaffold";
  // Per-character weights, summed to pick. Downtown is metered and racked,
  // residential is cabinets and bins, wharf is A-boards and planters.
  const CLUTTER_MIX = {
    downtown: [
      ["meter", 5],
      ["news", 3],
      ["bike", 3],
      ["scooter", 3],
      ["cabinet", 2],
      ["mailbox", 2],
      ["aboard", 1],
      ["scaffold", 1],
    ],
    highrise: [
      ["meter", 4],
      ["news", 2],
      ["bike", 3],
      ["scooter", 3],
      ["cabinet", 3],
      ["scaffold", 2],
      ["mailbox", 1],
    ],
    commercial: [
      ["meter", 5],
      ["aboard", 4],
      ["news", 3],
      ["planter", 3],
      ["bike", 2],
      ["scooter", 2],
      ["dumpster", 2],
      ["mailbox", 1],
    ],
    wharf: [
      ["aboard", 4],
      ["planter", 4],
      ["bike", 3],
      ["news", 2],
      ["meter", 2],
      ["dumpster", 1],
    ],
    residential: [
      ["cabinet", 4],
      ["meter", 3],
      ["mailbox", 2],
      ["bike", 2],
      ["scooter", 1],
      ["planter", 2],
      ["dumpster", 1],
    ],
    victorian: [
      ["cabinet", 3],
      ["meter", 4],
      ["news", 2],
      ["mailbox", 2],
      ["bike", 2],
      ["scooter", 2],
      ["planter", 2],
      ["aboard", 1],
    ],
    industrial: [
      ["dumpster", 5],
      ["cabinet", 3],
      ["scaffold", 1],
    ],
    park: [],
  } satisfies Record<DistrictChar, ReadonlyArray<readonly [ClutterKind, number]>>;
  {
    const parts = {
      meter: meterKit(),
      news: newsBoxKit(),
      mailbox: mailboxKit(),
      bike: bikeRackKit(),
      scooter: scooterKit(),
      cabinet: cabinetKit(),
      aboard: aBoardKit(),
      scaffold: scaffoldKit(),
    };
    const NEWS_TINTS = [0x2f6f4f, 0x2b4a8f, 0xa8562f, 0x6f4a7a, 0x4a4a4a] as const;
    const ABOARD_TINT = 0x3a3630;
    const MAIL_TINT = 0x24457f;
    const CABINET_TINT = 0x8f9a8f;
    const SCAFFOLD_TINT = 0x9fb4c4;
    const planterUrl2 = modelUrl("props", PROP_PLANTER);
    const planterScale2 = 1.5 / Math.max(cache.bounds(planterUrl2).size.x, 0.001);
    const dumpUrl = modelUrl("props", PROP_DUMPSTER);
    const dumpScale = scaleToHeight(dumpUrl, 1.5);
    let clutter = 0;
    for (const edge of network.edges) {
      if (clutter >= CLUTTER_CAP) break;
      await breathe();
      const mid = network.sample(edge, edge.len / 2);
      if (inPark(mid.x, mid.z)) continue;
      kerbWalk(edge, CLUTTER_PITCH, 1.25, (p) => {
        if (clutter >= CLUTTER_CAP) return;
        const mix = CLUTTER_MIX[p.district.character];
        if (mix.length === 0) return;
        if (!rng.chance(0.55)) return;
        let total = 0;
        for (const [, w] of mix) total += w;
        let roll = rng.range(0, total);
        let kind: ClutterKind = "meter";
        for (const [k, w] of mix) {
          roll -= w;
          if (roll <= 0) {
            kind = k;
            break;
          }
        }
        // Scaffolding is 9u long and 6u tall — it needs the clear run and the
        // set-back a hoarding really takes, so it is checked hardest.
        const radius = kind === "scaffold" ? 6.5 : kind === "dumpster" ? 2.6 : 1.7;
        const back = kind === "scaffold" ? 1.5 : 0;
        const px = p.x - p.tz * p.side * back;
        const pz = p.z + p.tx * p.side * back;
        if (!claimFree(px, pz, radius)) return;
        if (kind === "scaffold") {
          if (
            onAsphalt(px - p.tx * 4.6, pz - p.tz * 4.6, 0.4) ||
            onAsphalt(px + p.tx * 4.6, pz + p.tz * 4.6, 0.4)
          ) {
            return;
          }
        }
        if (onAsphalt(px, pz, 0.25)) return;
        claim(px, pz);
        const y = surfaceAt(px, pz);
        const faceOut = facingRoad(p);
        const alongKerb = Math.atan2(p.tx, p.tz);
        switch (kind) {
          case "planter":
            seat(planterUrl2, px, pz, rng.range(0, Math.PI * 2), planterScale2);
            break;
          case "dumpster":
            seatKK(dumpUrl, px, pz, alongKerb + rng.range(-0.08, 0.08), dumpScale);
            break;
          case "news":
            placeKit(parts.news, px, y, pz, faceOut, 1, new THREE.Color(rng.pick(NEWS_TINTS)));
            break;
          case "mailbox":
            placeKit(parts.mailbox, px, y, pz, faceOut, 1, new THREE.Color(MAIL_TINT));
            break;
          case "cabinet":
            placeKit(parts.cabinet, px, y, pz, faceOut, 1, new THREE.Color(CABINET_TINT));
            break;
          case "aboard":
            placeKit(
              parts.aboard,
              px,
              y,
              pz,
              alongKerb + rng.range(-0.4, 0.4),
              1,
              new THREE.Color(ABOARD_TINT),
            );
            break;
          case "bike":
            placeKit(parts.bike, px, y, pz, alongKerb);
            break;
          case "scooter":
            placeKit(parts.scooter, px, y, pz, alongKerb + rng.range(-0.25, 0.25));
            break;
          case "scaffold":
            placeKit(parts.scaffold, px, y, pz, alongKerb, 1, new THREE.Color(SCAFFOLD_TINT));
            break;
          case "meter":
            placeKit(parts.meter, px, y, pz, faceOut);
            break;
        }
        bump(`clutter.${kind}`);
        clutter++;
      });
    }
  }

  // ------------------------------------------------------------------
  // 20. SIGNAGE — street-name blades at junctions and regulatory plates on the
  // kerb. Names come from the real corridor names in sf-transit.ts; a junction
  // whose streets we do not KNOW gets no blade rather than a made-up one.
  //
  // Glyphs are geometry, not a texture (see the GLYPH FONT block): the bake
  // drops UVs on procedural geometry, so a bitmap atlas could not survive it.
  // Text is one merged geometry per string, cached — 240 blades over the top
  // named streets upload a few dozen geometries, not 480.
  //
  // NOT DONE HERE: one-way arrows. Nothing in the network carries a one-way
  // flag, and the road-surface glyph work is the roads pass's; inventing the
  // direction would put a wrong arrow on a real street.
  // ------------------------------------------------------------------
  const BLADE_STREET_CAP = 40; // distinct names that earn a label geometry
  const BLADE_CAP = 260;
  const REGULATORY_CAP = 240;
  {
    // Only the longest corridors get blades: a name is a geometry, so capping
    // the vocabulary caps the bake payload, and these are exactly the streets a
    // player recognises.
    const bladeFor = new Map<string, string>();
    const rejected = new Set<string>();
    while (bladeFor.size < BLADE_STREET_CAP) {
      let best: string | null = null;
      let bestLen = 0;
      for (const [street, len] of streetLength) {
        if (bladeFor.has(street) || rejected.has(street)) continue;
        if (len > bestLen) {
          best = street;
          bestLen = len;
        }
      }
      if (best === null) break;
      const text = bladeText(best);
      if (text) bladeFor.set(best, text);
      else rejected.add(best);
    }
    let blades = 0;
    for (let n = 0; n < network.nodes.length && blades < BLADE_CAP; n++) {
      if (junctionControl(network, n) === "none") continue; // real junctions only
      const node = network.nodes[n];
      if (!node) continue;
      const labels: string[] = [];
      for (const id of network.nodeEdges[n] ?? []) {
        const street = edgeStreet.get(id);
        if (!street) continue;
        const text = bladeFor.get(street);
        if (text && !labels.includes(text)) labels.push(text);
      }
      if (labels.length === 0) continue;
      const arms = controlArms(network, n);
      // Mount on the first arm whose kerb corner is real pavement, set further
      // back than the signal so the two do not intersect.
      let mounted = false;
      for (const a of arms) {
        if (mounted) break;
        const px = a.px + a.tx * 2.2 + a.tz * (a.half + 2.0);
        const pz = a.pz + a.tz * 2.2 - a.tx * (a.half + 2.0);
        if (onAsphalt(px, pz, 0.2)) continue;
        if (!claimFree(px, pz, 2.0)) continue;
        claim(px, pz);
        const y = surfaceAt(px, pz);
        const poleH = 3.6;
        const pole = new THREE.Mesh(STOP_POLE, POLE_MAT);
        pole.scale.set(1.2, poleH, 1.2);
        pole.position.set(px, y + poleH / 2, pz);
        pole.updateMatrixWorld(true);
        objects.push(pole);
        // Blades CROSS at one height, each square to its own street — the way
        // a real SF mast carries them, and the way the pair stays one prop.
        // Stacking the second 0.78u lower made every two-street junction ship
        // the same sign geometry at two different heights, which is a kind
        // whose own baseline calls half its instances misplaced.
        for (let i = 0; i < Math.min(2, labels.length); i++) {
          const text = labels[i];
          if (text === undefined) continue;
          const geo = labelGeo(text);
          if (!geo) continue;
          const scale = 1.9;
          const w = labelWidth(text) * scale;
          const yaw = Math.atan2(a.tx, a.tz) + (i === 0 ? 0 : HALF_PI);
          const by = y + poleH - 0.28;
          const plate = new THREE.Mesh(BLADE_PLATE_BOX, BLADE_MAT);
          plate.scale.set(w + 0.5, GLYPH_H * scale + 0.28, 0.07);
          plate.rotation.y = yaw;
          plate.position.set(px, by, pz);
          plate.updateMatrixWorld(true);
          objects.push(plate);
          const label = new THREE.Mesh(geo, STOP_WHITE_MAT);
          label.scale.setScalar(scale);
          label.rotation.y = yaw;
          label.position.set(px + Math.sin(yaw) * 0.05, by, pz + Math.cos(yaw) * 0.05);
          label.updateMatrixWorld(true);
          objects.push(label);
        }
        bump("blade", Math.min(2, labels.length));
        blades++;
        mounted = true;
      }
    }

    // Regulatory plates: tow-away / no-parking, correct on any SF kerb.
    const regParts = regulatoryKit();
    let plates = 0;
    for (const edge of network.edges) {
      if (plates >= REGULATORY_CAP) break;
      await breathe();
      const mid = network.sample(edge, edge.len / 2);
      if (inPark(mid.x, mid.z)) continue;
      if (!rng.chance(0.12)) continue;
      kerbWalk(edge, ROAD_TILE * 5, 1.2, (p) => {
        if (plates >= REGULATORY_CAP) return;
        if (p.district.character === "park") return;
        if (!claimSeat(p.x, p.z, 2.0)) return;
        placeKit(regParts, p.x, surfaceAt(p.x, p.z), p.z, facingRoad(p));
        bump("regulatoryPlate");
        plates++;
      });
    }
  }

  // ------------------------------------------------------------------
  // 21. FACADE FURNITURE — awnings, fire escapes, murals, roll-up shutters.
  //
  // The kit awning GLBs (public/models/props/awning*.glb, overhang*.glb) are on
  // disk but are NOT in assets/manifest.ts, so nothing ever preloads them and
  // `cache.instance` cannot resolve them — that, plus the old pass scaling a
  // 0.4u canopy to storefront width, is why "the repo ships awnings" and the
  // city has none. These are procedural instead: correct proportions by
  // construction and no manifest dependency.
  //
  // WHERE THE WALL IS. `city.ts`'s row walk seats a frontage building at
  // `edge.half + 1.7 + footprint/2 + 0.7` and centres the model there, so the
  // FRONT FACE is at `facadeOffset(edge.half)` from the centreline whatever the
  // footprint — the street's own sidewalk plus a stoop, NOT a constant. That
  // invariant is the only reason facade props can hang on a wall this module
  // cannot see, so it is imported from city.ts rather than restated. It also bounds where they are safe:
  // downtown and highrise are real extruded footprints at real addresses, not
  // row-walk lots, so they are excluded — a plate there would float.
  // ------------------------------------------------------------------
  const AWNING_CAP = 620;
  const FIRE_ESCAPE_CAP = 260;
  const MURAL_CAP = 140;
  const SHUTTER_CAP = 220;
  const FACADE_PITCH = 7.4;
  // Districts whose fabric the row walk builds shoulder-to-shoulder, so a
  // facade prop lands on a wall rather than in a gap.
  const FIRE_ESCAPE_DISTRICTS = new Set(["Chinatown", "North Beach", "Civic Center", "SoMa"]);
  const MURAL_DISTRICTS = new Set(["the Mission", "Mission Dolores", "the Castro"]);
  {
    const awningParts = awningKit();
    const escapeParts = fireEscapeKit();
    const muralParts = muralKit();
    const shutterParts = shutterKit();
    const AWNING_TINTS = [0xb5384a, 0x2f6f5a, 0x2b4a7a, 0x8f6f3a, 0x6f3a5a, 0x3a3a3a] as const;
    const MURAL_TINTS = [0xd8783a, 0x3a8fa8, 0xc9483a, 0x6f9e4a, 0xe0b03a] as const;
    let awnings = 0;
    let escapes = 0;
    let murals = 0;
    let shutters = 0;
    for (const edge of network.edges) {
      await breathe();
      const mid = network.sample(edge, edge.len / 2);
      if (inPark(mid.x, mid.z)) continue;
      kerbWalk(edge, FACADE_PITCH, frontPlane(edge), (p) => {
        const char = p.district.character;
        if (char === "park" || char === "downtown" || char === "highrise") return;
        // The wall plane is only trustworthy when THIS edge is the closest one:
        // at a corner the nearest edge is the cross street and the row that
        // actually faces us was built off that one instead.
        const near = network.nearest(p.x, p.z, ROAD_TILE * 1.6);
        if (!near || near.edge.id !== edge.id) return;
        // …and only when a wall was actually BUILT here. The plane is where a
        // frontage lot's front face WOULD be; alleys between runs, refused
        // lots and blocks the real-footprint pass owns have no wall on it, and
        // a 9u awning panel hanging over open pavement is the loudest
        // "generated" tell on the whole map.
        if (!facadeAt(p.x, p.z)) return;
        const y = surfaceAt(p.x, p.z);
        // local +Z points at the street: the props are authored that way.
        const yaw = facingRoad(p);
        const shopfront = char === "commercial" || char === "wharf";
        // Denser than the old 0.5 because the facadeAt gate above now throws
        // away every sample with no wall behind it: at 0.5 the surviving
        // shopfronts came out sparser than the un-gated version LOOKED, which
        // trades one wrong read (props in mid-air) for another (bare walls).
        if (shopfront && awnings < AWNING_CAP && rng.chance(0.72)) {
          placeKit(
            awningParts,
            p.x,
            y,
            p.z,
            yaw,
            rng.range(0.9, 1.15),
            new THREE.Color(rng.pick(AWNING_TINTS)),
          );
          bump("awning");
          awnings++;
        } else if (
          shopfront &&
          shutters < SHUTTER_CAP &&
          char === "commercial" &&
          rng.chance(0.18)
        ) {
          placeKit(shutterParts, p.x, y, p.z, yaw, 1, new THREE.Color(0x8f9298));
          bump("shutter");
          shutters++;
        }
        if (
          escapes < FIRE_ESCAPE_CAP &&
          FIRE_ESCAPE_DISTRICTS.has(p.district.name) &&
          rng.chance(0.34)
        ) {
          placeKit(escapeParts, p.x, y, p.z, yaw, rng.range(0.92, 1.08));
          bump("fireEscape");
          escapes++;
        }
        if (murals < MURAL_CAP && MURAL_DISTRICTS.has(p.district.name) && rng.chance(0.1)) {
          // Flat on the wall, above the shopfront band.
          placeKit(
            muralParts,
            p.x - Math.sin(yaw) * 0.06,
            y + 4.2,
            p.z - Math.cos(yaw) * 0.06,
            yaw,
            1,
            new THREE.Color(rng.pick(MURAL_TINTS)),
          );
          bump("mural");
          murals++;
        }
      });
    }
  }

  console.log(
    `[city] furniture ${objects.length} objects, ${solids.length} solids, ` +
      `${parkedCars.length} parked, ${lampHeads.length} lamps`,
  );
  console.log(
    `[city] dressing ${Object.entries(census)
      .map(([k, n]) => `${k}=${n}`)
      .join(" ")}`,
  );
  return { objects, solids, openWaterCells, pierDecks, parkedCars, lampHeads };
}
