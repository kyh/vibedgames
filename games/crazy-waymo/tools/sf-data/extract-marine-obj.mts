import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { at, GRID_X, GRID_Z, landFactor, plLen, rdp, ringArea, WORLD_H, WORLD_W } from "./lib.mts";
import type { Point } from "./lib.mts";
import { readOverpass } from "./osm.mts";

const [objPath, outPath] = process.argv.slice(2);

if (objPath === undefined || objPath === "" || outPath === undefined || outPath === "") {
  console.error("usage: node extract-marine-obj.mts <obj> <out.json>");
  process.exit(1);
}

type P3 = readonly [number, number, number];

type Tri = readonly [Point, Point, Point];

interface Face {
  ids: number[];
  mtl: string;
}

interface OsmName {
  name: string;
  x: number;
  z: number;
}

interface GamePiers {
  dockCount: number;
  piers: { area: number; ring: Point[] }[];
}

interface GameMatch {
  areaRatio: number;
  dist: number;
  gameArea: number;
  gamePts: number;
  index: number;
  verdict: string;
}

interface PierEntry {
  area: number;
  cls: string;
  cx: number;
  cz: number;
  d: number;
  duplicateIn?: string[];
  gameMatch?: GameMatch | null;
  group: string;
  nearestGameDist?: number | null;
  osm: { dist: number; name: string } | null;
  pts: number;
  rawPts: number;
  ring: number[];
  u: number;
  v: number;
  w: number;
  wet: number;
}

interface GameDeck {
  area: number;
  pts: number;
  x: number;
  z: number;
}

interface Axis {
  ax: number;
  az: number;
  cx: number;
  cz: number;
}

interface Bin {
  maxY: number;
  minY: number;
  n: number;
  pts: P3[];
}

interface ProfileRow {
  maxY: number;
  minY: number;
  n: number;
  ramp: boolean;
  roadW: number | null;
  roadY: number | null;
  s: number;
}

type AlongAxis = (p: P3) => number;

const CAL = { bx: 325.2, bz: -400.5, sx: 0.17829, sz: 0.17909 };
const CAL_SY = 1 / (1.598 * 4.446);

const ANCHORS: readonly (readonly [string, number, number, number, number])[] = [
  ["Salesforce", 2458.4, -2088.9, 760, -770.1],
  ["Transamerica", 1809.9, -2842.1, 644.9, -907.7],
];

const wxOf = (mx: number) => mx * CAL.sx + CAL.bx;
const wzOf = (mz: number) => mz * CAL.sz + CAL.bz;
const uOf = (wx: number) => wx / WORLD_W + 0.5;
const vOf = (wz: number) => wz / WORLD_H + 0.5;
const r1 = (n: number) => Math.round(n * 10) / 10;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

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
  "builds",
  "builds_3",
]);

const CH_SPACE = 32;
const CH_F = 102;
const CH_V = 118;

const vx: number[] = [];
const vy: number[] = [];
const vz: number[] = [];
const waterTris: Tri[] = [];

const worldXZ: (id: number) => Point = (id) => [wxOf(at(vx, id)), wzOf(at(vz, id))];

const faceIds = (l: string) => {
  const ids: number[] = [];

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

      for (let i = 2; i < ids.length; i += 1) {
        waterTris.push([worldXZ(at(ids, 0)), worldXZ(at(ids, i - 1)), worldXZ(at(ids, i))]);
      }
    } else if (l.startsWith("usemtl")) {
      mtl = l.slice(7).trim();
    }
  }
};

const pushTo = <K, V>(map: Map<K, V[]>, k: K, v: V) => {
  const list = map.get(k);

  if (list === undefined) {
    map.set(k, [v]);
  } else {
    list.push(v);
  }
};

const WATER_CELL = 40;
const waterGrid = new Map<string, number[]>();

const buildWaterIndex = () => {
  for (const [ti, t] of waterTris.entries()) {
    const x0 = Math.min(t[0][0], t[1][0], t[2][0]);
    const x1 = Math.max(t[0][0], t[1][0], t[2][0]);
    const z0 = Math.min(t[0][1], t[1][1], t[2][1]);
    const z1 = Math.max(t[0][1], t[1][1], t[2][1]);

    for (let a = Math.floor(x0 / WATER_CELL); a <= Math.floor(x1 / WATER_CELL); a += 1) {
      for (let b = Math.floor(z0 / WATER_CELL); b <= Math.floor(z1 / WATER_CELL); b += 1) {
        pushTo(waterGrid, `${a}:${b}`, ti);
      }
    }
  }
};

const inWater = (x: number, z: number) => {
  const g = waterGrid.get(`${Math.floor(x / WATER_CELL)}:${Math.floor(z / WATER_CELL)}`);

  if (g === undefined) {
    return false;
  }

  for (const ti of g) {
    const [A, B, C] = at(waterTris, ti);
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

const DECK_CELL = 30;
const deckGrid = new Map<string, number[]>();
const deckRings: (readonly Point[])[] = [];

const buildDeckIndex = (rings: readonly (readonly Point[])[]) => {
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
        pushTo(deckGrid, `${a}:${b}`, di);
      }
    }
  }
};

