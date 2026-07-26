// Extract the REAL SF TRANSIT NETWORK (cable car, streetcar, Muni Metro,
// trolleybus wire, bus, heavy rail) from the licensed "Downtown San Francisco"
// OBJ, as world-space CENTRELINE POLYLINES.
//
//   node tools/sf-data/extract-transit-obj.mjs <path-to-obj> [out.json]
//
// Sibling of extract-footprints.mjs and shares its verified model->world
// calibration (see CAL below). TWO outputs: the full JSON analysis report at
// [out.json], and the shipped game module src/world/sf-transit.ts (see EMIT at
// the bottom) — the render-ready subset, stamped with the NETWORK_GEN_ID of the
// sf-network.ts it was resolved against.
//
// RE-RUN THIS AFTER EVERY `pnpm bake:map`. The emitted coverage is a list of
// INDICES into SF_EDGES, and a map bake renumbers them; `pnpm test` asserts the
// stamp so stale indices fail the suite instead of painting track through
// buildings.
//
// HOW THE OBJ STORES ROUTES
// -------------------------
// Route relations are NOT `l` polylines. Each is an extruded rectangular tube
// swept along the OSM way: per path point 4 verts (2 at y=0.5, 2 at y=0), per
// segment 4 quads (top / side / bottom / side, all `usemtl roads`). So the
// centreline is exact, not approximate: take only the TOP quads, and every top
// quad's two CROSS edges (the ribbon-width edges, shared with the neighbouring
// quad) have a midpoint that IS a path point of the original OSM way.
//
//   quad [a, b, c, d] -> cross edges (a,d) and (b,c); midpoints = path points
//
// Choosing which of the two opposite-edge pairings is "cross" uses topology,
// not length: cross edges are SHARED between consecutive top quads, along-edges
// are ribbon boundary and appear once. Ties (isolated one-quad stubs) fall back
// to the shorter pairing. Deviation of the recovered centreline from the source
// ribbon is therefore 0 by construction; the only lossy step is the final RDP,
// whose max deviation is measured and reported.
//
// Path points are then MERGED BY POSITION into one graph per kind, which
// collapses the enormous overlap between coincident routes (57 bus relations
// mostly redraw the same streets) into a unique corridor network, and turns
// crossings into real degree-4 junctions. The emitted polylines are STROKES,
// not chains: tracing runs THROUGH a junction while the street name is
// unchanged and the turn is under STROKE_TURN, so "the cable track on Hyde
// Street" comes out as one polyline instead of 30 block-long fragments.
//
// IDENTIFICATION uses two independent external sources, never vibes:
//   - sf-streets.raw.json (the OSM extract the game's own network is baked
//     from) gives every chain a street NAME by nearest named way.
//   - named lines (Powell-Hyde, Powell-Mason, California St, F-line) are
//     recovered by Dijkstra between terminals located as the geometric
//     intersection of two named OSM streets.
//
// SNAPPING: each point is measured against, and optionally pulled onto, the
// game's own baked street centrelines (src/world/sf-network.ts) so rails land
// on our asphalt. Before/after distance distributions are printed.

import { spawnSync } from "node:child_process";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import { plLen, projU, projV, rdp, WORLD_H, WORLD_W } from "./lib.mjs";

const objPath = process.argv[2];
const outPath = process.argv[3] ?? "transit.json";
if (!objPath) {
  console.error("usage: node extract-transit-obj.mjs <obj> [out.json]");
  process.exit(1);
}

// --- Model -> world transform (identical to extract-footprints.mjs; do NOT
// re-fit it — see that file's comment for how it was anchored). ---
const CAL = { sx: 0.17829, sz: 0.17909, bx: 325.2, bz: -400.5 };
const toWorld = (mx, mz) => [mx * CAL.sx + CAL.bx, mz * CAL.sz + CAL.bz];
const ANCHORS = [
  ["Salesforce", 2458.4, -2088.9, 760.0, -770.1],
  ["Transamerica", 1809.9, -2842.1, 644.9, -907.7],
];

// Merge radius for path points, in MODEL units. 1 world u ~ 5.6 model u, so
// 1.5 model u ~ 0.27 world u: tight enough that two genuinely distinct track
// points never merge (the tightest real spacing is a ~2.1u ribbon width),
// loose enough to absorb the exporter's float re-rounding of shared OSM nodes.
const MERGE_R = 1.5;
const RDP_EPS = 1.0; // world units
const SNAP_MAX = 6.0; // world units; beyond this we leave the point alone
const NAME_MAX = 10.0; // world units; street-name lookup radius
const MEASURE_MAX = 150.0; // world units; distance-to-asphalt probe radius (report only)
const DEDUPE_D = 4.0; // world units; "_suspended duplicates live" test radius
const DEDUPE_FRAC = 0.9; // >= this share inside live track => the variant is a redraw
const MIN_CHAIN_U = 1.5; // world units; drop only true slivers — a stub that
//                          crosses one junction still has to be drawn
const MERGE_W = 2.5; // world units; second merge, after snapping, that folds the
//                      two directional ribbons of one route into one track
const STROKE_TURN = Math.cos((65 * Math.PI) / 180); // stroke continuation limit
const XSEC_MAX = 40.0; // world units; how far apart two named streets may be
//                        and still be called an intersection (Powell dies into
//                        Market across Hallidie Plaza at 23.5u)

// Alignments the model draws AT GRADE that are underground in reality. Painting
// them puts phantom rails down the city's main street: of the light_rail
// corridor, 2342u of 2973u runs in the Market Street subway, and railway adds
// 2812u of the same tunnel plus 387u of the Stockton Tunnel (a ROAD tunnel the
// OBJ tagged as railway). Surface Market IS carried — by the F-line, which
// comes through as `tram`, so the filter is per-mode and never touches a mode
// that is a surface mode by definition.
const UNDERGROUND_STREETS = new Set(["Market Street", "Stockton Tunnel"]);
const UNDERGROUND_MODES = new Set(["light_rail", "railway"]);

// Modes that reach src/world/sf-transit.ts as track geometry. `bus` leaves no
// physical trace on the roadway (71 relations mostly redraw the same streets),
// so it ships as a service-density weight only; `monorail` is declared in the
// OBJ with zero faces.
const EMITTED_MODES = ["cable", "tram", "light_rail", "trolleybus", "railway"];

// ---------------------------------------------------------------------------
// Group classification
// ---------------------------------------------------------------------------
// `route_trollybus_suspended_1` is a real (misspelled) group in the file.
const KIND_RE = [
  [/^route_cable(_|$)/, "cable"],
  [/^route_tram(_|$)/, "tram"],
  [/^route_light_rail(_|$)/, "light_rail"],
  [/^route_troll?eybus(_|$)/, "trolleybus"],
  [/^route_bus(_|$)/, "bus"],
  [/^railway$/, "railway"],
  [/^route_monorail(_|$)/, "monorail"],
  [/^route_subway(_|$)/, "subway"],
  [/^route_train(_|$)/, "train"],
  [/^route_ferry(_|$)/, "ferry"],
];
function classify(group) {
  const bare = group.replace(/_suspended/, "");
  for (const [re, kind] of KIND_RE) if (re.test(bare)) return kind;
  return null;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx;
  const qz = az + t * dz;
  return [Math.hypot(px - qx, pz - qz), qx, qz];
}

