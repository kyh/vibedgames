// Bake the VECTOR road network from the raw OSM dump — the source of truth
// for the vector-first world: rendering sweeps geometry along these edges,
// traffic drives them, buildings align to them. Also re-emits the raster mask
// (sf-streets.ts) derived from the SAME polylines (supercover + bake-time
// thinning), so raster consumers (lots, districts, minimap fallback) can never
// disagree with the vectors.
//
// Usage: node bake-network.mjs
// Reads sf-streets.raw.json (Overpass `out geom`; fetch-streets.sh recreates).

import { readFileSync, writeFileSync } from "node:fs";

// --- Must match src/shared/constants.ts ---
const GRID_X = 244;
const GRID_Z = 200;
const ROAD_TILE = 13;
const WORLD_W = GRID_X * ROAD_TILE;
const WORLD_H = GRID_Z * ROAD_TILE;

// Calibrated projection (see calibrate.mjs; R² ~0.999 vs the game's hills).
const U_M = 6.2462, U_B = 765.2557;
const V_M = -9.6095, V_B = 363.344;
const projU = (lon) => U_M * lon + U_B;
const projV = (lat) => V_M * lat + V_B;

// --- landFactor, kept in sync with src/world/sf-map.ts ---
function smooth(x, a, b) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function box(u, v, uMin, uMax, vMin, vMax) {
  const fu = Math.min(smooth(u, uMin - 0.02, uMin + 0.01), 1 - smooth(u, uMax - 0.01, uMax + 0.02));
  const fv = Math.min(smooth(v, vMin - 0.02, vMin + 0.01), 1 - smooth(v, vMax - 0.01, vMax + 0.02));
  return Math.min(fu, fv);
}
function lineSide(u, v, ax, ay, bx, by) {
  return (bx - ax) * (v - ay) - (by - ay) * (u - ax);
}
function landFactor(u, v) {
  let land = Math.min(smooth(u, 0.025, 0.06), 1 - smooth(u, 0.78, 0.85), smooth(v, 0.025, 0.07));
  land = Math.min(land, smooth(lineSide(u, v, 0.03, 0.26, 0.25, 0.03), -0.015, 0.02));
  land = Math.max(land, box(u, v, 0.82, 0.99, 0.7, 0.84));
  land = Math.max(land, box(u, v, 0.82, 0.98, 0.87, 0.97));
  land = Math.min(land, 1 - box(u, v, 0.71, 0.8, 0.29, 0.35));
  land = Math.min(land, 1 - box(u, v, 0.71, 0.82, 0.57, 0.63));
  land = Math.min(land, 1 - box(u, v, 0.08, 0.18, 0.72, 0.86));
  return land;
}
const onLandUV = (u, v) => landFactor(u, v) > 0.5;
const onLandXZ = (x, z) => onLandUV(x / WORLD_W + 0.5, z / WORLD_H + 0.5);

// Road classes → asphalt HALF width (world units). Wider majors read as real
// boulevards; tertiary matches the old uniform profile (ASPHALT_W/2 = 5.2).
// Freeways (motorway/trunk + ramps) are multi-level structures we would
// render flat — pure spaghetti. Everything else is in: SF's identity IS the
// fine residential grid (Sunset/Richmond/Mission blocks).
const CLASS_HALF = {
  primary: 7.2, primary_link: 5.8,
  secondary: 6.4, secondary_link: 5.8,
  tertiary: 5.8, tertiary_link: 5.8,
  residential: 4.6, unclassified: 4.6, living_street: 4.2,
};
// Arcade compression (Driver:SF-style): minors only survive when they are
// long connective streets — short block-fillers go, majors read as the map.
const MINOR_MIN_LEN = 35; // world units (~310m real) — density reads as city
// Only divided arterials get twin-merged — the residential grid has genuine
// close parallels that must never be eaten.
const MERGE_MIN_HALF = 5.6;

// --- Load + project (majors only: the arterial network IS the game map) ---
const raw = JSON.parse(readFileSync(new URL("./sf-streets.raw.json", import.meta.url)));
const ways = raw.elements.filter(
  (e) => e.type === "way" && e.geometry && CLASS_HALF[e.tags?.highway] !== undefined,
);
console.log(`ways kept (arterials): ${ways.length}`);

