// Mine GROUND CLASSES, TOWER MASSING and POWER/RAIL infrastructure out of the
// licensed "Downtown San Francisco" OBJ.
//
//   node tools/sf-data/extract-landuse-obj.mjs <path-to-obj> [out.json]
//
// Companion to extract-footprints.mjs, which already mines the same file for
// building footprint rings + heights. That script owns the verified model →
// world transform; this one imports the SAME constants (copied below with the
// same provenance note) and re-asserts the two tower anchors before emitting,
// so the two extractors can never drift apart silently.
//
// WHY: the game's entire ground-class dataset is two bitmasks (GREEN, SAND),
// so 72% of land cells render as one literal colour. The OBJ carries ~50
// distinct `landuse=`/`leisure=`/`amenity=`/`natural=` object groups — real
// OSM area classes — but Cinema 4D TRUNCATED every object name to 10
// characters and resolved collisions by overwriting the tail with a counter
// ("landuse=grass" and "landuse=greenfield" both become "landuse=g<n>"). The
// names alone are therefore undecodable. This script decodes them
// GEOMETRICALLY: every OBJ polygon is matched to an untruncated OSM way by
// centroid + area, and each OBJ group takes the modal tag of its matches.
//
// Inputs, all resolved next to this file:
//   sf-landuse.raw.json  — tracked green-only Overpass dump (./fetch-landuse.sh)
//   sf-osm-tags.raw.json — wider dump incl. residential/commercial/industrial/
//                          amenity/man_made/power (./fetch-osm-tags.sh).
//                          OPTIONAL: without it only green classes decode.
//
// Output is JSON only — a later phase turns it into a TypeScript data module.

import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { onLandUV, plLen, rdp, ringArea, WORLD_H, WORLD_W } from "./lib.mjs";

const objPath = process.argv[2];
const outPath = process.argv[3] ?? new URL("./sf-landuse-obj.json", import.meta.url).pathname;
if (!objPath) {
  console.error("usage: node extract-landuse-obj.mjs <obj> [out.json]");
  process.exit(1);
}

// --- Model → world transform (see extract-footprints.mjs for the fit) -------
// Anchored on Salesforce/Transamerica (model-h / real-m = 1.598 for both),
// hill-climbed against the street mask with INDEPENDENT x/z scales, NO z-flip.
const CAL = { sx: 0.17829, sz: 0.17909, bx: 325.2, bz: -400.5 };
const CAL_SY = 1 / (1.598 * 4.446); // world runs 4.446 m/u
const M_PER_U = 4.446;
const ANCHORS = [
  ["Salesforce", 2458.4, -2088.9, 760.0, -770.1],
  ["Transamerica", 1809.9, -2842.1, 644.9, -907.7],
];
const toWorldX = (x) => x * CAL.sx + CAL.bx;
const toWorldZ = (z) => z * CAL.sz + CAL.bz;
const toU = (wx) => wx / WORLD_W + 0.5;
const toV = (wz) => wz / WORLD_H + 0.5;

// --- lon/lat → world (the game's own OSM projection, from lib.mjs) ----------
// Kept local because lib.mjs exposes it as (u,v) in 0..1 and everything here
// works in world units.
const U_M = 6.2462,
  U_B = 765.2557;
const V_M = -9.6095,
  V_B = 363.344;
const osmX = (lon) => (U_M * lon + U_B - 0.5) * WORLD_W;
const osmZ = (lat) => (V_M * lat + V_B - 0.5) * WORLD_H;

const GRID_X = 244;
const GRID_Z = 200;

// --- Which OBJ objects are what --------------------------------------------
// Object names are truncated garbage, but their PREFIX survives and the
// material is intact. Road ribbons (highway_*, route_*, restriction_*,
// name_<street>_*) all carry usemtl "roads" — that plus a name test is enough
// to isolate the ground-area groups.
const ROADISH_NAME = /^(highway_|route_|restriction_|name_.)/;
const BUILDING_NAME = /^(height=|buildin|builds)/;
// Ground groups that are really thin extruded LINES, not areas.
const STRIPY_NAME = /^(barrier|man_stroke)$/;

const vx = [];
const vy = [];
const vz = [];
/** name|mtl -> number[][] (faces as vertex ids) */
const groups = new Map();
let curName = null;
let curMtl = "";
let objLines = 0;

const rl = createInterface({ input: createReadStream(objPath), crlfDelay: Infinity });
rl.on("line", (l) => {
  const c0 = l.charCodeAt(0);
  if (c0 === 118 /* v */ && l.charCodeAt(1) === 32) {
    let i = 2;
    while (l.charCodeAt(i) === 32) i++;
    const j = l.indexOf(" ", i);
    const k = l.indexOf(" ", j + 1);
    vx.push(Number(l.slice(i, j)));
    vy.push(Number(l.slice(j + 1, k)));
    vz.push(Number(l.slice(k + 1)));
  } else if (c0 === 102 /* f */ && l.charCodeAt(1) === 32) {
    if (!curName) return;
    const key = `${curName}|${curMtl}`;
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
    }
    const ids = [];
    for (const part of l.slice(2).trim().split(/\s+/)) {
      const s = part.indexOf("/") >= 0 ? part.slice(0, part.indexOf("/")) : part;
      let id = Number(s);
      if (id < 0) id = vx.length + 1 + id;
      ids.push(id - 1);
    }
    g.push(ids);
  } else if (c0 === 111 /* o */ && l.charCodeAt(1) === 32) {
    curName = l.slice(2).trim();
    objLines++;
  } else if (l.startsWith("usemtl")) {
    curMtl = l.slice(7).trim();
  }
});

rl.on("close", () => {
  for (const [name, mx, mz, wx, wz] of ANCHORS) {
    const err = Math.hypot(toWorldX(mx) - wx, toWorldZ(mz) - wz);
    console.log(`anchor ${name}: ${err.toFixed(1)}u`);
    if (err > 12) {
      console.error("anchor drift — recheck CAL before emitting");
      process.exit(1);
    }
  }
  console.log(
    `parsed ${vx.length} verts, ${objLines} object decls, ${groups.size} (object,material) buckets`,
  );
  main();
});

// --- Connected components + boundary rings ---------------------------------

/**
 * Split a face soup into welded components (union-find over shared vertex
 * ids), the same split extract-footprints.mjs uses: one OBJ object aggregates
 * every OSM area that shared a tag value, so components ARE the source areas.
 */
function components(faces) {
  const parent = new Map();
  const find = (a) => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(a) !== r) {
      const nxt = parent.get(a);
      parent.set(a, r);
      a = nxt;
    }
    return r;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const f of faces) for (let i = 1; i < f.length; i++) union(f[0], f[i]);
  const out = new Map();
  for (const f of faces) {
    const root = find(f[0]);
    let c = out.get(root);
    if (!c) {
      c = { faces: [], minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, minZ: 1e9, maxZ: -1e9 };
      out.set(root, c);
    }
    c.faces.push(f);
    for (const id of f) {
      const x = vx[id];
      const y = vy[id];
      const z = vz[id];
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      if (z < c.minZ) c.minZ = z;
      if (z > c.maxZ) c.maxZ = z;
    }
  }
  return [...out.values()];
}

/**
 * ALL boundary loops of a component's TOP faces (edges used by exactly one
 * face). Ground areas are single flat planes, so "top faces" is all of them;
 * the filter only matters for the extruded strips (barrier/man_stroke/power),
 * whose side walls would otherwise make the shell watertight and leave no
 * boundary edge at all.
 *
 * Returning ALL loops rather than the largest matters here in a way it did not
 * for extract-footprints: one OBJ object aggregates every OSM area sharing a
 * tag, and the exporter welds areas that touch at a single vertex, so a
 * "component" is routinely a dozen separate parcels. A largest-loop walk threw
 * ~47% of them away.
 */
