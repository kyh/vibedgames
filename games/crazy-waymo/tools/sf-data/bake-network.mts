import { readFileSync, writeFileSync } from "node:fs";

import { GRID_X, GRID_Z, projU, projV, rdp, ROAD_TILE, WORLD_H, WORLD_W } from "./lib.mts";
import { parkCell } from "../../src/world/park-clear.ts";
import { landuseGreenAt } from "../../src/world/sf-landuse.ts";
import { districtAt, landFactor, makeTerrain } from "../../src/world/sf-map.ts";

const onLandUV = (u: number, v: number) => landFactor(u, v) > 0.5;

const GEN_ID = new Date().toISOString();

const CLASS_HALF = {
  primary: 7,
  primary_link: 4.6,
  residential: 3.2,
  secondary: 5.4,
  secondary_link: 4.6,
  tertiary: 4.6,
  tertiary_link: 4.6,
  unclassified: 3.2,
};

const MINOR_MIN_LEN = 45;
const MERGE_MIN_HALF = 4.6;
const MINOR_MAX_HALF = 3.2;

const plLen = (pts: string | any[]) => {
  let L = 0;

  for (let i = 1; i < pts.length; i += 1) {
    L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }

  return L;
};

const edgeLen = (
  e: { a: any; b: any; half: any; pts: number[][] } | { a: any; b: any; half: number; pts: any[] },
) => plLen(e.pts);

const samplesOf = (e: { pts: string | any[] }, step: number) => {
  const out = [];
  let acc = 0;

  for (let i = 1; i < e.pts.length; i += 1) {
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

  if (out.length === 0) {
    out.push(e.pts[0]);
  }

  return out;
};

const samplesWithS = (e: { pts: string | any[] }, step: number) => {
  const out = [];
  let acc = 0;
  let base = 0;

  for (let i = 1; i < e.pts.length; i += 1) {
    const [ax, az] = e.pts[i - 1];
    const [bx, bz] = e.pts[i];
    const segLen = Math.hypot(bx - ax, bz - az);

    if (segLen < 1e-6) {
      continue;
    }

    let t = acc === 0 ? 0 : step - acc;

    while (t <= segLen) {
      out.push([ax + ((bx - ax) * t) / segLen, az + ((bz - az) * t) / segLen, base + t]);
      t += step;
    }

    acc = (acc + segLen) % step;
    base += segLen;
  }

  return out;
};

const nearestOnEdge = (x: number, z: number, e: { pts: string | any[] }) => {
  let best = Infinity;
  let tx = 1;
  let tz = 0;

  for (let i = 1; i < e.pts.length; i += 1) {
    const [ax, az] = e.pts[i - 1];
    const [bx, bz] = e.pts[i];
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-8 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / l2, 0), 1) : 0;
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = Math.hypot(px - x, pz - z);

    if (d < best) {
      best = d;
      const dl = Math.sqrt(l2) || 1;
      tx = dx / dl;
      tz = dz / dl;
    }
  }

  return { d: best, tx, tz };
};

const armsByNode = (es: any[]) => {
  const byNode = new Map();

  for (const [i, e] of es.entries()) {
    for (const n of [e.a, e.b]) {
      if (!byNode.has(n)) {
        byNode.set(n, []);
      }

      byNode.get(n).push(i);
    }
  }

  return byNode;
};

const excessArmKills = (
  es: (
    | { a: any; b: any; half: any; pts: number[][] }
    | { a: any; b: any; half: number; pts: any[] }
  )[],
) => {
  const kill = new Set();

  for (const [, list] of armsByNode(es)) {
    if (list.length <= 4) {
      continue;
    }

    const candidates = list
      .filter((i: unknown) => !kill.has(i) && es[i].half <= MINOR_MAX_HALF)
      .toSorted(
        (x: string | number, y: string | number) =>
          es[x].half - es[y].half || edgeLen(es[x]) - edgeLen(es[y]),
      );

    let excess = list.filter((i: unknown) => !kill.has(i)).length - 4;

    for (const i of candidates) {
      if (excess <= 0) {
        break;
      }

      kill.add(i);
      excess -= 1;
    }
  }

  return kill;
};

const COS_SLIVER = Math.cos((25 * Math.PI) / 180);

const armTangents = (es: { [x: string]: { a: any } }, n: any, live: any[]) =>
  live.map((i: string | number) => {
    const { pts } = es[i];
    const m = pts.length;

    const [tx, tz] =
      es[i].a === n
        ? [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]]
        : [pts[m - 2][0] - pts[m - 1][0], pts[m - 2][1] - pts[m - 1][1]];

    const l = Math.hypot(tx, tz) || 1;

    return { i, tx: tx / l, tz: tz / l };
  });

const sliverArmKills = (
  es: (
    | { a: any; b: any; half: any; pts: number[][] }
    | { a: any; b: any; half: number; pts: any[] }
  )[],
) => {
  const kill = new Set();

  for (const [n, list] of armsByNode(es)) {
    const live = list.filter((i: unknown) => !kill.has(i));

    if (live.length < 2) {
      continue;
    }

    const arms = armTangents(es, n, live);

    for (let x = 0; x < arms.length; x += 1) {
      for (let y = x + 1; y < arms.length; y += 1) {
        const A = arms[x];
        const B = arms[y];

        if (kill.has(A.i) || kill.has(B.i)) {
          continue;
        }

        if (A.tx * B.tx + A.tz * B.tz <= COS_SLIVER) {
          continue;
        }

        const cand = [A.i, B.i].filter((i) => es[i].half <= MINOR_MAX_HALF && edgeLen(es[i]) < 60);

        if (cand.length === 0) {
          continue;
        }

        cand.sort((p, q) => es[p].half - es[q].half || edgeLen(es[p]) - edgeLen(es[q]));
        kill.add(cand[0]);
      }
    }
  }

  return kill;
};