// World-space polylines, split wherever they leave land.
const polylines = []; // { pts: [[x,z],...], half }
for (const w of ways) {
  const half = CLASS_HALF[w.tags.highway];
  let cur = [];
  for (const g of w.geometry) {
    const u = projU(g.lon);
    const v = projV(g.lat);
    const x = (u - 0.5) * WORLD_W;
    const z = (v - 0.5) * WORLD_H;
    if (onLandUV(u, v)) cur.push([x, z]);
    else {
      if (cur.length >= 2) polylines.push({ pts: cur, half });
      cur = [];
    }
  }
  if (cur.length >= 2) polylines.push({ pts: cur, half });
}

// Arcade compression: drop short minor streets entirely.
{
  const plLen = (pts) => {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1]);
    return L;
  };
  const before = polylines.length;
  const isMinor = (half) => half <= 4.6;
  // Group way fragments back by rough identity: filter per-polyline is enough
  // (fragments of one long street are individually long).
  const kept = polylines.filter((pl) => !isMinor(pl.half) || plLen(pl.pts) >= MINOR_MIN_LEN);

  // --- Parity thinning: at 1x the full residential grid leaves no room for
  // buildings. Streets come in parallel families (E-W rows, N-S columns);
  // keeping every OTHER lattice line doubles block size and stays connected
  // by construction (the kept rows/columns still cross). Diagonals and
  // arterials are never touched.
  const SPACING = 25; // typical minor spacing in world units at 1x (~100m)
  const thinnedOut = [];
  for (const pl of kept) {
    if (!isMinor(pl.half)) {
      thinnedOut.push(pl);
      continue;
    }
    const [x0, z0] = pl.pts[0];
    const [x1, z1] = pl.pts[pl.pts.length - 1];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const L = Math.hypot(dx, dz) || 1;
    let meanX = 0;
    let meanZ = 0;
    for (const [x, z] of pl.pts) {
      meanX += x;
      meanZ += z;
    }
    meanX /= pl.pts.length;
    meanZ /= pl.pts.length;
    let lattice = null;
    if (Math.abs(dx) / L > 0.8) lattice = meanZ; // E-W street -> row coord
    else if (Math.abs(dz) / L > 0.8) lattice = meanX; // N-S street -> column coord
    if (lattice === null) {
      thinnedOut.push(pl); // diagonal / curvy — keep
      continue;
    }
    if (Math.round(lattice / SPACING) % 2 === 0) thinnedOut.push(pl);
  }
  polylines.length = 0;
  polylines.push(...thinnedOut);
  console.log(
    `minor-street compression: ${before} -> ${kept.length} -> ${polylines.length} polylines (parity-thinned)`,
  );
}

// --- Junction detection by shared vertex (OSM ways reference shared nodes,
// so intersecting streets carry an IDENTICAL lat/lon vertex). ---
const useCount = new Map(); // quantized "x,z" -> count
const K = (p) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
for (const pl of polylines) {
  for (let i = 0; i < pl.pts.length; i++) {
    const k = K(pl.pts[i]);
    // Endpoints always count as potential nodes; interiors count once per way.
    useCount.set(k, (useCount.get(k) ?? 0) + 1);
  }
}

// --- Split polylines at junction vertices → primitive edges ---
const nodeIds = new Map(); // key -> node index
const nodes = []; // [x, z]
const nodeAt = (p) => {
  const k = K(p);
  let id = nodeIds.get(k);
  if (id === undefined) {
    id = nodes.length;
    nodeIds.set(k, id);
    nodes.push([p[0], p[1]]);
  }
  return id;
};
let edges = []; // { a, b, half, pts: [[x,z],...] including endpoints }
for (const pl of polylines) {
  let start = 0;
  for (let i = 1; i < pl.pts.length; i++) {
    const isEnd = i === pl.pts.length - 1;
    const shared = (useCount.get(K(pl.pts[i])) ?? 0) >= 2;
    if (isEnd || shared) {
      const pts = pl.pts.slice(start, i + 1);
      if (pts.length >= 2) {
        edges.push({ a: nodeAt(pts[0]), b: nodeAt(pts[pts.length - 1]), half: pl.half, pts });
      }
      start = i;
    }
  }
}

