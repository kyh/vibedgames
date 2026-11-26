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
import { DIR_DELTA, E, N, S, W } from "../shared/types";
import type { Dir, Solid, SurfaceDeck } from "../shared/types";
import { facadeOffset, STEEP_CLIFF } from "./frontage";
import { GGP_LAKE, isParkDistrictLand } from "./land-class";
import { stowBasinOverlapsBox, STOW_WATER_SEGMENTS, STOW_WATER_Y } from "./lake";
import { controlArms, junctionControl } from "./junction-control";
import type { DrapeField } from "./conform";

import type { NetEdge, RoadNetwork } from "./network";
import type { CityPlan } from "./grid";
import { districtAt } from "./sf-map";
import type { District, DistrictChar } from "./sf-map";
import { parkPathMaskAt } from "./sf-streets";
import { SF_TRANSIT, SF_TRANSIT_LINES, TRANSIT_MODES } from "./sf-transit";
import type { TransitMode } from "./sf-transit";
import type { Terrain } from "./terrain";
import { getMuniShelterKit } from "./sf-street-kit";
import type { ParcelClearance } from "./parcel-clearance";
import { getTreeTrunks } from "./tree-clearance";
import type { TreeClearance } from "./tree-clearance";

export interface FurnitureCtx {
  readonly plan: CityPlan;
  readonly network: RoadNetwork;
  readonly terrain: Terrain;
  /** terrain + street terrace — the field the kerb/sidewalk/asphalt drape onto */
  readonly roadDrape: DrapeField;
  /** makeGroundOffset(network, terrain) — the ground mesh's per-vertex shift */
  readonly groundOffset: (x: number, z: number) => number;
  readonly cache: ModelCache;
  readonly rng: Rng;
  readonly reserved: ReadonlySet<string>;
  readonly parcelClear: ParcelClearance;
  readonly treeClear: TreeClearance;
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
}

export type ParkedSpec = {
  x: number;
  z: number;
  yaw: number;
  model: string;
};

export type LampHead = {
  x: number;
  y: number;
  z: number;
  ground: number;
};

export interface FurnitureResult {
  readonly objects: THREE.Object3D[];
  readonly solids: Solid[];
  readonly pierDecks: readonly SurfaceDeck[];
  readonly parkedCars: readonly ParkedSpec[];
  readonly lampHeads: readonly LampHead[];
}

const HALF_PI = Math.PI / 2;
const DIRS: readonly Dir[] = [N, E, S, W];

const LIGHT_HEIGHT = 5;
const PIER_DECK_Y = 0.55;
const PIER_WIDTH = ROAD_TILE * 1.03;
const PIER_RAMP_RUN = ROAD_TILE * 0.6;
const PIER_DECK_MAT = new THREE.MeshStandardMaterial({ color: 0x9c_81_58, roughness: 0.9 });
const CONSTRUCTION_POCKETS = 6;

const CHIMNEYS: readonly string[] = [PROP_CHIMNEY_SMALL, PROP_CHIMNEY_MEDIUM, PROP_CHIMNEY_LARGE];
const PIER_END_BUILDINGS: readonly string[] = ["com-building-a", "com-building-f"];
const PIER_BUILDING_TINT = 0xc4_5a_3a;
const KK_TINT = 0xd8_d2_c4;
const KK_TINT_AMT = 0.15;
const HYDRANT_CAP = 340;
const SEATING_CAP = 280;
const VICTORIAN_LAMP_HEIGHT = 4.2;
const PARK_SKIRT_DEPTH = 1.6;

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const PARK_SKIRT_BOX = new THREE.BoxGeometry(1, 1, 1);
const WALL_FOOTING_BOX = new THREE.BoxGeometry(1, 1, 1);
const GATE_POST_BOX = new THREE.BoxGeometry(1, 1, 1);
const BLADE_PLATE_BOX = new THREE.BoxGeometry(1, 1, 1);

const STOP_FACE = new THREE.CylinderGeometry(0.42, 0.42, 0.05, 8)
  .rotateY(Math.PI / 8)
  .rotateX(Math.PI / 2);

const STOP_RIM = new THREE.CylinderGeometry(0.48, 0.48, 0.04, 8)
  .rotateY(Math.PI / 8)
  .rotateX(Math.PI / 2);

const STOP_POLE = new THREE.CylinderGeometry(0.05, 0.05, 1, 6);
const STOP_RED_MAT = new THREE.MeshStandardMaterial({ color: 0xc0_39_2b, roughness: 0.7 });
const STOP_WHITE_MAT = new THREE.MeshStandardMaterial({ color: 0xf4_f7_f4, roughness: 0.7 });
const POLE_MAT = new THREE.MeshStandardMaterial({ color: 0x8f_97_9e, roughness: 0.9 });
const RAIL_MAT = new THREE.MeshStandardMaterial({ color: 0x8a_6f_4d, roughness: 0.9 });
const SEAWALL_MAT = new THREE.MeshStandardMaterial({ color: 0x9a_a2_a6, roughness: 1 });
const LAKE_MAT = new THREE.MeshStandardMaterial({ color: 0x3f_6f_8f, roughness: 0.4 });

const WIRE_MAT = new THREE.MeshStandardMaterial({
  color: 0x24_26_2a,
  metalness: 0.3,
  roughness: 0.5,
});

const MUNI_MAT = new THREE.MeshStandardMaterial({ color: 0x5c_46_34, roughness: 0.8 });
const BLADE_MAT = new THREE.MeshStandardMaterial({ color: 0x25_60_4a, roughness: 0.75 });
const CANVAS_MAT = new THREE.MeshStandardMaterial({ color: 0xb5_38_4a, roughness: 0.92 });
const FROND_MAT = new THREE.MeshStandardMaterial({ color: 0x4d_7a_4a, roughness: 0.85 });

const UNIT_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);

interface KitPiece {
  readonly geo: THREE.BufferGeometry;
  readonly mat: THREE.MeshStandardMaterial;
  readonly at?: readonly [number, number, number];
  readonly size?: readonly [number, number, number];
  readonly rot?: readonly [number, number, number];
}

interface KitPart {
  readonly geo: THREE.BufferGeometry;
  readonly mat: THREE.MeshStandardMaterial;
}

const KIT_M = new THREE.Matrix4();
const KIT_E = new THREE.Euler();
const KIT_Q = new THREE.Quaternion();
const KIT_V = new THREE.Vector3();
const KIT_S = new THREE.Vector3();

const buildKit = (pieces: readonly KitPiece[]) => {
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

    if (list) {
      list.push(geo);
    } else {
      byMat.set(p.mat, [geo]);
    }
  }

  const parts: KitPart[] = [];

  for (const [mat, geos] of byMat) {
    const [first] = geos;

    if (!first) {
      continue;
    }

    parts.push({ geo: geos.length === 1 ? first : mergeGeometries(geos, false), mat });
  }

  return parts;
};

const lazyKit = (build: () => readonly KitPiece[]) => {
  let parts: readonly KitPart[] | null = null;

  return () => (parts ??= buildKit(build()));
};

const kBox = (
  mat: THREE.MeshStandardMaterial,
  at: readonly [number, number, number],
  size: readonly [number, number, number],
  rot?: readonly [number, number, number],
) => (rot ? { at, geo: UNIT_BOX, mat, rot, size } : { at, geo: UNIT_BOX, mat, size });

const kTube = (
  mat: THREE.MeshStandardMaterial,
  at: readonly [number, number, number],
  size: readonly [number, number, number],
  rot?: readonly [number, number, number],
) => (rot ? { at, geo: UNIT_CYL, mat, rot, size } : { at, geo: UNIT_CYL, mat, size });

const WIRE_SAG = 0.055;
const WIRE_GAUGE = 0.0019;
const WIRE_SEGS = 4;
const wireSagAt = (t: number) => -WIRE_SAG * 4 * t * (1 - t);