const bucketEdges = (es: any[], cell: number) => {
  const buckets = new Map();

  for (const [i, e] of es.entries()) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;

    for (const [x, z] of e.pts) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }

    for (let bx = Math.floor((x0 - 8) / cell); bx <= Math.floor((x1 + 8) / cell); bx += 1) {
      for (let bz = Math.floor((z0 - 8) / cell); bz <= Math.floor((z1 + 8) / cell); bz += 1) {
        const k = `${bx},${bz}`;

        if (!buckets.has(k)) {
          buckets.set(k, []);
        }

        buckets.get(k).push(i);
      }
    }
  }

  return buckets;
};

const route = (ax: number, az: number, bx: number, bz: number, midX: number, midZ: number) => {
  const dx = bx - ax;
  const dz = bz - az;
  const adx = Math.abs(dx);
  const adz = Math.abs(dz);

  if (adx < 1e-6 || adz < 1e-6 || Math.abs(adx - adz) < 1e-6) {
    return [
      [ax, az],
      [bx, bz],
    ];
  }

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

const stepKey = (x1: number, z1: number, x2: number, z2: number) =>
  x1 < x2 || (x1 === x2 && z1 <= z2) ? `${x1},${z1}|${x2},${z2}` : `${x2},${z2}|${x1},${z1}`;

const sampleEvery = (pts: string | any[], step: number) => {
  const out = [];
  let acc = 0;
  out.push(pts[0]);

  for (let i = 1; i < pts.length; i += 1) {
    const [ax, az] = pts[i - 1];
    const [bx, bz] = pts[i];
    const seg = Math.hypot(bx - ax, bz - az);
    let t = step - acc;

    while (t <= seg) {
      out.push([ax + ((bx - ax) * t) / seg, az + ((bz - az) * t) / seg]);
      t += step;
    }

    acc = (acc + seg) % step;
  }

  return out;
};

const raw = JSON.parse(readFileSync(new URL("sf-streets.raw.json", import.meta.url)));

const ways = raw.elements.filter(
  (e: { type: string; geometry: any; tags: { highway: string | number } }) =>
    e.type === "way" && e.geometry && CLASS_HALF[e.tags?.highway] !== undefined,
);

console.log(`ways kept (arterials): ${ways.length}`);

const polylines = [];

for (const w of ways) {
  const half = CLASS_HALF[w.tags.highway];
  let cur = [];

  for (const g of w.geometry) {
    const u = projU(g.lon);
    const v = projV(g.lat);
    const x = (u - 0.5) * WORLD_W;
    const z = (v - 0.5) * WORLD_H;

    if (onLandUV(u, v)) {
      cur.push([x, z]);
    } else {
      if (cur.length >= 2) {
        polylines.push({ half, pts: cur });
      }

      cur = [];
    }
  }

  if (cur.length >= 2) {
    polylines.push({ half, pts: cur });
  }
}

{
  const before = polylines.length;
  const isMinor = (half: number) => half <= MINOR_MAX_HALF;
  const hillTerrain = makeTerrain();

  const steepAt = (x: number, z: number) => {
    const e = 6;
    const dx = hillTerrain.heightAt(x + e, z) - hillTerrain.heightAt(x - e, z);
    const dz = hillTerrain.heightAt(x, z + e) - hillTerrain.heightAt(x, z - e);

    return Math.hypot(dx, dz) / (2 * e);
  };

  const onHill = (pts: string | any[]) => {
    let meanX = 0;
    let meanZ = 0;

    for (const [x, z] of pts) {
      meanX += x;
      meanZ += z;
    }

    meanX /= pts.length;
    meanZ /= pts.length;

    return steepAt(meanX, meanZ) > 0.09;
  };

  let hillKept = 0;

  const kept = polylines.filter((pl) => {
    if (!isMinor(pl.half) || plLen(pl.pts) >= MINOR_MIN_LEN) {
      return true;
    }

    if (onHill(pl.pts)) {
      hillKept += 1;

      return true;
    }

    return false;
  });

  const SPACING = 25;
  const thinnedOut = [];

  for (const pl of kept) {
    if (!isMinor(pl.half) || onHill(pl.pts)) {
      thinnedOut.push(pl);
      continue;
    }

    const [[x0, z0]] = pl.pts;
    const [x1, z1] = pl.pts.at(-1);
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

    if (Math.abs(dx) / L > 0.8) {
      lattice = meanZ;
    } else if (Math.abs(dz) / L > 0.8) {
      lattice = meanX;
    }

    if (lattice === null) {
      thinnedOut.push(pl);
      continue;
    }

    if (Math.round(lattice / SPACING) % 2 === 0) {
      thinnedOut.push(pl);
    }
  }

  polylines.length = 0;
  polylines.push(...thinnedOut);
  console.log(
    `minor-street compression: ${before} -> ${kept.length} -> ${polylines.length} polylines (parity-thinned; ${hillKept} short hill rungs kept)`,
  );
}

const useCount = new Map();
const K = (p: number[] | undefined) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;

for (const pl of polylines) {
  for (const p of pl.pts) {
    const k = K(p);
    useCount.set(k, (useCount.get(k) ?? 0) + 1);
  }
}

const nodeIds = new Map();
const nodes: any[][] = [];

const nodeAt = (p: any[] | undefined) => {
  const k = K(p);
  let id = nodeIds.get(k);

  if (id === undefined) {
    id = nodes.length;
    nodeIds.set(k, id);
    nodes.push([p[0], p[1]]);
  }

  return id;
};

let edges: any[] = [];

for (const pl of polylines) {
  let start = 0;

  for (let i = 1; i < pl.pts.length; i += 1) {
    const isEnd = i === pl.pts.length - 1;
    const shared = (useCount.get(K(pl.pts[i])) ?? 0) >= 2;

    if (isEnd || shared) {
      const pts = pl.pts.slice(start, i + 1);

      if (pts.length >= 2) {
        edges.push({ a: nodeAt(pts[0]), b: nodeAt(pts.at(-1)), half: pl.half, pts });
      }

      start = i;
    }
  }
}

const degreeMap = () => {
  const deg = new Map();

  for (const e of edges) {
    deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
    deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
  }

  return deg;
};

let merged = true;

while (merged) {
  merged = false;
  const deg = degreeMap();
  const byNode = new Map();

  for (const [i, e] of edges.entries()) {
    for (const n of [e.a, e.b]) {
      if (!byNode.has(n)) {
        byNode.set(n, []);
      }

      byNode.get(n).push(i);
    }
  }

  const dead = new Set();

  for (const [n, idxs] of byNode) {
    if (deg.get(n) !== 2 || idxs.length !== 2) {
      continue;
    }

    const [i1, i2] = idxs;

    if (dead.has(i1) || dead.has(i2) || i1 === i2) {
      continue;
    }

    const e1 = edges[i1];
    const e2 = edges[i2];

    if (e1.a === e1.b || e2.a === e2.b) {
      continue;
    }

    const p1 = e1.b === n ? e1.pts : [...e1.pts].toReversed();
    const a = e1.b === n ? e1.a : e1.b;
    const p2 = e2.a === n ? e2.pts : [...e2.pts].toReversed();
    const b = e2.a === n ? e2.b : e2.a;

    if (a === b) {
      continue;
    }

    edges[i1] = { a, b, half: Math.max(e1.half, e2.half), pts: [...p1, ...p2.slice(1)] };
    dead.add(i2);
    merged = true;
  }

  if (dead.size > 0) {
    edges = edges.filter((_, i) => !dead.has(i));
  }
}

for (const e of edges) {
  e.pts = rdp(e.pts, 2.5);
}

{
  const deg = degreeMap();
  edges = edges.filter((e) => {
    const stub = deg.get(e.a) === 1 || deg.get(e.b) === 1;

    return !(stub && edgeLen(e) < 8);
  });
}

const sameRoadway = (B: { half: any }, bLen: number | undefined, A: { half: any }) => {
  const union = A.half + B.half;
  const inner = samplesWithS(B, 4).filter((p) => p[2] > union && p[2] < bLen - union);

  if (inner.length < 6) {
    return false;
  }

  let covered = 0;

  for (let i = 0; i < inner.length; i += 1) {
    const q = inner[Math.min(i + 1, inner.length - 1)];
    const r = inner[Math.max(i - 1, 0)];
    const dl = Math.hypot(q[0] - r[0], q[1] - r[1]) || 1;
    const hit = nearestOnEdge(inner[i][0], inner[i][1], A);

    if (hit.d >= union) {
      continue;
    }

    if (Math.abs((hit.tx * (q[0] - r[0]) + hit.tz * (q[1] - r[1])) / dl) < 0.8) {
      continue;
    }

    covered += 1;
  }

  return covered >= inner.length * 0.9;
};

const mergeParallelPass = () => {
  const MERGE_DIST = 11;
  const lens = edges.map(edgeLen);
  const CELL = 60;
  const buckets = bucketEdges(edges, CELL);
  const removed = new Set();
  const order = edges.map((_, i) => i).toSorted((a, b) => lens[a] - lens[b]);

  for (const bi of order) {
    const B = edges[bi];

    if (lens[bi] < 20) {
      continue;
    }

    const samples = samplesOf(B, 8);

    const sampleTans = samples.map((p, i) => {
      const q = samples[Math.min(i + 1, samples.length - 1)];
      const r = samples[Math.max(i - 1, 0)];
      const dx = q[0] - r[0];
      const dz = q[1] - r[1];
      const dl = Math.hypot(dx, dz) || 1;

      return [dx / dl, dz / dl];
    });

    const cand = new Set();

    for (const [x, z] of samples) {
      for (const id of buckets.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []) {
        if (id !== bi && !removed.has(id) && lens[id] >= lens[bi]) {
          cand.add(id);
        }
      }
    }

    for (const ai of cand) {
      const A = edges[ai];
      let twin = A.half >= MERGE_MIN_HALF && B.half >= MERGE_MIN_HALF;

      if (twin) {
        let covered = 0;

        for (let si = 0; si < samples.length; si += 1) {
          const [x, z] = samples[si];
          const hit = nearestOnEdge(x, z, A);

          if (hit.d >= MERGE_DIST) {
            continue;
          }

          const [btx, btz] = sampleTans[si];

          if (Math.abs(hit.tx * btx + hit.tz * btz) < 0.8) {
            continue;
          }

          covered += 1;
        }

        twin = covered >= samples.length * 0.9;
      }

      if (!twin && !sameRoadway(B, lens[bi], A)) {
        continue;
      }

      removed.add(bi);
      edges[ai] = { ...A, half: Math.max(A.half, B.half) };
      break;
    }
  }

  edges = edges.filter((_, i) => !removed.has(i));
  console.log(`parallel-merge removed ${removed.size} carriageway twins`);
  const deg = degreeMap();
  edges = edges.filter((e) => {
    const stub = deg.get(e.a) === 1 || deg.get(e.b) === 1;
    let L = 0;

    for (let i = 1; i < e.pts.length; i += 1) {
      L += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]);
    }

    return !(stub && L < 14);
  });
};

