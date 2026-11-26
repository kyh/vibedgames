import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { at, rdp, ringArea, WORLD_H, WORLD_W } from "./lib.mts";
import type { Point } from "./lib.mts";

const [objPath] = process.argv.slice(2);

if (objPath === undefined || objPath === "") {
  console.error("usage: node extract-footprints.mts <obj>");
  process.exit(1);
}

const ROAD_RE =
  /^highway_(?:motorway|trunk|primary|secondary|tertiary|residential|unclassified)(?:_link)?(?:_|$)/u;

interface Comp {
  faces: number[][];
  maxX: number;
  maxY: number;
  maxZ: number;
  minX: number;
  minY: number;
  minZ: number;
}

interface Building {
  cx: number;
  cz: number;
  d: number;
  h: number;
  outline: Point[] | null;
  w: number;
}

const vx: number[] = [];
const vy: number[] = [];
const vz: number[] = [];
let curGroup: string | null = null;
let curMtl = "";
const buildingGroups = new Map<string, number[][]>();
const roadVerts: Point[] = [];
let roadVertBudget = 0;

const rl = createInterface({ crlfDelay: Infinity, input: createReadStream(objPath) });

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
  } else if (c0 === 102) {
    if (curGroup === null || curGroup === "") {
      return;
    }

    const isRoad = ROAD_RE.test(curGroup);
    const isBuilding = curMtl === "building";

    if (!isRoad && !isBuilding) {
      return;
    }

    const ids: number[] = [];

    for (const part of l.slice(2).trim().split(/\s+/u)) {
      const s = part.includes("/") ? part.slice(0, part.indexOf("/")) : part;
      let id = Number(s);

      if (id < 0) {
        id = vx.length + 1 + id;
      }

      ids.push(id - 1);
    }

    if (isBuilding) {
      let g = buildingGroups.get(curGroup);

      if (g === undefined) {
        g = [];
        buildingGroups.set(curGroup, g);
      }

      g.push(ids);
    } else {
      const keep = roadVertBudget % 3 === 0;
      roadVertBudget += 1;

      if (keep) {
        for (const id of ids) {
          roadVerts.push([at(vx, id), at(vz, id)]);
        }
      }
    }
  } else if (l.startsWith("g ") || l.startsWith("o ")) {
    curGroup = l.slice(2).trim();
  } else if (l.startsWith("usemtl")) {
    curMtl = l.slice(7).trim();
  }
});

