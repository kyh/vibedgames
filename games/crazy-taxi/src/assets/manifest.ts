// Asset catalog. Files live in public/models/<category>/<name>.glb and are
// served at <BASE_URL>models/<category>/<name>.glb.

const BASE = import.meta.env.BASE_URL;

export function modelUrl(category: string, name: string): string {
  return `${BASE}models/${category}/${name}.glb`;
}

// --- Cars ---
export const PLAYER_CAR = "taxi";
export const TRAFFIC_CARS = [
  "sedan",
  "sedan-sports",
  "suv",
  "suv-luxury",
  "van",
  "truck",
  "delivery",
  "hatchback-sports",
] as const;
export const POLICE_CAR = "police";

// --- Roads (autotile set) ---
// The five base tiles the autotiler resolves to, plus decorative variants.
export const ROAD_STRAIGHT = "road-straight";
export const ROAD_BEND = "road-bend";
export const ROAD_CROSSROAD = "road-crossroad";
export const ROAD_INTERSECTION = "road-intersection";
export const ROAD_END = "road-end";
export const ROAD_CROSSING = "road-crossing";

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
] as const;

// --- Props ---
export const TREE_LARGE = "tree-large";
export const TREE_SMALL = "tree-small";
export const PROP_CONE = "construction-cone";
export const PROP_PLANTER = "planter";

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

// Everything that must be preloaded before the game starts.
export function allModelUrls(): string[] {
  const urls: string[] = [];
  urls.push(modelUrl("cars", PLAYER_CAR));
  urls.push(modelUrl("cars", POLICE_CAR));
  for (const c of TRAFFIC_CARS) urls.push(modelUrl("cars", c));
  for (const r of [
    ROAD_STRAIGHT,
    ROAD_BEND,
    ROAD_CROSSROAD,
    ROAD_INTERSECTION,
    ROAD_END,
    ROAD_CROSSING,
  ])
    urls.push(modelUrl("roads", r));
  for (const b of [
    ...BUILDINGS_COMMERCIAL,
    ...BUILDINGS_SKYSCRAPER,
    ...BUILDINGS_INDUSTRIAL,
    ...BUILDINGS_SUBURBAN,
  ])
    urls.push(modelUrl("buildings", b));
  for (const p of [TREE_LARGE, TREE_SMALL, PROP_CONE, PROP_PLANTER])
    urls.push(modelUrl("props", p));
  for (const c of CHARACTERS) urls.push(modelUrl("characters", c));
  return urls;
}
