import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { onLandUV, plLen, rdp, ringArea, WORLD_H, WORLD_W } from "./lib.mts";

const [objPath, outArg] = process.argv.slice(2);
const outPath = outArg ?? new URL("sf-landuse-obj.json", import.meta.url).pathname;

if (!objPath) {
  console.error("usage: node extract-landuse-obj.mts <obj> [out.json]");
  process.exit(1);
}

const CAL = { bx: 325.2, bz: -400.5, sx: 0.17829, sz: 0.17909 };
const CAL_SY = 1 / (1.598 * 4.446);
const M_PER_U = 4.446;

const ANCHORS = [
  ["Salesforce", 2458.4, -2088.9, 760, -770.1],
  ["Transamerica", 1809.9, -2842.1, 644.9, -907.7],
];

const toWorldX = (x: string | number | undefined) => x * CAL.sx + CAL.bx;
const toWorldZ = (z: string | number | undefined) => z * CAL.sz + CAL.bz;
const toU = (wx: number) => wx / WORLD_W + 0.5;
const toV = (wz: number) => wz / WORLD_H + 0.5;

const U_B = 765.2557;
const U_M = 6.2462;
const V_M = -9.6095;
const V_B = 363.344;
const osmX = (lon: number) => (U_M * lon + U_B - 0.5) * WORLD_W;
const osmZ = (lat: number) => (V_M * lat + V_B - 0.5) * WORLD_H;

const GRID_X = 244;
const GRID_Z = 200;

const ROADISH_NAME = /^(?:highway_|route_|restriction_|name_.)/u;
const BUILDING_NAME = /^(?:height=|buildin|builds)/u;
const STRIPY_NAME = /^(?:barrier|man_stroke)$/u;

const CH_SPACE = 32;
const CH_F = 102;
const CH_O = 111;
const CH_V = 118;

const vx: number[] = [];
const vy: number[] = [];
const vz: number[] = [];
const groups = new Map();
let curName: string | null = null;
let curMtl = "";
let objLines = 0;

const rl = createInterface({ crlfDelay: Infinity, input: createReadStream(objPath) });

rl.on("line", (l) => {
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
  } else if (c0 === CH_F && l.codePointAt(1) === CH_SPACE) {
    if (!curName) {
      return;
    }

    const key = `${curName}|${curMtl}`;
    let g = groups.get(key);

    if (!g) {
      g = [];
      groups.set(key, g);
    }

    const ids = [];

    for (const part of l.slice(2).trim().split(/\s+/u)) {
      const s = part.includes("/") ? part.slice(0, part.indexOf("/")) : part;
      let id = Number(s);

      if (id < 0) {
        id = vx.length + 1 + id;
      }

      ids.push(id - 1);
    }

    g.push(ids);
  } else if (c0 === CH_O && l.codePointAt(1) === CH_SPACE) {
    curName = l.slice(2).trim();
    objLines += 1;
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

const components = (faces: any) => {
  const parent = new Map();

  const find = (a: any) => {
    let r = a;

    while (parent.get(r) !== r) {
      r = parent.get(r);
    }

    let walk = a;

    while (parent.get(walk) !== r) {
      const nxt = parent.get(walk);
      parent.set(walk, r);
      walk = nxt;
    }

    return r;
  };

  const union = (a: any, b: any) => {
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
    for (let i = 1; i < f.length; i += 1) {
      union(f[0], f[i]);
    }
  }

  const out = new Map();

  for (const f of faces) {
    const root = find(f[0]);
    let c = out.get(root);

    if (!c) {
      c = { faces: [], maxX: -1e9, maxY: -1e9, maxZ: -1e9, minX: 1e9, minY: 1e9, minZ: 1e9 };
      out.set(root, c);
    }

    c.faces.push(f);

    for (const id of f) {
      const x = vx[id];
      const y = vy[id];
      const z = vz[id];

      if (x < c.minX) {
        c.minX = x;
      }

      if (x > c.maxX) {
        c.maxX = x;
      }

      if (y < c.minY) {
        c.minY = y;
      }

      if (y > c.maxY) {
        c.maxY = y;
      }

      if (z < c.minZ) {
        c.minZ = z;
      }

      if (z > c.maxZ) {
        c.maxZ = z;
      }
    }
  }

  return [...out.values()];
};

const edgeAngle = (a: string | number, b: number) => Math.atan2(vz[b] - vz[a], vx[b] - vx[a]);

const boundaryEdges = (top: any) => {
  const count = new Map();
  const dir = new Map();

  for (const f of top) {
    for (let i = 0; i < f.length; i += 1) {
      const a = f[i];
      const b = f[(i + 1) % f.length];

      if (a === b) {
        continue;
      }

      const k = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(k, (count.get(k) ?? 0) + 1);

      if (!dir.has(k)) {
        dir.set(k, [a, b]);
      }
    }
  }

  const next = new Map();
  let edges = 0;

  for (const [k, n] of count) {
    if (n !== 1) {
      continue;
    }

    const d = dir.get(k);

    if (!d) {
      continue;
    }

    let l = next.get(d[0]);

    if (!l) {
      l = [];
      next.set(d[0], l);
    }

    l.push(d[1]);
    edges += 1;
  }

  return { edges, next };
};

const traceRings = (next: Map<any, any>, edges: number) => {
  const rings = [];

  for (const start of next.keys()) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const loop = [];
      let prev = -1;
      let cur = start;
      let guard = 0;

      while (guard < edges + 2) {
        guard += 1;
        const outs = next.get(cur);

        if (!outs || outs.length === 0) {
          break;
        }

        let pick = 0;

        if (outs.length > 1 && prev >= 0) {
          const base = edgeAngle(cur, prev);
          let bestD = Infinity;

          for (let i = 0; i < outs.length; i += 1) {
            let d = base - edgeAngle(cur, outs[i]);

            while (d <= 1e-9) {
              d += Math.PI * 2;
            }

            while (d > Math.PI * 2) {
              d -= Math.PI * 2;
            }

            if (d < bestD) {
              bestD = d;
              pick = i;
            }
          }
        }

        loop.push(cur);
        prev = cur;
        [cur] = outs.splice(pick, 1);

        if (cur === start) {
          break;
        }
      }

      if (cur === start && loop.length >= 3) {
        rings.push(loop.map((id) => [toWorldX(vx[id]), toWorldZ(vz[id])]));
      }
    }
  }

  return rings;
};

