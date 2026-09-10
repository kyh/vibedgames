// Mine the WATERFRONT out of the licensed "Downtown San Francisco" OBJ:
// piers/docks, the structures standing on them, the Bay Bridge, Oracle Park
// and the real China Basin water outline.
//
//   node tools/sf-data/extract-marine-obj.mjs <path-to-obj> <out.json>
//
// ANALYSIS ONLY — this writes ONE json and touches nothing in src/. It is the
// survey a later pass turns into TypeScript data modules; the game is meant to
// REBUILD these things with its own Kenney kit + procedural geometry on the
// alignments measured here, not to import OBJ meshes.
//
// Structure mirrors extract-footprints.mjs (same file, same calibration, same
// union-find-into-blobs trick), with three additions that the footprint pass
// did not need:
//
//   1. The model ships its OWN coastline. Every face drawn with the `Water`
//      material is the bay/creek surface, so "is this thing over water?" is a
//      point-in-triangle test against the model's own truth instead of against
//      the game's traced coast. That is what separates a pier from a warehouse.
//   2. Marine features are FLAT (y ~ 0) triangulated polygons, so their
//      outline is the boundary loop of ALL their faces, not of their roof.
//   3. The bridge is a LINEAR structure. It gets a principal-axis pass:
//      chainage bins along the axis recover the deck centreline, the deck
//      width, the four tower stations and the cable sag between them.
//
// The extractor names nothing by hand. Piers are labelled by nearest named OSM
// way in sf-piers.raw.json, which is the same source bake-piers.mjs bakes.

import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { GRID_X, GRID_Z, landFactor, plLen, rdp, ringArea, WORLD_H, WORLD_W } from "./lib.mjs";

const [objPath, outPath] = process.argv.slice(2);
if (!objPath || !outPath) {
  console.error("usage: node extract-marine-obj.mjs <obj> <out.json>");
  process.exit(1);
}

// --- The verified OBJ -> world transform (extract-footprints.mjs owns it) ---
// Independent x/z scales, NO flip; anchored on Salesforce + Transamerica and
// hill-climbed against the street mask. Do not re-fit it here: two extractors
// disagreeing about where the city is would be worse than either being wrong.
const CAL = { bx: 325.2, bz: -400.5, sx: 0.17829, sz: 0.17909 };
// model h / real m = 1.598; world = 4.446 m/u
const CAL_SY = 1 / (1.598 * 4.446);
const ANCHORS = [
  ["Salesforce", 2458.4, -2088.9, 760, -770.1],
  ["Transamerica", 1809.9, -2842.1, 644.9, -907.7],
];
const wxOf = (mx) => mx * CAL.sx + CAL.bx;
const wzOf = (mz) => mz * CAL.sz + CAL.bz;
const uOf = (wx) => wx / WORLD_W + 0.5;
const vOf = (wz) => wz / WORLD_H + 0.5;
const r1 = (n) => Math.round(n * 10) / 10;
const r4 = (n) => Math.round(n * 1e4) / 1e4;

// Groups kept in full regardless of where they sit. Everything else is kept
// only where it stands over water (see PASS 2) — that is the whole point of
// this extractor and it keeps the 151 MB file's 1.5 M faces out of memory.
//
// Group names come from the Cinema4D export, which names each object after the
// OSM tag KEY it came from, truncated: `man`/`man_stroke` are the man_made=*
// fills and their outline strokes, `landuse=po` is landuse=port, `builds*` are
// oversized building complexes split out of the height=* buckets.
const KEEP_GROUPS = new Set([
  "man",
  "man_stroke",
  "barrier",
  "waterway",
  "natural",
  "way",
  "park",
  "others",
  "type",
  "amenity",
  "boundary",
  "landuse=po",
  "landuse=co",
  "landuse=r3",
  "railway",
  // the Bay Bridge candidate
  "builds",
  // the Oracle Park candidate
  "builds_3",
]);

// =========================================================================
// PASS 1 — every vertex, plus the model's own water surface.
// =========================================================================

const CH_SPACE = 32;
const CH_F = 102;
const CH_V = 118;

const vx = [];
const vy = [];
const vz = [];
/** Water triangles, as world-space [[x,z],[x,z],[x,z]]. */
const waterTris = [];

const pass1 = async () => {
  let mtl = "";
  const rl = createInterface({ crlfDelay: Infinity, input: createReadStream(objPath) });
  for await (const l of rl) {
    const c0 = l.codePointAt(0);
    if (c0 === CH_V && l.codePointAt(1) === CH_SPACE) {
      let i = 2;
      while (l.codePointAt(i) === CH_SPACE) {
        i += 1;
      }
      const j = l.indexOf(" ", i);
      const k = l.indexOf(" ", j + 1);
      vx.push(Number(l.slice(i, j)));
      vy.push(Number(l.slice(j + 1, k)));
      vz.push(Number(l.slice(k + 1)));
    } else if (c0 === CH_F && mtl === "Water") {
      const ids = faceIds(l);
      // Fan-triangulate: the export's water faces are tris and convex quads.
      for (let i = 2; i < ids.length; i += 1) {
        waterTris.push([ids[0], ids[i - 1], ids[i]].map((id) => [wxOf(vx[id]), wzOf(vz[id])]));
      }
    } else if (l.startsWith("usemtl")) {
      mtl = l.slice(7).trim();
    }
  }
};

const faceIds = (l) => {
  const ids = [];
  for (const part of l.slice(2).trim().split(/\s+/u)) {
    const s = part.includes("/") ? part.slice(0, part.indexOf("/")) : part;
    let id = Number(s);
    if (id < 0) {
      id = vx.length + 1 + id;
    }
    ids.push(id - 1);
  }
  return ids;
};

// --- Point-in-water, bucketed on a 40u grid (1.2k triangles, ~1 M queries) ---
const WATER_CELL = 40;
const waterGrid = new Map();
const buildWaterIndex = () => {
  for (const [ti, t] of waterTris.entries()) {
    const x0 = Math.min(t[0][0], t[1][0], t[2][0]);
    const x1 = Math.max(t[0][0], t[1][0], t[2][0]);
    const z0 = Math.min(t[0][1], t[1][1], t[2][1]);
    const z1 = Math.max(t[0][1], t[1][1], t[2][1]);
    for (let a = Math.floor(x0 / WATER_CELL); a <= Math.floor(x1 / WATER_CELL); a += 1) {
      for (let b = Math.floor(z0 / WATER_CELL); b <= Math.floor(z1 / WATER_CELL); b += 1) {
        const k = `${a}:${b}`;
        let g = waterGrid.get(k);
        if (!g) {
          g = [];
          waterGrid.set(k, g);
        }
        g.push(ti);
      }
    }
  }
};
const inWater = (x, z) => {
  const g = waterGrid.get(`${Math.floor(x / WATER_CELL)}:${Math.floor(z / WATER_CELL)}`);
  if (!g) {
    return false;
  }
  for (const ti of g) {
    const [A, B, C] = waterTris[ti];
    const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
    if (den === 0) {
      continue;
    }
    const a = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (z - C[1])) / den;
    const b = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (z - C[1])) / den;
    if (a >= -1e-9 && b >= -1e-9 && a + b <= 1 + 1e-9) {
      return true;
    }
  }
  return false;
};

// =========================================================================
// PASS 2 — faces of the kept groups, plus anything standing over water.
// =========================================================================

// --- Point-in-deck, over the polygons the game already ships -------------
// "Over water" alone under-counts pier structures: the model's coastline is the
// real one, so a shed on the landward third of a finger pier reads as dry. The
// question that actually matters is "would this thing land on one of the game's
// 55 empty decks", so the decks themselves are the second test.
const DECK_CELL = 30;
const deckGrid = new Map();
const deckRings = [];
const buildDeckIndex = (rings) => {
  for (const [di, ring] of rings.entries()) {
    deckRings.push(ring);
    let x0 = 1e9;
    let x1 = -1e9;
    let z0 = 1e9;
    let z1 = -1e9;
    for (const [x, z] of ring) {
      if (x < x0) {
        x0 = x;
      }
      if (x > x1) {
        x1 = x;
      }
      if (z < z0) {
        z0 = z;
      }
      if (z > z1) {
        z1 = z;
      }
    }
    for (let a = Math.floor(x0 / DECK_CELL); a <= Math.floor(x1 / DECK_CELL); a += 1) {
      for (let b = Math.floor(z0 / DECK_CELL); b <= Math.floor(z1 / DECK_CELL); b += 1) {
        const k = `${a}:${b}`;
        let g = deckGrid.get(k);
        if (!g) {
          g = [];
          deckGrid.set(k, g);
        }
        g.push(di);
      }
    }
  }
};
/** Index of the deck the point falls inside, or -1. */
const deckAt = (x, z) => {
  const g = deckGrid.get(`${Math.floor(x / DECK_CELL)}:${Math.floor(z / DECK_CELL)}`);
  if (!g) {
    return -1;
  }
  for (const di of g) {
    const r = deckRings[di];
    let inside = false;
    let j = r.length - 1;
    for (let i = 0; i < r.length; i += 1) {
      const [xi, zi] = r[i];
      const [xj, zj] = r[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
        inside = !inside;
      }
      j = i;
    }
    if (inside) {
      return di;
    }
  }
  return -1;
};

