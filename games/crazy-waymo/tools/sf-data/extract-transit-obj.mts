import { spawnSync } from "node:child_process";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { at, plLen, projU, projV, rdp, WORLD_H, WORLD_W } from "./lib.mts";
import type { Point } from "./lib.mts";
import { readOverpass } from "./osm.mts";

const [objPath, outArg] = process.argv.slice(2);
const outPath = outArg ?? "transit.json";

if (objPath === undefined || objPath === "") {
  console.error("usage: node extract-transit-obj.mts <obj> [out.json]");
  process.exit(1);
}

type Quad = readonly [number, number, number, number];

interface Rec {
  kind: string;
  quads: Quad[];
  susp: boolean;
  tris: number;
}

interface Hit<P> {
  d: number;
  payload: P;
  x: number;
  z: number;
}

interface SegIndex<P> {
  add: (ax: number, az: number, bx: number, bz: number, payload: P) => void;
  count: () => number;
  nearest: (px: number, pz: number, maxD: number) => Hit<P> | null;
}

interface GameNetwork {
  edgeLen: number[];
  edges: number;
  genId: string;
  idx: SegIndex<number>;
}

interface NamedStreets {
  byName: Map<string, Point[][]>;
  idx: SegIndex<string>;
  ways: number;
}

interface Adjacency {
  adj: Map<number, Set<number>>;
  pos: Point[];
}

interface Corridor {
  edges: number[];
  lengthU: number;
  street: string;
}

interface UvBox {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

interface Route {
  kind: string;
  lengthU: number;
  name: string;
  pts: Point[];
  snapped: true;
  street: string | null;
  uv: UvBox;
}

interface FailedLine {
  kind: string;
  name: string;
  ok: false;
  why: string;
}

interface RecoveredLine {
  kind: string;
  lengthKm: number;
  lengthU: number;
  maxRdpDeviationU: number;
  name: string;
  ok: true;
  pts: Point[];
  snapped: true;
  terminalErrU: [number, number];
  uv: UvBox;
  viaStreets: string[];
}

type NamedLine = FailedLine | RecoveredLine;

interface Extent {
  u01: [number, number];
  uFull: [number, number];
  v01: [number, number];
  vFull: [number, number];
}

const CAL = { bx: 325.2, bz: -400.5, sx: 0.17829, sz: 0.17909 };

const toWorld: (mx: number, mz: number) => Point = (mx, mz) => [
  mx * CAL.sx + CAL.bx,
  mz * CAL.sz + CAL.bz,
];

const ANCHORS: readonly (readonly [string, number, number, number, number])[] = [
  ["Salesforce", 2458.4, -2088.9, 760, -770.1],
  ["Transamerica", 1809.9, -2842.1, 644.9, -907.7],
];

const MERGE_R = 1.5;
const RDP_EPS = 1;
const SNAP_MAX = 6;
const NAME_MAX = 10;
const MEASURE_MAX = 150;
const DEDUPE_D = 4;
const DEDUPE_FRAC = 0.9;
const MIN_CHAIN_U = 1.5;
const MERGE_W = 2.5;
const STROKE_TURN = Math.cos((65 * Math.PI) / 180);
const XSEC_MAX = 40;

const UNDERGROUND_STREETS = new Set(["Market Street", "Stockton Tunnel"]);
const UNDERGROUND_MODES = new Set(["light_rail", "railway"]);

const EMITTED_MODES = ["cable", "tram", "light_rail", "trolleybus", "railway"];

const KIND_RE: readonly (readonly [RegExp, string])[] = [
  [/^route_cable(?:_|$)/u, "cable"],
  [/^route_tram(?:_|$)/u, "tram"],
  [/^route_light_rail(?:_|$)/u, "light_rail"],
  [/^route_troll?eybus(?:_|$)/u, "trolleybus"],
  [/^route_bus(?:_|$)/u, "bus"],
  [/^railway$/u, "railway"],
  [/^route_monorail(?:_|$)/u, "monorail"],
  [/^route_subway(?:_|$)/u, "subway"],
  [/^route_train(?:_|$)/u, "train"],
  [/^route_ferry(?:_|$)/u, "ferry"],
];

const classify = (group: string) => {
  const bare = group.replace(/_suspended/u, "");

  for (const [re, kind] of KIND_RE) {
    if (re.test(bare)) {
      return kind;
    }
  }

  return null;
};

const segDist = (px: number, pz: number, ax: number, az: number, bx: number, bz: number) => {
  const dx = bx - ax;
  const dz = bz - az;
  const L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : Math.min(1, t);
  const qx = ax + t * dx;
  const qz = az + t * dz;

  return [Math.hypot(px - qx, pz - qz), qx, qz] as const;
};

const cellKey = (i: number, j: number) => `${i},${j}`;
const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

const makeSegIndex = <P,>(cell: number) => {
  const buckets = new Map<string, number[]>();
  const segs: (readonly [number, number, number, number, P])[] = [];

  const index: SegIndex<P> = {
    add(ax, az, bx, bz, payload) {
      const id = segs.push([ax, az, bx, bz, payload]) - 1;
      const i0 = Math.floor(Math.min(ax, bx) / cell);
      const i1 = Math.floor(Math.max(ax, bx) / cell);
      const j0 = Math.floor(Math.min(az, bz) / cell);
      const j1 = Math.floor(Math.max(az, bz) / cell);

      for (let i = i0; i <= i1; i += 1) {
        for (let j = j0; j <= j1; j += 1) {
          const k = cellKey(i, j);
          let b = buckets.get(k);

          if (b === undefined) {
            b = [];
            buckets.set(k, b);
          }

          b.push(id);
        }
      }
    },
    count: () => segs.length,
    nearest(px, pz, maxD) {
      const r = Math.ceil(maxD / cell);
      const ci = Math.floor(px / cell);
      const cj = Math.floor(pz / cell);
      let best: Hit<P> | null = null;

      for (let i = ci - r; i <= ci + r; i += 1) {
        for (let j = cj - r; j <= cj + r; j += 1) {
          const b = buckets.get(cellKey(i, j));

          if (b === undefined) {
            continue;
          }

          for (const id of b) {
            const s = at(segs, id);
            const [d, qx, qz] = segDist(px, pz, s[0], s[1], s[2], s[3]);

            if (d <= maxD && (best === null || d < best.d)) {
              best = { d, payload: s[4], x: qx, z: qz };
            }
          }
        }
      }

      return best;
    },
  };

  return index;
};

const setOf = (adj: ReadonlyMap<number, Set<number>>, n: number) => {
  const s = adj.get(n);

  if (s === undefined) {
    throw new Error(`node ${n} is not in the graph`);
  }

  return s;
};

const pct = (arr: readonly number[], t: number) => {
  if (arr.length === 0) {
    return Number.NaN;
  }

  const s = arr.toSorted((a, b) => a - b);

  return at(s, Math.min(s.length - 1, Math.floor(s.length * t)));
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const uOf = (x: number) => x / WORLD_W + 0.5;
const vOf = (z: number) => z / WORLD_H + 0.5;

const oxfmt = (file: string) => {
  const bin = path.resolve(
    new URL("../../../../node_modules/.bin/oxfmt", import.meta.url).pathname,
  );

  const r = spawnSync(bin, ["--write", file], { stdio: "ignore" });

  if (r.status !== 0) {
    console.log(`  (could not run oxfmt on ${file} — format it before committing)`);
  }
};

const loadGameNetwork = () => {
  const src = readFileSync(new URL("../../src/world/sf-network.ts", import.meta.url), "utf-8");
  const stamp = /NETWORK_GEN_ID = "(?<id>[^"]+)"/u.exec(src);

