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
import { landuseClassAt, type LanduseClass, landuseGreenAt } from "./sf-landuse";
import { districtAt, greenHillWeightAt, seawallShore } from "./sf-map";
import { inLake } from "./lake";
export { GGP_LAKE, inLake } from "./lake";
import { parkPathMaskAt } from "./sf-streets";
import { type Flank, makeFlank, type Terrain } from "./terrain";

// WHAT THE GROUND IS — the single ground-class rule for the whole game.
//
// This used to be four rules that disagreed. ground.ts painted a cell park at
// greenHillWeight > 0.01, city.ts's wheel FX used 0.4 and had no shore term at
// all (so driving Ocean Beach reported "concrete"), park-clear.ts exempted the
// Presidio, and furniture.ts dropped the OSM landuse term entirely. Every
// consumer re-picked its own thresholds, which is why the same cell could be
// lawn to the eye, concrete to the tyres and park to the prop scatter.
//
// The rule is now ONE resolver over ONE result type, and every decision that
// used to be a magic number at a call site is a NAMED part of that result:
//
//   parkland — park vs open-space-with-streets. THE Presidio exemption.
//   flank    — the hill-forest threshold, resolved once, with its band.
//   shore    — the natural-shore sand term, which is what the wheel FX lacked.
//   built    — does a building pass actually place here. Ground with houses on
//              it is not a lawn, whatever OSM says about the polygon.
//
// A caller therefore cannot ask a half-question: `cover` is the answer, and the
// four fields above are the reasons, all present, all named.

/**
 * The surface itself. One value per visually distinct ground treatment — the
 * paint table in ground.ts is keyed on exactly this, so adding a class forces
 * a colour decision rather than silently falling back to concrete.
 */
export type GroundCover =
  // --- hard ground
  | "pavement" // generic city hardscape: the warm grey San Francisco is mostly made of
  | "yard" // built residential ground: driveway, garden wall, a little planting
  | "rearYard" // block interior behind the buildings: fences, sheds, hardstand
  | "plaza" // civic paving, pale
  | "parking" // surface lot asphalt
  | "court" // asphalt schoolyard / sport court
  | "industrial" // warm dust hardstand
  | "railyard" // ballast
  | "quay" // engineered waterfront: seawall apron and the Port's quay strip
  | "path" // park promenade: compacted tan gravel
  // --- vegetated
  | "lawn" // irrigated, mown park turf
  | "meadow" // unirrigated park grass
  | "grove" // park tree canopy
  | "conifer" // Presidio cypress-eucalyptus: the darkest green in the city
  | "woodland" // hill forest (Sutro, Mount Davidson)
  | "grassland" // straw. This is what SF's wild hills are eight months a year
  | "cemetery" // mown grass over stone
  | "rock" // bare serpentine outcrop
  // --- coast
  | "sand"
  | "dune" // back-beach: sand held together by scrub
  | "water";

/**
 * Where the ground sits in the city fabric, read from the SAME `CityPlan` the
 * building passes walk — so "there are houses here" and "this is painted as a
 * lawn" cannot disagree.
 */
export type Fabric =
  | { readonly kind: "street" }
  | { readonly kind: "frontage" } // lot with street frontage: the buildable fabric
  | { readonly kind: "interior" } // lot with no frontage: rear-of-lot / block interior
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
  | { readonly kind: "lowland" } // away from any hill
  | { readonly kind: "urban" } // on a hill, but the hill is covered in houses
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
export type LandClass = {
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
};

// --- Named thresholds. Each of these was a magic number at a call site. ------

/** Hill-gaussian weight above which a WILD flank carries tree cover. The old
 *  paint used 0.01 (any gaussian tail at all) and the wheel FX used 0.4. */
const FOREST_WEIGHT = 0.3;
/** Fraction of a cell's 5×5 neighbourhood that must be free of streets and
 *  frontage lots before wildland cover paints at all. Below it the hill is a
 *  neighbourhood: Forest Hill, Golden Gate Heights, Bernal's north slope. */
const WILD_MIN = 0.34;
const WILD_FULL = 0.72;
/** Bare rock wants BOTH: steep and high. SF's outcrops are the serpentine
 *  shoulders near the summits, not every steep street. */