const clusterJunctionsPass = () => {
  const CONTRACT_LEN = 9;
  let changed = true;
  let contracted = 0;

  while (changed) {
    changed = false;

    for (let i = 0; i < edges.length; i += 1) {
      const e = edges[i];

      if (!e || e.a === e.b || edgeLen(e) >= CONTRACT_LEN) {
        continue;
      }

      const keep = e.a;
      const drop = e.b;
      nodes[keep] = [(nodes[keep][0] + nodes[drop][0]) / 2, (nodes[keep][1] + nodes[drop][1]) / 2];

      for (const f of edges) {
        if (!f) {
          continue;
        }

        if (f.a === drop) {
          f.a = keep;
        }

        if (f.b === drop) {
          f.b = keep;
        }
      }

      edges[i] = null;
      contracted += 1;
      changed = true;
    }

    edges = edges.filter(Boolean);
    const seen = new Set();
    edges = edges.filter((f) => {
      if (f.a === f.b && edgeLen(f) < 40) {
        return false;
      }

      const k = `${Math.min(f.a, f.b)}_${Math.max(f.a, f.b)}`;

      if (f.a !== f.b && seen.has(k)) {
        return false;
      }

      seen.add(k);

      return true;
    });
  }

  for (const e of edges) {
    e.pts[0] = [nodes[e.a][0], nodes[e.a][1]];
    e.pts[e.pts.length - 1] = [nodes[e.b][0], nodes[e.b][1]];
    e.pts = rdp(e.pts, 2.5);
  }

  console.log(`junction clustering contracted ${contracted} sliver edges`);
};

