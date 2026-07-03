// Rasterize the real OSM SF street network onto a rectangular game grid.
//
// Reads sf-streets.raw.json (Overpass `out geom`), projects every vertex to the
// game's (u,v) space with the calibrated linear fit (see calibrate.mjs), then
// supercover-rasterizes each street segment into road cells. Emits stats, an
// SVG preview, and — for the chosen size — a compact baked mask module the game
// loads instead of the old procedural makeLines()/carve().
//
// Usage: node rasterize.mjs [GRID_X GRID_Z]   (default: sweep candidate sizes)

import { readFileSync, writeFileSync } from "node:fs";

// Calibrated projection (from calibrate.mjs, R^2 ~0.999 vs the game's hills).
const U_M = 6.2462,
  U_B = 765.2557;
const V_M = -9.6095,
  V_B = 363.344;
const projU = (lon) => U_M * lon + U_B;
const projV = (lat) => V_M * lat + V_B;

// --- landFactor, copied from src/world/sf-map.ts (kept pure; no game imports) ---
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
  let land = Math.min(
    smooth(u, 0.025, 0.06),
    1 - smooth(u, 0.78, 0.85),
    smooth(v, 0.025, 0.07),
  );
  land = Math.min(land, smooth(lineSide(u, v, 0.03, 0.26, 0.25, 0.03), -0.015, 0.02));
  land = Math.max(land, box(u, v, 0.82, 0.99, 0.7, 0.84));
  land = Math.max(land, box(u, v, 0.82, 0.98, 0.87, 0.97));
  land = Math.min(land, 1 - box(u, v, 0.71, 0.8, 0.29, 0.35));
  land = Math.min(land, 1 - box(u, v, 0.71, 0.82, 0.57, 0.63));
  land = Math.min(land, 1 - box(u, v, 0.08, 0.18, 0.72, 0.86));
  return land;
}
const isLand = (u, v) => landFactor(u, v) > 0.5;

// --- Load + project streets ---
const raw = JSON.parse(readFileSync(new URL("./sf-streets.raw.json", import.meta.url)));
const ways = raw.elements.filter((e) => e.type === "way" && e.geometry);
// Major roads (arterials/boulevards) are ALWAYS kept — they define SF's read.
// Minor roads (the residential grid) are kept but thinned so building blocks
// survive between them.
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
// Polylines in (u,v), tagged major/minor.
const polylines = ways.map((w) => ({
  major: MAJOR.has(w.tags?.highway),
  pts: w.geometry.map((g) => [projU(g.lon), projV(g.lat)]),
}));
const majorCount = polylines.filter((p) => p.major).length;
console.log(
  `Loaded ${ways.length} ways (${majorCount} major / ${ways.length - majorCount} minor), ` +
    `${polylines.reduce((n, p) => n + p.pts.length, 0)} vertices.`,
);

// Supercover rasterize a segment (u0,v0)->(u1,v1) into grid cells [gx,gz].
function rasterizeSeg(grid, gx0, gz0, gx1, gz1, GX, GZ) {
  let x = gx0,
    z = gz0;
  const dx = Math.abs(gx1 - gx0),
    dz = Math.abs(gz1 - gz0);
  const sx = gx0 < gx1 ? 1 : -1,
    sz = gz0 < gz1 ? 1 : -1;
  let err = dx - dz;
  const mark = (cx, cz) => {
    if (cx >= 0 && cz >= 0 && cx < GX && cz < GZ) grid[cx * GZ + cz] = 1;
  };
  // guard against pathological long segments
  let steps = 0;
  const maxSteps = dx + dz + 4;
  while (steps++ < maxSteps) {
    mark(x, z);
    if (x === gx1 && z === gz1) break;
    const e2 = 2 * err;
    if (e2 > -dz) {
      err -= dz;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      z += sz;
      mark(x, z); // supercover: also fill the corner cell so no diagonal leaks
    }
  }
}

