// Typed access to the world map (public/assets/map.json) plus the gameplay
// classification of its tile indices: which cells walk, till, fish, and collide.

import { isJsonNumber, isJsonObject, isJsonString } from "../json";
import type { JsonValue } from "../json";

export interface WorldMapTileLayer {
  name: string;
  w: number;
  h: number;
  // -1 = empty; else atlas index | flipX<<20 | flipY<<21 | rotate<<22
  grid: number[];
}

export interface WorldMapSprite {
  layer: string;
  sprite: string;
  x: number;
  y: number;
  sx: number;
  sy: number;
  speed: number;
}

export interface DecoDef {
  frames: number;
  fw: number;
  fh: number;
  ox: number;
  oy: number;
  fps: number;
}

export interface DecoMap {
  [sprite: string]: DecoDef;
}

export interface WorldMap {
  w: number;
  h: number;
  tileLayers: WorldMapTileLayer[];
  sprites: WorldMapSprite[];
  deco: DecoMap;
  animations: number[][];
  animationFps: number;
}

/* oxlint-disable no-bitwise -- the tile word packs the atlas index with flip/rotate flags; unpacking it IS bit math */
export const tileIndex = (v: number): number => v & 0xf_ff_ff;
export const tileFlipX = (v: number): boolean => ((v >> 20) & 1) === 1;
export const tileFlipY = (v: number): boolean => ((v >> 21) & 1) === 1;
// 90° clockwise, applied after flips.
export const tileRotate = (v: number): boolean => ((v >> 22) & 1) === 1;
/* oxlint-enable no-bitwise */

const isNumberArray = (v: JsonValue | undefined): v is number[] =>
  Array.isArray(v) && v.every(isJsonNumber);

const parseTileLayers = (raw: JsonValue | undefined, w: number, h: number): WorldMapTileLayer[] => {
  if (!Array.isArray(raw)) {
    throw new TypeError("map.json: bad tileLayers");
  }
  const out: WorldMapTileLayer[] = [];
  for (const l of raw) {
    if (!isJsonObject(l)) {
      throw new Error("map.json: bad layer");
    }
    const { name, grid } = l;
    if (!isJsonString(name) || !isNumberArray(grid)) {
      throw new Error("map.json: bad layer");
    }
    out.push({ grid, h, name, w });
  }
  return out;
};

const parseSprites = (raw: JsonValue | undefined): WorldMapSprite[] => {
  if (!Array.isArray(raw)) {
    throw new TypeError("map.json: bad sprites");
  }
  const out: WorldMapSprite[] = [];
  for (const s of raw) {
    if (!isJsonObject(s)) {
      continue;
    }
    const { sprite, x, layer, y, sx, sy, speed } = s;
    if (!isJsonString(sprite) || !isJsonNumber(x)) {
      continue;
    }
    out.push({
      layer: isJsonString(layer) ? layer : "Assets_1",
      speed: isJsonNumber(speed) ? speed : 1,
      sprite,
      sx: isJsonNumber(sx) ? sx : 1,
      sy: isJsonNumber(sy) ? sy : 1,
      x,
      y: isJsonNumber(y) ? y : 0,
    });
  }
  return out;
};

const parseDeco = (raw: JsonValue | undefined): DecoMap => {
  const deco: DecoMap = {};
  if (!isJsonObject(raw)) {
    return deco;
  }
  for (const [k, d] of Object.entries(raw)) {
    if (!isJsonObject(d)) {
      continue;
    }
    const { frames, fw, fh, ox, oy, fps } = d;
    deco[k] = {
      fh: isJsonNumber(fh) ? fh : 16,
      fps: isJsonNumber(fps) ? fps : 8,
      frames: isJsonNumber(frames) ? frames : 1,
      fw: isJsonNumber(fw) ? fw : 16,
      ox: isJsonNumber(ox) ? ox : 0,
      oy: isJsonNumber(oy) ? oy : 0,
    };
  }
  return deco;
};