/** group name -> { ids, mtl }[] */
const groupFaces = new Map();

const pass2 = async () => {
  let group = null;
  let mtl = "";
  const rl = createInterface({ crlfDelay: Infinity, input: createReadStream(objPath) });
  for await (const l of rl) {
    const c0 = l.codePointAt(0);
    if (c0 === CH_F && l.codePointAt(1) === CH_SPACE) {
      if (!group) {
        continue;
      }
      const ids = faceIds(l);
      let keep = KEEP_GROUPS.has(group);
      if (!keep) {
        // Water faces are kept above via their own group (`waterway`), which is
        // what the outline pass reads; here anything else earns its way in by
        // standing over the bay OR on one of the game's shipped pier decks.
        for (const id of ids) {
          const x = wxOf(vx[id]);
          const z = wzOf(vz[id]);
          if (inWater(x, z) || deckAt(x, z) >= 0) {
            keep = true;
            break;
          }
        }
      }
      if (!keep) {
        continue;
      }
      let a = groupFaces.get(group);
      if (!a) {
        a = [];
        groupFaces.set(group, a);
      }
      a.push({ ids, mtl });
    } else if (l.startsWith("o ") || l.startsWith("g ")) {
      group = l.slice(2).trim();
    } else if (l.startsWith("usemtl")) {
      mtl = l.slice(7).trim();
    }
  }
};

// =========================================================================
// Blob decomposition + outlines (shared with extract-footprints.mjs in spirit)
// =========================================================================

/** Split a face list into connected components over shared vertices. */
const toBlobs = (faces) => {
  const parent = new Map();
  const find = (a) => {
    let r = a;
    while (parent.get(r) !== r) {
      r = parent.get(r);
    }
    let walk = a;
    while (parent.get(walk) !== r) {
      const next = parent.get(walk);
      parent.set(walk, r);
      walk = next;
    }
    return r;
  };
  const union = (a, b) => {
    if (!parent.has(a)) {
      parent.set(a, a);
    }
    if (!parent.has(b)) {
      parent.set(b, b);
    }
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(ra, rb);
    }
  };
  for (const f of faces) {
    for (let i = 1; i < f.ids.length; i += 1) {
      union(f.ids[0], f.ids[i]);
    }
  }
  const comps = new Map();
  for (const f of faces) {
    const root = find(f.ids[0]);
    let c = comps.get(root);
    if (!c) {
      c = [];
      comps.set(root, c);
    }
    c.push(f);
  }
  return [...comps.values()].map(blobStats);
};

const blobStats = (faces) => {
  const verts = new Set();
  const mtls = new Set();
  let minX = 1e9;
  let maxX = -1e9;
  let minY = 1e9;
  let maxY = -1e9;
  let minZ = 1e9;
  let maxZ = -1e9;
  for (const f of faces) {
    mtls.add(f.mtl);
    for (const id of f.ids) {
      verts.add(id);
      const x = wxOf(vx[id]);
      const y = vy[id] * CAL_SY;
      const z = wzOf(vz[id]);
      if (x < minX) {
        minX = x;
      }
      if (x > maxX) {
        maxX = x;
      }
      if (y < minY) {
        minY = y;
      }
      if (y > maxY) {
        maxY = y;
      }
      if (z < minZ) {
        minZ = z;
      }
      if (z > maxZ) {
        maxZ = z;
      }
    }
  }
  let wet = 0;
  for (const id of verts) {
    if (inWater(wxOf(vx[id]), wzOf(vz[id]))) {
      wet += 1;
    }
  }
  return {
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    d: maxZ - minZ,
    faces,
    h: maxY - minY,
    maxX,
    maxY,
    maxZ,
    minX,
    minY,
    minZ,
    mtls: [...mtls],
    nf: faces.length,
    nv: verts.size,
    verts,
    w: maxX - minX,
    wet: wet / verts.size,
  };
};

/**
 * Boundary loop of a face set: edges used by exactly one face, walked into the
 * LARGEST-AREA closed loop. For the FLAT marine polygons that is the feature
 * outline; pass a filtered face list (bottom faces / top faces) to get the
 * footprint or roof of a solid.
 *
 * extract-footprints.mjs keeps the loop with the most POINTS; that is wrong for
 * anything with a hole (a stadium base slab, a quay ring) where the inner loop
 * can easily out-count the outer one. Largest area always picks the outside.
 */
const undirectedBoundary = (faces) => {
  const count = new Map();
  const ends = new Map();
  for (const f of faces) {
    const ids = f.ids ?? f;
    for (let i = 0; i < ids.length; i += 1) {
      const a = ids[i];
      const b = ids[(i + 1) % ids.length];
      if (a === b) {
        continue;
      }
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(k, (count.get(k) ?? 0) + 1);
      if (!ends.has(k)) {
        ends.set(k, [a, b]);
      }
    }
  }
  // UNDIRECTED adjacency. A directed next-vertex walk assumes every face winds
  // the same way; the exported water surface does not, and one flipped triangle
  // on the coast is enough to break the chain and lose the whole bay outline.
  const adj = new Map();
  let edges = 0;
  for (const [k, n] of count) {
    if (n !== 1) {
      continue;
    }
    const [a, b] = ends.get(k);
    if (!adj.has(a)) {
      adj.set(a, []);
    }
    if (!adj.has(b)) {
      adj.set(b, []);
    }
    adj.get(a).push(b);
    adj.get(b).push(a);
    edges += 1;
  }
  return { adj, edges };
};

/** One unvisited chain out of `start`, consuming vertices as it goes. */
const walkLoop = (adj, start, visited) => {
  const loop = [start];
  visited.add(start);
  let prev = start;
  let cur = adj.get(start).find((n) => !visited.has(n));
  while (cur !== undefined && !visited.has(cur)) {
    visited.add(cur);
    loop.push(cur);
    const nbrs = adj.get(cur) ?? [];
    const from = prev;
    const nxt = nbrs.find((n) => n !== from && !visited.has(n));
    prev = cur;
    // Closing back onto the start is success; a dead end is a dangling chain.
    cur = nxt ?? (nbrs.includes(start) ? start : undefined);
    if (cur === start) {
      break;
    }
  }
  return loop;
};

const boundaryRing = (faces) => {
  const { adj, edges } = undirectedBoundary(faces);
  if (edges < 3) {
    return null;
  }
  const visited = new Set();
  let best = null;
  let bestA = -1;
  for (const start of adj.keys()) {
    if (visited.has(start)) {
      continue;
    }
    const loop = walkLoop(adj, start, visited);
    if (loop.length < 3) {
      continue;
    }
    const pts = loop.map((id) => [wxOf(vx[id]), wzOf(vz[id])]);
    const a = Math.abs(ringArea(pts));
    if (a > bestA) {
      bestA = a;
      best = pts;
    }
  }
  if (!best) {
    return null;
  }
  // normalize CCW
  return ringArea(best) < 0 ? best.toReversed() : best;
};

const flat = (ring) => ring.flatMap(([x, z]) => [r1(x), r1(z)]);

/**
 * AREA centroid of a ring, not the vertex mean. Marine outlines are wildly
 * non-uniform in vertex density (a traced quay wall carries 40 points, the
 * straight seaward face carries 2), so the vertex mean walks off toward the
 * detailed edge — enough to move Oracle Park's reported centre by ~12u.
 */
const centroidOf = (ring) => {
  let a = 0;
  let x = 0;
  let z = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const cr = p[0] * q[1] - q[0] * p[1];
    a += cr;
    x += (p[0] + q[0]) * cr;
    z += (p[1] + q[1]) * cr;
  }
  if (Math.abs(a) < 1e-9) {
    let mx = 0;
    let mz = 0;
    for (const p of ring) {
      mx += p[0];
      mz += p[1];
    }
    return [mx / ring.length, mz / ring.length];
  }
  return [x / (3 * a), z / (3 * a)];
};

// =========================================================================
// Reference data the OBJ is being diffed AGAINST (read-only).
// =========================================================================

const srcUrl = (p) => new URL(p, import.meta.url);

/** SF_PIERS from the shipped src/world/sf-piers.ts (OSM man_made=pier bake). */
const readGamePiers = () => {
  const ts = readFileSync(srcUrl("../../src/world/sf-piers.ts"), "utf-8");
  const body = ts.slice(ts.indexOf("export const SF_PIERS"), ts.indexOf("export const SF_DOCKS"));
  const out = [];
  // Entry bodies only ever contain numbers, so a no-nesting bracket class is
  // both sufficient and immune to how oxfmt happens to wrap the ring.
  for (const m of body.matchAll(/p:\s*\[(?<points>[^\]]*)\]\s*,\s*area:\s*(?<area>\d+)/gu)) {
    const nums = (m.groups?.points ?? "").split(",").map(Number);
    const ring = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      ring.push([nums[i], nums[i + 1]]);
    }
    out.push({ area: Number(m.groups?.area), ring });
  }
  const dockBody = ts.slice(ts.indexOf("export const SF_DOCKS"));
  return { dockCount: (dockBody.match(/\[[-\d.,\s]+\]/gu) ?? []).length, piers: out };
};