  if (stamp === null) {
    console.error("sf-network.ts carries no NETWORK_GEN_ID — cannot stamp the emitted module");
    process.exit(1);
  }

  const idx = makeSegIndex<number>(24);
  const edgeLen: number[] = [];

  for (const m of src.matchAll(/p:\s*\[(?<nums>[-\d.,\s]+)\]/gu)) {
    const nums = (m.groups?.nums ?? "").split(",").map(Number);
    const e = edgeLen.length;
    let L = 0;

    for (let i = 2; i + 1 < nums.length; i += 2) {
      const ax = at(nums, i - 2);
      const az = at(nums, i - 1);
      const bx = at(nums, i);
      const bz = at(nums, i + 1);
      idx.add(ax, az, bx, bz, e);
      L += Math.hypot(bx - ax, bz - az);
    }

    edgeLen.push(L);
  }

  if (edgeLen.length === 0) {
    console.error("sf-network.ts parsed to 0 edges — the SF_EDGES shape changed, fix the regex");
    process.exit(1);
  }

  const net: GameNetwork = {
    edgeLen,
    edges: edgeLen.length,
    genId: stamp.groups?.id ?? "",
    idx,
  };

  return net;
};

const loadNamedStreets = () => {
  const raw = readOverpass(new URL("sf-streets.raw.json", import.meta.url));
  const idx = makeSegIndex<string>(24);
  const byName = new Map<string, Point[][]>();
  let ways = 0;

  for (const el of raw.elements) {
    const name = el.tags?.name;

    if (name === undefined || name === "" || el.geometry === undefined) {
      continue;
    }

    const pl = el.geometry.map<Point>((g) => [
      (projU(g.lon) - 0.5) * WORLD_W,
      (projV(g.lat) - 0.5) * WORLD_H,
    ]);

    if (pl.length < 2) {
      continue;
    }

    ways += 1;

    for (let i = 1; i < pl.length; i += 1) {
      const [ax, az] = at(pl, i - 1);
      const [bx, bz] = at(pl, i);
      idx.add(ax, az, bx, bz, name);
    }

    let l = byName.get(name);

    if (l === undefined) {
      l = [];
      byName.set(name, l);
    }

    l.push(pl);
  }

  const streets: NamedStreets = { byName, idx, ways };

  return streets;
};

const streetIntersection = (streets: NamedStreets, nameA: string, nameB: string) => {
  const A = streets.byName.get(nameA);
  const B = streets.byName.get(nameB);

  if (A === undefined || B === undefined) {
    return null;
  }

  let best: { d: number; x: number; z: number } | null = null;

  for (const pb of B) {
    for (const [px, pz] of pb) {
      for (const pa of A) {
        for (let i = 1; i < pa.length; i += 1) {
          const [ax, az] = at(pa, i - 1);
          const [bx, bz] = at(pa, i);
          const [d, qx, qz] = segDist(px, pz, ax, az, bx, bz);

          if (best === null || d < best.d) {
            best = { d, x: (px + qx) / 2, z: (pz + qz) / 2 };
          }
        }
      }
    }
  }

  return best !== null && best.d < XSEC_MAX ? best : null;
};

const vx: number[] = [];
const vy: number[] = [];
const vz: number[] = [];
const groups = new Map<string, Rec>();
let curRec: Rec | null = null;
let emptyGroups = 0;

const rl = createInterface({ crlfDelay: Infinity, input: createReadStream(objPath) });

const vertexId = (part: string) => {
  const s = part.includes("/") ? part.slice(0, part.indexOf("/")) : part;
  let id = Number(s);

  if (id < 0) {
    id = vx.length + 1 + id;
  }

  return id - 1;
};

rl.on("line", (l) => {
  const c0 = l.codePointAt(0);

  if (c0 === 118 && l.codePointAt(1) === 32) {
    let i = 2;

    while (l.codePointAt(i) === 32) {
      i += 1;
    }

    const j = l.indexOf(" ", i);
    const k = l.indexOf(" ", j + 1);
    vx.push(Number(l.slice(i, j)));
    vy.push(Number(l.slice(j + 1, k)));
    vz.push(Number(l.slice(k + 1)));
  } else if (c0 === 102 && l.codePointAt(1) === 32) {
    if (curRec === null) {
      return;
    }

    const parts = l.slice(2).trim().split(/\s+/u);

    if (parts.length !== 4) {
      curRec.tris += 1;

      return;
    }

    curRec.quads.push([
      vertexId(at(parts, 0)),
      vertexId(at(parts, 1)),
      vertexId(at(parts, 2)),
      vertexId(at(parts, 3)),
    ]);
  } else if (l.startsWith("o ") || l.startsWith("g ")) {
    const cur = l.slice(2).trim();
    const kind = classify(cur);
    curRec = null;

    if (kind !== null) {
      let rec = groups.get(cur);

      if (rec === undefined) {
        rec = { kind, quads: [], susp: cur.includes("suspended"), tris: 0 };
        groups.set(cur, rec);
      }

      curRec = rec;
    }
  }
});