mergeParallelPass();

clusterJunctionsPass();

mergeParallelPass();

clusterJunctionsPass();

{
  const adj = new Map();

  for (const e of edges) {
    for (const [from, to] of [
      [e.a, e.b],
      [e.b, e.a],
    ]) {
      if (!adj.has(from)) {
        adj.set(from, []);
      }

      adj.get(from).push(to);
    }
  }

  const comp = new Map();
  let nComp = 0;

  for (const n of adj.keys()) {
    if (comp.has(n)) {
      continue;
    }

    const stack = [n];
    comp.set(n, nComp);

    while (stack.length) {
      const c = stack.pop();

      for (const m of adj.get(c) ?? []) {
        if (!comp.has(m)) {
          comp.set(m, nComp);
          stack.push(m);
        }
      }
    }

    nComp += 1;
  }

  const sizes = Array.from({ length: nComp }, () => 0);

  for (const c of comp.values()) {
    sizes[c] += 1;
  }

  const main = sizes.indexOf(Math.max(...sizes));
  edges = edges.filter((e) => comp.get(e.a) === main);
  console.log(`components: ${nComp}, kept main with ${sizes[main]} nodes`);
}

{
  let dropped = 0;
  let changed = true;

  while (changed) {
    changed = false;
    const kill = excessArmKills(edges);

    if (kill.size > 0) {
      edges = edges.filter((_, i) => !kill.has(i));
      dropped += kill.size;
      changed = true;
    }
  }

  console.log(`junction sanity: dropped ${dropped} excess minor arms`);

  {
    let slivers = 0;
    let again = true;

    while (again) {
      again = false;
      const kill = sliverArmKills(edges);
      slivers += kill.size;

      if (kill.size > 0) {
        edges = edges.filter((_, i) => !kill.has(i));
        again = true;
      }
    }

    console.log(`sliver arms: dropped ${slivers} near-parallel minor arms`);
  }

  const adj = new Map();

  for (const e of edges) {
    if (!adj.has(e.a)) {
      adj.set(e.a, []);
    }

    if (!adj.has(e.b)) {
      adj.set(e.b, []);
    }

    adj.get(e.a).push(e.b);
    adj.get(e.b).push(e.a);
  }

  const comp = new Map();
  let nComp = 0;

  for (const n of adj.keys()) {
    if (comp.has(n)) {
      continue;
    }

    const stack = [n];
    comp.set(n, nComp);

    while (stack.length) {
      const c = stack.pop();

      for (const m of adj.get(c) ?? []) {
        if (!comp.has(m)) {
          comp.set(m, nComp);
          stack.push(m);
        }
      }
    }

    nComp += 1;
  }

  const sizes = Array.from({ length: nComp }, () => 0);

  for (const c of comp.values()) {
    sizes[c] += 1;
  }

  const main = sizes.indexOf(Math.max(...sizes));
  edges = edges.filter((e) => comp.get(e.a) === main);
}

{
  const remap = new Map();
  const outNodes: any[] = [];

  const idFor = (n: string | number) => {
    let id = remap.get(n);

    if (id === undefined) {
      id = outNodes.length;
      remap.set(n, id);
      outNodes.push(nodes[n]);
    }

    return id;
  };

  for (const e of edges) {
    e.a = idFor(e.a);
    e.b = idFor(e.b);
  }

  nodes.length = 0;
  nodes.push(...outNodes);
}

{
  const LATTICE = ROAD_TILE / 2;
  const snapC = (v: number) => Math.round(v / LATTICE) * LATTICE;
  const byPos = new Map();
  const redirect = Array.from({ length: nodes.length });

  for (let i = 0; i < nodes.length; i += 1) {
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

  let snapped = 0;

  for (const e of edges) {
    if (redirect[e.a] !== e.a || redirect[e.b] !== e.b) {
      snapped += 1;
    }

    e.a = redirect[e.a];
    e.b = redirect[e.b];
  }

  edges = edges.filter((e) => {
    if (e.a === e.b) {
      return false;
    }

    const a = nodes[e.a];
    const b = nodes[e.b];

    if (a[0] === b[0] && a[1] === b[1]) {
      return false;
    }

    const mid = e.pts[Math.floor(e.pts.length / 2)] ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    e.pts = route(a[0], a[1], b[0], b[1], mid[0], mid[1]);

    return true;
  });
  console.log(
    `octilinear: merged ${snapped} edge endpoints onto lattice nodes, ${edges.length} edges routed`,
  );
  {
    const edgeSteps = (
      e:
        | { a: any; b: any; half: any; pts: number[][] }
        | { a: any; b: any; half: number; pts: any[] },
    ) => {
      const steps = [];

      for (let i = 1; i < e.pts.length; i += 1) {
        const [x1, z1] = e.pts[i - 1];
        const [x2, z2] = e.pts[i];
        const n = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1)) / LATTICE;
        const k = Math.max(1, Math.round(n));

        for (let j = 0; j < k; j += 1) {
          const ax = x1 + ((x2 - x1) * j) / k;
          const az = z1 + ((z2 - z1) * j) / k;
          const bx = x1 + ((x2 - x1) * (j + 1)) / k;
          const bz = z1 + ((z2 - z1) * (j + 1)) / k;
          steps.push(stepKey(Math.round(ax), Math.round(az), Math.round(bx), Math.round(bz)));
        }
      }

      return steps;
    };

    const own = new Map();

    for (const e of edges) {
      for (const st of edgeSteps(e)) {
        const cur = own.get(st);

        if (cur === undefined || e.half > cur) {
          own.set(st, e.half);
        }
      }
    }

    const counts = new Map();

    for (const e of edges) {
      for (const st of edgeSteps(e)) {
        counts.set(st, (counts.get(st) ?? 0) + 1);
      }
    }

    let dropped = 0;
    edges = edges.filter((e) => {
      const steps = edgeSteps(e);
      let covered = 0;

      for (const st of steps) {
        const width = own.get(st) ?? 0;
        const n = counts.get(st) ?? 1;

        if (n > 1 && (width > e.half || (width === e.half && n > 1))) {
          covered += 1;
        }
      }

      if (steps.length > 0 && covered / steps.length >= 0.7) {
        dropped += 1;

        return false;
      }

      return true;
    });
    let shared = 0;

    for (const [, n] of counts) {
      if (n > 1) {
        shared += 1;
      }
    }

    console.log(
      `overlap pass: dropped ${dropped} redundant edges (${shared} shared lattice steps before)`,
    );
  }

  const adj = new Map();

  for (const e of edges) {
    if (!adj.has(e.a)) {
      adj.set(e.a, []);
    }

    if (!adj.has(e.b)) {
      adj.set(e.b, []);
    }

    adj.get(e.a).push(e.b);
    adj.get(e.b).push(e.a);
  }

  const comp = new Map();
  let nComp = 0;

  for (const n of adj.keys()) {
    if (comp.has(n)) {
      continue;
    }

    const stack = [n];
    comp.set(n, nComp);

    while (stack.length) {
      const c = stack.pop();

      for (const m of adj.get(c) ?? []) {
        if (!comp.has(m)) {
          comp.set(m, nComp);
          stack.push(m);
        }
      }
    }

    nComp += 1;
  }

  const sizes = Array.from({ length: nComp }, () => 0);

  for (const c of comp.values()) {
    sizes[c] += 1;
  }

  const main = sizes.indexOf(Math.max(...sizes));
  edges = edges.filter((e) => comp.get(e.a) === main);
  const remap = new Map();
  const outNodes: any[] = [];

  const idFor = (n: string | number) => {
    let id = remap.get(n);

    if (id === undefined) {
      id = outNodes.length;
      remap.set(n, id);
      outNodes.push(nodes[n]);
    }

    return id;
  };

  for (const e of edges) {
    e.a = idFor(e.a);
    e.b = idFor(e.b);
  }

  nodes.length = 0;
  nodes.push(...outNodes);
}