// 4-connectivity check over road cells that are ALSO on land, between two
// cells. Restricting the flood-fill to land matters because generateCity drops
// water cells (isLandCell) — road cells rasterized onto water (bridge
// approaches, Treasure Island) don't exist in the playable graph, so a path
// that routes through them would falsely report the network as still connected.
function connectedOnLand(grid, onLand, GX, GZ, ax, az, bx, bz) {
  const seen = new Uint8Array(GX * GZ);
  const stack = [[ax, az]];
  seen[ax * GZ + az] = 1;
  while (stack.length) {
    const [x, z] = stack.pop();
    if (x === bx && z === bz) return true;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx,
        nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= GX || nz >= GZ) continue;
      const idx = nx * GZ + nz;
      if (seen[idx] || !grid[idx] || !onLand[idx]) continue;
      seen[idx] = 1;
      stack.push([nx, nz]);
    }
  }
  return false;
}

function bake(GX, GZ) {
  const grid = new Uint8Array(GX * GZ); // 1 = road
  const major = new Uint8Array(GX * GZ); // 1 = arterial (never thinned)
  const draw = (pts, majorFlag) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i],
        b = pts[i + 1];
      rasterizeSeg(
        grid,
        Math.floor(a[0] * GX),
        Math.floor(a[1] * GZ),
        Math.floor(b[0] * GX),
        Math.floor(b[1] * GZ),
        GX,
        GZ,
      );
      if (majorFlag)
        rasterizeSeg(major, Math.floor(a[0] * GX), Math.floor(a[1] * GZ), Math.floor(b[0] * GX), Math.floor(b[1] * GZ), GX, GZ);
    }
  };
  // Minor first, then major on top, so `major` marks the protected arterials.
  // MAJORS_ONLY drops the residential grid entirely — the game reads better
  // (and runs faster) with SF's arterial network + superblocks.
  if (!MAJORS_ONLY) for (const pl of polylines) if (!pl.major) draw(pl.pts, false);
  for (const pl of polylines) if (pl.major) draw(pl.pts, true);

  // --- Thinning: open building blocks by forbidding any fully-road 2x2 window.
  // Remove a minor-road cell from each solid 2x2, but only if the network stays
  // connected (checked against a nearby road cell). This preserves every
  // arterial and never creates an unreachable island. ---
  const onLandCache = new Uint8Array(GX * GZ);
  for (let gx = 0; gx < GX; gx++)
    for (let gz = 0; gz < GZ; gz++) onLandCache[gx * GZ + gz] = isLand((gx + 0.5) / GX, (gz + 0.5) / GZ) ? 1 : 0;

  let removedTotal = 0;
  for (let pass = 0; pass < 6; pass++) {
    let removed = 0;
    for (let gx = 0; gx + 1 < GX; gx++) {
      for (let gz = 0; gz + 1 < GZ; gz++) {
        const cells = [
          [gx, gz],
          [gx + 1, gz],
          [gx, gz + 1],
          [gx + 1, gz + 1],
        ];
        if (!cells.every(([x, z]) => grid[x * GZ + z] && onLandCache[x * GZ + z])) continue;
        // Prefer removing a non-major cell; find one whose removal keeps a
        // neighbour reachable (connectivity guard).
        const cand = cells.filter(([x, z]) => !major[x * GZ + z]);
        if (!cand.length) continue; // all four are arterials — leave the plaza
        const [rx, rz] = cand[0];
        grid[rx * GZ + rz] = 0;
        // Verify: pick any still-road neighbour and confirm reachability to another road cell.
        const nbrs = [
          [rx + 1, rz],
          [rx - 1, rz],
          [rx, rz + 1],
          [rx, rz - 1],
        ].filter(([x, z]) => x >= 0 && z >= 0 && x < GX && z < GZ && grid[x * GZ + z] && onLandCache[x * GZ + z]);
        let ok = true;
        for (let i = 1; i < nbrs.length; i++) {
          if (!connectedOnLand(grid, onLandCache, GX, GZ, nbrs[0][0], nbrs[0][1], nbrs[i][0], nbrs[i][1])) {
            ok = false;
            break;
          }
        }
        if (ok) removed++;
        else grid[rx * GZ + rz] = 1; // restore — removal would split the network
      }
    }
    removedTotal += removed;
    if (!removed) break;
  }

  // Stats over land cells only.
  let land = 0,
    road = 0,
    roadOffLand = 0;
  for (let gx = 0; gx < GX; gx++) {
    for (let gz = 0; gz < GZ; gz++) {
      const u = (gx + 0.5) / GX,
        v = (gz + 0.5) / GZ;
      const onLand = onLandCache[gx * GZ + gz];
      if (onLand) land++;
      if (grid[gx * GZ + gz]) {
        if (onLand) road++;
        else roadOffLand++;
      }
    }
  }
  return { grid, major, GX, GZ, land, road, roadOffLand, removedTotal };
}