// --- Merge degree-2 nodes (chain edges through cosmetic joints) ---
function degreeMap() {
  const deg = new Map();
  for (const e of edges) {
    deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
    deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
  }
  return deg;
}
let merged = true;
while (merged) {
  merged = false;
  const deg = degreeMap();
  const byNode = new Map();
  edges.forEach((e, i) => {
    for (const n of [e.a, e.b]) {
      if (!byNode.has(n)) byNode.set(n, []);
      byNode.get(n).push(i);
    }
  });
  const dead = new Set();
  for (const [n, idxs] of byNode) {
    if (deg.get(n) !== 2 || idxs.length !== 2) continue;
    const [i1, i2] = idxs;
    if (dead.has(i1) || dead.has(i2) || i1 === i2) continue;
    const e1 = edges[i1], e2 = edges[i2];
    if (e1.a === e1.b || e2.a === e2.b) continue; // loops stay
    // Orient e1 to END at n, e2 to START at n.
    const p1 = e1.b === n ? e1.pts : [...e1.pts].reverse();
    const a = e1.b === n ? e1.a : e1.b;
    const p2 = e2.a === n ? e2.pts : [...e2.pts].reverse();
    const b = e2.a === n ? e2.b : e2.a;
    if (a === b) continue; // would collapse to a loop
    edges[i1] = { a, b, half: Math.max(e1.half, e2.half), pts: [...p1, ...p2.slice(1)] };
    dead.add(i2);
    merged = true;
  }
  if (dead.size > 0) edges = edges.filter((_, i) => !dead.has(i));
}

// --- Simplify edge shapes (RDP, world units) ---
function rdp(pts, eps) {
  if (pts.length <= 2) return pts;
  const [x0, z0] = pts[0];
  const [x1, z1] = pts[pts.length - 1];
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz) || 1;
  let maxD = -1, maxI = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const d = Math.abs((pts[i][0] - x0) * dz - (pts[i][1] - z0) * dx) / len;
    if (d > maxD) { maxD = d; maxI = i; }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const l = rdp(pts.slice(0, maxI + 1), eps);
  const r = rdp(pts.slice(maxI), eps);
  return [...l.slice(0, -1), ...r];
}
for (const e of edges) e.pts = rdp(e.pts, 2.5);

// Drop degenerate stubs (sub-8u dead-end whiskers clutter junctions).
{
  const deg = degreeMap();
  const len = (e) => {
    let L = 0;
    for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i][0] - e.pts[i-1][0], e.pts[i][1] - e.pts[i-1][1]);
    return L;
  };
  edges = edges.filter((e) => {
    const stub = deg.get(e.a) === 1 || deg.get(e.b) === 1;
    return !(stub && len(e) < 8);
  });
}