const toG = (x: number, z: number) => [
  Math.floor((x / WORLD_W + 0.5) * GRID_X),
  Math.floor((z / WORLD_H + 0.5) * GRID_Z),
];

const rasterizeEdges = (
  road: Uint8Array<ArrayBuffer>,
  major: Uint8Array<ArrayBuffer> | null,
  edgeList: any[],
) => {
  const mark = (cx: number, cz: number, isMajor: any) => {
    if (cx < 0 || cz < 0 || cx >= GRID_X || cz >= GRID_Z) {
      return;
    }

    road[cx * GRID_Z + cz] = 1;

    if (major && isMajor) {
      major[cx * GRID_Z + cz] = 1;
    }
  };

  const seg = (
    gx0: number | undefined,
    gz0: number | undefined,
    gx1: number | undefined,
    gz1: number | undefined,
    isMajor: boolean,
  ) => {
    let x = gx0;
    let z = gz0;
    const dx = Math.abs(gx1 - gx0);
    const dz = Math.abs(gz1 - gz0);
    const sx = gx0 < gx1 ? 1 : -1;
    const sz = gz0 < gz1 ? 1 : -1;
    let err = dx - dz;
    let steps = 0;
    const maxSteps = dx + dz + 4;

    while (steps < maxSteps) {
      steps += 1;
      mark(x, z, isMajor);

      if (x === gx1 && z === gz1) {
        break;
      }

      const e2 = 2 * err;

      if (e2 > -dz) {
        err -= dz;
        x += sx;
        mark(x, z, isMajor);
      }

      if (e2 < dx) {
        err += dx;
        z += sz;
        mark(x, z, isMajor);
      }
    }
  };

  for (const e of edgeList) {
    const isMajor = e.half >= 5;

    for (let i = 1; i < e.pts.length; i += 1) {
      const [ax, az] = e.pts[i - 1];
      const [bx, bz] = e.pts[i];
      const [g0x, g0z] = toG(ax, az);
      const [g1x, g1z] = toG(bx, bz);
      seg(g0x, g0z, g1x, g1z, isMajor);
    }
  }
};

const thin = (road: Uint8Array<ArrayBuffer> | number[], sizeX: number, sizeZ: number) => {
  const at = (x: number, z: number) =>
    x >= 0 && z >= 0 && x < sizeX && z < sizeZ && road[x * sizeZ + z] === 1;

  const RING = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];

  const inSquare = (x: number, z: number) => {
    for (const dx of [-1, 1]) {
      for (const dz of [-1, 1]) {
        if (at(x + dx, z) && at(x, z + dz) && at(x + dx, z + dz)) {
          return true;
        }
      }
    }

    return false;
  };

  const removable = (x: number, z: number) => {
    let n4 = 0;
    const ring = [];

    for (let i = 0; i < 8; i += 1) {
      const r = at(x + RING[i][0], z + RING[i][1]);
      ring.push(r);

      if (r && i % 2 === 0) {
        n4 += 1;
      }
    }

    if (n4 < 2 || !inSquare(x, z)) {
      return false;
    }

    let all = true;
    let arcs = 0;

    for (let i = 0; i < 8; i += 1) {
      if (!ring[i]) {
        all = false;
        continue;
      }

      if (ring[(i + 7) % 8]) {
        continue;
      }

      for (let j = i; ring[j % 8] && j < i + 8; j += 1) {
        if (j % 2 === 0) {
          arcs += 1;
          break;
        }
      }
    }

    return all || arcs === 1;
  };

  for (let sweep = 0; sweep < 12; sweep += 1) {
    let changed = false;

    for (const peel of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]) {
      for (let x = 0; x < sizeX; x += 1) {
        for (let z = 0; z < sizeZ; z += 1) {
          if (road[x * sizeZ + z] !== 1) {
            continue;
          }

          if (at(x + peel[0], z + peel[1])) {
            continue;
          }

          if (!removable(x, z)) {
            continue;
          }

          road[x * sizeZ + z] = 0;
          changed = true;
        }
      }
    }

    if (!changed) {
      break;
    }
  }
};