function topRings(c) {
  // Adaptive epsilon: 0.75 model units is right for a building (tens of units
  // tall) but swallows a 0.5-unit-tall painted strip whole.
  const eps = Math.max(1e-4, Math.min(0.75, (c.maxY - c.minY) * 0.1));
  const top = c.faces.filter((f) => f.every((id) => vy[id] >= c.maxY - eps));
  if (top.length === 0) return [];
  const count = new Map();
  const dir = new Map();
  for (const f of top) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      if (a === b) continue;
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(k, (count.get(k) ?? 0) + 1);
      if (!dir.has(k)) dir.set(k, [a, b]);
    }
  }
  // Multi-map: a pinch vertex shared by two parcels has two outgoing boundary
  // edges, and a single-successor Map silently dropped one of the loops.
  const next = new Map();
  let edges = 0;
  for (const [k, n] of count) {
    if (n !== 1) continue;
    const d = dir.get(k);
    if (!d) continue;
    let l = next.get(d[0]);
    if (!l) {
      l = [];
      next.set(d[0], l);
    }
    l.push(d[1]);
    edges++;
  }
  if (edges < 3) return [];
  // Cycle decomposition, consuming each directed boundary edge exactly once.
  // At a PINCH vertex (two parcels meeting at one welded point) there are two
  // ways out, and taking an arbitrary one splices the two parcels into a
  // self-intersecting bowtie — that is what turned the Western Addition
  // neighbourhood outline into a bogus 2.6 km² "square". Pick the successor by
  // planar face traversal instead: the first edge swept from the reversed
  // incoming direction, which keeps the walk on one side of one face.
  const ang = (a, b) => Math.atan2(vz[b] - vz[a], vx[b] - vx[a]);
  const rings = [];
  for (const start of [...next.keys()]) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const loop = [];
      let prev = -1;
      let cur = start;
      let guard = 0;
      while (guard++ < edges + 2) {
        const outs = next.get(cur);
        if (!outs || outs.length === 0) break;
        let pick = 0;
        if (outs.length > 1 && prev >= 0) {
          const base = ang(cur, prev);
          let bestD = Infinity;
          for (let i = 0; i < outs.length; i++) {
            let d = base - ang(cur, outs[i]);
            while (d <= 1e-9) d += Math.PI * 2;
            while (d > Math.PI * 2) d -= Math.PI * 2;
            if (d < bestD) {
              bestD = d;
              pick = i;
            }
          }
        }
        loop.push(cur);
        prev = cur;
        cur = outs.splice(pick, 1)[0];
        if (cur === start) break;
      }
      if (cur === start && loop.length >= 3)
        rings.push(loop.map((id) => [toWorldX(vx[id]), toWorldZ(vz[id])]));
    }
  }
  return rings;
}

/**
 * Is the ring simple (no self-crossing)? A handful of components are welded
 * n-gon soups whose boundary walk still splices two parcels; those rings have
 * garbage area and must not reach the raster. O(n²), so only run on the small
 * rings — the dense traced outlines are the ones that are never spliced.
 */
function isSimpleRing(r) {
  if (r.length > 120) return true;
  const cross = (p, q, s) => (q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0]);
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    for (let k = i + 2; k < r.length; k++) {
      if (i === 0 && k === r.length - 1) continue;
      const c = r[k];
      const d = r[(k + 1) % r.length];
      if (cross(c, d, a) > 0 !== cross(c, d, b) > 0 && cross(a, b, c) > 0 !== cross(a, b, d) > 0)
        return false;
    }
  }
  return true;
}