/**
 * The two landmarks this survey second-guesses, read out of landmarks.ts so
 * the reported error can never go stale against a hand-copied number.
 */
const readAuthoredLandmarks = () => {
  const ts = readFileSync(srcUrl("../../src/world/landmarks.ts"), "utf-8");
  const grab = (kind) => {
    const i = ts.indexOf(`kind: "${kind}"`);
    if (i === -1) {
      return null;
    }
    const seg = ts.slice(i, i + 400);
    const u = seg.match(/\bu:\s*(?<n>[-\d.]+)/u);
    const v = seg.match(/\bv:\s*(?<n>[-\d.]+)/u);
    const r = seg.match(/rotDeg:\s*(?<n>[-\d.]+)/u);
    return u && v
      ? { rotDeg: r ? Number(r.groups?.n) : 0, u: Number(u.groups?.n), v: Number(v.groups?.n) }
      : null;
  };
  return { baybridge: grab("baybridge"), oraclepark: grab("oraclepark") };
};

/** Named OSM pier ways (sf-piers.raw.json), projected to world, for labelling. */
const readOsmPierNames = () => {
  const raw = JSON.parse(readFileSync(srcUrl("./sf-piers.raw.json"), "utf-8"));
  const U_M = 6.2462;
  const U_B = 765.2557;
  const V_M = -9.6095;
  const V_B = 363.344;
  const out = [];
  for (const e of raw.elements) {
    if (e.type !== "way" || !e.geometry || !e.tags?.name) {
      continue;
    }
    let x = 0;
    let z = 0;
    for (const q of e.geometry) {
      x += (U_M * q.lon + U_B - 0.5) * WORLD_W;
      z += (V_M * q.lat + V_B - 0.5) * WORLD_H;
    }
    out.push({ name: e.tags.name, x: x / e.geometry.length, z: z / e.geometry.length });
  }
  return out;
};

/** SF_FOOTPRINTS centroids, for the China Basin cull count. */
const readFootprintCentroids = () => {
  const ts = readFileSync(srcUrl("../../src/world/sf-footprints.ts"), "utf-8");
  const body = ts.slice(
    ts.indexOf("export const SF_FOOTPRINTS"),
    ts.indexOf("export const SF_FOOTPRINTS_BOUNDS"),
  );
  const out = [];
  // `[h, x0,z0, x1,z1, ...]`, one entry per bracket group; oxfmt wraps long
  // rings over several lines, so match the bracket group, not the line.
  for (const m of body.matchAll(/\[(?<nums>[-\d.,\s]+)\]/gu)) {
    const n = (m.groups?.nums ?? "").split(",").map(Number);
    let x = 0;
    let z = 0;
    let c = 0;
    for (let i = 1; i + 1 < n.length; i += 2) {
      x += n[i];
      z += n[i + 1];
      c += 1;
    }
    if (c >= 3) {
      out.push([x / c, z / c, n[0]]);
    }
  }
  return out;
};

const nearestName = (names, x, z) => {
  let best = null;
  let bestD = Infinity;
  for (const n of names) {
    const d = Math.hypot(n.x - x, n.z - z);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best ? { dist: r1(bestD), name: best.name } : null;
};

// =========================================================================
// SECTION 1 — piers, docks, quays
// =========================================================================

// The man_made fills carry the pier polygons; landuse=port carries the apron
// they sit in. Both are flat, so their boundary ring IS the outline. A blob
// qualifies as marine when at least WET_MIN of its vertices stand over the
// model's own water.
const WET_MIN = 0.4;
// < ~12x12 m: gangway/bollard noise
const PIER_MIN_AREA = 60;

// What each source group actually IS over water. Only `pier` polygons get
// diffed against SF_PIERS; the rest are waterfront CONTEXT and are reported
// separately so a 85,000u2 port apron never masquerades as a pier.
const MARINE_CLASS = {
  barrier: "seawall",
  // landuse=port
  "landuse=po": "portApron",
  // man_made=pier/quay/breakwater fill
  man: "pier",
  natural: "shorelineNatural",
  park: "waterfrontPark",
  way: "other",
};

/** Marine outline of one wet blob, or null if it does not close big enough. */
const pierEntryOf = (g, b, osmNames) => {
  const ring = boundaryRing(b.faces);
  if (!ring || ring.length < 3) {
    return null;
  }
  const simple = rdp(ring, 0.4);
  if (simple.length < 3) {
    return null;
  }
  const area = Math.abs(ringArea(simple));
  if (area < PIER_MIN_AREA) {
    return null;
  }
  const [cx, cz] = centroidOf(simple);
  return {
    area: Math.round(area),
    cls: MARINE_CLASS[g],
    cx: r1(cx),
    cz: r1(cz),
    d: r1(b.d),
    group: g,
    osm: nearestName(osmNames, cx, cz),
    pts: simple.length,
    rawPts: ring.length,
    ring: flat(simple),
    u: r4(uOf(cx)),
    v: r4(vOf(cz)),
    w: r1(b.w),
    wet: r4(b.wet),
  };
};

/**
 * Dedupe: landuse=port aprons often trace the same outline as the man_made
 * fill they contain. Keep the larger, note the twin.
 */
const dedupePiers = (piers) => {
  const kept = [];
  for (const p of piers) {
    const twin = kept.find(
      (k) => Math.hypot(k.cx - p.cx, k.cz - p.cz) < 6 && Math.abs(k.area - p.area) / k.area < 0.25,
    );
    if (twin) {
      twin.duplicateIn = [...(twin.duplicateIn ?? []), p.group];
      continue;
    }
    kept.push(p);
  }
  return kept;
};

/** Nearest shipped-bake pier to an OBJ pier: its index and distance. */
const nearestGamePier = (gc, p) => {
  let bi = -1;
  let bd = Infinity;
  for (let i = 0; i < gc.length; i += 1) {
    const d = Math.hypot(gc[i].x - p.cx, gc[i].z - p.cz);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return { bd, bi };
};

/** Per-pier diff against the shipped OSM bake; marks the game piers it used. */
const diffAgainstGamePiers = (objPiers, gc, usedGame) => {
  for (const p of objPiers) {
    const { bd, bi } = nearestGamePier(gc, p);
    // 45u ~ one pier width; beyond that the "match" is a different structure.
    if (bi >= 0 && bd <= 45) {
      usedGame.add(bi);
      const ratio = p.area / Math.max(1, gc[bi].area);
      p.gameMatch = {
        areaRatio: r4(ratio),
        dist: r1(bd),
        gameArea: gc[bi].area,
        gamePts: gc[bi].pts,
        index: bi,
        // bake-piers.mjs SLIDES land-locked piers seaward, so a good match is
        // "same shape, moved". Ratio outside 2x means we matched the wrong one.
        verdict: ratio > 0.5 && ratio < 2 ? "same polygon" : "position only, shape differs",
      };
    } else {
      p.gameMatch = null;
      p.nearestGameDist = bi >= 0 ? r1(bd) : null;
    }
  }
};

const sectionPiers = (blobsByGroup, gamePiers, osmNames) => {
  const piers = [];
  for (const g of Object.keys(MARINE_CLASS)) {
    for (const b of blobsByGroup.get(g) ?? []) {
      if (b.wet < WET_MIN) {
        continue;
      }
      const entry = pierEntryOf(g, b, osmNames);
      if (entry) {
        piers.push(entry);
      }
    }
  }
  piers.sort((a, b) => b.area - a.area);

  const kept = dedupePiers(piers);

  // --- Per-pier diff against the shipped OSM bake (pier class only) ---
  const objPiers = kept.filter((p) => p.cls === "pier");
  const context = kept.filter((p) => p.cls !== "pier");
  const gc = gamePiers.piers.map((p) => {
    const [x, z] = centroidOf(p.ring);
    return { area: p.area, pts: p.ring.length, x, z };
  });
  const usedGame = new Set();
  diffAgainstGamePiers(objPiers, gc, usedGame);
  const orphanGame = [];
  for (let i = 0; i < gc.length; i += 1) {
    if (usedGame.has(i)) {
      continue;
    }
    let bd = Infinity;
    for (const p of objPiers) {
      bd = Math.min(bd, Math.hypot(gc[i].x - p.cx, gc[i].z - p.cz));
    }
    orphanGame.push({
      area: gc[i].area,
      distToNearestObj: Number.isFinite(bd) ? r1(bd) : null,
      index: i,
      osm: nearestName(osmNames, gc[i].x, gc[i].z),
      u: r4(uOf(gc[i].x)),
      v: r4(vOf(gc[i].z)),
    });
  }
  orphanGame.sort((a, b) => b.area - a.area);
  return { context, objPiers, orphanGame };
};

// =========================================================================
// SECTION 2 — what STANDS on the piers (the sheds the game's decks lack)
// =========================================================================

/**
 * Solid, over-water blobs drawn with the `building` material. Footprint = the
 * boundary ring of the base faces (all verts within 0.75u of the blob floor);
 * if those do not close, fall back to the roof ring, then to the bbox.
 */
// Bits of the crossing (anchorages, pier footings) got filed into ordinary
// `height=NN` buckets rather than into `builds`, so a group-name exclusion is
// not enough — anything inside this corridor is bridge, not a shed.
const BRIDGE_CORRIDOR = 30;

const onBridge = (bridge, x, z) => {
  if (!bridge?.present) {
    return false;
  }
  let best = Infinity;
  const c = bridge.centreline;
  for (let i = 1; i < c.length; i += 1) {
    const [x0, z0] = c[i - 1];
    const [x1, z1] = c[i];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / len2));
    best = Math.min(best, Math.hypot(x - (x0 + dx * t), z - (z0 + dz * t)));
  }
  return best < BRIDGE_CORRIDOR;
};

