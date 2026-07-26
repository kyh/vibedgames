// Bake OSM landuse/leisure/natural/amenity polygons into a per-cell GROUND
// CLASS grid (src/world/sf-landuse.ts).  node tools/sf-data/bake-landuse.mjs
//
// Two things this fixes over the green/sand bitmask pair it replaces:
//
//  1. THE DATASET WAS TWO BITS WIDE. Everything that was not park or beach fell
//     through to "unclassified", which is why 72% of the city's land cells
//     painted as one literal grey. Rail yards, container aprons, parking lots,
//     schoolyards, plazas, quarry rock and the Bayview's brownfields are all
//     distinguishable now — see CLASSES. `leisure=pitch` in particular used to
//     bucket as GREEN, so SF's asphalt schoolyards painted as lawn; a pitch now
//     reads `surface`/`sport` and only lands on turf when the tags say grass.
//  2. IT SAMPLED CELL CENTRES. A 13u cell either contained a polygon's centre
//     or did not, so the ~350 OSM components smaller than three cells landed
//     wherever the arithmetic fell — a blur, not a shape. Coverage is now
//     computed by exact x-span scanline fill at 4 sub-rows per cell, and a cell
//     takes the class that covers the most of it (min MIN_COVER).
//
// Relations are in the pull now too (fetch-landuse.sh): Golden Gate Park and
// the Presidio are multipolygons and are invisible to a way-only query. Their
// member ways arrive as open fragments, so rings get stitched below.

import { readFileSync, writeFileSync } from "node:fs";

const GRID_X = 244;
const GRID_Z = 200;
// Same calibrated projection as bake-network.mts.
const U_M = 6.2462,
  U_B = 765.2557;
const V_M = -9.6095,
  V_B = 363.344;
// Sub-rows per cell for the scanline fill (x is exact within each sub-row).
const SUB_ROWS = 4;
// A cell has to be a third covered before it takes a class. Below that the
// polygon is street furniture, not ground: a 6u parklet does not repaint 58 m².
const MIN_COVER = 0.34;

// --- Class taxonomy ---------------------------------------------------------
// Order is the tie-break order (earlier wins an exact tie) and the id order in
// the emitted file, so APPEND new classes; never renumber.
const CLASSES = [
  "unclassified",
  "park",
  "grass",
  "garden",
  "wood",
  "scrub",
  "cemetery",
  "turf",
  "court",
  "plaza",
  "parking",
  "industrial",
  "railyard",
  "port",
  "institution",
  "retail",
  "sand",
  "rock",
  "water",
];
const ID = new Map(CLASSES.map((c, i) => [c, i]));
// OSM ground polygons NEST: the Presidio's park ring contains the national
// cemetery, a school ring contains its pitches, Golden Gate Park contains Ocean
// Beach's sand. Pure argmax coverage always returns the encloser, so a cell's
// class is the best `coverage × specificity` — the broad background classes are
// discounted and the small distinctive features can win the cell they sit in.
const WEIGHT = {
  park: 1,
  plaza: 1,
  grass: 1.1,
  wood: 1.2,
  scrub: 1.2,
  railyard: 1.2,
  parking: 1.3,
  turf: 1.4,
  court: 1.4,
  cemetery: 1.5,
  garden: 1.5,
  rock: 1.5,
  sand: 1.6,
  water: 1.6,
  industrial: 0.95,
  port: 0.95,
  institution: 0.9,
  retail: 0.85,
};
// Classes the ground reads as vegetated. landuseGreenAt gates park tiles, the
// car-free park clip and the meadow patches, so this stays conservative:
// courts, plazas and parking are NOT green however much a school owns them.
const GREEN = ["park", "grass", "garden", "wood", "scrub", "cemetery", "turf"];
const SAND = ["sand"];

// Pitches, tracks and playgrounds: grass only when the tags say so. SF's
// school pitches are overwhelmingly asphalt, so unknown surface → court.
const GRASS_SURFACE = new Set(["grass", "dirt", "earth", "ground", "sand", "clay", "gravel"]);
const HARD_SURFACE = new Set([
  "asphalt",
  "concrete",
  "paved",
  "acrylic",
  "tartan",
  "rubber",
  "artificial_turf",
  "metal",
  "wood",
]);
const TURF_SPORT = new Set([
  "soccer",
  "baseball",
  "softball",
  "american_football",
  "rugby",
  "cricket",
  "field_hockey",
  "athletics",
  "golf",
  "multi",
]);