// --- Merge dual carriageways: OSM maps divided arterials as TWO parallel
// one-way ways which sweep into overlapping roads; junction clustering
// (below) then aligns more twins, so both passes run twice. ---
function mergeParallelPass() {
  const MERGE_DIST = 11; // < combined road widths; still << grid spacing (~22u)
  const samplesOf = (e, step) => {
    const out = [];
    let acc = 0;
    for (let i = 1; i < e.pts.length; i++) {
      const [ax, az] = e.pts[i - 1];
      const [bx, bz] = e.pts[i];
      const segLen = Math.hypot(bx - ax, bz - az);
      let t = acc === 0 ? 0 : step - acc;
      while (t <= segLen) {
        out.push([ax + ((bx - ax) * t) / segLen, az + ((bz - az) * t) / segLen]);
        t += step;
      }
      acc = (acc + segLen) % step;
    }
    if (out.length === 0) out.push(e.pts[0]);
    return out;
  };
  const edgeLen = (e) => {
    let L = 0;
    for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i][0] - e.pts[i-1][0], e.pts[i][1] - e.pts[i-1][1]);
    return L;
  };
  const lens = edges.map(edgeLen);
  // Distance from a point to an edge + the tangent of the nearest segment.
  const nearestOnEdge = (x, z, e) => {
    let best = Infinity, tx = 1, tz = 0;
    for (let i = 1; i < e.pts.length; i++) {
      const [ax, az] = e.pts[i - 1];
      const [bx, bz] = e.pts[i];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 1e-8 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / l2, 0), 1) : 0;
      const px = ax + dx * t, pz = az + dz * t;
      const d = Math.hypot(px - x, pz - z);
      if (d < best) {
        best = d;
        const dl = Math.sqrt(l2) || 1;
        tx = dx / dl; tz = dz / dl;
      }
    }
    return { d: best, tx, tz };
  };
  // Coarse bucket of edge ids by their AABB (padded) for candidate lookup.
  const CELL = 60;
  const buckets = new Map();
  edges.forEach((e, i) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of e.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    for (let bx = Math.floor((x0 - 8) / CELL); bx <= Math.floor((x1 + 8) / CELL); bx++)
      for (let bz = Math.floor((z0 - 8) / CELL); bz <= Math.floor((z1 + 8) / CELL); bz++) {
        const k = bx + "," + bz;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(i);
      }
  });
  const removed = new Set();
  const order = edges.map((_, i) => i).sort((a, b) => lens[a] - lens[b]); // shortest first
  for (const bi of order) {
    const B = edges[bi];
    if (B.half < MERGE_MIN_HALF) continue; // arterial carriageways only
    if (lens[bi] < 20) continue; // junction connectors are never "twins"
    const samples = samplesOf(B, 8);
    // Local tangent per sample (for the parallel check).
    const sampleTans = samples.map((p, i) => {
      const q = samples[Math.min(i + 1, samples.length - 1)];
      const r = samples[Math.max(i - 1, 0)];
      const dx = q[0] - r[0], dz = q[1] - r[1];
      const dl = Math.hypot(dx, dz) || 1;
      return [dx / dl, dz / dl];
    });
    // Candidate longer edges from B's buckets.
    const cand = new Set();
    for (const [x, z] of samples) {
      for (const id of buckets.get(Math.floor(x / CELL) + "," + Math.floor(z / CELL)) ?? []) {
        if (id !== bi && !removed.has(id) && lens[id] >= lens[bi] && edges[id].half >= MERGE_MIN_HALF) cand.add(id);
      }
    }
    for (const ai of cand) {
      const A = edges[ai];
      let covered = 0;
      for (let si = 0; si < samples.length; si++) {
        const [x, z] = samples[si];
        const hit = nearestOnEdge(x, z, A);
        if (hit.d >= MERGE_DIST) continue;
        // Must run PARALLEL to A there — cross streets stay.
        const [btx, btz] = sampleTans[si];
        if (Math.abs(hit.tx * btx + hit.tz * btz) < 0.8) continue;
        covered++;
      }
      if (covered >= samples.length * 0.9) {
        removed.add(bi);
        edges[ai] = { ...A, half: Math.max(A.half, B.half) };
        break;
      }
    }
  }
  edges = edges.filter((_, i) => !removed.has(i));
  console.log(`parallel-merge removed ${removed.size} carriageway twins`);
  // Median connectors between the twins become stubs — drop generously.
  const deg = degreeMap();
  edges = edges.filter((e) => {
    const stub = deg.get(e.a) === 1 || deg.get(e.b) === 1;
    let L = 0;
    for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i][0] - e.pts[i-1][0], e.pts[i][1] - e.pts[i-1][1]);
    return !(stub && L < 14);
  });
}