/** Footprint of a shed: the base faces, else the roof faces, else the bbox. */
const shedFootprint = (b) => {
  const base = b.faces.filter((f) => f.ids.every((id) => vy[id] * CAL_SY <= b.minY + 0.75));
  const top = b.faces.filter((f) => f.ids.every((id) => vy[id] * CAL_SY >= b.maxY - 0.75));
  let ring = base.length ? boundaryRing(base) : null;
  if (!ring || Math.abs(ringArea(ring)) < 0.45 * b.w * b.d) {
    ring = top.length ? boundaryRing(top) : null;
    if (ring && Math.abs(ringArea(ring)) >= 0.35 * b.w * b.d) {
      return { ring, src: "roof" };
    }
    return {
      ring: [
        [b.minX, b.minZ],
        [b.maxX, b.minZ],
        [b.maxX, b.maxZ],
        [b.minX, b.maxZ],
      ],
      src: "bbox",
    };
  }
  return { ring, src: "base" };
};

/**
 * Which shipped pier deck is closest. `onGameDeck` is a hard point-in-polygon
 * hit — that is the one that means "this deck stops being an empty slab".
 * `nearestGameDeck` is only context.
 */
const nearestGameDeck = (gc, cx, cz) => {
  let nearest = null;
  let bd = Infinity;
  for (let i = 0; i < gc.length; i += 1) {
    const d = Math.hypot(gc[i].c[0] - cx, gc[i].c[1] - cz);
    if (d < bd) {
      bd = d;
      nearest = i;
    }
  }
  return { bd, nearest };
};

const isShedBlob = (b) => {
  if (!b.mtls.includes("building")) {
    return false;
  }
  if (b.wet < WET_MIN && deckAt(b.cx, b.cz) < 0) {
    return false;
  }
  // flat marking, not a shed
  if (b.h < 1) {
    return false;
  }
  // the bridge, not a building
  return b.w >= 3 && b.d >= 3 && b.w <= 400 && b.d <= 400;
};

const shedEntryOf = (g, b, gc, osmNames, bridge) => {
  const { ring, src } = shedFootprint(b);
  const simple = rdp(ring, 0.35);
  if (simple.length < 3 || simple.length > 64) {
    return null;
  }
  const area = Math.abs(ringArea(simple));
  if (area < 30) {
    return null;
  }
  const [cx, cz] = centroidOf(simple);
  if (onBridge(bridge, cx, cz)) {
    return null;
  }
  const { bd, nearest } = nearestGameDeck(gc, cx, cz);
  return {
    area: Math.round(area),
    cx: r1(cx),
    cz: r1(cz),
    group: g,
    h: r1(b.h),
    nearestGameDeck: { dist: r1(bd), index: nearest },
    onGameDeck: deckAt(cx, cz),
    osm: nearestName(osmNames, cx, cz),
    pts: simple.length,
    ring: flat(simple),
    ringFrom: src,
    u: r4(uOf(cx)),
    v: r4(vOf(cz)),
    wet: r4(b.wet),
  };
};

// `man_stroke`/`barrier` are flat strokes, not massing. `builds` is the Bay
// Bridge and `builds_3` is the ballpark; both are drawn with the `building`
// material and both stand over water, so without this exclusion a 29u bridge
// tower gets filed as a pier shed on "Pier B".
const NON_SHED_GROUPS = new Set(["man_stroke", "barrier", "builds", "builds_3"]);

const sectionPierBuildings = (blobsByGroup, gamePiers, osmNames, bridge) => {
  const gc = gamePiers.piers.map((p) => ({ area: p.area, c: centroidOf(p.ring), ring: p.ring }));
  const out = [];
  for (const [g, blobs] of blobsByGroup) {
    if (NON_SHED_GROUPS.has(g)) {
      continue;
    }
    for (const b of blobs) {
      if (!isShedBlob(b)) {
        continue;
      }
      const entry = shedEntryOf(g, b, gc, osmNames, bridge);
      if (entry) {
        out.push(entry);
      }
    }
  }
  out.sort((a, b) => b.area * b.h - a.area * a.h);
  return out;
};

// =========================================================================
// SECTION 3 — the Bay Bridge
// =========================================================================

/**
 * The `builds` group, surveyed as a linear structure: PCA axis, then 5u
 * chainage bins. Deck band is chosen by COVERAGE (the y-band whose vertices
 * appear in the most bins is the roadway, which by definition runs the whole
 * length); towers are bins whose ceiling stands clear of the deck; the ceiling
 * between towers is the main cable.
 *
 * The whole GROUP is one structure — the export split it into a main mesh plus
 * ~520 detached bits (two full towers and a swarm of 24-vertex suspender caps).
 * Surveying only the largest blob loses half the towers, so everything in the
 * group is pooled; the group's bbox is a single 540x615u corridor over the bay
 * with nothing else in it.
 */
const BIN = 5;

const principalAxis = (pts) => {
  let cx = 0;
  let cz = 0;
  for (const p of pts) {
    cx += p[0];
    cz += p[2];
  }
  cx /= pts.length;
  cz /= pts.length;
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  for (const p of pts) {
    const a = p[0] - cx;
    const b = p[2] - cz;
    sxx += a * a;
    sxz += a * b;
    szz += b * b;
  }
  const th = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  let ax = Math.cos(th);
  let az = Math.sin(th);
  // Orient +axis away from the city (increasing x), i.e. SF -> Yerba Buena.
  if (ax < 0) {
    ax = -ax;
    az = -az;
  }
  return { ax, az, cx, cz };
};

/** Pooled vertices binned along the structure's axis. */
const chainageBins = (pts, sOf) => {
  const bins = new Map();
  for (const p of pts) {
    const b = Math.round(sOf(p) / BIN);
    let e = bins.get(b);
    if (!e) {
      e = { maxY: -1e9, minY: 1e9, n: 0, pts: [] };
      bins.set(b, e);
    }
    e.n += 1;
    e.maxY = Math.max(e.maxY, p[1]);
    e.minY = Math.min(e.minY, p[1]);
    e.pts.push(p);
  }
  return bins;
};

/**
 * Deck band by along-axis coverage: the 0.5u y-bucket whose vertices appear in
 * the most bins is the roadway, which by definition runs the whole length.
 */
const deckBand = (bins) => {
  // 0.5u y-bucket -> Set(bin)
  const yBand = new Map();
  for (const [b, e] of bins) {
    for (const p of e.pts) {
      const k = Math.round(p[1] * 2);
      let set = yBand.get(k);
      if (!set) {
        set = new Set();
        yBand.set(k, set);
      }
      set.add(b);
    }
  }
  let deckK = 0;
  let deckCov = -1;
  for (const [k, set] of yBand) {
    if (set.size > deckCov) {
      deckCov = set.size;
      deckK = k;
    }
  }
  const deckY = deckK / 2;
  // slab + parapet
  return { deckHi: deckY + 2.5, deckLo: deckY - 0.6, deckY };
};

/**
 * Roadway points of one bin. On the suspended crossing the roadway sits in the
 * deck band. On the approach viaduct it RAMPS down to the city, so those bins
 * have nothing in the band; there the roadway is the bin's own top surface
 * instead, flagged `ramp` so the two are never averaged into one bogus
 * elevation.
 */
const roadwayOf = (e, deckLo, deckHi) => {
  const inBand = e.pts.filter((p) => p[1] >= deckLo && p[1] <= deckHi);
  if (inBand.length >= 4) {
    return { ramp: false, road: inBand };
  }
  const top = Math.max(...e.pts.map((p) => p[1]));
  if (top >= deckLo || top <= 0.3) {
    return { ramp: false, road: [] };
  }
  const road = e.pts.filter((p) => p[1] >= top - 1.2);
  return road.length >= 4 ? { ramp: true, road } : { ramp: false, road: [] };
};

/** Lateral extent and mean elevation of one bin's roadway points. */
const roadSpanOf = (road, tOf) => {
  let tmin = 1e9;
  let tmax = -1e9;
  let ys = 0;
  for (const p of road) {
    const t = tOf(p);
    if (t < tmin) {
      tmin = t;
    }
    if (t > tmax) {
      tmax = t;
    }
    ys += p[1];
  }
  return { roadY: ys / road.length, tmax, tmin, width: tmax - tmin };
};

