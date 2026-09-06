// Bake the citywide PARCEL SOURCE the parcel fabric builds from:
//
//   pnpm bake:parcels        (vite-node — imports the survey tables in TS)
//
// Two inputs, one output:
//   * sf-buildings.raw.json — every OSM building footprint on the peninsula
//     (fetch-buildings.sh), projected through lib.mjs like the streets.
//   * src/world/sf-footprints.ts + sf-adjacency.ts — the licensed downtown
//     survey (LiDAR-true heights, exact party walls). Where the survey has a
//     parcel the OSM one is dropped; the survey is the hero set.
// → public/world/parcels.bin, gzipped, one custom record stream (see
//   src/world/parcel-source.ts for the reader — change them together).
//
// Why a binary and not a TS table: the 21k survey parcels were already a
// 2.4 MB module in the main bundle; 130k more as text would be 15 MB of
// JavaScript parsed on every load. Int16 deltas at 5 cm gzip to under 2 MB
// and are fetched next to the world bins.
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { onLandXZ, projU, projV, rdp, WORLD_H, WORLD_W } from "./lib.mjs";
import { parcelAt } from "../../src/world/sf-adjacency.ts";
import { SF_FOOTPRINTS } from "../../src/world/sf-footprints.ts";
import {
  PARCEL_HINTS,
  PARCEL_SOURCE_MAGIC,
  PARCEL_SOURCE_VERSION,
  type ParcelHint,
} from "../../src/world/parcel-source.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, "sf-buildings.raw.json");
const OUT = join(HERE, "../../public/world/parcels.bin");

/** Metres per world unit (the calibration the survey extractor measured). */
const M_PER_U = 4.46;
const RDP_EPS = 0.12;
const MAX_VERTS = 24;
// Below this a footprint is a rear-yard garage or a shed: real, but 30 m² of
// roof behind a house the player never sees, at the same vertex cost as the
// house. ~2 u² is 40 m².
const MIN_AREA = 2.0;
/** OSM parcels this close to a survey ring are the survey's. */
const SURVEY_REACH = 1.5;
const Q = 20; // int16 units per world unit (5 cm)

type Rec = {
  ring: number[]; // x0,z0,x1,z1...
  height: number; // world units, 0 = unknown
  hint: ParcelHint;
  hero: boolean;
  blind: number; // bitmask over edges e (vertex e -> e+1)
};

/** Signed area of a flat x,z ring. */
function areaFlat(ring: readonly number[]): number {
  const n = ring.length / 2;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += (ring[i * 2] ?? 0) * (ring[j * 2 + 1] ?? 0) - (ring[j * 2] ?? 0) * (ring[i * 2 + 1] ?? 0);
  }
  return a / 2;
}

function centroid(ring: readonly number[]): [number, number] {
  const n = ring.length / 2;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i * 2] ?? 0;
    cz += ring[i * 2 + 1] ?? 0;
  }
  return [cx / n, cz / n];
}

function pointInRing(ring: readonly number[], x: number, z: number): boolean {
  const n = ring.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2] ?? 0;
    const zi = ring[i * 2 + 1] ?? 0;
    const xj = ring[j * 2] ?? 0;
    const zj = ring[j * 2 + 1] ?? 0;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distToRing(ring: readonly number[], x: number, z: number): number {
  const n = ring.length / 2;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2] ?? 0;
    const az = ring[i * 2 + 1] ?? 0;
    const bx = ring[j * 2] ?? 0;
    const bz = ring[j * 2 + 1] ?? 0;
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-8 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / l2, 0), 1) : 0;
    const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (d < best) best = d;
  }
  return best;
}