const ROCK_SLOPE = 0.62;
const ROCK_HEIGHT = 52;
/** Straw grass starts a little above the flats and saturates on the shoulders. */
const GRASS_HEIGHT_LO = 12;
const GRASS_HEIGHT_HI = 34;
/** Downhill-west/north (the fog side) keeps its eucalyptus; the sun-baked
 *  south/east flanks are straw. Above this shade fraction, cover is woodland. */
const SHADE_FOR_TREES = 0.42;
/** Land-mask fractions bounding the coast. `landAt` is 1 well inland, 0 at sea,
 *  and the beach is everything under 0.6 — unchanged, because Ocean Beach's ~16u
 *  of dry sand is correct and must not narrow.
 *  The dune field backs it up to 0.995, which looks like a typo and is not: the
 *  west coast's mask saturates inside ONE 13u cell (land 0.6 at u 0.0448, 0.78
 *  at 0.0490), so a band expressed at 0.78 is a single cell wide. Reading it up
 *  to the very top of the mask buys the ~3 cells of back-beach that actually
 *  read as a dune field. */
const BEACH_OUTER = 0.6;
const DUNE_OUTER = 0.995;
/** Where the Pacific dune field exists at all: Ocean Beach and Fort Funston,
 *  south of the Lands End cliffs. Nowhere else in SF is dune-backed. */
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

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
function smooth01(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}
function band(v: number, lo: number, hi: number): number {
  return smooth01((v - lo) / (hi - lo));
}

// Low-frequency organic noise (~40-90u), the same family as ground.ts's meadow
// patches. Deterministic: park mosaics and band jitter must be identical in the
// gen worker, the main thread and the bake.
function patchNoise(x: number, z: number, scale: number): number {
  const a = Math.sin(x * 0.043 * scale + Math.sin(z * 0.051 * scale) * 1.9);
  const b = Math.sin(z * 0.037 * scale + Math.sin(x * 0.029 * scale) * 1.6);
  return 0.5 + 0.5 * a * b;
}

// --- Parks -------------------------------------------------------------------

// Park districts, by what actually grows in them. Golden Gate Park is a mosaic
// of meadow, grove and lawn (it read as one flat checkerboard of turf tiles);
// the Presidio is 1,267 cells of dark cypress-eucalyptus canopy, NOT lawn;
// Twin Peaks and McLaren are dry coastal scrub over grass.
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

// Park districts with a real street network through them — parkland, but never
// car-free. The Presidio is the only one.
const STREETED_PARKS: ReadonlySet<string> = new Set(["the Presidio"]);

function canopyForClass(c: LanduseClass): ParkCanopy {
  switch (c) {
    case "wood":
      return "grove";
    case "scrub":
      return "chaparral";
    default:
      return "lawn";
  }
}

/**
 * Parkland status of a grid cell. Depends on the OSM landuse raster and the
 * traced districts ONLY — no city plan, no terrain — because the street bake
 * (tools/sf-data/bake-network.mts, via park-clear.ts) calls this to decide what
 * to clip, long before a plan exists.
 */
export function parklandAt(gx: number, gz: number): Parkland {
  if (gx < 0 || gz < 0 || gx >= GRID_X || gz >= GRID_Z) return NOT_PARKLAND;
  const d = districtAt(gx, gz);
  if (d.character === "park") {
    const canopy = PARK_CANOPY.get(d.name) ?? "mosaic";
    return STREETED_PARKS.has(d.name)
      ? { kind: "openSpace", source: "district", carFree: false, canopy, name: d.name }
      : { kind: "park", source: "district", carFree: true, canopy };
  }
  // The OSM green classes (park/grass/garden/wood/scrub/cemetery/turf) — the
  // set landuseGreenAt gates, kept as the authority so the street mask this
  // feeds cannot drift from the shipped raster.
  if (landuseGreenAt(gx, gz)) {
    return {
      kind: "park",
      source: "landuse",
      carFree: true,
      canopy: canopyForClass(landuseClassAt(gx, gz)),
    };
  }
  return NOT_PARKLAND;
}