const wireKit = lazyKit(() => {
  const pieces: KitPiece[] = [];

  for (let i = 0; i < WIRE_SEGS; i += 1) {
    const t0 = i / WIRE_SEGS;
    const t1 = (i + 1) / WIRE_SEGS;
    const y0 = wireSagAt(t0);
    const y1 = wireSagAt(t1);
    const len = Math.hypot(t1 - t0, y1 - y0) * 1.06;
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

const TROLLEY_POLE_H = 7.2;

const trolleyPoleKit = lazyKit(() => [
  kTube(POLE_MAT, [0, TROLLEY_POLE_H / 2, 0], [0.26, TROLLEY_POLE_H, 0.26]),
  kTube(POLE_MAT, [0, 0.14, 0], [0.52, 0.28, 0.52]),
  kTube(POLE_MAT, [0, TROLLEY_POLE_H - 0.5, 1.1], [0.14, 2.2, 0.14], [0, 0, Math.PI / 2]),
  kBox(POLE_MAT, [0, TROLLEY_POLE_H - 1.05, 0.75], [0.1, 1.3, 0.1], [Math.PI / 5, 0, 0]),
]);

const transformerKit = lazyKit(() => [
  kBox(WIRE_MAT, [0, 0, 0], [0.62, 0.9, 0.5]),
  kTube(WIRE_MAT, [0, 0.56, 0], [0.5, 0.22, 0.5]),
]);

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

const STOP_POLE_H = 3.4;

const stopPoleKit = lazyKit(() => [
  kTube(MUNI_MAT, [0, STOP_POLE_H / 2, 0], [0.14, STOP_POLE_H, 0.14]),
  kBox(MUNI_MAT, [0, STOP_POLE_H - 0.42, 0.02], [0.9, 0.84, 0.05]),
]);

const TURNTABLE_R = 4.6;

const turntableKit = lazyKit(() => {
  const pieces: KitPiece[] = [
    {
      at: [0, -0.08, 0],
      geo: UNIT_CYL,
      mat: SEAWALL_MAT,
      size: [TURNTABLE_R * 2, 0.3, TURNTABLE_R * 2],
    },
    {
      at: [0, 0.09, 0],
      geo: UNIT_CYL,
      mat: RAIL_MAT,
      size: [TURNTABLE_R * 1.82, 0.12, TURNTABLE_R * 1.82],
    },
  ];

  for (const z of [-0.26, 0.26] as const) {
    pieces.push(kBox(POLE_MAT, [0, 0.17, z], [TURNTABLE_R * 1.8, 0.08, 0.14]));
  }

  for (let i = 0; i < 8; i += 1) {
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
    at: [0, 1.21, 0],
    geo: UNIT_CYL,
    mat: CANVAS_MAT,
    rot: [0, 0, Math.PI / 2],
    size: [0.72, 0.56, 0.56],
  },
  kBox(CANVAS_MAT, [0, 0.22, 0], [0.3, 0.44, 0.3]),
]);

const bikeRackKit = lazyKit(() => {
  const pieces: KitPiece[] = [];

  for (const x of [-0.9, 0.9] as const) {
    pieces.push(
      kTube(POLE_MAT, [x - 0.32, 0.4, 0], [0.09, 0.8, 0.09]),
      kTube(POLE_MAT, [x + 0.32, 0.4, 0], [0.09, 0.8, 0.09]),
      kBox(POLE_MAT, [x, 0.79, 0], [0.72, 0.09, 0.09]),
    );
  }

  return pieces;
});

const scooterKit = lazyKit(() => [
  kBox(WIRE_MAT, [0, 0.16, 0], [0.9, 0.07, 0.18]),
  kTube(WIRE_MAT, [0.38, 0.6, 0], [0.06, 0.9, 0.06], [0, 0, -0.12]),
  kBox(WIRE_MAT, [0.44, 1.03, 0], [0.08, 0.06, 0.44]),
  {
    at: [0.42, 0.14, 0],
    geo: UNIT_CYL,
    mat: WIRE_MAT,
    rot: [0, 0, Math.PI / 2],
    size: [0.26, 0.07, 0.26],
  },
  {
    at: [-0.42, 0.14, 0],
    geo: UNIT_CYL,
    mat: WIRE_MAT,
    rot: [0, 0, Math.PI / 2],
    size: [0.26, 0.07, 0.26],
  },
]);

const cabinetKit = lazyKit(() => [
  kBox(SEAWALL_MAT, [0, 0.66, 0], [1.05, 1.32, 0.55]),
  kBox(SEAWALL_MAT, [0, 1.36, 0], [1.15, 0.1, 0.65]),
  kBox(WIRE_MAT, [0, 0.66, 0.29], [0.86, 1.06, 0.03]),
]);

const aBoardKit = lazyKit(() => [
  kBox(CANVAS_MAT, [0, 0.5, -0.16], [0.6, 1, 0.04], [0.28, 0, 0]),
  kBox(CANVAS_MAT, [0, 0.5, 0.16], [0.6, 1, 0.04], [-0.28, 0, 0]),
]);

const SCAFFOLD_RUN = 9;

export const getScaffoldKit = lazyKit(() => {
  const pieces: KitPiece[] = [];

  for (let i = 0; i <= 3; i += 1) {
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
  const braceAngle = Math.atan2(2.9, 3.4);
  const braceLength = Math.hypot(2.9, 3.4);

  for (const x of [-3, 0, 3]) {
    for (const sign of [-1, 1]) {
      pieces.push(
        kBox(POLE_MAT, [x, 4.4, 0.85], [0.055, braceLength, 0.07], [0, 0, sign * braceAngle]),
      );
    }
  }

  for (let i = 0; i <= 20; i += 1) {
    const x = -SCAFFOLD_RUN / 2 + 0.025 + ((SCAFFOLD_RUN - 0.05) * i) / 20;
    pieces.push(kBox(WIRE_MAT, [x, 4.4, 0.9], [0.025, 3.5, 0.03]));
  }

  for (let i = 0; i <= 7; i += 1) {
    pieces.push(kBox(WIRE_MAT, [0, 2.675 + (3.45 * i) / 7, 0.9], [SCAFFOLD_RUN, 0.025, 0.03]));
  }

  return pieces;
});

/** The scaffold's nine-unit run is local +X; its clearance probes follow
 *  the street tangent. Local +Z belongs across the sidewalk. */
export const scaffoldYaw = (tx: number, tz: number) => Math.atan2(-tz, tx);

const regulatoryKit = lazyKit(() => [
  kTube(POLE_MAT, [0, 1.15, 0], [0.07, 2.3, 0.07]),
  kBox(STOP_WHITE_MAT, [0, 2.02, 0.02], [0.44, 0.66, 0.04]),
  kBox(STOP_RED_MAT, [0, 2.24, 0.05], [0.4, 0.16, 0.02]),
]);

const frontPlane = (edge: NetEdge) => facadeOffset(edge.half) - edge.half;

const awningKit = lazyKit(() => [
  kBox(CANVAS_MAT, [0, 2.86, 0.62], [3.2, 0.06, 1.5], [-0.36, 0, 0]),
  kBox(CANVAS_MAT, [0, 2.52, 1.24], [3.2, 0.36, 0.05]),
  kTube(POLE_MAT, [-1.5, 2.95, 0.62], [0.06, 1.5, 0.06], [-1.2, 0, 0]),
  kTube(POLE_MAT, [1.5, 2.95, 0.62], [0.06, 1.5, 0.06], [-1.2, 0, 0]),
]);

const fireEscapeKit = lazyKit(() => {
  const pieces: KitPiece[] = [];

  for (const y of [3.6, 6.6] as const) {
    pieces.push(
      kBox(WIRE_MAT, [0, y, 0.55], [2.6, 0.08, 1.1]),
      kBox(WIRE_MAT, [0, y + 0.5, 1.08], [2.6, 0.06, 0.06]),
      kBox(WIRE_MAT, [0, y + 0.95, 1.08], [2.6, 0.06, 0.06]),
    );

    for (const x of [-1.25, 0, 1.25] as const) {
      pieces.push(kBox(WIRE_MAT, [x, y + 0.5, 1.08], [0.06, 1, 0.06]));
    }

    pieces.push(kBox(WIRE_MAT, [0.9, y - 1.5, 0.75], [0.08, 3.4, 0.5], [0, 0, 0.62]));
  }

  return pieces;
});

const muralKit = lazyKit(() => [{ geo: UNIT_PLANE, mat: CANVAS_MAT, size: [5.2, 4.4, 1] }]);

const shutterKit = lazyKit(() => {
  const pieces: KitPiece[] = [kBox(WIRE_MAT, [0, 1.35, 0], [3.4, 2.7, 0.07])];

  for (let i = 0; i < 7; i += 1) {
    pieces.push(kBox(WIRE_MAT, [0, 0.24 + i * 0.37, 0.05], [3.4, 0.1, 0.04]));
  }

  return pieces;
});

const TREE_WELL_R = 0.82;

const treeWellKit = lazyKit(() => {
  const pieces: KitPiece[] = [];

  for (const s of [-1, 1] as const) {
    pieces.push(
      kBox(SEAWALL_MAT, [s * TREE_WELL_R, 0.06, 0], [0.2, 0.16, TREE_WELL_R * 2 + 0.2]),
      kBox(SEAWALL_MAT, [0, 0.06, s * TREE_WELL_R], [TREE_WELL_R * 2 - 0.2, 0.16, 0.2]),
    );
  }

  return pieces;
});

const palmKit = lazyKit(() => {
  const pieces: KitPiece[] = [];
  const H = 8.4;

  for (let i = 0; i < 7; i += 1) {
    const t = i / 6;
    pieces.push(
      kTube(
        RAIL_MAT,
        [t * 0.5, 0.35 + t * (H - 0.9), 0],
        [0.56 - t * 0.22, (H - 0.7) / 6.4, 0.56 - t * 0.22],
      ),
    );
  }

  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    const droop = i % 2 === 0 ? 0.45 : 0.72;
    pieces.push({
      at: [0.5 + Math.cos(a) * 1.3, H - 0.15 - droop * 0.9, Math.sin(a) * 1.3],
      geo: UNIT_BOX,
      mat: FROND_MAT,
      rot: [0, -a, droop],
      size: [2.9, 0.07, 0.62],
    });
  }

  return pieces;
});

const GLYPHS: ReadonlyMap<string, readonly [number, number, number, number, number]> = new Map(
  Object.entries({
    " ": [0, 0, 0, 0, 0],
    "'": [0b0100, 0b0100, 0b0000, 0b0000, 0b0000],
    "-": [0b0000, 0b0000, 0b1110, 0b0000, 0b0000],
    ".": [0b0000, 0b0000, 0b0000, 0b0000, 0b0100],
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
  } satisfies Record<string, readonly [number, number, number, number, number]>),
);

const GLYPH_PX = 0.075;
const GLYPH_ADVANCE = 5 * GLYPH_PX;
const GLYPH_H = 5 * GLYPH_PX;

const labelWidth = (text: string) => Math.max(0, text.length * GLYPH_ADVANCE - GLYPH_PX);

const labelCache = new Map<string, THREE.BufferGeometry>();

const labelGeo = (text: string) => {
  const cached = labelCache.get(text);

  if (cached) {
    return cached;
  }

  const w = labelWidth(text);
  const quads: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();

  for (let c = 0; c < text.length; c += 1) {
    const rows = GLYPHS.get(text.charAt(c));

    if (!rows) {
      continue;
    }

    const x0 = -w / 2 + c * GLYPH_ADVANCE;

    for (let r = 0; r < 5; r += 1) {
      const bits = rows[r] ?? 0;
      let col = 0;

      while (col < 4) {
        // oxlint-disable-next-line no-bitwise -- a glyph row is a 4-bit mask, MSB is column 0
        if ((bits & (1 << (3 - col))) === 0) {
          col += 1;
          continue;
        }

        let run = 1;

        // oxlint-disable-next-line no-bitwise -- same row mask, walked to the end of the lit run
        while (col + run < 4 && (bits & (1 << (3 - col - run))) !== 0) {
          run += 1;
        }

        m.makeScale(run * GLYPH_PX, GLYPH_PX, 1);
        m.setPosition(x0 + (col + run / 2) * GLYPH_PX, GLYPH_H / 2 - (r + 0.5) * GLYPH_PX, 0);
        quads.push(UNIT_PLANE.clone().applyMatrix4(m));
        col += run;
      }
    }
  }

  const [first] = quads;

  if (!first) {
    return null;
  }

  const geo = quads.length === 1 ? first : mergeGeometries(quads, false);
  labelCache.set(text, geo);

  return geo;
};

const bladeText = (street: string) => {
  let t = street.toUpperCase().replace(/^THE /u, "");
  t = t
    .replace(/ STREET$/u, "")
    .replace(/ AVENUE$/u, " AVE")
    .replace(/ BOULEVARD$/u, " BLVD")
    .replace(/ FREEWAY$/u, " FWY")
    .replace(/ DRIVE$/u, " DR")
    .replace(/ PLACE$/u, " PL")
    .replace(/ ROAD$/u, " RD")
    .replace(/ WAY$/u, " WAY")
    .replace(/ TERRACE$/u, " TER");
  t = t.replaceAll(/[^A-Z0-9'. -]/gu, "");

  if (t.length === 0 || t.length > 13) {
    return null;
  }

  for (const ch of t) {
    if (!GLYPHS.has(ch)) {
      return null;
    }
  }

  return t;
};

const tintNode = (node: THREE.Object3D, hex: number, amt: number) => {
  node.traverse((c) => {
    if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial) {
      c.userData.tint = c.material.color.clone().lerp(new THREE.Color(hex), amt);
    }
  });
};

const cellKey = (gx: number, gz: number) => `${gx},${gz}`;

const inBounds = (gx: number, gz: number) => gx >= 0 && gz >= 0 && gx < GRID_X && gz < GRID_Z;

const uOf = (x: number) => x / WORLD_W + 0.5;
const vOf = (z: number) => z / WORLD_H + 0.5;
const toGx = (x: number) => Math.floor((x + WORLD_W / 2) / ROAD_TILE);
const toGz = (z: number) => Math.floor((z + WORLD_H / 2) / ROAD_TILE);

const claimKey = (x: number, z: number) => `${Math.floor(x / 8)},${Math.floor(z / 8)}`;

interface KerbPoint {
  readonly x: number;
  readonly z: number;
  readonly tx: number;
  readonly tz: number;
  readonly side: 1 | -1;
  readonly half: number;
  readonly district: District;
}

const facingRoad = (p: KerbPoint) => Math.atan2(-p.tz * p.side, -p.tx * p.side);

const dirToYaw = (d: Dir) => {
  switch (d) {
    case N: {
      return Math.PI;
    }

    case S: {
      return 0;
    }

    case E: {
      return -HALF_PI;
    }

    case W: {
      return HALF_PI;
    }

    default: {
      return 0;
    }
  }
};

const cornerQuarter = (bit: (d: Dir) => boolean) => {
  if (bit(S) && bit(W)) {
    return 0;
  }

  if (bit(W) && bit(N)) {
    return 1;
  }

  if (bit(N) && bit(E)) {
    return 2;
  }

  if (bit(E) && bit(S)) {
    return 3;
  }

  return null;
};

const LIGHT_FOR = {
  commercial: LIGHT_SQUARE_DOUBLE,
  downtown: LIGHT_SQUARE,
  highrise: LIGHT_SQUARE,
  industrial: LIGHT_SQUARE,
  park: LIGHT_CURVED,
  residential: LIGHT_CURVED,
  victorian: LIGHT_CURVED,
  wharf: LIGHT_CURVED_CROSS,
} satisfies Record<DistrictChar, string>;

const inPark = (x: number, z: number) =>
  districtAt(Math.floor((x + WORLD_W / 2) / ROAD_TILE), Math.floor((z + WORLD_H / 2) / ROAD_TILE))
    .character === "park";

const isGGPark = (gx: number, gz: number) =>
  inBounds(gx, gz) && districtAt(gx, gz).name === "Golden Gate Park";

// oxlint-disable-next-line complexity -- one sequential dressing pipeline of ~20 passes over a scope of shared placement helpers; splitting it is a refactor, not a lint fix
export const buildFurniture: (ctx: FurnitureCtx) => Promise<FurnitureResult> = async (ctx) => {
  let lastYield = performance.now();

  const breathe = async () => {
    if (performance.now() - lastYield < 12) {
      return;
    }

    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => {
      setTimeout(resolve, 0);
    });

    await promise;
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
  const pierDecks: SurfaceDeck[] = [];
  const parkedCars: ParkedSpec[] = [];
  const lampHeads: LampHead[] = [];

  const roadAt = (gx: number, gz: number) =>
    inBounds(gx, gz) ? (plan.roads[gx]?.[gz] ?? null) : null;

  const onAsphalt = (x: number, z: number, margin = 0.3) => {
    const hit = network.nearest(x, z, ROAD_TILE * 1.4);

    return hit !== null && hit.dist < hit.edge.half + margin;
  };

  const surfaceAt = makeStandingSurface(network, terrain, groundOffset, roadDrape);

  const nonCardinalStreet = (gx: number, gz: number) => {
    const hit = network.nearest(worldX(gx), worldZ(gz), ROAD_TILE * 1.6);

    if (!hit) {
      return false;
    }

    return Math.abs(Math.sin(2 * Math.atan2(hit.tx, hit.tz))) >= 0.18;
  };

  const cellAt = (gx: number, gz: number) =>
    inBounds(gx, gz) ? (plan.cells[gx]?.[gz] ?? null) : null;

  const straightAlongX = (gx: number, gz: number) =>
    cellAt(gx + 1, gz) === "road" || cellAt(gx - 1, gz) === "road";

  const centreX = (GRID_X - 1) / 2;
  const centreZ = (GRID_Z - 1) / 2;

  const nearCentre = (gx: number, gz: number, r: number) =>
    Math.hypot(gx - centreX, gz - centreZ) <= r;

  const place = (url: string, x: number, y: number, z: number, yaw: number, s: number) => {
    if (!ctx.treeClear(url, { scaleX: s, scaleZ: s, x, yaw, z })) {
      return false;
    }

    const node = cache.instance(url);
    node.scale.setScalar(s);
    node.rotation.y = yaw;
    node.position.set(x, y, z);
    node.updateMatrixWorld(true);
    objects.push(node);

    return true;
  };

  const seat = (
    url: string,
    x: number,
    z: number,
    yaw: number,
    s: number,
    allowAsphalt = false,
  ) => {
    if (!allowAsphalt && onAsphalt(x, z, 0.2)) {
      return false;
    }

    return place(url, x, surfaceAt(x, z), z, yaw, s);
  };

  const placeKK = (url: string, x: number, y: number, z: number, yaw: number, s: number) => {
    if (!ctx.treeClear(url, { scaleX: s, scaleZ: s, x, yaw, z })) {
      return false;
    }

    const node = cache.instance(url);
    tintNode(node, KK_TINT, KK_TINT_AMT);
    node.scale.setScalar(s);
    node.rotation.y = yaw;
    node.position.set(x, y, z);
    node.updateMatrixWorld(true);
    objects.push(node);

    return true;
  };

  const seatKK = (url: string, x: number, z: number, yaw: number, s: number) => {
    if (onAsphalt(x, z, 0.2)) {
      return false;
    }

    return placeKK(url, x, surfaceAt(x, z), z, yaw, s);
  };

  const nextToJunction = (gx: number, gz: number) => {
    for (const d of DIRS) {
      const [dx, dz] = DIR_DELTA[d];
      const nb = roadAt(gx + dx, gz + dz);

      if (nb && (nb.kind === "cross" || nb.kind === "tee")) {
        return true;
      }
    }

    return false;
  };

  const scaleToHeight = (url: string, h: number) => h / Math.max(cache.bounds(url).size.y, 0.001);

  const box = (
    mat: THREE.Material,
    sx: number,
    sy: number,
    sz: number,
    x: number,
    y: number,
    z: number,
  ) => {
    const mesh = new THREE.Mesh(UNIT_BOX, mat);
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(x, y, z);
    mesh.updateMatrixWorld(true);
    objects.push(mesh);
  };

  const cornerClean = (gx: number, gz: number, sx: 1 | -1, sz: 1 | -1) =>
    cellAt(gx + sx, gz + sz) !== "road";

  const claims = new Map<string, [number, number][]>();

  const claim = (x: number, z: number) => {
    const k = claimKey(x, z);
    const list = claims.get(k);

    if (list) {
      list.push([x, z]);
    } else {
      claims.set(k, [[x, z]]);
    }
  };

  const claimFree = (x: number, z: number, r: number) => {
    const bx = Math.floor(x / 8);
    const bz = Math.floor(z / 8);

    for (let i = -1; i <= 1; i += 1) {
      for (let j = -1; j <= 1; j += 1) {
        const list = claims.get(`${bx + i},${bz + j}`);

        if (!list) {
          continue;
        }

        for (const [px, pz] of list) {
          if (Math.hypot(px - x, pz - z) < r) {
            return false;
          }
        }
      }
    }

    return true;
  };

  const claimSeat = (x: number, z: number, r: number) => {
    if (!claimFree(x, z, r)) {
      return false;
    }

    if (onAsphalt(x, z, 0.25)) {
      return false;
    }

    claim(x, z);

    return true;
  };

  const placeKit = (
    parts: readonly KitPart[],
    x: number,
    y: number,
    z: number,
    yaw: number,
    s = 1,
    tint?: THREE.Color,
  ) => {
    for (const p of parts) {
      const mesh = new THREE.Mesh(p.geo, p.mat);
      mesh.position.set(x, y, z);
      mesh.rotation.y = yaw;
      mesh.scale.setScalar(s);

      if (tint) {
        mesh.userData.tint = tint;
      }

      mesh.updateMatrixWorld(true);
      objects.push(mesh);
    }
  };

  const WIRE_DIR = new THREE.Vector3();

  const placeWire = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);

    if (len < 1) {
      return;
    }

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

  const edgeStreet = new Map<number, string>();
  const streetLength = new Map<string, number>();
  const modeEdges = new Map<TransitMode, Set<number>>();

  for (const mode of TRANSIT_MODES) {
    const set = new Set<number>();

    for (const corridor of SF_TRANSIT[mode]) {
      for (const id of corridor.edges) {
        set.add(id);

        if (corridor.street) {
          edgeStreet.set(id, corridor.street);
        }
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

  const byEdgeId = new Map<number, NetEdge>();

  for (const edge of network.edges) {
    byEdgeId.set(edge.id, edge);
  }

  const edgeById = (id: number) => byEdgeId.get(id) ?? null;

  const topCorridors = (mode: TransitMode, n: number) => {
    const out: NetEdge[] = [];

    for (const corridor of SF_TRANSIT[mode].slice(0, n)) {
      for (const id of corridor.edges) {
        const edge = edgeById(id);

        if (edge) {
          out.push(edge);
        }
      }
    }

    return out;
  };

  const kerbWalk = (
    edge: NetEdge,
    spacing: number,
    lateral: number,
    visit: (p: KerbPoint) => void,
    sideOf?: (s: number) => 1 | -1,
  ) => {
    const trimA = network.nodeTrim(edge.a) + 2.5;
    const trimB = network.nodeTrim(edge.b) + 2.5;

    if (edge.len - trimA - trimB < spacing * 0.5) {
      return;
    }

    for (let s = trimA + spacing * 0.5; s < edge.len - trimB; s += spacing) {
      const side: 1 | -1 = sideOf?.(s) ?? (rng.chance(0.5) ? 1 : -1);
      const smp = network.sample(edge, s);
      const off = (edge.half + lateral) * side;
      const px = smp.x - smp.tz * off;
      const pz = smp.z + smp.tx * off;
      const gx = toGx(px);
      const gz = toGz(pz);

      if (!inBounds(gx, gz)) {
        continue;
      }

      if (reserved.has(cellKey(gx, gz))) {
        continue;
      }

      visit({
        district: districtAt(gx, gz),
        half: edge.half,
        side,
        tx: smp.tx,
        tz: smp.tz,
        x: px,
        z: pz,
      });
    }
  };

  const lightSide = new Map<string, 1 | -1>();
  const LAMP_SPACING = ROAD_TILE * 4.5;
  let lampFlip = false;

  for (const edge of network.edges) {
    await breathe();
    const mid = network.sample(edge, edge.len / 2);

    if (inPark(mid.x, mid.z)) {
      continue;
    }

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

      if (reserved.has(cellKey(gx, gz))) {
        continue;
      }

      const yaw = Math.atan2(-smp.tz * side, smp.tx * side);
      const char = districtAt(gx, gz).character;
      const groundY = surfaceAt(px, pz);

      if (char === "victorian") {
        const url = modelUrl("props", LIGHT_OLD);

        if (!seatKK(url, px, pz, yaw, scaleToHeight(url, VICTORIAN_LAMP_HEIGHT))) {
          continue;
        }

        lampHeads.push({
          ground: groundY,
          x: px,
          y: groundY + VICTORIAN_LAMP_HEIGHT * 0.85,
          z: pz,
        });
      } else {
        const url = modelUrl("props", LIGHT_FOR[char]);
        const sc = scaleToHeight(url, LIGHT_HEIGHT);

        if (!seat(url, px, pz, yaw, sc)) {
          continue;
        }

        const reach = cache.bounds(url).size.z * sc * 0.5;
        lampHeads.push({
          ground: groundY,
          x: px - Math.sin(yaw) * reach,
          y: groundY + LIGHT_HEIGHT * 0.92,
          z: pz - Math.cos(yaw) * reach,
        });
      }

      lightSide.set(cellKey(gx, gz), side);
      claim(px, pz);
    }
  }

  for (const edge of network.edges) {
    await breathe();
    const trimA = network.nodeTrim(edge.a) + 3;
    const trimB = network.nodeTrim(edge.b) + 3;

    for (let s = trimA; s < edge.len - trimB; s += ROAD_TILE) {
      if (!rng.chance(0.3)) {
        continue;
      }

      const smp = network.sample(edge, s);
      const gx = toGx(smp.x);
      const gz = toGz(smp.z);

      if (reserved.has(cellKey(gx, gz))) {
        continue;
      }

      if (nearCentre(gx, gz, 2)) {
        continue;
      }

      const char = districtAt(gx, gz).character;

      if (char !== "residential" && char !== "victorian" && char !== "commercial") {
        continue;
      }

      const side: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const off = (edge.half - 1.05) * side;
      const px = smp.x - smp.tz * off;
      const pz = smp.z + smp.tx * off;
      const owner = network.nearest(px, pz, ROAD_TILE * 1.4);

      if (owner && owner.edge.id !== edge.id && owner.dist < owner.edge.half - 1.05) {
        continue;
      }

      const yaw = Math.atan2(smp.tx, smp.tz) + (side > 0 ? 0 : Math.PI) + rng.range(-0.04, 0.04);
      parkedCars.push({ model: rng.pick(TRAFFIC_CARS), x: px, yaw, z: pz });
    }
  }

  const steepLot = (gx: number, gz: number) => {
    const wx = worldX(gx);
    const wz = worldZ(gz);
    const fh = ROAD_TILE * 0.4;

    const hs = [
      terrain.heightAt(wx - fh, wz - fh),
      terrain.heightAt(wx + fh, wz - fh),
      terrain.heightAt(wx - fh, wz + fh),
      terrain.heightAt(wx + fh, wz + fh),
    ];

    return Math.max(...hs) - Math.min(...hs) > STEEP_CLIFF;
  };

  for (const b of plan.buildingCells) {
    if (reserved.has(cellKey(b.gx, b.gz))) {
      continue;
    }

    if (steepLot(b.gx, b.gz)) {
      continue;
    }

    const district = districtAt(b.gx, b.gz);
    const [dx, dz] = DIR_DELTA[b.faceDir];

    if (nonCardinalStreet(b.gx, b.gz)) {
      continue;
    }

    const perpX = dz;
    const perpZ = dx;
    const wx = worldX(b.gx);
    const wz = worldZ(b.gz);

    if (district.character === "wharf" && rng.chance(0.2)) {
      const corner: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const px = wx + dx * ROAD_TILE * 0.38 + perpX * corner * ROAD_TILE * 0.3;
      const pz = wz + dz * ROAD_TILE * 0.38 + perpZ * corner * ROAD_TILE * 0.3;
      const url = modelUrl("props", rng.chance(0.5) ? PROP_PARASOL_A : PROP_PARASOL_B);
      seat(url, px, pz, rng.range(0, Math.PI * 2), scaleToHeight(url, 2.4));
    } else if (district.character === "industrial" && rng.chance(0.5)) {
      const stacks = 1 + rng.int(2);
      const firstCorner: 1 | -1 = rng.chance(0.5) ? 1 : -1;

      for (let i = 0; i < stacks; i += 1) {
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

  {
    const eligible = network.edges.filter((e) => e.len > 60);
    const coneUrl = modelUrl("props", PROP_CONE);
    const coneScale = scaleToHeight(coneUrl, 0.75);
    const barrierUrl = modelUrl("props", PROP_BARRIER);
    const lightUrl = modelUrl("props", PROP_CONSTRUCTION_LIGHT);

    for (let p = 0; p < CONSTRUCTION_POCKETS && eligible.length > 0; p += 1) {
      const edge = eligible[rng.int(eligible.length)];

      if (!edge) {
        continue;
      }

      const s0 = rng.range(edge.len * 0.25, edge.len * 0.7);
      const smp = network.sample(edge, s0);
      const gx = toGx(smp.x);
      const gz = toGz(smp.z);

      if (reserved.has(cellKey(gx, gz)) || nearCentre(gx, gz, 3)) {
        continue;
      }

      const side: 1 | -1 = rng.chance(0.5) ? 1 : -1;

      const at = (t: number) => {
        const p2 = network.sample(edge, s0 + (t - 0.5) * 8);
        const lat = side * (edge.half - 1) * (1 - t);

        return { x: p2.x - p2.tz * lat, z: p2.z + p2.tx * lat };
      };

      const cones = 3 + rng.int(2);

      for (let i = 0; i < cones; i += 1) {
        const t = cones > 1 ? i / (cones - 1) : 0.5;
        const pos = at(t);
        seat(
          coneUrl,
          pos.x + rng.range(-0.3, 0.3),
          pos.z + rng.range(-0.3, 0.3),
          rng.range(0, Math.PI * 2),
          coneScale,
          true,
        );
      }

      const bPos = at(0.5);
      const bYaw = Math.atan2(smp.tz, -smp.tx);
      seat(barrierUrl, bPos.x, bPos.z, bYaw, scaleToHeight(barrierUrl, 1.1), true);
      solids.push({
        maxX: bPos.x + 1,
        maxY: surfaceAt(bPos.x, bPos.z) + 1.6,
        maxZ: bPos.z + 1,
        minX: bPos.x - 1,
        minZ: bPos.z - 1,
      });
      const lPos = at(0.08);
      seat(lightUrl, lPos.x, lPos.z, bYaw, scaleToHeight(lightUrl, 2), true);

      if (rng.chance(0.75)) {
        const vUrl = modelUrl("cars", rng.pick(CONSTRUCTION_VEHICLES));
        const vPos = at(0.85);
        const vYaw = Math.atan2(smp.tx, smp.tz) + (rng.chance(0.5) ? 0 : Math.PI);
        seat(vUrl, vPos.x, vPos.z, vYaw + rng.range(-0.15, 0.15), scaleToHeight(vUrl, 1.9), true);
        solids.push({
          maxX: vPos.x + 1.2,
          maxY: surfaceAt(vPos.x, vPos.z) + 1.9,
          maxZ: vPos.z + 1.2,
          minX: vPos.x - 1.2,
          minZ: vPos.z - 1.2,
        });
      }
    }
  }

  const treeUrl = modelUrl("props", TREE_LARGE);
  const planterUrl = modelUrl("props", PROP_PLANTER);
  const planterScale = 1.5 / Math.max(cache.bounds(planterUrl).size.x, 0.001);

  for (let gx = 0; gx < GRID_X; gx += 1) {
    for (let gz = 0; gz < GRID_Z; gz += 1) {
      await breathe();

      if (!isGGPark(gx, gz)) {
        continue;
      }

      if (reserved.has(cellKey(gx, gz))) {
        continue;
      }

      if (cellAt(gx, gz) !== "lot") {
        continue;
      }

      const wx = worldX(gx);
      const wz = worldZ(gz);
      const edges: number[] = [];

      if (!isGGPark(gx, gz - 1)) {
        edges.push(-1);
      }

      if (!isGGPark(gx, gz + 1)) {
        edges.push(1);
      }

      for (const edge of edges) {
        const tz = wz + edge * (ROAD_TILE * 0.5 - 0.9);

        for (const off of [-0.25, 0.25] as const) {
          const tx = wx + off * ROAD_TILE;

          if (onAsphalt(tx, tz, 1.6)) {
            continue;
          }

          const planted = seat(
            treeUrl,
            tx,
            tz,
            rng.range(0, Math.PI * 2),
            scaleToHeight(treeUrl, rng.range(5, 6.5)),
          );

          if (planted) {
            solids.push({
              maxX: tx + 0.55,
              maxZ: tz + 0.55,
              minX: tx - 0.55,
              minZ: tz - 0.55,
              noBody: true,
            });
          }
        }
      }

      if (rng.chance(0.25)) {
        const count = 3 + rng.int(3);

        for (let i = 0; i < count; i += 1) {
          const px = wx + rng.range(-2.6, 2.6);
          const pz = wz + rng.range(-2.6, 2.6);

          if (onAsphalt(px, pz, 1.2)) {
            continue;
          }

          seat(planterUrl, px, pz, rng.range(0, Math.PI * 2), planterScale);
        }
      }
    }
  }

  const lakeGx = Math.round(GGP_LAKE.u * GRID_X - 0.5);
  const lakeGz = Math.round(GGP_LAKE.v * GRID_Z - 0.5);

  if (isGGPark(lakeGx, lakeGz) && !reserved.has(cellKey(lakeGx, lakeGz))) {
    const lake = new THREE.Mesh(new THREE.CircleGeometry(1, STOW_WATER_SEGMENTS), LAKE_MAT);
    lake.scale.set(GGP_LAKE.ru, GGP_LAKE.rv, 1);
    lake.rotation.x = -HALF_PI;
    lake.position.set((GGP_LAKE.u - 0.5) * WORLD_W, STOW_WATER_Y, (GGP_LAKE.v - 0.5) * WORLD_H);
    lake.name = "stow-water";
    lake.updateMatrixWorld(true);
    objects.push(lake);
  }

  const isParkCell = (gx: number, gz: number) =>
    inBounds(gx, gz) && cellAt(gx, gz) === "lot" && isParkDistrictLand(gx, gz);

  const isPathCell = (gx: number, gz: number) =>
    inBounds(gx, gz) && cellAt(gx, gz) === "lot" && parkPathMaskAt(gx, gz);

  const pathMask = (gx: number, gz: number) => {
    let mask = 0;

    for (const d of DIRS) {
      const [dx, dz] = DIR_DELTA[d];

      if (isPathCell(gx + dx, gz + dz) || cellAt(gx + dx, gz + dz) === "road") {
        // oxlint-disable-next-line no-bitwise -- the neighbour mask is a bit set, one bit per Dir
        mask |= 1 << d;
      }
    }

    return mask;
  };

  const pathStraight = () => {
    if (rng.chance(0.5)) {
      return "park-road-straight";
    }

    return rng.chance(0.5) ? "park-road-straight-decorated-A" : "park-road-straight-decorated-B";
  };

  const cornerName = () => (rng.chance(0.5) ? "park-road-corner" : "park-road-corner-decorated");

  const pathTileFor = (mask: number) => {
    // oxlint-disable-next-line no-bitwise -- reads one Dir's bit out of the neighbour mask
    const bit = (d: Dir) => (mask & (1 << d)) !== 0;
    // oxlint-disable-next-line no-bitwise -- popcount over the four Dir bits
    const count = (mask & 1 ? 1 : 0) + (mask & 2 ? 1 : 0) + (mask & 4 ? 1 : 0) + (mask & 8 ? 1 : 0);

    if (count >= 4) {
      return { name: "park-road-junction", quarter: 0 };
    }

    if (count === 3) {
      const missing = ([N, E, S, W] as const).find((d) => !bit(d)) ?? N;
      const q = { [N]: 0, [E]: 1, [S]: 2, [W]: 3 }[missing] ?? 0;

      return {
        name: rng.chance(0.5) ? "park-road-tsplit" : "park-road-tsplit-decorated",
        quarter: q,
      };
    }

    if (count === 2) {
      if (bit(N) && bit(S)) {
        return { name: pathStraight(), quarter: 0 };
      }

      if (bit(E) && bit(W)) {
        return { name: pathStraight(), quarter: 1 };
      }

      const corner = cornerQuarter(bit);

      if (corner !== null) {
        return { name: cornerName(), quarter: corner };
      }
    }

    if (count === 1) {
      return { name: pathStraight(), quarter: bit(N) || bit(S) ? 0 : 1 };
    }

    return null;
  };

  const wallUrl = modelUrl("props", PARK_WALL);
  const wallBounds = cache.bounds(wallUrl);
  const wallH = 1.1 / Math.max(wallBounds.size.y, 0.001);

  for (let gx = 0; gx < GRID_X; gx += 1) {
    for (let gz = 0; gz < GRID_Z; gz += 1) {
      await breathe();

      if (!isParkCell(gx, gz)) {
        continue;
      }

      if (reserved.has(cellKey(gx, gz))) {
        continue;
      }

      const wx = worldX(gx);
      const wz = worldZ(gz);

      if (
        stowBasinOverlapsBox(
          wx - ROAD_TILE / 2,
          wx + ROAD_TILE / 2,
          wz - ROAD_TILE / 2,
          wz + ROAD_TILE / 2,
        )
      ) {
        continue;
      }

      if (onAsphalt(wx, wz, ROAD_TILE * 0.55)) {
        continue;
      }

      for (const d of DIRS) {
        const [dx, dz] = DIR_DELTA[d];

        if (cellAt(gx + dx, gz + dz) !== "road") {
          continue;
        }

        const edgeOff = ROAD_TILE / 2 - 0.5;
        const along = dx === 0 ? "x" : "z";
        const runLen = ROAD_TILE / 2 - 2.2;
        const wallRun = runLen / Math.max(wallBounds.size.z, 0.001);

        for (const side of [-1, 1] as const) {
          const mid = side * (2.2 + runLen / 2);
          const px = along === "x" ? wx + mid : wx + dx * edgeOff;
          const pz = along === "x" ? wz + dz * edgeOff : wz + mid;
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

          if (wallY - lowY > 0.15) {
            const drop = wallY - lowY + 0.25;
            const footing = new THREE.Mesh(WALL_FOOTING_BOX, SEAWALL_MAT);
            footing.scale.set(along === "x" ? runLen : 0.72, drop, along === "x" ? 0.72 : runLen);
            footing.position.set(px, wallY + 0.1 - drop / 2, pz);
            footing.updateMatrixWorld(true);
            objects.push(footing);
          }

          const t = 0.5;
          solids.push(
            along === "x"
              ? {
                  maxX: px + runLen / 2,
                  maxY: wallY + 1.4,
                  maxZ: pz + t,
                  minX: px - runLen / 2,
                  minZ: pz - t,
                }
              : {
                  maxX: px + t,
                  maxY: wallY + 1.4,
                  maxZ: pz + runLen / 2,
                  minX: px - t,
                  minZ: pz - runLen / 2,
                },
          );
        }

        for (const side of [-2.2, 2.2] as const) {
          const px = along === "x" ? wx + side : wx + dx * edgeOff;
          const pz = along === "x" ? wz + dz * edgeOff : wz + side;

          if (onAsphalt(px, pz, 1)) {
            continue;
          }

          const post = new THREE.Mesh(GATE_POST_BOX, SEAWALL_MAT);
          post.scale.set(0.9, 2.4, 0.9);
          post.position.set(px, surfaceAt(px, pz) + 1.2, pz);
          post.updateMatrixWorld(true);
          objects.push(post);
        }
      }

      {
        const seatY = parkCellHeight(terrain, gx, gz);
        const spread = seatY - 0.05 - parkCellFloor(terrain, gx, gz);
        let lip = 0;

        for (let a = 0; a < 8; a += 1) {
          const th = (a / 8) * Math.PI * 2;

          const drop =
            seatY -
            surfaceAt(wx + Math.cos(th) * ROAD_TILE * 0.62, wz + Math.sin(th) * ROAD_TILE * 0.62);

          if (drop > lip) {
            lip = drop;
          }
        }

        const roll = rng.range(0, 1);

        if (spread <= 0.8 && lip <= PARK_SKIRT_DEPTH) {
          const path = isPathCell(gx, gz) ? pathTileFor(pathMask(gx, gz)) : null;
          let name = path?.name;

          if (name === undefined) {
            if (spread < 0.3 && roll < 0.015) {
              name = rng.pick(PARK_TILE_PLAZAS);
            } else if (roll < 0.4) {
              name = "park-base-decorated-trees";
            } else if (roll < 0.6) {
              name = "park-base-decorated-bushes";
            } else {
              name = "park-base";
            }
          }

          const url = modelUrl("parks", name);
          const b = cache.bounds(url);
          const sc = ROAD_TILE / Math.max(b.size.x, b.size.z, 0.001);
          const yaw = HALF_PI * (path ? path.quarter : rng.int(4));
          const planted = ctx.treeClear(url, { scaleX: sc, scaleZ: sc, x: wx, yaw, z: wz });
          const node = cache.instance(planted ? url : modelUrl("parks", "park-base"));
          node.scale.setScalar(sc);
          node.rotation.y = yaw;
          node.position.set(wx, seatY, wz);
          node.updateMatrixWorld(true);
          objects.push(node);
          const skirt = new THREE.Mesh(PARK_SKIRT_BOX, SEAWALL_MAT);
          skirt.scale.set(ROAD_TILE * 1.02, PARK_SKIRT_DEPTH, ROAD_TILE * 1.02);
          skirt.position.set(wx, seatY - PARK_SKIRT_DEPTH / 2, wz);
          skirt.updateMatrixWorld(true);
          objects.push(skirt);

          if (planted && name === "park-base-decorated-trees") {
            for (const trunk of getTreeTrunks(cache, url)) {
              const x = wx + (trunk.rootX * Math.cos(yaw) + trunk.rootZ * Math.sin(yaw)) * sc;
              const z = wz + (-trunk.rootX * Math.sin(yaw) + trunk.rootZ * Math.cos(yaw)) * sc;
              solids.push({
                maxX: x + 0.55,
                maxZ: z + 0.55,
                minX: x - 0.55,
                minZ: z - 0.55,
                noBody: true,
              });
            }
          }
        } else {
          const clusters = 1 + rng.int(2);

          for (let c = 0; c < clusters; c += 1) {
            const cx2 = wx + rng.range(-4, 4);
            const cz2 = wz + rng.range(-4, 4);
            const count = 2 + rng.int(4);

            for (let i = 0; i < count; i += 1) {
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
                  maxX: ptx + 0.55,
                  maxZ: ptz + 0.55,
                  minX: ptx - 0.55,
                  minZ: ptz - 0.55,
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

  interface PierColumn {
    gx: number;
    landGz: number;
  }

  const pierCandidates: PierColumn[] = [];

  for (let gx = 0; gx < GRID_X; gx += 1) {
    let landGz = -1;

    for (let gz = 0; gz < GRID_Z; gz += 1) {
      await breathe();

      if (cellAt(gx, gz) !== "water") {
        landGz = gz;
        break;
      }
    }

    if (landGz < 2) {
      continue;
    }

    if (districtAt(gx, landGz).name !== "Fisherman's Wharf") {
      continue;
    }

    const shoreKind = cellAt(gx, landGz);
    const shoreBuilt = plan.buildingCells.some((b) => b.gx === gx && b.gz === landGz);

    if (shoreKind !== "road" && shoreBuilt) {
      continue;
    }

    let anyReserved = reserved.has(cellKey(gx, landGz));

    for (let gz = 0; gz < landGz; gz += 1) {
      if (reserved.has(cellKey(gx, gz))) {
        anyReserved = true;
      }
    }

    if (anyReserved) {
      continue;
    }

    pierCandidates.push({ gx, landGz });
  }

  const chosenPiers: PierColumn[] = [];

  if (pierCandidates.length > 0) {
    const idxs = [0, Math.floor((pierCandidates.length - 1) / 2), pierCandidates.length - 1];

    for (const i of idxs) {
      const col = pierCandidates[i];

      if (col && !chosenPiers.includes(col)) {
        chosenPiers.push(col);
      }
    }
  }

  const pillarUrl = modelUrl("roads", BRIDGE_PILLAR);
  const pillarBounds = cache.bounds(pillarUrl);

  for (let pierIdx = 0; pierIdx < chosenPiers.length; pierIdx += 1) {
    const pier = chosenPiers[pierIdx];

    if (pier === undefined) {
      continue;
    }

    const deckY = PIER_DECK_Y + pierIdx * 0.02;
    const len = Math.min(2 + rng.int(2), pier.landGz);
    const px = worldX(pier.gx);
    const boundary = worldZ(pier.landGz) - ROAD_TILE / 2;

    for (let i = 1; i <= len; i += 1) {
      const gz = pier.landGz - i;

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
    const halfW = PIER_WIDTH / 2;
    const zNorth = worldZ(pier.landGz - len) - PIER_WIDTH / 2;
    pierDecks.push(
      { maxX: px + halfW, maxZ: boundary, minX: px - halfW, minZ: zNorth, y: deckY },
      {
        maxX: px + halfW,
        maxZ: boundary + PIER_RAMP_RUN,
        minX: px - halfW,
        minZ: boundary,
        y: deckY,
        y2: shoreH,
      },
    );

    if (pierIdx === 1) {
      for (let i = 0; i < PIER_END_BUILDINGS.length; i += 1) {
        const name = PIER_END_BUILDINGS[i];

        if (name === undefined) {
          continue;
        }

        const url = modelUrl("buildings", name);
        const bnd = cache.bounds(url);
        const s = (ROAD_TILE * 0.4) / Math.max(bnd.size.x, bnd.size.z, 0.001);
        const bx = px + (i === 0 ? -1 : 1) * ROAD_TILE * 0.24;
        const bz = zNorth + ROAD_TILE * 0.35;
        const node = cache.instance(url);
        tintNode(node, PIER_BUILDING_TINT, 0.5);
        node.scale.setScalar(s);
        node.rotation.y = Math.PI;
        node.position.set(bx, deckY, bz);
        node.updateMatrixWorld(true);
        objects.push(node);
        const half = ROAD_TILE * 0.19;
        solids.push({ maxX: bx + half, maxZ: bz + half, minX: bx - half, minZ: bz - half });
      }
    }
  }

  const hydrantUrl = modelUrl("props", PROP_HYDRANT);
  const hydrantScale = scaleToHeight(hydrantUrl, 0.9);
  let hydrants = 0;

  for (let gx = 0; gx < GRID_X && hydrants < HYDRANT_CAP; gx += 1) {
    for (let gz = 0; gz < GRID_Z && hydrants < HYDRANT_CAP; gz += 1) {
      if (!roadAt(gx, gz)) {
        continue;
      }

      if (reserved.has(cellKey(gx, gz))) {
        continue;
      }

      const char = districtAt(gx, gz).character;

      if (char === "park") {
        continue;
      }

      if (!nextToJunction(gx, gz)) {
        continue;
      }

      if (!rng.chance(0.45)) {
        continue;
      }

      let sx: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      let sz: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      let ok = false;

      for (let c = 0; c < 4 && !ok; c += 1) {
        if (cornerClean(gx, gz, sx, sz)) {
          ok = true;
        } else if (c % 2 === 0) {
          sx = sx > 0 ? -1 : 1;
        } else {
          sz = sz > 0 ? -1 : 1;
        }
      }

      if (!ok) {
        continue;
      }

      const px = worldX(gx) + sx * ROAD_TILE * 0.42;
      const pz = worldZ(gz) + sz * ROAD_TILE * 0.42;

      if (onAsphalt(px, pz)) {
        continue;
      }

      if (!claimFree(px, pz, 1.6)) {
        continue;
      }

      claim(px, pz);
      seatKK(hydrantUrl, px, pz, rng.range(0, Math.PI * 2), hydrantScale);
      hydrants += 1;
    }
  }

  const signalUrl = modelUrl("props", PROP_TRAFFICLIGHT);
  const signalScale = scaleToHeight(signalUrl, 5);

  for (let n = 0; n < network.nodes.length; n += 1) {
    const control = junctionControl(network, n);

    if (control === "none") {
      continue;
    }

    const node = network.nodes[n];

    if (!node) {
      continue;
    }

    const arms = controlArms(network, n);

    if (control === "signal") {
      for (const a of arms) {
        const px = a.px + a.tx * 4.6 + a.tz * (a.half + 1.2);
        const pz = a.pz + a.tz * 4.6 - a.tx * (a.half + 1.2);

        if (onAsphalt(px, pz)) {
          continue;
        }

        const dl = Math.hypot(node[0] - px, node[1] - pz) || 1;
        const yaw = Math.atan2((node[1] - pz) / dl, -(node[0] - px) / dl);
        claim(px, pz);
        seatKK(signalUrl, px, pz, yaw, signalScale);
      }

      continue;
    }

    for (const a of arms) {
      const px = a.px + a.tx * 1.6 + a.tz * (a.half + 0.8);
      const pz = a.pz + a.tz * 1.6 - a.tx * (a.half + 0.8);

      if (onAsphalt(px, pz, 0.2)) {
        continue;
      }

      const gy = surfaceAt(px, pz);
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

  const benchUrl = modelUrl("props", PROP_BENCH);
  const benchScale = scaleToHeight(benchUrl, 0.85);
  let seating = 0;

  for (let gx = 0; gx < GRID_X && seating < SEATING_CAP; gx += 1) {
    for (let gz = 0; gz < GRID_Z && seating < SEATING_CAP; gz += 1) {
      const road = roadAt(gx, gz);

      if (!road) {
        continue;
      }

      if (reserved.has(cellKey(gx, gz))) {
        continue;
      }

      const char = districtAt(gx, gz).character;

      if (char === "industrial" || char === "highrise") {
        continue;
      }

      let lotDir: Dir | null = null;

      for (const d of DIRS) {
        const [dx, dz] = DIR_DELTA[d];

        if (cellAt(gx + dx, gz + dz) === "lot") {
          lotDir = d;
          break;
        }
      }

      if (lotDir === null) {
        continue;
      }

      if (!rng.chance(char === "wharf" || char === "park" ? 0.4 : 0.16)) {
        continue;
      }

      const [dx, dz] = DIR_DELTA[lotDir];
      const lampSide = lightSide.get(cellKey(gx, gz));
      const alongX = road.kind === "straight" && straightAlongX(gx, gz);
      const clash = lampSide !== undefined && (alongX ? dz : dx) === lampSide;
      const slide = clash ? ROAD_TILE * 0.24 : 0;
      const bx = worldX(gx) + dx * ROAD_TILE * 0.42 + dz * slide;
      const bz = worldZ(gz) + dz * ROAD_TILE * 0.42 + dx * slide;

      if (onAsphalt(bx, bz)) {
        continue;
      }

      if (!claimFree(bx, bz, 2.4)) {
        continue;
      }

      claim(bx, bz);
      seatKK(benchUrl, bx, bz, dirToYaw(lotDir) + Math.PI, benchScale);
      seating += 1;

      if (seating >= SEATING_CAP) {
        break;
      }

      let along: 1 | -1 = 1;

      if (!clash) {
        along = rng.chance(0.5) ? 1 : -1;
      }

      const trashUrl = modelUrl("props", rng.chance(0.5) ? PROP_TRASH_A : PROP_TRASH_B);
      const trashBounds = cache.bounds(trashUrl);
      const trashScale = 0.55 / Math.max(trashBounds.size.x, trashBounds.size.z, 0.001);
      seatKK(
        trashUrl,
        bx + dz * along * 1.3,
        bz + dx * along * 1.3,
        rng.range(0, Math.PI * 2),
        trashScale,
      );
      seating += 1;
    }
  }

  const dumpsterUrl = modelUrl("props", PROP_DUMPSTER);
  const dumpsterScale = scaleToHeight(dumpsterUrl, 1.5);

  for (const b of plan.buildingCells) {
    if (reserved.has(cellKey(b.gx, b.gz))) {
      continue;
    }

    if (districtAt(b.gx, b.gz).character !== "industrial") {
      continue;
    }

    const [dx, dz] = DIR_DELTA[b.faceDir];

    if (nonCardinalStreet(b.gx, b.gz)) {
      continue;
    }

    const perpX = dz;
    const perpZ = dx;
    const wx = worldX(b.gx);
    const wz = worldZ(b.gz);

    if (rng.chance(0.4)) {
      const corner: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const px = wx - dx * ROAD_TILE * 0.4 + perpX * corner * ROAD_TILE * 0.16;
      const pz = wz - dz * ROAD_TILE * 0.4 + perpZ * corner * ROAD_TILE * 0.16;
      seatKK(dumpsterUrl, px, pz, dirToYaw(b.faceDir) + rng.range(-0.08, 0.08), dumpsterScale);
    }

    if (rng.chance(0.5)) {
      const crates = 1 + rng.int(2);

      for (let i = 0; i < crates; i += 1) {
        const url = modelUrl("props", rng.chance(0.5) ? PROP_BOX_A : PROP_BOX_B);
        const back = 0.28 + rng.range(0, 0.1);
        const lat = rng.range(-0.24, 0.24);
        const px = wx - dx * ROAD_TILE * back + perpX * lat * ROAD_TILE;
        const pz = wz - dz * ROAD_TILE * back + perpZ * lat * ROAD_TILE;
        seatKK(url, px, pz, rng.range(0, Math.PI * 2), scaleToHeight(url, 0.8));
      }
    }
  }

  const towerLots = plan.buildingCells.filter((b) => {
    if (reserved.has(cellKey(b.gx, b.gz))) {
      return false;
    }

    if (districtAt(b.gx, b.gz).character !== "industrial") {
      return false;
    }

    return !nonCardinalStreet(b.gx, b.gz);
  });

  const towerUrl = modelUrl("props", PROP_WATERTOWER);
  const towerScale = scaleToHeight(towerUrl, 13);
  const towerCount = Math.min(2 + rng.int(2), towerLots.length);

  for (let i = 0; i < towerCount; i += 1) {
    const idx = rng.int(towerLots.length);
    const lot = towerLots[idx];

    if (lot === undefined) {
      continue;
    }

    towerLots.splice(idx, 1);
    const [dx, dz] = DIR_DELTA[lot.faceDir];
    const px = worldX(lot.gx) - dx * ROAD_TILE * 0.18;
    const pz = worldZ(lot.gz) - dz * ROAD_TILE * 0.18;
    seatKK(towerUrl, px, pz, rng.range(0, Math.PI * 2), towerScale);
  }

  const census: Record<string, number> = {};

  const bump = (k: string, n = 1) => {
    census[k] = (census[k] ?? 0) + n;
  };

  const TROLLEY_CORRIDOR_COUNT = 8;
  const TROLLEY_SPAN = 30;
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
      const trimA = network.nodeTrim(edge.a) + 3;
      const trimB = network.nodeTrim(edge.b) + 3;

      if (edge.len - trimA - trimB < TROLLEY_SPAN) {
        continue;
      }

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
          stations += 1;
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
            placeWire(lx, ly + spanY, lz, lx - smp.tx * 3.2, ly + 0.3, lz - smp.tz * 3.2);
          }

          bump("trolleySpan", prev ? 3 : 2);
          sinceTransformer += 1;

          if (sinceTransformer >= 7) {
            sinceTransformer = 0;
            placeKit(transformerKit(), lx, ly + 4.4, lz, Math.atan2(-smp.tz, -smp.tx));
          }

          prev = { lx, ly, lz, rx, ry, rz };
        } else {
          prev = null;
        }
      }
    }

    let poles = 0;

    for (const edge of network.edges) {
      if (poles >= POWER_POLE_CAP) {
        break;
      }

      await breathe();
      const mid = network.sample(edge, edge.len / 2);

      if (uOf(mid.x) > 0.6) {
        continue;
      }

      if (inPark(mid.x, mid.z)) {
        continue;
      }

      const char = districtAt(toGx(mid.x), toGz(mid.z)).character;

      if (char !== "residential" && char !== "victorian") {
        continue;
      }

      if (edge.len < POWER_SPAN * 1.6) {
        continue;
      }

      if (!rng.chance(0.3)) {
        continue;
      }

      const side: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      let prev: { x: number; y: number; z: number } | null = null;
      kerbWalk(
        edge,
        POWER_SPAN,
        1.1,
        // oxlint-disable-next-line no-loop-func -- kerbWalk runs the visitor synchronously inside this iteration; `prev` is this edge's own span state and `poles` is the pass-wide cap, both shared on purpose
        (p) => {
          if (poles >= POWER_POLE_CAP) {
            return;
          }

          if (!claimSeat(p.x, p.z, 2.2)) {
            prev = null;

            return;
          }

          const y = surfaceAt(p.x, p.z);
          placeKit(powerPoleKit(), p.x, y, p.z, Math.atan2(p.tx, p.tz));
          bump("powerPole");
          poles += 1;

          if (prev) {
            bump("powerSpan", 2);
          }

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

  const SHELTER_CAP = 140;
  const STOP_CAP = 260;
  const STOP_PITCH = 92;

  const ROUTE_FOR: ReadonlyMap<string, string> = new Map(
    Object.entries({
      "16th Street": "22",
      "3rd Street": "T",
      "California Street": "1",
      "Castro Street": "24",
      "Clay Street": "1",
      "Columbus Avenue": "30",
      "Divisadero Street": "24",
      "Eddy Street": "31",
      "Fillmore Street": "22",
      "Geary Street": "38",
      "Hyde Street": "PH",
      "Market Street": "F",
      "Mason Street": "PM",
      "Mission Street": "14",
      "Powell Street": "PM",
      "Sacramento Street": "1",
      "Sutter Street": "2",
      "The Embarcadero": "E",
      "Union Street": "45",
      "Van Ness Avenue": "49",
    } satisfies Record<string, string>),
  );

  {
    let shelters = 0;
    let stops = 0;
    const { parcelClear } = ctx;
    const shelterParts = getMuniShelterKit();
    const poleParts = stopPoleKit();
    const served = new Set<number>();

    for (const mode of ["trolleybus", "tram", "cable", "light_rail"] as const) {
      const take = mode === "trolleybus" ? TROLLEY_CORRIDOR_COUNT : SF_TRANSIT[mode].length;

      for (const edge of topCorridors(mode, take)) {
        if (stops >= STOP_CAP) {
          break;
        }

        if (served.has(edge.id)) {
          continue;
        }

        served.add(edge.id);
        await breathe();
        const street = edgeStreet.get(edge.id) ?? "";
        const route = ROUTE_FOR.get(street) ?? "MUNI";
        const routeGeo = labelGeo(route);
        // oxlint-disable-next-line no-loop-func -- kerbWalk runs the visitor synchronously inside this iteration; it needs this edge's `routeGeo` and the pass-wide `stops` cap
        kerbWalk(edge, STOP_PITCH, 1.4, (p) => {
          if (stops >= STOP_CAP) {
            return;
          }

          const shelterYaw = Math.atan2(p.tz * p.side, -p.tx * p.side);
          const cos = Math.cos(shelterYaw);
          const sin = Math.sin(shelterYaw);

          const footOffsets: readonly (readonly [number, number])[] = [
            [-1.91, -0.7],
            [-1.91, 0.69],
            [1.91, -0.7],
            [1.91, 0.69],
            [-1.33, -0.23],
            [1.14, -0.23],
          ];

          const candidates = [0, -5, 5].flatMap((along) =>
            [1.15, 0.65, 0.15].map((back) => ({
              x: p.x + p.tx * along - p.tz * p.side * back,
              z: p.z + p.tz * along + p.tx * p.side * back,
            })),
          );

          let site: {
            readonly x: number;
            readonly z: number;
            readonly top: number;
            readonly feet: readonly {
              readonly x: number;
              readonly y: number;
              readonly z: number;
            }[];
          } | null = null;

          if (shelters < SHELTER_CAP) {
            for (const candidate of candidates) {
              const { x: bx, z: bz } = candidate;
              const gx = Math.floor((bx + WORLD_W / 2) / ROAD_TILE);
              const gz = Math.floor((bz + WORLD_H / 2) / ROAD_TILE);

              if (reserved.has(cellKey(gx, gz)) || !claimFree(bx, bz, 5.2)) {
                continue;
              }

              if (network.nearest(bx, bz, ROAD_TILE)?.edge.id !== edge.id) {
                continue;
              }

              if (
                !parcelClear(
                  { halfDepth: 0.95, halfWidth: 2.2, x: bx, yaw: shelterYaw, z: bz },
                  0.6,
                )
              ) {
                continue;
              }

              const laneClear = [-2.2, 0, 2.2].every((x) =>
                [-0.95, 0, 0.95].every(
                  (z) => !onAsphalt(bx + x * cos + z * sin, bz - x * sin + z * cos, 0.5),
                ),
              );

              if (!laneClear) {
                continue;
              }

              const feet = footOffsets.map(([x, z]) => {
                const fx = bx + x * cos + z * sin;
                const fz = bz - x * sin + z * cos;

                return { x: fx, y: surfaceAt(fx, fz), z: fz };
              });

              const top = Math.max(...feet.map((f) => f.y));
              const bottom = Math.min(...feet.map((f) => f.y));

              if (top - bottom > 0.8) {
                continue;
              }

              site = { feet, top, x: bx, z: bz };
              break;
            }
          }

          if (site) {
            const { x: bx, z: bz, feet, top } = site;
            claim(bx, bz);
            const seatY = top + 0.025;
            placeKit(shelterParts, bx, seatY, bz, shelterYaw);

            for (const foot of feet) {
              const height = seatY - foot.y;
              box(
                SEAWALL_MAT,
                0.26,
                height + 0.02,
                0.25,
                foot.x,
                foot.y + height / 2 - 0.01,
                foot.z,
              );
            }

            solids.push({
              maxX: bx + 2.3,
              maxZ: bz + 2.3,
              minX: bx - 2.3,
              minZ: bz - 2.3,
              noBody: true,
            });
            bump("shelter");
            shelters += 1;
          }

          if (!claimSeat(p.x, p.z, 1.8)) {
            return;
          }

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
          stops += 1;
        });
      }
    }
  }

  {
    const done: [number, number][] = [];
    const parts = turntableKit();

    for (const line of SF_TRANSIT_LINES) {
      if (line.mode !== "cable") {
        continue;
      }

      const { p } = line;

      const ends: readonly (readonly [number, number])[] = [
        [p[0] ?? 0, p[1] ?? 0],
        [p.at(-2) ?? 0, p.at(-1) ?? 0],
      ];

      for (const [ex, ez] of ends) {
        if (done.some(([dx2, dz2]) => Math.hypot(dx2 - ex, dz2 - ez) < 12)) {
          continue;
        }

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

        if (onAsphalt(px, pz, TURNTABLE_R * 0.4)) {
          continue;
        }

        done.push([ex, ez]);
        claim(px, pz);
        bump("turntable");
        placeKit(parts, px, surfaceAt(px, pz), pz, rng.range(0, Math.PI * 2));
      }
    }
  }

  const JAPANTOWN = { uMax: 0.565, uMin: 0.5, vMax: 0.268, vMin: 0.222 } as const;
  const TREE_CAP = 9000;
  const TREE_PITCH = ROAD_TILE * 1.8;

  type TreeKind = "cypress" | "eucalyptus" | "palm" | "plane" | "cherry" | "mixed";

  const treeKindAt: (x: number, z: number, district: District, street: string) => TreeKind = (
    x,
    z,
    district,
    street,
  ) => {
    if (district.name === "the Presidio") {
      return rng.chance(0.5) ? "eucalyptus" : "cypress";
    }

    if (street === "Market Street") {
      return "plane";
    }

    const u = uOf(x);
    const v = vOf(z);

    if (u >= JAPANTOWN.uMin && u <= JAPANTOWN.uMax && v >= JAPANTOWN.vMin && v <= JAPANTOWN.vMax) {
      return "cherry";
    }

    if (district.name === "the Embarcadero" || district.name === "Mission Dolores") {
      return "palm";
    }

    if (u < 0.42) {
      return rng.chance(0.55) ? "cypress" : "eucalyptus";
    }

    return "mixed";
  };

  {
    const wellParts = treeWellKit();
    const palmParts = palmKit();
    let trees = 0;

    for (const edge of network.edges) {
      if (trees >= TREE_CAP) {
        break;
      }

      await breathe();
      const mid = network.sample(edge, edge.len / 2);
      const midDistrict = districtAt(toGx(mid.x), toGz(mid.z));

      if (midDistrict.character === "park" && midDistrict.name !== "the Presidio") {
        continue;
      }

      const street = edgeStreet.get(edge.id) ?? "";
      // oxlint-disable-next-line no-loop-func -- kerbWalk runs the visitor synchronously inside this iteration; it needs this edge's `street` and the pass-wide `trees` cap
      kerbWalk(edge, TREE_PITCH, 1.5, (p) => {
        if (trees >= TREE_CAP) {
          return;
        }

        if (!rng.chance(0.72)) {
          return;
        }

        if (!claimSeat(p.x, p.z, 3.2)) {
          return;
        }

        const roadHit = network.nearest(p.x, p.z, ROAD_TILE * 1.4);

        if (roadHit !== null && roadHit.dist < roadHit.edge.half + 0.9) {
          return;
        }

        const y = surfaceAt(p.x, p.z);
        const kind = treeKindAt(p.x, p.z, p.district, street);
        trees += 1;

        if (kind === "palm") {
          const yaw = rng.range(0, Math.PI * 2);
          const scale = rng.range(0.82, 1.15);

          if (
            !ctx.parcelClear(
              {
                halfDepth: 0.28 * scale,
                halfWidth: 0.475 * scale,
                x: p.x + 0.195 * scale * Math.cos(yaw),
                yaw,
                z: p.z - 0.195 * scale * Math.sin(yaw),
              },
              0.05,
            )
          ) {
            return;
          }

          placeKit(palmParts, p.x, y, p.z, yaw, scale);
        } else {
          const small = kind === "cherry";
          const url = modelUrl("props", small ? TREE_SMALL : TREE_LARGE);
          const bounds = cache.bounds(url);
          let height: number;

          if (kind === "eucalyptus") {
            height = rng.range(9, 11.5);
          } else if (kind === "cypress") {
            height = rng.range(7, 9);
          } else if (kind === "plane") {
            height = rng.range(5.6, 7);
          } else if (kind === "cherry") {
            height = rng.range(3.6, 4.6);
          } else {
            height = rng.range(5, 7);
          }

          let spread = 1;

          if (kind === "eucalyptus") {
            spread = 0.58;
          } else if (kind === "cypress") {
            spread = 0.66;
          } else if (kind === "plane") {
            spread = 1.2;
          }

          const sy = height / Math.max(bounds.size.y, 0.001);
          const yaw = rng.range(0, Math.PI * 2);

          if (
            !ctx.treeClear(url, {
              scaleX: sy * spread,
              scaleZ: sy * spread,
              x: p.x,
              yaw,
              z: p.z,
            })
          ) {
            return;
          }

          const node = cache.instance(url);
          node.scale.set(sy * spread, sy, sy * spread);
          node.rotation.y = yaw;
          node.position.set(p.x, y, p.z);

          if (kind === "eucalyptus") {
            tintNode(node, 0xb9_c4_ae, 0.32);
          }

          if (kind === "cherry") {
            tintNode(node, 0xf2_b8_cc, 0.6);
          }

          if (kind === "cypress") {
            tintNode(node, 0x6f_8a_6b, 0.22);
          }

          node.updateMatrixWorld(true);
          objects.push(node);
          solids.push({
            maxX: p.x + 0.5,
            maxZ: p.z + 0.5,
            minX: p.x - 0.5,
            minZ: p.z - 0.5,
            noBody: true,
          });
        }

        placeKit(wellParts, p.x, y, p.z, Math.atan2(p.tx, p.tz));
        bump(`tree.${kind}`);
      });
    }
  }

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

  const CLUTTER_MIX = {
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
    industrial: [
      ["dumpster", 5],
      ["cabinet", 3],
      ["scaffold", 1],
    ],
    park: [],
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
    wharf: [
      ["aboard", 4],
      ["planter", 4],
      ["bike", 3],
      ["news", 2],
      ["meter", 2],
      ["dumpster", 1],
    ],
  } satisfies Record<DistrictChar, readonly (readonly [ClutterKind, number])[]>;

  {
    const parts = {
      aboard: aBoardKit(),
      bike: bikeRackKit(),
      cabinet: cabinetKit(),
      mailbox: mailboxKit(),
      meter: meterKit(),
      news: newsBoxKit(),
      scaffold: getScaffoldKit(),
      scooter: scooterKit(),
    };

    const NEWS_TINTS = [0x2f_6f_4f, 0x2b_4a_8f, 0xa8_56_2f, 0x6f_4a_7a, 0x4a_4a_4a] as const;
    const ABOARD_TINT = 0x3a_36_30;
    const MAIL_TINT = 0x24_45_7f;
    const CABINET_TINT = 0x8f_9a_8f;
    const SCAFFOLD_TINT = 0x9f_b4_c4;
    const planterUrl2 = modelUrl("props", PROP_PLANTER);
    const planterScale2 = 1.5 / Math.max(cache.bounds(planterUrl2).size.x, 0.001);
    const dumpUrl = modelUrl("props", PROP_DUMPSTER);
    const dumpScale = scaleToHeight(dumpUrl, 1.5);

    const pickClutter = (mix: readonly (readonly [ClutterKind, number])[]) => {
      let total = 0;

      for (const [, w] of mix) {
        total += w;
      }

      let roll = rng.range(0, total);
      let kind: ClutterKind = "meter";

      for (const [k, w] of mix) {
        roll -= w;

        if (roll <= 0) {
          kind = k;
          break;
        }
      }

      return kind;
    };

    const placeClutter = (kind: ClutterKind, p: KerbPoint, px: number, pz: number, y: number) => {
      const faceOut = facingRoad(p);
      const alongKerb = Math.atan2(p.tx, p.tz);

      switch (kind) {
        case "planter": {
          seat(planterUrl2, px, pz, rng.range(0, Math.PI * 2), planterScale2);
          break;
        }

        case "dumpster": {
          seatKK(dumpUrl, px, pz, alongKerb + rng.range(-0.08, 0.08), dumpScale);
          break;
        }

        case "news": {
          placeKit(parts.news, px, y, pz, faceOut, 1, new THREE.Color(rng.pick(NEWS_TINTS)));
          break;
        }

        case "mailbox": {
          placeKit(parts.mailbox, px, y, pz, faceOut, 1, new THREE.Color(MAIL_TINT));
          break;
        }

        case "cabinet": {
          placeKit(parts.cabinet, px, y, pz, faceOut, 1, new THREE.Color(CABINET_TINT));
          break;
        }

        case "aboard": {
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
        }

        case "bike": {
          placeKit(parts.bike, px, y, pz, alongKerb);
          break;
        }

        case "scooter": {
          placeKit(parts.scooter, px, y, pz, alongKerb + rng.range(-0.25, 0.25));
          break;
        }

        case "scaffold": {
          placeKit(
            parts.scaffold,
            px,
            y,
            pz,
            scaffoldYaw(p.tx, p.tz),
            1,
            new THREE.Color(SCAFFOLD_TINT),
          );
          break;
        }

        case "meter": {
          placeKit(parts.meter, px, y, pz, faceOut);
          break;
        }

        default: {
          break;
        }
      }
    };

    let clutter = 0;

    const seatClutter = (p: KerbPoint) => {
      if (clutter >= CLUTTER_CAP) {
        return;
      }

      const mix = CLUTTER_MIX[p.district.character];

      if (mix.length === 0) {
        return;
      }

      if (!rng.chance(0.55)) {
        return;
      }

      const kind = pickClutter(mix);
      let radius = 1.7;

      if (kind === "scaffold") {
        radius = 6.5;
      } else if (kind === "dumpster") {
        radius = 2.6;
      }

      const back = kind === "scaffold" ? 1.5 : 0;
      const px = p.x - p.tz * p.side * back;
      const pz = p.z + p.tx * p.side * back;

      if (!claimFree(px, pz, radius)) {
        return;
      }

      if (
        kind === "scaffold" &&
        (onAsphalt(px - p.tx * 4.6, pz - p.tz * 4.6, 0.4) ||
          onAsphalt(px + p.tx * 4.6, pz + p.tz * 4.6, 0.4))
      ) {
        return;
      }

      if (onAsphalt(px, pz, 0.25)) {
        return;
      }

      claim(px, pz);
      placeClutter(kind, p, px, pz, surfaceAt(px, pz));
      bump(`clutter.${kind}`);
      clutter += 1;
    };

    for (const edge of network.edges) {
      if (clutter >= CLUTTER_CAP) {
        break;
      }

      await breathe();
      const mid = network.sample(edge, edge.len / 2);

      if (inPark(mid.x, mid.z)) {
        continue;
      }

      kerbWalk(edge, CLUTTER_PITCH, 1.25, seatClutter);
    }
  }

  const BLADE_STREET_CAP = 40;
  const BLADE_CAP = 260;
  const REGULATORY_CAP = 240;
  {
    const bladeFor = new Map<string, string>();
    const rejected = new Set<string>();

    while (bladeFor.size < BLADE_STREET_CAP) {
      let best: string | null = null;
      let bestLen = 0;

      for (const [street, len] of streetLength) {
        if (bladeFor.has(street) || rejected.has(street)) {
          continue;
        }

        if (len > bestLen) {
          best = street;
          bestLen = len;
        }
      }

      if (best === null) {
        break;
      }

      const text = bladeText(best);

      if (text !== null && text !== "") {
        bladeFor.set(best, text);
      } else {
        rejected.add(best);
      }
    }

    let blades = 0;

    for (let n = 0; n < network.nodes.length && blades < BLADE_CAP; n += 1) {
      if (junctionControl(network, n) === "none") {
        continue;
      }

      const node = network.nodes[n];

      if (!node) {
        continue;
      }

      const labels: string[] = [];

      for (const id of network.nodeEdges[n] ?? []) {
        const street = edgeStreet.get(id);

        if (street === undefined || street === "") {
          continue;
        }

        const text = bladeFor.get(street);

        if (text !== undefined && text !== "" && !labels.includes(text)) {
          labels.push(text);
        }
      }

      if (labels.length === 0) {
        continue;
      }

      const arms = controlArms(network, n);
      let mounted = false;

      for (const a of arms) {
        if (mounted) {
          break;
        }

        const px = a.px + a.tx * 2.2 + a.tz * (a.half + 2);
        const pz = a.pz + a.tz * 2.2 - a.tx * (a.half + 2);

        if (onAsphalt(px, pz, 0.2)) {
          continue;
        }

        if (!claimFree(px, pz, 2)) {
          continue;
        }

        claim(px, pz);
        const y = surfaceAt(px, pz);
        const poleH = 3.6;
        const pole = new THREE.Mesh(STOP_POLE, POLE_MAT);
        pole.scale.set(1.2, poleH, 1.2);
        pole.position.set(px, y + poleH / 2, pz);
        pole.updateMatrixWorld(true);
        objects.push(pole);

        for (let i = 0; i < Math.min(2, labels.length); i += 1) {
          const text = labels[i];

          if (text === undefined) {
            continue;
          }

          const geo = labelGeo(text);

          if (!geo) {
            continue;
          }

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
        blades += 1;
        mounted = true;
      }
    }

    const regParts = regulatoryKit();
    let plates = 0;

    const seatPlate = (p: KerbPoint) => {
      if (plates >= REGULATORY_CAP) {
        return;
      }

      if (p.district.character === "park") {
        return;
      }

      if (!claimSeat(p.x, p.z, 2)) {
        return;
      }

      placeKit(regParts, p.x, surfaceAt(p.x, p.z), p.z, facingRoad(p));
      bump("regulatoryPlate");
      plates += 1;
    };

    for (const edge of network.edges) {
      if (plates >= REGULATORY_CAP) {
        break;
      }

      await breathe();
      const mid = network.sample(edge, edge.len / 2);

      if (inPark(mid.x, mid.z)) {
        continue;
      }

      if (!rng.chance(0.12)) {
        continue;
      }

      kerbWalk(edge, ROAD_TILE * 5, 1.2, seatPlate);
    }
  }

  const AWNING_CAP = 620;
  const FIRE_ESCAPE_CAP = 260;
  const MURAL_CAP = 140;
  const SHUTTER_CAP = 220;
  const FACADE_PITCH = 7.4;
  const FIRE_ESCAPE_DISTRICTS = new Set(["Chinatown", "North Beach", "Civic Center", "SoMa"]);
  const MURAL_DISTRICTS = new Set(["the Mission", "Mission Dolores", "the Castro"]);
  {
    const awningParts = awningKit();
    const escapeParts = fireEscapeKit();
    const muralParts = muralKit();
    const shutterParts = shutterKit();

    const AWNING_TINTS = [
      0xb5_38_4a, 0x2f_6f_5a, 0x2b_4a_7a, 0x8f_6f_3a, 0x6f_3a_5a, 0x3a_3a_3a,
    ] as const;

    const MURAL_TINTS = [0xd8_78_3a, 0x3a_8f_a8, 0xc9_48_3a, 0x6f_9e_4a, 0xe0_b0_3a] as const;
    let awnings = 0;
    let escapes = 0;
    let murals = 0;
    let shutters = 0;

    const onFacade = (p: KerbPoint, edge: NetEdge) => {
      const char = p.district.character;

      if (char === "park" || char === "downtown" || char === "highrise") {
        return false;
      }

      const near = network.nearest(p.x, p.z, ROAD_TILE * 1.6);

      if (!near || near.edge.id !== edge.id) {
        return false;
      }

      return facadeAt(p.x, p.z);
    };

    for (const edge of network.edges) {
      await breathe();
      const mid = network.sample(edge, edge.len / 2);

      if (inPark(mid.x, mid.z)) {
        continue;
      }

      // oxlint-disable-next-line no-loop-func -- kerbWalk runs the visitor synchronously inside this iteration; it needs this `edge` to verify the wall plane, plus the four pass-wide caps
      kerbWalk(edge, FACADE_PITCH, frontPlane(edge), (p) => {
        if (!onFacade(p, edge)) {
          return;
        }

        const char = p.district.character;
        const y = surfaceAt(p.x, p.z);
        const yaw = facingRoad(p);
        const shopfront = char === "commercial" || char === "wharf";

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
          awnings += 1;
        } else if (
          shopfront &&
          shutters < SHUTTER_CAP &&
          char === "commercial" &&
          rng.chance(0.18)
        ) {
          placeKit(shutterParts, p.x, y, p.z, yaw, 1, new THREE.Color(0x8f_92_98));
          bump("shutter");
          shutters += 1;
        }

        if (
          escapes < FIRE_ESCAPE_CAP &&
          FIRE_ESCAPE_DISTRICTS.has(p.district.name) &&
          rng.chance(0.34)
        ) {
          placeKit(escapeParts, p.x, y, p.z, yaw, rng.range(0.92, 1.08));
          bump("fireEscape");
          escapes += 1;
        }

        if (murals < MURAL_CAP && MURAL_DISTRICTS.has(p.district.name) && rng.chance(0.1)) {
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
          murals += 1;
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

  return { lampHeads, objects, parkedCars, pierDecks, solids };
};