/** Height in world units from OSM tags, 0 when neither tag parses. */
function heightOf(tags: Record<string, string>): number {
  const h = tags.height ?? tags["building:height"];
  if (h !== undefined) {
    const m = /^\s*([\d.]+)\s*(m|ft|')?/.exec(h);
    if (m) {
      let v = Number(m[1]);
      if (m[2] === "ft" || m[2] === "'") v *= 0.3048;
      if (Number.isFinite(v) && v > 0) return v / M_PER_U;
    }
  }
  const l = tags["building:levels"];
  if (l !== undefined) {
    const v = Number(l);
    if (Number.isFinite(v) && v > 0) return (v * 3.3) / M_PER_U;
  }
  return 0;
}

function hintOf(tags: Record<string, string>): ParcelHint | null {
  const b = (tags.building ?? "yes").toLowerCase();
  if (b === "no" || b === "roof" || b === "carport" || b === "ruins" || b === "construction") {
    return null;
  }
  if (b === "garage" || b === "garages" || b === "shed" || b === "hut" || b === "kiosk") {
    return "shed";
  }
  if (
    b === "house" ||
    b === "detached" ||
    b === "semidetached_house" ||
    b === "terrace" ||
    b === "residential" ||
    b === "bungalow"
  ) {
    return "house";
  }
  if (b === "apartments" || b === "dormitory" || b === "hotel") return "apartments";
  if (b === "commercial" || b === "retail" || b === "office" || b === "supermarket") {
    return "commercial";
  }
  if (b === "industrial" || b === "warehouse" || b === "hangar" || b === "service") {
    return "industrial";
  }
  if (
    b === "church" ||
    b === "school" ||
    b === "public" ||
    b === "civic" ||
    b === "hospital" ||
    b === "university" ||
    b === "college" ||
    b === "government" ||
    b === "temple" ||
    b === "synagogue" ||
    b === "mosque" ||
    b === "cathedral"
  ) {
    return "public";
  }
  return "generic";
}

type Geom = { readonly lat: number; readonly lon: number };
type Element = {
  readonly type: string;
  readonly id: number;
  readonly tags?: Record<string, string>;
  readonly geometry?: readonly Geom[];
  readonly members?: readonly {
    readonly type: string;
    readonly role: string;
    readonly geometry?: readonly Geom[];
  }[];
};

function toWorld(g: readonly Geom[]): number[] {
  const pts: [number, number][] = [];
  for (const p of g) {
    const u = projU(p.lon);
    const v = projV(p.lat);
    pts.push([(u - 0.5) * WORLD_W, (v - 0.5) * WORLD_H]);
  }
  // Closed in OSM (first == last) — drop the repeat.
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (
    first &&
    last &&
    pts.length > 1 &&
    Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6
  ) {
    pts.pop();
  }
  return pts.flat();
}

/**
 * RDP on a ring. rdp() is an open-polyline routine and a closed ring hands
 * it a zero-length chord (first == last), so every vertex measures zero and
 * the ring collapses. Split at the vertex farthest from vertex 0, simplify
 * the two open halves, rejoin.
 */
function simplify(flat: number[]): number[] | null {
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i] ?? 0, flat[i + 1] ?? 0]);
  if (pts.length < 3) return null;
  const p0 = pts[0] ?? [0, 0];
  let far = 1;
  let farD = -1;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i] ?? [0, 0];
    const d = Math.hypot(p[0] - p0[0], p[1] - p0[1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  // SAFETY: lib.mjs rdp() returns a subset of the [x, z] pairs it is given.
  const simplifyOpen = rdp as (pts: [number, number][], eps: number) => [number, number][];
  const run = (eps: number): [number, number][] => {
    const a = simplifyOpen(pts.slice(0, far + 1), eps);
    const b = simplifyOpen([...pts.slice(far), p0], eps);
    return [...a.slice(0, -1), ...b.slice(0, -1)];
  };
  let eps = RDP_EPS;
  let out = run(eps);
  while (out.length > MAX_VERTS && eps < 2) {
    eps *= 1.6;
    out = run(eps);
  }
  if (out.length < 3) return null;
  return out.flat();
}

// --- The survey (hero set) --------------------------------------------------
const recs: Rec[] = [];
let surveyStacked = 0;
for (let id = 0; id < SF_FOOTPRINTS.length; id++) {
  const flat = SF_FOOTPRINTS[id];
  if (flat === undefined) continue;
  const adj = parcelAt(id);
  if (adj?.stacked === true) {
    surveyStacked++;
    continue;
  }
  const ring = flat.slice(1);
  let blind = 0;
  if (adj) for (const e of adj.blind) if (e < 32) blind |= 1 << e;
  recs.push({ ring, height: flat[0] ?? 0, hint: "generic", hero: true, blind });
}
const surveyCount = recs.length;

// A hash of survey ring VERTICES and EDGE MIDPOINTS for the drop test.
const CELL = 8;
const surveyHash = new Map<number, number[]>();
const hkey = (x: number, z: number): number =>
  Math.floor((x + WORLD_W) / CELL) * 4096 + Math.floor((z + WORLD_H) / CELL);
for (let i = 0; i < surveyCount; i++) {
  const r = recs[i];
  if (!r) continue;
  const [cx, cz] = centroid(r.ring);
  const k = hkey(cx, cz);
  const arr = surveyHash.get(k) ?? [];
  arr.push(i);
  surveyHash.set(k, arr);
}
function nearSurvey(x: number, z: number): boolean {
  const gx = Math.floor((x + WORLD_W) / CELL);
  const gz = Math.floor((z + WORLD_H) / CELL);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (const i of surveyHash.get((gx + dx) * 4096 + gz + dz) ?? []) {
        const r = recs[i];
        if (!r) continue;
        if (pointInRing(r.ring, x, z) || distToRing(r.ring, x, z) < SURVEY_REACH) return true;
      }
    }
  }
  return false;
}

