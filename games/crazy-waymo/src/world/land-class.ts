import {
  GRID_X,
  GRID_Z,
  ROAD_TILE,
  WORLD_H,
  WORLD_HALF_X,
  WORLD_HALF_Z,
  WORLD_W,
} from "../shared/constants";
import type { CityPlan } from "./grid";
import { landuseClassAt, landuseGreenAt } from "./sf-landuse";
import type { LanduseClass } from "./sf-landuse";
import { districtAt, greenHillWeightAt, seawallShore } from "./sf-map";
import { inLake } from "./lake";
import { parkPathMaskAt } from "./sf-streets";
import { makeFlank } from "./terrain";
import type { Flank, Terrain } from "./terrain";

export { GGP_LAKE, inLake } from "./lake";

/**
 * The surface itself. One value per visually distinct ground treatment — the
 * paint table in ground.ts is keyed on exactly this, so adding a class forces
 * a colour decision rather than silently falling back to concrete.
 */
export type GroundCover =
  | "pavement"
  | "yard"
  | "rearYard"
  | "plaza"
  | "parking"
  | "court"
  | "industrial"
  | "railyard"
  | "quay"
  | "path"
  | "lawn"
  | "meadow"
  | "grove"
  | "conifer"
  | "woodland"
  | "grassland"
  | "cemetery"
  | "rock"
  | "sand"
  | "dune"
  | "water";

/**
 * Where the ground sits in the city fabric, read from the SAME `CityPlan` the
 * building passes walk — so "there are houses here" and "this is painted as a
 * lawn" cannot disagree.
 */
export type Fabric =
  | { readonly kind: "street" }
  | { readonly kind: "frontage" }
  | { readonly kind: "interior" }
  | { readonly kind: "water" };

/** Vegetation a piece of parkland actually wears — not every park is a lawn. */
export type ParkCanopy = "lawn" | "mosaic" | "grove" | "conifer" | "chaparral";

/** Whether the parkland came from an OSM polygon or from a traced district. */
export type ParkSource = "landuse" | "district";

/**
 * Parkland status. `carFree` is the WHOLE Presidio exemption: it is parkland
 * with a real street network (and the Golden Gate Bridge approach anchors on
 * its northernmost road cell), so it must never be clipped out of the street
 * bake the way Golden Gate Park's interior is. Consumers that mean "car-free
 * park land" read `carFree`; consumers that mean "park land at all" test
 * `kind !== "none"`. Those are different questions and they now look different.
 */
export type Parkland =
  | { readonly kind: "none" }
  | {
      readonly kind: "park";
      readonly source: ParkSource;
      readonly carFree: true;
      readonly canopy: ParkCanopy;
    }
  | {
      readonly kind: "openSpace";
      readonly source: ParkSource;
      readonly carFree: false;
      readonly canopy: ParkCanopy;
      readonly name: string;
    };

/**
 * Hill-flank band. `urban` and `lowland` are both "no wildland cover" but for
 * different reasons, and keeping them apart is the fix for the single biggest
 * green bug in the map: Forest Hill and Mount Davidson sit INSIDE the Sunset's
 * district box, so the hill gaussian was painting ~1,500 built residential
 * cells full forest green. A built-over hill is `urban`, not `none`.
 */
export type HillFlank =
  | { readonly kind: "lowland" }
  | { readonly kind: "urban" }
  | { readonly kind: "wooded"; readonly weight: number }
  | { readonly kind: "grassland"; readonly weight: number }
  | { readonly kind: "rock"; readonly weight: number };

/**
 * Coast treatment. The `beach` term is what city.ts's wheel-FX copy of this
 * rule was missing, which is why driving on Ocean Beach kicked up concrete
 * dust. `dune` is the back-beach INLAND of the sand — it must not narrow the
 * beach, Ocean Beach's ~16u of dry sand is correct.
 */
export type Shore =
  | { readonly kind: "inland" }
  | { readonly kind: "seawall"; readonly amount: number }
  | { readonly kind: "beach"; readonly dry: number; readonly wet: number }
  | { readonly kind: "dune"; readonly amount: number };

/**
 * What the ground at one point IS, with the reasons attached. `cover` fades
 * into `under` by `strength`: soft terms (a hill flank thinning out, a beach
 * apron running inland) feather into the hard ground beneath them instead of
 * ending on a line. Where nothing soft applies, `cover === under` at 1.
 */