const chainageProfile = (bins, keys, band, axis, tOf) => {
  const centre = [];
  const widths = [];
  const profile = [];
  for (const k of keys) {
    const e = bins.get(k);
    const { ramp, road } = roadwayOf(e, band.deckLo, band.deckHi);
    let width = null;
    let roadY = null;
    if (road.length >= 4) {
      const span = roadSpanOf(road, tOf);
      ({ roadY, width } = span);
      // Wider than 25u is an anchorage block or a landfall apron, not roadway.
      if (width < 25) {
        const tMid = (span.tmin + span.tmax) / 2;
        const s = k * BIN;
        if (!ramp) {
          widths.push(width);
        }
        centre.push([
          axis.cx + axis.ax * s - axis.az * tMid,
          axis.cz + axis.az * s + axis.ax * tMid,
        ]);
      }
    }
    profile.push({
      maxY: r1(e.maxY),
      minY: r1(e.minY),
      n: e.n,
      ramp,
      roadW: width === null ? null : r1(width),
      roadY: roadY === null ? null : r1(roadY),
      s: k * BIN,
    });
  }
  return { centre, profile, widths };
};

// Towers are bins whose ceiling clears the deck by this much.
const TOWER_CLEAR = 8;

const findTowers = (profile, deckY) => {
  const towers = [];
  for (let i = 0; i < profile.length; i += 1) {
    const p = profile[i];
    if (p.maxY < deckY + TOWER_CLEAR) {
      continue;
    }
    const prev = profile[i - 1];
    const nextP = profile[i + 1];
    if ((prev && prev.maxY > p.maxY) || (nextP && nextP.maxY > p.maxY)) {
      continue;
    }
    if (towers.length && p.s - towers.at(-1).s < 40) {
      if (p.maxY > towers.at(-1).top) {
        towers[towers.length - 1] = { s: p.s, top: p.maxY };
      }
      continue;
    }
    towers.push({ s: p.s, top: p.maxY });
  }
  return towers;
};

const describeTowers = (towers, bins, axis, tOf) =>
  towers.map((t) => {
    const x = axis.cx + axis.ax * t.s;
    const z = axis.cz + axis.az * t.s;
    // Base width: the widest deck-band extent within one bin of the station.
    const e = bins.get(Math.round(t.s / BIN));
    let tmin = 1e9;
    let tmax = -1e9;
    for (const p of e?.pts ?? []) {
      const tt = tOf(p);
      if (tt < tmin) {
        tmin = tt;
      }
      if (tt > tmax) {
        tmax = tt;
      }
    }
    return {
      baseW: r1(tmax - tmin),
      s: t.s,
      topM: Math.round(t.top * 4.446),
      topY: r1(t.top),
      u: r4(uOf(x)),
      v: r4(vOf(z)),
      x: r1(x),
      z: r1(z),
    };
  });

/**
 * Main cables: the ceiling on each side of the roadway, above deck. They are
 * extruded in ~12u chunks that the export left detached, so they do not show up
 * in the main mesh at all; pooled, they trace two clean catenary strings whose
 * lateral offset gives the cable-plane spacing to rebuild at.
 */
const cableProfile = (bins, keys, deckHi, tOf) => {
  const cable = [];
  const offsets = [];
  for (const k of keys) {
    const e = bins.get(k);
    let ly = -1e9;
    let ry = -1e9;
    let lt = 0;
    let rt = 0;
    for (const p of e.pts) {
      const [, py] = p;
      if (py <= deckHi) {
        continue;
      }
      const t = tOf(p);
      // tower shaft / stray
      if (Math.abs(t) < 1.5 || Math.abs(t) > 8) {
        continue;
      }
      if (t < 0 && py > ly) {
        ly = py;
        lt = t;
      }
      if (t > 0 && py > ry) {
        ry = py;
        rt = t;
      }
    }
    if (ly === -1e9 && ry === -1e9) {
      continue;
    }
    if (ly !== -1e9) {
      offsets.push(-lt);
    }
    if (ry !== -1e9) {
      offsets.push(rt);
    }
    cable.push({
      leftY: ly === -1e9 ? null : r1(ly),
      rightY: ry === -1e9 ? null : r1(ry),
      s: k * BIN,
    });
  }
  offsets.sort((a, b) => a - b);
  return {
    cable,
    cableOffset: offsets.length ? offsets[Math.floor(offsets.length / 2)] : null,
  };
};

/** Cable sag: ceiling minus deck, midway between adjacent towers. */
const cableSag = (towerOut, profile) => {
  const sag = [];
  for (let i = 1; i < towerOut.length; i += 1) {
    const mid = (towerOut[i - 1].s + towerOut[i].s) / 2;
    let [nearest] = profile;
    for (const p of profile) {
      if (Math.abs(p.s - mid) < Math.abs(nearest.s - mid)) {
        nearest = p;
      }
    }
    sag.push({
      betweenTowers: [i - 1, i],
      midY: r1(nearest.maxY),
      sagBelowTowerTop: r1(towerOut[i].topY - nearest.maxY),
      spanM: Math.round((towerOut[i].s - towerOut[i - 1].s) * 4.446),
      spanU: r1(towerOut[i].s - towerOut[i - 1].s),
    });
  }
  return sag;
};

/**
 * What the game currently ships, and how wrong it is. landmarks.ts authors the
 * crossing along local +X and spins it with node.rotation.y, which maps +X to
 * (cos r, -sin r) in (x, z). North is -z, so the authored bearing clockwise
 * from north is atan2(cos r, sin r).
 */
const compareAuthoredBridge = (bearingDeg, deckY, towers, sf, anchorPt) => {
  const authored = readAuthoredLandmarks().baybridge;
  if (!authored) {
    return null;
  }
  const rr = (authored.rotDeg * Math.PI) / 180;
  const authBearing = (Math.atan2(Math.cos(rr), Math.sin(rr)) * 180) / Math.PI;
  const axu = (authored.u - 0.5) * WORLD_W;
  const azw = (authored.v - 0.5) * WORLD_H;
  return {
    anchorErrorToViaductEndU: r1(Math.hypot(axu - sf[0], azw - sf[1])),
    anchorErrorU: r1(Math.hypot(axu - anchorPt[0], azw - anchorPt[1])),
    authored,
    authoredBearingDegFromNorth: r1(authBearing),
    authoredDeckY: 13,
    authoredTowerCount: 2,
    authoredTowerTopY: 49,
    bearingErrorDeg: r1(bearingDeg - authBearing),
    trueBearingDegFromNorth: r1(bearingDeg),
    trueDeckY: r1(deckY),
    trueTowerCount: towers.length,
    trueTowerTopY: towers.length ? r1(Math.max(...towers.map((t) => t.top))) : null,
  };
};

/** A detached tall blob is a tower or saddle on the centreline, else cable. */
const detachedPartOf = (t, w) => {
  if (Math.abs(t) >= 1.5) {
    return "cable";
  }
  return w > 6 ? "tower" : "saddle";
};