// Junction clustering: contract edges too short to render — they draw as
// floating road slivers; fusing the node cluster makes one junction.
function clusterJunctionsPass() {
  const CONTRACT_LEN = 9; // 1x units: merge near-coincident junction clusters
  const eLen = (e) => {
    let L = 0;
    for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i][0] - e.pts[i-1][0], e.pts[i][1] - e.pts[i-1][1]);
    return L;
  };
  let changed = true;
  let contracted = 0;
  while (changed) {
    changed = false;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (!e || e.a === e.b || eLen(e) >= CONTRACT_LEN) continue;
      const keep = e.a, drop = e.b;
      nodes[keep] = [(nodes[keep][0] + nodes[drop][0]) / 2, (nodes[keep][1] + nodes[drop][1]) / 2];
      for (const f of edges) {
        if (!f) continue;
        if (f.a === drop) f.a = keep;
        if (f.b === drop) f.b = keep;
      }
      edges[i] = null;
      contracted++;
      changed = true;
    }
    edges = edges.filter(Boolean);
    // Self-loops from contraction + duplicate parallels between one node pair.
    const seen = new Set();
    edges = edges.filter((f) => {
      if (f.a === f.b && eLen(f) < 40) return false;
      const k = Math.min(f.a, f.b) + "_" + Math.max(f.a, f.b);
      if (f.a !== f.b && seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  // Snap polylines to the (possibly moved) node positions.
  for (const e of edges) {
    e.pts[0] = [nodes[e.a][0], nodes[e.a][1]];
    e.pts[e.pts.length - 1] = [nodes[e.b][0], nodes[e.b][1]];
    e.pts = rdp(e.pts, 2.5);
  }
  console.log(`junction clustering contracted ${contracted} sliver edges`);
}

mergeParallelPass();
clusterJunctionsPass();
mergeParallelPass();
clusterJunctionsPass();

// --- Largest connected component ---
{
  const adj = new Map();
  edges.forEach((e, i) => {
    for (const [from, to] of [[e.a, e.b], [e.b, e.a]]) {
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from).push(to);
    }
  });
  const comp = new Map();
  let nComp = 0;
  for (const n of adj.keys()) {
    if (comp.has(n)) continue;
    const stack = [n];
    comp.set(n, nComp);
    while (stack.length) {
      const c = stack.pop();
      for (const m of adj.get(c) ?? []) {
        if (!comp.has(m)) { comp.set(m, nComp); stack.push(m); }
      }
    }
    nComp++;
  }
  const sizes = new Array(nComp).fill(0);
  for (const c of comp.values()) sizes[c]++;
  const main = sizes.indexOf(Math.max(...sizes));
  edges = edges.filter((e) => comp.get(e.a) === main);
  console.log(`components: ${nComp}, kept main with ${sizes[main]} nodes`);
}

// --- Junction sanity: >4 arms reads as street soup in-game. Drop the
// narrowest (then shortest) MINOR arms until every node has <= 4. ---
{
  let dropped = 0;
  let changed = true;
  while (changed) {
    changed = false;
    const byNode = new Map();
    edges.forEach((e, i) => {
      if (!byNode.has(e.a)) byNode.set(e.a, []);
      if (!byNode.has(e.b)) byNode.set(e.b, []);
      byNode.get(e.a).push(i);
      byNode.get(e.b).push(i);
    });
    const kill = new Set();
    for (const [, list] of byNode) {
      if (list.length <= 4) continue;
      const edgeLen = (e) => {
        let L = 0;
        for (let i = 1; i < e.pts.length; i++) {
          L += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]);
        }
        return L;
      };
      const candidates = list
        .filter((i) => !kill.has(i) && edges[i].half <= 4.6)
        .sort((x, y) => edges[x].half - edges[y].half || edgeLen(edges[x]) - edgeLen(edges[y]));
      let excess = list.filter((i) => !kill.has(i)).length - 4;
      for (const i of candidates) {
        if (excess <= 0) break;
        kill.add(i);
        excess--;
      }
    }
    if (kill.size > 0) {
      edges = edges.filter((_, i) => !kill.has(i));
      dropped += kill.size;
      changed = true;
    }
  }
  console.log(`junction sanity: dropped ${dropped} excess minor arms`);
  // Arm drops can orphan small sub-graphs — keep the main component again.
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push(e.b);
    adj.get(e.b).push(e.a);
  }
  const comp = new Map();
  let nComp = 0;
  for (const n of adj.keys()) {
    if (comp.has(n)) continue;
    const stack = [n];
    comp.set(n, nComp);
    while (stack.length) {
      const c = stack.pop();
      for (const m of adj.get(c) ?? []) {
        if (!comp.has(m)) { comp.set(m, nComp); stack.push(m); }
      }
    }
    nComp++;
  }
  const sizes = new Array(nComp).fill(0);
  for (const c of comp.values()) sizes[c]++;
  const main = sizes.indexOf(Math.max(...sizes));
  edges = edges.filter((e) => comp.get(e.a) === main);
}

// --- Compact node table (only referenced nodes) ---
{
  const remap = new Map();
  const outNodes = [];
  const idFor = (n) => {
    let id = remap.get(n);
    if (id === undefined) { id = outNodes.length; remap.set(n, id); outNodes.push(nodes[n]); }
    return id;
  };
  for (const e of edges) { e.a = idFor(e.a); e.b = idFor(e.b); }
  nodes.length = 0;
  nodes.push(...outNodes);
}