const gridFull = new Uint8Array(GRID_X * GRID_Z);

rasterizeEdges(gridFull, null, edges);

thin(gridFull, GRID_X, GRID_Z);

const PARK_KEEP_HALF = 5.5;
const CROSSOVER_X0 = -430;
const CROSSOVER_X1 = -320;
const CROSSOVER_KEEP_HALF = 4.8;
const MIN_FRAGMENT_LEN = 14;

const greenAtWorld = (x: number, z: number) =>
  parkCell(Math.floor((x + WORLD_W / 2) / ROAD_TILE), Math.floor((z + WORLD_H / 2) / ROAD_TILE));

const parkFrac = (pts: string | any[]) => {
  let inside = 0;
  let total = 0;

  for (let k = 0; k + 1 < pts.length; k += 1) {
    const [ax, az] = pts[k];
    const [bx, bz] = pts[k + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 6));

    for (let s = 0; s <= steps; s += 1) {
      total += 1;
      const t = s / steps;

      if (greenAtWorld(ax + (bx - ax) * t, az + (bz - az) * t)) {
        inside += 1;
      }
    }
  }

  return total > 0 ? inside / total : 0;
};

const inCrossover = (pts: any[]) => pts.every(([x]) => x >= CROSSOVER_X0 && x <= CROSSOVER_X1);
const baseNodeCount = nodes.length;

const cutNode = (x: any, z: any) => {
  nodes.push([x, z]);

  return nodes.length - 1;
};

const clipEdge = (
  e: { a: any; b: any; half: any; pts: number[][] } | { a: any; b: any; half: number; pts: any[] },
) => {
  const pts = [];

  for (let k = 0; k < e.pts.length; k += 1) {
    const [ax, az] = e.pts[k];

    if (k + 1 < e.pts.length) {
      const [bx, bz] = e.pts[k + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 4));

      for (let s = 0; s < steps; s += 1) {
        const t = s / steps;
        pts.push([ax + (bx - ax) * t, az + (bz - az) * t]);
      }
    } else {
      pts.push([ax, az]);
    }
  }

  const green = pts.map(([x, z]) => greenAtWorld(x, z));

  for (let i = 0; i < green.length;) {
    if (!green[i]) {
      i += 1;
      continue;
    }

    let j = i;
    let len = 0;

    while (j < green.length && green[j]) {
      const a = pts[j - 1];
      const b = pts[j];

      if (j > i && a && b) {
        len += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }

      j += 1;
    }

    if (len < 12) {
      for (let k = i; k < j; k += 1) {
        green[k] = false;
      }
    }

    i = j;
  }

  const out: { b: any }[] = [];
  let run: [any] | (any[] | undefined)[] = [];
  let runStartsAtA = false;

  const flush = (endsAtB: boolean) => {
    if (run.length >= 2) {
      let len = 0;

      for (let i = 1; i < run.length; i += 1) {
        len += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
      }

      const [first] = run;
      const last = run.at(-1);

      if (len >= MIN_FRAGMENT_LEN) {
        out.push({
          a: runStartsAtA ? e.a : cutNode(first[0], first[1]),
          b: endsAtB ? e.b : cutNode(last[0], last[1]),
          half: e.half,
          pts: [...run],
        });
      }
    }

    run = [];
  };

  for (let i = 0; i < pts.length; i += 1) {
    if (green[i]) {
      flush(false);
    } else {
      if (run.length === 0) {
        runStartsAtA = i === 0;
      }

      run.push(pts[i]);
    }
  }

  flush(true);

  if (out.length === 1 && out[0].a === e.a && out[0].b === e.b) {
    return [e];
  }

  return out;
};

{
  const before = edges.length;
  const cleared = [];

  for (const e of edges) {
    if (e.half >= PARK_KEEP_HALF || parkFrac(e.pts) <= 0.02) {
      cleared.push(e);
    } else if (e.half >= CROSSOVER_KEEP_HALF && inCrossover(e.pts)) {
      cleared.push(e);
    } else {
      cleared.push(...clipEdge(e));
    }
  }

  edges = cleared;
  console.log(
    `park-clear: ${before} -> ${edges.length} edges, +${nodes.length - baseNodeCount} cut nodes`,
  );
}

{
  const adj = new Map();

  for (const e of edges) {
    for (const [from, to] of [
      [e.a, e.b],
      [e.b, e.a],
    ]) {
      if (!adj.has(from)) {
        adj.set(from, []);
      }

      adj.get(from).push(to);
    }
  }

  const comp = new Map();
  let nComp = 0;

  for (const n of adj.keys()) {
    if (comp.has(n)) {
      continue;
    }

    const stack = [n];
    comp.set(n, nComp);

    while (stack.length) {
      const c = stack.pop();

      for (const m of adj.get(c) ?? []) {
        if (!comp.has(m)) {
          comp.set(m, nComp);
          stack.push(m);
        }
      }
    }

    nComp += 1;
  }

  const sizes = Array.from({ length: nComp }, () => 0);

  for (const c of comp.values()) {
    sizes[c] += 1;
  }

  const main = sizes.indexOf(Math.max(...sizes));
  const before = edges.length;
  edges = edges.filter((e) => comp.get(e.a) === main);
  console.log(
    `park-stub prune: ${nComp} components, dropped ${before - edges.length} stranded edges`,
  );
}

let totalLen = 0;

for (const e of edges) {
  for (let i = 1; i < e.pts.length; i += 1) {
    totalLen += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]);

    if (!Number.isFinite(e.pts[i][0]) || !Number.isFinite(e.pts[i][1])) {
      throw new TypeError("NaN vertex");
    }
  }
}

console.log(
  `nodes: ${nodes.length}, edges: ${edges.length}, total ${Math.round(totalLen / 1000)}k units`,
);

if (nodes.length < 400 || edges.length < 600) {
  throw new Error("suspiciously small network");
}

const grid = new Uint8Array(GRID_X * GRID_Z);
const gridMajor = new Uint8Array(GRID_X * GRID_Z);

rasterizeEdges(grid, gridMajor, edges);