// --- OSM ---------------------------------------------------------------------
// SAFETY: the file is the Overpass JSON fetch-buildings.sh wrote; its shape is the API's.
const raw = JSON.parse(readFileSync(RAW, "utf8")) as { elements: Element[] };
let ways = 0;
let rels = 0;
let offMap = 0;
let water = 0;
let skippedKind = 0;
let tooSmall = 0;
let dropSurvey = 0;
let withHeight = 0;
const osm: Rec[] = [];
for (const el of raw.elements) {
  const tags = el.tags ?? {};
  const hint = hintOf(tags);
  if (hint === null) {
    skippedKind++;
    continue;
  }
  const rings: number[][] = [];
  if (el.type === "way" && el.geometry) {
    ways++;
    rings.push(toWorld(el.geometry));
  } else if (el.type === "relation" && el.members) {
    rels++;
    for (const m of el.members) {
      if (m.type === "way" && m.role === "outer" && m.geometry) rings.push(toWorld(m.geometry));
    }
  } else {
    continue;
  }
  const height = heightOf(tags);
  for (const flat of rings) {
    const [cx, cz] = centroid(flat);
    if (Math.abs(cx) > WORLD_W / 2 - 4 || Math.abs(cz) > WORLD_H / 2 - 4) {
      offMap++;
      continue;
    }
    if (!onLandXZ(cx, cz)) {
      water++;
      continue;
    }
    const ring = simplify(flat);
    if (ring === null || Math.abs(areaFlat(ring)) < MIN_AREA) {
      tooSmall++;
      continue;
    }
    if (nearSurvey(cx, cz)) {
      dropSurvey++;
      continue;
    }
    if (height > 0) withHeight++;
    osm.push({ ring, height, hint, hero: false, blind: 0 });
  }
}

// --- Stacked OSM rings: a centroid inside a bigger neighbour is a part ---------
const osmHash = new Map<number, number[]>();
for (let i = 0; i < osm.length; i++) {
  const r = osm[i];
  if (!r) continue;
  const [cx, cz] = centroid(r.ring);
  const k = hkey(cx, cz);
  const arr = osmHash.get(k) ?? [];
  arr.push(i);
  osmHash.set(k, arr);
}
let stacked = 0;
const keep: Rec[] = [];
for (let i = 0; i < osm.length; i++) {
  const r = osm[i];
  if (!r) continue;
  const [cx, cz] = centroid(r.ring);
  const area = Math.abs(areaFlat(r.ring));
  const gx = Math.floor((cx + WORLD_W) / CELL);
  const gz = Math.floor((cz + WORLD_H) / CELL);
  let inside = false;
  for (let dx = -2; dx <= 2 && !inside; dx++) {
    for (let dz = -2; dz <= 2 && !inside; dz++) {
      for (const j of osmHash.get((gx + dx) * 4096 + gz + dz) ?? []) {
        if (j === i) continue;
        const o = osm[j];
        if (!o) continue;
        if (Math.abs(areaFlat(o.ring)) > area && pointInRing(o.ring, cx, cz)) {
          inside = true;
          break;
        }
      }
    }
  }
  if (inside) stacked++;
  else keep.push(r);
}

