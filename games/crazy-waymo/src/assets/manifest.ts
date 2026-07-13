// Asset catalog. Files live in public/models/<category>/<name>.glb and are
// served at <BASE_URL>models/<category>/<name>.glb.

const BASE = import.meta.env.BASE_URL;

export function modelUrl(category: string, name: string): string {
  return `${BASE}models/${category}/${name}.glb`;
}

// --- Cars ---
export const PLAYER_CAR = "waymo";
export const TRAFFIC_CARS = [
  "sedan",
  "sedan-sports",
  "suv",
  "suv-luxury",
  "van",
  "truck",
  "delivery",
  "delivery-flat",
  "hatchback-sports",
  "taxi", // the OTHER cab company — SF classic
  "race",
  "race-future",
] as const;
// Service vehicles spice the traffic mix (weighted by district in traffic.ts).
export const SERVICE_CARS = ["ambulance", "firetruck", "garbage-truck"] as const;
// Construction-site vehicles parked at the cone pockets (furniture.ts).
export const CONSTRUCTION_VEHICLES = ["tractor", "tractor-shovel"] as const;
export const POLICE_CAR = "police";
// Generated robotaxi bodies (Meshy image-to-3d from GPT-Image-2 renders of
// the real vehicles) — player skins only, never traffic.
export const GEN_ROBOTAXIS = [
  "robotaxi-cruise",
  "robotaxi-zoox",
  "robotaxi-cybercab",
  "lyft-sedan",
  "uber-sedan",
] as const;

// --- Roads ---
// Street geometry is generated procedurally (world/roads.ts); road-cell shape
// classes live in grid.ts (RoadKind). Only the bridge pieces are real models.
export const ROAD_BRIDGE = "road-bridge";
export const BRIDGE_PILLAR = "bridge-pillar";
export const BRIDGE_PILLAR_WIDE = "bridge-pillar-wide";

// --- Buildings (by district prefix) ---
export const BUILDINGS_COMMERCIAL = [
  "com-building-a",
  "com-building-b",
  "com-building-c",
  "com-building-d",
  "com-building-e",
  "com-building-f",
  "com-building-g",
  "com-building-h",
  "com-building-i",
  "com-building-j",
  "com-building-k",
  "com-building-l",
  "com-building-m",
  "com-building-n",
] as const;
export const BUILDINGS_SKYSCRAPER = [
  "com-building-skyscraper-a",
  "com-building-skyscraper-b",
  "com-building-skyscraper-c",
  "com-building-skyscraper-d",
  "com-building-skyscraper-e",
] as const;
export const BUILDINGS_INDUSTRIAL = [
  "ind-building-a",
  "ind-building-b",
  "ind-building-c",
  "ind-building-d",
  "ind-building-e",
  "ind-building-f",
  "ind-building-g",
  "ind-building-h",
] as const;
export const BUILDINGS_SUBURBAN = [
  "sub-building-type-a",
  "sub-building-type-b",
  "sub-building-type-c",
  "sub-building-type-d",
  "sub-building-type-e",
  "sub-building-type-f",
  "sub-building-type-g",
  "sub-building-type-h",
  "sub-building-type-i",
  "sub-building-type-j",
  "sub-building-type-k",
  "sub-building-type-l",
  "sub-building-type-m",
  "sub-building-type-n",
  "sub-building-type-o",
  "sub-building-type-p",
  "sub-building-type-q",
  "sub-building-type-r",
  "sub-building-type-s",
  "sub-building-type-t",
  "sub-building-type-u",
] as const;