rl.on("close", () => {
  const buildings: Building[] = [];

  for (const [, faces] of buildingGroups) {
    const parent = new Map<number, number>();
    const parentOf = (x: number) => parent.get(x) ?? x;

    const find = (start: number) => {
      let r = start;

      while (parentOf(r) !== r) {
        r = parentOf(r);
      }

      let a = start;

      while (parentOf(a) !== r) {
        const next = parentOf(a);
        parent.set(a, r);
        a = next;
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
      for (let i = 1; i < f.length; i += 1) {
        union(at(f, 0), at(f, i));
      }
    }

    const comps = new Map<number, Comp>();

    for (const f of faces) {
      const root = find(at(f, 0));
      let c = comps.get(root);

      if (c === undefined) {
        c = {
          faces: [],
          maxX: -1e9,
          maxY: -1e9,
          maxZ: -1e9,
          minX: 1e9,
          minY: 1e9,
          minZ: 1e9,
        };
        comps.set(root, c);
      }

      c.faces.push(f);

      for (const id of f) {
        const x = at(vx, id);
        const y = at(vy, id);
        const z = at(vz, id);

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

    for (const c of comps.values()) {
      const w = c.maxX - c.minX;
      const d = c.maxZ - c.minZ;

      if (w < 3 || d < 3) {
        continue;
      }

      buildings.push({
        cx: (c.minX + c.maxX) / 2,
        cz: (c.minZ + c.maxZ) / 2,
        d,
        h: c.maxY - c.minY,
        outline: roofOutline(c),
        w,
      });
    }
  }

  console.log(`components: ${buildings.length} (${buildingGroups.size} tag groups)`);
  const withOutline = buildings.filter((b) => b.outline !== null).length;
  console.log(
    `roof outlines recovered: ${withOutline} (${((withOutline / buildings.length) * 100).toFixed(1)}%)`,
  );

  calibrateAndEmit(buildings);
});

const boundaryNext = (faces: readonly (readonly number[])[]) => {
  const edgeCount = new Map<string, number>();
  const edgeDir = new Map<string, Point>();

  for (const f of faces) {
    for (let i = 0; i < f.length; i += 1) {
      const a = at(f, i);
      const b = at(f, (i + 1) % f.length);

      if (a === b) {
        continue;
      }

      const k = a < b ? `${a},${b}` : `${b},${a}`;
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);

      if (!edgeDir.has(k)) {
        edgeDir.set(k, [a, b]);
      }
    }
  }

  const next = new Map<number, number>();

  for (const [k, n] of edgeCount) {
    if (n !== 1) {
      continue;
    }

    const dir = edgeDir.get(k);

    if (dir !== undefined) {
      next.set(dir[0], dir[1]);
    }
  }

  return next;
};

const largestLoop = (next: ReadonlyMap<number, number>) => {
  const seen = new Set<number>();
  let best: number[] | null = null;

  for (const start of next.keys()) {
    if (seen.has(start)) {
      continue;
    }

    const loop: number[] = [];
    let cur: number | undefined = start;

    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      loop.push(cur);
      cur = next.get(cur);
    }

    if (cur === start && loop.length >= 3 && (best === null || loop.length > best.length)) {
      best = loop;
    }
  }

  return best;
};

const roofOutline = (c: Comp) => {
  const topFaces = c.faces.filter((f) => f.every((id) => at(vy, id) >= c.maxY - 0.75));

  if (topFaces.length === 0) {
    return null;
  }

  const next = boundaryNext(topFaces);

  if (next.size < 3) {
    return null;
  }

  const best = largestLoop(next);

  if (best === null) {
    return null;
  }

  const pts = best.map<Point>((id) => [at(vx, id), at(vz, id)]);
  const area = Math.abs(ringArea(pts));

  if (area < 0.45 * (c.maxX - c.minX) * (c.maxZ - c.minZ)) {
    return null;
  }

  return pts;
};

const CAL = { bx: 325.2, bz: -400.5, sx: 0.17829, sz: 0.17909 };
const CAL_SY = 1 / (1.598 * 4.446);

const ANCHORS: readonly (readonly [string, number, number, number, number])[] = [
  ["Salesforce", 2458.4, -2088.9, 760, -770.1],
  ["Transamerica", 1809.9, -2842.1, 644.9, -907.7],
];

const toWorld: (p: Point) => Point = ([x, z]) => [x * CAL.sx + CAL.bx, z * CAL.sz + CAL.bz];

const bboxRing: (b: Building) => Point[] = (b) => [
  [b.cx - b.w / 2, b.cz - b.d / 2],
  [b.cx + b.w / 2, b.cz - b.d / 2],
  [b.cx + b.w / 2, b.cz + b.d / 2],
  [b.cx - b.w / 2, b.cz + b.d / 2],
];

const worldRing = (ring: readonly Point[]) => {
  let world = ring.map(toWorld);

  if (ringArea(world) < 0) {
    world = world.toReversed();
  }

  world = rdp(world, 0.3);

  if (world.length < 3 || world.length > 64) {
    return null;
  }

  if (Math.abs(ringArea(world)) < 5) {
    return null;
  }

  for (const [x, z] of world) {
    if (Math.abs(x) > WORLD_W / 2 || Math.abs(z) > WORLD_H / 2) {
      return null;
    }
  }

  return world;
};

const percentile = (arr: readonly number[], t: number) =>
  at(
    arr.toSorted((a, b) => a - b),
    Math.floor(arr.length * t),
  );

const calibrateAndEmit = (buildings: readonly Building[]) => {
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

  const out: number[][] = [];
  let fromBbox = 0;

  for (const b of buildings) {
    if (b.w > 900 || b.d > 900) {
      continue;
    }

    const h = b.h * CAL_SY;

    if (h < 1 || h > 130) {
      continue;
    }

    if (b.outline === null) {
      fromBbox += 1;
    }

    const world = worldRing(b.outline ?? bboxRing(b));

    if (world === null) {
      continue;
    }

    const flat = [Math.round(h * 10) / 10];

    for (const [x, z] of world) {
      flat.push(Math.round(x * 10) / 10, Math.round(z * 10) / 10);
    }

    out.push(flat);
  }

  out.sort((a, b) => at(b, 0) - at(a, 0));
  console.log(`emitting ${out.length} footprints (${fromBbox} bbox fallbacks pre-filter)`);

  const xs: number[] = [];
  const zs: number[] = [];

  for (const f of out) {
    for (let i = 1; i < f.length; i += 2) {
      xs.push(at(f, i));
      zs.push(at(f, i + 1));
    }
  }

  const body = out.map((f) => JSON.stringify(f)).join(",\n");
  writeFileSync(
    new URL("../../src/world/sf-footprints.ts", import.meta.url),
    `// AUTO-GENERATED by tools/sf-data/extract-footprints.mts — do not edit.
// Real downtown building FOOTPRINT POLYGONS + heights (licensed model,
// OSM-derived), calibrated via tower anchors + street-mask fit (see extractor).
// Entry: [height, x0, z0, x1, z1, ...] — CCW ring, world units, tallest first.
export const SF_FOOTPRINTS: readonly (readonly number[])[] = [
${body},
];

// Dense-core coverage (8th..92nd pct) — procedural kit lots yield to the real
// fabric inside this box.
export const SF_FOOTPRINTS_BOUNDS = {
  minX: ${Math.round(percentile(xs, 0.08) - 10)},
  maxX: ${Math.round(percentile(xs, 0.92) + 10)},
  minZ: ${Math.round(percentile(zs, 0.08) - 10)},
  maxZ: ${Math.round(percentile(zs, 0.92) + 10)},
} as const;
`,
  );
  console.log("sf-footprints.ts written");
};