const topRings = (c: { maxY: number; minY: number; faces: any[] }) => {
  const eps = Math.max(1e-4, Math.min(0.75, (c.maxY - c.minY) * 0.1));
  const top = c.faces.filter((f: any[]) =>
    f.every((id: string | number) => vy[id] >= c.maxY - eps),
  );

  if (top.length === 0) {
    return [];
  }

  const { edges, next } = boundaryEdges(top);

  if (edges < 3) {
    return [];
  }

  return traceRings(next, edges);
};

const cross = (p: number[], q: number[], s: number[]) =>
  (q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0]);

const isSimpleRing = (r: string | any[]) => {
  if (r.length > 120) {
    return true;
  }

  for (let i = 0; i < r.length; i += 1) {
    const a = r[i];
    const b = r[(i + 1) % r.length];

    for (let k = i + 2; k < r.length; k += 1) {
      if (i === 0 && k === r.length - 1) {
        continue;
      }

      const c = r[k];
      const d = r[(k + 1) % r.length];

      if (cross(c, d, a) > 0 !== cross(c, d, b) > 0 && cross(a, b, c) > 0 !== cross(a, b, d) > 0) {
        return false;
      }
    }
  }

  return true;
};

const centroidOf = (ring: string | any[]) => {
  let a = 0;
  let cx = 0;
  let cz = 0;

  for (let i = 0; i < ring.length; i += 1) {
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

const tagsOf = (element: { tags: { [x: string]: any } }) => {
  const tags = [];

  for (const k of TAG_KEYS) {
    if (element.tags?.[k]) {
      tags.push(`${k}=${element.tags[k]}`);
    }
  }

  return tags;
};

const ringGeometriesOf = (element: { type: string; geometry: string | any[]; members: any }) => {
  if (element.type === "way") {
    return element.geometry?.length >= 2 ? [element.geometry] : [];
  }

  if (element.type === "relation") {
    return (element.members ?? [])
      .filter(
        (m: { role: string; geometry: string | any[] }) =>
          m.role !== "inner" && m.geometry?.length >= 3,
      )
      .map((m: { geometry: any }) => m.geometry);
  }

  return [];
};

const loadOsm = () => {
  const ways = [];
  const seen = new Set();

  for (const file of ["sf-landuse.raw.json", "sf-osm-tags.raw.json"]) {
    const url = new URL(`${file}`, import.meta.url);

    if (!existsSync(url)) {
      console.log(`WARN ${file} missing — decode coverage will be reduced`);
      continue;
    }

    const raw = JSON.parse(readFileSync(url, "utf-8"));
    let n = 0;
    let rel = 0;

    for (const e of raw.elements ?? []) {
      const key = `${e.type}/${e.id}`;

      if (seen.has(key)) {
        continue;
      }

      const tags = tagsOf(e);

      if (tags.length === 0) {
        continue;
      }

      const geoms = ringGeometriesOf(e);

      if (geoms.length === 0) {
        continue;
      }

      seen.add(key);

      if (e.type === "relation") {
        rel += 1;
      }

      for (const geom of geoms) {
        const ring = geom.map((g: { lon: any; lat: any }) => [osmX(g.lon), osmZ(g.lat)]);
        const closed = ring.length > 3;
        const [cx, cz] = closed ? centroidOf(ring) : ring[Math.floor(ring.length / 2)];
        ways.push({
          area: closed ? Math.abs(ringArea(ring)) : 0,
          cx,
          cz,
          id: e.id,
          len: plLen(ring),
          name: e.tags?.name ?? null,
          ring: closed ? ring : null,
          tags,
        });
        n += 1;
      }
    }

    console.log(`osm ${file}: ${n} new tagged rings (${rel} from multipolygon relations)`);
  }

  return ways;
};

const CELL = 64;
const cellKey = (gx: number, gz: number) => gx * 100_000 + gz;

const indexWays = (ways: string | any[]) => {
  const map = new Map();

  for (let i = 0; i < ways.length; i += 1) {
    const gx = Math.floor(ways[i].cx / CELL);
    const gz = Math.floor(ways[i].cz / CELL);
    const k = cellKey(gx, gz);
    let b = map.get(k);

    if (!b) {
      b = [];
      map.set(k, b);
    }

    b.push(i);
  }

  return {
    near(x: number, z: number, r: number) {
      const out = [];
      const g0x = Math.floor((x - r) / CELL);
      const g1x = Math.floor((x + r) / CELL);
      const g0z = Math.floor((z - r) / CELL);
      const g1z = Math.floor((z + r) / CELL);

      for (let gx = g0x; gx <= g1x; gx += 1) {
        for (let gz = g0z; gz <= g1z; gz += 1) {
          const b = map.get(cellKey(gx, gz));

          if (b) {
            out.push(...b);
          }
        }
      }

      return out;
    },
  };
};

const CLASS_OF = {
  "amenity=bicycle_parking": ["parking", 34],
  "amenity=college": ["institution", 14],
  "amenity=fountain": ["plaza", 64],
  "amenity=hospital": ["institution", 14],
  "amenity=kindergarten": ["institution", 14],
  "amenity=motorcycle_parking": ["parking", 34],
  "amenity=parking": ["parking", 34],
  "amenity=parking_space": ["parking", 34],
  "amenity=place_of_worship": ["institution", 14],
  "amenity=school": ["institution", 14],
  "amenity=shelter": ["plaza", 64],
  "amenity=university": ["institution", 14],
  "landuse=allotments": ["garden", 50],
  "landuse=brownfield": ["brownfield", 26],
  "landuse=cemetery": ["cemetery", 52],
  "landuse=commercial": ["commercial", 18],
  "landuse=construction": ["construction", 28],
  "landuse=flowerbed": ["garden", 50],
  "landuse=forest": ["wood", 46],
  "landuse=grass": ["grass", 40],
  "landuse=industrial": ["industrial", 24],
  "landuse=meadow": ["grass", 40],
  "landuse=military": ["military", 32],
  "landuse=port": ["port", 30],
  "landuse=railway": ["railyard", 30],
  "landuse=recreation_ground": ["recreation", 48],
  "landuse=religious": ["cemetery", 52],
  "landuse=residential": ["residential", 10],
  "landuse=retail": ["retail", 20],
  "landuse=tree_pit": ["garden", 50],
  "landuse=village_green": ["grass", 40],
  "leisure=bleachers": ["recreation", 48],
  "leisure=common": ["park", 60],
  "leisure=dog_park": ["park", 60],
  "leisure=fitness_station": ["recreation", 48],
  "leisure=garden": ["garden", 50],
  "leisure=golf_course": ["golf", 44],
  "leisure=marina": ["water", 90],
  "leisure=nature_reserve": ["park", 60],
  "leisure=outdoor_seating": ["plaza", 64],
  "leisure=park": ["park", 60],
  "leisure=parklet": ["garden", 50],
  "leisure=pitch": ["pitch", 70],
  "leisure=playground": ["playground", 72],
  "leisure=slipway": ["port", 30],
  "leisure=sports_centre": ["recreation", 48],
  "leisure=stadium": ["recreation", 48],
  "leisure=swimming_pool": ["water", 90],
  "leisure=track": ["pitch", 70],
  "man_made=breakwater": ["pier", 36],
  "man_made=pier": ["pier", 36],
  "man_made=storage_tank": ["industrial", 24],
  "natural=bare_rock": ["rock", 78],
  "natural=beach": ["sand", 80],
  "natural=cliff": ["rock", 78],
  "natural=grassland": ["grass", 40],
  "natural=sand": ["sand", 80],
  "natural=scrub": ["scrub", 42],
  "natural=shrubbery": ["scrub", 42],
  "natural=tree_row": ["wood", 46],
  "natural=water": ["water", 90],
  "natural=wood": ["wood", 46],
  "place=square": ["plaza", 66],
  "tourism=attraction": ["plaza", 64],
  "tourism=picnic_site": ["park", 60],
  "waterway=dock": ["water", 90],
  "waterway=riverbank": ["water", 90],
};

const classFor = (tag: string) => CLASS_OF[tag] ?? null;

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
  "leisure=PO": ["POPS"],
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
  "leisure=pr": ["practice_pitch"],
  "leisure=s*": ["swimming_pool", "sports_centre", "slipway", "stadium"],
  "leisure=sl": ["slipway"],
  "leisure=sp": ["sports_centre"],
};

const nameHint = (objName: string) => {
  const m = /^(?<tagKey>landuse|leisure)=(?<suffix>..)$/u.exec(objName);

  if (!m?.groups) {
    return null;
  }

  const { suffix, tagKey } = m.groups;
  const wild = /\d$/u.test(suffix) ? `${tagKey}=${suffix[0]}*` : `${tagKey}=${suffix}`;

  return NAME_HINTS[wild] ? { candidates: NAME_HINTS[wild], pattern: wild } : null;
};

const groundBucketsOf = () => {
  const buckets = [];

  for (const [key, faces] of groups) {
    const [name, mtl] = key.split("|");

    if (name === "base" || name === "railway" || name === "power") {
      continue;
    }

    if (BUILDING_NAME.test(name) || ROADISH_NAME.test(name)) {
      continue;
    }

    if (mtl === "roads") {
      continue;
    }

    buckets.push({ faces, key, mtl, name });
  }

  return buckets;
};

const groundPolyOf = (
  bucket: { key: any; name: string },
  c: { maxY: number },
  ring: number[][],
) => {
  let r = rdp(ring, 0.4);

  if (r.length < 3) {
    return null;
  }

  if (ringArea(r) < 0) {
    r = r.toReversed();
  }

  const area = Math.abs(ringArea(r));

  if (area < 0.4) {
    return null;
  }

  const per = plLen([...r, r[0]]);
  const [cx, cz] = centroidOf(r);

  return {
    area,
    compact: per > 0 ? (4 * Math.PI * area) / (per * per) : 0,
    cx,
    cz,
    group: bucket.key,
    name: bucket.name,
    ring: r,
    simple: isSimpleRing(r),
    strip: STRIPY_NAME.test(bucket.name),
    y: c.maxY * CAL_SY,
  };
};

const buildGroundPolys = (buckets: { faces: any; key: any; mtl: any; name: any }[]) => {
  const polys = [];
  let comps = 0;
  let ringFail = 0;

  for (const b of buckets) {
    for (const c of components(b.faces)) {
      comps += 1;
      const rings = topRings(c);

      if (rings.length === 0) {
        ringFail += 1;
        continue;
      }

      for (const ring of rings) {
        const poly = groundPolyOf(b, c, ring);

        if (poly) {
          polys.push(poly);
        }
      }
    }
  }

  return { comps, polys, ringFail };
};

const areaPenalty = (pArea: number, wArea: number) => {
  if (pArea > 1 && wArea > 1) {
    return Math.abs(Math.log(wArea / pArea));
  }

  return wArea > 1 || pArea > 1 ? 1.5 : 0;
};

const matchWay = (
  ways: {
    area: number;
    cx: any;
    cz: any;
    id: any;
    len: number;
    name: any;
    ring: any;
    tags: string[];
  }[],
  idx: { near: any },
  p: {
    area: any;
    compact?: number;
    cx: any;
    cz: any;
    group?: any;
    name?: any;
    ring?: any;
    simple?: boolean;
    strip?: boolean;
    y?: number;
  },
  dx: number,
  dz: number,
  radius: number,
) => {
  const x = p.cx - dx;
  const z = p.cz - dz;
  let best = null;
  let bestScore = Infinity;

  for (const i of idx.near(x, z, radius)) {
    const w = ways[i];
    const d = Math.hypot(w.cx - x, w.cz - z);

    if (d > radius) {
      continue;
    }

    const ratio = areaPenalty(p.area, w.area);

    if (p.area > 200 && w.area > 200 && ratio > 0.7) {
      continue;
    }

    if (p.area > 2000 !== w.area > 2000) {
      continue;
    }

    const score = d / radius + ratio;

    if (score < bestScore) {
      bestScore = score;
      best = w;
    }
  }

  return bestScore < 1.2 ? best : null;
};

const median = (a: string | any[]) => [...a].toSorted((x, y) => x - y)[Math.floor(a.length / 2)];

const measureOsmOffset = (
  polys: {
    area: number;
    compact: number;
    cx: number | undefined;
    cz: number | undefined;
    group: any;
    name: any;
    ring: any;
    simple: boolean;
    strip: boolean;
    y: number;
  }[],
  ways: {
    area: number;
    cx: any;
    cz: any;
    id: any;
    len: number;
    name: any;
    ring: any;
    tags: string[];
  }[],
  idx: { near(x: any, z: any, r: any): any[] },
) => {
  let dx = 0;
  let dz = 0;

  for (let pass = 0; pass < 2; pass += 1) {
    const ex = [];
    const ez = [];

    for (const p of polys) {
      const w = matchWay(ways, idx, p, dx, dz, 45);

      if (!w) {
        continue;
      }

      ex.push(p.cx - dx - w.cx);
      ez.push(p.cz - dz - w.cz);
    }

    if (ex.length < 20) {
      break;
    }

    dx += median(ex);
    dz += median(ez);
  }

  return { dx, dz };
};

const voteGroups = (
  polys: {
    area: number;
    compact: number;
    cx: number | undefined;
    cz: number | undefined;
    group: any;
    name: any;
    ring: any;
    simple: boolean;
    strip: boolean;
    y: number;
  }[],
) => {
  const groupInfo = new Map();

  for (const p of polys) {
    let g = groupInfo.get(p.group);

    if (!g) {
      g = { area: 0, group: p.group, matched: 0, polys: 0, votes: new Map() };
      groupInfo.set(p.group, g);
    }

    g.polys += 1;
    g.area += p.area;

    if (!p.tags) {
      continue;
    }

    g.matched += 1;

    for (const t of p.tags) {
      g.votes.set(t, (g.votes.get(t) ?? 0) + 1);
    }
  }

  const decoded = [];

  for (const g of groupInfo.values()) {
    const ranked = [...g.votes.entries()].toSorted((a, b) => b[1] - a[1]);
    const [top] = ranked;
    const conf = top ? top[1] / Math.max(1, g.matched) : 0;
    const hint = nameHint(g.group.split("|")[0]);
    decoded.push({
      areaU2: Math.round(g.area),
      confidence: +conf.toFixed(3),
      decoded: top?.[0] ?? null,
      group: g.group,
      hintAgrees: hint ? hint.candidates.some((c: any) => top?.[0]?.endsWith(`=${c}`)) : null,
      matchRate: +(g.matched / g.polys).toFixed(3),
      matched: g.matched,
      nameHint: hint?.candidates ?? null,
      polygons: g.polys,
      runnersUp: ranked.slice(1, 5).map(([t, n]) => `${t} x${n}`),
      tagSpectrum: ranked.slice(0, 8).map(([t, n]) => `${t} x${n}`),
    });
  }

  decoded.sort((a, b) => b.areaU2 - a.areaU2);

  return decoded;
};

const assignPolyClasses = (
  polys: {
    area: number;
    compact: number;
    cx: number | undefined;
    cz: number | undefined;
    group: any;
    name: any;
    ring: any;
    simple: boolean;
    strip: boolean;
    y: number;
  }[],
  decoded: {
    areaU2: number;
    confidence: number;
    decoded: any;
    group: any;
    hintAgrees: any;
    matchRate: number;
    matched: any;
    nameHint: any;
    polygons: any;
    runnersUp: string[];
    tagSpectrum: string[];
  }[],
) => {
  const groupVerdict = new Map(
    decoded
      .filter((d: { confidence: number }) => d.confidence >= 0.5)
      .map((d: { group: any; decoded: any }) => [d.group, d.decoded]),
  );

  for (const p of polys) {
    const own = p.tags?.map((t: any) => classFor(t)).find(Boolean);
    const grp = classFor(groupVerdict.get(p.group) ?? "");
    const cls = own ?? grp;
    p.cls = cls?.[0] ?? null;
    p.rank = cls?.[1] ?? 0;
    p.tag = p.tags?.find((t: any) => classFor(t)) ?? groupVerdict.get(p.group) ?? null;
    p.fromGroupVote = !own && !!grp;
  }
};

const DISTRICT_MIN = 20_000;
const isDistrict = (p: {
  area: any;
  compact?: number;
  cx?: number | undefined;
  cz?: number | undefined;
  group?: any;
  name: any;
  ring?: any;
  simple?: boolean;
  strip?: boolean;
  y?: number;
}) => p.area >= DISTRICT_MIN || p.name === "boundary";

const districtRings = (polys: any[]) =>
  polys
    .filter((p: any) => isDistrict(p))
    .map(
      (p: {
        area: number;
        group: any;
        tags: any[];
        osmName: any;
        ring: [any, any][];
        cx: any;
        cz: any;
      }) => ({
        areaKm2: +((p.area * M_PER_U * M_PER_U) / 1e6).toFixed(2),
        areaU2: Math.round(p.area),
        group: p.group,
        matchedOsm: !!p.tags,
        name: p.osmName ?? null,
        ring: p.ring.flatMap(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]),
        tag: p.tags?.[0] ?? null,
        u: +toU(p.cx).toFixed(4),
        v: +toV(p.cz).toFixed(4),
      }),
    )
    .toSorted((a: { areaU2: number }, b: { areaU2: number }) => b.areaU2 - a.areaU2);