/** Park land of any kind — TILE territory (the ground terraces each of these
 *  cells flat so KayKit park tiles seat on it). Includes the Presidio. */
export function isParkLand(gx: number, gz: number): boolean {
  return parklandAt(gx, gz).kind !== "none";
}

/** A traced park DISTRICT (Golden Gate Park, the Presidio, Dolores…) rather
 *  than a stray OSM green polygon — the scale that earns park furniture. */
export function isParkDistrictLand(gx: number, gz: number): boolean {
  const p = parklandAt(gx, gz);
  return p.kind !== "none" && p.source === "district";
}

// --- Port apron --------------------------------------------------------------

// The Port of San Francisco's quay strip behind the finger piers, traced from
// the licensed downtown model (`landuse=po`, 85,123u² over 450 points, RDP'd to
// 214 at 5u and rounded to the unit — the raster it feeds is 13u cells). Flat
// world x,z pairs. Without it the 55 pier decks read as slabs floating off a
// kerb, because the ground behind them was painted as generic city concrete.
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

/** Rasterize the quay ring to grid cells once: the ring wanders the whole
 *  waterfront, so its bbox is a third of the map and a per-sample point-in-
 *  polygon would run 450 crossing tests over ~30k ground vertices. */
function rasterizeApron(): Uint8Array {
  const mask = new Uint8Array(GRID_X * GRID_Z);
  const n = PORT_APRON.length / 2;
  let xMin = Infinity;
  let xMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const px = PORT_APRON[i * 2] ?? 0;
    const pz = PORT_APRON[i * 2 + 1] ?? 0;
    if (px < xMin) xMin = px;
    if (px > xMax) xMax = px;
    if (pz < zMin) zMin = pz;
    if (pz > zMax) zMax = pz;
  }
  const gx0 = Math.max(0, Math.floor((xMin + WORLD_HALF_X) / ROAD_TILE));
  const gx1 = Math.min(GRID_X - 1, Math.ceil((xMax + WORLD_HALF_X) / ROAD_TILE));
  const gz0 = Math.max(0, Math.floor((zMin + WORLD_HALF_Z) / ROAD_TILE));
  const gz1 = Math.min(GRID_Z - 1, Math.ceil((zMax + WORLD_HALF_Z) / ROAD_TILE));
  for (let gx = gx0; gx <= gx1; gx++) {
    const px = (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
    for (let gz = gz0; gz <= gz1; gz++) {
      const pz = (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = PORT_APRON[i * 2] ?? 0;
        const az = PORT_APRON[i * 2 + 1] ?? 0;
        const bx = PORT_APRON[j * 2] ?? 0;
        const bz = PORT_APRON[j * 2 + 1] ?? 0;
        if (az > pz !== bz > pz && px < ((bx - ax) * (pz - az)) / (bz - az) + ax) inside = !inside;
      }
      if (inside) mask[gx * GRID_Z + gz] = 1;
    }
  }
  return mask;
}

// --- Cover resolution --------------------------------------------------------

/** The OSM class's own surface, where it has one. The vegetated classes return
 *  null: the parkland term owns those, because it is the term that knows about
 *  districts and canopies. `built` is the licence to refuse — a cemetery
 *  polygon with houses on it is a yard. */
function landuseCover(c: LanduseClass, built: boolean): GroundCover | null {
  switch (c) {
    case "water":
      return "water";
    case "sand":
      return "sand";
    case "rock":
      return "rock";
    case "plaza":
      return "plaza";
    case "parking":
      return "parking";
    case "court":
      return "court";
    case "industrial":
      return "industrial";
    case "railyard":
      return "railyard";
    case "port":
      return "quay";
    case "cemetery":
      return built ? "yard" : "cemetery";
    case "park":
    case "grass":
    case "garden":
    case "turf":
    case "wood":
    case "scrub":
      return null; // vegetated: the parkland term decides
    case "retail":
    case "institution":
    case "unclassified":
      return null; // built-up or unknown: the fabric term decides
  }
}