const centroidOf = (ring) => {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    const cr = x0 * z1 - x1 * z0;
    a += cr;
    cx += (x0 + x1) * cr;
    cz += (z0 + z1) * cr;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sz = 0;
    for (const [x, z] of ring) {
      sx += x;
      sz += z;
    }
    return [sx / ring.length, sz / ring.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
};

// --- OSM ground truth -------------------------------------------------------

const TAG_KEYS = [
  "landuse",
  "leisure",
  "natural",
  "amenity",
  "tourism",
  "man_made",
  "power",
  "barrier",
  "place",
  "waterway",
  "railway",
];

/** Every OSM way in the dumps, projected to world units, with its full tag. */
function loadOsm() {
  const ways = [];
  const seen = new Set();
  for (const file of ["sf-landuse.raw.json", "sf-osm-tags.raw.json"]) {
    const url = new URL(`./${file}`, import.meta.url);
    if (!existsSync(url)) {
      console.log(`WARN ${file} missing — decode coverage will be reduced`);
      continue;
    }
    const raw = JSON.parse(readFileSync(url, "utf8"));
    let n = 0;
    let rel = 0;
    for (const e of raw.elements ?? []) {
      const key = `${e.type}/${e.id}`;
      if (seen.has(key)) continue;
      const tags = [];
      for (const k of TAG_KEYS) if (e.tags?.[k]) tags.push(`${k}=${e.tags[k]}`);
      if (tags.length === 0) continue;
      // A multipolygon relation's outer members each become their own ring
      // with the relation's tags. Golden Gate Park and the Presidio only exist
      // as relations, so a way-only pull leaves the two biggest green areas in
      // the city unclassified.
      const geoms =
        e.type === "way" && e.geometry?.length >= 2
          ? [e.geometry]
          : e.type === "relation"
            ? (e.members ?? [])
                .filter((m) => m.role !== "inner" && m.geometry?.length >= 3)
                .map((m) => m.geometry)
            : [];
      if (geoms.length === 0) continue;
      seen.add(key);
      if (e.type === "relation") rel++;
      for (const geom of geoms) {
        const ring = geom.map((g) => [osmX(g.lon), osmZ(g.lat)]);
        const closed = ring.length > 3;
        const [cx, cz] = closed ? centroidOf(ring) : ring[Math.floor(ring.length / 2)];
        ways.push({
          id: e.id,
          tags,
          cx,
          cz,
          ring: closed ? ring : null,
          area: closed ? Math.abs(ringArea(ring)) : 0,
          len: plLen(ring),
          name: e.tags?.name ?? null,
        });
        n++;
      }
    }
    console.log(`osm ${file}: ${n} new tagged rings (${rel} from multipolygon relations)`);
  }
  return ways;
}

/** Uniform grid index over OSM way centroids, 64u cells. */
function indexWays(ways) {
  const CELL = 64;
  const map = new Map();
  const key = (gx, gz) => gx * 100000 + gz;
  for (let i = 0; i < ways.length; i++) {
    const gx = Math.floor(ways[i].cx / CELL);
    const gz = Math.floor(ways[i].cz / CELL);
    const k = key(gx, gz);
    let b = map.get(k);
    if (!b) {
      b = [];
      map.set(k, b);
    }
    b.push(i);
  }
  return {
    near(x, z, r) {
      const out = [];
      const g0x = Math.floor((x - r) / CELL);
      const g1x = Math.floor((x + r) / CELL);
      const g0z = Math.floor((z - r) / CELL);
      const g1z = Math.floor((z + r) / CELL);
      for (let gx = g0x; gx <= g1x; gx++)
        for (let gz = g0z; gz <= g1z; gz++) {
          const b = map.get(key(gx, gz));
          if (b) out.push(...b);
        }
      return out;
    },
  };
}

// --- Class taxonomy for the rasterised grid ---------------------------------
// Decoded OSM tag → the ground class the game should actually draw. The rank
// is the raster priority: a cell takes the HIGHEST-ranked class covering it,
// so a pitch inside a park stays a pitch and water beats everything.
const CLASS_OF = {
  "natural=water": ["water", 90],
  "waterway=riverbank": ["water", 90],
  "waterway=dock": ["water", 90],
  "natural=beach": ["sand", 80],
  "natural=sand": ["sand", 80],
  "natural=bare_rock": ["rock", 78],
  "natural=cliff": ["rock", 78],
  "natural=scrub": ["scrub", 42],
  "natural=shrubbery": ["scrub", 42],
  "natural=wood": ["wood", 46],
  "natural=grassland": ["grass", 40],
  "natural=tree_row": ["wood", 46],
  "landuse=forest": ["wood", 46],
  "landuse=grass": ["grass", 40],
  "landuse=meadow": ["grass", 40],
  "landuse=village_green": ["grass", 40],
  "landuse=flowerbed": ["garden", 50],
  "landuse=tree_pit": ["garden", 50],
  "landuse=allotments": ["garden", 50],
  "landuse=cemetery": ["cemetery", 52],
  "landuse=religious": ["cemetery", 52],
  "landuse=recreation_ground": ["recreation", 48],
  "landuse=residential": ["residential", 10],
  "landuse=retail": ["retail", 20],
  "landuse=commercial": ["commercial", 18],
  "landuse=industrial": ["industrial", 24],
  "landuse=brownfield": ["brownfield", 26],
  "landuse=construction": ["construction", 28],
  "landuse=railway": ["railyard", 30],
  "landuse=military": ["military", 32],
  "landuse=port": ["port", 30],
  "leisure=park": ["park", 60],
  "leisure=garden": ["garden", 50],
  "leisure=common": ["park", 60],
  "leisure=dog_park": ["park", 60],
  "leisure=nature_reserve": ["park", 60],
  "leisure=pitch": ["pitch", 70],
  "leisure=track": ["pitch", 70],
  "leisure=playground": ["playground", 72],
  "leisure=swimming_pool": ["water", 90],
  "leisure=golf_course": ["golf", 44],
  "leisure=marina": ["water", 90],
  "leisure=sports_centre": ["recreation", 48],
  "leisure=stadium": ["recreation", 48],
  "leisure=slipway": ["port", 30],
  "leisure=parklet": ["garden", 50],
  "leisure=outdoor_seating": ["plaza", 64],
  "leisure=fitness_station": ["recreation", 48],
  "leisure=bleachers": ["recreation", 48],
  "amenity=parking": ["parking", 34],
  "amenity=parking_space": ["parking", 34],
  "amenity=motorcycle_parking": ["parking", 34],
  "amenity=bicycle_parking": ["parking", 34],
  "amenity=school": ["institution", 14],
  "amenity=university": ["institution", 14],
  "amenity=college": ["institution", 14],
  "amenity=kindergarten": ["institution", 14],
  "amenity=hospital": ["institution", 14],
  "amenity=place_of_worship": ["institution", 14],
  "amenity=fountain": ["plaza", 64],
  "amenity=shelter": ["plaza", 64],
  "place=square": ["plaza", 66],
  "man_made=pier": ["pier", 36],
  "man_made=breakwater": ["pier", 36],
  "man_made=storage_tank": ["industrial", 24],
  "tourism=attraction": ["plaza", 64],
  "tourism=picnic_site": ["park", 60],
};
const classFor = (tag) => CLASS_OF[tag] ?? null;

// Independent cross-check on the geometric decode: the OSM values that COULD
// hide behind each truncated name. C4D kept 10 characters and, when two
// objects collided at that length, overwrote the tail with a counter — so
// "landuse=g1" means "a landuse=g?? that was not the only landuse=g??", and
// the surviving letters are all the name evidence there is. Where the
// geometric verdict is not in this list, the verdict is suspect.
const NAME_HINTS = {
  "landuse=al": ["allotments"],
  "landuse=br": ["brownfield"],
  "landuse=c*": ["commercial", "construction", "cemetery", "churchyard"],
  "landuse=ch": ["churchyard"],
  "landuse=co": ["commercial", "construction"],
  "landuse=g*": ["grass", "greenfield", "garages", "greenhouse_horticulture"],
  "landuse=ga": ["garages"],
  "landuse=i*": ["industrial", "institutional"],
  "landuse=in": ["industrial", "institutional"],
  "landuse=me": ["meadow"],
  "landuse=mi": ["military"],
  "landuse=po": ["port", "pond"],
  "landuse=r*": ["residential", "retail", "religious", "railway", "recreation_ground"],
  "landuse=ra": ["railway"],
  "landuse=wa": ["wasteland", "water"],
  "leisure=b*": ["bleachers", "beach_resort"],
  "leisure=c*": ["common"],
  "leisure=do": ["dog_park"],
  "leisure=fi": ["fitness_station", "fitness_centre"],
  "leisure=ga": ["garden"],
  "leisure=go": ["golf_course"],
  "leisure=ma": ["marina", "maze"],
  "leisure=mi": ["miniature_golf"],
  "leisure=ou": ["outdoor_seating"],
  "leisure=p*": ["park", "pitch", "playground", "parklet", "picnic_table"],
  "leisure=pl": ["playground"],
  "leisure=PO": ["POPS"],
  "leisure=pr": ["practice_pitch"],
  "leisure=s*": ["swimming_pool", "sports_centre", "slipway", "stadium"],
  "leisure=sl": ["slipway"],
  "leisure=sp": ["sports_centre"],
};
/** Candidate OSM values for a truncated object name, if the name says anything. */
function nameHint(objName) {
  const m = /^(landuse|leisure)=(..)$/.exec(objName);
  if (!m) return null;
  const [, key, suf] = m;
  // A trailing digit is C4D's collision counter, so only the first letter is
  // real evidence.
  const wild = /\d$/.test(suf) ? `${key}=${suf[0]}*` : `${key}=${suf}`;
  return NAME_HINTS[wild] ? { pattern: wild, candidates: NAME_HINTS[wild] } : null;
}

// --- Main -------------------------------------------------------------------

function main() {
  const ways = loadOsm();
  const idx = indexWays(ways);

  // ===== 1. GROUND POLYGONS ================================================
  const groundBuckets = [];
  for (const [key, faces] of groups) {
    const [name, mtl] = key.split("|");
    if (name === "base" || name === "railway" || name === "power") continue;
    if (BUILDING_NAME.test(name) || ROADISH_NAME.test(name)) continue;
    if (mtl === "roads") continue;
    groundBuckets.push({ key, name, mtl, faces });
  }

  const polys = []; // { group, ring, cx, cz, area, strip }
  let comps = 0;
  let ringFail = 0;
  for (const b of groundBuckets) {
    for (const c of components(b.faces)) {
      comps++;
      const rings = topRings(c);
      if (rings.length === 0) {
        ringFail++;
        continue;
      }
      for (const ring of rings) {
        let r = rdp(ring, 0.4);
        if (r.length < 3) continue;
        if (ringArea(r) < 0) r = r.reverse(); // normalise CCW
        const area = Math.abs(ringArea(r));
        if (area < 0.4) continue; // < ~8 m² — exporter sliver
        const per = plLen([...r, r[0]]);
        const [cx, cz] = centroidOf(r);
        polys.push({
          group: b.key,
          name: b.name,
          ring: r,
          cx,
          cz,
          area,
          // Compactness 4πA/P²: ~1 for a disc, ~0 for a fence line.
          compact: per > 0 ? (4 * Math.PI * area) / (per * per) : 0,
          strip: STRIPY_NAME.test(b.name),
          simple: isSimpleRing(r),
          y: c.maxY * CAL_SY,
        });
      }
    }
  }
  const nonSimple = polys.filter((p) => !p.simple).length;
  console.log(
    `ground: ${groundBuckets.length} buckets, ${comps} welded components -> ${polys.length} rings ` +
      `(${ringFail} components yielded no boundary loop; ${nonSimple} rings self-intersect and are ` +
      `kept out of the raster)`,
  );

  // --- Decode: match each polygon to an untruncated OSM way ---------------
  // Two passes: the first measures the systematic offset between the OBJ's
  // hill-climbed CAL and the game's lon/lat projection, the second re-matches
  // with that offset removed. Both are reported.
  const match = (p, dx, dz, radius) => {
    const x = p.cx - dx;
    const z = p.cz - dz;
    let best = null;
    let bestScore = Infinity;
    for (const i of idx.near(x, z, radius)) {
      const w = ways[i];
      const d = Math.hypot(w.cx - x, w.cz - z);
      if (d > radius) continue;
      // Area agreement matters as much as position: SF stacks a pitch, a
      // garden and a park on the same centroid.
      const ratio =
        p.area > 1 && w.area > 1
          ? Math.abs(Math.log(w.area / p.area))
          : w.area > 1 || p.area > 1
            ? 1.5
            : 0;
      // Hard veto on wildly mismatched areas. Without it a 1.7 km² Port of San
      // Francisco ring happily "matched" a 500 m² pier that happened to sit
      // near its centroid.
      if (p.area > 200 && w.area > 200 && ratio > 0.7) continue;
      if (p.area > 2000 !== w.area > 2000) continue;
      const score = d / radius + ratio;
      if (score < bestScore) {
        bestScore = score;
        best = w;
      }
    }
    return bestScore < 1.2 ? best : null;
  };

  let dx = 0;
  let dz = 0;
  for (let pass = 0; pass < 2; pass++) {
    const ex = [];
    const ez = [];
    for (const p of polys) {
      const w = match(p, dx, dz, 45);
      if (!w) continue;
      ex.push(p.cx - dx - w.cx);
      ez.push(p.cz - dz - w.cz);
    }
    if (ex.length < 20) break;
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    dx += med(ex);
    dz += med(ez);
  }
  console.log(
    `OBJ↔OSM systematic offset: dx=${dx.toFixed(2)}u dz=${dz.toFixed(2)}u ` +
      `(${(Math.hypot(dx, dz) * M_PER_U).toFixed(1)} m) — removed before matching`,
  );

  let matched = 0;
  for (const p of polys) {
    const w = match(p, dx, dz, 45);
    if (w) {
      matched++;
      p.tags = w.tags;
      p.osmName = w.name;
      p.dist = Math.hypot(p.cx - dx - w.cx, p.cz - dz - w.cz);
    }
  }
  console.log(
    `decode: ${matched}/${polys.length} polygons matched an OSM way (${((matched / polys.length) * 100).toFixed(1)}%)`,
  );

  // --- Vote per OBJ group ---------------------------------------------------
  const groupInfo = new Map();
  for (const p of polys) {
    let g = groupInfo.get(p.group);
    if (!g) {
      g = { group: p.group, polys: 0, matched: 0, votes: new Map(), area: 0 };
      groupInfo.set(p.group, g);
    }
    g.polys++;
    g.area += p.area;
    if (!p.tags) continue;
    g.matched++;
    for (const t of p.tags) g.votes.set(t, (g.votes.get(t) ?? 0) + 1);
  }
  const decoded = [];
  for (const g of groupInfo.values()) {
    const ranked = [...g.votes.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    // Confidence = the winner's share of matched polygons in the group.
    const conf = top ? top[1] / Math.max(1, g.matched) : 0;
    const hint = nameHint(g.group.split("|")[0]);
    decoded.push({
      group: g.group,
      nameHint: hint?.candidates ?? null,
      // Does the truncated name agree with the geometry? A false here means
      // one of the two is wrong; take the geometry and flag it.
      hintAgrees: hint ? hint.candidates.some((c) => top?.[0]?.endsWith(`=${c}`)) : null,
      polygons: g.polys,
      matched: g.matched,
      matchRate: +(g.matched / g.polys).toFixed(3),
      areaU2: Math.round(g.area),
      decoded: top?.[0] ?? null,
      confidence: +conf.toFixed(3),
      // A single verdict is a lie for the mixed groups. The full tag spectrum
      // is what the emit phase should read.
      tagSpectrum: ranked.slice(0, 8).map(([t, n]) => `${t} x${n}`),
      runnersUp: ranked.slice(1, 5).map(([t, n]) => `${t} x${n}`),
    });
  }
  decoded.sort((a, b) => b.areaU2 - a.areaU2);

  // Per-polygon class: its own matched tag first, else its group's verdict.
  // The group vote is only a fallback — several OBJ objects genuinely mix
  // classes (the exporter merged whatever shared a 10-char name), so trusting
  // the vote over the polygon's own match would smear them.
  const groupVerdict = new Map(
    // Only trust a group vote that is actually a majority. Half these objects
    // are a bag of unrelated OSM areas that happened to share ten characters.
    decoded.filter((d) => d.confidence >= 0.5).map((d) => [d.group, d.decoded]),
  );
  for (const p of polys) {
    const own = p.tags?.map((t) => classFor(t)).find(Boolean);
    const grp = classFor(groupVerdict.get(p.group) ?? "");
    const cls = own ?? grp;
    p.cls = cls?.[0] ?? null;
    p.rank = cls?.[1] ?? 0;
    p.tag = p.tags?.find((t) => classFor(t)) ?? groupVerdict.get(p.group) ?? null;
    p.fromGroupVote = !own && !!grp;
  }

  // DISTRICT rings, not ground classes. Anything over 20,000u² (0.4 km²) is
  // bigger than every real parcel in this OBJ's footprint — the largest true
  // ground area is Fort Mason at 13,400u² — so a ring that size is an
  // administrative / neighbourhood outline (the `boundary` and `name` objects
  // carry several). They are reported separately and kept OUT of the raster,
  // where they would otherwise repaint whole quadrants.
  const DISTRICT_MIN = 20000;
  const districts = polys
    .filter((p) => p.area >= DISTRICT_MIN || p.name === "boundary")
    .map((p) => ({
      group: p.group,
      // Own match only — a group vote is meaningless at this size and would
      // stamp "hospital" on a 6.8 km² administrative ring.
      tag: p.tags?.[0] ?? null,
      matchedOsm: !!p.tags,
      name: p.osmName ?? null,
      areaU2: Math.round(p.area),
      areaKm2: +((p.area * M_PER_U * M_PER_U) / 1e6).toFixed(2),
      u: +toU(p.cx).toFixed(4),
      v: +toV(p.cz).toFixed(4),
      ring: p.ring.flatMap(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]),
    }))
    .sort((a, b) => b.areaU2 - a.areaU2);
  for (const p of polys) if (p.area >= DISTRICT_MIN || p.name === "boundary") p.cls = null;

  // ===== 2. MASSING ========================================================
  const massing = analyseMassing();

  // ===== 3. POWER + RAIL ===================================================
  const infra = analyseInfra(ways, idx, dx, dz);

  // ===== 4. GRID HISTOGRAM =================================================
  // Strips (fences, kerbs, pier edges) never claim a cell — they are lines.
  const objInput = polys
    .filter((p) => p.cls && p.simple && !p.strip && p.compact >= 0.12)
    .map((p) => ({ ring: p.ring, cls: p.cls }));
  const objGrid = rasteriseAreas(objInput, 0.06);

  // Honesty check: how much of the same raster do we get from a straight
  // Overpass pull, with no OBJ involved? The OBJ's ground layer turns out to
  // be the THINNER of the two — its value is the massing, not the classes —
  // so the shipped raster should be the union, OSM first.
  const osmInput = [];
  for (const w of ways) {
    if (!w.ring) continue;
    const cls = w.tags.map((t) => classFor(t)).find(Boolean);
    // Same district guard: OSM carries protected-area and neighbourhood rings.
    if (cls && w.area < 20000) osmInput.push({ ring: w.ring, cls: cls[0] });
  }
  const osmGrid = rasteriseAreas(osmInput, 0.06);
  const grid = {
    gridX: GRID_X,
    gridZ: GRID_Z,
    note: "Union of the OBJ-decoded polygons and the Overpass pull. THIS is the raster the game should ship.",
    ...rasteriseAreas([...osmInput, ...objInput], 0.06),
  };
  // Coverage split by the OBJ's own footprint. The licensed model only covers
  // the north-east quadrant, which is where the game is driven — worth knowing
  // whether the classes land there or out in the avenues.
  const OBJ_BOX = { u0: 0.43, u1: 0.89, v0: -0.07, v1: 0.49 };
  let inBox = 0;
  let inBoxCls = 0;
  let outBox = 0;
  let outBoxCls = 0;
  let land = 0;
  let landCls = 0;
  for (let gx = 0; gx < GRID_X; gx++)
    for (let gz = 0; gz < GRID_Z; gz++) {
      const u = (gx + 0.5) / GRID_X;
      const v = (gz + 0.5) / GRID_Z;
      const has = parseInt(grid.cols[gx].substr(gz * 2, 2), 16) > 0;
      // Land is the honest denominator — over a third of the rectangle is bay.
      if (onLandUV(u, v)) {
        land++;
        if (has) landCls++;
      }
      if (u >= OBJ_BOX.u0 && u <= OBJ_BOX.u1 && v >= OBJ_BOX.v0 && v <= OBJ_BOX.v1) {
        inBox++;
        if (has) inBoxCls++;
      } else {
        outBox++;
        if (has) outBoxCls++;
      }
    }
  const coverage = {
    objFootprint: OBJ_BOX,
    landCells: { cells: land, classified: landCls, pct: +((landCls / land) * 100).toFixed(1) },
    insideObjFootprint: {
      cells: inBox,
      classified: inBoxCls,
      pct: +((inBoxCls / inBox) * 100).toFixed(1),
    },
    outsideObjFootprint: {
      cells: outBox,
      classified: outBoxCls,
      pct: +((outBoxCls / outBox) * 100).toFixed(1),
    },
  };
  console.log(
    `raster: OBJ polygons alone classify ${objGrid.classified}/48800 cells; ` +
      `a straight Overpass pull classifies ${osmGrid.classified}/48800; ` +
      `union ${grid.classified}/48800 (${((grid.classified / 48800) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  LAND cells only: ${landCls}/${land} (${coverage.landCells.pct}%). ` +
      `Inside the OBJ footprint (u ${OBJ_BOX.u0}-${OBJ_BOX.u1}, v ${OBJ_BOX.v0}-${OBJ_BOX.v1}): ` +
      `${inBoxCls}/${inBox} (${coverage.insideObjFootprint.pct}%); outside: ${outBoxCls}/${outBox} ` +
      `(${coverage.outsideObjFootprint.pct}%)`,
  );

  // ===== EMIT ==============================================================
  const emitPolys = polys
    .filter((p) => p.cls || p.strip)
    .map((p) => ({
      cls: p.cls,
      tag: p.tag,
      grp: p.group,
      name: p.osmName ?? undefined,
      a: Math.round(p.area),
      strip: p.strip || p.compact < 0.12 ? 1 : undefined,
      selfIntersects: p.simple ? undefined : 1,
      r: p.ring.flatMap(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]),
    }));

  const out = {
    meta: {
      source: objPath,
      generator: "tools/sf-data/extract-landuse-obj.mjs",
      cal: CAL,
      calSY: CAL_SY,
      metresPerUnit: M_PER_U,
      world: { w: WORLD_W, h: WORLD_H, gridX: GRID_X, gridZ: GRID_Z },
      objVerts: vx.length,
      objObjects: objLines,
      objBuckets: groups.size,
      osmOffset: { dx: +dx.toFixed(2), dz: +dz.toFixed(2) },
      note: "u = x/3172+0.5, v = z/2600+0.5. Lower v = north.",
    },
    landuse: {
      groups: decoded,
      districts,
      polygonCount: emitPolys.length,
      polygons: emitPolys,
    },
    massing,
    infrastructure: infra,
    grid: { ...grid, coverage },
    objOnlyGrid: {
      note: "OBJ-decoded polygons only — what the licensed model can supply on its own.",
      classes: objGrid.classes,
      histogram: objGrid.histogram,
      classified: objGrid.classified,
    },
    osmGrid: {
      note: "Same rasteriser, fed straight from the Overpass dumps instead of the OBJ — the coverage baseline the OBJ layer has to beat, and loses to.",
      classes: osmGrid.classes,
      histogram: osmGrid.histogram,
      classified: osmGrid.classified,
    },
    renderPlan: RENDER_PLAN,
  };
  writeFileSync(outPath, JSON.stringify(out));
  console.log(`wrote ${outPath} (${(JSON.stringify(out).length / 1e6).toFixed(2)} MB)`);

  // --- Console report -------------------------------------------------------
  console.log("\n=== DECODED GROUPS (by total area) ===");
  for (const d of decoded.slice(0, 60)) {
    console.log(
      `${d.group.padEnd(24)} n=${String(d.polygons).padStart(5)} ` +
        `match=${String(Math.round(d.matchRate * 100)).padStart(3)}% ` +
        `area=${String(d.areaU2).padStart(8)}u² -> ${String(d.decoded).padEnd(28)} ` +
        `conf=${d.confidence.toFixed(2)} ` +
        `${d.hintAgrees === false ? `NAME-HINT DISAGREES (${d.nameHint.join("|")}) ` : ""}` +
        `${d.runnersUp.slice(0, 2).join(", ")}`,
    );
  }
  console.log("\n=== DISTRICT RINGS (>0.4 km² — kept OUT of the raster) ===");
  for (const d of districts)
    console.log(
      `${String(d.name ?? d.tag ?? "(no OSM match)").padEnd(28)} ${String(d.areaKm2).padStart(6)} km²  ` +
        `u=${d.u} v=${d.v}  from ${d.group}`,
    );
  console.log("\n=== GRID CLASS HISTOGRAM (244x200 = 48800 cells) ===");
  const objH = new Map(objGrid.histogram);
  const osmH = new Map(osmGrid.histogram);
  const unionH = new Map(grid.histogram);
  for (const [cls, n] of grid.histogram)
    console.log(
      `${cls.padEnd(14)} union ${String(n).padStart(6)} (${((n / 48800) * 100).toFixed(2)}%)` +
        `   obj ${String(objH.get(cls) ?? 0).padStart(6)}   osm ${String(osmH.get(cls) ?? 0).padStart(6)}`,
    );
  for (const [cls, n] of osmGrid.histogram)
    if (!unionH.has(cls)) console.log(`${cls.padEnd(14)} union      0   obj      0   osm ${n}`);
  console.log("\n=== MASSING ===");
  console.log(massing.summary.join("\n"));
  console.log("\n=== INFRASTRUCTURE ===");
  console.log(infra.summary.join("\n"));
}