const OBJ_BOX = { u0: 0.43, u1: 0.89, v0: -0.07, v1: 0.49 };

const coverageOf = (grid: {
  classes?: any[];
  classified?: number;
  cols: any;
  histogram?: [any, any][];
  gridX?: number;
  gridZ?: number;
  note?: string;
}) => {
  let inBox = 0;
  let inBoxCls = 0;
  let outBox = 0;
  let outBoxCls = 0;
  let land = 0;
  let landCls = 0;

  for (let gx = 0; gx < GRID_X; gx += 1) {
    for (let gz = 0; gz < GRID_Z; gz += 1) {
      const u = (gx + 0.5) / GRID_X;
      const v = (gz + 0.5) / GRID_Z;
      const has = Number.parseInt(grid.cols[gx].slice(gz * 2, gz * 2 + 2), 16) > 0;

      if (onLandUV(u, v)) {
        land += 1;

        if (has) {
          landCls += 1;
        }
      }

      if (u >= OBJ_BOX.u0 && u <= OBJ_BOX.u1 && v >= OBJ_BOX.v0 && v <= OBJ_BOX.v1) {
        inBox += 1;

        if (has) {
          inBoxCls += 1;
        }
      } else {
        outBox += 1;

        if (has) {
          outBoxCls += 1;
        }
      }
    }
  }

  return {
    insideObjFootprint: {
      cells: inBox,
      classified: inBoxCls,
      pct: +((inBoxCls / inBox) * 100).toFixed(1),
    },
    landCells: { cells: land, classified: landCls, pct: +((landCls / land) * 100).toFixed(1) },
    objFootprint: OBJ_BOX,
    outsideObjFootprint: {
      cells: outBox,
      classified: outBoxCls,
      pct: +((outBoxCls / outBox) * 100).toFixed(1),
    },
  };
};