/** Uniform-grid index over line segments; nearest() is the only query. */
function makeSegIndex(cell) {
  const buckets = new Map();
  const segs = [];
  const key = (i, j) => `${i},${j}`;
  return {
    add(ax, az, bx, bz, payload) {
      const id = segs.push([ax, az, bx, bz, payload]) - 1;
      const i0 = Math.floor(Math.min(ax, bx) / cell);
      const i1 = Math.floor(Math.max(ax, bx) / cell);
      const j0 = Math.floor(Math.min(az, bz) / cell);
      const j1 = Math.floor(Math.max(az, bz) / cell);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = key(i, j);
          let b = buckets.get(k);
          if (!b) buckets.set(k, (b = []));
          b.push(id);
        }
      }
    },
    /** @returns {{d:number,x:number,z:number,payload:unknown}|null} */
    nearest(px, pz, maxD) {
      const r = Math.ceil(maxD / cell);
      const ci = Math.floor(px / cell);
      const cj = Math.floor(pz / cell);
      let best = null;
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          const b = buckets.get(key(i, j));
          if (!b) continue;
          for (const id of b) {
            const s = segs[id];
            const [d, qx, qz] = segDist(px, pz, s[0], s[1], s[2], s[3]);
            if (d <= maxD && (!best || d < best.d)) best = { d, x: qx, z: qz, payload: s[4] };
          }
        }
      }
      return best;
    },
    count: () => segs.length,
  };
}

const pct = (arr, t) => {
  if (arr.length === 0) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * t))];
};
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const uOf = (x) => x / WORLD_W + 0.5;
const vOf = (z) => z / WORLD_H + 0.5;

/**
 * Format an emitted module in place, so `pnpm format` cannot go red just because
 * someone re-ran a bake. Best effort: a missing binary is a warning, not a
 * failed extract — the data is already written by then.
 */
function oxfmt(path) {
  const bin = resolve(new URL("../../../../node_modules/.bin/oxfmt", import.meta.url).pathname);
  const r = spawnSync(bin, ["--write", path], { stdio: "ignore" });
  if (r.status !== 0)
    console.log(`  (could not run oxfmt on ${path} — format it before committing)`);
}

// ---------------------------------------------------------------------------
// The game's own baked street network — snap target
// ---------------------------------------------------------------------------
function loadGameNetwork() {
  const src = readFileSync(new URL("../../src/world/sf-network.ts", import.meta.url), "utf8");
  // The stamp travels with the coverage: edge indices only mean anything for
  // the exact bake that produced them.
  const stamp = /NETWORK_GEN_ID = "([^"]+)"/.exec(src);
  if (!stamp) {
    console.error("sf-network.ts carries no NETWORK_GEN_ID — cannot stamp the emitted module");
    process.exit(1);
  }
  const idx = makeSegIndex(24);
  const edgeLen = [];
  for (const m of src.matchAll(/p: \[([-\d.,\s]+)\]/g)) {
    const nums = m[1].split(",").map(Number);
    const e = edgeLen.length;
    let L = 0;
    for (let i = 2; i + 1 < nums.length; i += 2) {
      idx.add(nums[i - 2], nums[i - 1], nums[i], nums[i + 1], e);
      L += Math.hypot(nums[i] - nums[i - 2], nums[i + 1] - nums[i - 1]);
    }
    edgeLen.push(L);
  }
  return { idx, edgeLen, edges: edgeLen.length, genId: stamp[1] };
}

// ---------------------------------------------------------------------------
// OSM street names — identification source
// ---------------------------------------------------------------------------
function loadNamedStreets() {
  const raw = JSON.parse(readFileSync(new URL("./sf-streets.raw.json", import.meta.url), "utf8"));
  const idx = makeSegIndex(24);
  /** @type {Map<string, number[][]>} name -> list of world polylines */
  const byName = new Map();
  let ways = 0;
  for (const el of raw.elements) {
    const name = el?.tags?.name;
    if (!name || !el.geometry) continue;
    const pl = [];
    for (const g of el.geometry) {
      if (!g) continue;
      pl.push([(projU(g.lon) - 0.5) * WORLD_W, (projV(g.lat) - 0.5) * WORLD_H]);
    }
    if (pl.length < 2) continue;
    ways++;
    for (let i = 1; i < pl.length; i++) {
      idx.add(pl[i - 1][0], pl[i - 1][1], pl[i][0], pl[i][1], name);
    }
    let l = byName.get(name);
    if (!l) byName.set(name, (l = []));
    l.push(pl);
  }
  return { idx, byName, ways };
}

/**
 * Geometric intersection of two named OSM streets: the midpoint of the closest
 * approach between any segment of A and any vertex of B (vertex-to-segment is
 * enough — OSM shares a node at real intersections, so the true crossing is a
 * vertex of both).
 */
function streetIntersection(streets, nameA, nameB) {
  const A = streets.byName.get(nameA);
  const B = streets.byName.get(nameB);
  if (!A || !B) return null;
  let best = null;
  for (const pb of B) {
    for (const [px, pz] of pb) {
      for (const pa of A) {
        for (let i = 1; i < pa.length; i++) {
          const [d, qx, qz] = segDist(px, pz, pa[i - 1][0], pa[i - 1][1], pa[i][0], pa[i][1]);
          if (!best || d < best.d) best = { d, x: (px + qx) / 2, z: (pz + qz) / 2 };
        }
      }
    }
  }
  return best && best.d < XSEC_MAX ? best : null;
}

// ---------------------------------------------------------------------------
// Pass 1 — stream the OBJ, keep only transit groups' faces
// ---------------------------------------------------------------------------
const vx = [];
const vy = [];
const vz = [];
/** @type {Map<string, {kind:string, susp:boolean, quads:number[][], tris:number}>} */
const groups = new Map();
let cur = null;
let curRec = null;
let emptyGroups = 0;

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
    if (!curRec) return;
    const parts = l.slice(2).trim().split(/\s+/);
    if (parts.length !== 4) {
      curRec.tris++;
      return;
    }
    const ids = [];
    for (const p of parts) {
      const s = p.indexOf("/") >= 0 ? p.slice(0, p.indexOf("/")) : p;
      let id = Number(s);
      if (id < 0) id = vx.length + 1 + id;
      ids.push(id - 1);
    }
    curRec.quads.push(ids);
  } else if (l.startsWith("o ") || l.startsWith("g ")) {
    cur = l.slice(2).trim();
    const kind = classify(cur);
    curRec = null;
    if (kind) {
      let rec = groups.get(cur);
      if (!rec) {
        rec = { kind, susp: cur.includes("suspended"), quads: [], tris: 0 };
        groups.set(cur, rec);
      }
      curRec = rec;
    }
  }
});
rl.on("close", () => {
  for (const [, rec] of groups) if (rec.quads.length === 0 && rec.tris === 0) emptyGroups++;
  main();
});

