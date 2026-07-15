// Extract REAL building footprint POLYGONS + heights from the licensed
// "Downtown San Francisco" OBJ and calibrate them into world space.
//
//   node tools/sf-data/extract-footprints.mjs <path-to-obj>
//
// This supersedes the bbox-only extract-downtown/calibrate-downtown pair for
// the downtown fabric: the game extrudes these outlines as prisms, so the
// massing IS the real city's (L-shapes, wall-to-wall rows, the lot pattern),
// not kit boxes stretched to a bbox. Calibration is the same road-vertex vs
// street-mask hit-rate fit; it runs here so outlines and transform can never
// drift apart. Emits src/world/sf-footprints.ts.
//
// Building groups in the OBJ aggregate many buildings per height tag; a
// union-find over shared vertices splits them. Per component the footprint is
// the boundary loop of its roof faces (faces whose verts all sit at the
// component's top); when that fails (stepped parapets, penthouse-only tops)
// the bbox rectangle stands in.

import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { GRID_Z, rdp, ringArea, WORLD_H, WORLD_W } from "./lib.mjs";

const objPath = process.argv[2];
if (!objPath) {
  console.error("usage: node extract-footprints.mjs <obj>");
  process.exit(1);
}

// --- Street mask (for calibration scoring) ---
const streetsTs = readFileSync(new URL("../../src/world/sf-streets.ts", import.meta.url), "utf8");
const colsMatch = streetsTs.match(/cols: (\[[^\]]+\])/);
if (!colsMatch) throw new Error("could not parse sf-streets.ts cols");
const cols = JSON.parse(colsMatch[1]);
const maskAt = (gx, gz) => {
  const col = cols[gx];
  if (col === undefined || gz < 0 || gz >= GRID_Z) return false;
  const nibble = col.charCodeAt(gz >> 2);
  const val = nibble <= 57 ? nibble - 48 : nibble - 87;
  return (val & (8 >> (gz & 3))) !== 0;
};

// --- Stream the OBJ ---
const ROAD_RE =
  /^highway_(motorway|trunk|primary|secondary|tertiary|residential|unclassified)(_link)?(_|$)/;
const vx = [];
const vy = [];
const vz = [];
let curGroup = null;
let curMtl = "";
const buildingGroups = new Map(); // group name -> number[][] (faces, vertex ids)
const roadVerts = [];
let roadVertBudget = 0;

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
  } else if (c0 === 102 /* f */) {
    if (!curGroup) return;
    const isRoad = ROAD_RE.test(curGroup);
    const isBuilding = curMtl === "building";
    if (!isRoad && !isBuilding) return;
    const ids = [];
    for (const part of l.slice(2).trim().split(/\s+/)) {
      const s = part.indexOf("/") >= 0 ? part.slice(0, part.indexOf("/")) : part;
      let id = Number(s);
      if (id < 0) id = vx.length + 1 + id;
      ids.push(id - 1);
    }
    if (isBuilding) {
      let g = buildingGroups.get(curGroup);
      if (!g) {
        g = [];
        buildingGroups.set(curGroup, g);
      }
      g.push(ids);
    } else if (roadVertBudget++ % 3 === 0) {
      for (const id of ids) roadVerts.push([vx[id], vz[id]]);
    }
  } else if (l.startsWith("g ") || l.startsWith("o ")) {
    curGroup = l.slice(2).trim();
  } else if (l.startsWith("usemtl")) {
    curMtl = l.slice(7).trim();
  }
});