const main = () => {
  const ways = loadOsm();
  const idx = indexWays(ways);

  const groundBuckets = groundBucketsOf();
  const { comps, polys, ringFail } = buildGroundPolys(groundBuckets);
  const nonSimple = polys.filter((p) => !p.simple).length;
  console.log(
    `ground: ${groundBuckets.length} buckets, ${comps} welded components -> ${polys.length} rings ` +
      `(${ringFail} components yielded no boundary loop; ${nonSimple} rings self-intersect and are ` +
      `kept out of the raster)`,
  );

  const { dx, dz } = measureOsmOffset(polys, ways, idx);
  console.log(
    `OBJ↔OSM systematic offset: dx=${dx.toFixed(2)}u dz=${dz.toFixed(2)}u ` +
      `(${(Math.hypot(dx, dz) * M_PER_U).toFixed(1)} m) — removed before matching`,
  );

  let matched = 0;

  for (const p of polys) {
    const w = matchWay(ways, idx, p, dx, dz, 45);

    if (w) {
      matched += 1;
      p.tags = w.tags;
      p.osmName = w.name;
      p.dist = Math.hypot(p.cx - dx - w.cx, p.cz - dz - w.cz);
    }
  }

  console.log(
    `decode: ${matched}/${polys.length} polygons matched an OSM way (${((matched / polys.length) * 100).toFixed(1)}%)`,
  );

  const decoded = voteGroups(polys);
  assignPolyClasses(polys, decoded);
  const districts = districtRings(polys);

  for (const p of polys) {
    if (isDistrict(p)) {
      p.cls = null;
    }
  }

  const massing = analyseMassing();

  const infra = analyseInfra(ways, idx, dx, dz);

  const objInput = polys
    .filter((p) => p.cls && p.simple && !p.strip && p.compact >= 0.12)
    .map((p) => ({ cls: p.cls, ring: p.ring }));

  const objGrid = rasteriseAreas(objInput, 0.06);

  const osmInput = [];

  for (const w of ways) {
    if (!w.ring) {
      continue;
    }

    const cls = w.tags.map((t) => classFor(t)).find(Boolean);

    if (cls && w.area < 20_000) {
      osmInput.push({ cls: cls[0], ring: w.ring });
    }
  }

  const osmGrid = rasteriseAreas(osmInput, 0.06);

  const grid = {
    gridX: GRID_X,
    gridZ: GRID_Z,
    note: "Union of the OBJ-decoded polygons and the Overpass pull. THIS is the raster the game should ship.",
    ...rasteriseAreas([...osmInput, ...objInput], 0.06),
  };

  const coverage = coverageOf(grid);
  const { classified: landCls, cells: land } = coverage.landCells;
  const { classified: inBoxCls, cells: inBox } = coverage.insideObjFootprint;
  const { classified: outBoxCls, cells: outBox } = coverage.outsideObjFootprint;
  console.log(
    `raster: OBJ polygons alone classify ${objGrid.classified}/48800 cells; ` +
      `a straight Overpass pull classifies ${osmGrid.classified}/48800; ` +
      `union ${grid.classified}/48800 (${((grid.classified / 48_800) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  LAND cells only: ${landCls}/${land} (${coverage.landCells.pct}%). ` +
      `Inside the OBJ footprint (u ${OBJ_BOX.u0}-${OBJ_BOX.u1}, v ${OBJ_BOX.v0}-${OBJ_BOX.v1}): ` +
      `${inBoxCls}/${inBox} (${coverage.insideObjFootprint.pct}%); outside: ${outBoxCls}/${outBox} ` +
      `(${coverage.outsideObjFootprint.pct}%)`,
  );

  const emitPolys = polys
    .filter((p) => p.cls || p.strip)
    .map((p) => ({
      a: Math.round(p.area),
      cls: p.cls,
      grp: p.group,
      name: p.osmName ?? undefined,
      r: p.ring.flatMap(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]),
      selfIntersects: p.simple ? undefined : 1,
      strip: p.strip || p.compact < 0.12 ? 1 : undefined,
      tag: p.tag,
    }));

  const out = {
    grid: { ...grid, coverage },
    infrastructure: infra,
    landuse: {
      districts,
      groups: decoded,
      polygonCount: emitPolys.length,
      polygons: emitPolys,
    },
    massing,
    meta: {
      cal: CAL,
      calSY: CAL_SY,
      generator: "tools/sf-data/extract-landuse-obj.mts",
      metresPerUnit: M_PER_U,
      note: "u = x/3172+0.5, v = z/2600+0.5. Lower v = north.",
      objBuckets: groups.size,
      objObjects: objLines,
      objVerts: vx.length,
      osmOffset: { dx: +dx.toFixed(2), dz: +dz.toFixed(2) },
      source: objPath,
      world: { gridX: GRID_X, gridZ: GRID_Z, h: WORLD_H, w: WORLD_W },
    },
    objOnlyGrid: {
      classes: objGrid.classes,
      classified: objGrid.classified,
      histogram: objGrid.histogram,
      note: "OBJ-decoded polygons only — what the licensed model can supply on its own.",
    },
    osmGrid: {
      classes: osmGrid.classes,
      classified: osmGrid.classified,
      histogram: osmGrid.histogram,
      note: "Same rasteriser, fed straight from the Overpass dumps instead of the OBJ — the coverage baseline the OBJ layer has to beat, and loses to.",
    },
    renderPlan: RENDER_PLAN,
  };

  writeFileSync(outPath, JSON.stringify(out));
  console.log(`wrote ${outPath} (${(JSON.stringify(out).length / 1e6).toFixed(2)} MB)`);

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

  for (const d of districts) {
    console.log(
      `${String(d.name ?? d.tag ?? "(no OSM match)").padEnd(28)} ${String(d.areaKm2).padStart(6)} km²  ` +
        `u=${d.u} v=${d.v}  from ${d.group}`,
    );
  }

  console.log("\n=== GRID CLASS HISTOGRAM (244x200 = 48800 cells) ===");
  const objH = new Map(objGrid.histogram);
  const osmH = new Map(osmGrid.histogram);
  const unionH = new Map(grid.histogram);

  for (const [cls, n] of grid.histogram) {
    console.log(
      `${cls.padEnd(14)} union ${String(n).padStart(6)} (${((n / 48_800) * 100).toFixed(2)}%)` +
        `   obj ${String(objH.get(cls) ?? 0).padStart(6)}   osm ${String(osmH.get(cls) ?? 0).padStart(6)}`,
    );
  }

  for (const [cls, n] of osmGrid.histogram) {
    if (!unionH.has(cls)) {
      console.log(`${cls.padEnd(14)} union      0   obj      0   osm ${n}`);
    }
  }

  console.log("\n=== MASSING ===");
  console.log(massing.summary.join("\n"));
  console.log("\n=== INFRASTRUCTURE ===");
  console.log(infra.summary.join("\n"));
};

