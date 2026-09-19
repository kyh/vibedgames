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
import path from "node:path";

import { onLandXZ, projU, projV, rdp, WORLD_H, WORLD_W } from "./lib.mjs";
import { parcelAt } from "../../src/world/sf-adjacency.ts";
import { SF_FOOTPRINTS } from "../../src/world/sf-footprints.ts";
import {
  PARCEL_HINTS,
  PARCEL_SOURCE_MAGIC,
  PARCEL_SOURCE_VERSION,
} from "../../src/world/parcel-source.ts";
import type { ParcelHint } from "../../src/world/parcel-source.ts";

const HERE = import.meta.dirname;
const RAW = path.join(HERE, "sf-buildings.raw.json");
const OUT = path.join(HERE, "../../public/world/parcels.bin");

/** Metres per world unit (the calibration the survey extractor measured). */
const M_PER_U = 4.46;
const RDP_EPS = 0.12;
const MAX_VERTS = 24;
// Below this a footprint is a rear-yard garage or a shed: real, but 30 m² of
// roof behind a house the player never sees, at the same vertex cost as the
// house. ~2 u² is 40 m².
const MIN_AREA = 2;
/** OSM parcels this close to a survey ring are the survey's. */
const SURVEY_REACH = 1.5;
// int16 units per world unit (5 cm)
const Q = 20;

interface Rec {
  // x0,z0,x1,z1...
  ring: number[];
  // world units, 0 = unknown
  height: number;
  hint: ParcelHint;
  hero: boolean;
  // bitmask over edges e (vertex e -> e+1)
  blind: number;
}

/** Signed area of a flat x,z ring. */
const areaFlat = (ring: readonly number[]): number => {
  const n = ring.length / 2;
  let a = 0;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    a += (ring[i * 2] ?? 0) * (ring[j * 2 + 1] ?? 0) - (ring[j * 2] ?? 0) * (ring[i * 2 + 1] ?? 0);
  }
  return a / 2;
};

const centroid = (ring: readonly number[]): [number, number] => {
  const n = ring.length / 2;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i += 1) {
    cx += ring[i * 2] ?? 0;
    cz += ring[i * 2 + 1] ?? 0;
  }
  return [cx / n, cz / n];
};