function parkCover(canopy: ParkCanopy, x: number, z: number): GroundCover {
  switch (canopy) {
    case "lawn":
      return "lawn";
    case "grove":
      return "grove";
    case "conifer":
      return "conifer";
    case "chaparral": {
      // Dry coastal scrub — McLaren's and Twin Peaks' grass knolls, with the
      // eucalyptus stands that break them up. The mix matters because these two
      // are traced as district RECTANGLES: one flat fill draws the box.
      return patchNoise(x, z, 1.6) < 0.24 ? "grove" : "grassland";
    }
    case "mosaic": {
      // Golden Gate Park's real read: grove, meadow and mown lawn interlocking
      // at ~60-90u, not one uniform turf field.
      const p = patchNoise(x, z, 1.35);
      return p < 0.36 ? "grove" : p < 0.74 ? "meadow" : "lawn";
    }
  }
}

function fabricCover(fabric: Fabric): GroundCover {
  switch (fabric.kind) {
    case "water":
      return "water";
    case "street":
      return "pavement";
    case "frontage":
      // Built ground: a driveway, a garden wall, a paved side yard. At 58 m a
      // cell is most of a block face, so this is mostly hardscape.
      return "yard";
    case "interior":
      // Block interiors used to be lerped 30% toward park green — 12,600 cells
      // of lawn where real SF has building rear walls and fenced private yards
      // nobody can see from the street.
      return "rearYard";
  }
}

// --- The resolver ------------------------------------------------------------

export type LandClassAt = (x: number, z: number) => LandClass;

/**
 * Bind the ground rule to one world. The plan supplies the fabric (and with it
 * the built-over test and the wildness field); the terrain supplies elevation,
 * slope, aspect and the land mask. Both are needed to answer the question
 * completely, which is exactly why the four old copies each got it wrong.
 */