rl.on("close", () => {
  for (const [, rec] of groups) {
    if (rec.quads.length === 0 && rec.tris === 0) {
      emptyGroups += 1;
    }
  }

  main();
});

const components = (adj: ReadonlyMap<number, ReadonlySet<number>>) => {
  const seen = new Set<number>();
  const out: number[] = [];

  for (const start of adj.keys()) {
    if (seen.has(start)) {
      continue;
    }

    let n = 0;
    const stack = [start];
    seen.add(start);

    for (let u = stack.pop(); u !== undefined; u = stack.pop()) {
      n += 1;

      for (const v of adj.get(u) ?? []) {
        if (!seen.has(v)) {
          seen.add(v);
          stack.push(v);
        }
      }
    }

    out.push(n);
  }

  return out.toSorted((a, b) => b - a);
};

const quadUpness = (f: Quad) => {
  let nx = 0;
  let ny = 0;
  let nz = 0;

  for (let i = 0; i < 4; i += 1) {
    const a = at(f, i);
    const b = at(f, (i + 1) % 4);
    nx += (at(vy, a) - at(vy, b)) * (at(vz, a) + at(vz, b));
    ny += (at(vz, a) - at(vz, b)) * (at(vx, a) + at(vx, b));
    nz += (at(vx, a) - at(vx, b)) * (at(vy, a) + at(vy, b));
  }

  return ny / (Math.hypot(nx, ny, nz) || 1);
};

type Pairing = readonly (readonly [number, number])[];

const crossEdgesOf = (f: Quad, ecount: ReadonlyMap<string, number>) => {
  const [a, b, c, d] = f;

  const pair1: Pairing = [
    [a, b],
    [c, d],
  ];

  const pair2: Pairing = [
    [b, c],
    [d, a],
  ];

  const count = (p: number, q: number) => ecount.get(edgeKey(p, q)) ?? 0;
  const s1 = count(a, b) + count(c, d);
  const s2 = count(b, c) + count(d, a);

  if (s1 === s2) {
    const L = (p: number, q: number) => Math.hypot(at(vx, p) - at(vx, q), at(vz, p) - at(vz, q));

    return { byLength: true, cross: L(a, b) + L(c, d) < L(b, c) + L(d, a) ? pair1 : pair2 };
  }

  return { byLength: false, cross: s1 > s2 ? pair1 : pair2 };
};

const meanY = (fs: readonly Quad[]) => {
  let s = 0;
  let n = 0;

  for (const f of fs) {
    for (const id of f) {
      s += at(vy, id);
      n += 1;
    }
  }

  return n > 0 ? s / n : -1e9;
};

const buildGraph = (recs: readonly Rec[]) => {
  const horizA: Quad[] = [];
  const horizB: Quad[] = [];
  let nonHoriz = 0;

  for (const rec of recs) {
    for (const f of rec.quads) {
      const uy = quadUpness(f);

      if (uy > 0.9) {
        horizA.push(f);
      } else if (uy < -0.9) {
        horizB.push(f);
      } else {
        nonHoriz += 1;
      }
    }
  }

  const top = meanY(horizA) >= meanY(horizB) ? horizA : horizB;
  const bottom = top === horizA ? horizB : horizA;

  const ecount = new Map<string, number>();

  for (const f of top) {
    for (let i = 0; i < 4; i += 1) {
      ecount.set(edgeKey(at(f, i), at(f, (i + 1) % 4)), 0);
    }
  }

  for (const f of top) {
    for (let i = 0; i < 4; i += 1) {
      const k = edgeKey(at(f, i), at(f, (i + 1) % 4));
      ecount.set(k, (ecount.get(k) ?? 0) + 1);
    }
  }

  let byTopology = 0;
  let byLength = 0;

  const buckets = new Map<string, number[]>();
  const pos: Point[] = [];
  const adj = new Map<number, Set<number>>();

  const nodeAt = (mx: number, mz: number) => {
    const bi = Math.floor(mx / MERGE_R);
    const bj = Math.floor(mz / MERGE_R);

    for (let i = bi - 1; i <= bi + 1; i += 1) {
      for (let j = bj - 1; j <= bj + 1; j += 1) {
        const b = buckets.get(`${i},${j}`);

        if (b === undefined) {
          continue;
        }

        for (const id of b) {
          const [px, pz] = at(pos, id);

          if (Math.hypot(px - mx, pz - mz) <= MERGE_R) {
            return id;
          }
        }
      }
    }

    const id = pos.push([mx, mz]) - 1;
    adj.set(id, new Set());
    const k = `${bi},${bj}`;
    let b = buckets.get(k);

    if (b === undefined) {
      b = [];
      buckets.set(k, b);
    }

    b.push(id);

    return id;
  };

  const link = (a: number, b: number) => {
    if (a === b) {
      return;
    }

    setOf(adj, a).add(b);
    setOf(adj, b).add(a);
  };

  const widths: number[] = [];

  for (const f of top) {
    const { byLength: lengthDecided, cross } = crossEdgesOf(f, ecount);

    if (lengthDecided) {
      byLength += 1;
    } else {
      byTopology += 1;
    }

    const mids = cross.map(([p, q]) => {
      widths.push(Math.hypot(at(vx, p) - at(vx, q), at(vz, p) - at(vz, q)));

      return nodeAt((at(vx, p) + at(vx, q)) / 2, (at(vz, p) + at(vz, q)) / 2);
    });

    link(at(mids, 0), at(mids, 1));
  }

  const compSizes = components(adj);

  return {
    adj,
    pos,
    stats: {
      biggestComponents: compSizes.slice(0, 6),
      bottomQuads: bottom.length,
      components: compSizes.length,
      nodes: pos.length,
      nonHorizQuads: nonHoriz,
      pairedByLength: byLength,
      pairedByTopology: byTopology,
      quads: top.length + bottom.length + nonHoriz,
      ribbonWidthModel: r2(pct(widths, 0.5)),
      ribbonWidthWorld: r2(pct(widths, 0.5) * CAL.sx),
      topQuads: top.length,
    },
  };
};