const pointInRing = (ring: readonly number[], x: number, z: number): boolean => {
  const n = ring.length / 2;
  let inside = false;
  for (let i = 0; i < n; i += 1) {
    const j = (i + n - 1) % n;
    const xi = ring[i * 2] ?? 0;
    const zi = ring[i * 2 + 1] ?? 0;
    const xj = ring[j * 2] ?? 0;
    const zj = ring[j * 2 + 1] ?? 0;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};

const distToRing = (ring: readonly number[], x: number, z: number): number => {
  const n = ring.length / 2;
  let best = Infinity;
  for (let i = 0; i < n; i += 1) {
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
    if (d < best) {
      best = d;
    }
  }
  return best;
};

/** Height in world units from OSM tags, 0 when neither tag parses. */
const heightOf = (tags: Record<string, string>): number => {
  const h = tags.height ?? tags["building:height"];
  if (h !== undefined) {
    const m = /^\s*(?<value>[\d.]+)\s*(?<unit>m|ft|')?/u.exec(h);
    if (m) {
      let v = Number(m.groups?.value);
      if (m.groups?.unit === "ft" || m.groups?.unit === "'") {
        v *= 0.3048;
      }
      if (Number.isFinite(v) && v > 0) {
        return v / M_PER_U;
      }
    }
  }
  const l = tags["building:levels"];
  if (l !== undefined) {
    const v = Number(l);
    if (Number.isFinite(v) && v > 0) {
      return (v * 3.3) / M_PER_U;
    }
  }
  return 0;
};

const NOT_A_PARCEL = new Set(["carport", "construction", "no", "roof", "ruins"]);

const BUILDING_HINT = new Map<string, ParcelHint>([
  ["apartments", "apartments"],
  ["bungalow", "house"],
  ["cathedral", "public"],
  ["church", "public"],
  ["civic", "public"],
  ["college", "public"],
  ["commercial", "commercial"],
  ["detached", "house"],
  ["dormitory", "apartments"],
  ["garage", "shed"],
  ["garages", "shed"],
  ["government", "public"],
  ["hangar", "industrial"],
  ["hospital", "public"],
  ["hotel", "apartments"],
  ["house", "house"],
  ["hut", "shed"],
  ["industrial", "industrial"],
  ["kiosk", "shed"],
  ["mosque", "public"],
  ["office", "commercial"],
  ["public", "public"],
  ["residential", "house"],
  ["retail", "commercial"],
  ["school", "public"],
  ["semidetached_house", "house"],
  ["service", "industrial"],
  ["shed", "shed"],
  ["supermarket", "commercial"],
  ["synagogue", "public"],
  ["temple", "public"],
  ["terrace", "house"],
  ["university", "public"],
  ["warehouse", "industrial"],
]);

const hintOf = (tags: Record<string, string>): ParcelHint | null => {
  const b = (tags.building ?? "yes").toLowerCase();
  if (NOT_A_PARCEL.has(b)) {
    return null;
  }
  return BUILDING_HINT.get(b) ?? "generic";
};

interface Geom {
  readonly lat: number;
  readonly lon: number;
}
interface Element {
  readonly type: string;
  readonly id: number;
  readonly tags?: Record<string, string>;
  readonly geometry?: readonly Geom[];
  readonly members?: readonly {
    readonly type: string;
    readonly role: string;
    readonly geometry?: readonly Geom[];
  }[];
}

const toWorld = (g: readonly Geom[]): number[] => {
  const pts: [number, number][] = [];
  for (const p of g) {
    const u = projU(p.lon);
    const v = projV(p.lat);
    pts.push([(u - 0.5) * WORLD_W, (v - 0.5) * WORLD_H]);
  }
  // Closed in OSM (first == last) — drop the repeat.
  const [first] = pts;
  const last = pts.at(-1);
  if (
    first &&
    last &&
    pts.length > 1 &&
    Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6
  ) {
    pts.pop();
  }
  return pts.flat();
};

/**
 * RDP on a ring. rdp() is an open-polyline routine and a closed ring hands
 * it a zero-length chord (first == last), so every vertex measures zero and
 * the ring collapses. Split at the vertex farthest from vertex 0, simplify
 * the two open halves, rejoin.
 */
const simplify = (flat: number[]): number[] | null => {
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pts.push([flat[i] ?? 0, flat[i + 1] ?? 0]);
  }
  if (pts.length < 3) {
    return null;
  }
  const p0 = pts[0] ?? [0, 0];
  let far = 1;
  let farD = -1;
  for (let i = 1; i < pts.length; i += 1) {
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
  if (out.length < 3) {
    return null;
  }
  return out.flat();
};

// --- The survey (hero set) --------------------------------------------------
const recs: Rec[] = [];
let surveyStacked = 0;
for (let id = 0; id < SF_FOOTPRINTS.length; id += 1) {
  const flat = SF_FOOTPRINTS[id];
  if (flat === undefined) {
    continue;
  }
  const adj = parcelAt(id);
  if (adj?.stacked === true) {
    surveyStacked += 1;
    continue;
  }
  const ring = flat.slice(1);
  let blind = 0;
  if (adj) {
    for (const e of adj.blind) {
      if (e < 32) {
        // oxlint-disable-next-line no-bitwise -- `blind` is a packed 32-bit edge flag set
        blind |= 1 << e;
      }
    }
  }
  recs.push({ blind, height: flat[0] ?? 0, hero: true, hint: "generic", ring });
}
const surveyCount = recs.length;

// A hash of survey ring VERTICES and EDGE MIDPOINTS for the drop test.
const CELL = 8;
const surveyHash = new Map<number, number[]>();
const hkey = (x: number, z: number): number =>
  Math.floor((x + WORLD_W) / CELL) * 4096 + Math.floor((z + WORLD_H) / CELL);
for (let i = 0; i < surveyCount; i += 1) {
  const r = recs[i];
  if (!r) {
    continue;
  }
  const [cx, cz] = centroid(r.ring);
  const k = hkey(cx, cz);
  const arr = surveyHash.get(k) ?? [];
  arr.push(i);
  surveyHash.set(k, arr);
}
const nearSurvey = (x: number, z: number): boolean => {
  const gx = Math.floor((x + WORLD_W) / CELL);
  const gz = Math.floor((z + WORLD_H) / CELL);
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      for (const i of surveyHash.get((gx + dx) * 4096 + gz + dz) ?? []) {
        const r = recs[i];
        if (!r) {
          continue;
        }
        if (pointInRing(r.ring, x, z) || distToRing(r.ring, x, z) < SURVEY_REACH) {
          return true;
        }
      }
    }
  }
  return false;
};