export interface LandClass {
  readonly cover: GroundCover;
  readonly under: GroundCover;
  readonly strength: number;
  readonly landuse: LanduseClass;
  readonly fabric: Fabric;
  readonly parkland: Parkland;
  readonly flank: HillFlank;
  readonly shore: Shore;
  /** A building pass places here: park districts are rejected wholesale, every
   *  other street-frontage lot is fair game. The paint's licence to refuse
   *  vegetation. */
  readonly built: boolean;
}

const FOREST_WEIGHT = 0.3;
const WILD_MIN = 0.34;
const WILD_FULL = 0.72;
const ROCK_SLOPE = 0.62;
const ROCK_HEIGHT = 52;
const GRASS_HEIGHT_LO = 12;
const GRASS_HEIGHT_HI = 34;
const SHADE_FOR_TREES = 0.42;
const BEACH_OUTER = 0.6;
const DUNE_OUTER = 0.995;
const DUNE_MAX_U = 0.1;
const DUNE_MIN_V = 0.3;

const NOT_PARKLAND: Parkland = { kind: "none" };
const INLAND: Shore = { kind: "inland" };
const LOWLAND: HillFlank = { kind: "lowland" };
const URBAN: HillFlank = { kind: "urban" };
const STREET: Fabric = { kind: "street" };
const FRONTAGE: Fabric = { kind: "frontage" };
const INTERIOR: Fabric = { kind: "interior" };
const WATER: Fabric = { kind: "water" };

const clamp01 = (t: number) => (t < 0 ? 0 : Math.min(1, t));

const smooth01 = (t: number) => {
  const c = clamp01(t);

  return c * c * (3 - 2 * c);
};

const band = (v: number, lo: number, hi: number) => smooth01((v - lo) / (hi - lo));

const patchNoise = (x: number, z: number, scale: number) => {
  const a = Math.sin(x * 0.043 * scale + Math.sin(z * 0.051 * scale) * 1.9);
  const b = Math.sin(z * 0.037 * scale + Math.sin(x * 0.029 * scale) * 1.6);

  return 0.5 + 0.5 * a * b;
};

const PARK_CANOPY: ReadonlyMap<string, ParkCanopy> = new Map([
  ["Golden Gate Park", "mosaic"],
  ["the Presidio", "conifer"],
  ["the Panhandle", "grove"],
  ["Buena Vista Park", "conifer"],
  ["Mount Davidson Park", "conifer"],
  ["McLaren Park", "chaparral"],
  ["Twin Peaks", "chaparral"],
  ["Dolores Park", "lawn"],
]);

const STREETED_PARKS: ReadonlySet<string> = new Set(["the Presidio"]);

const canopyForClass: (c: LanduseClass) => ParkCanopy = (c) => {
  switch (c) {
    case "wood": {
      return "grove";
    }

    case "scrub": {
      return "chaparral";
    }

    default: {
      return "lawn";
    }
  }
};

/**
 * Parkland status of a grid cell. Depends on the OSM landuse raster and the
 * traced districts ONLY — no city plan, no terrain — because the street bake
 * (tools/sf-data/bake-network.mts, via park-clear.ts) calls this to decide what
 * to clip, long before a plan exists.
 */
export const parklandAt: (gx: number, gz: number) => Parkland = (gx, gz) => {
  if (gx < 0 || gz < 0 || gx >= GRID_X || gz >= GRID_Z) {
    return NOT_PARKLAND;
  }

  const d = districtAt(gx, gz);

  if (d.character === "park") {
    const canopy = PARK_CANOPY.get(d.name) ?? "mosaic";

    return STREETED_PARKS.has(d.name)
      ? { canopy, carFree: false, kind: "openSpace", name: d.name, source: "district" }
      : { canopy, carFree: true, kind: "park", source: "district" };
  }

  if (landuseGreenAt(gx, gz)) {
    return {
      canopy: canopyForClass(landuseClassAt(gx, gz)),
      carFree: true,
      kind: "park",
      source: "landuse",
    };
  }

  return NOT_PARKLAND;
};

/** Park land of any kind — TILE territory (the ground terraces each of these
 *  cells flat so KayKit park tiles seat on it). Includes the Presidio. */
export const isParkLand = (gx: number, gz: number) => parklandAt(gx, gz).kind !== "none";

/** A traced park DISTRICT (Golden Gate Park, the Presidio, Dolores…) rather
 *  than a stray OSM green polygon — the scale that earns park furniture. */
