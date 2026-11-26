import type { PathOrFileDescriptor } from "node:fs";
import { writeFileSync } from "node:fs";

import { at } from "./lib.mts";
import type { Point } from "./lib.mts";
import { readOverpass } from "./osm.mts";

const U_B = 765.2557;
const U_M = 6.2462;
const V_M = -9.6095;
const V_B = 363.344;
const projU = (lon: number) => U_M * lon + U_B;
const projV = (lat: number) => V_M * lat + V_B;

const smooth = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));

  return t * t * (3 - 2 * t);
};

const box = (u: number, v: number, uMin: number, uMax: number, vMin: number, vMax: number) => {
  const fu = Math.min(smooth(u, uMin - 0.02, uMin + 0.01), 1 - smooth(u, uMax - 0.01, uMax + 0.02));
  const fv = Math.min(smooth(v, vMin - 0.02, vMin + 0.01), 1 - smooth(v, vMax - 0.01, vMax + 0.02));

  return Math.min(fu, fv);
};

const lineSide = (u: number, v: number, ax: number, ay: number, bx: number, by: number) =>
  (bx - ax) * (v - ay) - (by - ay) * (u - ax);

const landFactor = (u: number, v: number) => {
  let land = Math.min(smooth(u, 0.025, 0.06), 1 - smooth(u, 0.78, 0.85), smooth(v, 0.025, 0.07));
  land = Math.min(land, smooth(lineSide(u, v, 0.03, 0.26, 0.25, 0.03), -0.015, 0.02));
  land = Math.max(land, box(u, v, 0.82, 0.99, 0.7, 0.84));
  land = Math.max(land, box(u, v, 0.82, 0.98, 0.87, 0.97));
  land = Math.min(land, 1 - box(u, v, 0.71, 0.8, 0.29, 0.35));
  land = Math.min(land, 1 - box(u, v, 0.71, 0.82, 0.57, 0.63));
  land = Math.min(land, 1 - box(u, v, 0.08, 0.18, 0.72, 0.86));

  return land;
};

const isLand = (u: number, v: number) => landFactor(u, v) > 0.5;

const STEPS: readonly Point[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const raw = readOverpass(new URL("sf-streets.raw.json", import.meta.url));

const ways = raw.elements.flatMap((e) =>
  e.type === "way" && e.geometry !== undefined ? [{ geometry: e.geometry, tags: e.tags }] : [],
);

const MAJOR = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
]);

const polylines = ways.map((w) => ({
  major: MAJOR.has(w.tags?.highway ?? ""),
  pts: w.geometry.map<Point>((g) => [projU(g.lon), projV(g.lat)]),
}));

const majorCount = polylines.filter((p) => p.major).length;

console.log(
  `Loaded ${ways.length} ways (${majorCount} major / ${ways.length - majorCount} minor), ` +
    `${polylines.reduce((n, p) => n + p.pts.length, 0)} vertices.`,
);

const rasterizeSeg = (
  grid: Uint8Array,
  gx0: number,
  gz0: number,
  gx1: number,
  gz1: number,
  GX: number,
  GZ: number,
) => {
  let x = gx0;
  let z = gz0;
  const dx = Math.abs(gx1 - gx0);
  const dz = Math.abs(gz1 - gz0);
  const sx = gx0 < gx1 ? 1 : -1;
  const sz = gz0 < gz1 ? 1 : -1;
  let err = dx - dz;

  const mark = (cx: number, cz: number) => {
    if (cx >= 0 && cz >= 0 && cx < GX && cz < GZ) {
      grid[cx * GZ + cz] = 1;
    }
  };

  let steps = 0;
  const maxSteps = dx + dz + 4;

  while (steps < maxSteps) {
    steps += 1;
    mark(x, z);

    if (x === gx1 && z === gz1) {
      break;
    }

    const e2 = 2 * err;

    if (e2 > -dz) {
      err -= dz;
      x += sx;
    }

    if (e2 < dx) {
      err += dx;
      z += sz;
      mark(x, z);
    }
  }
};

const isSet = (cells: Uint8Array, i: number) => (cells[i] ?? 0) !== 0;

const connectedOnLand = (
  grid: Uint8Array,
  onLand: Uint8Array,
  GX: number,
  GZ: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
) => {
  const seen = new Uint8Array(GX * GZ);
  const stack: Point[] = [[ax, az]];
  seen[ax * GZ + az] = 1;

  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [x, z] = top;

    if (x === bx && z === bz) {
      return true;
    }

    for (const [dx, dz] of STEPS) {
      const nx = x + dx;
      const nz = z + dz;

      if (nx < 0 || nz < 0 || nx >= GX || nz >= GZ) {
        continue;
      }

      const idx = nx * GZ + nz;

      if (isSet(seen, idx) || !isSet(grid, idx) || !isSet(onLand, idx)) {
        continue;
      }

      seen[idx] = 1;
      stack.push([nx, nz]);
    }
  }

  return false;
};