// --- OSM ---------------------------------------------------------------------
// SAFETY: the file is the Overpass JSON fetch-buildings.sh wrote; its shape is the API's.
const raw = JSON.parse(readFileSync(RAW, "utf-8")) as { elements: Element[] };
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
    skippedKind += 1;
    continue;
  }
  const rings: number[][] = [];
  if (el.type === "way" && el.geometry) {
    ways += 1;
    rings.push(toWorld(el.geometry));
  } else if (el.type === "relation" && el.members) {
    rels += 1;
    for (const m of el.members) {
      if (m.type === "way" && m.role === "outer" && m.geometry) {
        rings.push(toWorld(m.geometry));
      }
    }
  } else {
    continue;
  }
  const height = heightOf(tags);
  for (const flat of rings) {
    const [cx, cz] = centroid(flat);
    if (Math.abs(cx) > WORLD_W / 2 - 4 || Math.abs(cz) > WORLD_H / 2 - 4) {
      offMap += 1;
      continue;
    }
    if (!onLandXZ(cx, cz)) {
      water += 1;
      continue;
    }
    const ring = simplify(flat);
    if (ring === null || Math.abs(areaFlat(ring)) < MIN_AREA) {
      tooSmall += 1;
      continue;
    }
    if (nearSurvey(cx, cz)) {
      dropSurvey += 1;
      continue;
    }
    if (height > 0) {
      withHeight += 1;
    }
    osm.push({ blind: 0, height, hero: false, hint, ring });
  }
}

// --- Stacked OSM rings: a centroid inside a bigger neighbour is a part ---------
const osmHash = new Map<number, number[]>();
for (let i = 0; i < osm.length; i += 1) {
  const r = osm[i];
  if (!r) {
    continue;
  }
  const [cx, cz] = centroid(r.ring);
  const k = hkey(cx, cz);
  const arr = osmHash.get(k) ?? [];
  arr.push(i);
  osmHash.set(k, arr);
}
let stacked = 0;
const keep: Rec[] = [];
for (let i = 0; i < osm.length; i += 1) {
  const r = osm[i];
  if (!r) {
    continue;
  }
  const [cx, cz] = centroid(r.ring);
  const area = Math.abs(areaFlat(r.ring));
  const gx = Math.floor((cx + WORLD_W) / CELL);
  const gz = Math.floor((cz + WORLD_H) / CELL);
  let inside = false;
  for (let dx = -2; dx <= 2 && !inside; dx += 1) {
    for (let dz = -2; dz <= 2 && !inside; dz += 1) {
      for (const j of osmHash.get((gx + dx) * 4096 + gz + dz) ?? []) {
        if (j === i) {
          continue;
        }
        const o = osm[j];
        if (!o) {
          continue;
        }
        if (Math.abs(areaFlat(o.ring)) > area && pointInRing(o.ring, cx, cz)) {
          inside = true;
          break;
        }
      }
    }
  }
  if (inside) {
    stacked += 1;
  } else {
    keep.push(r);
  }
}