type ModelGraph = ReturnType<typeof buildGraph>;

const snapNodes = (g: Readonly<Adjacency>, net: GameNetwork, streets: NamedStreets) => {
  const preD: number[] = [];
  const placed: Point[] = [];
  const coveredEdges = new Set<number>();
  const edgeVotes = new Map<number, Map<string, number>>();
  let snapped = 0;

  for (const [mx, mz] of g.pos) {
    const [x, z] = toWorld(mx, mz);
    const hit = net.idx.nearest(x, z, MEASURE_MAX);
    preD.push(hit === null ? MEASURE_MAX : hit.d);

    if (hit !== null && hit.d <= SNAP_MAX) {
      placed.push([hit.x, hit.z]);
      coveredEdges.add(hit.payload);
      const nameHit = streets.idx.nearest(hit.x, hit.z, NAME_MAX);
      let votes = edgeVotes.get(hit.payload);

      if (votes === undefined) {
        votes = new Map();
        edgeVotes.set(hit.payload, votes);
      }

      const nm = nameHit === null ? "" : nameHit.payload;
      votes.set(nm, (votes.get(nm) ?? 0) + 1);
      snapped += 1;
    } else {
      placed.push([x, z]);
    }
  }

  return { coveredEdges, edgeVotes, placed, preD, snapped };
};

const consolidate = (g: ModelGraph, net: GameNetwork, streets: NamedStreets) => {
  const { coveredEdges, edgeVotes, placed, preD, snapped } = snapNodes(g, net, streets);
  const buckets = new Map<string, number[]>();
  const pos: Point[] = [];
  const remap = new Int32Array(placed.length);
  const snapRank = (i: number) => (at(preD, i) <= SNAP_MAX ? 0 : 1);
  const order = [...placed.keys()].toSorted((a, b) => snapRank(a) - snapRank(b) || a - b);

  for (const i of order) {
    const [x, z] = at(placed, i);
    const bi = Math.floor(x / MERGE_W);
    const bj = Math.floor(z / MERGE_W);
    let found = -1;

    for (let a = bi - 1; a <= bi + 1 && found < 0; a += 1) {
      for (let b = bj - 1; b <= bj + 1 && found < 0; b += 1) {
        for (const id of buckets.get(`${a},${b}`) ?? []) {
          const [px, pz] = at(pos, id);

          if (Math.hypot(px - x, pz - z) <= MERGE_W) {
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

      if (b === undefined) {
        b = [];
        buckets.set(k, b);
      }

      b.push(found);
    }

    remap[i] = found;
  }

  const adj = new Map<number, Set<number>>();

  for (let i = 0; i < pos.length; i += 1) {
    adj.set(i, new Set());
  }

  for (const [a, nbrs] of g.adj) {
    for (const b of nbrs) {
      const ra = at(remap, a);
      const rb = at(remap, b);

      if (ra === rb) {
        continue;
      }

      setOf(adj, ra).add(rb);
      setOf(adj, rb).add(ra);
    }
  }

  return {
    adj,
    coveredEdges,
    edgeVotes,
    merged: placed.length - pos.length,
    points: placed.length,
    pos,
    preD,
    snapped,
  };
};

type WorldGraph = ReturnType<typeof consolidate>;

const byText = (a: string, b: string) => {
  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};

const buildCorridors = (
  edgeVotes: ReadonlyMap<number, ReadonlyMap<string, number>>,
  net: GameNetwork,
) => {
  const byStreet = new Map<string, number[]>();

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

    if (list === undefined) {
      list = [];
      byStreet.set(street, list);
    }

    list.push(edge);
  }

  const out: Corridor[] = [];

  for (const [street, edges] of byStreet) {
    edges.sort((a, b) => a - b);
    out.push({
      edges,
      lengthU: r1(edges.reduce((s, e) => s + at(net.edgeLen, e), 0)),
      street,
    });
  }

  out.sort((a, b) => b.lengthU - a.lengthU || (a.street < b.street ? -1 : 1));

  return out;
};

const edgeLoad = (recs: readonly Rec[], net: GameNetwork) => {
  const load = new Map<number, number>();

  for (const rec of recs) {
    const ids = new Set<number>();

    for (const f of rec.quads) {
      for (const id of f) {
        ids.add(id);
      }
    }

    const edges = new Set<number>();

    for (const id of ids) {
      const [x, z] = toWorld(at(vx, id), at(vz, id));
      const hit = net.idx.nearest(x, z, SNAP_MAX);

      if (hit !== null) {
        edges.add(hit.payload);
      }
    }

    for (const e of edges) {
      load.set(e, (load.get(e) ?? 0) + 1);
    }
  }

  return load;
};

type LabelOf = (a: number, b: number) => string | null;

const traceStrokes = (g: Readonly<Adjacency>, labelOf: LabelOf) => {
  const { pos, adj } = g;
  const used = new Set<string>();
  const edges: (readonly [number, number])[] = [];

  for (const [a, nbrs] of adj) {
    for (const b of nbrs) {
      if (a < b) {
        edges.push([a, b]);
      }
    }
  }

  edges.sort((p, q) => p[0] - q[0] || p[1] - q[1]);

  const dirOf = (from: number, to: number) => {
    const [tx, tz] = at(pos, to);
    const [fx, fz] = at(pos, from);
    const dx = tx - fx;
    const dz = tz - fz;
    const l = Math.hypot(dx, dz) || 1;

    return [dx / l, dz / l] as const;
  };

  const extend = (out: number[], from: number, start: number, label: string | null) => {
    let prev = from;
    let node = start;

    for (;;) {
      const [dx, dz] = dirOf(prev, node);
      let best = -1;
      let bestDot = STROKE_TURN;
      const cands = [...(adj.get(node) ?? [])].toSorted((a, b) => a - b);

      for (const n of cands) {
        if (n === prev || used.has(edgeKey(node, n))) {
          continue;
        }

        if (labelOf(node, n) !== label) {
          continue;
        }

        const [ex, ez] = dirOf(node, n);
        const dot = dx * ex + dz * ez;

        if (dot > bestDot) {
          bestDot = dot;
          best = n;
        }
      }

      if (best < 0) {
        return;
      }

      used.add(edgeKey(node, best));
      out.push(best);
      prev = node;
      node = best;

      if (out.length > 100_000) {
        return;
      }
    }
  };

  const strokes: { ids: number[]; label: string | null }[] = [];

  for (const [a, b] of edges) {
    if (used.has(edgeKey(a, b))) {
      continue;
    }

    used.add(edgeKey(a, b));
    const label = labelOf(a, b);
    const fwd = [b];
    extend(fwd, a, b, label);
    const back = [a];
    extend(back, b, a, label);
    strokes.push({ ids: [...back.toReversed(), ...fwd], label });
  }

  return strokes;
};

const clipToWorld = (pts: readonly Point[]) => {
  const out: Point[][] = [];
  let run: Point[] = [];

  for (const p of pts) {
    if (Math.abs(p[0]) <= WORLD_W / 2 && Math.abs(p[1]) <= WORLD_H / 2) {
      run.push(p);
    } else {
      if (run.length >= 2) {
        out.push(run);
      }

      run = [];
    }
  }

  if (run.length >= 2) {
    out.push(run);
  }

  return out;
};

const rdpSafe = (pts: readonly Point[], eps: number) => {
  if (pts.length <= 2) {
    return [...pts];
  }

  const [x0, z0] = at(pts, 0);
  const [xn, zn] = at(pts, pts.length - 1);
  const chord = Math.hypot(x0 - xn, z0 - zn);

  if (chord > 0.05 * plLen(pts)) {
    return rdp(pts, eps);
  }

  let far = 0;
  let fd = -1;

  for (let i = 1; i < pts.length; i += 1) {
    const [x, z] = at(pts, i);
    const d = Math.hypot(x - x0, z - z0);

    if (d > fd) {
      fd = d;
      far = i;
    }
  }

  if (far < 1 || far > pts.length - 2) {
    return rdp(pts, eps);
  }

  const l = rdp(pts.slice(0, far + 1), eps);
  const r = rdp(pts.slice(far), eps);

  return [...l.slice(0, -1), ...r];
};

const shortestPath = (g: Readonly<Adjacency>, from: number, to: number) => {
  const dist = new Map([[from, 0]]);
  const prev = new Map<number, number>();
  const seen = new Set<number>();
  const queue: (readonly [number, number])[] = [[0, from]];

  for (;;) {
    queue.sort((a, b) => a[0] - b[0]);
    const head = queue.shift();

    if (head === undefined) {
      break;
    }

    const [d, u] = head;

    if (seen.has(u)) {
      continue;
    }

    seen.add(u);

    if (u === to) {
      break;
    }

    const [ux, uz] = at(g.pos, u);

    for (const v of g.adj.get(u) ?? []) {
      if (seen.has(v)) {
        continue;
      }

      const [vx2, vz2] = at(g.pos, v);
      const nd = d + Math.hypot(ux - vx2, uz - vz2);

      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, u);
        queue.push([nd, v]);
      }
    }
  }

  if (!seen.has(to)) {
    return null;
  }

  const out: Point[] = [];

  for (let c: number | undefined = to; c !== undefined; c = prev.get(c)) {
    out.push(at(g.pos, c));

    if (c === from) {
      break;
    }
  }

  return out.toReversed();
};