export function makeLandClassAt(plan: CityPlan, terrain: Terrain): LandClassAt {
  const cellCount = GRID_X * GRID_Z;
  // 0 water, 1 street, 2 frontage lot, 3 interior lot.
  const fabricMap = new Uint8Array(cellCount);
  const builtMap = new Uint8Array(cellCount);
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
      const kind = plan.cells[gx]?.[gz];
      fabricMap[gx * GRID_Z + gz] = kind === "water" ? 0 : kind === "road" ? 1 : 3;
    }
  }
  for (const b of plan.buildingCells) {
    const idx = b.gx * GRID_Z + b.gz;
    fabricMap[idx] = 2;
    // The building passes reject park DISTRICTS wholesale (city.ts) and place
    // on every other frontage lot, so park cells on a park's road edge keep
    // their lawn while the Sunset's OSM-green frontage cells do not.
    builtMap[idx] = districtAt(b.gx, b.gz).character === "park" ? 0 : 1;
  }
  // Wildness: how unbuilt a cell's neighbourhood is. A hill only wears
  // wildland cover where the city has not covered it — the gaussian alone put
  // saturated forest green across the Sunset, because Forest Hill and Mount
  // Davidson sit inside the Sunset's district box.
  const wildMap = new Float32Array(cellCount);
  const R = 2;
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
      let wild = 0;
      let n = 0;
      for (let i = Math.max(0, gx - R); i <= Math.min(GRID_X - 1, gx + R); i++) {
        for (let j = Math.max(0, gz - R); j <= Math.min(GRID_Z - 1, gz + R); j++) {
          n++;
          const f = fabricMap[i * GRID_Z + j] ?? 0;
          if (f !== 1 && f !== 2) wild++;
        }
      }
      wildMap[gx * GRID_Z + gz] = n === 0 ? 1 : wild / n;
    }
  }
  const apron = rasterizeApron();
  // The two per-CELL answers, resolved once each instead of ~2.5× per cell: the
  // ground painter runs over ~125k mesh vertices, and both of these cost a
  // district-box scan or a hex parse. Parkland values are immutable, so caching
  // the objects is safe.
  const parklandCache: Parkland[] = [];
  const landuseCache: LanduseClass[] = [];
  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
      const idx = gx * GRID_Z + gz;
      parklandCache[idx] = parklandAt(gx, gz);
      landuseCache[idx] = landuseClassAt(gx, gz);
    }
  }
  const flankScratch = makeFlank();

  return (x: number, z: number): LandClass => {
    const gx = Math.min(GRID_X - 1, Math.max(0, Math.floor((x + WORLD_HALF_X) / ROAD_TILE)));
    const gz = Math.min(GRID_Z - 1, Math.max(0, Math.floor((z + WORLD_HALF_Z) / ROAD_TILE)));
    const idx = gx * GRID_Z + gz;
    const f = fabricMap[idx] ?? 0;
    const fabric = f === 0 ? WATER : f === 1 ? STREET : f === 2 ? FRONTAGE : INTERIOR;
    const built = (builtMap[idx] ?? 0) === 1;
    const landuse = landuseCache[idx] ?? "unclassified";
    const parkland = parklandCache[idx] ?? NOT_PARKLAND;
    const u = x / WORLD_W + 0.5;
    const v = z / WORLD_H + 0.5;

    // --- the hard ground under everything
    let under: GroundCover;
    if (inLake(x, z)) under = "water";
    else if ((apron[idx] ?? 0) === 1) under = "quay";
    else {
      const lu = landuseCover(landuse, built);
      if (lu !== null) under = lu;
      else if (parkland.kind !== "none" && !built) {
        // Park paths are the OLD street lines through the parks, clipped out of
        // the shipped mask at bake time and laid back as promenades by the
        // furniture pass — paint the gravel under them.
        under = parkPathMaskAt(gx, gz) ? "path" : parkCover(parkland.canopy, x, z);
      } else under = fabricCover(fabric);
    }

    // --- soft terms. Coast first: it is the strongest read on the map.
    const landAmt = terrain.landAt(x, z);
    const shore = resolveShore(u, v, landAmt);
    let flank: HillFlank = LOWLAND;
    // Inside the beach/seawall band the coast owns the paint outright, so the
    // flank is not even sampled. Everywhere else it is — including under the
    // dune band, so a wooded coastal slope (the Presidio's bluffs, the Marin
    // headland) does not lose its canopy in a strip along the shore.
    if (landAmt >= BEACH_OUTER) {
      if (built) {
        // Built ground has no wildland band at all, so it never needs the flank
        // sample — and it is most of the map.
        flank = greenHillWeightAt(u, v) > 0.01 ? URBAN : LOWLAND;
      } else {
        flank = resolveFlank(u, v, x, z, wildMap[idx] ?? 1, terrain.flankInto(flankScratch, x, z));
      }
    }

    let cover = under;
    let strength = 1;
    switch (shore.kind) {
      case "beach":
        cover = "sand";
        strength = shore.dry;
        break;
      case "dune":
        cover = "dune";
        strength = shore.amount;
        break;
      case "seawall":
        cover = "quay";
        strength = shore.amount;
        break;
      case "inland":
        switch (flank.kind) {
          case "wooded":
            cover = "woodland";
            strength = flank.weight;
            break;
          case "grassland":
            cover = "grassland";
            strength = flank.weight;
            break;
          case "rock":
            cover = "rock";
            strength = flank.weight;
            break;
          case "urban":
          case "lowland":
            break;
        }
        break;
    }
    if (cover === under) strength = 1;

    return { cover, under, strength, landuse, fabric, parkland, flank, shore, built };
  };
}

function resolveShore(u: number, v: number, landAmt: number): Shore {
  if (landAmt >= BEACH_OUTER) {
    // Past the beach the only coast term left is the back-beach, and only on
    // the Pacific dune coast — Ocean Beach and Fort Funston. Every other point
    // on the map (the whole interior) leaves here on the first compare.
    if (landAmt >= DUNE_OUTER || u > DUNE_MAX_U || v < DUNE_MIN_V) return INLAND;
    const a = 1 - band(landAmt, BEACH_OUTER, DUNE_OUTER);
    return a > 0.02 ? { kind: "dune", amount: a * 0.7 } : INLAND;
  }
  // The Embarcadero and the whole industrial east shore are ENGINEERED — a
  // concrete/riprap apron, not a beach. Ocean Beach keeps its sand.
  const amount = 1 - smooth01((landAmt - 0.3) / 0.3);
  if (seawallShore(u, v)) {
    return amount > 0.01 ? { kind: "seawall", amount: amount * 0.85 } : INLAND;
  }
  // Ocean Beach reads strongest; the bay-side natural pockets (Crissy, Baker,
  // Aquatic Park) stay a touch greyer.
  const dry = u < 0.12 ? amount : amount * 0.8;
  const wet = 1 - band(landAmt, 0.28, 0.4);
  return { kind: "beach", dry, wet };
}