const levelsOf = (c: { faces: any; minY: number }) => {
  const lv = new Map();

  for (const f of c.faces) {
    for (const id of f) {
      const b = Math.round(vy[id] * 2) / 2;
      let e = lv.get(b);

      if (!e) {
        e = { maxX: -1e9, maxZ: -1e9, minX: 1e9, minZ: 1e9, n: 0 };
        lv.set(b, e);
      }

      e.n += 1;

      if (vx[id] < e.minX) {
        e.minX = vx[id];
      }

      if (vx[id] > e.maxX) {
        e.maxX = vx[id];
      }

      if (vz[id] < e.minZ) {
        e.minZ = vz[id];
      }

      if (vz[id] > e.maxZ) {
        e.maxZ = vz[id];
      }
    }
  }

  return [...lv.entries()]
    .filter(([, e]) => e.n >= 3)
    .toSorted((a, b) => a[0] - b[0])
    .map(([y, e]) => ({
      area: +((e.maxX - e.minX) * CAL.sx * ((e.maxZ - e.minZ) * CAL.sz)).toFixed(1),
      h: +((y - c.minY) * CAL_SY).toFixed(2),
      n: e.n,
    }));
};

const bandExtent = (c: { maxY: number; minY: number; faces: any }, lo: number, hi: number) => {
  const ext = c.maxY - c.minY;
  let x0 = 1e9;
  let x1 = -1e9;
  let z0 = 1e9;
  let z1 = -1e9;
  let n = 0;

  for (const f of c.faces) {
    for (const id of f) {
      const t = ext > 0 ? (vy[id] - c.minY) / ext : 0;

      if (t < lo || t > hi) {
        continue;
      }

      n += 1;

      if (vx[id] < x0) {
        x0 = vx[id];
      }

      if (vx[id] > x1) {
        x1 = vx[id];
      }

      if (vz[id] < z0) {
        z0 = vz[id];
      }

      if (vz[id] > z1) {
        z1 = vz[id];
      }
    }
  }

  return n === 0 ? 0 : (x1 - x0) * CAL.sx * ((z1 - z0) * CAL.sz);
};