// --- Props ---
export const TREE_LARGE = "tree-large";
export const TREE_SMALL = "tree-small";
export const PROP_CONE = "construction-cone";
export const PROP_PLANTER = "planter";
export const PROP_BARRIER = "construction-barrier";
export const PROP_CONSTRUCTION_LIGHT = "construction-light";
// Streetlights (by district character).
export const LIGHT_CURVED = "light-curved";
export const LIGHT_SQUARE = "light-square";
export const LIGHT_SQUARE_DOUBLE = "light-square-double";
export const LIGHT_CURVED_CROSS = "light-curved-cross";
// Victorian gas lamps (KayKit City Builder Bits).
export const LIGHT_OLD = "kk-lamp-old";
export const LIGHT_OLD_DOUBLE = "kk-lamp-old-double";
// KayKit park kit (City Builder Bits): walls, bushes, blobby trees.
export const PARK_WALL = "kk-park-wall";
export const PARK_WALL_CORNER = "kk-park-wall-corner";
export const PARK_ENTRY = "kk-park-entry";
export const BUSHES = ["kk-bush-a", "kk-bush-b", "kk-bush-c"] as const;
export const PARK_TREES = ["kk-tree-a", "kk-tree-b", "kk-tree-c"] as const;
// The robotaxi garage (Kenney industrial building-s: orange roller doors).
// Deliberately NOT in BUILDINGS_INDUSTRIAL — it only spawns as a garage.
export const GARAGE_MODEL = "ind-building-s";

// KayKit buildings + cars (City Builder Bits) — editor palette alongside Kenney.
export const KK_BUILDINGS = [
  "kk-building-a",
  "kk-building-b",
  "kk-building-c",
  "kk-building-d",
  "kk-building-e",
  "kk-building-f",
  "kk-building-g",
  "kk-building-h",
] as const;
export const KK_CARS = [
  "kk-car-hatchback",
  "kk-car-police",
  "kk-car-sedan",
  "kk-car-stationwagon",
  "kk-car-taxi",
] as const;
export const KK_PROPS_EXTRA = [
  "kk-streetlight",
  "kk-trafficlight-b",
  "kk-trafficlight-c",
  "kk-tree-d",
  "kk-tree-e",
  "kk-bush-plain",
] as const;
// KayKit prebuilt park tiles (City Builder Bits) — public/models/parks/.
export const PARK_TILE_PLAZAS = [
  "park-road-junction-decorated-A",
  "park-road-junction-decorated-B",
  "park-road-junction-decorated-C",
] as const;
export const PARK_TILES = [
  "park-base",
  "park-base-decorated-bushes",
  "park-base-decorated-trees",
  ...PARK_TILE_PLAZAS,
  "park-road-straight",
  "park-road-straight-decorated-A",
  "park-road-straight-decorated-B",
  "park-road-corner",
  "park-road-corner-decorated",
  "park-road-junction",
  "park-road-tsplit",
  "park-road-tsplit-decorated",
  "park-wall-straight-decorated",
  "park-wall-entry-decorated",
  "park-wall-innercorner-decorated",
  "park-wall-outercorner-decorated",
] as const;
// KayKit street details (City Builder Bits).
export const PROP_HYDRANT = "kk-hydrant";
export const PROP_BENCH = "kk-bench";
export const PROP_TRASH_A = "kk-trash-a";
export const PROP_TRASH_B = "kk-trash-b";
export const PROP_TRAFFICLIGHT = "kk-trafficlight";
export const PROP_DUMPSTER = "kk-dumpster";
export const PROP_WATERTOWER = "kk-watertower";
export const PROP_BOX_A = "kk-box-a";
export const PROP_BOX_B = "kk-box-b";
// Commercial frontage details.
export const PROP_PARASOL_A = "parasol-a";
export const PROP_PARASOL_B = "parasol-b";
// Suburban yards.
export const PROP_FENCE = "fence";
export const PROP_FENCE_LOW = "fence-low";
export const PROP_PATH = "path-short";
export const PROP_PATH_STONES = "path-stones-short";
// Industrial skyline.
export const PROP_CHIMNEY_SMALL = "chimney-small";
export const PROP_CHIMNEY_MEDIUM = "chimney-medium";
export const PROP_CHIMNEY_LARGE = "chimney-large";
export const PROP_TANK = "tank";

// --- Crash debris (Car Kit) ---
export const DEBRIS_SMALL = [
  "debris-bolt",
  "debris-nut",
  "debris-plate-small-a",
  "debris-plate-small-b",
] as const;
export const DEBRIS_BIG = [
  "debris-tire",
  "debris-bumper",
  "debris-plate-a",
  "debris-door",
] as const;