function classOf(tags) {
  const t = tags ?? {};
  const leisure = t.leisure ?? "";
  const landuse = t.landuse ?? "";
  const natural = t.natural ?? "";
  const amenity = t.amenity ?? "";
  const manMade = t.man_made ?? "";
  if (natural === "beach" || natural === "sand") return "sand";
  if (natural === "bare_rock" || natural === "cliff") return "rock";
  if (natural === "water" || natural === "wetland") return "water";
  if (natural === "wood") return "wood";
  if (natural === "scrub" || natural === "heath") return "scrub";
  if (natural === "grassland") return "grass";
  if (leisure === "pitch" || leisure === "track" || leisure === "playground") {
    const surface = t.surface ?? "";
    if (GRASS_SURFACE.has(surface)) return "turf";
    if (HARD_SURFACE.has(surface)) return "court";
    return leisure === "playground" ? "court" : TURF_SPORT.has(t.sport ?? "") ? "turf" : "court";
  }
  if (leisure === "golf_course") return "turf";
  if (leisure === "stadium" || leisure === "sports_centre") return "court";
  if (leisure === "park" || leisure === "common" || leisure === "nature_reserve") return "park";
  if (leisure === "dog_park") return "park";
  if (leisure === "garden") return "garden";
  if (leisure === "recreation_ground") return "grass";
  if (landuse === "cemetery") return "cemetery";
  if (landuse === "forest") return "wood";
  if (landuse === "grass" || landuse === "meadow" || landuse === "recreation_ground")
    return "grass";
  if (landuse === "village_green") return "park";
  if (landuse === "allotments" || landuse === "orchard") return "garden";
  if (landuse === "railway") return "railyard";
  if (landuse === "port") return "port";
  if (landuse === "industrial" || landuse === "brownfield") return "industrial";
  if (landuse === "construction" || landuse === "quarry") return "industrial";
  if (landuse === "military") return "institution";
  if (landuse === "retail" || landuse === "commercial") return "retail";
  if (amenity === "parking") return "parking";
  if (amenity === "school" || amenity === "university" || amenity === "college")
    return "institution";
  if (amenity === "hospital") return "institution";
  if (manMade === "pier" || manMade === "quay" || manMade === "breakwater") return "port";
  if (manMade === "works") return "industrial";
  if (t.highway === "pedestrian" || t.place === "square") return "plaza";
  return null;
}

// --- Rings ------------------------------------------------------------------
// Grid-space ring: [x0, z0, x1, z1, …] in CELL units (x = gx + frac).
const toGrid = (geometry) => {
  const ring = [];
  for (const g of geometry) ring.push((U_M * g.lon + U_B) * GRID_X, (V_M * g.lat + V_B) * GRID_Z);
  return ring;
};

const key = (g) => `${g.lat.toFixed(7)},${g.lon.toFixed(7)}`;
const isClosed = (g) => g.length > 3 && key(g[0]) === key(g[g.length - 1]);

// Stitch a relation's member ways into closed rings. Members arrive as
// arbitrarily-ordered, arbitrarily-directed fragments; a ring is done when it
// bites its own tail. Fragments that never close are dropped (a relation with a
// gap has no interior to fill).
function stitch(members) {
  const open = members.map((m) => m.geometry).filter((g) => Array.isArray(g) && g.length > 1);
  const rings = [];
  const pending = [];
  for (const g of open) (isClosed(g) ? rings : pending).push(g);
  while (pending.length > 0) {
    let run = pending.pop();
    let grew = true;
    while (grew && !isClosed(run)) {
      grew = false;
      for (let i = 0; i < pending.length; i++) {
        const c = pending[i];
        const head = key(run[0]);
        const tail = key(run[run.length - 1]);
        if (key(c[0]) === tail) run = [...run, ...c.slice(1)];
        else if (key(c[c.length - 1]) === tail) run = [...run, ...c.slice(0, -1).reverse()];
        else if (key(c[c.length - 1]) === head) run = [...c.slice(0, -1), ...run];
        else if (key(c[0]) === head) run = [...c.slice(1).reverse(), ...run];
        else continue;
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (isClosed(run)) rings.push(run);
  }
  return rings;
}

const raw = JSON.parse(readFileSync(new URL("./sf-landuse.raw.json", import.meta.url)));
const rings = []; // { cls, ring, inner }
let skippedTags = 0;
let relRings = 0;
for (const e of raw.elements ?? []) {
  const cls = classOf(e.tags);
  if (cls === null) {
    skippedTags++;
    continue;
  }
  if (e.type === "way") {
    if (!Array.isArray(e.geometry) || e.geometry.length < 3) continue;
    rings.push({ cls, ring: toGrid(e.geometry), inner: false });
  } else if (e.type === "relation") {
    const members = (e.members ?? []).filter((m) => m.type === "way");
    const outers = stitch(members.filter((m) => m.role !== "inner"));
    const inners = stitch(members.filter((m) => m.role === "inner"));
    for (const g of outers) rings.push({ cls, ring: toGrid(g), inner: false });
    for (const g of inners) rings.push({ cls, ring: toGrid(g), inner: true });
    relRings += outers.length + inners.length;
  }
}
console.log(
  `${rings.length} rings (${relRings} from relations), ${skippedTags} elements with no ground class`,
);

// --- Coverage ---------------------------------------------------------------
// Exact x-span fill per sub-row: for each scanline the ring's crossings are
// sorted and each inside span adds its true overlap with every cell it touches.
// That is real area coverage, not a centre-point coin flip.
const cover = CLASSES.map(() => new Float32Array(GRID_X * GRID_Z));
function fill(target, ring, sign) {
  const n = ring.length / 2;
  let minZ = Infinity,
    maxZ = -Infinity;
  for (let i = 1; i < ring.length; i += 2) {
    minZ = Math.min(minZ, ring[i]);
    maxZ = Math.max(maxZ, ring[i]);
  }
  const gz0 = Math.max(0, Math.floor(minZ));
  const gz1 = Math.min(GRID_Z - 1, Math.ceil(maxZ));
  const xs = [];
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let s = 0; s < SUB_ROWS; s++) {
      const pz = gz + (s + 0.5) / SUB_ROWS;
      xs.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const zi = ring[i * 2 + 1];
        const zj = ring[j * 2 + 1];
        if (zi > pz === zj > pz) continue;
        const xi = ring[i * 2];
        const xj = ring[j * 2];
        xs.push(xi + ((xj - xi) * (pz - zi)) / (zj - zi));
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, xs[k]);
        const x1 = Math.min(GRID_X, xs[k + 1]);
        if (x1 <= x0) continue;
        for (let gx = Math.floor(x0); gx <= Math.min(GRID_X - 1, Math.floor(x1)); gx++) {
          const overlap = Math.min(x1, gx + 1) - Math.max(x0, gx);
          if (overlap > 0) target[gx * GRID_Z + gz] += (sign * overlap) / SUB_ROWS;
        }
      }
    }
  }
}
for (const r of rings) fill(cover[ID.get(r.cls)], r.ring, r.inner ? -1 : 1);