const maskComponents = (g: Uint8Array<ArrayBuffer>) => {
  const at = (x: number, z: number) =>
    x >= 0 && z >= 0 && x < GRID_X && z < GRID_Z && g[x * GRID_Z + z] === 1;
  const seen = new Set();
  const sizes = [];

  for (let x = 0; x < GRID_X; x += 1) {
    for (let z = 0; z < GRID_Z; z += 1) {
      if (!at(x, z) || seen.has(x * GRID_Z + z)) {
        continue;
      }

      let n = 0;
      const st = [[x, z]];
      seen.add(x * GRID_Z + z);

      while (st.length) {
        const c = st.pop();
        n += 1;

        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = c[0] + dx;
          const nz = c[1] + dz;

          if (at(nx, nz) && !seen.has(nx * GRID_Z + nz)) {
            seen.add(nx * GRID_Z + nz);
            st.push([nx, nz]);
          }
        }
      }

      sizes.push(n);
    }
  }

  sizes.sort((a, b) => b - a);

  return sizes;
};

const pre = maskComponents(grid);

console.log(`pre-thin components: ${pre.length}, top: ${pre.slice(0, 5).join(",")}`);

thin(grid, GRID_X, GRID_Z);

const post = maskComponents(grid);

console.log(`post-thin components: ${post.length}, top: ${post.slice(0, 5).join(",")}`);

let roadCells = 0;

for (const v of grid) {
  roadCells += v;
}

console.log(`mask road cells: ${roadCells}`);

if (roadCells < 3000 || roadCells > 60_000) {
  throw new Error("mask cell count out of range");
}

const parkPath = new Uint8Array(GRID_X * GRID_Z);

for (let gx = 0; gx < GRID_X; gx += 1) {
  for (let gz = 0; gz < GRID_Z; gz += 1) {
    if (gridFull[gx * GRID_Z + gz] !== 1) {
      continue;
    }

    if (landuseGreenAt(gx, gz) || districtAt(gx, gz).character === "park") {
      parkPath[gx * GRID_Z + gz] = 1;
    }
  }
}

let parkPathCells = 0;

for (const v of parkPath) {
  parkPathCells += v;
}

console.log(`park-path cells: ${parkPathCells}`);

const packCols = (bytes: any[] | Uint8Array<ArrayBuffer>) => {
  const out = [];

  for (let gx = 0; gx < GRID_X; gx += 1) {
    let bits = "";

    for (let gz = 0; gz < GRID_Z; gz += 1) {
      bits += bytes[gx * GRID_Z + gz] ? "1" : "0";
    }

    let hex = "";

    for (let i = 0; i < bits.length; i += 4) {
      hex += Number.parseInt(bits.slice(i, i + 4).padEnd(4, "0"), 2).toString(16);
    }

    out.push(hex);
  }

  return out;
};

const cols = packCols(grid);
const colsMajor = packCols(gridMajor);
const colsPath = packCols(parkPath);

writeFileSync(
  new URL("../../src/world/sf-streets.ts", import.meta.url),
  `// AUTO-GENERATED by tools/sf-data/bake-network.mts — do not edit by hand.
// Raster mask DERIVED from the park-cleared vector network (sf-network.ts) —
// supercover-rasterized then pre-thinned; mask + edges agree by construction.
// ${roadCells} road cells at ${GRID_X}x${GRID_Z}.

// Generation stamp shared with sf-network.ts (NETWORK_GEN_ID) — proves both
// files came from one bake run (the test asserts equality).
export const STREETS_GEN_ID = ${JSON.stringify(GEN_ID)};

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

// Park-interior street cells REMOVED from the shipped mask (park clipping) —
// furniture.ts lays KayKit pedestrian paths along these old street lines.
export const PARK_PATH_MASK = {
  cols: ${JSON.stringify(colsPath)},
} as const;

export function parkPathMaskAt(gx: number, gz: number): boolean {
  const col = PARK_PATH_MASK.cols[gx];
  if (col === undefined) return false;
  const nibble = col.charCodeAt(gz >> 2);
  const val = nibble <= 57 ? nibble - 48 : nibble - 87;
  return (val & (8 >> (gz & 3))) !== 0;
}
`,
);

const r1 = (n: number) => Math.round(n * 10) / 10;
const nodesOut = nodes.map(([x, z]) => `[${r1(x)},${r1(z)}]`).join(",");

const edgesOut = edges
  .map(
    (e) =>
      `{a:${e.a},b:${e.b},w:${e.half},p:[${e.pts.map(([x, z]) => `${r1(x)},${r1(z)}`).join(",")}]}`,
  )
  .join(",\n");

writeFileSync(
  new URL("../../src/world/sf-network.ts", import.meta.url),
  `// AUTO-GENERATED by tools/sf-data/bake-network.mts — do not edit by hand.
// The VECTOR road network (real OSM arterials, world coords): source of truth
// for road rendering, traffic routing and building alignment. Park-interior
// streets are already CLIPPED here (car-free parks) — the runtime carries no
// park filter; the shipped raster mask (sf-streets.ts) agrees by construction.
// ${nodes.length} nodes (first ${baseNodeCount} are junctions; the rest are
// fresh degree-1 endpoints minted at park cut points), ${edges.length} edges.

// Generation stamp shared with sf-streets.ts (STREETS_GEN_ID) — equal only when
// both files came from the same bake run (the test asserts equality).
export const NETWORK_GEN_ID = ${JSON.stringify(GEN_ID)};

// Nodes at index >= this are park-clip cut ends (kept degree-1 by construction).
export const SF_BASE_NODES = ${baseNodeCount};

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

{
  const cell = 5;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${GRID_X * cell}" height="${GRID_Z * cell}"><rect width="100%" height="100%" fill="#9ec7d8"/>`;

  for (let gx = 0; gx < GRID_X; gx += 1) {
    for (let gz = 0; gz < GRID_Z; gz += 1) {
      if (onLandUV((gx + 0.5) / GRID_X, (gz + 0.5) / GRID_Z)) {
        out += `<rect x="${gx * cell}" y="${gz * cell}" width="${cell}" height="${cell}" fill="${grid[gx * GRID_Z + gz] ? "#bbb" : "#e8e4d8"}"/>`;
      }
    }
  }

  const sx = (x: number) => (x / WORLD_W + 0.5) * GRID_X * cell;
  const sz = (z: number) => (z / WORLD_H + 0.5) * GRID_Z * cell;

  for (const e of edges) {
    out += `<polyline fill="none" stroke="#c22" stroke-width="1.6" points="${e.pts.map(([x, z]) => `${sx(x).toFixed(1)},${sz(z).toFixed(1)}`).join(" ")}"/>`;
  }

  out += "</svg>";
  writeFileSync(new URL("preview-network.svg", import.meta.url), out);
}