// --- Characters (passengers) ---
export const CHARACTERS = [
  "character-male-a",
  "character-male-b",
  "character-male-c",
  "character-male-d",
  "character-male-e",
  "character-male-f",
  "character-female-a",
  "character-female-b",
  "character-female-c",
  "character-female-d",
  "character-female-e",
  "character-female-f",
] as const;

export const PROPS = [
  TREE_LARGE,
  TREE_SMALL,
  PROP_CONE,
  PROP_PLANTER,
  PROP_BARRIER,
  PROP_CONSTRUCTION_LIGHT,
  LIGHT_CURVED,
  LIGHT_SQUARE,
  LIGHT_SQUARE_DOUBLE,
  LIGHT_CURVED_CROSS,
  LIGHT_OLD,
  LIGHT_OLD_DOUBLE,
  PROP_HYDRANT,
  PROP_BENCH,
  PROP_TRASH_A,
  PROP_TRASH_B,
  PROP_TRAFFICLIGHT,
  PROP_DUMPSTER,
  PROP_WATERTOWER,
  PROP_BOX_A,
  PROP_BOX_B,
  PROP_PARASOL_A,
  PROP_PARASOL_B,
  PROP_FENCE,
  PROP_FENCE_LOW,
  PROP_PATH,
  PROP_PATH_STONES,
  PROP_CHIMNEY_SMALL,
  PROP_CHIMNEY_MEDIUM,
  PROP_CHIMNEY_LARGE,
  PROP_TANK,
  PARK_WALL,
  PARK_WALL_CORNER,
  PARK_ENTRY,
  ...BUSHES,
  ...PARK_TREES,
] as const;

const ROADS = [ROAD_BRIDGE, BRIDGE_PILLAR, BRIDGE_PILLAR_WIDE] as const;

// TITLE-CRITICAL set (~200KB): exactly what the player car and city phase 1
// (terrain/streets/green cells/garage depots — city.ts buildPhase1) touch.
// The title screen goes up after these; everything else streams behind it.
// If buildPhase1 gains a new model, it MUST move into this list.
export function earlyModelUrls(): string[] {
  return [
    modelUrl("cars", PLAYER_CAR),
    modelUrl("props", TREE_LARGE),
    modelUrl("props", TREE_SMALL),
    modelUrl("props", PROP_WATERTOWER),
    modelUrl("buildings", GARAGE_MODEL),
  ];
}

// Everything else — needed by the late city build (rebuildRest resolves
// building/prop GLB refs), traffic, fares, debris. Preloaded behind the title.
export function lateModelUrls(): string[] {
  const early = new Set(earlyModelUrls());
  return allModelUrls().filter((u) => !early.has(u));
}

// Everything the game ever preloads (early + late).
export function allModelUrls(): string[] {
  const urls: string[] = [];
  urls.push(modelUrl("cars", PLAYER_CAR));
  urls.push(modelUrl("cars", POLICE_CAR));
  for (const c of TRAFFIC_CARS) urls.push(modelUrl("cars", c));
  for (const c of SERVICE_CARS) urls.push(modelUrl("cars", c));
  for (const c of GEN_ROBOTAXIS) urls.push(modelUrl("cars", c));
  for (const c of CONSTRUCTION_VEHICLES) urls.push(modelUrl("cars", c));
  for (const r of ROADS) urls.push(modelUrl("roads", r));
  for (const b of [
    ...BUILDINGS_COMMERCIAL,
    ...BUILDINGS_SKYSCRAPER,
    ...BUILDINGS_INDUSTRIAL,
    ...BUILDINGS_SUBURBAN,
  ])
    urls.push(modelUrl("buildings", b));
  for (const p of PROPS) urls.push(modelUrl("props", p));
  for (const t of PARK_TILES) urls.push(modelUrl("parks", t));
  urls.push(modelUrl("buildings", GARAGE_MODEL));
  for (const b of KK_BUILDINGS) urls.push(modelUrl("buildings", b));
  for (const c of KK_CARS) urls.push(modelUrl("cars", c));
  for (const x of KK_PROPS_EXTRA) urls.push(modelUrl("props", x));
  for (const d of [...DEBRIS_SMALL, ...DEBRIS_BIG]) urls.push(modelUrl("debris", d));
  for (const c of CHARACTERS) urls.push(modelUrl("characters", c));
  return urls;
}