const nearestNode = (g: Readonly<Pick<Adjacency, "pos">>, x: number, z: number) => {
  let best = -1;
  let bd = Infinity;

  for (const [i, [px, pz]] of g.pos.entries()) {
    const d = Math.hypot(px - x, pz - z);

    if (d < bd) {
      bd = d;
      best = i;
    }
  }

  return { d: bd, id: best };
};

const maxDeviation = (src: readonly Point[], simp: readonly Point[]) => {
  let worst = 0;

  for (const [px, pz] of src) {
    let d = Infinity;

    for (let i = 1; i < simp.length; i += 1) {
      const [ax, az] = at(simp, i - 1);
      const [bx, bz] = at(simp, i);
      const [dd] = segDist(px, pz, ax, az, bx, bz);

      if (dd < d) {
        d = dd;
      }
    }

    if (d > worst) {
      worst = d;
    }
  }

  return worst;
};

const checkAnchors = () => {
  for (const [name, mx, mz, wx, wz] of ANCHORS) {
    const [ax, az] = toWorld(mx, mz);
    const err = Math.hypot(ax - wx, az - wz);
    console.log(`anchor ${name}: (${r1(ax)}, ${r1(az)}) vs (${wx}, ${wz}) — ${r1(err)}u`);

    if (err > 12) {
      console.error("anchor drift — recheck CAL before emitting");
      process.exit(1);
    }
  }
};

interface KindGroup {
  graph: WorldGraph | null;
  live: Rec[];
  names: string[];
  susp: Rec[];
}