// --- 2. Tower massing -------------------------------------------------------

/**
 * Per-component height + vertical TIER profile of every building-material
 * component. The question the game needs answered: are these single extruded
 * prisms (one base level, one top level) or do they carry podium/setback
 * structure (three or more distinct vertex levels, with the upper level's
 * footprint narrower than the base)?
 */
function analyseMassing() {
  const comps = [];
  for (const [key, faces] of groups) {
    const [name, mtl] = key.split("|");
    if (mtl !== "building" || !BUILDING_NAME.test(name)) continue;
    for (const c of components(faces)) {
      const w = (c.maxX - c.minX) * CAL.sx;
      const d = (c.maxZ - c.minZ) * CAL.sz;
      if (w < 3 * CAL.sx || d < 3 * CAL.sz) continue;
      if (w > 900 * CAL.sx || d > 900 * CAL.sz) continue;
      // Distinct vertex LEVELS. Bin at 0.5 model units (~0.31 m real, well
      // under any real floor-to-floor) so a level is a genuine plane, not
      // float noise.
      const lv = new Map();
      for (const f of c.faces)
        for (const id of f) {
          const b = Math.round(vy[id] * 2) / 2;
          let e = lv.get(b);
          if (!e) {
            e = { n: 0, minX: 1e9, maxX: -1e9, minZ: 1e9, maxZ: -1e9 };
            lv.set(b, e);
          }
          e.n++;
          if (vx[id] < e.minX) e.minX = vx[id];
          if (vx[id] > e.maxX) e.maxX = vx[id];
          if (vz[id] < e.minZ) e.minZ = vz[id];
          if (vz[id] > e.maxZ) e.maxZ = vz[id];
        }
      const levels = [...lv.entries()]
        .filter(([, e]) => e.n >= 3)
        .sort((a, b) => a[0] - b[0])
        .map(([y, e]) => ({
          h: +((y - c.minY) * CAL_SY).toFixed(2),
          n: e.n,
          area: +((e.maxX - e.minX) * CAL.sx * ((e.maxZ - e.minZ) * CAL.sz)).toFixed(1),
        }));
      // Per-level bbox is noisy (one level may hold only a mullion ring), so
      // the podium/setback verdict uses QUARTILE bands instead: the plan
      // extent of everything in the bottom quarter vs the top quarter of the
      // component's height. 1.0 = a straight prism, <1 = it tapers.
      const ext = c.maxY - c.minY;
      const band = (lo, hi) => {
        let x0 = 1e9;
        let x1 = -1e9;
        let z0 = 1e9;
        let z1 = -1e9;
        let n = 0;
        for (const f of c.faces)
          for (const id of f) {
            const t = ext > 0 ? (vy[id] - c.minY) / ext : 0;
            if (t < lo || t > hi) continue;
            n++;
            if (vx[id] < x0) x0 = vx[id];
            if (vx[id] > x1) x1 = vx[id];
            if (vz[id] < z0) z0 = vz[id];
            if (vz[id] > z1) z1 = vz[id];
          }
        return n === 0 ? 0 : (x1 - x0) * CAL.sx * ((z1 - z0) * CAL.sz);
      };
      const lowA = band(0, 0.25);
      const highA = band(0.75, 1);
      comps.push({
        taper: lowA > 0 ? +(highA / lowA).toFixed(3) : 1,
        group: key,
        x: +((c.minX + c.maxX) / 2).toFixed(1),
        z: +((c.minZ + c.maxZ) / 2).toFixed(1),
        wx: +toWorldX((c.minX + c.maxX) / 2).toFixed(1),
        wz: +toWorldZ((c.minZ + c.maxZ) / 2).toFixed(1),
        h: +((c.maxY - c.minY) * CAL_SY).toFixed(2),
        base: +(c.minY * CAL_SY).toFixed(2),
        bboxArea: +(w * d).toFixed(1),
        levels,
      });
    }
  }
  comps.sort((a, b) => b.h - a.h);

  const hs = comps.map((c) => c.h).sort((a, b) => a - b);
  const q = (t) => hs[Math.min(hs.length - 1, Math.floor(hs.length * t))];
  // Height histogram in 1u (4.45 m) buckets.
  const hist = new Map();
  for (const h of hs) hist.set(Math.floor(h), (hist.get(Math.floor(h)) ?? 0) + 1);
  const histogram = [...hist.entries()].sort((a, b) => a[0] - b[0]);

  // Distinct heights: the model quantises to the OSM height tag, so this
  // counts how many DISTINCT tag values the city actually carries.
  const distinct = new Set(hs.map((h) => h.toFixed(2)));

  // Height bands, because the answer differs completely between the low
  // fabric and the towers.
  const BANDS = [
    ["<1u  (<4.4m)", (c) => c.h < 1],
    ["1-2u (4-9m)", (c) => c.h >= 1 && c.h < 2],
    ["2-4u (9-18m)", (c) => c.h >= 2 && c.h < 4],
    ["4-9u (18-40m)", (c) => c.h >= 4 && c.h < 9],
    ["9-20u (40-89m)", (c) => c.h >= 9 && c.h < 20],
    ["20-40u (89-178m)", (c) => c.h >= 20 && c.h < 40],
    [">=40u (>=178m)", (c) => c.h >= 40],
  ];
  const bandStats = BANDS.map(([label, test]) => {
    const set = comps.filter(test);
    const prisms = set.filter((c) => c.levels.length <= 2).length;
    const tapered = set.filter((c) => c.taper < 0.8).length;
    const taperSorted = set.map((c) => c.taper).sort((a, b) => a - b);
    const medTaper = set.length ? taperSorted[Math.floor(set.length / 2)].toFixed(2) : "-";
    return {
      band: label,
      n: set.length,
      pctOfCity: +((set.length / comps.length) * 100).toFixed(2),
      flatPrisms: prisms,
      flatPrismPct: set.length ? +((prisms / set.length) * 100).toFixed(1) : 0,
      taperedBelow80pct: tapered,
      medianTaper: +medTaper,
    };
  });

  const tiers = { 2: 0, 3: 0, 4: 0, "5+": 0 };
  const setbacks = [];
  for (const c of comps) {
    const n = c.levels.length;
    if (n <= 2) tiers[2]++;
    else if (n === 3) tiers[3]++;
    else if (n === 4) tiers[4]++;
    else tiers["5+"]++;
    if (n >= 3 && c.taper < 0.8) setbacks.push(c);
  }

  // The 20 heights the city actually repeats — the real "tier" set the game
  // is trying to approximate with its 3-way pool pick.
  const hCount = new Map();
  for (const c of comps) hCount.set(c.h, (hCount.get(c.h) ?? 0) + 1);
  const modalHeights = [...hCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([h, n]) => ({ h, m: +(h * M_PER_U).toFixed(1), n }));

  // Tall = the pool the game currently collapses into 3 kit picks at 9u / 28u.
  const tall = comps.filter((c) => c.h >= 9);
  const towers = comps.filter((c) => c.h >= 20);

  // Cluster the tall ones spatially to describe the downtown skyline shape.
  const fidi = towers.filter((c) => {
    const u = toU(c.wx);
    const v = toV(c.wz);
    return u > 0.66 && u < 0.8 && v > 0.12 && v < 0.27;
  });

  const summary = [
    `components: ${comps.length}`,
    `height (world u, 1u = ${M_PER_U} m): min ${hs[0].toFixed(2)} p25 ${q(0.25).toFixed(2)} p50 ${q(0.5).toFixed(2)} p75 ${q(0.75).toFixed(2)} p90 ${q(0.9).toFixed(2)} p99 ${q(0.99).toFixed(2)} max ${hs[hs.length - 1].toFixed(2)}`,
    `distinct height values: ${distinct.size} — the model carries the OSM height/levels tag, so heights are QUANTISED. Top 5 repeats: ${modalHeights
      .slice(0, 5)
      .map((x) => `${x.h}u x${x.n}`)
      .join(", ")}`,
    `>=9u (game's mid tier): ${tall.length}   >=20u: ${towers.length}   >=28u (game's tall tier): ${comps.filter((c) => c.h >= 28).length}   >=45u: ${comps.filter((c) => c.h >= 45).length}`,
    `vertical levels per component: 2 -> ${tiers[2]}, 3 -> ${tiers[3]}, 4 -> ${tiers[4]}, 5+ -> ${tiers["5+"]}`,
    `TAPER (plan extent of the top quarter / the bottom quarter of a component):`,
    ...bandStats.map(
      (b) =>
        `  ${b.band.padEnd(18)} n=${String(b.n).padStart(6)} (${String(b.pctOfCity).padStart(5)}%)  ` +
        `flat 2-level prisms ${String(b.flatPrismPct).padStart(5)}%  median taper ${b.medianTaper}  ` +
        `tapered <0.8: ${b.taperedBelow80pct}`,
    ),
    `components with 3+ levels AND taper < 0.8 (a real podium/setback): ${setbacks.length} (${((setbacks.length / comps.length) * 100).toFixed(2)}%)`,
    `FiDi cluster (u .66-.80, v .12-.27), h>=20u: ${fidi.length} towers`,
  ];

  return {
    summary,
    componentCount: comps.length,
    bandStats,
    modalHeights,
    heightQuantiles: {
      min: hs[0],
      p10: q(0.1),
      p25: q(0.25),
      p50: q(0.5),
      p75: q(0.75),
      p90: q(0.9),
      p99: q(0.99),
      max: hs[hs.length - 1],
    },
    distinctHeightValues: distinct.size,
    heightHistogram: histogram,
    levelHistogram: tiers,
    setbackCount: setbacks.length,
    setbackSamples: setbacks
      .sort((a, b) => b.h - a.h)
      .slice(0, 40)
      .map((c) => ({
        wx: c.wx,
        wz: c.wz,
        u: +toU(c.wx).toFixed(4),
        v: +toV(c.wz).toFixed(4),
        h: c.h,
        taper: c.taper,
        levels: c.levels,
      })),
    tallest: comps.slice(0, 150).map((c) => ({
      wx: c.wx,
      wz: c.wz,
      u: +toU(c.wx).toFixed(4),
      v: +toV(c.wz).toFixed(4),
      h: c.h,
      m: +(c.h * M_PER_U).toFixed(0),
      bboxArea: c.bboxArea,
      levels: c.levels.length,
      taper: c.taper,
      group: c.group,
    })),
    fidiCluster: {
      note: "h>=20u components inside u .66-.80 / v .12-.27. [u, v, height(u), taper, bboxArea(u²)]",
      count: fidi.length,
      towers: fidi
        .sort((a, b) => b.h - a.h)
        .map((c) => [
          +toU(c.wx).toFixed(4),
          +toV(c.wz).toFixed(4),
          c.h,
          c.taper,
          Math.round(c.bboxArea),
        ]),
    },
  };
}