// --- Party walls: coincident edges (OSM shares nodes, so they are exact) -----
const EQ = 50; // 2 cm
const edgeKey = (ax: number, az: number, bx: number, bz: number): string => {
  const a = `${Math.round(ax * EQ)},${Math.round(az * EQ)}`;
  const b = `${Math.round(bx * EQ)},${Math.round(bz * EQ)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
};
const edges = new Map<string, number>();
for (const r of keep) {
  const n = r.ring.length / 2;
  for (let e = 0; e < n; e++) {
    const j = (e + 1) % n;
    const k = edgeKey(
      r.ring[e * 2] ?? 0,
      r.ring[e * 2 + 1] ?? 0,
      r.ring[j * 2] ?? 0,
      r.ring[j * 2 + 1] ?? 0,
    );
    edges.set(k, (edges.get(k) ?? 0) + 1);
  }
}
let partyWalls = 0;
for (const r of keep) {
  const n = r.ring.length / 2;
  for (let e = 0; e < n && e < 32; e++) {
    const j = (e + 1) % n;
    const k = edgeKey(
      r.ring[e * 2] ?? 0,
      r.ring[e * 2 + 1] ?? 0,
      r.ring[j * 2] ?? 0,
      r.ring[j * 2 + 1] ?? 0,
    );
    if ((edges.get(k) ?? 0) > 1) {
      r.blind |= 1 << e;
      partyWalls++;
    }
  }
}

// --- Order spatially (compression + stable ids) and encode --------------------
const all = [...recs, ...keep];
all.sort((a, b) => {
  const [ax, az] = centroid(a.ring);
  const [bx, bz] = centroid(b.ring);
  const ka = Math.floor((az + WORLD_H) / 40) * 1000 + Math.floor((ax + WORLD_W) / 40);
  const kb = Math.floor((bz + WORLD_H) / 40) * 1000 + Math.floor((bx + WORLD_W) / 40);
  return ka - kb || ax - bx;
});
const HINT_CODE = new Map<ParcelHint, number>(PARCEL_HINTS.map((h, i) => [h, i]));
let bytes = 0;
for (const r of all) bytes += 9 + (r.ring.length / 2) * 4;
const buf = new ArrayBuffer(9 + bytes);
const dv = new DataView(buf);
let off = 0;
for (let i = 0; i < 4; i++) dv.setUint8(off++, PARCEL_SOURCE_MAGIC.charCodeAt(i));
dv.setUint8(off++, PARCEL_SOURCE_VERSION);
dv.setUint32(off, all.length, true);
off += 4;
let clampedH = 0;
for (const r of all) {
  const n = r.ring.length / 2;
  dv.setUint8(off++, n);
  dv.setUint8(off++, HINT_CODE.get(r.hint) ?? 0);
  dv.setUint8(off++, r.hero ? 1 : 0);
  let h = Math.round(r.height * 100);
  if (h > 65535) {
    h = 65535;
    clampedH++;
  }
  dv.setUint16(off, h, true);
  off += 2;
  dv.setUint32(off, r.blind >>> 0, true);
  off += 4;
  let px = 0;
  let pz = 0;
  for (let i = 0; i < n; i++) {
    const qx = Math.round((r.ring[i * 2] ?? 0) * Q);
    const qz = Math.round((r.ring[i * 2 + 1] ?? 0) * Q);
    const dx = i === 0 ? qx : qx - px;
    const dz = i === 0 ? qz : qz - pz;
    if (dx > 32767 || dx < -32768 || dz > 32767 || dz < -32768) {
      throw new Error(`delta overflow in parcel ${i}`);
    }
    dv.setInt16(off, dx, true);
    dv.setInt16(off + 2, dz, true);
    off += 4;
    px = qx;
    pz = qz;
  }
}
const gz = gzipSync(new Uint8Array(buf, 0, off), { level: 9 });
writeFileSync(OUT, gz);
const size = statSync(OUT).size;
console.log(
  `[bake-parcels] survey ${surveyCount} (+${surveyStacked} stacked skipped) | osm ways ${ways} rels ${rels}: ` +
    `${keep.length} kept, ${dropSurvey} under the survey, ${stacked} stacked, ${tooSmall} too small, ` +
    `${water} in water, ${offMap} off map, ${skippedKind} skipped kinds; ${withHeight} with a height tag, ` +
    `${partyWalls} party walls` +
    (clampedH ? `, ${clampedH} heights clamped` : ""),
);
{
  const bands = [4, 8, 16, 32, 64, 1e9];
  const counts = bands.map(() => 0);
  for (const r of all) {
    const a = Math.abs(areaFlat(r.ring));
    counts[bands.findIndex((b) => a < b)]++;
  }
  console.log("[bake-parcels] area bands u²  <4 <8 <16 <32 <64 ≥64:", counts.join(" "));
}
console.log(
  `[bake-parcels] ${all.length} parcels, ${off} bytes raw, ${size} bytes gzipped → ${OUT}`,
);
if (size > 3 * 1024 * 1024) {
  console.error("[bake-parcels] STOP: over the 3 MB gzipped budget");
  process.exit(1);
}