// ---------------------------------------------------------------------------
// Ribbon -> centreline graph
// ---------------------------------------------------------------------------
/**
 * Build one merged centreline graph from a set of OBJ groups.
 * @returns {{pos:number[][], adj:Map<number,Set<number>>, stats:object}}
 */
function buildGraph(recs) {
  // --- select TOP quads: horizontal, and (of the two horizontal orientations)
  // the one whose mean Y is higher. Orientation is read off the Newell normal
  // so the choice is self-validating rather than assumed. ---
  const horizA = []; // ny > 0
  const horizB = []; // ny < 0
  let nonHoriz = 0;
  for (const rec of recs) {
    for (const f of rec.quads) {
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let i = 0; i < 4; i++) {
        const a = f[i];
        const b = f[(i + 1) % 4];
        nx += (vy[a] - vy[b]) * (vz[a] + vz[b]);
        ny += (vz[a] - vz[b]) * (vx[a] + vx[b]);
        nz += (vx[a] - vx[b]) * (vy[a] + vy[b]);
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      const uy = ny / len;
      if (uy > 0.9) horizA.push(f);
      else if (uy < -0.9) horizB.push(f);
      else nonHoriz++;
    }
  }
  const meanY = (fs) => {
    let s = 0;
    let n = 0;
    for (const f of fs)
      for (const id of f) {
        s += vy[id];
        n++;
      }
    return n ? s / n : -1e9;
  };
  const top = meanY(horizA) >= meanY(horizB) ? horizA : horizB;
  const bottom = top === horizA ? horizB : horizA;

  // --- cross-edge pairing by topology ---
  const ecount = new Map();
  const ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const f of top) for (let i = 0; i < 4; i++) ecount.set(ek(f[i], f[(i + 1) % 4]), 0);
  for (const f of top)
    for (let i = 0; i < 4; i++) {
      const k = ek(f[i], f[(i + 1) % 4]);
      ecount.set(k, ecount.get(k) + 1);
    }
  let byTopology = 0;
  let byLength = 0;

  // --- merged node graph ---
  // Bucket-and-search, NOT bucket-as-identity: a plain quantized key splits two
  // points 0.002 apart whenever they straddle a bucket edge, and the C4D export
  // re-rounds shared OSM nodes just enough for that to happen. That fragmented
  // the cable-car graph into 120 disconnected pieces. Search the 3x3
  // neighbourhood and reuse any node within MERGE_R instead.
  const buckets = new Map(); // "i,j" -> node ids
  const pos = [];
  const adj = new Map();
  const nodeAt = (mx, mz) => {
    const bi = Math.floor(mx / MERGE_R);
    const bj = Math.floor(mz / MERGE_R);
    for (let i = bi - 1; i <= bi + 1; i++) {
      for (let j = bj - 1; j <= bj + 1; j++) {
        const b = buckets.get(`${i},${j}`);
        if (!b) continue;
        for (const id of b) {
          if (Math.hypot(pos[id][0] - mx, pos[id][1] - mz) <= MERGE_R) return id;
        }
      }
    }
    const id = pos.push([mx, mz]) - 1;
    adj.set(id, new Set());
    const k = `${bi},${bj}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(id);
    return id;
  };
  const link = (a, b) => {
    if (a === b) return;
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  const widths = [];
  for (const f of top) {
    const [a, b, c, d] = f;
    // pairing 1: cross = (a,b) & (c,d);  pairing 2: cross = (b,c) & (d,a)
    const s1 = ecount.get(ek(a, b)) + ecount.get(ek(c, d));
    const s2 = ecount.get(ek(b, c)) + ecount.get(ek(d, a));
    let cross;
    if (s1 !== s2) {
      cross =
        s1 > s2
          ? [
              [a, b],
              [c, d],
            ]
          : [
              [b, c],
              [d, a],
            ];
      byTopology++;
    } else {
      const L = (p, q) => Math.hypot(vx[p] - vx[q], vz[p] - vz[q]);
      cross =
        L(a, b) + L(c, d) < L(b, c) + L(d, a)
          ? [
              [a, b],
              [c, d],
            ]
          : [
              [b, c],
              [d, a],
            ];
      byLength++;
    }
    const mids = cross.map(([p, q]) => {
      widths.push(Math.hypot(vx[p] - vx[q], vz[p] - vz[q]));
      return nodeAt((vx[p] + vx[q]) / 2, (vz[p] + vz[q]) / 2);
    });
    link(mids[0], mids[1]);
  }
  // Connected components — the honest measure of how fragmented the recovered
  // network is, and the reason a Dijkstra between two terminals can fail.
  const seen = new Set();
  const compSizes = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    let n = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const u = stack.pop();
      n++;
      for (const v of adj.get(u))
        if (!seen.has(v)) {
          seen.add(v);
          stack.push(v);
        }
    }
    compSizes.push(n);
  }
  compSizes.sort((a, b) => b - a);

  return {
    pos,
    adj,
    stats: {
      quads: top.length + bottom.length + nonHoriz,
      topQuads: top.length,
      bottomQuads: bottom.length,
      nonHorizQuads: nonHoriz,
      pairedByTopology: byTopology,
      pairedByLength: byLength,
      nodes: pos.length,
      components: compSizes.length,
      biggestComponents: compSizes.slice(0, 6),
      ribbonWidthModel: r2(pct(widths, 0.5)),
      ribbonWidthWorld: r2(pct(widths, 0.5) * CAL.sx),
    },
  };
}

/**
 * Model graph -> world graph: measure, snap, then RE-MERGE.
 *
 * The model draws each direction of a route as its OWN ribbon, laterally offset
 * by ~0.5-2.5u. Left alone that doubles every corridor's length and splits the
 * cable-car network into two never-touching halves (measured: 3858u of "cable
 * track" for a system with ~1900u of it, and 2 big components where there is
 * one network). Snapping both onto the game's street centreline collapses the
 * pair, and a second merge at MERGE_W finishes the job for the stretches that
 * have no asphalt under them.
 *
 * Also tallies, per covered game edge, which named OSM street the snap points
 * landed on. That per-EDGE vote (not the per-stroke label) is what lets the
 * emitted coverage be grouped into corridors and the underground alignments be
 * filtered out — a stroke label is one vote for a whole run of edges.
 *
 * @returns {{pos:number[][], adj:Map<number,Set<number>>, preD:number[],
 *            snapped:number, points:number, merged:number,
 *            coveredEdges:Set<number>, edgeVotes:Map<number,Map<string,number>>}}
 */
function consolidate(g, net, streets) {
  const preD = [];
  const placed = [];
  const coveredEdges = new Set();
  /** game edge index -> street name -> snap-point count ("" = unnamed) */
  const edgeVotes = new Map();
  let snapped = 0;
  for (const [mx, mz] of g.pos) {
    const [x, z] = toWorld(mx, mz);
    const hit = net.idx.nearest(x, z, MEASURE_MAX);
    preD.push(hit ? hit.d : MEASURE_MAX);
    if (hit && hit.d <= SNAP_MAX) {
      placed.push([hit.x, hit.z]);
      coveredEdges.add(hit.payload);
      const nameHit = streets.idx.nearest(hit.x, hit.z, NAME_MAX);
      let votes = edgeVotes.get(hit.payload);
      if (!votes) edgeVotes.set(hit.payload, (votes = new Map()));
      const nm = nameHit ? nameHit.payload : "";
      votes.set(nm, (votes.get(nm) ?? 0) + 1);
      snapped++;
    } else {
      placed.push([x, z]);
    }
  }
  const buckets = new Map();
  const pos = [];
  const remap = new Int32Array(placed.length);
  // Snapped nodes are inserted FIRST so they become the cluster representative:
  // otherwise a merge can drag a node that was sitting exactly on our asphalt
  // back off it, and the after-snap distribution comes out worse than before.
  const order = [...placed.keys()].sort(
    (a, b) => (preD[a] <= SNAP_MAX ? 0 : 1) - (preD[b] <= SNAP_MAX ? 0 : 1) || a - b,
  );
  for (const i of order) {
    const [x, z] = placed[i];
    const bi = Math.floor(x / MERGE_W);
    const bj = Math.floor(z / MERGE_W);
    let found = -1;
    for (let a = bi - 1; a <= bi + 1 && found < 0; a++) {
      for (let b = bj - 1; b <= bj + 1 && found < 0; b++) {
        for (const id of buckets.get(`${a},${b}`) ?? []) {
          if (Math.hypot(pos[id][0] - x, pos[id][1] - z) <= MERGE_W) {
            found = id;
            break;
          }
        }
      }
    }
    if (found < 0) {
      found = pos.push([x, z]) - 1;
      const k = `${bi},${bj}`;
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(found);
    }
    remap[i] = found;
  }
  const adj = new Map();
  for (let i = 0; i < pos.length; i++) adj.set(i, new Set());
  for (const [a, nbrs] of g.adj) {
    for (const b of nbrs) {
      const ra = remap[a];
      const rb = remap[b];
      if (ra === rb) continue;
      adj.get(ra).add(rb);
      adj.get(rb).add(ra);
    }
  }
  return {
    pos,
    adj,
    preD,
    snapped,
    coveredEdges,
    edgeVotes,
    points: placed.length,
    merged: placed.length - pos.length,
  };
}

/**
 * Group covered game edges into named CORRIDORS. Each edge is assigned to the
 * street that won its snap-point vote (ties broken lexicographically so the
 * output is deterministic), so the corridors PARTITION the coverage — their
 * union is the flat edge list and no edge is counted twice.
 *
 * @returns {{street:string, lengthU:number, edges:number[]}[]} longest first
 */
function buildCorridors(edgeVotes, net) {
  const byStreet = new Map();
  for (const [edge, votes] of edgeVotes) {
    let street = "";
    let best = -1;
    for (const [name, n] of [...votes].toSorted((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (n > best) {
        best = n;
        street = name;
      }
    }
    let list = byStreet.get(street);
    if (!list) byStreet.set(street, (list = []));
    list.push(edge);
  }
  const out = [];
  for (const [street, edges] of byStreet) {
    edges.sort((a, b) => a - b);
    out.push({
      street,
      lengthU: r1(edges.reduce((s, e) => s + net.edgeLen[e], 0)),
      edges,
    });
  }
  out.sort((a, b) => b.lengthU - a.lengthU || (a.street < b.street ? -1 : 1));
  return out;
}

/**
 * Per-relation service density: how many of the OBJ's route objects cover each
 * game edge. Snapped straight off the ribbon VERTICES (no centreline recovery)
 * because a relative weight does not need sub-metre alignment — and each object
 * is one route direction/variant, so the count is a density, not a route count.
 * @returns {Map<number, number>}
 */
function edgeLoad(recs, net) {
  const load = new Map();
  for (const rec of recs) {
    const ids = new Set();
    for (const f of rec.quads) for (const id of f) ids.add(id);
    const edges = new Set();
    for (const id of ids) {
      const [x, z] = toWorld(vx[id], vz[id]);
      const hit = net.idx.nearest(x, z, SNAP_MAX);
      if (hit) edges.add(hit.payload);
    }
    for (const e of edges) load.set(e, (load.get(e) ?? 0) + 1);
  }
  return load;
}

/** Connected-component sizes, largest first. */
function components(adj) {
  const seen = new Set();
  const out = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    let n = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const u = stack.pop();
      n++;
      for (const v of adj.get(u))
        if (!seen.has(v)) {
          seen.add(v);
          stack.push(v);
        }
    }
    out.push(n);
  }
  return out.sort((a, b) => b - a);
}

/**
 * Trace STROKES: maximal runs of graph edges that share a street label and turn
 * by less than STROKE_TURN at each node. Deterministic — edges are visited in
 * sorted (a,b) order and continuations break ties by smallest turn.
 * @returns {{ids:number[], label:string|null}[]}
 */
function traceStrokes(g, labelOf) {
  const { pos, adj } = g;
  const ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const used = new Set();
  const edges = [];
  for (const [a, nbrs] of adj) for (const b of nbrs) if (a < b) edges.push([a, b]);
  edges.sort((p, q) => p[0] - q[0] || p[1] - q[1]);

  const dirOf = (from, to) => {
    const dx = pos[to][0] - pos[from][0];
    const dz = pos[to][1] - pos[from][1];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  /** Walk forward from `node` (arrived from `prev`), appending node ids. */
  const extend = (out, prev, node, label) => {
    for (;;) {
      const [dx, dz] = dirOf(prev, node);
      let best = -1;
      let bestDot = STROKE_TURN;
      const cands = [...adj.get(node)].sort((a, b) => a - b);
      for (const n of cands) {
        if (n === prev || used.has(ek(node, n))) continue;
        if (labelOf(node, n) !== label) continue;
        const [ex, ez] = dirOf(node, n);
        const dot = dx * ex + dz * ez;
        if (dot > bestDot) {
          bestDot = dot;
          best = n;
        }
      }
      if (best < 0) return;
      used.add(ek(node, best));
      out.push(best);
      prev = node;
      node = best;
      if (out.length > 100000) return; // paranoia against a pathological ring
    }
  };

  const strokes = [];
  for (const [a, b] of edges) {
    if (used.has(ek(a, b))) continue;
    used.add(ek(a, b));
    const label = labelOf(a, b);
    const fwd = [b];
    extend(fwd, a, b, label);
    const back = [a];
    extend(back, b, a, label);
    strokes.push({ ids: [...back.reverse(), ...fwd], label });
  }
  return strokes;
}

/**
 * Split a node-id run into world-space polylines that stay inside the
 * playfield. Filtering out-of-bounds points in place would weld the two sides
 * of the gap into one phantom straight segment kilometres long.
 */
function clipToWorld(pts) {
  const out = [];
  let run = [];
  for (const p of pts) {
    if (Math.abs(p[0]) <= WORLD_W / 2 && Math.abs(p[1]) <= WORLD_H / 2) run.push(p);
    else {
      if (run.length >= 2) out.push(run);
      run = [];
    }
  }
  if (run.length >= 2) out.push(run);
  return out;
}

/**
 * RDP that survives closed rings. Plain RDP on a loop degenerates: first and
 * last point coincide, so the chord is zero-length, every interior point tests
 * as "on the line", and the whole loop collapses to a dot (this is what showed
 * up as a 282u "max deviation" before). Split near-closed runs at the point
 * farthest from the start and simplify each half.
 */
function rdpSafe(pts, eps) {
  if (pts.length <= 2) return pts;
  const chord = Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]);
  if (chord > 0.05 * plLen(pts)) return rdp(pts, eps);
  let far = 0;
  let fd = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  if (far < 1 || far > pts.length - 2) return rdp(pts, eps);
  const l = rdp(pts.slice(0, far + 1), eps);
  const r = rdp(pts.slice(far), eps);
  return [...l.slice(0, -1), ...r];
}

/** Dijkstra over the merged graph, by euclidean edge length. */
function shortestPath(g, from, to) {
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const seen = new Set();
  const queue = [[0, from]];
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, u] = queue.shift();
    if (seen.has(u)) continue;
    seen.add(u);
    if (u === to) break;
    for (const v of g.adj.get(u)) {
      if (seen.has(v)) continue;
      const w = Math.hypot(g.pos[u][0] - g.pos[v][0], g.pos[u][1] - g.pos[v][1]);
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, u);
        queue.push([nd, v]);
      }
    }
  }
  if (!seen.has(to)) return null;
  const out = [];
  for (let c = to; c !== undefined; c = prev.get(c)) {
    out.push(g.pos[c]);
    if (c === from) break;
  }
  return out.reverse();
}

const nearestNode = (g, x, z) => {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < g.pos.length; i++) {
    const d = Math.hypot(g.pos[i][0] - x, g.pos[i][1] - z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return { id: best, d: bd };
};

/** Max distance from every source point to the simplified polyline. */
function maxDeviation(src, simp) {
  let worst = 0;
  for (const [px, pz] of src) {
    let d = Infinity;
    for (let i = 1; i < simp.length; i++) {
      const [dd] = segDist(px, pz, simp[i - 1][0], simp[i - 1][1], simp[i][0], simp[i][1]);
      if (dd < d) d = dd;
    }
    if (d > worst) worst = d;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  for (const [name, mx, mz, wx, wz] of ANCHORS) {
    const [ax, az] = toWorld(mx, mz);
    const err = Math.hypot(ax - wx, az - wz);
    console.log(`anchor ${name}: (${r1(ax)}, ${r1(az)}) vs (${wx}, ${wz}) — ${r1(err)}u`);
    if (err > 12) {
      console.error("anchor drift — recheck CAL before emitting");
      process.exit(1);
    }
  }

  const net = loadGameNetwork();
  const streets = loadNamedStreets();
  console.log(
    `game network: ${net.edges} edges / ${net.idx.count()} segs · named OSM ways: ${streets.ways} (${streets.byName.size} distinct names)`,
  );

  // --- group inventory ---
  const byKind = new Map();
  for (const [gname, rec] of groups) {
    let k = byKind.get(rec.kind);
    if (!k) byKind.set(rec.kind, (k = { live: [], susp: [], names: [] }));
    (rec.susp ? k.susp : k.live).push(rec);
    k.names.push(gname);
  }
  console.log("\n--- OBJ group inventory ---");
  let totalQuads = 0;
  let totalTris = 0;
  for (const [kind, k] of [...byKind].sort()) {
    const q = [...k.live, ...k.susp].reduce((s, r) => s + r.quads.length, 0);
    const t = [...k.live, ...k.susp].reduce((s, r) => s + r.tris, 0);
    totalQuads += q;
    totalTris += t;
    console.log(
      `${kind.padEnd(12)} objects=${String(k.names.length).padStart(3)} (live ${k.live.length} / suspended ${k.susp.length})  quads=${String(q).padStart(7)}  non-quad faces=${t}`,
    );
  }
  console.log(
    `total: ${groups.size} transit objects, ${totalQuads} quads, ${totalTris} non-quad faces skipped, ${emptyGroups} empty declarations`,
  );

  const routes = [];
  const kindStats = {};
  /** kind -> indices into SF_EDGES that carry it (raw, including underground). */
  const coverage = {};
  /** kind -> named corridors partitioning the SURFACE coverage, longest first. */
  const corridors = {};
  /** game edge index -> number of OBJ bus route objects covering it. */
  let busLoad = new Map();

  for (const [kind, k] of [...byKind].sort()) {
    if (k.live.length === 0 && k.susp.length === 0) continue;
    const liveHas = k.live.some((r) => r.quads.length > 0);
    const suspHas = k.susp.some((r) => r.quads.length > 0);
    if (!liveHas && !suspHas) {
      console.log(`\n### ${kind}: declared but carries no geometry — skipped`);
      kindStats[kind] = { note: "declared in OBJ but carries no faces" };
      continue;
    }

    console.log(`\n### ${kind}`);
    const gLive = liveHas ? buildGraph(k.live) : null;
    const gSusp = suspHas ? buildGraph(k.susp) : null;
    if (gLive) console.log(`  live      : ${JSON.stringify(gLive.stats)}`);
    if (gSusp) console.log(`  suspended : ${JSON.stringify(gSusp.stats)}`);

    // --- does the _suspended variant duplicate the live network? ---
    let dedupe = null;
    if (gLive && gSusp) {
      const liveIdx = makeSegIndex(24);
      for (const [a, nbrs] of gLive.adj) {
        for (const b of nbrs) {
          if (b < a) continue;
          const [ax, az] = toWorld(...gLive.pos[a]);
          const [bx, bz] = toWorld(...gLive.pos[b]);
          liveIdx.add(ax, az, bx, bz);
        }
      }
      let hit = 0;
      let tot = 0;
      for (const p of gSusp.pos) {
        const [x, z] = toWorld(p[0], p[1]);
        tot++;
        if (liveIdx.nearest(x, z, DEDUPE_D)) hit++;
      }
      const frac = tot ? hit / tot : 0;
      dedupe = { suspendedPoints: tot, withinLive: r2(frac), radiusU: DEDUPE_D };
      console.log(
        `  suspended-vs-live overlap: ${(frac * 100).toFixed(1)}% of suspended points sit within ${DEDUPE_D}u of live track`,
      );
      dedupe.dropped = frac >= DEDUPE_FRAC;
      if (dedupe.dropped) console.log(`  -> suspended variant DROPPED as a duplicate`);
      else console.log(`  -> suspended variant KEPT (distinct alignment)`);
    }

    // --- union of the graphs we keep, rebuilt from the source recs so nodes
    // merge across live+suspended too ---
    const keep = [...k.live];
    if (gSusp && !(dedupe && dedupe.dropped)) keep.push(...k.susp);
    const gm = keep.length === k.live.length && gLive ? gLive : buildGraph(keep);

    // Model graph -> snapped, direction-deduped WORLD graph.
    const g = consolidate(gm, net, streets);
    const preD = g.preD;
    const comps = components(g.adj);
    console.log(
      `  consolidated: ${gm.pos.length} model nodes -> ${g.pos.length} world nodes (${g.merged} merged at ${MERGE_W}u, ${((g.snapped / g.points) * 100).toFixed(1)}% snapped to game asphalt within ${SNAP_MAX}u) · components ${comps.length} ${JSON.stringify(comps.slice(0, 6))}`,
    );

    // Label every graph edge with the street it runs on, so strokes can be
    // traced per street. Cached: bus has ~40k edges and the lookup dominates.
    const ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
    const labelCache = new Map();
    const labelOf = (a, b) => {
      const key = ek(a, b);
      let l = labelCache.get(key);
      if (l === undefined) {
        const hit = streets.idx.nearest(
          (g.pos[a][0] + g.pos[b][0]) / 2,
          (g.pos[a][1] + g.pos[b][1]) / 2,
          NAME_MAX,
        );
        l = hit ? hit.payload : null;
        labelCache.set(key, l);
      }
      return l;
    };
    let unlabelled = 0;
    for (const [a, nbrs] of g.adj)
      for (const b of nbrs) if (a < b && labelOf(a, b) === null) unlabelled++;

    const strokes = traceStrokes(g, labelOf);
    const emitted = [];
    const postD = [];
    let rawPts = 0;
    let simpPts = 0;
    let worstDev = 0;
    let dropped = 0;

    for (const st of strokes) {
      const world = st.ids.map((i) => g.pos[i]);
      for (const pts of clipToWorld(world)) {
        if (plLen(pts) < MIN_CHAIN_U) {
          dropped++;
          continue;
        }
        for (const [x, z] of pts) {
          const hit = net.idx.nearest(x, z, MEASURE_MAX);
          postD.push(hit ? hit.d : MEASURE_MAX);
        }
        rawPts += pts.length;
        const simp = rdpSafe(pts, RDP_EPS);
        simpPts += simp.length;
        const dev = maxDeviation(pts, simp);
        if (dev > worstDev) worstDev = dev;

        emitted.push({
          kind,
          name: st.label ? `${kind}: ${st.label}` : `${kind}: unnamed`,
          street: st.label,
          pts: simp.map(([x, z]) => [r1(x), r1(z)]),
          lengthU: r1(plLen(simp)),
          snapped: true,
          uv: {
            u0: r2(uOf(Math.min(...simp.map((p) => p[0])))),
            u1: r2(uOf(Math.max(...simp.map((p) => p[0])))),
            v0: r2(vOf(Math.min(...simp.map((p) => p[1])))),
            v1: r2(vOf(Math.max(...simp.map((p) => p[1])))),
          },
        });
      }
    }
    const snappedPts = g.snapped;
    console.log(
      `  edges without a named street within ${NAME_MAX}u: ${unlabelled} · sub-${MIN_CHAIN_U}u fragments dropped: ${dropped}`,
    );

    const totalLen = emitted.reduce((s, e) => s + e.lengthU, 0);
    console.log(
      `  strokes: ${emitted.length} · unique corridor ${r1(totalLen)}u (${r1((totalLen * 4.446) / 1000)} km) · pts ${rawPts} -> ${simpPts} at RDP ${RDP_EPS}u · max RDP deviation ${r2(worstDev)}u`,
    );
    console.log(
      `  distance to game asphalt BEFORE snap: p50 ${r2(pct(preD, 0.5))}u  p90 ${r2(pct(preD, 0.9))}u  p99 ${r2(pct(preD, 0.99))}u  max ${r2(Math.max(...preD))}u`,
    );
    console.log(
      `  distance to game asphalt AFTER  snap: p50 ${r2(pct(postD, 0.5))}u  p90 ${r2(pct(postD, 0.9))}u  p99 ${r2(pct(postD, 0.99))}u  max ${r2(Math.max(...postD))}u  (${((snappedPts / g.points) * 100).toFixed(1)}% of nodes snapped, cap ${SNAP_MAX}u)`,
    );
    const covLen = [...g.coveredEdges].reduce((s2, e) => s2 + net.edgeLen[e], 0);
    console.log(
      `  lands on ${g.coveredEdges.size}/${net.edges} game street edges = ${r1(covLen)}u of our asphalt (${r1((covLen * 4.446) / 1000)} km) — draw the rails along THESE edges and alignment is exact by construction`,
    );

    const topStreets = new Map();
    for (const e of emitted)
      if (e.street) topStreets.set(e.street, (topStreets.get(e.street) ?? 0) + e.lengthU);
    const ts = [...topStreets].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`  top streets: ${ts.map(([n, l]) => `${n} ${r1(l)}u`).join(" · ")}`);

    kindStats[kind] = {
      objects: k.names.length,
      live: k.live.length,
      suspended: k.susp.length,
      dedupe,
      graph: g.stats,
      strokes: emitted.length,
      unlabelledEdges: unlabelled,
      droppedFragments: dropped,
      corridorLengthU: r1(totalLen),
      corridorKm: r1((totalLen * 4.446) / 1000),
      pointsRaw: rawPts,
      pointsSimplified: simpPts,
      rdpEps: RDP_EPS,
      maxRdpDeviationU: r2(worstDev),
      snapCapU: SNAP_MAX,
      snappedFrac: r2(snappedPts / g.points),
      mergeW: MERGE_W,
      nodesModel: gm.pos.length,
      nodesWorld: g.pos.length,
      nodesMergedByDirection: g.merged,
      componentsAfterConsolidation: comps.length,
      biggestComponentsAfterConsolidation: comps.slice(0, 6),
      distToAsphaltBefore: {
        p50: r2(pct(preD, 0.5)),
        p90: r2(pct(preD, 0.9)),
        p99: r2(pct(preD, 0.99)),
        max: r2(Math.max(...preD)),
      },
      distToAsphaltAfter: {
        p50: r2(pct(postD, 0.5)),
        p90: r2(pct(postD, 0.9)),
        p99: r2(pct(postD, 0.99)),
        max: r2(Math.max(...postD)),
      },
      topStreets: ts.map(([n, l]) => [n, r1(l)]),
      gameEdgesCovered: g.coveredEdges.size,
      gameEdgeLengthU: r1(covLen),
    };
    coverage[kind] = [...g.coveredEdges].sort((a, b) => a - b);

    // Corridors, then the underground cut for the two modes the OBJ draws at
    // grade but reality buries.
    const all = buildCorridors(g.edgeVotes, net);
    const filt = UNDERGROUND_MODES.has(kind)
      ? all.filter((c) => !UNDERGROUND_STREETS.has(c.street))
      : all;
    if (filt.length !== all.length) {
      const cut = all.filter((c) => UNDERGROUND_STREETS.has(c.street));
      console.log(
        `  UNDERGROUND cut: ${cut.map((c) => `${c.street} ${c.edges.length}e/${c.lengthU}u`).join(" · ")} -> ${filt.reduce((s, c) => s + c.edges.length, 0)} surface edges remain`,
      );
    }
    corridors[kind] = filt;
    kindStats[kind].surfaceCorridors = filt.length;
    kindStats[kind].surfaceEdges = filt.reduce((s, c) => s + c.edges.length, 0);

    if (kind === "bus") {
      // Restricted to the centreline-derived coverage so "which edges have bus
      // service" has ONE definition. The ribbon-vertex pass reaches a few more
      // edges by snapping off the ribbon's shoulder; those are not corridor.
      const raw = edgeLoad([...k.live, ...k.susp], net);
      for (const e of g.coveredEdges) busLoad.set(e, raw.get(e) ?? 1);
      const loads = [...busLoad.values()];
      console.log(
        `  bus service density over ${busLoad.size} edges: p50 ${pct(loads, 0.5)} · p90 ${pct(loads, 0.9)} · max ${Math.max(...loads)} route objects`,
      );
    }

    // Bus is emitted as a corridor network only; individual relations are not
    // separable and there are far too many to render.
    for (const e of emitted) routes.push(e);
    byKind.get(kind).graph = g; // world-space, snapped, direction-deduped
  }

  // --- named lines, recovered by Dijkstra between OSM street intersections ---
  console.log("\n--- named line recovery (Dijkstra between OSM street intersections) ---");
  const NAMED = [
    ["cable", "Powell-Hyde", ["Powell Street", "Market Street"], ["Hyde Street", "Beach Street"]],
    ["cable", "Powell-Mason", ["Powell Street", "Market Street"], ["Taylor Street", "Bay Street"]],
    [
      "cable",
      "California St",
      ["California Street", "Drumm Street"],
      ["California Street", "Van Ness Avenue"],
    ],
    ["tram", "F-line", ["Market Street", "Castro Street"], ["Jefferson Street", "Jones Street"]],
    [
      "light_rail",
      "Muni Metro (Market subway)",
      ["Market Street", "Steuart Street"],
      ["Market Street", "Church Street"],
    ],
  ];
  const named = [];
  for (const [kind, label, A, B] of NAMED) {
    const k = byKind.get(kind);
    if (!k || !k.graph) {
      console.log(`  ${label}: no ${kind} graph`);
      continue;
    }
    const ia = streetIntersection(streets, A[0], A[1]);
    const ib = streetIntersection(streets, B[0], B[1]);
    if (!ia || !ib) {
      console.log(`  ${label}: could not locate terminal (${A.join(" x ")} / ${B.join(" x ")})`);
      named.push({ kind, name: label, ok: false, why: "terminal intersection not found in OSM" });
      continue;
    }
    // The kept graph is already world-space (consolidate()).
    const na = nearestNode(k.graph, ia.x, ia.z);
    const nb = nearestNode(k.graph, ib.x, ib.z);
    const daU = na.d;
    const dbU = nb.d;
    if (daU > 40 || dbU > 40) {
      console.log(
        `  ${label}: terminals located but track ends ${r1(daU)}u / ${r1(dbU)}u away — NOT this network`,
      );
      named.push({
        kind,
        name: label,
        ok: false,
        why: `nearest track node ${r1(daU)}u / ${r1(dbU)}u from terminal`,
      });
      continue;
    }
    const pathModel = shortestPath(k.graph, na.id, nb.id);
    if (!pathModel) {
      console.log(`  ${label}: terminals matched but no connected path in the track graph`);
      named.push({ kind, name: label, ok: false, why: "terminals not connected in track graph" });
      continue;
    }
    const snappedPath = pathModel;
    const simp = rdpSafe(snappedPath, RDP_EPS);
    const dev = maxDeviation(snappedPath, simp);
    const lenU = plLen(simp);
    // Which streets does it use, in order?
    const seq = [];
    for (const [x, z] of simp) {
      const hit = streets.idx.nearest(x, z, NAME_MAX);
      const n = hit ? hit.payload : "?";
      if (seq[seq.length - 1] !== n) seq.push(n);
    }
    const cond = seq.filter((n, i) => n !== "?" || i === 0);
    console.log(
      `  ${label}: ${r1(lenU)}u (${r1((lenU * 4.446) / 1000)} km), ${simp.length} pts, dev ${r2(dev)}u · via ${cond.slice(0, 14).join(" > ")}`,
    );
    named.push({
      kind,
      name: label,
      ok: true,
      pts: simp.map(([x, z]) => [r1(x), r1(z)]),
      lengthU: r1(lenU),
      lengthKm: r1((lenU * 4.446) / 1000),
      maxRdpDeviationU: r2(dev),
      terminalErrU: [r1(daU), r1(dbU)],
      viaStreets: cond,
      snapped: true,
      uv: {
        u0: r2(uOf(Math.min(...simp.map((p) => p[0])))),
        u1: r2(uOf(Math.max(...simp.map((p) => p[0])))),
        v0: r2(vOf(Math.min(...simp.map((p) => p[1])))),
        v1: r2(vOf(Math.max(...simp.map((p) => p[1])))),
      },
    });
  }

  // --- how much of the playfield the OBJ's transit data actually covers ---
  // The model is "Downtown San Francisco": its route relations stop well short
  // of the game's full 3172x2600 map, so a renderer must not assume city-wide
  // coverage. Reported as the u/v box that holds 98% of all route points.
  const allU = [];
  const allV = [];
  for (const r of routes)
    for (const [x, z] of r.pts) {
      allU.push(uOf(x));
      allV.push(vOf(z));
    }
  const extent = {
    u01: [r2(pct(allU, 0.01)), r2(pct(allU, 0.99))],
    v01: [r2(pct(allV, 0.01)), r2(pct(allV, 0.99))],
    uFull: [r2(Math.min(...allU)), r2(Math.max(...allU))],
    vFull: [r2(Math.min(...allV)), r2(Math.max(...allV))],
  };
  console.log(
    `\ntransit data extent: u ${extent.u01[0]}-${extent.u01[1]} (full ${extent.uFull[0]}-${extent.uFull[1]}), v ${extent.v01[0]}-${extent.v01[1]} (full ${extent.vFull[0]}-${extent.vFull[1]}) — the OBJ is DOWNTOWN-only, the rest of the map has no transit at all`,
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    source: objPath,
    calibration: { ...CAL, note: "shared with extract-footprints.mjs; do not re-fit" },
    world: { W: WORLD_W, H: WORLD_H, metresPerUnit: 4.446 },
    params: {
      RDP_EPS,
      SNAP_MAX,
      NAME_MAX,
      DEDUPE_D,
      DEDUPE_FRAC,
      MIN_CHAIN_U,
      MERGE_R,
      MERGE_W,
      XSEC_MAX,
    },
    extent,
    routes,
    namedLines: named,
    network: { genId: net.genId, edges: net.edges },
    gameEdgeCoverage: coverage,
    gameEdgeCorridors: corridors,
    busEdgeLoad: [...busLoad].toSorted((a, b) => a[0] - b[0]),
    stats: {
      objects: groups.size,
      emptyObjects: emptyGroups,
      quads: totalQuads,
      nonQuadFacesSkipped: totalTris,
      byKind: kindStats,
    },
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload));
  console.log(
    `\nwrote ${outPath} — ${routes.length} corridor polylines, ${named.filter((n) => n.ok).length}/${named.length} named lines recovered`,
  );

  emitTransitModule(net, corridors, named, busLoad, extent);
}