// --- 3. Power + rail --------------------------------------------------------

/**
 * The `power` and `railway` objects. Both are drawn as flat ribbons, so a
 * component is either a LINE (long, thin) or an AREA (a substation / yard).
 */
function analyseInfra(ways, idx, dx, dz) {
  const out = { summary: [] };
  for (const which of ["power", "railway"]) {
    const buckets = [...groups.entries()].filter(([k]) => k.split("|")[0] === which);
    const items = [];
    for (const [key, faces] of buckets) {
      for (const c of components(faces)) {
        // Largest loop is the right choice here: an infrastructure component
        // is one line or one yard, and the inner loops are just holes.
        const ring = topRings(c).sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)))[0];
        const w = (c.maxX - c.minX) * CAL.sx;
        const d = (c.maxZ - c.minZ) * CAL.sz;
        const span = Math.max(w, d);
        const thin = Math.min(w, d);
        const r = ring ? rdp(ring, 0.5) : null;
        const area = r ? Math.abs(ringArea(r)) : 0;
        const per = r ? plLen([...r, r[0]]) : 0;
        const compact = per > 0 ? (4 * Math.PI * area) / (per * per) : 0;
        // Decode against OSM.
        let tag = null;
        let nm = null;
        if (r) {
          const [cx, cz] = centroidOf(r);
          let best = null;
          let bd = 60;
          for (const i of idx.near(cx - dx, cz - dz, 60)) {
            const wobj = ways[i];
            if (!wobj.tags.some((t) => t.startsWith(`${which}=`))) continue;
            const dd = Math.hypot(wobj.cx - (cx - dx), wobj.cz - (cz - dz));
            if (dd < bd) {
              bd = dd;
              best = wobj;
            }
          }
          if (best) {
            tag = best.tags.find((t) => t.startsWith(`${which}=`)) ?? null;
            nm = best.name;
          }
        }
        items.push({
          key,
          span: +span.toFixed(1),
          thin: +thin.toFixed(1),
          area: +area.toFixed(1),
          compact: +compact.toFixed(3),
          yMin: +(c.minY * CAL_SY).toFixed(2),
          yMax: +(c.maxY * CAL_SY).toFixed(2),
          wx: +toWorldX((c.minX + c.maxX) / 2).toFixed(1),
          wz: +toWorldZ((c.minZ + c.maxZ) / 2).toFixed(1),
          u: +toU(toWorldX((c.minX + c.maxX) / 2)).toFixed(4),
          v: +toV(toWorldZ((c.minZ + c.maxZ) / 2)).toFixed(4),
          tag,
          name: nm,
          ring: r
            ? r.flatMap(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10])
            : null,
        });
      }
    }
    const lines = items.filter((i) => i.compact < 0.15 && i.span > 8);
    const areas = items.filter((i) => !(i.compact < 0.15 && i.span > 8));
    const tagHist = new Map();
    for (const i of items) if (i.tag) tagHist.set(i.tag, (tagHist.get(i.tag) ?? 0) + 1);
    const yMin = Math.min(...items.map((i) => i.yMin));
    const yMax = Math.max(...items.map((i) => i.yMax));
    out[which] = {
      components: items.length,
      lineLike: lines.length,
      areaLike: areas.length,
      totalLineSpanU: +lines.reduce((s, i) => s + i.span, 0).toFixed(0),
      totalAreaU2: +areas.reduce((s, i) => s + i.area, 0).toFixed(0),
      yRangeU: [yMin, yMax],
      yRangeM: [+(yMin * M_PER_U).toFixed(1), +(yMax * M_PER_U).toFixed(1)],
      osmTags: [...tagHist.entries()].sort((a, b) => b[1] - a[1]),
      items: items.sort((a, b) => b.span - a.span).slice(0, 200),
    };
    // What OSM has for this key that the OBJ did NOT model — the gap between
    // "the licensed model gives us this for free" and "we would have to pull
    // it ourselves".
    const avail = new Map();
    for (const w of ways)
      for (const t of w.tags) if (t.startsWith(`${which}=`)) avail.set(t, (avail.get(t) ?? 0) + 1);
    out[which].osmAvailableNotInObj = [...avail.entries()].sort((a, b) => b[1] - a[1]);
    out.summary.push(
      `${which}: ${items.length} components — ${lines.length} line-like, ${areas.length} area-like; ` +
        `y ${yMin.toFixed(2)}..${yMax.toFixed(2)}u (${(yMin * M_PER_U).toFixed(1)}..${(yMax * M_PER_U).toFixed(1)} m); ` +
        `OSM tags: ${[...tagHist.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([t, n]) => `${t} x${n}`)
          .join(", ")}`,
    );
    out.summary.push(
      `  OSM has, in the same bbox: ${[...avail.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([t, n]) => `${t} x${n}`)
        .join(", ")}`,
    );
  }
  return out;
}