const massingOf = (
  key: any,
  c: { minY: number; maxY: number; minX: any; maxX: any; minZ: any; maxZ: any },
  w: number,
  d: number,
) => {
  const lowA = bandExtent(c, 0, 0.25);
  const highA = bandExtent(c, 0.75, 1);

  return {
    base: +(c.minY * CAL_SY).toFixed(2),
    bboxArea: +(w * d).toFixed(1),
    group: key,
    h: +((c.maxY - c.minY) * CAL_SY).toFixed(2),
    levels: levelsOf(c),
    taper: lowA > 0 ? +(highA / lowA).toFixed(3) : 1,
    wx: +toWorldX((c.minX + c.maxX) / 2).toFixed(1),
    wz: +toWorldZ((c.minZ + c.maxZ) / 2).toFixed(1),
    x: +((c.minX + c.maxX) / 2).toFixed(1),
    z: +((c.minZ + c.maxZ) / 2).toFixed(1),
  };
};

const analyseMassing = () => {
  const comps: never[] = [];

  for (const [key, faces] of groups) {
    const [name, mtl] = key.split("|");

    if (mtl !== "building" || !BUILDING_NAME.test(name)) {
      continue;
    }

    for (const c of components(faces)) {
      const w = (c.maxX - c.minX) * CAL.sx;
      const d = (c.maxZ - c.minZ) * CAL.sz;

      if (w < 3 * CAL.sx || d < 3 * CAL.sz) {
        continue;
      }

      if (w > 900 * CAL.sx || d > 900 * CAL.sz) {
        continue;
      }

      comps.push(massingOf(key, c, w, d));
    }
  }

  comps.sort((a, b) => b.h - a.h);

  const hs = comps.map((c) => c.h).toSorted((a, b) => a - b);
  const q = (t: number) => hs[Math.min(hs.length - 1, Math.floor(hs.length * t))];
  const hist = new Map();

  for (const h of hs) {
    hist.set(Math.floor(h), (hist.get(Math.floor(h)) ?? 0) + 1);
  }

  const histogram = [...hist.entries()].toSorted((a, b) => a[0] - b[0]);

  const distinct = new Set(hs.map((h) => h.toFixed(2)));

  const BANDS = [
    ["<1u  (<4.4m)", (c: { h: number }) => c.h < 1],
    ["1-2u (4-9m)", (c: { h: number }) => c.h >= 1 && c.h < 2],
    ["2-4u (9-18m)", (c: { h: number }) => c.h >= 2 && c.h < 4],
    ["4-9u (18-40m)", (c: { h: number }) => c.h >= 4 && c.h < 9],
    ["9-20u (40-89m)", (c: { h: number }) => c.h >= 9 && c.h < 20],
    ["20-40u (89-178m)", (c: { h: number }) => c.h >= 20 && c.h < 40],
    [">=40u (>=178m)", (c: { h: number }) => c.h >= 40],
  ];

  const bandStats = BANDS.map(([label, test]) => {
    const set = comps.filter(test);
    const prisms = set.filter((c) => c.levels.length <= 2).length;
    const tapered = set.filter((c) => c.taper < 0.8).length;
    const taperSorted = set.map((c) => c.taper).toSorted((a, b) => a - b);
    const medTaper = set.length ? taperSorted[Math.floor(set.length / 2)].toFixed(2) : "-";

    return {
      band: label,
      flatPrismPct: set.length ? +((prisms / set.length) * 100).toFixed(1) : 0,
      flatPrisms: prisms,
      medianTaper: +medTaper,
      n: set.length,
      pctOfCity: +((set.length / comps.length) * 100).toFixed(2),
      taperedBelow80pct: tapered,
    };
  });

  const tiers = { 2: 0, 3: 0, 4: 0, "5+": 0 };
  const setbacks: never[] = [];

  for (const c of comps) {
    const n = c.levels.length;

    if (n <= 2) {
      tiers[2] += 1;
    } else if (n === 3) {
      tiers[3] += 1;
    } else if (n === 4) {
      tiers[4] += 1;
    } else {
      tiers["5+"] += 1;
    }

    if (n >= 3 && c.taper < 0.8) {
      setbacks.push(c);
    }
  }

  const hCount = new Map();

  for (const c of comps) {
    hCount.set(c.h, (hCount.get(c.h) ?? 0) + 1);
  }

  const modalHeights = [...hCount.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([h, n]) => ({ h, m: +(h * M_PER_U).toFixed(1), n }));

  const tall = comps.filter((c) => c.h >= 9);
  const towers = comps.filter((c) => c.h >= 20);

  const fidi = towers.filter((c) => {
    const u = toU(c.wx);
    const v = toV(c.wz);

    return u > 0.66 && u < 0.8 && v > 0.12 && v < 0.27;
  });

  const summary = [
    `components: ${comps.length}`,
    `height (world u, 1u = ${M_PER_U} m): min ${hs[0].toFixed(2)} p25 ${q(0.25).toFixed(2)} p50 ${q(0.5).toFixed(2)} p75 ${q(0.75).toFixed(2)} p90 ${q(0.9).toFixed(2)} p99 ${q(0.99).toFixed(2)} max ${hs.at(-1).toFixed(2)}`,
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
    bandStats,
    componentCount: comps.length,
    distinctHeightValues: distinct.size,
    fidiCluster: {
      count: fidi.length,
      note: "h>=20u components inside u .66-.80 / v .12-.27. [u, v, height(u), taper, bboxArea(u²)]",
      towers: fidi
        .toSorted((a, b) => b.h - a.h)
        .map((c) => [
          +toU(c.wx).toFixed(4),
          +toV(c.wz).toFixed(4),
          c.h,
          c.taper,
          Math.round(c.bboxArea),
        ]),
    },
    heightHistogram: histogram,
    heightQuantiles: {
      max: hs.at(-1),
      min: hs[0],
      p10: q(0.1),
      p25: q(0.25),
      p50: q(0.5),
      p75: q(0.75),
      p90: q(0.9),
      p99: q(0.99),
    },
    levelHistogram: tiers,
    modalHeights,
    setbackCount: setbacks.length,
    setbackSamples: setbacks
      .toSorted((a, b) => b.h - a.h)
      .slice(0, 40)
      .map((c) => ({
        h: c.h,
        levels: c.levels,
        taper: c.taper,
        u: +toU(c.wx).toFixed(4),
        v: +toV(c.wz).toFixed(4),
        wx: c.wx,
        wz: c.wz,
      })),
    summary,
    tallest: comps.slice(0, 150).map((c) => ({
      bboxArea: c.bboxArea,
      group: c.group,
      h: c.h,
      levels: c.levels.length,
      m: +(c.h * M_PER_U).toFixed(0),
      taper: c.taper,
      u: +toU(c.wx).toFixed(4),
      v: +toV(c.wz).toFixed(4),
      wx: c.wx,
      wz: c.wz,
    })),
  };
};