// Narrow the fetched JSON. The file is produced by our own tool, so checks are
// structural rather than exhaustive.
export const parseWorldMap = (v: JsonValue): WorldMap => {
  if (!isJsonObject(v)) {
    throw new Error("map.json: not an object");
  }
  const o = v;
  const { w, h, animationFps } = o;
  if (!isJsonNumber(w) || !isJsonNumber(h)) {
    throw new Error("map.json: bad size");
  }
  const tileLayers = parseTileLayers(o["tileLayers"], w, h);
  const sprites = parseSprites(o["sprites"]);
  const deco = parseDeco(o["deco"]);
  const animations = Array.isArray(o["animations"]) ? o["animations"].filter(isNumberArray) : [];
  return {
    animationFps: isJsonNumber(animationFps) ? animationFps : 5,
    animations,
    deco,
    h,
    sprites,
    tileLayers,
    w,
  };
};

export const layerByName = (map: WorldMap, name: string): WorldMapTileLayer | null =>
  map.tileLayers.find((l) => l.name === name) ?? null;

// ---------------------------------------------------------------- semantics

// Land-layer classification. Anything used-but-unlisted defaults to solid
// ground (cliff), which fails safe: you can't walk into un-vetted terrain.
const LAND_GRASS = new Set([
  66, 129, 130, 131, 132, 133, 134, 193, 194, 195, 196, 197, 198, 200, 257, 258, 259, 260, 261, 262,
  263, 270, 271, 272, 273, 326, 327, 329, 330, 332, 2123, 2124, 2125,
  // pond/river RIM tiles (grass with a painted water lip, all orientations) —
  // walkable: you stand at the bank's edge; the full-water tiles still block.
  // Classifying rims as water walled every bank off invisibly.
  471, 472, 473, 474, 475, 477, 534, 536, 537, 538, 539, 540,
]);
// Sand, including the animated foam waterline (147-152 sea foam, 339-344
// sand-foam edges): the beach ring is wet sand you can walk, so shorelines
// and the mine-cave spit connect; open water beyond still blocks.
const LAND_SAND = new Set([
  69, 71, 72, 73, 147, 148, 149, 150, 151, 152, 339, 340, 341, 342, 343, 344,
]);
// the dark excavated mining yard (bottom-left) — walkable, not tillable
const LAND_DIRT = new Set([
  1803, 1804, 1867, 1868, 1929, 1930, 1931, 1932, 1994, 1995, 2058, 2059, 2060, 2061,
]);
// Water drawn on the land layer: sea-foam shores, sand shoals, waterfall
// mouths (each listed with its animation partners), and the turquoise
// river/pond family — fills, grass edges, corners, sparkles. 264 is the
// fully-transparent spacer over open sea.
const LAND_WATER = new Set([
  211, 212, 213, 214, 215, 403, 404, 405, 406, 407, 408, 414, 415, 416, 417, 264, 470, 478, 479,
  480, 481, 542, 543, 544, 545, 859,
]);
// Cliff faces and bridge posts painted on the land layer — known solids.
const LAND_SOLID = new Set([101, 165, 202, 203, 266, 267, 268, 394, 396, 418]);

// Structural posts that hold bridges up — never walkable.
const PATH_SOLID = new Set([101, 165, 359, 361]);
// Translucent dressing on the paths layer that is NOT a walkway: grass tufts
// hanging over cliff faces, dust/speckle transitions, rail shadows. These
// inherit the land class. Every other paths tile is walkway art (dirt path,
// bridges, stairs, ramps, decks) and overrides the land class — that's what
// the layer is for, so bridges over the river walk.
const PATH_OVERLAY = new Set([
  // grass tufts over cliff faces
  205, 206, 207, 397, 398, 399, 400,
  // dust / speckle / shadow transition fringes
  135, 137, 138, 140, 294, 336, 422, 452, 454, 455, 456, 463, 465, 467, 483, 484, 485, 486, 487,
  489, 515, 516, 517, 518, 519, 526, 527, 528, 529, 530, 546, 548, 549, 550, 551, 552,
]);