// --- 4. Rasterise to the game grid -----------------------------------------

const CELL_W = WORLD_W / GRID_X; // 13u = 57.8 m
const CELL_H = WORLD_H / GRID_Z;
const CELL_AREA = CELL_W * CELL_H;

const inRing = (ring, px, pz) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};

/**
 * AREA-WEIGHTED rasterisation. The naive "class of whatever covers the cell
 * centre" test that bake-landuse.mjs uses throws away almost everything at
 * this grid pitch: a cell is 13x13u (58x58 m) and the MEDIAN decoded polygon
 * is two orders of magnitude smaller, so its centre is almost never covered.
 * Here every polygon is sampled on a 1.5u lattice and contributes its covered
 * area to each cell; the cell then takes the class holding the most area,
 * breaking ties by the class rank (water > sand > pitch > park > ... > land
 * use). A cell must be `minFill` covered to claim a class at all.
 */
function rasteriseAreas(items, minFill) {
  const acc = new Map(); // cellIndex -> Map<class, area>
  const STEP = 1.5;
  for (const p of items) {
    let minX = 1e9;
    let maxX = -1e9;
    let minZ = 1e9;
    let maxZ = -1e9;
    for (const [x, z] of p.ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const w = STEP * STEP;
    for (let x = minX + STEP / 2; x < maxX; x += STEP)
      for (let z = minZ + STEP / 2; z < maxZ; z += STEP) {
        if (!inRing(p.ring, x, z)) continue;
        const gx = Math.floor((x + WORLD_W / 2) / CELL_W);
        const gz = Math.floor((z + WORLD_H / 2) / CELL_H);
        if (gx < 0 || gx >= GRID_X || gz < 0 || gz >= GRID_Z) continue;
        const k = gx * GRID_Z + gz;
        let m = acc.get(k);
        if (!m) {
          m = new Map();
          acc.set(k, m);
        }
        m.set(p.cls, (m.get(p.cls) ?? 0) + w);
      }
  }
  const classes = [];
  const classId = new Map();
  const idOf = (c) => {
    let i = classId.get(c);
    if (i === undefined) {
      i = classes.length;
      classes.push(c);
      classId.set(c, i);
    }
    return i;
  };
  const cell = new Int16Array(GRID_X * GRID_Z).fill(-1);
  const fill = new Float32Array(GRID_X * GRID_Z);
  const rankOf = new Map(Object.values(CLASS_OF).map(([c, r]) => [c, r]));
  for (const [k, m] of acc) {
    let bestC = null;
    let bestA = 0;
    let total = 0;
    for (const [c, a] of m) {
      total += a;
      if (a > bestA || (a === bestA && (rankOf.get(c) ?? 0) > (rankOf.get(bestC) ?? 0))) {
        bestA = a;
        bestC = c;
      }
    }
    fill[k] = total / CELL_AREA;
    if (bestC && bestA / CELL_AREA >= minFill) cell[k] = idOf(bestC);
  }
  const counts = new Map();
  for (let i = 0; i < cell.length; i++) {
    const c = cell[i] < 0 ? "unclassified" : classes[cell[i]];
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  // Hex-encode a column per gx (2 chars per cell, class id + 1, 00 = none),
  // the same shape sf-streets.ts uses, so the emit phase's loader is a copy.
  const cols = [];
  for (let gx = 0; gx < GRID_X; gx++) {
    let s = "";
    for (let gz = 0; gz < GRID_Z; gz++)
      s += (cell[gx * GRID_Z + gz] + 1).toString(16).padStart(2, "0");
    cols.push(s);
  }
  return {
    classes,
    histogram: [...counts.entries()].sort((a, b) => b[1] - a[1]),
    cols,
    classified: cell.reduce((s, v) => s + (v >= 0 ? 1 : 0), 0),
  };
}

// --- Render plan ------------------------------------------------------------
const RENDER_PLAN = [
  "== 1. GROUND CLASSES ==",
  "SHIP `grid.cols`, NOT `objOnlyGrid`. The OBJ's ground layer decodes cleanly but is the",
  "  THINNER source: 3,057 of 48,800 cells vs 10,643 from a plain Overpass pull. The OBJ's",
  "  real contribution here is the TAXONOMY (it proves which ~26 classes downtown actually",
  "  uses, and it carries plaza/POPS/parklet areas a tag-filtered pull misses); the",
  "  coverage should come from the union. 11,005 cells / 22.6% classified.",
  "ENCODING — `grid.cols` is 244 strings of 400 hex chars, 2 chars per cell = classId+1,",
  "  '00' = unclassified. Identical shape to sf-streets.ts `cols`, so the runtime loader is",
  "  a copy of the mask loader and the ground pass gains one Uint8Array, no new format.",
  "PALETTE — today GREEN|SAND collapse into one literal 0xa6a496 for 72% of land. Keep",
  "  0xa6a496 for `unclassified` only, and give the earners their own tone: park/grass/",
  "  garden/wood/scrub as four separated greens (park darkest, grass lightest, wood a",
  "  blue-green, scrub a dry olive), pitch a saturated turf, sand/rock the existing warm",
  "  pair, water the bay colour, plaza/parking a cool pale grey, industrial/brownfield/",
  "  railyard/construction a warm dust. That is 4.5% of cells in the greens and 2.5% in",
  "  the greys — small in count, but they are the cells around every landmark.",
  "PROP SEEDS, not just colour — the polygons matter more than the raster for the cells",
  "  players drive past. `landuse.polygons` carries 2,800+ world-space rings with a class:",
  "  * plaza / place=square / POPS -> paved patch + Kenney planter, bench, fountain at the",
  "    ring centroid. These are Union Square, UN Plaza, Foundry Square, Piazza Angelo.",
  "  * amenity=parking -> correct, real surface lots. Seat parked cars and lot paint here",
  "    instead of scattering them procedurally.",
  "  * leisure=pitch / playground -> fenced court decal + the kit's fence run along the ring.",
  "  * man_made=pier -> already handled by bake-piers.mjs; use these only to cross-check.",
  "  Seat every one of them through ground.ts makeStandingSurface, never terrain.heightAt.",
  "STRIPS ARE LINES, NOT AREAS — the `barrier` (452 rings) and `man_stroke` (863 rings)",
  "  objects are extruded 0.3 m ribbons: fences, retaining walls, kerbs, pier edges. They",
  "  are flagged `strip:1` and excluded from the raster. Reduce them to centrelines and run",
  "  the kit's fence/wall props along them; do NOT paint them as ground.",
  "DISTRICTS — `landuse.districts` holds 5 rings over 0.4 km². The biggest (6.78 km²,",
  "  bounded by the Embarcadero, Market Street and Van Ness) is an administrative outline,",
  "  not a ground class. Use it as a REGION MASK — e.g. denser street furniture, more",
  "  traffic, taller default massing inside it — never as a colour.",
  "",
  "== 2. MASSING ==",
  "THE GAME'S 3-WAY POOL PICK AT 9u/28u IS RIGHT FOR 75% OF THE CITY AND WRONG FOR THE",
  "  SKYLINE. 67.9% of components are 1-2u (4-9 m) and 99.5% of those are literal 2-level",
  "  extruded prisms — `bhV = max(bh, 4.0)` plus a prism is exactly correct there.",
  "  The structure appears only as you go up: flat-prism share falls 99.5% -> 79.6% (2-4u)",
  "  -> 54.9% (9-20u) -> 21.7% (20-40u) -> 0% (>=40u), and median taper falls 1.00 -> 0.72",
  "  -> 0.57. Every tower a player can see from the road has a podium and setbacks.",
  "REPRESENT IT WITH THREE STACKED PRISMS, NOT NEW ART. For h >= 20u (101 components,",
  "  98 of them inside the FiDi box u .66-.80 / v .12-.27), extrude the real footprint ring",
  "  three times: podium 0 -> 0.25h at 1.00x inset, shaft 0.25h -> 0.85h at ~0.80x, crown",
  "  0.85h -> h at `taper` (median 0.72 at 20-40u, 0.57 above). `massing.fidiCluster.towers`",
  "  gives [u, v, h, taper, bboxArea] per tower and `massing.setbackSamples` gives the",
  "  measured level stacks for the top 40. Inset each stage about its own centroid so the",
  "  silhouette steps in, which is the whole read at driving distance.",
  "DO NOT ADD MORE HEIGHT TIERS. 532 distinct heights sounds like variety but 5 values",
  "  (1.69, 1.41, 1.83, 1.97, 1.55u) cover 13,260 of 25,213 components — the fabric is",
  "  genuinely uniform. Spend the budget on the 101 towers, not on the 17,109 low boxes.",
  "9 components exceed 40u: Salesforce 73.3u/326 m, Transamerica 58.5u/260 m, 181 Fremont",
  "  55.2u/245 m, 555 California 48.7u/216 m. These four alone justify bespoke crowns.",
  "",
  "== 3. POWER / RAIL ==",
  "POWER IS NOT TRANSMISSION. The `power` object is 30 flat polygons, 3-33u² each, 0.3 m",
  "  tall, all matching OSM power=generator — rooftop SOLAR ARRAYS (eight identical 3.7u²",
  "  rectangles in a row at u .623 / v .472 are one array). There are no pylons, no lines",
  "  and no substations in this model, so it is NOT free infrastructure for the industrial",
  "  south-east. If pylons are wanted, OSM has power=line x49, minor_line x109 and",
  "  substation x17 in the same bbox — pull them separately; the OBJ will not help.",
  "RAIL IS THE REAL PRIZE HERE and the OBJ does model it: 380 components, 134 line-like,",
  "  spanning y -15.6 m to +1.8 m — the Caltrain approach, the Muni Metro subway box and",
  "  the surface tram. `infrastructure.railway.items` carries rings + decoded tags",
  "  (platform x182, rail x53, tram x51, light_rail x48, disused x20, turntable x7).",
  "  Platforms and the turntables at the 4th & King yard are placeable props today;",
  "  the sub-grade sections are what a viaduct/cut pass would need.",
];