const landMask = (GX: number, GZ: number) => {
  const onLandCache = new Uint8Array(GX * GZ);

  for (let gx = 0; gx < GX; gx += 1) {
    for (let gz = 0; gz < GZ; gz += 1) {
      onLandCache[gx * GZ + gz] = isLand((gx + 0.5) / GX, (gz + 0.5) / GZ) ? 1 : 0;
    }
  }

  return onLandCache;
};

const removalKeepsNetwork = (
  grid: Uint8Array,
  onLandCache: Uint8Array,
  GX: number,
  GZ: number,
  rx: number,
  rz: number,
) => {
  const around: Point[] = [
    [rx + 1, rz],
    [rx - 1, rz],
    [rx, rz + 1],
    [rx, rz - 1],
  ];

  const nbrs = around.filter(
    ([x, z]) =>
      x >= 0 &&
      z >= 0 &&
      x < GX &&
      z < GZ &&
      isSet(grid, x * GZ + z) &&
      isSet(onLandCache, x * GZ + z),
  );

  for (let i = 1; i < nbrs.length; i += 1) {
    const [x0, z0] = at(nbrs, 0);
    const [xi, zi] = at(nbrs, i);

    if (!connectedOnLand(grid, onLandCache, GX, GZ, x0, z0, xi, zi)) {
      return false;
    }
  }

  return true;
};

const thinPass = (
  grid: Uint8Array,
  major: Uint8Array,
  onLandCache: Uint8Array,
  GX: number,
  GZ: number,
) => {
  let removed = 0;

  for (let gx = 0; gx + 1 < GX; gx += 1) {
    for (let gz = 0; gz + 1 < GZ; gz += 1) {
      const cells: Point[] = [
        [gx, gz],
        [gx + 1, gz],
        [gx, gz + 1],
        [gx + 1, gz + 1],
      ];

      if (!cells.every(([x, z]) => isSet(grid, x * GZ + z) && isSet(onLandCache, x * GZ + z))) {
        continue;
      }

      const cand = cells.filter(([x, z]) => !isSet(major, x * GZ + z));

      if (cand.length === 0) {
        continue;
      }

      const [rx, rz] = at(cand, 0);
      grid[rx * GZ + rz] = 0;

      if (removalKeepsNetwork(grid, onLandCache, GX, GZ, rx, rz)) {
        removed += 1;
      } else {
        grid[rx * GZ + rz] = 1;
      }
    }
  }

  return removed;
};

const thinBlocks = (
  grid: Uint8Array,
  major: Uint8Array,
  onLandCache: Uint8Array,
  GX: number,
  GZ: number,
) => {
  let removedTotal = 0;

  for (let pass = 0; pass < 6; pass += 1) {
    const removed = thinPass(grid, major, onLandCache, GX, GZ);
    removedTotal += removed;

    if (removed === 0) {
      break;
    }
  }

  return removedTotal;
};

const gridStats = (grid: Uint8Array, onLandCache: Uint8Array, GX: number, GZ: number) => {
  let land = 0;
  let road = 0;
  let roadOffLand = 0;

  for (let gx = 0; gx < GX; gx += 1) {
    for (let gz = 0; gz < GZ; gz += 1) {
      const onLand = isSet(onLandCache, gx * GZ + gz);

      if (onLand) {
        land += 1;
      }

      if (isSet(grid, gx * GZ + gz)) {
        if (onLand) {
          road += 1;
        } else {
          roadOffLand += 1;
        }
      }
    }
  }

  return { land, road, roadOffLand };
};

const densityNote = (pct: number) => {
  if (pct > 60) {
    return "dense";
  }

  if (pct > 45) {
    return "good balance";
  }

  return "sparse";
};

const bake = (GX: number, GZ: number) => {
  const grid = new Uint8Array(GX * GZ);
  const major = new Uint8Array(GX * GZ);

  const draw = (pts: readonly Point[], majorFlag: boolean) => {
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const a = at(pts, i);
      const b = at(pts, i + 1);
      rasterizeSeg(
        grid,
        Math.floor(a[0] * GX),
        Math.floor(a[1] * GZ),
        Math.floor(b[0] * GX),
        Math.floor(b[1] * GZ),
        GX,
        GZ,
      );

      if (majorFlag) {
        rasterizeSeg(
          major,
          Math.floor(a[0] * GX),
          Math.floor(a[1] * GZ),
          Math.floor(b[0] * GX),
          Math.floor(b[1] * GZ),
          GX,
          GZ,
        );
      }
    }
  };

  if (!MAJORS_ONLY) {
    for (const pl of polylines) {
      if (!pl.major) {
        draw(pl.pts, false);
      }
    }
  }

  for (const pl of polylines) {
    if (pl.major) {
      draw(pl.pts, true);
    }
  }

  const onLandCache = landMask(GX, GZ);
  const removedTotal = thinBlocks(grid, major, onLandCache, GX, GZ);
  const { land, road, roadOffLand } = gridStats(grid, onLandCache, GX, GZ);

  return { GX, GZ, grid, land, major, removedTotal, road, roadOffLand };
};