const sectionBayBridge = (blobsByGroup) => {
  const blobs = [...(blobsByGroup.get("builds") ?? [])].toSorted((a, b) => b.nv - a.nv);
  if (!blobs.length) {
    return { present: false };
  }
  const [main] = blobs;
  const allIds = new Set();
  for (const b of blobs) {
    for (const id of b.verts) {
      allIds.add(id);
    }
  }
  const pts = [...allIds].map((id) => [wxOf(vx[id]), vy[id] * CAL_SY, wzOf(vz[id])]);

  const axis = principalAxis(pts);
  const { ax, az, cx, cz } = axis;
  const sOf = (p) => (p[0] - cx) * ax + (p[2] - cz) * az;
  const tOf = (p) => -(p[0] - cx) * az + (p[2] - cz) * ax;
  // clockwise from north
  const bearingDeg = (Math.atan2(ax, -az) * 180) / Math.PI;

  const bins = chainageBins(pts, sOf);
  const band = deckBand(bins);
  const { deckY } = band;
  const keys = [...bins.keys()].toSorted((a, b) => a - b);
  const { centre, profile, widths } = chainageProfile(bins, keys, band, axis, tOf);
  widths.sort((a, b) => a - b);
  const medWidth = widths.length ? widths[Math.floor(widths.length / 2)] : null;

  const towers = findTowers(profile, deckY);
  const towerOut = describeTowers(towers, bins, axis, tOf);
  const { cable, cableOffset } = cableProfile(bins, keys, band.deckHi, tOf);
  const sag = cableSag(towerOut, profile);

  // --- Endpoints + simplified centreline ---
  const line = rdp(centre, 0.8);
  const [sf] = line;
  const yb = line.at(-1);
  const rampBins = profile.filter((p) => p.ramp);
  const suspended = profile.filter((p) => p.roadY !== null && !p.ramp);
  // The shore anchorage is where the ramp stops and the level crossing starts —
  // that, not the far west end of the approach viaduct, is the point a landmark
  // table's (u,v) names.
  const anchorS = suspended.length ? suspended[0].s : null;
  const anchorPt = anchorS === null ? sf : [cx + ax * anchorS, cz + az * anchorS];
  const vsAuthored = compareAuthoredBridge(bearingDeg, deckY, towers, sf, anchorPt);

  return {
    approach: {
      rampBins: rampBins.length,
      rampLengthU: r1(rampBins.length * BIN),
      rampLowY: rampBins.length ? r1(Math.min(...rampBins.map((p) => p.roadY))) : null,
      suspendedBins: suspended.length,
      suspendedLengthU: r1(suspended.length * BIN),
    },
    axis: { ax: r4(ax), az: r4(az), bearingDegFromNorth: r1(bearingDeg) },
    blobs: blobs.length,
    cable: {
      planeOffsetM: cableOffset === null ? null : Math.round(cableOffset * 4.446),
      planeOffsetU: cableOffset === null ? null : r1(cableOffset),
      profile: cable,
    },
    centreline: line.map(([x, z]) => [r1(x), r1(z)]),
    centrelineUV: line.map(([x, z]) => [r4(uOf(x)), r4(vOf(z))]),
    chainage: profile,
    deck: {
      widthM: medWidth === null ? null : Math.round(medWidth * 4.446),
      widthU: medWidth === null ? null : r1(medWidth),
      yM: Math.round(deckY * 4.446),
      yU: r1(deckY),
    },
    // Blobs outside the main mesh that stand at tower height, classified so the
    // pooling above is auditable: two are genuine TOWERS the export detached
    // (they sit on the centreline), the rest are cable chunks either side of it.
    detachedTall: blobs
      .slice(1)
      .filter((b) => b.maxY > deckY + TOWER_CLEAR && b.nv >= 16)
      .map((b) => {
        const t = tOf([b.cx, 0, b.cz]);
        return {
          d: r1(b.d),
          nv: b.nv,
          part: detachedPartOf(t, b.w),
          s: r1(sOf([b.cx, 0, b.cz])),
          t: r1(t),
          topY: r1(b.maxY),
          u: r4(uOf(b.cx)),
          v: r4(vOf(b.cz)),
          w: r1(b.w),
        };
      })
      .toSorted((a, b) => a.s - b.s),
    identity: "Bay Bridge, western crossing (SF landfall -> Yerba Buena)",
    landfallYerbaBuena: { u: r4(uOf(yb[0])), v: r4(vOf(yb[1])), x: r1(yb[0]), z: r1(yb[1]) },
    lengthM: Math.round(plLen(line) * 4.446),
    lengthU: r1(plLen(line)),
    mainBlob: { nf: main.nf, nv: main.nv },
    pooledVerts: allIds.size,
    present: true,
    shoreAnchorage: {
      s: anchorS,
      u: r4(uOf(anchorPt[0])),
      v: r4(vOf(anchorPt[1])),
      x: r1(anchorPt[0]),
      z: r1(anchorPt[1]),
    },
    spans: sag,
    towers: towerOut,
    viaductWestEnd: { u: r4(uOf(sf[0])), v: r4(vOf(sf[1])), x: r1(sf[0]), z: r1(sf[1]) },
    vsAuthored,
  };
};

// =========================================================================
// SECTION 4 — Oracle Park
// =========================================================================

const sectionOraclePark = (blobsByGroup, osmNames) => {
  const blobs = [...(blobsByGroup.get("builds_3") ?? [])].toSorted((a, b) => b.nv - a.nv);
  if (!blobs.length) {
    return { present: false };
  }
  const [bowl] = blobs;
  const base = bowl.faces.filter((f) => f.ids.every((id) => vy[id] * CAL_SY <= bowl.minY + 1.5));
  let ring = base.length ? boundaryRing(base) : null;
  let ringFrom = "base";
  // The bowl is an open shell, so an all-faces boundary walk still returns the
  // outer rim; it is just at grandstand height rather than at grade.
  if (!ring || Math.abs(ringArea(ring)) < 0.3 * bowl.w * bowl.d) {
    ring = boundaryRing(bowl.faces);
    ringFrom = "all-faces (outer rim, no closed base slab in the mesh)";
  }
  const simple = ring ? rdp(ring, 0.5) : null;
  const [cx, cz] = simple ? centroidOf(simple) : [bowl.cx, bowl.cz];

  // Height profile around the bowl: 24 angular sectors, ceiling in each.
  const SECT = 24;
  const sect = Array.from({ length: SECT }, () => -1e9);
  const sectR = Array.from({ length: SECT }, () => 0);
  for (const id of bowl.verts) {
    const x = wxOf(vx[id]);
    const z = wzOf(vz[id]);
    const y = vy[id] * CAL_SY;
    let a = Math.atan2(z - cz, x - cx) / (2 * Math.PI);
    a -= Math.floor(a);
    const k = Math.min(SECT - 1, Math.floor(a * SECT));
    if (y > sect[k]) {
      sect[k] = y;
    }
    sectR[k] = Math.max(sectR[k], Math.hypot(x - cx, z - cz));
  }

  // Light masts / flag poles: the tall slender satellites around the bowl.
  const masts = blobs
    .slice(1)
    .filter((b) => b.h > 3 && b.w < 6 && b.d < 6)
    .map((b) => ({
      bearingFromCentreDeg: r1((Math.atan2(b.cz - cz, b.cx - cx) * 180) / Math.PI),
      d: r1(b.d),
      h: r1(b.h),
      radius: r1(Math.hypot(b.cx - cx, b.cz - cz)),
      topY: r1(b.maxY),
      u: r4(uOf(b.cx)),
      v: r4(vOf(b.cz)),
      w: r1(b.w),
      x: r1(b.cx),
      z: r1(b.cz),
    }))
    .toSorted((a, b) => a.bearingFromCentreDeg - b.bearingFromCentreDeg);

  const authored = readAuthoredLandmarks().oraclepark;
  let vsAuthored = null;
  if (authored) {
    const axu = (authored.u - 0.5) * WORLD_W;
    const azw = (authored.v - 0.5) * WORLD_H;
    vsAuthored = {
      authored,
      authoredOuterRadius: 26,
      errorDistM: Math.round(Math.hypot(axu - cx, azw - cz) * 4.446),
      errorDistU: r1(Math.hypot(axu - cx, azw - cz)),
      errorU: r1(axu - cx),
      errorV: r1(azw - cz),
      trueMeanRadius: r1((bowl.w + bowl.d) / 4),
      trueU: r4(uOf(cx)),
      trueV: r4(vOf(cz)),
    };
  }
  // oxlint-disable-next-line sort-keys -- serialized verbatim into the report; key order is part of the output
  return {
    present: true,
    identity: "Oracle Park (OSM name node `AT_T_Park`)",
    blobs: blobs.length,
    bowl: { nf: bowl.nf, nv: bowl.nv },
    vsAuthored,
    centre: { u: r4(uOf(cx)), v: r4(vOf(cz)), x: r1(cx), z: r1(cz) },
    bboxCentre: { u: r4(uOf(bowl.cx)), v: r4(vOf(bowl.cz)) },
    sizeU: { d: r1(bowl.d), w: r1(bowl.w) },
    sizeM: { d: Math.round(bowl.d * 4.446), w: Math.round(bowl.w * 4.446) },
    heightU: { max: r1(bowl.maxY), min: r1(bowl.minY), rise: r1(bowl.h) },
    ringFrom,
    ringPts: simple ? simple.length : 0,
    ring: simple ? flat(simple) : [],
    ringUV: simple ? simple.map(([x, z]) => [r4(uOf(x)), r4(vOf(z))]) : [],
    // Ceiling per 15 deg sector. A null sector has no geometry at all — that is
    // the bowl's open side (Oracle Park opens east onto McCovey Cove), not a
    // measurement failure, so it must not read as "height zero".
    sectorProfile: sect.map((y, i) => ({
      degFromEastCCW: Math.round((i * 360) / SECT),
      radius: sectR[i] === 0 ? null : r1(sectR[i]),
      topY: y === -1e9 ? null : r1(y),
    })),
    masts,
    osm: nearestName(osmNames, cx, cz),
  };
};

// =========================================================================
// SECTION 5 — the water itself (China Basin / Mission Creek)
// =========================================================================

// Box vs truth on the game's own cell grid, so the counts are comparable.
// Cells are classed against the MODEL's water, and separately against the
// shipped box, inside a window that brackets both.
const boxVsModelCells = (inBox) => {
  let boxCells = 0;
  let wetCells = 0;
  let boxButDry = 0;
  let wetButNotBoxed = 0;
  for (let gx = 0; gx < GRID_X; gx += 1) {
    for (let gz = 0; gz < GRID_Z; gz += 1) {
      const cu = (gx + 0.5) / GRID_X;
      const cv = (gz + 0.5) / GRID_Z;
      if (cu < 0.68 || cu > 0.84 || cv < 0.25 || cv > 0.44) {
        continue;
      }
      const boxed = inBox(cu, cv);
      const wet = inWater((cu - 0.5) * WORLD_W, (cv - 0.5) * WORLD_H);
      if (boxed) {
        boxCells += 1;
      }
      if (wet) {
        wetCells += 1;
      }
      if (boxed && !wet) {
        boxButDry += 1;
      }
      if (wet && !boxed) {
        wetButNotBoxed += 1;
      }
    }
  }
  return { boxButDry, boxCells, wetButNotBoxed, wetCells };
};

/**
 * Boundary rings of the model's water mesh, reported globally and clipped to
 * the China Basin window, plus a direct count of how many real footprints the
 * game's crude `box(u,v,0.71,0.8,0.29,0.35)` inlet currently deletes.
 */