// --- Streets v3: octilinear snap (grid-native network) ---
// Nodes snap to a half-tile lattice and merge when co-located; every edge
// re-routes as at most two runs (one 45° diagonal + one axis-aligned), the
// bend chosen to hug the original polyline's midpoint. The emitted network
// is octilinear — the runtime needs no snapping code at all.
{
  const LATTICE = ROAD_TILE / 2;
  const snapC = (v) => Math.round(v / LATTICE) * LATTICE;
  // snap + merge co-located nodes
  const byPos = new Map();
  const redirect = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const sx = snapC(nodes[i][0]);
    const sz = snapC(nodes[i][1]);
    const key = `${sx},${sz}`;
    const hit = byPos.get(key);
    if (hit === undefined) {
      byPos.set(key, i);
      nodes[i] = [sx, sz];
      redirect[i] = i;
    } else {
      redirect[i] = hit;
    }
  }
  let merged = 0;
  for (const e of edges) {
    if (redirect[e.a] !== e.a || redirect[e.b] !== e.b) merged++;
    e.a = redirect[e.a];
    e.b = redirect[e.b];
  }
  // octilinear re-route
  const route = (ax, az, bx, bz, midX, midZ) => {
    const dx = bx - ax;
    const dz = bz - az;
    const adx = Math.abs(dx);
    const adz = Math.abs(dz);
    if (adx < 1e-6 || adz < 1e-6 || Math.abs(adx - adz) < 1e-6) return [[ax, az], [bx, bz]];
    const d = Math.min(adx, adz);
    const sx = Math.sign(dx);
    const sz = Math.sign(dz);
    const k1 = [ax + sx * d, az + sz * d];
    const k2 = [bx - sx * d, bz - sz * d];
    const d1 = Math.hypot(k1[0] - midX, k1[1] - midZ);
    const d2 = Math.hypot(k2[0] - midX, k2[1] - midZ);
    const k = d1 <= d2 ? k1 : k2;
    return [[ax, az], k, [bx, bz]];
  };
  edges = edges.filter((e) => {
    if (e.a === e.b) return false;
    const a = nodes[e.a];
    const b = nodes[e.b];
    if (a[0] === b[0] && a[1] === b[1]) return false;
    const mid = e.pts[Math.floor(e.pts.length / 2)] ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    e.pts = route(a[0], a[1], b[0], b[1], mid[0], mid[1]);
    return true;
  });
  console.log(`octilinear: merged ${merged} edge endpoints onto lattice nodes, ${edges.length} edges routed`);
  // snapping can orphan sub-graphs — keep the main component once more
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push(e.b);
    adj.get(e.b).push(e.a);
  }
  const comp = new Map();
  let nComp = 0;
  for (const n of adj.keys()) {
    if (comp.has(n)) continue;
    const stack = [n];
    comp.set(n, nComp);
    while (stack.length) {
      const c = stack.pop();
      for (const m of adj.get(c) ?? []) {
        if (!comp.has(m)) { comp.set(m, nComp); stack.push(m); }
      }
    }
    nComp++;
  }
  const sizes = new Array(nComp).fill(0);
  for (const c of comp.values()) sizes[c]++;
  const main = sizes.indexOf(Math.max(...sizes));
  edges = edges.filter((e) => comp.get(e.a) === main);
  // recompact the node table
  const remap = new Map();
  const outNodes = [];
  const idFor = (n) => {
    let id = remap.get(n);
    if (id === undefined) { id = outNodes.length; remap.set(n, id); outNodes.push(nodes[n]); }
    return id;
  };
  for (const e of edges) { e.a = idFor(e.a); e.b = idFor(e.b); }
  nodes.length = 0;
  nodes.push(...outNodes);
}

// --- Stats + validation ---
let totalLen = 0;
for (const e of edges) {
  for (let i = 1; i < e.pts.length; i++) {
    totalLen += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]);
    if (!Number.isFinite(e.pts[i][0]) || !Number.isFinite(e.pts[i][1])) throw new Error("NaN vertex");
  }
}
console.log(`nodes: ${nodes.length}, edges: ${edges.length}, total ${Math.round(totalLen / 1000)}k units`);
if (nodes.length < 400 || edges.length < 600) throw new Error("suspiciously small network");