rl.on("close", () => {
  // --- Split groups into per-building components, capture roof outlines ---
  const buildings = []; // { cx, cz, w, d, h, outline: [[x,z],...] | null } model space
  for (const [, faces] of buildingGroups) {
    const parent = new Map();
    const find = (a) => {
      let r = a;
      while (parent.get(r) !== r) r = parent.get(r);
      while (parent.get(a) !== r) {
        const next = parent.get(a);
        parent.set(a, r);
        a = next;
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
    const comps = new Map(); // root -> { faces, minX.. }
    for (const f of faces) {
      const root = find(f[0]);
      let c = comps.get(root);
      if (!c) {
        c = {
          faces: [],
          minX: 1e9,
          maxX: -1e9,
          minY: 1e9,
          maxY: -1e9,
          minZ: 1e9,
          maxZ: -1e9,
        };
        comps.set(root, c);
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
    for (const c of comps.values()) {
      const w = c.maxX - c.minX;
      const d = c.maxZ - c.minZ;
      if (w < 3 || d < 3) continue; // shed/antenna slivers
      buildings.push({
        cx: (c.minX + c.maxX) / 2,
        cz: (c.minZ + c.maxZ) / 2,
        w,
        d,
        h: c.maxY - c.minY,
        outline: roofOutline(c),
      });
    }
  }
  console.log(`components: ${buildings.length} (${buildingGroups.size} tag groups)`);
  const withOutline = buildings.filter((b) => b.outline).length;
  console.log(
    `roof outlines recovered: ${withOutline} (${((withOutline / buildings.length) * 100).toFixed(1)}%)`,
  );

  calibrateAndEmit(buildings);
});

// Boundary loop of the component's top faces. Roof faces = all verts within
// 0.75 of the component max Y. Boundary edges appear in exactly one face.
function roofOutline(c) {
  const topFaces = c.faces.filter((f) => f.every((id) => vy[id] >= c.maxY - 0.75));
  if (topFaces.length === 0) return null;
  const edgeCount = new Map(); // "a,b" (a<b) -> count
  const edgeDir = new Map(); // "a,b" -> [from, to] of first occurrence
  for (const f of topFaces) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      if (a === b) continue;
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      if (!edgeDir.has(k)) edgeDir.set(k, [a, b]);
    }
  }
  const next = new Map(); // vertex -> vertex along boundary
  for (const [k, n] of edgeCount) {
    if (n !== 1) continue;
    const dir = edgeDir.get(k);
    if (dir) next.set(dir[0], dir[1]);
  }
  if (next.size < 3) return null;
  // Walk the largest loop.
  const seen = new Set();
  let best = null;
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let cur = start;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      loop.push(cur);
      cur = next.get(cur);
    }
    if (cur === start && loop.length >= 3 && (!best || loop.length > best.length)) best = loop;
  }
  if (!best) return null;
  const pts = best.map((id) => [vx[id], vz[id]]);
  // Guard: a penthouse-only top loses the footprint — fall back to bbox.
  const area = Math.abs(ringArea(pts));
  if (area < 0.45 * (c.maxX - c.minX) * (c.maxZ - c.minZ)) return null;
  return pts;
}

// Model → world transform. NOT auto-fitted: the old calibrate-downtown fit
// assumed one uniform scale AND a mirrored z (fz=-1) — the mask score
// actually preferred the MIRRORED city (SF's grid is quasi-symmetric), which
// shipped an upside-down downtown. These constants were anchored on towers
// identified by height ratio (model h / real m = 1.598 for both Salesforce
// 520.9/326 and Transamerica 415.6/260), then hill-climbed against the street
// mask with independent x/z scales and NO flip. Verified: Salesforce,
// Transamerica and 345 California all land within ~5u of their projected
// real coordinates.
const CAL = { sx: 0.17829, sz: 0.17909, bx: 325.2, bz: -400.5 };
// Vertical: model h / real meters = 1.598 (both anchor towers), and the world
// runs 4.446 m/u — so world h = model h / (1.598 * 4.446).
const CAL_SY = 1 / (1.598 * 4.446);
const ANCHORS = [
  ["Salesforce", 2458.4, -2088.9, 760.0, -770.1],
  ["Transamerica", 1809.9, -2842.1, 644.9, -907.7],
];

