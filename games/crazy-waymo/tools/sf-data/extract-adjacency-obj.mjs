// Extract BUILDING ADJACENCY — which real SF parcels share a PARTY WALL —
// from the licensed "Downtown San Francisco" OBJ.
//
//   node tools/sf-data/extract-adjacency-obj.mjs <path-to-obj> <out.json>
//
// extract-footprints.mjs already runs a union-find over shared vertex INDICES
// to split each building tag group into per-building components, and emits one
// footprint ring per component (src/world/sf-footprints.ts, 21,023 parcels).
// The union-find separates buildings that share a wall, because the OBJ stores
// a SEPARATE vertex per building even where the coordinates are identical.
// That is the whole trick this extractor exploits: the party walls are still
// in the data as EXACTLY COINCIDENT, antiparallel ring edges between two
// different components. Nothing needs fitting — the separation histogram is
// bimodal at machine precision (see the eps sweep this prints).
//
// The pipeline up to "parcels" is a byte-for-byte replay of
// extract-footprints.mjs, so parcel id === index into SF_FOOTPRINTS. The
// extractor VERIFIES that against the shipped file and refuses to emit if the
// two ever drift apart.
//
// Output (JSON, see EMIT below): per parcel its world ring, height, district,
// the neighbour parcels it is attached to and WHICH RING EDGE each party wall
// is; plus block-face RUNS (chains of attached parcels along one frontage)
// with per-parcel lot widths.
//
// ANALYSIS ONLY — this writes JSON, never a .ts module. A later phase turns
// the JSON into a generated data module.

import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { GRID_X, GRID_Z, rdp, ringArea, WORLD_H, WORLD_W } from "./lib.mjs";

const objPath = process.argv[2];
const outPath = process.argv[3];
if (!objPath || !outPath) {
  console.error("usage: node extract-adjacency-obj.mjs <obj> <out.json>");
  process.exit(1);
}

// --- Tunables -------------------------------------------------------------
// Coincidence epsilon, world units. The sweep printed below shows the signal
// is a spike at <=0.001u (exact shared geometry) sitting on a flat background;
// 0.02u (~9 cm) is float slack, not a fitted threshold.
const EPS = 0.02;
// Two rings can graze at a corner. A party wall has to be a WALL.
const MIN_OVERLAP = 0.5; // world units (~2.2 m)
// Ring edges are compared before RDP simplification, so a true party wall is
// parallel to within float noise; this only rejects glancing near-parallels.
const MAX_CROSS = 0.05; // |sin(angle)| — ~2.9 deg
// A run continues through a parcel while the next party wall keeps pointing
// the same way along the frontage.
const RUN_COS = Math.cos((38 * Math.PI) / 180);
const METERS_PER_UNIT = 4.446;

// Model → world transform. Owned by extract-footprints.mjs; copied verbatim,
// NOT re-fitted. Anchors are re-asserted below so a drift here is loud.
const CAL = { sx: 0.17829, sz: 0.17909, bx: 325.2, bz: -400.5 };
const CAL_SY = 1 / (1.598 * 4.446);
const ANCHORS = [
  ["Salesforce", 2458.4, -2088.9, 760.0, -770.1],
  ["Transamerica", 1809.9, -2842.1, 644.9, -907.7],
];
const toWorld = ([x, z]) => [x * CAL.sx + CAL.bx, z * CAL.sz + CAL.bz];

// --- Stream the OBJ (building faces only) ---------------------------------
const vx = [];
const vy = [];
const vz = [];
let curGroup = null;
let curMtl = "";
const buildingGroups = new Map(); // group name -> number[][] (faces, vertex ids)

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
    if (!curGroup || curMtl !== "building") return;
    const ids = [];
    for (const part of l.slice(2).trim().split(/\s+/)) {
      const s = part.indexOf("/") >= 0 ? part.slice(0, part.indexOf("/")) : part;
      let id = Number(s);
      if (id < 0) id = vx.length + 1 + id;
      ids.push(id - 1);
    }
    let g = buildingGroups.get(curGroup);
    if (!g) buildingGroups.set(curGroup, (g = []));
    g.push(ids);
  } else if (l.startsWith("g ") || l.startsWith("o ")) {
    curGroup = l.slice(2).trim();
  } else if (l.startsWith("usemtl")) {
    curMtl = l.slice(7).trim();
  }
});

rl.on("close", () => main());