const nearestInfraWay = (
  ways: { [x: string]: any },
  idx: { near: (arg0: number, arg1: number, arg2: number) => any },
  which: any,
  cx: number,
  cz: number,
  dx: number,
  dz: number | undefined,
) => {
  let best = null;
  let bd = 60;

  for (const i of idx.near(cx - dx, cz - dz, 60)) {
    const wobj = ways[i];

    if (!wobj.tags.some((t: string) => t.startsWith(`${which}=`))) {
      continue;
    }

    const dd = Math.hypot(wobj.cx - (cx - dx), wobj.cz - (cz - dz));

    if (dd < bd) {
      bd = dd;
      best = wobj;
    }
  }

  return best;
};

const infraItemOf = (
  which: string,
  key: any,
  c: { maxX: number; minX: number; maxZ: number; minZ: number; maxY: number; minY: number },
  ways: any,
  idx: any,
  dx: any,
  dz: any,
) => {
  const [ring] = topRings(c).toSorted((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
  const w = (c.maxX - c.minX) * CAL.sx;
  const d = (c.maxZ - c.minZ) * CAL.sz;
  const r = ring ? rdp(ring, 0.5) : null;
  const area = r ? Math.abs(ringArea(r)) : 0;
  const per = r ? plLen([...r, r[0]]) : 0;
  const best = r ? nearestInfraWay(ways, idx, which, ...centroidOf(r), dx, dz) : null;

  return {
    area: +area.toFixed(1),
    compact: +(per > 0 ? (4 * Math.PI * area) / (per * per) : 0).toFixed(3),
    key,
    name: best?.name ?? null,
    ring: r ? r.flatMap(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]) : null,
    span: +Math.max(w, d).toFixed(1),
    tag: best?.tags.find((t: string) => t.startsWith(`${which}=`)) ?? null,
    thin: +Math.min(w, d).toFixed(1),
    u: +toU(toWorldX((c.minX + c.maxX) / 2)).toFixed(4),
    v: +toV(toWorldZ((c.minZ + c.maxZ) / 2)).toFixed(4),
    wx: +toWorldX((c.minX + c.maxX) / 2).toFixed(1),
    wz: +toWorldZ((c.minZ + c.maxZ) / 2).toFixed(1),
    yMax: +(c.maxY * CAL_SY).toFixed(2),
    yMin: +(c.minY * CAL_SY).toFixed(2),
  };
};

const analyseInfra = (
  ways: {
    area: number;
    cx: any;
    cz: any;
    id: any;
    len: number;
    name: any;
    ring: any;
    tags: string[];
  }[],
  idx: { near(x: any, z: any, r: any): any[] },
  dx: number,
  dz: number,
) => {
  const out = { summary: [] };

  for (const which of ["power", "railway"]) {
    const buckets = [...groups.entries()].filter(([k]) => k.split("|")[0] === which);
    const items = [];

    for (const [key, faces] of buckets) {
      for (const c of components(faces)) {
        items.push(infraItemOf(which, key, c, ways, idx, dx, dz));
      }
    }

    const lines = items.filter((i) => i.compact < 0.15 && i.span > 8);
    const areas = items.filter((i) => !(i.compact < 0.15 && i.span > 8));
    const tagHist = new Map();

    for (const i of items) {
      if (i.tag) {
        tagHist.set(i.tag, (tagHist.get(i.tag) ?? 0) + 1);
      }
    }

    const yMin = Math.min(...items.map((i) => i.yMin));
    const yMax = Math.max(...items.map((i) => i.yMax));
    out[which] = {
      areaLike: areas.length,
      components: items.length,
      items: items.toSorted((a, b) => b.span - a.span).slice(0, 200),
      lineLike: lines.length,
      osmTags: [...tagHist.entries()].toSorted((a, b) => b[1] - a[1]),
      totalAreaU2: +areas.reduce((s, i) => s + i.area, 0).toFixed(0),
      totalLineSpanU: +lines.reduce((s, i) => s + i.span, 0).toFixed(0),
      yRangeM: [+(yMin * M_PER_U).toFixed(1), +(yMax * M_PER_U).toFixed(1)],
      yRangeU: [yMin, yMax],
    };
    const avail = new Map();

    for (const w of ways) {
      for (const t of w.tags) {
        if (t.startsWith(`${which}=`)) {
          avail.set(t, (avail.get(t) ?? 0) + 1);
        }
      }
    }

    out[which].osmAvailableNotInObj = [...avail.entries()].toSorted((a, b) => b[1] - a[1]);
    out.summary.push(
      `${which}: ${items.length} components — ${lines.length} line-like, ${areas.length} area-like; ` +
        `y ${yMin.toFixed(2)}..${yMax.toFixed(2)}u (${(yMin * M_PER_U).toFixed(1)}..${(yMax * M_PER_U).toFixed(1)} m); ` +
        `OSM tags: ${[...tagHist.entries()]
          .toSorted((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([t, n]) => `${t} x${n}`)
          .join(", ")}`,
      `  OSM has, in the same bbox: ${[...avail.entries()]
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([t, n]) => `${t} x${n}`)
        .join(", ")}`,
    );
  }

  return out;
};

const CELL_W = WORLD_W / GRID_X;
const CELL_H = WORLD_H / GRID_Z;
const CELL_AREA = CELL_W * CELL_H;

const inRing = (ring: string | any[], px: number, pz: number) => {
  let inside = false;
  let j = ring.length - 1;

  for (let i = 0; i < ring.length; i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];

    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }

    j = i;
  }

  return inside;
};