// ---------------------------------------------------------------------------
// EMIT src/world/sf-transit.ts — the shipped subset
// ---------------------------------------------------------------------------
// Deliberately NOT the JSON: no extracted polylines for the corridors (we draw
// the game's own rails along the edges the coverage names, so the extracted
// geometry is calibration input, not render input), no bus geometry, no stats.
// What ships is per-mode edge coverage grouped into named corridors, the four
// recovered named lines as drivable polylines, and a bus service-density table.
const lineBlock = (n) =>
  `  {\n` +
  `    name: ${JSON.stringify(n.name)},\n` +
  `    mode: ${JSON.stringify(n.kind)},\n` +
  `    lengthU: ${n.lengthU},\n` +
  `    p: ${JSON.stringify(n.pts.flat())},\n` +
  `  },`;

function emitTransitModule(net, corridors, named, busLoad, extent) {
  const modes = EMITTED_MODES.filter((m) => (corridors[m] ?? []).length > 0);
  // Muni Metro is excluded even if a future run recovers it: its only end-to-end
  // path is the Market subway, and a drivable route in a tunnel we do not model
  // is worse than no route.
  const lines = named.filter((n) => n.ok && n.kind !== "light_rail");

  const modeBlock = (m) =>
    `  ${m}: [\n` +
    corridors[m]
      .map(
        (c) =>
          `    { street: ${JSON.stringify(c.street)}, lengthU: ${c.lengthU}, edges: ${JSON.stringify(c.edges)} },`,
      )
      .join("\n") +
    `\n  ],`;

  const busRows = [...busLoad]
    .toSorted((a, b) => a[0] - b[0])
    .map(([e, n]) => `[${e}, ${n}],`)
    .join(" ");

  const totals = modes
    .map((m) => `${m} ${corridors[m].reduce((s, c) => s + c.edges.length, 0)}`)
    .join(", ");

  const src = `// AUTO-GENERATED by tools/sf-data/extract-transit-obj.mjs — do not edit by hand.
// Real SF rail and trolley-wire transit, recovered from a licensed downtown
// model and resolved onto OUR OWN street network. Every corridor here is a list
// of INDICES INTO SF_EDGES (src/world/sf-network.ts), never traced geometry:
// draw the game's own rails along those edges and the alignment is exact by
// construction — track cannot land beside the asphalt because it IS the
// asphalt's edge. Edges covered: ${totals}.
//
// DOWNTOWN ONLY. TRANSIT_EXTENT is the u/v box the source model covers; the
// Sunset, the Richmond and the whole south of the map carry no transit at all.
// A renderer must not treat an empty corridor list as "no transit here".
//
// light_rail and railway are SURFACE-FILTERED at extract time: the model draws
// the Market Street subway and the Stockton Tunnel at grade. Surface Market is
// still carried — by the F-line, which comes through as \`tram\`.

/**
 * The street-network bake these edge indices belong to (NETWORK_GEN_ID of the
 * sf-network.ts this file was extracted against). \`pnpm test\` asserts equality:
 * a \`pnpm bake:map\` renumbers SF_EDGES, so drift has to fail the suite rather
 * than quietly paint track through buildings. Re-run the extractor to fix it.
 */
export const TRANSIT_GEN_ID = ${JSON.stringify(net.genId)};

/** SF_EDGES length at extraction time — every index below is < this. */
export const TRANSIT_EDGE_COUNT = ${net.edges};

/** Every mode with track in this file. Iterate this, never a literal list. */
export const TRANSIT_MODES = [${modes.map((m) => JSON.stringify(m)).join(", ")}] as const;

export type TransitMode = (typeof TRANSIT_MODES)[number];

/** One named street's worth of one mode's track, as game street edges. */
export type TransitCorridor = {
  /** OSM street name, "" when no named way ran within 10u of the track. */
  readonly street: string;
  /** Length of OUR asphalt carrying it, world units. */
  readonly lengthU: number;
  /** Ascending indices into SF_EDGES. */
  readonly edges: readonly number[];
};

/**
 * Per mode, the corridors that carry it, longest first. The corridors PARTITION
 * the mode's coverage — every edge appears in exactly one of them — so "paint
 * everything" is a flat concat and "paint the top-5 corridors" is a slice.
 * Take the slice for trolleybus: all of it is 11% of the network and reads as
 * clutter.
 */
export const SF_TRANSIT: Readonly<Record<TransitMode, readonly TransitCorridor[]>> = {
${modes.map(modeBlock).join("\n")}
};

/** Flat edge list for a mode, ascending — the "paint all of it" case. */
export function transitEdges(mode: TransitMode): readonly number[] {
  return SF_TRANSIT[mode].flatMap((c) => c.edges);
}

/** A revenue line end to end: a route a vehicle can actually drive. */
export type TransitLine = {
  readonly name: string;
  readonly mode: TransitMode;
  /** Polyline length, world units (x4.446 for metres). */
  readonly lengthU: number;
  /** Flat [x0,z0, x1,z1, ...], world units, 0.1-quantized, snapped to our own
   *  centrelines. First and last point are the terminals (turntables, for the
   *  three cable lines). */
  readonly p: readonly number[];
};

/**
 * The named lines, recovered end to end by shortest path between real terminal
 * intersections. Lengths are within 0.1 km of the real system. The Muni Metro
 * is absent on purpose: its only end-to-end path is the Market subway.
 */
export const SF_TRANSIT_LINES: readonly TransitLine[] = [
${lines.map(lineBlock).join("\n")}
];

/**
 * Relative bus service density: [SF_EDGES index, number of route objects].
 * Buses leave no physical trace on a roadway, so this is NOT geometry — use it
 * to weight traffic spawning, shelter placement and dressing density. A route
 * object is one direction/variant of one relation, so the number is a density,
 * not a route count.
 */
export const SF_BUS_LOAD: readonly (readonly [edge: number, routeObjects: number])[] = [
  ${busRows}
];

let busIndex: Map<number, number> | null = null;

/** Bus service density on a street edge; 0 where no route runs. */
export function busLoadAt(edge: number): number {
  if (busIndex === null) busIndex = new Map(SF_BUS_LOAD);
  return busIndex.get(edge) ?? 0;
}

/**
 * Map fractions (u = x/WORLD_W + 0.5, v = z/WORLD_H + 0.5) the source model
 * actually covers. Outside this box "no corridor" means "not surveyed", not
 * "no transit".
 */
export const TRANSIT_EXTENT = {
  u0: ${extent.uFull[0]},
  u1: ${extent.uFull[1]},
  v0: ${extent.vFull[0]},
  v1: ${extent.vFull[1]},
} as const;
`;
  const out = new URL("../../src/world/sf-transit.ts", import.meta.url);
  writeFileSync(out, src);
  oxfmt(out.pathname);
  console.log(
    `wrote src/world/sf-transit.ts — ${modes.length} modes / ${modes.reduce((s, m) => s + corridors[m].length, 0)} corridors, ${lines.length} named lines, ${busLoad.size} bus-weighted edges, ${(src.length / 1024).toFixed(1)} KB, stamp ${net.genId}`,
  );
}