// Walkable overrides painted on the decoration layers: ladders against cliff
// faces / over the stone wall (174, 810) and the plank footbridge over the
// south-beach inlet (358, 360). They force the cell walkable.
const DECO_CLIMB = new Set([174, 810, 358, 360]);

// Free-standing solid props on the decoration layers (fences, rocks, graves,
// furniture). Everything else there is walk-over dressing.
const DECO_SOLID = new Set([
  // wooden + stone fences, hedges (NOT 170 — that's the open gate piece, and
  // NOT 174 — that's the wall ladder)
  38, 39, 113, 114, 166, 167, 173, 175, 108, 109, 110, 111, 177, 178,
  // trunks, stumps, big bushes & berry bushes, potted trees
  // (small plant 372 and pebbles 287-290 are step-over dressing — GM paints
  // them ON the narrow cliff-descent paths)
  103, 104, 106, 229, 231, 232, 233, 296, 305, 306, 307, 308, 351, 352, 369, 433, 499, 500, 701,
  241, 242,
  // rocks, ore boulders, gravestones, statues
  236, 300, 301, 1003, 1004, 1005, 1006, 1067, 1068, 1069, 1070, 1071, 1521, 1522, 1523, 1524, 1525,
  1526, 1585, 1586, 1587, 1588, 1589, 1590, 1591, 1777, 1778, 1779, 1780, 1781, 1782, 1841, 1842,
  1843, 1844, 1845, 1846, 1907, 1908, 1909, 1910, 1971, 1972, 1973, 1974, 2163, 2164, 1324, 1325,
  // crates, barrels, jars, furniture, dummies, anvils, fountains
  // (NOT 919/920 — drying-line posts dressing the south bridge deck; NOT 648 —
  // on the deco layer it's flat log dressing by the farmhouse, and it walled
  // off the river bank east of spawn)
  613, 614, 615, 616, 650, 677, 678, 679, 680, 684, 685, 846, 847, 861, 862, 863, 875, 876, 878,
  879, 882, 936, 988, 1010, 1061, 1062, 1063, 1064, 1138, 1260, 1261, 1265, 1266, 1267, 1268, 1330,
  1359, 1376, 1377, 1378, 1388, 1389, 1423, 2228, 2230, 2279, 2343, 797, 798, 799, 1131, 1132, 1133,
  1134, 1135, 1248, 1249, 1250,
]);

export const CELL = {
  // walk (mining yard, paths)
  dirt: 3,
  // walk + till
  grass: 1,
  // walk
  sand: 2,
  // cliff/building/fence — static collision
  solid: 5,
  // open sea / sky — solid, fishable
  void: 0,
  // river/sea visible — solid, fishable
  water: 4,
} as const;
export type Cell = (typeof CELL)[keyof typeof CELL];

// The farm field on the top-left plateau: the map's crop dressing is suppressed
// here and the plot tiles till like grass.
export const FIELD_RECT = { x0: 9, x1: 21, y0: 6, y1: 11 } as const;
export const inField = (tx: number, ty: number): boolean =>
  tx >= FIELD_RECT.x0 && tx <= FIELD_RECT.x1 && ty >= FIELD_RECT.y0 && ty <= FIELD_RECT.y1;

export interface Semantics {
  kind: Uint8Array;
}

// Per-layer classification, shared by buildSemantics and the ?gallery page.
export const classifyLandIndex = (i: number): Cell => {
  if (LAND_GRASS.has(i)) {
    return CELL.grass;
  }
  if (LAND_SAND.has(i)) {
    return CELL.sand;
  }
  if (LAND_DIRT.has(i)) {
    return CELL.dirt;
  }
  if (LAND_WATER.has(i)) {
    return CELL.water;
  }
  return CELL.solid;
};
export const isKnownLandIndex = (i: number): boolean =>
  LAND_GRASS.has(i) ||
  LAND_SAND.has(i) ||
  LAND_DIRT.has(i) ||
  LAND_WATER.has(i) ||
  LAND_SOLID.has(i);