const sectionWaterway = (blobsByGroup, footprints) => {
  const wblobs = [...(blobsByGroup.get("waterway") ?? [])].toSorted((a, b) => b.nv - a.nv);
  const rings = [];
  for (const b of wblobs) {
    const ring = boundaryRing(b.faces);
    if (!ring || ring.length < 4) {
      continue;
    }
    const simple = rdp(ring, 1);
    const area = Math.abs(ringArea(simple));
    if (area < 100) {
      continue;
    }
    const [cx, cz] = centroidOf(simple);
    rings.push({
      area: Math.round(area),
      bboxU: [r4(uOf(b.minX)), r4(uOf(b.maxX))],
      bboxV: [r4(vOf(b.minZ)), r4(vOf(b.maxZ))],
      mtls: b.mtls,
      pts: simple.length,
      ring: flat(simple),
      u: r4(uOf(cx)),
      v: r4(vOf(cz)),
    });
  }
  rings.sort((a, b) => b.area - a.area);

  // The game's inlet box, verbatim from src/world/sf-map.ts:80.
  const BOX = { uMax: 0.8, uMin: 0.71, vMax: 0.35, vMin: 0.29 };
  const inBox = (u, v) => u > BOX.uMin && u < BOX.uMax && v > BOX.vMin && v < BOX.vMax;
  let culled = 0;
  let culledOnRealLand = 0;
  let tallestCulled = 0;
  for (const [x, z, h] of footprints) {
    // isLandCell() samples the CELL centre, so replicate that rounding.
    const gx = Math.floor((x / WORLD_W + 0.5) * GRID_X);
    const gz = Math.floor((z / WORLD_H + 0.5) * GRID_Z);
    const cu = (gx + 0.5) / GRID_X;
    const cv = (gz + 0.5) / GRID_Z;
    if (landFactor(cu, cv) > 0.5) {
      continue;
    }
    if (!inBox(cu, cv)) {
      continue;
    }
    culled += 1;
    if (!inWater(x, z)) {
      culledOnRealLand += 1;
    }
    if (h > tallestCulled) {
      tallestCulled = h;
    }
  }

  // The creek itself: the water blob that is NOT the open bay and lies inside
  // the China Basin window. That polygon, not a bounding box, is the shape the
  // inlet should be cut to.
  const creek =
    rings.find((r) => r.u > 0.7 && r.u < 0.82 && r.v > 0.3 && r.v < 0.42 && r.area < 60_000) ??
    null;

  const { boxButDry, boxCells, wetButNotBoxed, wetCells } = boxVsModelCells(inBox);

  return {
    chinaBasin: {
      boxedButDryInModel: boxButDry,
      creekPolygon: creek
        ? {
            area: creek.area,
            bboxU: creek.bboxU,
            bboxV: creek.bboxV,
            pts: creek.pts,
            ring: creek.ring,
            u: creek.u,
            v: creek.v,
          }
        : null,
      culledThatAreOnModelLand: culledOnRealLand,
      footprintsCulledByBox: culled,
      gameBox: BOX,
      gameBoxCells: boxCells,
      modelWetCells: wetCells,
      tallestCulledU: r1(tallestCulled),
      wetInModelButNotBoxed: wetButNotBoxed,
    },
    rings: rings.slice(0, 12),
    waterTriangles: waterTris.length,
  };
};

// =========================================================================
// Main
// =========================================================================