/** Bands ONE unbuilt point's flank. Built ground short-circuits to `urban`
 *  before this is called — a hill covered in houses has no wildland cover. */
function resolveFlank(
  u: number,
  v: number,
  x: number,
  z: number,
  wild: number,
  flank: Flank,
): HillFlank {
  const canopy = greenHillWeightAt(u, v);
  const w = band(wild, WILD_MIN, WILD_FULL);
  if (w <= 0.01) return canopy > 0.01 ? URBAN : LOWLAND;
  // Jitter the band edges with the same low-frequency noise the park mosaic
  // uses: sharp thresholds on a gaussian hill draw contour RINGS.
  const jitter = (patchNoise(x, z, 0.8) - 0.5) * 2;
  const height = flank.height + jitter * 7;
  const slope = flank.slope + jitter * 0.06;
  if (slope > ROCK_SLOPE && height > ROCK_HEIGHT) {
    return { kind: "rock", weight: w * band(slope, ROCK_SLOPE, ROCK_SLOPE + 0.2) * 0.8 };
  }
  // Aspect is the DOWNHILL bearing, clockwise from north: -π/2 is due west.
  // The fog comes off the Pacific, so west-facing flanks hold the eucalyptus
  // and cypress while the sun-baked east faces are straw.
  const shade = 0.5 - 0.5 * Math.sin(flank.aspect);
  if (canopy > FOREST_WEIGHT && shade > SHADE_FOR_TREES) {
    return { kind: "wooded", weight: w * Math.min(1, canopy) * 0.9 };
  }
  const dry = Math.max(band(height, GRASS_HEIGHT_LO, GRASS_HEIGHT_HI), canopy);
  if (dry > 0.02) return { kind: "grassland", weight: w * dry * 0.88 };
  return LOWLAND;
}

// --- Derived questions -------------------------------------------------------

/** What the wheels are running on — the off-road kick-up FX and the tyre audio.
 *  city.ts's own copy of this rule had no shore term, so Ocean Beach reported
 *  "concrete"; reading it off the resolved cover makes that impossible. */
export type WheelSurface = "road" | "grass" | "sand" | "dirt" | "gravel" | "rock" | "concrete";

/** Where a soft overlay stops being a tint and becomes the surface. */
const COVER_DOMINANT = 0.5;

/** The cover a viewer would NAME the ground: the overlay once it carries the
 *  colour, the ground under it while it is still a tint. Exported so no caller
 *  has to re-pick that threshold — the whole point of this module. */
export function dominantCover(land: LandClass): GroundCover {
  return land.strength >= COVER_DOMINANT ? land.cover : land.under;
}
/** Loose material is loose long before it dominates the COLOUR: the outer half
 *  of the beach apron paints mostly as the ground behind it, and a car on it is
 *  still throwing sand. */
const LOOSE_UNDERFOOT = 0.22;

export function wheelSurface(land: LandClass): WheelSurface {
  if (land.fabric.kind === "street") return "road";
  if (land.shore.kind === "beach" && land.shore.dry > LOOSE_UNDERFOOT) return "sand";
  if (land.shore.kind === "dune" && land.shore.amount > LOOSE_UNDERFOOT) return "sand";
  const c = dominantCover(land);
  switch (c) {
    case "sand":
    case "dune":
      return "sand";
    case "lawn":
    case "meadow":
    case "grove":
    case "conifer":
    case "woodland":
    case "grassland":
    case "cemetery":
      return "grass";
    case "path":
    case "railyard":
      return "gravel";
    case "industrial":
      return "dirt";
    case "rock":
      return "rock";
    default:
      return "concrete";
  }
}