// --- Classify ---------------------------------------------------------------
const cls = new Uint8Array(GRID_X * GRID_Z);
const counts = CLASSES.map(() => 0);
const weightOf = CLASSES.map((c) => WEIGHT[c] ?? 1);
for (let i = 0; i < cls.length; i++) {
  let best = 0;
  let bestScore = 0;
  for (let c = 1; c < CLASSES.length; c++) {
    const v = cover[c][i];
    if (v < MIN_COVER) continue;
    const score = v * weightOf[c];
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  cls[i] = best;
  counts[best]++;
}
const classified = cls.length - counts[0];
console.log(
  `classified ${classified}/${cls.length} cells (${((classified / cls.length) * 100).toFixed(1)}%)`,
);
for (let c = 1; c < CLASSES.length; c++) {
  if (counts[c] > 0) console.log(`  ${CLASSES[c].padEnd(13)} ${counts[c]}`);
}

// One byte per cell, two hex chars, column-major — the same shape as
// sf-streets.ts's `cols`. Trailing unclassified runs are trimmed off each
// column (the bay margins), which is most of the payload.
const cols = [];
for (let gx = 0; gx < GRID_X; gx++) {
  let hex = "";
  for (let gz = 0; gz < GRID_Z; gz++) hex += cls[gx * GRID_Z + gz].toString(16).padStart(2, "0");
  cols.push(hex.replace(/(?:00)+$/, ""));
}

const union = (names) => names.map((n) => JSON.stringify(n)).join(" | ");
const list = (names) => names.map((n) => JSON.stringify(n)).join(", ");
const out = `// AUTO-GENERATED by tools/sf-data/bake-landuse.mjs — do not edit by hand.
// Real OSM ground classes per grid cell: what each 13u cell of San Francisco
// actually IS. One byte per cell, two hex chars, column-major (same shape as
// sf-streets.ts); trailing unclassified runs are trimmed per column.

/** Ground classes, in id order. Append only — the raster stores the index. */
export const LANDUSE_CLASSES = [
${CLASSES.map((c) => `  ${JSON.stringify(c)},`).join("\n")}
] as const;

export type LanduseClass = ${union(CLASSES)};

const CLASS_COLS: readonly string[] = ${JSON.stringify(cols)};

function classId(gx: number, gz: number): number {
  const col = CLASS_COLS[gx];
  if (col === undefined || gz < 0) return 0;
  const at = gz * 2;
  if (at + 2 > col.length) return 0; // column trimmed past its last class
  const id = Number.parseInt(col.slice(at, at + 2), 16);
  return Number.isNaN(id) ? 0 : id;
}

/** What the ground at this cell is. "unclassified" = OSM says nothing. */
export function landuseClassAt(gx: number, gz: number): LanduseClass {
  return LANDUSE_CLASSES[classId(gx, gz)] ?? "unclassified";
}

// Vegetated classes. This gates park tiles, the car-free park clip and the
// meadow patches, so it stays narrow: an asphalt schoolyard is a "court".
const GREEN_CLASSES: ReadonlySet<LanduseClass> = new Set([${list(GREEN)}]);
const SAND_CLASSES: ReadonlySet<LanduseClass> = new Set([${list(SAND)}]);

export function landuseGreenAt(gx: number, gz: number): boolean {
  return GREEN_CLASSES.has(landuseClassAt(gx, gz));
}
export function landuseSandAt(gx: number, gz: number): boolean {
  return SAND_CLASSES.has(landuseClassAt(gx, gz));
}
`;
writeFileSync(new URL("../../src/world/sf-landuse.ts", import.meta.url), out);
console.log(`sf-landuse.ts written (${(out.length / 1024).toFixed(1)} KB)`);