export const isParkDistrictLand: (gx: number, gz: number) => boolean = (gx, gz) => {
  const p = parklandAt(gx, gz);

  return p.kind !== "none" && p.source === "district";
};

const PORT_APRON: readonly number[] = [
  990, -572, 1003, -574, 945, -574, 950, -486, 893, -457, 904, -441, 949, -447, 959, -431, 1000,
  -436, 1002, -411, 960, -405, 962, -386, 1063, -393, 1070, -326, 1005, -362, 965, -360, 973, -314,
  983, -295, 988, -332, 987, -314, 994, -319, 986, -292, 1037, -270, 1032, -261, 989, -282, 1004,
  -244, 997, -231, 1051, -220, 1002, -216, 1003, -202, 1043, -206, 1044, -197, 983, -192, 970, -162,
  968, -124, 961, -118, 970, -111, 945, -75, 925, -327, 904, -349, 897, -440, 740, -272, 732, -294,
  891, -451, 871, -479, 911, -519, 903, -526, 920, -543, 903, -561, 930, -589, 900, -620, 935, -655,
  904, -685, 938, -720, 919, -740, 932, -754, 926, -769, 864, -830, 874, -841, 771, -956, 769, -975,
  749, -1004, 725, -1005, 722, -1024, 712, -1023, 715, -1004, 706, -1003, 685, -1094, 673, -1112,
  661, -1110, 657, -1133, 634, -1130, 630, -1153, 597, -1149, 594, -1172, 568, -1168, 555, -1214,
  524, -1209, 521, -1232, 455, -1222, 451, -1245, 288, -1221, 286, -1240, 274, -1246, 280, -1240,
  284, -1252, 249, -1289, 287, -1252, 290, -1259, 298, -1257, 292, -1256, 296, -1240, 347, -1248,
  345, -1253, 306, -1255, 307, -1260, 338, -1259, 327, -1269, 347, -1258, 358, -1236, 378, -1239,
  378, -1244, 361, -1246, 382, -1245, 381, -1254, 356, -1255, 294, -1314, 298, -1320, 305, -1315,
  307, -1322, 311, -1311, 325, -1303, 316, -1317, 328, -1319, 398, -1261, 397, -1267, 407, -1263,
  401, -1269, 409, -1264, 399, -1278, 436, -1263, 419, -1281, 424, -1286, 454, -1259, 453, -1268,
  458, -1262, 459, -1272, 466, -1267, 447, -1296, 474, -1313, 451, -1297, 501, -1320, 533, -1315,
  555, -1230, 570, -1228, 567, -1282, 581, -1283, 585, -1211, 597, -1204, 616, -1254, 625, -1250,
  609, -1206, 624, -1196, 647, -1232, 656, -1228, 634, -1194, 647, -1182, 684, -1223, 694, -1214,
  683, -1121, 693, -1118, 731, -1147, 737, -1138, 703, -1112, 710, -1102, 746, -1127, 752, -1118,
  710, -1088, 714, -1077, 760, -1107, 779, -1080, 734, -1048, 742, -1037, 786, -1068, 793, -1060,
  749, -1027, 757, -1017, 764, -1022, 757, -1016, 767, -1002, 815, -1035, 770, -997, 785, -978, 825,
  -1004, 830, -997, 792, -968, 799, -968, 801, -959, 838, -987, 843, -980, 806, -948, 838, -969,
  819, -952, 841, -920, 869, -936, 877, -925, 853, -901, 868, -894, 861, -877, 867, -866, 924, -804,
  928, -788, 940, -793, 936, -780, 986, -804, 990, -793, 948, -775, 953, -763, 994, -774, 997, -760,
  957, -749, 959, -735, 995, -743, 997, -733, 953, -723, 952, -711, 1009, -714, 1013, -673, 949,
  -666, 948, -651, 991, -654, 992, -644, 947, -639, 946, -626,
];