// --- Raster mask derived from the SAME edges (supercover + thinning) ---
const grid = new Uint8Array(GRID_X * GRID_Z);
const gridMajor = new Uint8Array(GRID_X * GRID_Z);
let markMajor = false;
const toG = (x, z) => [
  Math.floor((x / WORLD_W + 0.5) * GRID_X),
  Math.floor((z / WORLD_H + 0.5) * GRID_Z),
];
function rasterizeSeg(gx0, gz0, gx1, gz1) {
  let x = gx0, z = gz0;
  const dx = Math.abs(gx1 - gx0), dz = Math.abs(gz1 - gz0);
  const sx = gx0 < gx1 ? 1 : -1, sz = gz0 < gz1 ? 1 : -1;
  let err = dx - dz;
  const mark = (cx, cz) => {
    if (cx >= 0 && cz >= 0 && cx < GRID_X && cz < GRID_Z) {
      grid[cx * GRID_Z + cz] = 1;
      if (markMajor) gridMajor[cx * GRID_Z + cz] = 1;
    }
  };
  let steps = 0;
  const maxSteps = dx + dz + 4;
  while (steps++ < maxSteps) {
    mark(x, z);
    if (x === gx1 && z === gz1) break;
    const e2 = 2 * err;
    // Mark after EACH axis move: when both fire in one iteration this fills
    // the corner cell, keeping the line 4-connected (true supercover).
    if (e2 > -dz) { err -= dz; x += sx; mark(x, z); }
    if (e2 < dx) { err += dx; z += sz; mark(x, z); }
  }
}
for (const e of edges) {
  markMajor = e.half >= 6.4; // primary/secondary carry the "major" class
  for (let i = 1; i < e.pts.length; i++) {
    const [ax, az] = e.pts[i - 1];
    const [bx, bz] = e.pts[i];
    const [g0x, g0z] = toG(ax, az);
    const [g1x, g1z] = toG(bx, bz);
    rasterizeSeg(g0x, g0z, g1x, g1z);
  }
}
markMajor = false;
// Bake-time thinning (ported from src/world/thin-streets.ts).
function thin(road, sizeX, sizeZ) {
  const at = (x, z) => x >= 0 && z >= 0 && x < sizeX && z < sizeZ && road[x * sizeZ + z] === 1;
  const RING = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
  const inSquare = (x, z) => {
    for (const dx of [-1, 1]) for (const dz of [-1, 1])
      if (at(x + dx, z) && at(x, z + dz) && at(x + dx, z + dz)) return true;
    return false;
  };
  const removable = (x, z) => {
    let n4 = 0;
    const ring = [];
    for (let i = 0; i < 8; i++) {
      const r = at(x + RING[i][0], z + RING[i][1]);
      ring.push(r);
      if (r && i % 2 === 0) n4++;
    }
    if (n4 < 2 || !inSquare(x, z)) return false;
    let arcs = 0, all = true;
    for (let i = 0; i < 8; i++) {
      if (!ring[i]) { all = false; continue; }
      if (ring[(i + 7) % 8]) continue;
      for (let j = i; ring[j % 8] && j < i + 8; j++) {
        if (j % 2 === 0) { arcs++; break; }
      }
    }
    return all || arcs === 1;
  };
  for (let sweep = 0; sweep < 12; sweep++) {
    let changed = false;
    for (const peel of [[0,-1],[1,0],[0,1],[-1,0]]) {
      for (let x = 0; x < sizeX; x++) for (let z = 0; z < sizeZ; z++) {
        if (road[x * sizeZ + z] !== 1) continue;
        if (at(x + peel[0], z + peel[1])) continue;
        if (!removable(x, z)) continue;
        road[x * sizeZ + z] = 0;
        changed = true;
      }
    }
    if (!changed) break;
  }
}
function maskComponents(g) {
  const at = (x, z) => x >= 0 && z >= 0 && x < GRID_X && z < GRID_Z && g[x * GRID_Z + z] === 1;
  const seen = new Set();
  const sizes = [];
  for (let x = 0; x < GRID_X; x++) for (let z = 0; z < GRID_Z; z++) {
    if (!at(x, z) || seen.has(x * GRID_Z + z)) continue;
    let n = 0;
    const st = [[x, z]];
    seen.add(x * GRID_Z + z);
    while (st.length) {
      const c = st.pop();
      n++;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = c[0] + dx, nz = c[1] + dz;
        if (at(nx, nz) && !seen.has(nx * GRID_Z + nz)) { seen.add(nx * GRID_Z + nz); st.push([nx, nz]); }
      }
    }
    sizes.push(n);
  }
  sizes.sort((a, b) => b - a);
  return sizes;
}
const pre = maskComponents(grid);
console.log(`pre-thin components: ${pre.length}, top: ${pre.slice(0, 5).join(",")}`);
thin(grid, GRID_X, GRID_Z);
const post = maskComponents(grid);
console.log(`post-thin components: ${post.length}, top: ${post.slice(0, 5).join(",")}`);
let roadCells = 0;
for (const v of grid) roadCells += v;
console.log(`mask road cells: ${roadCells}`);
if (roadCells < 3000 || roadCells > 60000) throw new Error("mask cell count out of range");