// --- extract-footprints.mjs's roof-loop recovery (verbatim) ---------------
function roofOutline(c) {
  const topFaces = c.faces.filter((f) => f.every((id) => vy[id] >= c.maxY - 0.75));
  if (topFaces.length === 0) return null;
  const edgeCount = new Map();
  const edgeDir = new Map();
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
  const next = new Map();
  for (const [k, n] of edgeCount) {
    if (n !== 1) continue;
    const dir = edgeDir.get(k);
    if (dir) next.set(dir[0], dir[1]);
  }
  if (next.size < 3) return null;
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
  if (Math.abs(ringArea(pts)) < 0.45 * (c.maxX - c.minX) * (c.maxZ - c.minZ)) return null;
  return pts;
}

function components() {
  const buildings = [];
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
    const comps = new Map();
    for (const f of faces) {
      const root = find(f[0]);
      let c = comps.get(root);
      if (!c) {
        c = { faces: [], minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, minZ: 1e9, maxZ: -1e9 };
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
  return buildings;
}

// Replay of extract-footprints.mjs's emit filter. Keeps BOTH the full-precision
// world ring (adjacency is measured on this) and the shipped, RDP-simplified,
// 0.1-quantized ring, plus the map from raw edge index -> shipped edge index.
// RDP returns the SAME point-array objects, so the map is exact, not fitted.
function buildParcels(buildings) {
  const parcels = [];
  for (const b of buildings) {
    if (b.w > 900 || b.d > 900) continue; // merged mega-complex noise
    const h = b.h * CAL_SY;
    if (h < 1.0 || h > 130) continue;
    const modelRing = b.outline ?? [
      [b.cx - b.w / 2, b.cz - b.d / 2],
      [b.cx + b.w / 2, b.cz - b.d / 2],
      [b.cx + b.w / 2, b.cz + b.d / 2],
      [b.cx - b.w / 2, b.cz + b.d / 2],
    ];
    let raw = modelRing.map(toWorld);
    if (ringArea(raw) < 0) raw = raw.reverse(); // normalize CCW
    const simp = rdp(raw, 0.3);
    if (simp.length < 3 || simp.length > 64) continue;
    const world = simp.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
    if (Math.abs(ringArea(simp)) < 5) continue; // < ~10x10 m — noise
    let clipped = false;
    for (const [x, z] of simp) {
      if (Math.abs(x) > WORLD_W / 2 || Math.abs(z) > WORLD_H / 2) clipped = true;
    }
    if (clipped) continue;
    const at = new Map(raw.map((p, i) => [p, i]));
    const keep = simp.map((p) => at.get(p)); // raw index of each kept point
    const rawToEmit = new Array(raw.length).fill(0);
    for (let j = 0; j < keep.length; j++) {
      const k0 = keep[j];
      const k1 = j + 1 < keep.length ? keep[j + 1] : raw.length;
      for (let i = k0; i < k1; i++) rawToEmit[i] = j;
    }
    parcels.push({
      h: Math.round(h * 10) / 10,
      raw,
      ring: world,
      rawToEmit,
      bboxFallback: !b.outline,
    });
  }
  // Tallest first — matches SF_FOOTPRINTS ordering exactly (V8 sort is stable).
  parcels.sort((a, b) => b.h - a.h);
  return parcels;
}

// Hard gate: parcel ids are only meaningful if they index SF_FOOTPRINTS.
function assertMatchesShipped(parcels) {
  const src = readFileSync(new URL("../../src/world/sf-footprints.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("SF_FOOTPRINTS: readonly"));
  const rows = [...body.matchAll(/\[([-\d.,\s]+)\]/g)].map((m) =>
    m[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number),
  );
  let bad = rows.length !== parcels.length ? 1 : 0;
  for (let i = 0; i < Math.min(rows.length, parcels.length) && bad === 0; i++) {
    const mine = [parcels[i].h];
    for (const [x, z] of parcels[i].ring) mine.push(x, z);
    if (JSON.stringify(rows[i]) !== JSON.stringify(mine)) bad = 1;
  }
  console.log(
    `id check vs src/world/sf-footprints.ts: ${bad ? "FAIL" : "PASS"} ` +
      `(${parcels.length} parcels vs ${rows.length} shipped rows)`,
  );
  if (bad) {
    console.error(
      "parcel ids would NOT index SF_FOOTPRINTS — re-run extract-footprints.mjs first, " +
        "or reconcile the two filter chains before trusting this output.",
    );
    process.exit(1);
  }
}

// --- Districts: parsed out of the runtime source so they cannot drift ------
function loadDistricts() {
  const src = readFileSync(new URL("../../src/world/sf-map.ts", import.meta.url), "utf8");
  const block = src.slice(
    src.indexOf("const NEIGHBORHOODS"),
    src.indexOf("export function districtAt"),
  );
  const re =
    /name:\s*"([^"]+)",\s*character:\s*"([^"]+)",\s*color:\s*0x[0-9a-fA-F]+,\s*uMin:\s*([-\d.]+),\s*uMax:\s*([-\d.]+),\s*vMin:\s*([-\d.]+),\s*vMax:\s*([-\d.]+)/g;
  const boxes = [...block.matchAll(re)].map((m) => ({
    name: m[1],
    character: m[2],
    uMin: Number(m[3]),
    uMax: Number(m[4]),
    vMin: Number(m[5]),
    vMax: Number(m[6]),
  }));
  if (boxes.length < 40) throw new Error(`parsed only ${boxes.length} districts from sf-map.ts`);
  return boxes;
}
// Same rule as sf-map.ts districtAt: inside-box wins, else nearest box.
function districtAtUV(boxes, u, v) {
  let best = null;
  let bd = Infinity;
  for (const n of boxes) {
    if (u >= n.uMin && u <= n.uMax && v >= n.vMin && v <= n.vMax) return n;
    const du = Math.max(n.uMin - u, 0, u - n.uMax);
    const dv = Math.max(n.vMin - v, 0, v - n.vMax);
    const d = du * du + dv * dv;
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}

// --- Coincident-wall detection --------------------------------------------
// Builds the raw edge list + a uniform spatial hash, then for every candidate
// pair measures perpendicular separation and parallel overlap.
function buildEdgeIndex(parcels, cell) {
  const edges = [];
  const grid = new Map();
  const key = (gx, gz) => gx * 100003 + gz;
  for (let p = 0; p < parcels.length; p++) {
    const r = parcels[p].raw;
    for (let i = 0; i < r.length; i++) {
      const [x0, z0] = r[i];
      const [x1, z1] = r[(i + 1) % r.length];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1e-9) continue;
      const e = { p, i, x0, z0, x1, z1, len, dx: (x1 - x0) / len, dz: (z1 - z0) / len };
      const id = edges.push(e) - 1;
      const gx0 = Math.floor((Math.min(x0, x1) - EPS) / cell);
      const gx1 = Math.floor((Math.max(x0, x1) + EPS) / cell);
      const gz0 = Math.floor((Math.min(z0, z1) - EPS) / cell);
      const gz1 = Math.floor((Math.max(z0, z1) + EPS) / cell);
      for (let gx = gx0; gx <= gx1; gx++)
        for (let gz = gz0; gz <= gz1; gz++) {
          const k = key(gx, gz);
          let c = grid.get(k);
          if (!c) grid.set(k, (c = []));
          c.push(id);
        }
    }
  }
  return { edges, grid, cell, key };
}

// Perpendicular separation of b's endpoints from a's line + the length of the
// stretch of a that b covers. null when they are not near-parallel or miss.
function measure(a, b) {
  if (Math.abs(a.dx * b.dz - a.dz * b.dx) > MAX_CROSS) return null;
  const perp = (px, pz) => Math.abs((px - a.x0) * a.dz - (pz - a.z0) * a.dx);
  const sep = Math.max(perp(b.x0, b.z0), perp(b.x1, b.z1));
  const along = (px, pz) => (px - a.x0) * a.dx + (pz - a.z0) * a.dz;
  const t0 = along(b.x0, b.z0);
  const t1 = along(b.x1, b.z1);
  const ov = Math.min(a.len, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
  if (ov <= 0) return null;
  return { sep, ov };
}

// Every near-parallel, overlapping edge pair between DIFFERENT parcels, with
// the anti/parallel split. Antiparallel = the two CCW rings face each other =
// a party wall. Parallel = one ring nested in or duplicating the other.
function candidatePairs(idx, maxSep) {
  const { edges, grid, cell, key } = idx;
  const out = [];
  for (let ai = 0; ai < edges.length; ai++) {
    const a = edges[ai];
    const gx0 = Math.floor((Math.min(a.x0, a.x1) - maxSep) / cell);
    const gx1 = Math.floor((Math.max(a.x0, a.x1) + maxSep) / cell);
    const gz0 = Math.floor((Math.min(a.z0, a.z1) - maxSep) / cell);
    const gz1 = Math.floor((Math.max(a.z0, a.z1) + maxSep) / cell);
    const seen = new Set();
    for (let gx = gx0; gx <= gx1; gx++)
      for (let gz = gz0; gz <= gz1; gz++) {
        const c = grid.get(key(gx, gz));
        if (!c) continue;
        for (const bi of c) {
          if (bi <= ai || seen.has(bi)) continue;
          seen.add(bi);
          const b = edges[bi];
          if (b.p === a.p) continue;
          const m = measure(a, b);
          if (!m || m.sep > maxSep || m.ov < MIN_OVERLAP) continue;
          out.push({ ai, bi, sep: m.sep, ov: m.ov, anti: a.dx * b.dx + a.dz * b.dz < 0 });
        }
      }
  }
  return out;
}

function pct(arr, t) {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * t))];
}

function main() {
  for (const [name, mx, mz, wx, wz] of ANCHORS) {
    const [ax, az] = toWorld([mx, mz]);
    const err = Math.hypot(ax - wx, az - wz);
    console.log(`anchor ${name}: ${err.toFixed(1)}u drift`);
    if (err > 12) {
      console.error("anchor drift — recheck CAL before emitting");
      process.exit(1);
    }
  }

  const comps = components();
  console.log(`components: ${comps.length} (${buildingGroups.size} tag groups)`);
  const parcels = buildParcels(comps);
  assertMatchesShipped(parcels);

  const idx = buildEdgeIndex(parcels, 4);
  console.log(`raw ring edges: ${idx.edges.length}`);

  // --- eps sweep (evidence, not tuning): how bimodal is the separation? ---
  const sweep = candidatePairs(idx, 2.0);
  const bins = [0.001, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0];
  console.log(`separation sweep — near-parallel pairs with overlap >= ${MIN_OVERLAP}u:`);
  let prev = 0;
  for (const t of bins) {
    const n = sweep.filter((p) => p.sep <= t && p.anti).length;
    const par = sweep.filter((p) => p.sep <= t && !p.anti).length;
    console.log(
      `  sep <= ${String(t).padStart(5)}u : antiparallel ${String(n).padStart(6)} ` +
        `(+${String(n - prev).padStart(5)} in bin)   parallel ${String(par).padStart(5)}`,
    );
    prev = n;
  }

  const pairs = sweep.filter((p) => p.sep <= EPS && p.anti);
  console.log(`party-wall edge pairs at EPS=${EPS}u: ${pairs.length}`);

  // --- Aggregate edge pairs into parcel<->parcel walls -------------------
  // A jogged party wall shows up as several edge pairs; they collapse into one
  // neighbour record carrying every ring edge involved.
  const walls = new Map(); // "lo,hi" -> { a, b, len, edgesA:Set, edgesB:Set }
  for (const { ai, bi, ov } of pairs) {
    const ea = idx.edges[ai];
    const eb = idx.edges[bi];
    const lo = Math.min(ea.p, eb.p);
    const hi = Math.max(ea.p, eb.p);
    const k = `${lo},${hi}`;
    let w = walls.get(k);
    if (!w) walls.set(k, (w = { a: lo, b: hi, len: 0, edgesA: new Set(), edgesB: new Set() }));
    w.len += ov;
    const [la, lb] = ea.p === lo ? [ea, eb] : [eb, ea];
    w.edgesA.add(parcels[lo].rawToEmit[la.i]);
    w.edgesB.add(parcels[hi].rawToEmit[lb.i]);
  }
  console.log(`distinct attached parcel pairs: ${walls.size}`);

  // --- Per-parcel neighbour records --------------------------------------
  const nb = parcels.map(() => []); // [{ q, edges:[emit edge idx], len, nx, nz }]
  const centroidOf = (ring) => {
    let x = 0;
    let z = 0;
    for (const [px, pz] of ring) {
      x += px;
      z += pz;
    }
    return [x / ring.length, z / ring.length];
  };
  const cent = parcels.map((p) => centroidOf(p.ring));
  // Outward normal of emit edge i of a CCW ring.
  const edgeNormal = (ring, i) => {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const L = Math.hypot(dx, dz) || 1;
    return [dz / L, -dx / L];
  };
  for (const w of walls.values()) {
    const ea = [...w.edgesA].sort((x, y) => x - y);
    const eb = [...w.edgesB].sort((x, y) => x - y);
    const na = edgeNormal(parcels[w.a].ring, ea[0]);
    const nbn = edgeNormal(parcels[w.b].ring, eb[0]);
    nb[w.a].push({ q: w.b, edges: ea, len: Math.round(w.len * 100) / 100, nx: na[0], nz: na[1] });
    nb[w.b].push({ q: w.a, edges: eb, len: Math.round(w.len * 100) / 100, nx: nbn[0], nz: nbn[1] });
  }
  for (const list of nb) list.sort((x, y) => y.len - x.len || x.q - y.q);

  // --- Block-face runs -----------------------------------------------------
  // Walk each party wall's outward normal: at the next parcel, keep going while
  // some wall of ITS points the same way along the frontage. Parcels join at
  // most one run, so the counts below never double-count a lot.
  const runOf = new Array(parcels.length).fill(-1);
  const runs = [];
  const extend = (from, dirX, dirZ, chain, used) => {
    let cur = from;
    let dx = dirX;
    let dz = dirZ;
    for (;;) {
      let pick = null;
      for (const n of nb[cur]) {
        if (runOf[n.q] !== -1 || used.has(n.q)) continue;
        const d = n.nx * dx + n.nz * dz;
        if (d < RUN_COS) continue;
        if (!pick || n.len > pick.n.len) pick = { n, d };
      }
      if (!pick) return;
      chain.push(pick.n.q);
      used.add(pick.n.q);
      // Track the frontage direction so gently curved rows still chain.
      dx = dx * 0.6 + pick.n.nx * 0.4;
      dz = dz * 0.6 + pick.n.nz * 0.4;
      const L = Math.hypot(dx, dz) || 1;
      dx /= L;
      dz /= L;
      cur = pick.n.q;
    }
  };
  for (let p = 0; p < parcels.length; p++) {
    if (runOf[p] !== -1) continue;
    // Seed on this parcel's strongest wall; both ways from there.
    const seed = nb[p].find((n) => runOf[n.q] === -1);
    if (!seed) continue;
    const used = new Set([p]);
    const fwd = [];
    const back = [];
    extend(p, seed.nx, seed.nz, fwd, used);
    extend(p, -seed.nx, -seed.nz, back, used);
    const chain = [...back.reverse(), p, ...fwd];
    if (chain.length < 2) continue;
    const rid = runs.length;
    for (const q of chain) runOf[q] = rid;
    runs.push(chain);
  }

  // Run geometry: axis = first->last centroid; widths = ring extent on the axis.
  const runData = runs.map((chain, rid) => {
    const [x0, z0] = cent[chain[0]];
    const [x1, z1] = cent[chain[chain.length - 1]];
    let ax = x1 - x0;
    let az = z1 - z0;
    const L = Math.hypot(ax, az) || 1;
    ax /= L;
    az /= L;
    let lo = Infinity;
    let hi = -Infinity;
    const widths = chain.map((q) => {
      let a = Infinity;
      let b = -Infinity;
      for (const [px, pz] of parcels[q].ring) {
        const t = px * ax + pz * az;
        if (t < a) a = t;
        if (t > b) b = t;
        if (t < lo) lo = t;
        if (t > hi) hi = t;
      }
      return Math.round((b - a) * 100) / 100;
    });
    return {
      id: rid,
      p: chain,
      w: widths,
      len: Math.round((hi - lo) * 100) / 100,
      ax: Math.round(ax * 1000) / 1000,
      az: Math.round(az * 1000) / 1000,
    };
  });

  // --- Districts + stats ---------------------------------------------------
  const boxes = loadDistricts();
  const uvOf = (p) => [cent[p][0] / WORLD_W + 0.5, cent[p][1] / WORLD_H + 0.5];
  const district = parcels.map((_, p) => {
    const [u, v] = uvOf(p);
    return districtAtUV(boxes, u, v).name;
  });

  const deg = nb.map((l) => l.length);
  const attached = deg.filter((d) => d > 0).length;
  const runLenOf = new Array(parcels.length).fill(1);
  for (const r of runData) for (const q of r.p) runLenOf[q] = r.p.length;
  const in2 = runLenOf.filter((n) => n >= 2).length;
  const in4 = runLenOf.filter((n) => n >= 4).length;
  const in8 = runLenOf.filter((n) => n >= 8).length;

  const allWidths = runData.flatMap((r) => r.w);
  const wallLens = [...walls.values()].map((w) => w.len);

  // FIDELITY: a parcel whose roof loop was not recoverable ships a bbox
  // RECTANGLE, which cannot be coincident with a real neighbour's ring. Those
  // parcels can only ever look detached — the split below is the honest ceiling
  // on how much of the "45% detached" is real vs an artefact of the extractor.
  const bboxIds = parcels.map((p, i) => (p.bboxFallback ? i : -1)).filter((i) => i >= 0);
  const realIds = parcels.map((p, i) => (p.bboxFallback ? -1 : i)).filter((i) => i >= 0);
  const attRate = (ids) => (ids.length ? ids.filter((i) => deg[i] > 0).length / ids.length : 0);
  console.log("");
  console.log(
    `FIDELITY: roof-loop rings ${realIds.length} (${(attRate(realIds) * 100).toFixed(1)}% attached) | ` +
      `bbox-rectangle fallbacks ${bboxIds.length} (${(attRate(bboxIds) * 100).toFixed(1)}% attached — a rectangle cannot share a wall)`,
  );

  // FIDELITY 2: OVERLAP. The OBJ tags buildings by height band, so a tower with
  // setbacks (and OSM building:part geometry generally) arrives as several
  // components stacked on the same ground. Those are not lots and must not be
  // extruded twice; flagged here so the next phase can drop or merge them.
  const stacked = new Array(parcels.length).fill(0);
  {
    const CB = 20;
    const buckets = new Map();
    const bkey = (gx, gz) => gx * 100003 + gz;
    parcels.forEach((p, i) => {
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const [x, z] of p.ring) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      p.bb = [x0, z0, x1, z1];
      for (let gx = Math.floor(x0 / CB); gx <= Math.floor(x1 / CB); gx++)
        for (let gz = Math.floor(z0 / CB); gz <= Math.floor(z1 / CB); gz++) {
          const k = bkey(gx, gz);
          let c = buckets.get(k);
          if (!c) buckets.set(k, (c = []));
          c.push(i);
        }
    });
    const inside = (ring, x, z) => {
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, zi] = ring[i];
        const [xj, zj] = ring[j];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
      }
      return hit;
    };
    for (let i = 0; i < parcels.length; i++) {
      const [cxx, czz] = cent[i];
      const c = buckets.get(bkey(Math.floor(cxx / CB), Math.floor(czz / CB)));
      if (!c) continue;
      for (const j of c) {
        if (j === i) continue;
        const bb = parcels[j].bb;
        if (cxx < bb[0] || cxx > bb[2] || czz < bb[1] || czz > bb[3]) continue;
        if (inside(parcels[j].ring, cxx, czz)) {
          stacked[i] = 1;
          break;
        }
      }
    }
  }
  const nStacked = stacked.reduce((a, b) => a + b, 0);
  console.log(
    `  STACKED: ${nStacked} parcels (${((nStacked / parcels.length) * 100).toFixed(1)}%) sit with their centroid inside another parcel — height-band / building-part duplicates, not lots`,
  );

  const histOf = (vals, edges) => {
    const h = new Array(edges.length + 1).fill(0);
    for (const v of vals) {
      let k = edges.findIndex((t) => v <= t);
      if (k < 0) k = edges.length;
      h[k]++;
    }
    return h;
  };
  const runSizes = runData.map((r) => r.p.length);
  const runSizeHist = {};
  for (let s = 2; s <= 7; s++) runSizeHist[String(s)] = runSizes.filter((x) => x === s).length;
  runSizeHist["8+"] = runSizes.filter((x) => x >= 8).length;
  console.log(
    `  run size (parcels): ${Object.entries(runSizeHist)
      .map(([k, v]) => `${k}:${v}`)
      .join("  ")}`,
  );
  const W_BINS = [1.5, 2, 2.5, 3, 4, 5, 7, 10];
  const wh = histOf(allWidths, W_BINS);
  console.log(
    `  lot width hist (u): ${W_BINS.map((t, i) => `<=${t}:${wh[i]}`).join("  ")}  >${W_BINS[W_BINS.length - 1]}:${wh[W_BINS.length]}`,
  );

  console.log("");
  console.log(
    `ATTACHMENT: ${attached}/${parcels.length} parcels (${((attached / parcels.length) * 100).toFixed(1)}%) share >=1 party wall`,
  );
  console.log(
    `  degree distribution: ${[0, 1, 2, 3, 4].map((d) => `${d === 4 ? "4+" : d}:${deg.filter((x) => (d === 4 ? x >= 4 : x === d)).length}`).join("  ")}`,
  );
  console.log(
    `  runs: ${runData.length}   in run>=2: ${in2} (${((in2 / parcels.length) * 100).toFixed(1)}%)   >=4: ${in4} (${((in4 / parcels.length) * 100).toFixed(1)}%)   >=8: ${in8} (${((in8 / parcels.length) * 100).toFixed(1)}%)`,
  );
  console.log(`  longest run: ${Math.max(0, ...runData.map((r) => r.p.length))} parcels`);
  const fmtU = (u) =>
    `${u.toFixed(2)}u (${(u * METERS_PER_UNIT).toFixed(1)}m / ${((u * METERS_PER_UNIT) / 0.3048).toFixed(0)}ft)`;
  console.log(
    `  party-wall length  p25 ${fmtU(pct(wallLens, 0.25))}  median ${fmtU(pct(wallLens, 0.5))}  p75 ${fmtU(pct(wallLens, 0.75))}`,
  );
  console.log(
    `  LOT WIDTH along run p10 ${fmtU(pct(allWidths, 0.1))}  p25 ${fmtU(pct(allWidths, 0.25))}  median ${fmtU(pct(allWidths, 0.5))}  p75 ${fmtU(pct(allWidths, 0.75))}  p90 ${fmtU(pct(allWidths, 0.9))}`,
  );
  const runLens = runData.map((r) => r.len);
  console.log(
    `  RUN frontage length p25 ${fmtU(pct(runLens, 0.25))}  median ${fmtU(pct(runLens, 0.5))}  p75 ${fmtU(pct(runLens, 0.75))}  p95 ${fmtU(pct(runLens, 0.95))}`,
  );

  // Coverage: where the OBJ actually has parcels, per game district.
  const byDistrict = new Map();
  for (let p = 0; p < parcels.length; p++) {
    const d = district[p];
    let s = byDistrict.get(d);
    if (!s) byDistrict.set(d, (s = { n: 0, att: 0, r4: 0, w: [], rs: [] }));
    s.n++;
    if (deg[p] > 0) s.att++;
    if (runLenOf[p] >= 4) s.r4++;
    if (runOf[p] !== -1) {
      s.w.push(...runData[runOf[p]].w);
      s.rs.push(runData[runOf[p]].p.length);
    }
  }
  const rows = [...byDistrict.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log("");
  console.log("per-district (OBJ parcels only):");
  console.log("  district                     parcels  attached%  run>=4%  medLotW");
  for (const [name, s] of rows) {
    console.log(
      `  ${name.padEnd(28)} ${String(s.n).padStart(6)}  ${((s.att / s.n) * 100).toFixed(1).padStart(8)}%  ${((s.r4 / s.n) * 100).toFixed(1).padStart(6)}%  ${pct(s.w, 0.5).toFixed(2).padStart(6)}u`,
    );
  }
  const missing = boxes.map((b) => b.name).filter((n) => !byDistrict.has(n));
  console.log("");
  console.log(
    `districts with ZERO OBJ parcels (heuristic fallback only): ${missing.length}/${boxes.length}`,
  );
  console.log(`  ${missing.join(", ")}`);

  // A box fully swallowed by an EARLIER box can never be returned by
  // districtAt's first-inside-wins loop. Reported here because a district that
  // shows zero parcels for THAT reason is a map bug, not a coverage gap.
  const shadowed = boxes.filter((b, i) =>
    boxes.some(
      (a, j) =>
        j < i && a.uMin <= b.uMin && a.uMax >= b.uMax && a.vMin <= b.vMin && a.vMax >= b.vMax,
    ),
  );
  if (shadowed.length > 0) {
    console.log(
      `UNREACHABLE district boxes (fully inside an earlier box, districtAt can never return them): ${shadowed.map((b) => b.name).join(", ")}`,
    );
  }

  let uMin = 1;
  let uMax = 0;
  let vMin = 1;
  let vMax = 0;
  for (let p = 0; p < parcels.length; p++) {
    for (const [x, z] of parcels[p].ring) {
      const u = x / WORLD_W + 0.5;
      const v = z / WORLD_H + 0.5;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
  }
  console.log(
    `OBJ parcel span: u ${uMin.toFixed(3)}..${uMax.toFixed(3)}  v ${vMin.toFixed(3)}..${vMax.toFixed(3)}`,
  );

  // --- EMIT ---------------------------------------------------------------
  // parcels[i].id === index into SF_FOOTPRINTS (asserted above).
  //   r     flat CCW ring [x0,z0,x1,z1,...], world units, 0.1-quantized
  //   h     height, world units
  //   d     district name (sf-map.ts districtAt rule, parcel centroid)
  //   nb    [{ q, e:[ring edge indices that ARE the party wall], l: length }]
  //         edge i spans r[i] -> r[(i+1) % n]
  //   f     longest NON-party-wall edge index (the face to put a front on), or -1
  //   run   index into runs, or -1
  //   bbox  1 when the ring is a bbox rectangle (roof loop unrecoverable) —
  //         such a ring can never be coincident, so its `nb` is unreliable
  //   s     1 when the centroid falls inside ANOTHER parcel (height-band or
  //         building-part duplicate) — do not extrude these as separate lots
  const out = {
    meta: {
      source: objPath.split("/").pop(),
      generator: "tools/sf-data/extract-adjacency-obj.mjs",
      cal: CAL,
      calSy: CAL_SY,
      metersPerUnit: METERS_PER_UNIT,
      world: { w: WORLD_W, h: WORLD_H, gridX: GRID_X, gridZ: GRID_Z },
      eps: EPS,
      minOverlap: MIN_OVERLAP,
      runCosDeg: 38,
      parcelIdsIndex: "src/world/sf-footprints.ts SF_FOOTPRINTS",
      span: { uMin, uMax, vMin, vMax },
    },
    stats: {
      parcels: parcels.length,
      attached,
      pairs: walls.size,
      runs: runData.length,
      inRun2: in2,
      inRun4: in4,
      inRun8: in8,
      lotWidth: {
        p10: pct(allWidths, 0.1),
        p25: pct(allWidths, 0.25),
        p50: pct(allWidths, 0.5),
        p75: pct(allWidths, 0.75),
        p90: pct(allWidths, 0.9),
      },
      runLength: {
        p25: pct(runLens, 0.25),
        p50: pct(runLens, 0.5),
        p75: pct(runLens, 0.75),
        p95: pct(runLens, 0.95),
      },
      runSizeHist,
      lotWidthHist: Object.fromEntries(
        W_BINS.map((t, i) => [`<=${t}`, wh[i]]).concat([
          [`>${W_BINS[W_BINS.length - 1]}`, wh[W_BINS.length]],
        ]),
      ),
      wallLength: { p25: pct(wallLens, 0.25), p50: pct(wallLens, 0.5), p75: pct(wallLens, 0.75) },
      degreeHist: Object.fromEntries(
        [0, 1, 2, 3]
          .map((d) => [String(d), deg.filter((x) => x === d).length])
          .concat([["4+", deg.filter((x) => x >= 4).length]]),
      ),
      roofLoopRings: { n: realIds.length, attached: realIds.filter((i) => deg[i] > 0).length },
      bboxFallbackRings: { n: bboxIds.length, attached: bboxIds.filter((i) => deg[i] > 0).length },
      stackedParcels: nStacked,
      unreachableDistrictBoxes: shadowed.map((b) => b.name),
      // Per-district LOT RHYTHM. This is the table the frontage walk should
      // sample when it has no real parcel: a width band and a run size, per
      // district, measured off the real fabric instead of rng.range().
      byDistrict: Object.fromEntries(
        rows.map(([name, s]) => [
          name,
          {
            n: s.n,
            attached: s.att,
            inRun4: s.r4,
            lotWidth: { p25: pct(s.w, 0.25), p50: pct(s.w, 0.5), p75: pct(s.w, 0.75) },
            medRunSize: pct(s.rs, 0.5),
          },
        ]),
      ),
      districtsWithNoParcels: missing,
      // For the uncovered districts: the nearest district (same character
      // first) that DOES have measured rhythm, so the heuristic walk can
      // borrow a real distribution instead of inventing one.
      donorForUncovered: Object.fromEntries(
        missing
          .map((name) => {
            const b = boxes.find((x) => x.name === name);
            const cu = (b.uMin + b.uMax) / 2;
            const cv = (b.vMin + b.vMax) / 2;
            let pick = null;
            let pd = Infinity;
            for (const [dn] of rows) {
              const db = boxes.find((x) => x.name === dn);
              if (!db) continue;
              const sameChar = db.character === b.character;
              const d =
                Math.hypot((db.uMin + db.uMax) / 2 - cu, (db.vMin + db.vMax) / 2 - cv) +
                (sameChar ? 0 : 1.5);
              if (d < pd) {
                pd = d;
                pick = dn;
              }
            }
            return [name, pick];
          })
          .filter(([, v]) => v),
      ),
    },
    parcels: parcels.map((p, i) => {
      const flat = [];
      for (const [x, z] of p.ring) flat.push(x, z);
      const wallEdges = new Set();
      for (const n of nb[i]) for (const e of n.edges) wallEdges.add(e);
      let front = -1;
      let bestLen = 0;
      for (let e = 0; e < p.ring.length; e++) {
        if (wallEdges.has(e)) continue;
        const [x0, z0] = p.ring[e];
        const [x1, z1] = p.ring[(e + 1) % p.ring.length];
        const L = Math.hypot(x1 - x0, z1 - z0);
        if (L > bestLen) {
          bestLen = L;
          front = e;
        }
      }
      return {
        id: i,
        h: p.h,
        r: flat,
        d: district[i],
        nb: nb[i].map((n) => ({ q: n.q, e: n.edges, l: n.len })),
        f: front,
        run: runOf[i],
        bbox: p.bboxFallback ? 1 : 0,
        s: stacked[i],
      };
    }),
    runs: runData,
  };
  writeFileSync(outPath, JSON.stringify(out));
  console.log("");
  console.log(`wrote ${outPath}`);
}