const rasterizeApron = () => {
  const mask = new Uint8Array(GRID_X * GRID_Z);
  const n = PORT_APRON.length / 2;
  let xMin = Infinity;
  let xMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;

  for (let i = 0; i < n; i += 1) {
    const px = PORT_APRON[i * 2] ?? 0;
    const pz = PORT_APRON[i * 2 + 1] ?? 0;

    if (px < xMin) {
      xMin = px;
    }

    if (px > xMax) {
      xMax = px;
    }

    if (pz < zMin) {
      zMin = pz;
    }

    if (pz > zMax) {
      zMax = pz;
    }
  }

  const gx0 = Math.max(0, Math.floor((xMin + WORLD_HALF_X) / ROAD_TILE));
  const gx1 = Math.min(GRID_X - 1, Math.ceil((xMax + WORLD_HALF_X) / ROAD_TILE));
  const gz0 = Math.max(0, Math.floor((zMin + WORLD_HALF_Z) / ROAD_TILE));
  const gz1 = Math.min(GRID_Z - 1, Math.ceil((zMax + WORLD_HALF_Z) / ROAD_TILE));

  for (let gx = gx0; gx <= gx1; gx += 1) {
    const px = (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;

    for (let gz = gz0; gz <= gz1; gz += 1) {
      const pz = (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
      let inside = false;

      for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
        const ax = PORT_APRON[i * 2] ?? 0;
        const az = PORT_APRON[i * 2 + 1] ?? 0;
        const bx = PORT_APRON[j * 2] ?? 0;
        const bz = PORT_APRON[j * 2 + 1] ?? 0;

        if (az > pz !== bz > pz && px < ((bx - ax) * (pz - az)) / (bz - az) + ax) {
          inside = !inside;
        }
      }

      if (inside) {
        mask[gx * GRID_Z + gz] = 1;
      }
    }
  }

  return mask;
};

const LANDUSE_COVER = {
  cemetery: "cemetery",
  court: "court",
  garden: null,
  grass: null,
  industrial: "industrial",
  institution: null,
  park: null,
  parking: "parking",
  plaza: "plaza",
  port: "quay",
  railyard: "railyard",
  retail: null,
  rock: "rock",
  sand: "sand",
  scrub: null,
  turf: null,
  unclassified: null,
  water: "water",
  wood: null,
} satisfies Record<LanduseClass, GroundCover | null>;

const landuseCover = (c: LanduseClass, built: boolean) => {
  if (c === "cemetery" && built) {
    return "yard";
  }

  return LANDUSE_COVER[c];
};

const parkCover: (canopy: ParkCanopy, x: number, z: number) => GroundCover = (canopy, x, z) => {
  switch (canopy) {
    case "lawn": {
      return "lawn";
    }

    case "grove": {
      return "grove";
    }

    case "conifer": {
      return "conifer";
    }

    case "chaparral": {
      return patchNoise(x, z, 1.6) < 0.24 ? "grove" : "grassland";
    }

    case "mosaic": {
      const p = patchNoise(x, z, 1.35);

      if (p < 0.36) {
        return "grove";
      }

      return p < 0.74 ? "meadow" : "lawn";
    }

    default: {
      return canopy satisfies never;
    }
  }
};

const fabricCover: (fabric: Fabric) => GroundCover = (fabric) => {
  switch (fabric.kind) {
    case "water": {
      return "water";
    }

    case "street": {
      return "pavement";
    }

    case "frontage": {
      return "yard";
    }

    case "interior": {
      return "rearYard";
    }

    default: {
      return fabric satisfies never;
    }
  }
};

const FABRIC_BY_CODE: readonly Fabric[] = [WATER, STREET, FRONTAGE, INTERIOR];

const fabricCode = (kind: CityPlan["cells"][number][number] | undefined) => {
  if (kind === "water") {
    return 0;
  }

  return kind === "road" ? 1 : 3;
};

interface UnderQuery {
  readonly apron: boolean;
  readonly built: boolean;
  readonly fabric: Fabric;
  readonly gx: number;
  readonly gz: number;
  readonly landuse: LanduseClass;
  readonly parkland: Parkland;
  readonly x: number;
  readonly z: number;
}

const resolveUnder: (q: UnderQuery) => GroundCover = (q) => {
  if (inLake(q.x, q.z)) {
    return "water";
  }

  if (q.apron) {
    return "quay";
  }

  const lu = landuseCover(q.landuse, q.built);

  if (lu !== null) {
    return lu;
  }

  if (q.parkland.kind !== "none" && !q.built) {
    return parkPathMaskAt(q.gx, q.gz) ? "path" : parkCover(q.parkland.canopy, q.x, q.z);
  }

  return fabricCover(q.fabric);
};

interface Overlay {
  readonly cover: GroundCover;
  readonly strength: number;
}

const flankOverlay: (flank: HillFlank) => Overlay | null = (flank) => {
  switch (flank.kind) {
    case "wooded": {
      return { cover: "woodland", strength: flank.weight };
    }

    case "grassland": {
      return { cover: "grassland", strength: flank.weight };
    }

    case "rock": {
      return { cover: "rock", strength: flank.weight };
    }

    case "urban":
    case "lowland": {
      return null;
    }

    default: {
      return flank satisfies never;
    }
  }
};

const resolveOverlay = (under: GroundCover, shore: Shore, flank: HillFlank) => {
  let overlay: Overlay | null;

  switch (shore.kind) {
    case "beach": {
      overlay = { cover: "sand", strength: shore.dry };
      break;
    }

    case "dune": {
      overlay = { cover: "dune", strength: shore.amount };
      break;
    }

    case "seawall": {
      overlay = { cover: "quay", strength: shore.amount };
      break;
    }

    case "inland": {
      overlay = flankOverlay(flank);
      break;
    }

    default: {
      overlay = shore satisfies never;
    }
  }

  if (overlay === null || overlay.cover === under) {
    return { cover: under, strength: 1 };
  }

  return overlay;
};

const resolveShore: (u: number, v: number, landAmt: number) => Shore = (u, v, landAmt) => {
  if (landAmt >= BEACH_OUTER) {
    if (landAmt >= DUNE_OUTER || u > DUNE_MAX_U || v < DUNE_MIN_V) {
      return INLAND;
    }

    const a = 1 - band(landAmt, BEACH_OUTER, DUNE_OUTER);

    return a > 0.02 ? { amount: a * 0.7, kind: "dune" } : INLAND;
  }

  const amount = 1 - smooth01((landAmt - 0.3) / 0.3);

  if (seawallShore(u, v)) {
    return amount > 0.01 ? { amount: amount * 0.85, kind: "seawall" } : INLAND;
  }

  const dry = u < 0.12 ? amount : amount * 0.8;
  const wet = 1 - band(landAmt, 0.28, 0.4);

  return { dry, kind: "beach", wet };
};

const resolveFlank: (
  u: number,
  v: number,
  x: number,
  z: number,
  wild: number,
  flank: Flank,
) => HillFlank = (u, v, x, z, wild, flank) => {
  const canopy = greenHillWeightAt(u, v);
  const w = band(wild, WILD_MIN, WILD_FULL);

  if (w <= 0.01) {
    return canopy > 0.01 ? URBAN : LOWLAND;
  }

  const jitter = (patchNoise(x, z, 0.8) - 0.5) * 2;
  const height = flank.height + jitter * 7;
  const slope = flank.slope + jitter * 0.06;

  if (slope > ROCK_SLOPE && height > ROCK_HEIGHT) {
    return { kind: "rock", weight: w * band(slope, ROCK_SLOPE, ROCK_SLOPE + 0.2) * 0.8 };
  }

  const shade = 0.5 - 0.5 * Math.sin(flank.aspect);

  if (canopy > FOREST_WEIGHT && shade > SHADE_FOR_TREES) {
    return { kind: "wooded", weight: w * Math.min(1, canopy) * 0.9 };
  }

  const dry = Math.max(band(height, GRASS_HEIGHT_LO, GRASS_HEIGHT_HI), canopy);

  if (dry > 0.02) {
    return { kind: "grassland", weight: w * dry * 0.88 };
  }

  return LOWLAND;
};

export type LandClassAt = (x: number, z: number) => LandClass;

/**
 * Bind the ground rule to one world. The plan supplies the fabric (and with it
 * the built-over test and the wildness field); the terrain supplies elevation,
 * slope, aspect and the land mask. Both are needed to answer the question
 * completely, which is exactly why the four old copies each got it wrong.
 */
export const makeLandClassAt: (plan: CityPlan, terrain: Terrain) => LandClassAt = (
  plan,
  terrain,
) => {
  const cellCount = GRID_X * GRID_Z;
  const fabricMap = new Uint8Array(cellCount);
  const builtMap = new Uint8Array(cellCount);

  for (let gx = 0; gx < GRID_X; gx += 1) {
    for (let gz = 0; gz < GRID_Z; gz += 1) {
      const kind = plan.cells[gx]?.[gz];
      fabricMap[gx * GRID_Z + gz] = fabricCode(kind);
    }
  }

  for (const b of plan.buildingCells) {
    const idx = b.gx * GRID_Z + b.gz;
    fabricMap[idx] = 2;
    builtMap[idx] = districtAt(b.gx, b.gz).character === "park" ? 0 : 1;
  }

  const wildMap = new Float32Array(cellCount);
  const R = 2;

  for (let gx = 0; gx < GRID_X; gx += 1) {
    for (let gz = 0; gz < GRID_Z; gz += 1) {
      let wild = 0;
      let n = 0;

      for (let i = Math.max(0, gx - R); i <= Math.min(GRID_X - 1, gx + R); i += 1) {
        for (let j = Math.max(0, gz - R); j <= Math.min(GRID_Z - 1, gz + R); j += 1) {
          n += 1;
          const f = fabricMap[i * GRID_Z + j] ?? 0;

          if (f !== 1 && f !== 2) {
            wild += 1;
          }
        }
      }

      wildMap[gx * GRID_Z + gz] = n === 0 ? 1 : wild / n;
    }
  }

  const apron = rasterizeApron();
  const parklandCache: Parkland[] = [];
  const landuseCache: LanduseClass[] = [];

  for (let gx = 0; gx < GRID_X; gx += 1) {
    for (let gz = 0; gz < GRID_Z; gz += 1) {
      const idx = gx * GRID_Z + gz;
      parklandCache[idx] = parklandAt(gx, gz);
      landuseCache[idx] = landuseClassAt(gx, gz);
    }
  }

  const flankScratch = makeFlank();

  return (x: number, z: number) => {
    const gx = Math.min(GRID_X - 1, Math.max(0, Math.floor((x + WORLD_HALF_X) / ROAD_TILE)));
    const gz = Math.min(GRID_Z - 1, Math.max(0, Math.floor((z + WORLD_HALF_Z) / ROAD_TILE)));
    const idx = gx * GRID_Z + gz;
    const fabric = FABRIC_BY_CODE[fabricMap[idx] ?? 0] ?? INTERIOR;
    const built = (builtMap[idx] ?? 0) === 1;
    const landuse = landuseCache[idx] ?? "unclassified";
    const parkland = parklandCache[idx] ?? NOT_PARKLAND;
    const u = x / WORLD_W + 0.5;
    const v = z / WORLD_H + 0.5;

    const under = resolveUnder({
      apron: (apron[idx] ?? 0) === 1,
      built,
      fabric,
      gx,
      gz,
      landuse,
      parkland,
      x,
      z,
    });

    const landAmt = terrain.landAt(x, z);
    const shore = resolveShore(u, v, landAmt);
    let flank: HillFlank = LOWLAND;

    if (landAmt >= BEACH_OUTER) {
      if (built) {
        flank = greenHillWeightAt(u, v) > 0.01 ? URBAN : LOWLAND;
      } else {
        flank = resolveFlank(u, v, x, z, wildMap[idx] ?? 1, terrain.flankInto(flankScratch, x, z));
      }
    }

    const { cover, strength } = resolveOverlay(under, shore, flank);

    return {
      built,
      cover,
      fabric,
      flank,
      landuse,
      parkland,
      shore,
      strength,
      under,
    } satisfies LandClass;
  };
};

/** What the wheels are running on — the off-road kick-up FX and the tyre audio.
 *  city.ts's own copy of this rule had no shore term, so Ocean Beach reported
 *  "concrete"; reading it off the resolved cover makes that impossible. */
export type WheelSurface = "road" | "grass" | "sand" | "dirt" | "gravel" | "rock" | "concrete";

const COVER_DOMINANT = 0.5;

/** The cover a viewer would NAME the ground: the overlay once it carries the
 *  colour, the ground under it while it is still a tint. Exported so no caller
 *  has to re-pick that threshold — the whole point of this module. */
export const dominantCover = (land: LandClass) =>
  land.strength >= COVER_DOMINANT ? land.cover : land.under;

const LOOSE_UNDERFOOT = 0.22;

export const wheelSurface: (land: LandClass) => WheelSurface = (land) => {
  if (land.fabric.kind === "street") {
    return "road";
  }

  if (land.shore.kind === "beach" && land.shore.dry > LOOSE_UNDERFOOT) {
    return "sand";
  }

  if (land.shore.kind === "dune" && land.shore.amount > LOOSE_UNDERFOOT) {
    return "sand";
  }

  const c = dominantCover(land);

  switch (c) {
    case "sand":
    case "dune": {
      return "sand";
    }

    case "lawn":
    case "meadow":
    case "grove":
    case "conifer":
    case "woodland":
    case "grassland":
    case "cemetery": {
      return "grass";
    }

    case "path":
    case "railyard": {
      return "gravel";
    }

    case "industrial": {
      return "dirt";
    }

    case "rock": {
      return "rock";
    }

    default: {
      return "concrete";
    }
  }
};