const inventory = () => {
  const byKind = new Map<string, KindGroup>();

  for (const [gname, rec] of groups) {
    let k = byKind.get(rec.kind);

    if (k === undefined) {
      k = { graph: null, live: [], names: [], susp: [] };
      byKind.set(rec.kind, k);
    }

    (rec.susp ? k.susp : k.live).push(rec);
    k.names.push(gname);
  }

  console.log("\n--- OBJ group inventory ---");
  let totalQuads = 0;
  let totalTris = 0;

  for (const [kind, k] of [...byKind].toSorted((a, b) => byText(a[0], b[0]))) {
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

  return { byKind, totalQuads, totalTris };
};

const dedupeSuspended = (gLive: Readonly<Adjacency>, gSusp: Readonly<Adjacency>) => {
  const liveIdx = makeSegIndex<undefined>(24);

  for (const [a, nbrs] of gLive.adj) {
    for (const b of nbrs) {
      if (b < a) {
        continue;
      }

      const [ax, az] = toWorld(...at(gLive.pos, a));
      const [bx, bz] = toWorld(...at(gLive.pos, b));
      liveIdx.add(ax, az, bx, bz, undefined);
    }
  }

  let hit = 0;
  let tot = 0;

  for (const p of gSusp.pos) {
    const [x, z] = toWorld(p[0], p[1]);
    tot += 1;

    if (liveIdx.nearest(x, z, DEDUPE_D) !== null) {
      hit += 1;
    }
  }

  const frac = tot > 0 ? hit / tot : 0;
  console.log(
    `  suspended-vs-live overlap: ${(frac * 100).toFixed(1)}% of suspended points sit within ${DEDUPE_D}u of live track`,
  );

  const dedupe = {
    radiusU: DEDUPE_D,
    suspendedPoints: tot,
    withinLive: r2(frac),
    dropped: frac >= DEDUPE_FRAC,
  };

  if (dedupe.dropped) {
    console.log(`  -> suspended variant DROPPED as a duplicate`);
  } else {
    console.log(`  -> suspended variant KEPT (distinct alignment)`);
  }

  return dedupe;
};

const edgeLabeller = (g: Readonly<Adjacency>, streets: NamedStreets) => {
  const labelCache = new Map<string, string | null>();

  const labelOf: LabelOf = (a, b) => {
    const key = edgeKey(a, b);
    let l = labelCache.get(key);

    if (l === undefined) {
      const [ax, az] = at(g.pos, a);
      const [bx, bz] = at(g.pos, b);
      const hit = streets.idx.nearest((ax + bx) / 2, (az + bz) / 2, NAME_MAX);

      l = hit === null ? null : hit.payload;
      labelCache.set(key, l);
    }

    return l;
  };

  let unlabelled = 0;

  for (const [a, nbrs] of g.adj) {
    for (const b of nbrs) {
      if (a < b && labelOf(a, b) === null) {
        unlabelled += 1;
      }
    }
  }

  return { labelOf, unlabelled };
};

const uvBox = (pts: readonly Point[]) => {
  const box: UvBox = {
    u0: r2(uOf(Math.min(...pts.map((p) => p[0])))),
    u1: r2(uOf(Math.max(...pts.map((p) => p[0])))),
    v0: r2(vOf(Math.min(...pts.map((p) => p[1])))),
    v1: r2(vOf(Math.max(...pts.map((p) => p[1])))),
  };

  return box;
};

const distStats = (ds: readonly number[]) => ({
  max: r2(Math.max(...ds)),
  p50: r2(pct(ds, 0.5)),
  p90: r2(pct(ds, 0.9)),
  p99: r2(pct(ds, 0.99)),
});

const roundPts = (pts: readonly Point[]) => pts.map<Point>(([x, z]) => [r1(x), r1(z)]);

const emitStrokes = (
  kind: string,
  strokes: readonly { ids: readonly number[]; label: string | null }[],
  g: Readonly<Pick<Adjacency, "pos">>,
  net: GameNetwork,
) => {
  const emitted: Route[] = [];
  const postD: number[] = [];
  let rawPts = 0;
  let simpPts = 0;
  let worstDev = 0;
  let dropped = 0;

  for (const st of strokes) {
    const world = st.ids.map((i) => at(g.pos, i));

    for (const pts of clipToWorld(world)) {
      if (plLen(pts) < MIN_CHAIN_U) {
        dropped += 1;
        continue;
      }

      for (const [x, z] of pts) {
        const hit = net.idx.nearest(x, z, MEASURE_MAX);
        postD.push(hit === null ? MEASURE_MAX : hit.d);
      }

      rawPts += pts.length;
      const simp = rdpSafe(pts, RDP_EPS);
      simpPts += simp.length;
      worstDev = Math.max(worstDev, maxDeviation(pts, simp));
      emitted.push({
        kind,
        lengthU: r1(plLen(simp)),
        name: st.label !== null && st.label !== "" ? `${kind}: ${st.label}` : `${kind}: unnamed`,
        pts: roundPts(simp),
        snapped: true,
        street: st.label,
        uv: uvBox(simp),
      });
    }
  }

  return { dropped, emitted, postD, rawPts, simpPts, worstDev };
};

const topStreetsOf = (emitted: readonly Route[]) => {
  const topStreets = new Map<string, number>();

  for (const e of emitted) {
    if (e.street !== null && e.street !== "") {
      topStreets.set(e.street, (topStreets.get(e.street) ?? 0) + e.lengthU);
    }
  }

  return [...topStreets].toSorted((a, b) => b[1] - a[1]).slice(0, 10);
};

const surfaceCorridors = (kind: string, g: WorldGraph, net: GameNetwork) => {
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

  return filt;
};

const tallyBusLoad = (
  k: KindGroup,
  g: WorldGraph,
  net: GameNetwork,
  busLoad: Map<number, number>,
) => {
  const raw = edgeLoad([...k.live, ...k.susp], net);

  for (const e of g.coveredEdges) {
    busLoad.set(e, raw.get(e) ?? 1);
  }

  const loads = [...busLoad.values()];
  console.log(
    `  bus service density over ${busLoad.size} edges: p50 ${pct(loads, 0.5)} · p90 ${pct(loads, 0.9)} · max ${Math.max(...loads)} route objects`,
  );
};

const worldGraphOf = (kind: string, k: KindGroup) => {
  const liveHas = k.live.some((r) => r.quads.length > 0);
  const suspHas = k.susp.some((r) => r.quads.length > 0);

  if (!liveHas && !suspHas) {
    return null;
  }

  console.log(`\n### ${kind}`);
  const gLive = liveHas ? buildGraph(k.live) : null;
  const gSusp = suspHas ? buildGraph(k.susp) : null;

  if (gLive !== null) {
    console.log(`  live      : ${JSON.stringify(gLive.stats)}`);
  }

  if (gSusp !== null) {
    console.log(`  suspended : ${JSON.stringify(gSusp.stats)}`);
  }

  const dedupe = gLive !== null && gSusp !== null ? dedupeSuspended(gLive, gSusp) : null;
  const keep = [...k.live];

  if (gSusp !== null && dedupe?.dropped !== true) {
    keep.push(...k.susp);
  }

  const gm = keep.length === k.live.length && gLive !== null ? gLive : buildGraph(keep);

  return { dedupe, gm };
};

type DistStats = ReturnType<typeof distStats>;

interface KindStats {
  biggestComponentsAfterConsolidation: number[];
  componentsAfterConsolidation: number;
  corridorKm: number;
  corridorLengthU: number;
  dedupe: ReturnType<typeof dedupeSuspended> | null;
  distToAsphaltAfter: DistStats;
  distToAsphaltBefore: DistStats;
  droppedFragments: number;
  gameEdgeLengthU: number;
  gameEdgesCovered: number;
  live: number;
  maxRdpDeviationU: number;
  mergeW: number;
  nodesMergedByDirection: number;
  nodesModel: number;
  nodesWorld: number;
  objects: number;
  pointsRaw: number;
  pointsSimplified: number;
  rdpEps: number;
  snapCapU: number;
  snappedFrac: number;
  strokes: number;
  suspended: number;
  topStreets: (readonly [string, number])[];
  unlabelledEdges: number;
  surfaceCorridors: number;
  surfaceEdges: number;
}

interface SkippedKind {
  note: string;
}

interface Ctx {
  busLoad: Map<number, number>;
  corridors: Record<string, Corridor[]>;
  coverage: Record<string, number[]>;
  kindStats: Record<string, KindStats | SkippedKind>;
  net: GameNetwork;
  routes: Route[];
  streets: NamedStreets;
}

const processKind = (kind: string, k: KindGroup, ctx: Ctx) => {
  const { net, streets } = ctx;
  const graphs = worldGraphOf(kind, k);

  if (graphs === null) {
    console.log(`\n### ${kind}: declared but carries no geometry — skipped`);
    ctx.kindStats[kind] = { note: "declared in OBJ but carries no faces" };

    return;
  }

  const { dedupe, gm } = graphs;
  const g = consolidate(gm, net, streets);
  const { preD } = g;
  const comps = components(g.adj);
  console.log(
    `  consolidated: ${gm.pos.length} model nodes -> ${g.pos.length} world nodes (${g.merged} merged at ${MERGE_W}u, ${((g.snapped / g.points) * 100).toFixed(1)}% snapped to game asphalt within ${SNAP_MAX}u) · components ${comps.length} ${JSON.stringify(comps.slice(0, 6))}`,
  );
  const { labelOf, unlabelled } = edgeLabeller(g, streets);
  const strokes = traceStrokes(g, labelOf);
  const { dropped, emitted, postD, rawPts, simpPts, worstDev } = emitStrokes(kind, strokes, g, net);
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
  const covLen = [...g.coveredEdges].reduce((s2, e) => s2 + at(net.edgeLen, e), 0);
  console.log(
    `  lands on ${g.coveredEdges.size}/${net.edges} game street edges = ${r1(covLen)}u of our asphalt (${r1((covLen * 4.446) / 1000)} km) — draw the rails along THESE edges and alignment is exact by construction`,
  );
  const ts = topStreetsOf(emitted);
  console.log(`  top streets: ${ts.map(([n, l]) => `${n} ${r1(l)}u`).join(" · ")}`);

  const filt = surfaceCorridors(kind, g, net);

  ctx.kindStats[kind] = {
    biggestComponentsAfterConsolidation: comps.slice(0, 6),
    componentsAfterConsolidation: comps.length,
    corridorKm: r1((totalLen * 4.446) / 1000),
    corridorLengthU: r1(totalLen),
    dedupe,
    distToAsphaltAfter: distStats(postD),
    distToAsphaltBefore: distStats(preD),
    droppedFragments: dropped,
    gameEdgeLengthU: r1(covLen),
    gameEdgesCovered: g.coveredEdges.size,
    live: k.live.length,
    maxRdpDeviationU: r2(worstDev),
    mergeW: MERGE_W,
    nodesMergedByDirection: g.merged,
    nodesModel: gm.pos.length,
    nodesWorld: g.pos.length,
    objects: k.names.length,
    pointsRaw: rawPts,
    pointsSimplified: simpPts,
    rdpEps: RDP_EPS,
    snapCapU: SNAP_MAX,
    snappedFrac: r2(snappedPts / g.points),
    strokes: emitted.length,
    suspended: k.susp.length,
    topStreets: ts.map(([n, l]) => [n, r1(l)] as const),
    unlabelledEdges: unlabelled,
    surfaceCorridors: filt.length,
    surfaceEdges: filt.reduce((s, c) => s + c.edges.length, 0),
  };
  ctx.coverage[kind] = [...g.coveredEdges].toSorted((a, b) => a - b);
  ctx.corridors[kind] = filt;

  if (kind === "bus") {
    tallyBusLoad(k, g, net, ctx.busLoad);
  }

  for (const e of emitted) {
    ctx.routes.push(e);
  }

  k.graph = g;
};

type Terminal = readonly [string, string];

const NAMED: readonly (readonly [string, string, Terminal, Terminal])[] = [
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

const recoverLine = (
  [kind, label, A, B]: readonly [string, string, Terminal, Terminal],
  byKind: ReadonlyMap<string, KindGroup>,
  streets: NamedStreets,
) => {
  const graph = byKind.get(kind)?.graph ?? null;

  if (graph === null) {
    console.log(`  ${label}: no ${kind} graph`);

    return null;
  }

  const ia = streetIntersection(streets, A[0], A[1]);
  const ib = streetIntersection(streets, B[0], B[1]);

  if (ia === null || ib === null) {
    console.log(`  ${label}: could not locate terminal (${A.join(" x ")} / ${B.join(" x ")})`);

    const failed: NamedLine = {
      kind,
      name: label,
      ok: false,
      why: "terminal intersection not found in OSM",
    };

    return failed;
  }

  const na = nearestNode(graph, ia.x, ia.z);
  const nb = nearestNode(graph, ib.x, ib.z);
  const daU = na.d;
  const dbU = nb.d;

  if (daU > 40 || dbU > 40) {
    console.log(
      `  ${label}: terminals located but track ends ${r1(daU)}u / ${r1(dbU)}u away — NOT this network`,
    );

    const failed: NamedLine = {
      kind,
      name: label,
      ok: false,
      why: `nearest track node ${r1(daU)}u / ${r1(dbU)}u from terminal`,
    };

    return failed;
  }

  const pathModel = shortestPath(graph, na.id, nb.id);

  if (pathModel === null) {
    console.log(`  ${label}: terminals matched but no connected path in the track graph`);

    const failed: NamedLine = {
      kind,
      name: label,
      ok: false,
      why: "terminals not connected in track graph",
    };

    return failed;
  }

  const simp = rdpSafe(pathModel, RDP_EPS);
  const dev = maxDeviation(pathModel, simp);
  const lenU = plLen(simp);
  const seq: string[] = [];

  for (const [x, z] of simp) {
    const hit = streets.idx.nearest(x, z, NAME_MAX);
    const n = hit === null ? "?" : hit.payload;

    if (seq.at(-1) !== n) {
      seq.push(n);
    }
  }

  const cond = seq.filter((n, i) => n !== "?" || i === 0);
  console.log(
    `  ${label}: ${r1(lenU)}u (${r1((lenU * 4.446) / 1000)} km), ${simp.length} pts, dev ${r2(dev)}u · via ${cond.slice(0, 14).join(" > ")}`,
  );

  const line: NamedLine = {
    kind,
    lengthKm: r1((lenU * 4.446) / 1000),
    lengthU: r1(lenU),
    maxRdpDeviationU: r2(dev),
    name: label,
    ok: true,
    pts: roundPts(simp),
    snapped: true,
    terminalErrU: [r1(daU), r1(dbU)],
    uv: uvBox(simp),
    viaStreets: cond,
  };

  return line;
};

const dataExtent = (routes: readonly Route[]) => {
  const allU: number[] = [];
  const allV: number[] = [];

  for (const r of routes) {
    for (const [x, z] of r.pts) {
      allU.push(uOf(x));
      allV.push(vOf(z));
    }
  }

  const extent: Extent = {
    u01: [r2(pct(allU, 0.01)), r2(pct(allU, 0.99))],
    uFull: [r2(Math.min(...allU)), r2(Math.max(...allU))],
    v01: [r2(pct(allV, 0.01)), r2(pct(allV, 0.99))],
    vFull: [r2(Math.min(...allV)), r2(Math.max(...allV))],
  };

  return extent;
};

const main = () => {
  checkAnchors();
  const net = loadGameNetwork();
  const streets = loadNamedStreets();
  console.log(
    `game network: ${net.edges} edges / ${net.idx.count()} segs · named OSM ways: ${streets.ways} (${streets.byName.size} distinct names)`,
  );

  const { byKind, totalQuads, totalTris } = inventory();

  const ctx: Ctx = {
    busLoad: new Map(),
    corridors: {},
    coverage: {},
    kindStats: {},
    net,
    routes: [],
    streets,
  };

  for (const [kind, k] of [...byKind].toSorted((a, b) => byText(a[0], b[0]))) {
    if (k.live.length === 0 && k.susp.length === 0) {
      continue;
    }

    processKind(kind, k, ctx);
  }

  const { busLoad, corridors, coverage, kindStats, routes } = ctx;

  console.log("\n--- named line recovery (Dijkstra between OSM street intersections) ---");
  const named: NamedLine[] = [];

  for (const spec of NAMED) {
    const line = recoverLine(spec, byKind, streets);

    if (line !== null) {
      named.push(line);
    }
  }

  const extent = dataExtent(routes);
  console.log(
    `\ntransit data extent: u ${extent.u01[0]}-${extent.u01[1]} (full ${extent.uFull[0]}-${extent.uFull[1]}), v ${extent.v01[0]}-${extent.v01[1]} (full ${extent.vFull[0]}-${extent.vFull[1]}) — the OBJ is DOWNTOWN-only, the rest of the map has no transit at all`,
  );

  const payload = {
    busEdgeLoad: [...busLoad].toSorted((a, b) => a[0] - b[0]),
    calibration: { ...CAL, note: "shared with extract-footprints.mts; do not re-fit" },
    extent,
    gameEdgeCorridors: corridors,
    gameEdgeCoverage: coverage,
    generatedAt: new Date().toISOString(),
    namedLines: named,
    network: { edges: net.edges, genId: net.genId },
    params: {
      DEDUPE_D,
      DEDUPE_FRAC,
      MERGE_R,
      MERGE_W,
      MIN_CHAIN_U,
      NAME_MAX,
      RDP_EPS,
      SNAP_MAX,
      XSEC_MAX,
    },
    routes,
    source: objPath,
    stats: {
      byKind: kindStats,
      emptyObjects: emptyGroups,
      nonQuadFacesSkipped: totalTris,
      objects: groups.size,
      quads: totalQuads,
    },
    world: { H: WORLD_H, W: WORLD_W, metresPerUnit: 4.446 },
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload));
  console.log(
    `\nwrote ${outPath} — ${routes.length} corridor polylines, ${named.filter((n) => n.ok).length}/${named.length} named lines recovered`,
  );

  emitTransitModule(net, corridors, named, busLoad, extent);
};

const lineBlock = (n: RecoveredLine) =>
  `  {\n` +
  `    name: ${JSON.stringify(n.name)},\n` +
  `    mode: ${JSON.stringify(n.kind)},\n` +
  `    lengthU: ${n.lengthU},\n` +
  `    p: ${JSON.stringify(n.pts.flat())},\n` +
  `  },`;

const emitTransitModule = (
  net: GameNetwork,
  corridors: Readonly<Record<string, readonly Corridor[]>>,
  named: readonly NamedLine[],
  busLoad: ReadonlyMap<number, number>,
  extent: Extent,
) => {
  const corridorsOf = (m: string) => corridors[m] ?? [];
  const modes = EMITTED_MODES.filter((m) => corridorsOf(m).length > 0);
  const lines = named.filter((n): n is RecoveredLine => n.ok && n.kind !== "light_rail");

  const modeBlock = (m: string) =>
    `  ${m}: [\n${corridorsOf(m)
      .map(
        (c) =>
          `    { street: ${JSON.stringify(c.street)}, lengthU: ${c.lengthU}, edges: ${JSON.stringify(c.edges)} },`,
      )
      .join("\n")}\n  ],`;

  const busRows = [...busLoad]
    .toSorted((a, b) => a[0] - b[0])
    .map(([e, n]) => `[${e}, ${n}],`)
    .join(" ");

  const totals = modes
    .map((m) => `${m} ${corridorsOf(m).reduce((s, c) => s + c.edges.length, 0)}`)
    .join(", ");

  const src = `// AUTO-GENERATED by tools/sf-data/extract-transit-obj.mts — do not edit by hand.
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
    `wrote src/world/sf-transit.ts — ${modes.length} modes / ${modes.reduce((s, m) => s + corridorsOf(m).length, 0)} corridors, ${lines.length} named lines, ${busLoad.size} bus-weighted edges, ${(src.length / 1024).toFixed(1)} KB, stamp ${net.genId}`,
  );
};