export type PathClass = "solid" | "walk" | "overlay";
export const classifyPathIndex = (i: number): PathClass => {
  if (PATH_SOLID.has(i)) {
    return "solid";
  }
  if (PATH_OVERLAY.has(i)) {
    return "overlay";
  }
  return "walk";
};

type Layer = WorldMapTileLayer | null;

const landKindAt = (land: Layer, i: number, unknownLand: Set<number>): Cell | null => {
  const lv = land?.grid[i] ?? -1;
  if (lv < 0) {
    return null;
  }
  const li = tileIndex(lv);
  if (!isKnownLandIndex(li)) {
    unknownLand.add(li);
  }
  return classifyLandIndex(li);
};

// Solid props block, then ladders climb over anything (cliff faces, the stone wall).
const decoKindAt = (deco: readonly Layer[], i: number, inFieldCell: boolean, base: Cell): Cell => {
  let kind = base;
  for (const d of deco) {
    const dv = d?.grid[i] ?? -1;
    if (dv >= 0 && DECO_SOLID.has(tileIndex(dv)) && !inFieldCell) {
      kind = CELL.solid;
    }
  }
  for (const d of deco) {
    const dv = d?.grid[i] ?? -1;
    if (dv >= 0 && DECO_CLIMB.has(tileIndex(dv))) {
      kind = CELL.dirt;
    }
  }
  return kind;
};

// Collapse the painted layers into one gameplay cell kind per tile.
export const buildSemantics = (map: WorldMap): Semantics => {
  const { w, h } = map;
  const kind = new Uint8Array(w * h).fill(CELL.void);
  const land = layerByName(map, "land");
  const paths = layerByName(map, "paths");
  const deco: readonly Layer[] = [
    layerByName(map, "decoration_01"),
    layerByName(map, "decoration_02"),
  ];
  const building = layerByName(map, "building");
  const walls = layerByName(map, "walls");
  const unknownLand = new Set<number>();

  for (let i = 0; i < w * h; i += 1) {
    let cell: Cell = landKindAt(land, i, unknownLand) ?? CELL.void;
    // walkway overrides (bridges, stairs, decks); fringe tiles inherit land
    const pv = paths?.grid[i] ?? -1;
    const pc = pv >= 0 ? classifyPathIndex(tileIndex(pv)) : null;
    if (pc === "solid") {
      cell = CELL.solid;
    } else if (pc === "walk") {
      cell = CELL.dirt;
    }
    // field plots till like grass
    const inFieldCell = inField(i % w, Math.trunc(i / w));
    if (inFieldCell && cell !== CELL.solid) {
      cell = CELL.grass;
    }
    // Solid structures override everything EXCEPT a walkway: where GM paints
    // road tiles through a structure (the village archway) the road passes
    // underneath — the structure y-sorts over the player. The forest layer is
    // treetop canopy, not collision: the player walks beneath it (it renders
    // above); trunks block via the placed tree objects instead.
    const structure = (building?.grid[i] ?? -1) >= 0 || (walls?.grid[i] ?? -1) >= 0;
    if (structure && pc !== "walk") {
      cell = CELL.solid;
    }
    kind[i] = decoKindAt(deco, i, inFieldCell, cell);
  }
  if (unknownLand.size > 0) {
    console.warn(`worldmap: ${unknownLand.size} unclassified land tile indices treated as solid:`, [
      ...unknownLand,
    ]);
  }
  return { kind };
};

// Solid props on decoration layers that should y-sort against the player
// (fences, graves, rocks) rather than render under everything.
export const isDecoSolidIndex = (i: number): boolean => DECO_SOLID.has(i);