const deckAt = (x: number, z: number) => {
  const g = deckGrid.get(`${Math.floor(x / DECK_CELL)}:${Math.floor(z / DECK_CELL)}`);

  if (g === undefined) {
    return -1;
  }

  for (const di of g) {
    const r = at(deckRings, di);
    let inside = false;
    let j = r.length - 1;

    for (let i = 0; i < r.length; i += 1) {
      const [xi, zi] = at(r, i);
      const [xj, zj] = at(r, j);

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

const groupFaces = new Map<string, Face[]>();

const pass2 = async () => {
  let group: string | null = null;
  let mtl = "";
  const rl = createInterface({ crlfDelay: Infinity, input: createReadStream(objPath) });

  for await (const l of rl) {
    const c0 = l.codePointAt(0);

    if (c0 === CH_F && l.codePointAt(1) === CH_SPACE) {
      if (group === null || group === "") {
        continue;
      }

      const ids = faceIds(l);
      let keep = KEEP_GROUPS.has(group);

      if (!keep) {
        for (const id of ids) {
          const [x, z] = worldXZ(id);

          if (inWater(x, z) || deckAt(x, z) >= 0) {
            keep = true;
            break;
          }
        }
      }

      if (!keep) {
        continue;
      }

      pushTo(groupFaces, group, { ids, mtl });
    } else if (l.startsWith("o ") || l.startsWith("g ")) {
      group = l.slice(2).trim();
    } else if (l.startsWith("usemtl")) {
      mtl = l.slice(7).trim();
    }
  }
};

const blobStats = (faces: Face[]) => {
  const verts = new Set<number>();
  const mtls = new Set<string>();
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
      const [x, z] = worldXZ(id);
      const y = at(vy, id) * CAL_SY;

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
    if (inWater(...worldXZ(id))) {
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

type Blob = ReturnType<typeof blobStats>;

const toBlobs = (faces: readonly Face[]) => {
  const parent = new Map<number, number>();
  const parentOf = (x: number) => parent.get(x) ?? x;

  const find = (a: number) => {
    let r = a;

    while (parentOf(r) !== r) {
      r = parentOf(r);
    }

    let walk = a;

    while (parentOf(walk) !== r) {
      const next = parentOf(walk);
      parent.set(walk, r);
      walk = next;
    }

    return r;
  };

  const union = (a: number, b: number) => {
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
      union(at(f.ids, 0), at(f.ids, i));
    }
  }

  const comps = new Map<number, Face[]>();

  for (const f of faces) {
    pushTo(comps, find(at(f.ids, 0)), f);
  }

  return [...comps.values()].map((c) => blobStats(c));
};

const undirectedBoundary = (faces: readonly Face[]) => {
  const count = new Map<string, number>();
  const ends = new Map<string, readonly [number, number]>();

  for (const f of faces) {
    const { ids } = f;

    for (let i = 0; i < ids.length; i += 1) {
      const a = at(ids, i);
      const b = at(ids, (i + 1) % ids.length);

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

  const adj = new Map<number, number[]>();
  let edges = 0;

  for (const [k, n] of count) {
    const e = ends.get(k);

    if (n !== 1 || e === undefined) {
      continue;
    }

    const [a, b] = e;

    if (!adj.has(a)) {
      adj.set(a, []);
    }

    if (!adj.has(b)) {
      adj.set(b, []);
    }

    pushTo(adj, a, b);
    pushTo(adj, b, a);
    edges += 1;
  }

  return { adj, edges };
};

const walkLoop = (adj: ReadonlyMap<number, number[]>, start: number, visited: Set<number>) => {
  const loop = [start];
  visited.add(start);
  let prev = start;
  let cur = (adj.get(start) ?? []).find((n) => !visited.has(n));

  while (cur !== undefined && !visited.has(cur)) {
    visited.add(cur);
    loop.push(cur);
    const nbrs = adj.get(cur) ?? [];
    const from = prev;
    const nxt = nbrs.find((n) => n !== from && !visited.has(n));
    prev = cur;
    cur = nxt ?? (nbrs.includes(start) ? start : undefined);

    if (cur === start) {
      break;
    }
  }

  return loop;
};

const boundaryRing = (faces: readonly Face[]) => {
  const { adj, edges } = undirectedBoundary(faces);

  if (edges < 3) {
    return null;
  }

  const visited = new Set<number>();
  let best: Point[] | null = null;
  let bestA = -1;

  for (const start of adj.keys()) {
    if (visited.has(start)) {
      continue;
    }

    const loop = walkLoop(adj, start, visited);

    if (loop.length < 3) {
      continue;
    }

    const pts = loop.map((id) => worldXZ(id));
    const a = Math.abs(ringArea(pts));

    if (a > bestA) {
      bestA = a;
      best = pts;
    }
  }

  if (best === null) {
    return null;
  }

  return ringArea(best) < 0 ? best.toReversed() : best;
};

const flat = (ring: readonly Point[]) => ring.flatMap(([x, z]) => [r1(x), r1(z)]);

const centroidOf = (ring: readonly Point[]) => {
  let a = 0;
  let x = 0;
  let z = 0;

  for (let i = 0; i < ring.length; i += 1) {
    const p = at(ring, i);
    const q = at(ring, (i + 1) % ring.length);
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

    return [mx / ring.length, mz / ring.length] as const;
  }

  return [x / (3 * a), z / (3 * a)] as const;
};

const srcUrl = (p: string) => new URL(p, import.meta.url);

const readGamePiers = () => {
  const ts = readFileSync(srcUrl("../../src/world/sf-piers.ts"), "utf-8");
  const body = ts.slice(ts.indexOf("export const SF_PIERS"), ts.indexOf("export const SF_DOCKS"));
  const out: GamePiers["piers"] = [];

  for (const entry of body.matchAll(/\{(?<fields>[^{}]*)\}/gu)) {
    const fields = entry.groups?.fields ?? "";
    const points = /p:\s*\[(?<points>[^\]]*)\]/u.exec(fields)?.groups?.points;
    const area = /area:\s*(?<area>\d+)/u.exec(fields)?.groups?.area;

    if (points === undefined || area === undefined) {
      continue;
    }

    const nums = points.split(",").map(Number);
    const ring: Point[] = [];

    for (let i = 0; i + 1 < nums.length; i += 2) {
      ring.push([at(nums, i), at(nums, i + 1)]);
    }

    out.push({ area: Number(area), ring });
  }

  const dockBody = ts.slice(ts.indexOf("export const SF_DOCKS"));

  const piers: GamePiers = {
    dockCount: (dockBody.match(/\[[-\d.,\s]+\]/gu) ?? []).length,
    piers: out,
  };

  return piers;
};

const readAuthoredLandmarks = () => {
  const ts = readFileSync(srcUrl("../../src/world/landmarks.ts"), "utf-8");

  const grab = (kind: string) => {
    const i = ts.indexOf(`kind: "${kind}"`);

    if (i === -1) {
      return null;
    }

    const seg = ts.slice(i, i + 400);
    const u = /\bu:\s*(?<n>[-\d.]+)/u.exec(seg);
    const v = /\bv:\s*(?<n>[-\d.]+)/u.exec(seg);
    const r = /rotDeg:\s*(?<n>[-\d.]+)/u.exec(seg);

    return u !== null && v !== null
      ? {
          rotDeg: r === null ? 0 : Number(r.groups?.n),
          u: Number(u.groups?.n),
          v: Number(v.groups?.n),
        }
      : null;
  };

  return { baybridge: grab("baybridge"), oraclepark: grab("oraclepark") };
};

const readOsmPierNames = () => {
  const raw = readOverpass(srcUrl("./sf-piers.raw.json"));
  const U_M = 6.2462;
  const U_B = 765.2557;
  const V_M = -9.6095;
  const V_B = 363.344;
  const out: OsmName[] = [];

  for (const e of raw.elements) {
    const name = e.tags?.name;

    if (e.type !== "way" || e.geometry === undefined || name === undefined || name === "") {
      continue;
    }

    let x = 0;
    let z = 0;

    for (const q of e.geometry) {
      x += (U_M * q.lon + U_B - 0.5) * WORLD_W;
      z += (V_M * q.lat + V_B - 0.5) * WORLD_H;
    }

    out.push({ name, x: x / e.geometry.length, z: z / e.geometry.length });
  }

  return out;
};

const readFootprintCentroids = () => {
  const ts = readFileSync(srcUrl("../../src/world/sf-footprints.ts"), "utf-8");

  const body = ts.slice(
    ts.indexOf("export const SF_FOOTPRINTS"),
    ts.indexOf("export const SF_FOOTPRINTS_BOUNDS"),
  );

  const out: P3[] = [];

  for (const m of body.matchAll(/\[(?<nums>[-\d.,\s]+)\]/gu)) {
    const n = (m.groups?.nums ?? "").split(",").map(Number);
    let x = 0;
    let z = 0;
    let c = 0;

    for (let i = 1; i + 1 < n.length; i += 2) {
      x += at(n, i);
      z += at(n, i + 1);
      c += 1;
    }

    if (c >= 3) {
      out.push([x / c, z / c, at(n, 0)]);
    }
  }

  return out;
};

const nearestName = (names: readonly OsmName[], x: number, z: number) => {
  let best: OsmName | null = null;
  let bestD = Infinity;

  for (const n of names) {
    const d = Math.hypot(n.x - x, n.z - z);

    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }

  return best === null ? null : { dist: r1(bestD), name: best.name };
};

const WET_MIN = 0.4;
const PIER_MIN_AREA = 60;

const MARINE_CLASS = new Map([
  ["barrier", "seawall"],
  ["landuse=po", "portApron"],
  ["man", "pier"],
  ["natural", "shorelineNatural"],
  ["park", "waterfrontPark"],
  ["way", "other"],
]);

const pierEntryOf = (g: string, cls: string, b: Blob, osmNames: readonly OsmName[]) => {
  const ring = boundaryRing(b.faces);

  if (ring === null || ring.length < 3) {
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

  const entry: PierEntry = {
    area: Math.round(area),
    cls,
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

  return entry;
};

const dedupePiers = (piers: readonly PierEntry[]) => {
  const kept: PierEntry[] = [];

  for (const p of piers) {
    const twin = kept.find(
      (k) => Math.hypot(k.cx - p.cx, k.cz - p.cz) < 6 && Math.abs(k.area - p.area) / k.area < 0.25,
    );

    if (twin !== undefined) {
      twin.duplicateIn = [...(twin.duplicateIn ?? []), p.group];
      continue;
    }

    kept.push(p);
  }

  return kept;
};

const nearestGamePier = (gc: readonly GameDeck[], p: { cx: number; cz: number }) => {
  let bi = -1;
  let bd = Infinity;

  for (const [i, g] of gc.entries()) {
    const d = Math.hypot(g.x - p.cx, g.z - p.cz);

    if (d < bd) {
      bd = d;
      bi = i;
    }
  }

  return { bd, bi };
};

const diffAgainstGamePiers = (
  objPiers: readonly PierEntry[],
  gc: readonly GameDeck[],
  usedGame: Set<number>,
) => {
  for (const p of objPiers) {
    const { bd, bi } = nearestGamePier(gc, p);

    if (bi >= 0 && bd <= 45) {
      usedGame.add(bi);
      const g = at(gc, bi);
      const ratio = p.area / Math.max(1, g.area);
      p.gameMatch = {
        areaRatio: r4(ratio),
        dist: r1(bd),
        gameArea: g.area,
        gamePts: g.pts,
        index: bi,
        verdict: ratio > 0.5 && ratio < 2 ? "same polygon" : "position only, shape differs",
      };
    } else {
      p.gameMatch = null;
      p.nearestGameDist = bi >= 0 ? r1(bd) : null;
    }
  }
};

type BlobsByGroup = ReadonlyMap<string, readonly Blob[]>;

const sectionPiers = (
  blobsByGroup: BlobsByGroup,
  gamePiers: GamePiers,
  osmNames: readonly OsmName[],
) => {
  const piers: PierEntry[] = [];

  for (const [g, cls] of MARINE_CLASS) {
    for (const b of blobsByGroup.get(g) ?? []) {
      if (b.wet < WET_MIN) {
        continue;
      }

      const entry = pierEntryOf(g, cls, b, osmNames);

      if (entry !== null) {
        piers.push(entry);
      }
    }
  }

  piers.sort((a, b) => b.area - a.area);

  const kept = dedupePiers(piers);

  const objPiers = kept.filter((p) => p.cls === "pier");
  const context = kept.filter((p) => p.cls !== "pier");

  const gc = gamePiers.piers.map<GameDeck>((p) => {
    const [x, z] = centroidOf(p.ring);

    return { area: p.area, pts: p.ring.length, x, z };
  });

  const usedGame = new Set<number>();
  diffAgainstGamePiers(objPiers, gc, usedGame);
  const orphanGame = [];

  for (const [i, g] of gc.entries()) {
    if (usedGame.has(i)) {
      continue;
    }

    let bd = Infinity;

    for (const p of objPiers) {
      bd = Math.min(bd, Math.hypot(g.x - p.cx, g.z - p.cz));
    }

    orphanGame.push({
      area: g.area,
      distToNearestObj: Number.isFinite(bd) ? r1(bd) : null,
      index: i,
      osm: nearestName(osmNames, g.x, g.z),
      u: r4(uOf(g.x)),
      v: r4(vOf(g.z)),
    });
  }

  orphanGame.sort((a, b) => b.area - a.area);

  return { context, objPiers, orphanGame };
};

const BRIDGE_CORRIDOR = 30;

const onBridge = (bridge: BayBridge, x: number, z: number) => {
  if (!bridge.present) {
    return false;
  }

  let best = Infinity;
  const c = bridge.centreline;

  for (let i = 1; i < c.length; i += 1) {
    const [x0, z0] = at(c, i - 1);
    const [x1, z1] = at(c, i);
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / len2));
    best = Math.min(best, Math.hypot(x - (x0 + dx * t), z - (z0 + dz * t)));
  }

  return best < BRIDGE_CORRIDOR;
};

const yOf = (id: number) => at(vy, id) * CAL_SY;

const shedFootprint = (b: Blob) => {
  const base = b.faces.filter((f) => f.ids.every((id) => yOf(id) <= b.minY + 0.75));
  const top = b.faces.filter((f) => f.ids.every((id) => yOf(id) >= b.maxY - 0.75));
  let ring = base.length > 0 ? boundaryRing(base) : null;

  if (ring === null || Math.abs(ringArea(ring)) < 0.45 * b.w * b.d) {
    ring = top.length > 0 ? boundaryRing(top) : null;

    if (ring !== null && Math.abs(ringArea(ring)) >= 0.35 * b.w * b.d) {
      return { ring, src: "roof" };
    }

    const box: Point[] = [
      [b.minX, b.minZ],
      [b.maxX, b.minZ],
      [b.maxX, b.maxZ],
      [b.minX, b.maxZ],
    ];

    return { ring: box, src: "bbox" };
  }

  return { ring, src: "base" };
};

interface DeckCentre {
  area: number;
  c: readonly [number, number];
  ring: Point[];
}

const nearestGameDeck = (gc: readonly DeckCentre[], cx: number, cz: number) => {
  let nearest: number | null = null;
  let bd = Infinity;

  for (const [i, g] of gc.entries()) {
    const d = Math.hypot(g.c[0] - cx, g.c[1] - cz);

    if (d < bd) {
      bd = d;
      nearest = i;
    }
  }

  return { bd, nearest };
};

const isShedBlob = (b: Blob) => {
  if (!b.mtls.includes("building")) {
    return false;
  }

  if (b.wet < WET_MIN && deckAt(b.cx, b.cz) < 0) {
    return false;
  }

  if (b.h < 1) {
    return false;
  }

  return b.w >= 3 && b.d >= 3 && b.w <= 400 && b.d <= 400;
};

const shedEntryOf = (
  g: string,
  b: Blob,
  gc: readonly DeckCentre[],
  osmNames: readonly OsmName[],
  bridge: BayBridge,
) => {
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

const NON_SHED_GROUPS = new Set(["man_stroke", "barrier", "builds", "builds_3"]);

const sectionPierBuildings = (
  blobsByGroup: BlobsByGroup,
  gamePiers: GamePiers,
  osmNames: readonly OsmName[],
  bridge: BayBridge,
) => {
  const gc = gamePiers.piers.map<DeckCentre>((p) => ({
    area: p.area,
    c: centroidOf(p.ring),
    ring: p.ring,
  }));

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

      if (entry !== null) {
        out.push(entry);
      }
    }
  }

  out.sort((a, b) => b.area * b.h - a.area * a.h);

  return out;
};

const BIN = 5;

const principalAxis = (pts: readonly P3[]) => {
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

  if (ax < 0) {
    ax = -ax;
    az = -az;
  }

  const axis: Axis = { ax, az, cx, cz };

  return axis;
};

const chainageBins = (pts: readonly P3[], sOf: AlongAxis) => {
  const bins = new Map<number, Bin>();

  for (const p of pts) {
    const b = Math.round(sOf(p) / BIN);
    let e = bins.get(b);

    if (e === undefined) {
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

const binAt = (bins: ReadonlyMap<number, Bin>, k: number) => {
  const e = bins.get(k);

  if (e === undefined) {
    throw new Error(`no chainage bin ${k}`);
  }

  return e;
};

const deckBand = (bins: ReadonlyMap<number, Bin>) => {
  const yBand = new Map<number, Set<number>>();

  for (const [b, e] of bins) {
    for (const p of e.pts) {
      const k = Math.round(p[1] * 2);
      let set = yBand.get(k);

      if (set === undefined) {
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

  return { deckHi: deckY + 2.5, deckLo: deckY - 0.6, deckY };
};

const roadwayOf = (e: Bin, deckLo: number, deckHi: number) => {
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

const roadSpanOf = (road: readonly P3[], tOf: AlongAxis) => {
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

const chainageProfile = (
  bins: ReadonlyMap<number, Bin>,
  keys: readonly number[],
  band: { deckHi: number; deckLo: number },
  axis: Axis,
  tOf: AlongAxis,
) => {
  const centre: Point[] = [];
  const widths: number[] = [];
  const profile: ProfileRow[] = [];

  for (const k of keys) {
    const e = binAt(bins, k);
    const { ramp, road } = roadwayOf(e, band.deckLo, band.deckHi);
    let width: number | null = null;
    let roadY: number | null = null;

    if (road.length >= 4) {
      const span = roadSpanOf(road, tOf);
      ({ roadY, width } = span);

      if (span.width < 25) {
        const tMid = (span.tmin + span.tmax) / 2;
        const s = k * BIN;

        if (!ramp) {
          widths.push(span.width);
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

const TOWER_CLEAR = 8;

interface Tower {
  s: number;
  top: number;
}

const findTowers = (profile: readonly ProfileRow[], deckY: number) => {
  const towers: Tower[] = [];

  for (const [i, p] of profile.entries()) {
    if (p.maxY < deckY + TOWER_CLEAR) {
      continue;
    }

    const prev = profile[i - 1];
    const nextP = profile[i + 1];

    if (
      (prev !== undefined && prev.maxY > p.maxY) ||
      (nextP !== undefined && nextP.maxY > p.maxY)
    ) {
      continue;
    }

    const last = towers.at(-1);

    if (last !== undefined && p.s - last.s < 40) {
      if (p.maxY > last.top) {
        towers[towers.length - 1] = { s: p.s, top: p.maxY };
      }

      continue;
    }

    towers.push({ s: p.s, top: p.maxY });
  }

  return towers;
};

const describeTowers = (
  towers: readonly Tower[],
  bins: ReadonlyMap<number, Bin>,
  axis: Axis,
  tOf: AlongAxis,
) =>
  towers.map((t) => {
    const x = axis.cx + axis.ax * t.s;
    const z = axis.cz + axis.az * t.s;
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

type TowerOut = ReturnType<typeof describeTowers>[number];

const cableProfile = (
  bins: ReadonlyMap<number, Bin>,
  keys: readonly number[],
  deckHi: number,
  tOf: AlongAxis,
) => {
  const cable: { leftY: number | null; rightY: number | null; s: number }[] = [];
  const offsets: number[] = [];

  for (const k of keys) {
    const e = binAt(bins, k);
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
    cableOffset: offsets.length > 0 ? at(offsets, Math.floor(offsets.length / 2)) : null,
  };
};

const cableSag = (towerOut: readonly TowerOut[], profile: readonly ProfileRow[]) => {
  const sag = [];

  for (let i = 1; i < towerOut.length; i += 1) {
    const a = at(towerOut, i - 1);
    const b = at(towerOut, i);
    const mid = (a.s + b.s) / 2;
    let nearest = at(profile, 0);

    for (const p of profile) {
      if (Math.abs(p.s - mid) < Math.abs(nearest.s - mid)) {
        nearest = p;
      }
    }

    sag.push({
      betweenTowers: [i - 1, i],
      midY: r1(nearest.maxY),
      sagBelowTowerTop: r1(b.topY - nearest.maxY),
      spanM: Math.round((b.s - a.s) * 4.446),
      spanU: r1(b.s - a.s),
    });
  }

  return sag;
};

const compareAuthoredBridge = (
  bearingDeg: number,
  deckY: number,
  towers: readonly Tower[],
  sf: Point,
  anchorPt: Point,
) => {
  const authored = readAuthoredLandmarks().baybridge;

  if (authored === null) {
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
    trueTowerTopY: towers.length > 0 ? r1(Math.max(...towers.map((t) => t.top))) : null,
  };
};

const detachedPartOf = (t: number, w: number) => {
  if (Math.abs(t) >= 1.5) {
    return "cable";
  }

  return w > 6 ? "tower" : "saddle";
};

const sectionBayBridge = (blobsByGroup: BlobsByGroup) => {
  const blobs = [...(blobsByGroup.get("builds") ?? [])].toSorted((a, b) => b.nv - a.nv);

  if (blobs.length === 0) {
    return { present: false as const };
  }

  const main = at(blobs, 0);
  const allIds = new Set<number>();

  for (const b of blobs) {
    for (const id of b.verts) {
      allIds.add(id);
    }
  }

  const pts = [...allIds].map<P3>((id) => [wxOf(at(vx, id)), yOf(id), wzOf(at(vz, id))]);

  const axis = principalAxis(pts);
  const { ax, az, cx, cz } = axis;
  const sOf: AlongAxis = (p) => (p[0] - cx) * ax + (p[2] - cz) * az;
  const tOf: AlongAxis = (p) => -(p[0] - cx) * az + (p[2] - cz) * ax;
  const bearingDeg = (Math.atan2(ax, -az) * 180) / Math.PI;

  const bins = chainageBins(pts, sOf);
  const band = deckBand(bins);
  const { deckY } = band;
  const keys = [...bins.keys()].toSorted((a, b) => a - b);
  const { centre, profile, widths } = chainageProfile(bins, keys, band, axis, tOf);
  widths.sort((a, b) => a - b);
  const medWidth = widths.length > 0 ? at(widths, Math.floor(widths.length / 2)) : null;

  const towers = findTowers(profile, deckY);
  const towerOut = describeTowers(towers, bins, axis, tOf);
  const { cable, cableOffset } = cableProfile(bins, keys, band.deckHi, tOf);
  const sag = cableSag(towerOut, profile);

  const line = rdp(centre, 0.8);
  const sf = at(line, 0);
  const yb = at(line, line.length - 1);
  const rampBins = profile.filter((p) => p.ramp);
  const suspended = profile.filter((p) => p.roadY !== null && !p.ramp);
  const anchorS = suspended.length > 0 ? at(suspended, 0).s : null;
  const anchorPt: Point = anchorS === null ? sf : [cx + ax * anchorS, cz + az * anchorS];
  const vsAuthored = compareAuthoredBridge(bearingDeg, deckY, towers, sf, anchorPt);
  const rampYs = rampBins.flatMap((p) => (p.roadY === null ? [] : [p.roadY]));

  return {
    approach: {
      rampBins: rampBins.length,
      rampLengthU: r1(rampBins.length * BIN),
      rampLowY: rampBins.length > 0 ? r1(Math.min(...rampYs)) : null,
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
    centreline: line.map<Point>(([x, z]) => [r1(x), r1(z)]),
    centrelineUV: line.map<Point>(([x, z]) => [r4(uOf(x)), r4(vOf(z))]),
    chainage: profile,
    deck: {
      widthM: medWidth === null ? null : Math.round(medWidth * 4.446),
      widthU: medWidth === null ? null : r1(medWidth),
      yM: Math.round(deckY * 4.446),
      yU: r1(deckY),
    },
    detachedTall: blobs
      .slice(1)
      .flatMap((b) => {
        if (b.maxY <= deckY + TOWER_CLEAR || b.nv < 16) {
          return [];
        }

        const t = tOf([b.cx, 0, b.cz]);

        return [
          {
            d: r1(b.d),
            nv: b.nv,
            part: detachedPartOf(t, b.w),
            s: r1(sOf([b.cx, 0, b.cz])),
            t: r1(t),
            topY: r1(b.maxY),
            u: r4(uOf(b.cx)),
            v: r4(vOf(b.cz)),
            w: r1(b.w),
          },
        ];
      })
      .toSorted((a, b) => a.s - b.s),
    identity: "Bay Bridge, western crossing (SF landfall -> Yerba Buena)",
    landfallYerbaBuena: { u: r4(uOf(yb[0])), v: r4(vOf(yb[1])), x: r1(yb[0]), z: r1(yb[1]) },
    lengthM: Math.round(plLen(line) * 4.446),
    lengthU: r1(plLen(line)),
    mainBlob: { nf: main.nf, nv: main.nv },
    pooledVerts: allIds.size,
    present: true as const,
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

type BayBridge = ReturnType<typeof sectionBayBridge>;

const sectionOraclePark = (blobsByGroup: BlobsByGroup, osmNames: readonly OsmName[]) => {
  const blobs = [...(blobsByGroup.get("builds_3") ?? [])].toSorted((a, b) => b.nv - a.nv);

  if (blobs.length === 0) {
    return { present: false as const };
  }

  const bowl = at(blobs, 0);
  const base = bowl.faces.filter((f) => f.ids.every((id) => yOf(id) <= bowl.minY + 1.5));
  let ring = base.length > 0 ? boundaryRing(base) : null;
  let ringFrom = "base";

  if (ring === null || Math.abs(ringArea(ring)) < 0.3 * bowl.w * bowl.d) {
    ring = boundaryRing(bowl.faces);
    ringFrom = "all-faces (outer rim, no closed base slab in the mesh)";
  }

  const simple = ring === null ? null : rdp(ring, 0.5);
  const [cx, cz] = simple === null ? [bowl.cx, bowl.cz] : centroidOf(simple);

  const SECT = 24;
  const sect = Array.from({ length: SECT }, () => -1e9);
  const sectR = Array.from({ length: SECT }, () => 0);

  for (const id of bowl.verts) {
    const [x, z] = worldXZ(id);
    const y = yOf(id);
    let a = Math.atan2(z - cz, x - cx) / (2 * Math.PI);
    a -= Math.floor(a);
    const k = Math.min(SECT - 1, Math.floor(a * SECT));

    if (y > at(sect, k)) {
      sect[k] = y;
    }

    sectR[k] = Math.max(at(sectR, k), Math.hypot(x - cx, z - cz));
  }

  const masts = blobs
    .slice(1)
    .flatMap((b) =>
      b.h > 3 && b.w < 6 && b.d < 6
        ? [
            {
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
            },
          ]
        : [],
    )
    .toSorted((a, b) => a.bearingFromCentreDeg - b.bearingFromCentreDeg);

  const authored = readAuthoredLandmarks().oraclepark;
  let vsAuthored = null;

  if (authored !== null) {
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

  return {
    present: true as const,
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
    ringPts: simple === null ? 0 : simple.length,
    ring: simple === null ? [] : flat(simple),
    ringUV: simple === null ? [] : simple.map<Point>(([x, z]) => [r4(uOf(x)), r4(vOf(z))]),
    sectorProfile: sect.map((y, i) => {
      const r = at(sectR, i);

      return {
        degFromEastCCW: Math.round((i * 360) / SECT),
        radius: r === 0 ? null : r1(r),
        topY: y === -1e9 ? null : r1(y),
      };
    }),
    masts,
    osm: nearestName(osmNames, cx, cz),
  };
};

const boxVsModelCells = (inBox: (u: number, v: number) => boolean) => {
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

const sectionWaterway = (blobsByGroup: BlobsByGroup, footprints: readonly P3[]) => {
  const wblobs = [...(blobsByGroup.get("waterway") ?? [])].toSorted((a, b) => b.nv - a.nv);
  const rings = [];

  for (const b of wblobs) {
    const ring = boundaryRing(b.faces);

    if (ring === null || ring.length < 4) {
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

  const BOX = { uMax: 0.8, uMin: 0.71, vMax: 0.35, vMin: 0.29 };

  const inBox = (u: number, v: number) =>
    u > BOX.uMin && u < BOX.uMax && v > BOX.vMin && v < BOX.vMax;

  let culled = 0;
  let culledOnRealLand = 0;
  let tallestCulled = 0;

  for (const [x, z, h] of footprints) {
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

  const creek =
    rings.find((r) => r.u > 0.7 && r.u < 0.82 && r.v > 0.3 && r.v < 0.42 && r.area < 60_000) ??
    null;

  const { boxButDry, boxCells, wetButNotBoxed, wetCells } = boxVsModelCells(inBox);

  return {
    chinaBasin: {
      boxedButDryInModel: boxButDry,
      creekPolygon:
        creek === null
          ? null
          : {
              area: creek.area,
              bboxU: creek.bboxU,
              bboxV: creek.bboxV,
              pts: creek.pts,
              ring: creek.ring,
              u: creek.u,
              v: creek.v,
            },
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

const logLandmarks = (
  bayBridge: ReturnType<typeof sectionBayBridge>,
  oraclePark: ReturnType<typeof sectionOraclePark>,
) => {
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

  if (bayBridge.present && bayBridge.vsAuthored !== null) {
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

    if (oraclePark.vsAuthored !== null) {
      const a = oraclePark.vsAuthored;
      console.log(
        `          vs landmarks.ts: authored u=${a.authored.u} v=${a.authored.v} -> ` +
          `${a.errorDistU}u (${a.errorDistM} m) off; authored radius ${a.authoredOuterRadius}u vs true ${a.trueMeanRadius}u`,
      );
    }
  }
};

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
  const blobsByGroup = new Map<string, Blob[]>();
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
  const bayBridge = sectionBayBridge(blobsByGroup);
  const pierBuildings = sectionPierBuildings(blobsByGroup, gamePiers, osmNames, bayBridge);
  const oraclePark = sectionOraclePark(blobsByGroup, osmNames);
  const waterway = sectionWaterway(blobsByGroup, footprints);

  const matched = objPiers.filter((p) => (p.gameMatch ?? null) !== null);
  const same = matched.filter((p) => p.gameMatch?.verdict === "same polygon");
  const onDeck = pierBuildings.filter((b) => b.onGameDeck >= 0);
  const decksWithBuilding = new Set(onDeck.map((b) => b.onGameDeck));
  const sheds = pierBuildings.filter((b) => b.h >= 2 && b.area >= 100);

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
      "three quarters of the waterfront. Keep bake-piers.mts as the pier source. The " +
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
    generatedBy: "tools/sf-data/extract-marine-obj.mts",
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
    const gm = p.gameMatch ?? null;
    const match = gm === null ? "NO MATCH" : `game#${gm.index} d=${gm.dist}u ratio=${gm.areaRatio}`;

    console.log(
      `          A=${String(p.area).padStart(5)}u2 ${String(p.pts).padStart(3)}pts u=${p.u} v=${p.v} ${match}  ~${p.osm?.name ?? "?"}`,
    );
  }

  console.log(
    `SHEDS   : ${pierBuildings.length} building blobs over water or on a shipped deck, ` +
      `${sheds.length} of them real massing (h>=2u, A>=100u2); ` +
      `${onDeck.length} sit INSIDE a deck polygon, populating ${decksWithBuilding.size}/${gamePiers.piers.length}`,
  );

  for (const b of sheds.slice(0, 10)) {
    const deck =
      b.onGameDeck >= 0
        ? `ON deck#${b.onGameDeck}`
        : `near deck#${String(b.nearestGameDeck.index)}@${b.nearestGameDeck.dist}u`;

    console.log(
      `          h=${String(b.h).padStart(5)}u A=${String(b.area).padStart(5)}u2 u=${b.u} v=${b.v} ${deck}  ~${b.osm?.name ?? "?"}`,
    );
  }

  logLandmarks(bayBridge, oraclePark);

  const cb = waterway.chinaBasin;
  console.log(
    `WATER   : ${waterway.waterTriangles} tris, ${waterway.rings.length} rings emitted; ` +
      `inlet box covers ${cb.gameBoxCells} cells (${cb.boxedButDryInModel} of them DRY in the model), ` +
      `${cb.wetInModelButNotBoxed} genuinely wet cells fall outside it`,
  );

  if (cb.creekPolygon !== null) {
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

await main();