const svgPreview = (
  res: { readonly GX: number; readonly GZ: number; readonly grid: Uint8Array },
  path: PathOrFileDescriptor,
) => {
  const { grid, GX, GZ } = res;
  const cell = 6;
  const W = GX * cell;
  const H = GZ * cell;
  let rects = "";

  for (let gx = 0; gx < GX; gx += 1) {
    for (let gz = 0; gz < GZ; gz += 1) {
      const u = (gx + 0.5) / GX;
      const v = (gz + 0.5) / GZ;
      const onLand = isLand(u, v);
      const isR = isSet(grid, gx * GZ + gz);
      let fill: string | null = null;

      if (isR && onLand) {
        fill = "#222";
      } else if (isR && !onLand) {
        fill = "#c33";
      } else if (onLand) {
        fill = "#e8e4d8";
      }

      if (fill !== null && fill !== "") {
        rects += `<rect x="${gx * cell}" y="${gz * cell}" width="${cell}" height="${cell}" fill="${fill}"/>`;
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#aquamarine"><rect width="${W}" height="${H}" fill="#9ec7d8"/>${rects}</svg>`;
  writeFileSync(path, svg);
};

const MAJORS_ONLY = process.argv.includes("--majors-only");

const arg = process.argv
  .slice(2)
  .filter((a) => a !== "--majors-only")
  .map(Number);

if (arg.length === 2) {
  const res = bake(at(arg, 0), at(arg, 1));
  console.log(
    `\n${res.GX}x${res.GZ}: ${res.road} road cells over ${res.land} land cells ` +
      `(${((100 * res.road) / res.land).toFixed(1)}% streets), ${res.roadOffLand} clipped to water.`,
  );
  const cols: string[] = [];

  for (let gx = 0; gx < res.GX; gx += 1) {
    let bits = "";

    for (let gz = 0; gz < res.GZ; gz += 1) {
      bits += (res.grid[gx * res.GZ + gz] ?? 0) === 0 ? "0" : "1";
    }

    let hex = "";

    for (let i = 0; i < bits.length; i += 4) {
      hex += Number.parseInt(bits.slice(i, i + 4).padEnd(4, "0"), 2).toString(16);
    }

    cols.push(hex);
  }

  const ts = `// AUTO-GENERATED by tools/sf-data/rasterize.mts — do not edit by hand.
// Real San Francisco street network (OpenStreetMap), rasterized to the game grid.
// ${res.road} road cells at ${res.GX}x${res.GZ}. Regenerate: node tools/sf-data/rasterize.mts ${res.GX} ${res.GZ}
export const SF_STREET_MASK = {
  gx: ${res.GX},
  gz: ${res.GZ},
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
`;

  writeFileSync(new URL("../../src/world/sf-streets.ts", import.meta.url), ts);
  svgPreview(res, new URL(`preview-${res.GX}x${res.GZ}.svg`, import.meta.url));
  console.log(`Wrote src/world/sf-streets.ts and preview-${res.GX}x${res.GZ}.svg`);
} else {
  const WIDTH_KM = 14.1;
  console.log("\nSize sweep (aspect 1.219:1, square real cells):");
  console.log("  GX x GZ    cell(m)   cells    road cells   street%   note");

  const targets: Point[] = [
    [94, 77],
    [110, 90],
    [128, 105],
    [146, 120],
    [166, 136],
    [201, 165],
  ];

  for (const [GX, GZ] of targets) {
    const res = bake(GX, GZ);
    const cellM = Math.round((WIDTH_KM * 1000) / GX);
    const pct = (100 * res.road) / res.land;
    const note = densityNote(pct);
    console.log(
      `  ${String(GX).padStart(3)}x${String(GZ).padEnd(3)}  ${String(cellM).padStart(4)}m   ` +
        `${String(GX * GZ).padStart(6)}   ${String(res.road).padStart(7)}      ` +
        `${pct.toFixed(1).padStart(5)}%   ${note}`,
    );
    svgPreview(res, new URL(`preview-${GX}x${GZ}.svg`, import.meta.url));
  }

  console.log(
    "\nWrote preview-*.svg for each candidate. Re-run with `node rasterize.mts GX GZ` to bake one.",
  );
}