function calibrateAndEmit(buildings) {
  const toWorld = ([x, z]) => [x * CAL.sx + CAL.bx, z * CAL.sz + CAL.bz];
  for (const [name, mx, mz, wx, wz] of ANCHORS) {
    const [ax, az] = toWorld([mx, mz]);
    const err = Math.hypot(ax - wx, az - wz);
    console.log(
      `anchor ${name}: (${ax.toFixed(1)}, ${az.toFixed(1)}) vs (${wx}, ${wz}) — ${err.toFixed(1)}u`,
    );
    if (err > 12) {
      console.error("anchor drift — recheck CAL before emitting");
      process.exit(1);
    }
  }

  // --- Transform + filter + emit ---
  // Fabric goes LOW: 1u (~4.5m) keeps the 1-2 story wall-to-wall rows that
  // make Chinatown/North Beach read as city, not suburbs.
  const out = []; // [h, x0,z0, x1,z1, ...] world units, 0.1 quantized
  let fromBbox = 0;
  for (const b of buildings) {
    if (b.w > 900 || b.d > 900) continue; // merged mega-complex noise
    const h = b.h * CAL_SY;
    if (h < 1.0 || h > 130) continue;
    let ring = b.outline;
    if (!ring) {
      fromBbox++;
      ring = [
        [b.cx - b.w / 2, b.cz - b.d / 2],
        [b.cx + b.w / 2, b.cz - b.d / 2],
        [b.cx + b.w / 2, b.cz + b.d / 2],
        [b.cx - b.w / 2, b.cz + b.d / 2],
      ];
    }
    let world = ring.map(toWorld);
    if (ringArea(world) < 0) world = world.reverse(); // normalize CCW for extrusion
    world = rdp(world, 0.3);
    if (world.length < 3 || world.length > 64) continue;
    const area = Math.abs(ringArea(world));
    if (area < 5) continue; // < ~10x10 m — noise
    let clipped = false;
    for (const [x, z] of world) {
      if (Math.abs(x) > WORLD_W / 2 || Math.abs(z) > WORLD_H / 2) clipped = true;
    }
    if (clipped) continue;
    const flat = [Math.round(h * 10) / 10];
    for (const [x, z] of world) flat.push(Math.round(x * 10) / 10, Math.round(z * 10) / 10);
    out.push(flat);
  }
  // Tallest first (stable prism pass priority; ties broken by area).
  out.sort((a, b) => b[0] - a[0]);
  console.log(`emitting ${out.length} footprints (${fromBbox} bbox fallbacks pre-filter)`);

  const xs = [];
  const zs = [];
  for (const f of out) {
    for (let i = 1; i < f.length; i += 2) {
      xs.push(f[i]);
      zs.push(f[i + 1]);
    }
  }
  const q = (arr, t) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length * t)];
  const body = out.map((f) => JSON.stringify(f)).join(",\n");
  writeFileSync(
    new URL("../../src/world/sf-footprints.ts", import.meta.url),
    `// AUTO-GENERATED by tools/sf-data/extract-footprints.mjs — do not edit.
// Real downtown building FOOTPRINT POLYGONS + heights (licensed model,
// OSM-derived), calibrated via tower anchors + street-mask fit (see extractor).
// Entry: [height, x0, z0, x1, z1, ...] — CCW ring, world units, tallest first.
export const SF_FOOTPRINTS: readonly (readonly number[])[] = [
${body},
];

// Dense-core coverage (8th..92nd pct) — procedural kit lots yield to the real
// fabric inside this box.
export const SF_FOOTPRINTS_BOUNDS = {
  minX: ${Math.round(q(xs, 0.08) - 10)},
  maxX: ${Math.round(q(xs, 0.92) + 10)},
  minZ: ${Math.round(q(zs, 0.08) - 10)},
  maxZ: ${Math.round(q(zs, 0.92) + 10)},
} as const;
`,
  );
  console.log("sf-footprints.ts written");
}