// --- Party walls: coincident edges (OSM shares nodes, so they are exact) -----
// 2 cm
const EQ = 50;
const edgeKey = (ax: number, az: number, bx: number, bz: number): string => {
  const a = `${Math.round(ax * EQ)},${Math.round(az * EQ)}`;
  const b = `${Math.round(bx * EQ)},${Math.round(bz * EQ)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
};
const edges = new Map<string, number>();
for (const r of keep) {
  const n = r.ring.length / 2;
  for (let e = 0; e < n; e += 1) {
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
  for (let e = 0; e < n && e < 32; e += 1) {
    const j = (e + 1) % n;
    const k = edgeKey(
      r.ring[e * 2] ?? 0,
      r.ring[e * 2 + 1] ?? 0,
      r.ring[j * 2] ?? 0,
      r.ring[j * 2 + 1] ?? 0,
    );
    if ((edges.get(k) ?? 0) > 1) {
      // oxlint-disable-next-line no-bitwise -- `blind` is a packed 32-bit edge flag set
      r.blind |= 1 << e;
      partyWalls += 1;
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
for (const r of all) {
  bytes += 9 + (r.ring.length / 2) * 4;
}
const buf = new ArrayBuffer(9 + bytes);
const dv = new DataView(buf);
let off = 0;
for (let i = 0; i < 4; i += 1) {
  dv.setUint8(off, PARCEL_SOURCE_MAGIC.codePointAt(i) ?? 0);
  off += 1;
}
dv.setUint8(off, PARCEL_SOURCE_VERSION);
off += 1;
dv.setUint32(off, all.length, true);
off += 4;
let clampedH = 0;
for (const r of all) {
  const n = r.ring.length / 2;
  dv.setUint8(off, n);
  dv.setUint8(off + 1, HINT_CODE.get(r.hint) ?? 0);
  dv.setUint8(off + 2, r.hero ? 1 : 0);
  off += 3;
  let h = Math.round(r.height * 100);
  if (h > 65_535) {
    h = 65_535;
    clampedH += 1;
  }
  dv.setUint16(off, h, true);
  off += 2;
  // oxlint-disable-next-line no-bitwise -- reinterpret the packed flags as unsigned 32-bit
  dv.setUint32(off, r.blind >>> 0, true);
  off += 4;
  let px = 0;
  let pz = 0;
  for (let i = 0; i < n; i += 1) {
    const qx = Math.round((r.ring[i * 2] ?? 0) * Q);
    const qz = Math.round((r.ring[i * 2 + 1] ?? 0) * Q);
    const dx = i === 0 ? qx : qx - px;
    const dz = i === 0 ? qz : qz - pz;
    if (dx > 32_767 || dx < -32_768 || dz > 32_767 || dz < -32_768) {
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
const { size } = statSync(OUT);
console.log(
  `[bake-parcels] survey ${surveyCount} (+${surveyStacked} stacked skipped) | osm ways ${ways} rels ${rels}: ${keep.length} kept, ${dropSurvey} under the survey, ${stacked} stacked, ${tooSmall} too small, ${water} in water, ${offMap} off map, ${skippedKind} skipped kinds; ${withHeight} with a height tag, ${partyWalls} party walls${clampedH ? `, ${clampedH} heights clamped` : ""}`,
);
{
  const bands = [4, 8, 16, 32, 64, 1e9];
  const counts = bands.map(() => 0);
  for (const r of all) {
    const a = Math.abs(areaFlat(r.ring));
    const band = bands.findIndex((b) => a < b);
    counts[band] = (counts[band] ?? 0) + 1;
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