const STEP = 1.5;

const ringBounds = (ring: any) => {
  let minX = 1e9;
  let maxX = -1e9;
  let minZ = 1e9;
  let maxZ = -1e9;

  for (const [x, z] of ring) {
    if (x < minX) {
      minX = x;
    }

    if (x > maxX) {
      maxX = x;
    }

    if (z < minZ) {
      minZ = z;
    }

    if (z > maxZ) {
      maxZ = z;
    }
  }

  return { maxX, maxZ, minX, minZ };
};

const accumulateCoverage = (acc: Map<any, any>, p: { ring: any; cls: any }) => {
  const { maxX, maxZ, minX, minZ } = ringBounds(p.ring);
  const w = STEP * STEP;

  for (let x = minX + STEP / 2; x < maxX; x += STEP) {
    for (let z = minZ + STEP / 2; z < maxZ; z += STEP) {
      if (!inRing(p.ring, x, z)) {
        continue;
      }

      const gx = Math.floor((x + WORLD_W / 2) / CELL_W);
      const gz = Math.floor((z + WORLD_H / 2) / CELL_H);

      if (gx < 0 || gx >= GRID_X || gz < 0 || gz >= GRID_Z) {
        continue;
      }

      const k = gx * GRID_Z + gz;
      let m = acc.get(k);

      if (!m) {
        m = new Map();
        acc.set(k, m);
      }

      m.set(p.cls, (m.get(p.cls) ?? 0) + w);
    }
  }
};

const RANK_OF = new Map(Object.values(CLASS_OF).map(([c, r]) => [c, r]));

const bestClassOf = (m: any) => {
  let bestC = null;
  let bestA = 0;
  let total = 0;

  for (const [c, a] of m) {
    total += a;

    if (a > bestA || (a === bestA && (RANK_OF.get(c) ?? 0) > (RANK_OF.get(bestC) ?? 0))) {
      bestA = a;
      bestC = c;
    }
  }

  return { bestA, bestC, total };
};

const rasteriseAreas = (items: { cls: any; ring: any }[], minFill: number) => {
  const acc = new Map();

  for (const p of items) {
    accumulateCoverage(acc, p);
  }

  const classes: any[] = [];
  const classId = new Map();

  const idOf = (c: any) => {
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

  for (const [k, m] of acc) {
    const { bestA, bestC, total } = bestClassOf(m);
    fill[k] = total / CELL_AREA;

    if (bestC && bestA / CELL_AREA >= minFill) {
      cell[k] = idOf(bestC);
    }
  }

  const counts = new Map();

  for (const v of cell) {
    const c = v < 0 ? "unclassified" : classes[v];
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }

  const cols = [];

  for (let gx = 0; gx < GRID_X; gx += 1) {
    let s = "";

    for (let gz = 0; gz < GRID_Z; gz += 1) {
      s += (cell[gx * GRID_Z + gz] + 1).toString(16).padStart(2, "0");
    }

    cols.push(s);
  }

  return {
    classes,
    classified: cell.reduce((s, v) => s + (v >= 0 ? 1 : 0), 0),
    cols,
    histogram: [...counts.entries()].toSorted((a, b) => b[1] - a[1]),
  };
};

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
  "  * man_made=pier -> already handled by bake-piers.mts; use these only to cross-check.",
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