function svgPreview(res, path) {
  const { grid, GX, GZ } = res;
  const cell = 6;
  const W = GX * cell,
    H = GZ * cell;
  let rects = "";
  for (let gx = 0; gx < GX; gx++) {
    for (let gz = 0; gz < GZ; gz++) {
      const u = (gx + 0.5) / GX,
        v = (gz + 0.5) / GZ;
      const onLand = isLand(u, v);
      const isR = grid[gx * GZ + gz];
      let fill = null;
      if (isR && onLand) fill = "#222";
      else if (isR && !onLand) fill = "#c33"; // road rasterized onto water (clipped in-game)
      else if (onLand) fill = "#e8e4d8";
      if (fill) rects += `<rect x="${gx * cell}" y="${gz * cell}" width="${cell}" height="${cell}" fill="${fill}"/>`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#aquamarine"><rect width="${W}" height="${H}" fill="#9ec7d8"/>${rects}</svg>`;
  writeFileSync(path, svg);
}

const MAJORS_ONLY = process.argv.includes("--majors-only");
const arg = process.argv.slice(2).filter((a) => a !== "--majors-only").map(Number);
if (arg.length === 2) {
  // Bake one chosen size to a TS module + preview.
  const res = bake(arg[0], arg[1]);
  console.log(
    `\n${res.GX}x${res.GZ}: ${res.road} road cells over ${res.land} land cells ` +
      `(${((100 * res.road) / res.land).toFixed(1)}% streets), ${res.roadOffLand} clipped to water.`,
  );
  // Pack columns as hex bitstrings (gz-major within each gx column).
  const cols = [];
  for (let gx = 0; gx < res.GX; gx++) {
    let bits = "";
    for (let gz = 0; gz < res.GZ; gz++) bits += res.grid[gx * res.GZ + gz] ? "1" : "0";
    // to hex, padded
    let hex = "";
    for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4).padEnd(4, "0"), 2).toString(16);
    cols.push(hex);
  }
  const ts = `// AUTO-GENERATED by tools/sf-data/rasterize.mjs — do not edit by hand.
// Real San Francisco street network (OpenStreetMap), rasterized to the game grid.
// ${res.road} road cells at ${res.GX}x${res.GZ}. Regenerate: node tools/sf-data/rasterize.mjs ${res.GX} ${res.GZ}
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
  svgPreview(res, new URL(`./preview-${res.GX}x${res.GZ}.svg`, import.meta.url));
  console.log(`Wrote src/world/sf-streets.ts and preview-${res.GX}x${res.GZ}.svg`);
} else {
  // Sweep candidate sizes (aspect locked to 1.219:1) and report density.
  const WIDTH_KM = 14.1,
    HEIGHT_KM = 11.56;
  console.log("\nSize sweep (aspect 1.219:1, square real cells):");
  console.log("  GX x GZ    cell(m)   cells    road cells   street%   note");
  const targets = [
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
    const note = pct > 60 ? "dense" : pct > 45 ? "good balance" : "sparse";
    console.log(
      `  ${String(GX).padStart(3)}x${String(GZ).padEnd(3)}  ${String(cellM).padStart(4)}m   ` +
        `${String(GX * GZ).padStart(6)}   ${String(res.road).padStart(7)}      ` +
        `${pct.toFixed(1).padStart(5)}%   ${note}`,
    );
    svgPreview(res, new URL(`./preview-${GX}x${GZ}.svg`, import.meta.url));
  }
  console.log("\nWrote preview-*.svg for each candidate. Re-run with `node rasterize.mjs GX GZ` to bake one.");
}