console.log("Wrote src/world/sf-network.ts, src/world/sf-streets.ts, preview-network.svg");

const chainFragments = (parts: any[]) => {
  let joined = true;

  while (joined) {
    joined = false;

    for (let i = 0; i < parts.length && !joined; i += 1) {
      for (let j = 0; j < parts.length; j += 1) {
        if (i === j || parts[i].half !== parts[j].half) {
          continue;
        }

        const ae = parts[i].pts.at(-1);
        const [bs] = parts[j].pts;

        if (Math.hypot(ae[0] - bs[0], ae[1] - bs[1]) < 1.5) {
          parts[i].pts = [...parts[i].pts, ...parts[j].pts.slice(1)];
          parts.splice(j, 1);
          joined = true;
          break;
        }
      }
    }
  }
};

{
  const FWY_HALF = { motorway: 5.2, trunk: 4.4 };

  const fwyWays = raw.elements.filter(
    (e: { type: string; geometry: any; tags: { highway: string | number } }) =>
      e.type === "way" && e.geometry && FWY_HALF[e.tags?.highway] !== undefined,
  );

  const fwys = [];

  for (const w of fwyWays) {
    const half = FWY_HALF[w.tags.highway];
    let cur = [];

    for (const g of w.geometry) {
      const u = projU(g.lon);
      const v = projV(g.lat);
      const x = (u - 0.5) * WORLD_W;
      const z = (v - 0.5) * WORLD_H;

      if (onLandUV(u, v)) {
        cur.push([x, z]);
      } else {
        if (cur.length >= 2) {
          fwys.push({ half, pts: cur });
        }

        cur = [];
      }
    }

    if (cur.length >= 2) {
      fwys.push({ half, pts: cur });
    }
  }

  chainFragments(fwys);

  const kept = fwys.flatMap((fwy) => {
    const f = { half: fwy.half, pts: rdp(fwy.pts, 2) };

    return plLen(f.pts) >= 40 ? [f] : [];
  });

  console.log(
    `freeways: ${kept.length} polylines, ${Math.round(kept.reduce((a, f) => a + plLen(f.pts), 0) / 1000)}k units`,
  );

  const RAMP_HALF = { motorway_link: 3.6, trunk_link: 3.6 };

  const rampWays = raw.elements.filter(
    (e: { type: string; geometry: any; tags: { highway: string | number } }) =>
      e.type === "way" && e.geometry && RAMP_HALF[e.tags?.highway] !== undefined,
  );

  const ramps = [];

  for (const w of rampWays) {
    let cur = [];

    for (const g of w.geometry) {
      const u = projU(g.lon);
      const v = projV(g.lat);
      const x = (u - 0.5) * WORLD_W;
      const z = (v - 0.5) * WORLD_H;

      if (onLandUV(u, v)) {
        cur.push([x, z]);
      } else {
        if (cur.length >= 2) {
          ramps.push({ pts: cur });
        }

        cur = [];
      }
    }

    if (cur.length >= 2) {
      ramps.push({ pts: cur });
    }
  }

  chainFragments(ramps);

  const rampsSimple = ramps
    .flatMap((ramp) => {
      const r = { pts: rdp(ramp.pts, 2) };

      return plLen(r.pts) >= 26 ? [r] : [];
    })
    .toSorted((a, b) => plLen(b.pts) - plLen(a.pts));

  const keptSamples = [];
  const rampsKept = [];

  for (const r of rampsSimple) {
    const mine = sampleEvery(r.pts, 5);
    const body = mine.slice(2, Math.max(3, mine.length - 2));
    let clear = true;

    for (const [x, z] of body) {
      for (const [kx, kz] of keptSamples) {
        if (Math.hypot(kx - x, kz - z) < 9) {
          clear = false;
          break;
        }
      }

      if (!clear) {
        break;
      }
    }

    if (!clear) {
      continue;
    }

    rampsKept.push(r);
    keptSamples.push(...mine);
  }

  console.log(
    `freeway ramps: ${rampsKept.length} polylines (de-braided from ${rampsSimple.length})`,
  );

  const body = kept
    .map(
      (f) =>
        `  { half: ${f.half}, p: [${f.pts.map(([x, z]) => `${Math.round(x * 10) / 10},${Math.round(z * 10) / 10}`).join(",")}] },`,
    )
    .join("\n");

  const rampBody = rampsKept
    .map(
      (r) =>
        `  { half: 3.6, p: [${r.pts.map(([x, z]) => `${Math.round(x * 10) / 10},${Math.round(z * 10) / 10}`).join(",")}] },`,
    )
    .join("\n");

  writeFileSync(
    new URL("../../src/world/sf-freeways.ts", import.meta.url),
    `// AUTO-GENERATED by tools/sf-data/bake-network.mts — do not edit.
// Elevated freeway centerlines (motorway/trunk mainlines, land-clipped).
// Rendered as viaducts by src/world/freeways.ts — NOT part of the drivable
// street network.
export const FREEWAYS_GEN_ID = ${JSON.stringify(GEN_ID)};

export type FreewayLine = { readonly half: number; readonly p: readonly number[] };

export const SF_FREEWAYS: readonly FreewayLine[] = [
${body}
];

// On/off ramps (motorway/trunk links) — runtime anchors street end at grade,
// freeway end at deck height (src/world/freeways.ts).
export const SF_FREEWAY_RAMPS: readonly FreewayLine[] = [
${rampBody}
];
`,
  );
  console.log("Wrote src/world/sf-freeways.ts");
}