// --- Emit sf-streets.ts (same format as before — drop-in) ---
const cols = [];
const colsMajor = [];
for (let gx = 0; gx < GRID_X; gx++) {
  let bits = "";
  for (let gz = 0; gz < GRID_Z; gz++) bits += grid[gx * GRID_Z + gz] ? "1" : "0";
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4).padEnd(4, "0"), 2).toString(16);
  cols.push(hex);
  let mbits = "";
  for (let gz = 0; gz < GRID_Z; gz++) mbits += gridMajor[gx * GRID_Z + gz] ? "1" : "0";
  let mhex = "";
  for (let i = 0; i < mbits.length; i += 4) mhex += parseInt(mbits.slice(i, i + 4).padEnd(4, "0"), 2).toString(16);
  colsMajor.push(mhex);
}
writeFileSync(
  new URL("../../src/world/sf-streets.ts", import.meta.url),
  `// AUTO-GENERATED by tools/sf-data/bake-network.mjs — do not edit by hand.
// Raster mask DERIVED from the vector network (sf-network.ts) — pre-thinned.
// ${roadCells} road cells at ${GRID_X}x${GRID_Z}.
export const SF_STREET_MASK = {
  gx: ${GRID_X},
  gz: ${GRID_Z},
  // One hex string per column (gx); each nibble packs 4 rows (gz), MSB first.
  cols: ${JSON.stringify(cols)},
} as const;

export function streetMaskAt(gx: number, gz: number): boolean {
  const col = SF_STREET_MASK.cols[gx];
  if (col === undefined) return false;
  const nibble = col.charCodeAt(gz >> 2);
  const val = nibble <= 57 ? nibble - 48 : nibble - 87; // '0'-'9','a'-'f'
  return (val & (8 >> (gz & 3))) !== 0;
}

// Major-street class (primary/secondary) for width styling downstream.
export const SF_MAJOR_MASK = {
  cols: ${JSON.stringify(colsMajor)},
} as const;

export function majorMaskAt(gx: number, gz: number): boolean {
  const col = SF_MAJOR_MASK.cols[gx];
  if (col === undefined) return false;
  const nibble = col.charCodeAt(gz >> 2);
  const val = nibble <= 57 ? nibble - 48 : nibble - 87;
  return (val & (8 >> (gz & 3))) !== 0;
}
`,
);

// --- Emit sf-network.ts ---
const r1 = (n) => Math.round(n * 10) / 10;
const nodesOut = nodes.map(([x, z]) => `[${r1(x)},${r1(z)}]`).join(",");
const edgesOut = edges
  .map((e) => `{a:${e.a},b:${e.b},w:${e.half},p:[${e.pts.map(([x, z]) => `${r1(x)},${r1(z)}`).join(",")}]}`)
  .join(",\n");
writeFileSync(
  new URL("../../src/world/sf-network.ts", import.meta.url),
  `// AUTO-GENERATED by tools/sf-data/bake-network.mjs — do not edit by hand.
// The VECTOR road network (real OSM arterials, world coords): source of truth
// for road rendering, traffic routing and building alignment.
// ${nodes.length} nodes, ${edges.length} edges.

export type RawEdge = {
  readonly a: number; // node index
  readonly b: number;
  readonly w: number; // asphalt half-width
  readonly p: readonly number[]; // flat [x0,z0, x1,z1, ...] including endpoints
};

export const SF_NODES: readonly (readonly [number, number])[] = [${nodesOut}];

export const SF_EDGES: readonly RawEdge[] = [
${edgesOut}
];
`,
);

// SVG preview: network over the mask.
{
  const cell = 5;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${GRID_X * cell}" height="${GRID_Z * cell}"><rect width="100%" height="100%" fill="#9ec7d8"/>`;
  for (let gx = 0; gx < GRID_X; gx++) for (let gz = 0; gz < GRID_Z; gz++) {
    if (onLandUV((gx + 0.5) / GRID_X, (gz + 0.5) / GRID_Z))
      out += `<rect x="${gx * cell}" y="${gz * cell}" width="${cell}" height="${cell}" fill="${grid[gx * GRID_Z + gz] ? "#bbb" : "#e8e4d8"}"/>`;
  }
  const sx = (x) => ((x / WORLD_W) + 0.5) * GRID_X * cell;
  const sz = (z) => ((z / WORLD_H) + 0.5) * GRID_Z * cell;
  for (const e of edges) {
    out += `<polyline fill="none" stroke="#c22" stroke-width="1.6" points="${e.pts.map(([x, z]) => `${sx(x).toFixed(1)},${sz(z).toFixed(1)}`).join(" ")}"/>`;
  }
  out += "</svg>";
  writeFileSync(new URL("./preview-network.svg", import.meta.url), out);
}
console.log("Wrote src/world/sf-network.ts, src/world/sf-streets.ts, preview-network.svg");