const main = async () => {
  await pass1();
  console.log(`vertices: ${vx.length}`);
  for (const [name, mx, mz, wx, wz] of ANCHORS) {
    const err = Math.hypot(wxOf(mx) - wx, wzOf(mz) - wz);
    console.log(`anchor ${name}: ${err.toFixed(1)}u`);
    if (err > 12) {
      console.error("anchor drift — recheck CAL before trusting anything below");
      process.exit(1);
    }
  }
  buildWaterIndex();
  console.log(`water: ${waterTris.length} triangles from the model's own \`Water\` material`);

  const gamePiersEarly = readGamePiers();
  buildDeckIndex(gamePiersEarly.piers.map((p) => p.ring));
  console.log(`decks: ${deckRings.length} shipped SF_PIERS polygons indexed`);

  await pass2();
  const blobsByGroup = new Map();
  let blobCount = 0;
  for (const [g, faces] of groupFaces) {
    const b = toBlobs(faces);
    blobsByGroup.set(g, b);
    blobCount += b.length;
  }
  console.log(`kept ${groupFaces.size} groups -> ${blobCount} blobs`);

  const gamePiers = gamePiersEarly;
  const osmNames = readOsmPierNames();
  const footprints = readFootprintCentroids();
  console.log(
    `reference: ${gamePiers.piers.length} SF_PIERS + ${gamePiers.dockCount} SF_DOCKS, ` +
      `${osmNames.length} named OSM ways, ${footprints.length} SF_FOOTPRINTS`,
  );

  const { objPiers, context, orphanGame } = sectionPiers(blobsByGroup, gamePiers, osmNames);
  // Bridge first: the shed pass needs its corridor to reject bridge parts.
  const bayBridge = sectionBayBridge(blobsByGroup);
  const pierBuildings = sectionPierBuildings(blobsByGroup, gamePiers, osmNames, bayBridge);
  const oraclePark = sectionOraclePark(blobsByGroup, osmNames);
  const waterway = sectionWaterway(blobsByGroup, footprints);

  const matched = objPiers.filter((p) => p.gameMatch);
  const same = matched.filter((p) => p.gameMatch.verdict === "same polygon");
  const onDeck = pierBuildings.filter((b) => b.onGameDeck >= 0);
  const decksWithBuilding = new Set(onDeck.map((b) => b.onGameDeck));
  const sheds = pierBuildings.filter((b) => b.h >= 2 && b.area >= 100);

  // Render plans: what a later pass should DO with each section, using the
  // game's own kit and procedural geometry. Kept next to the numbers they
  // depend on so a plan can never be read without its evidence.
  const RENDER_PLAN = {
    bayBridge:
      "REBUILD ON THIS ALIGNMENT. Keep the existing bayBridge() geometry generator and " +
      "re-aim it: the crossing runs NE on bearing 40.5 deg from north, not the authored " +
      "84 deg, a 43.5 deg error that currently sends it out to sea parallel to the " +
      "shore instead of at Yerba Buena. The anchorage (u 0.7954 v 0.2127) is only 22.6u " +
      "from where it is authored, so only rotDeg needs to move. Then match the " +
      "arrangement: FOUR towers at 160/175/160u spacing (the 175 is the pair of side " +
      "spans either side of the centre anchorage), tops at 29.7u not 49u, deck at 10.5u " +
      "not 13u, roadway 4.7u wide, main cables in planes at t = +/-2.8u sagging 18u " +
      "below the tower tops to meet the deck at midspan, and a 50u approach ramp " +
      "climbing from y 2.4u at the city end. `centrelineUV` and `cable.profile` are " +
      "directly consumable as a spine + catenary.",
    oraclePark:
      "MOVE IT AND WIDEN IT. The procedural ballpark is 101.4u (451 m) NW of the real " +
      "one — two stadium widths, enough that it currently sits in the water box instead " +
      "of on China Basin's north bank. Retarget to u 0.7838 v 0.3115 and grow the outer " +
      "radius from 26u to ~31u (the real bowl is 65.8 x 56.8u). `ring` is a 39-point " +
      "outer rim and `sectorProfile` gives the ceiling per 15 deg sector, which is what " +
      "the raked-deck arc() pass needs to stop being a constant-height ring: the bowl " +
      "is open toward the bay. `masts` gives 16 real light-standard positions in two " +
      "roof rows plus two tall poles on the water side — replace the four guessed masts " +
      "with these.",
    pierBuildings:
      "BUILD THESE. Extrude each ring as a flat-shaded prism at its measured height, " +
      "exactly like the SF_FOOTPRINTS prism pass in city.ts, but seated on the pier " +
      "deck surface rather than on terrain. 16 candidates, 7 with real massing; 10 fall " +
      "inside a shipped deck polygon and would populate 8 of the 55 decks. The Ferry " +
      "Building (16.2u tall, 1543u2, u 0.7625 v 0.1464) is the single highest-value one " +
      "and deserves a hand-built landmark with its clock tower rather than a prism. " +
      "This does NOT solve the empty-deck problem on its own: 47 decks still carry " +
      "nothing, so the bulk of the Embarcadero bulkhead sheds must stay procedural — " +
      "use these 16 to calibrate the procedural shed's footprint-to-deck ratio and " +
      "height band (2-3.3u for sheds, i.e. one to two storeys) instead of guessing.",
    piers:
      "DO NOTHING. The OBJ's man_made polygons are the same OSM extract sf-piers.ts " +
      "already bakes, at lower coverage (14 over-water polygons vs 55 shipped decks; " +
      "matched pairs agree to ~1% in area). Re-baking piers from the OBJ would delete " +
      "three quarters of the waterfront. Keep bake-piers.mjs as the pier source. The " +
      "one thing worth lifting is the `landuse=port` apron polygon (85k u2, u 0.71-0.82 " +
      "x v 0.10-0.30): that is the Port of San Francisco's quay strip, and paving it as " +
      "one continuous concrete apron behind the finger piers is what makes the " +
      "Embarcadero read as working waterfront instead of decks floating off a kerb.",
    waterway:
      "REPLACE THE BOX WITH THE POLYGON. sf-map.ts's box(u,v, 0.71,0.8, 0.29,0.35) is " +
      "wrong in both axes: 246 of the 264 cells it floods are dry land in the model, " +
      "317 genuinely wet cells fall outside it, and it deletes 268 real building " +
      "footprints (all 268 on dry land, tallest 9.9u) including the ballpark's whole " +
      "block. The real Mission Creek channel is a 24-point polygon spanning u " +
      "0.7297-0.7828 by v 0.327-0.393 — a narrow east-west slot ~0.04 v SOUTH of where " +
      "the box sits. Swap landFactor's China Basin term for a point-in-polygon test " +
      "against `chinaBasin.creekPolygon` (or a 6-8 point simplification of it) and the " +
      "268 footprints come back. `rings[0]` is the model's full 399-point bay outline " +
      "if the traced Embarcadero coast is ever worth revisiting too.",
  };

  const doc = {
    bayBridge: { renderPlan: RENDER_PLAN.bayBridge, ...bayBridge },
    calibration: {
      ...CAL,
      sy: CAL_SY,
      worldH: WORLD_H,
      worldMetresPerUnit: 4.446,
      worldW: WORLD_W,
    },
    generatedBy: "tools/sf-data/extract-marine-obj.mjs",
    oraclePark: { renderPlan: RENDER_PLAN.oraclePark, ...oraclePark },
    pierBuildings: {
      count: pierBuildings.length,
      gameDecksTheyWouldPopulate: decksWithBuilding.size,
      landingOnAGameDeck: onDeck.length,
      list: pierBuildings,
      realSheds: sheds.length,
      renderPlan: RENDER_PLAN.pierBuildings,
    },
    piers: {
      count: objPiers.length,
      gameDockCount: gamePiers.dockCount,
      gameOrphans: orphanGame,
      gamePierCount: gamePiers.piers.length,
      gamePiersWithNoObjCounterpart: orphanGame.length,
      list: objPiers,
      matchedToGamePiers: matched.length,
      renderPlan: RENDER_PLAN.piers,
      samePolygon: same.length,
      unmatched: objPiers.length - matched.length,
      verdict:
        "The OBJ's man_made polygons are the SAME OSM source the game already bakes " +
        "(matched pairs agree to ~1% in area) but a coarser SUBSET of it. sf-piers.ts " +
        "should NOT be re-baked from the OBJ.",
    },
    renderPlan: RENDER_PLAN,
    source: objPath,
    waterfrontContext: { count: context.length, list: context },
    waterway: { renderPlan: RENDER_PLAN.waterway, ...waterway },
  };
  writeFileSync(outPath, JSON.stringify(doc, null, 1));

  // --- Factual summary ---
  console.log("");
  console.log(
    `PIERS   : ${objPiers.length} man_made polygons over water ` +
      `(wet>=${WET_MIN}, area>=${PIER_MIN_AREA}u2) + ${context.length} context polygons`,
  );
  console.log(
    `          ${matched.length} match a shipped SF_PIERS deck within 45u, ` +
      `${same.length} of those are the SAME polygon (area ratio 0.5-2x); ` +
      `${orphanGame.length}/${gamePiers.piers.length} shipped decks have no OBJ counterpart`,
  );
  for (const p of objPiers.slice(0, 8)) {
    console.log(
      `          A=${String(p.area).padStart(5)}u2 ${String(p.pts).padStart(3)}pts u=${p.u} v=${p.v} ` +
        `${p.gameMatch ? `game#${p.gameMatch.index} d=${p.gameMatch.dist}u ratio=${p.gameMatch.areaRatio}` : "NO MATCH"}` +
        `  ~${p.osm?.name ?? "?"}`,
    );
  }
  console.log(
    `SHEDS   : ${pierBuildings.length} building blobs over water or on a shipped deck, ` +
      `${sheds.length} of them real massing (h>=2u, A>=100u2); ` +
      `${onDeck.length} sit INSIDE a deck polygon, populating ${decksWithBuilding.size}/${gamePiers.piers.length}`,
  );
  for (const b of sheds.slice(0, 10)) {
    console.log(
      `          h=${String(b.h).padStart(5)}u A=${String(b.area).padStart(5)}u2 u=${b.u} v=${b.v} ` +
        `${b.onGameDeck >= 0 ? `ON deck#${b.onGameDeck}` : `near deck#${b.nearestGameDeck.index}@${b.nearestGameDeck.dist}u`}` +
        `  ~${b.osm?.name ?? "?"}`,
    );
  }
  if (bayBridge.present) {
    console.log(
      `BRIDGE  : ${bayBridge.lengthU}u (${bayBridge.lengthM} m) on bearing ` +
        `${bayBridge.axis.bearingDegFromNorth} deg from north; deck y=${bayBridge.deck.yU}u ` +
        `(${bayBridge.deck.yM} m), width ${bayBridge.deck.widthU}u (${bayBridge.deck.widthM} m)`,
    );
    console.log(
      `          viaduct west end u=${bayBridge.viaductWestEnd.u} v=${bayBridge.viaductWestEnd.v} -> ` +
        `shore anchorage u=${bayBridge.shoreAnchorage.u} v=${bayBridge.shoreAnchorage.v} -> ` +
        `Yerba Buena u=${bayBridge.landfallYerbaBuena.u} v=${bayBridge.landfallYerbaBuena.v}`,
    );
    console.log(
      `          approach ramp ${bayBridge.approach.rampLengthU}u (down to y=${bayBridge.approach.rampLowY}u), ` +
        `level crossing ${bayBridge.approach.suspendedLengthU}u`,
    );
    for (const t of bayBridge.towers) {
      console.log(
        `          tower s=${String(t.s).padStart(5)} top=${t.topY}u (${t.topM} m) u=${t.u} v=${t.v} base=${t.baseW}u`,
      );
    }
    for (const s of bayBridge.spans) {
      console.log(
        `          span ${s.betweenTowers.join("-")}: ${s.spanU}u (${s.spanM} m), cable dips ${s.sagBelowTowerTop}u`,
      );
    }
    console.log(
      `          cable plane at t=+/-${bayBridge.cable.planeOffsetU}u (${bayBridge.cable.planeOffsetM} m), ` +
        `${bayBridge.cable.profile.length} sampled stations`,
    );
  }
  if (bayBridge.vsAuthored) {
    const a = bayBridge.vsAuthored;
    console.log(
      `          vs landmarks.ts: authored at u=${a.authored.u} v=${a.authored.v} rot=${a.authored.rotDeg}deg ` +
        `= bearing ${a.authoredBearingDegFromNorth}; TRUE bearing ${a.trueBearingDegFromNorth} ` +
        `-> heading is ${Math.abs(a.bearingErrorDeg)} deg off, anchor is ${a.anchorErrorU}u off`,
    );
    console.log(
      `          authored deck ${a.authoredDeckY}u / towers ${a.authoredTowerCount}@${a.authoredTowerTopY}u; ` +
        `true deck ${a.trueDeckY}u / towers ${a.trueTowerCount}@${a.trueTowerTopY}u`,
    );
  }
  if (oraclePark.present) {
    console.log(
      `BALLPARK: centre u=${oraclePark.centre.u} v=${oraclePark.centre.v}, ` +
        `${oraclePark.sizeU.w}x${oraclePark.sizeU.d}u (${oraclePark.sizeM.w}x${oraclePark.sizeM.d} m), ` +
        `rise ${oraclePark.heightU.rise}u, ${oraclePark.ringPts}-pt ring (${oraclePark.ringFrom}), ` +
        `${oraclePark.masts.length} masts`,
    );
    if (oraclePark.vsAuthored) {
      const a = oraclePark.vsAuthored;
      console.log(
        `          vs landmarks.ts: authored u=${a.authored.u} v=${a.authored.v} -> ` +
          `${a.errorDistU}u (${a.errorDistM} m) off; authored radius ${a.authoredOuterRadius}u vs true ${a.trueMeanRadius}u`,
      );
    }
  }
  const cb = waterway.chinaBasin;
  console.log(
    `WATER   : ${waterway.waterTriangles} tris, ${waterway.rings.length} rings emitted; ` +
      `inlet box covers ${cb.gameBoxCells} cells (${cb.boxedButDryInModel} of them DRY in the model), ` +
      `${cb.wetInModelButNotBoxed} genuinely wet cells fall outside it`,
  );
  if (cb.creekPolygon) {
    const c = cb.creekPolygon;
    console.log(
      `          real Mission Creek channel: ${c.pts}-pt polygon, ${c.area}u2, ` +
        `u ${c.bboxU[0]}-${c.bboxU[1]} v ${c.bboxV[0]}-${c.bboxV[1]}`,
    );
  }
  console.log(
    `          the box deletes ${cb.footprintsCulledByBox} real footprints, ` +
      `${cb.culledThatAreOnModelLand} of them on dry land in the model (tallest ${cb.tallestCulledU}u)`,
  );
  console.log(`\nwrote ${outPath}`);
};

main();
