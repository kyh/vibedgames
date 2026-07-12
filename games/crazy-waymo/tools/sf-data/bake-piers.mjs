// Bake pier/dock polygons (OSM man_made=pier, fetched to sf-piers.raw.json)
// into src/world/sf-piers.ts. The Embarcadero finger piers + wharf docks are
// what makes SF's NE waterfront read as SF instead of a straight seawall.
//
//   node tools/sf-data/bake-piers.mjs

import { readFileSync, writeFileSync } from "node:fs";

const GRID_X = 244;
const GRID_Z = 200;
const ROAD_TILE = 13;
const WORLD_W = GRID_X * ROAD_TILE;
const WORLD_H = GRID_Z * ROAD_TILE;

// Calibrated projection — keep in sync with bake-network.mts.
const U_M = 6.2462,
  U_B = 765.2557;
const V_M = -9.6095,
  V_B = 363.344;
const projU = (lon) => U_M * lon + U_B;
const projV = (lat) => V_M * lat + V_B;

// landFactor — keep in sync with src/world/sf-map.ts (same copy as
// bake-network.mts; piers must reference the game's traced coast, not OSM's).
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
const EMBARCADERO_SHORE = [
  [0.021, 0.6596],
  [0.0415, 0.7146],
  [0.0838, 0.7458],
  [0.148, 0.7602],
  [0.2, 0.796],
  [0.2634, 0.8114],
];
function shoreCut(u, v) {
  const S = EMBARCADERO_SHORE;
  if (v <= S[0][0] || v >= S[S.length - 1][0]) return 1;
  let i = 1;
  while (i < S.length - 1 && S[i][0] < v) i++;
  const a = S[i - 1];
  const b = S[i];
  const t = (v - a[0]) / (b[0] - a[0] || 1);
  const su = a[1] + (b[1] - a[1]) * t;
  return 1 - smooth(u, su - 0.004, su + 0.008);
}
function landFactor(u, v) {
  let land = Math.min(smooth(u, 0.025, 0.06), 1 - smooth(u, 0.78, 0.85), smooth(v, 0.025, 0.07));
  land = Math.min(land, smooth(lineSide(u, v, 0.03, 0.26, 0.25, 0.03), -0.015, 0.02));
  land = Math.min(land, shoreCut(u, v));
  land = Math.max(land, box(u, v, 0.82, 0.99, 0.7, 0.84));
  land = Math.max(land, box(u, v, 0.82, 0.98, 0.87, 0.97));
  land = Math.min(land, 1 - box(u, v, 0.71, 0.8, 0.29, 0.35));
  land = Math.min(land, 1 - box(u, v, 0.71, 0.82, 0.57, 0.63));
  land = Math.min(land, 1 - box(u, v, 0.08, 0.18, 0.72, 0.86));
  return land;
}
const onLandUV = (u, v) => landFactor(u, v) > 0.5;

const raw = JSON.parse(readFileSync(new URL("./sf-piers.raw.json", import.meta.url)));
const ways = raw.elements.filter((e) => e.type === "way" && e.geometry);
console.log(`pier ways: ${ways.length}`);

const ringArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
};

function rdp(pts, eps) {
  if (pts.length <= 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const [ax, az] = pts[i0];
    const [bx, bz] = pts[i1];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    let worst = -1;
    let worstD = eps;
    for (let i = i0 + 1; i < i1; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / len;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([i0, worst], [worst, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const closed = []; // { p: flat ring, area }
const open = []; // { p: flat polyline }
let landDrop = 0;
for (const w of ways) {
  const g = w.geometry;
  if (g.length < 2) continue;
  const isClosed = g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
  let pts = (isClosed ? g.slice(0, -1) : g).map((q) => {
    const u = projU(q.lon);
    const v = projV(q.lat);
    return [(u - 0.5) * WORLD_W, (v - 0.5) * WORLD_H];
  });
  // In-world bounds only.
  if (pts.some(([x, z]) => Math.abs(x) > WORLD_W / 2 || Math.abs(z) > WORLD_H / 2)) continue;
  // The game's traced coast sits seaward of the real shoreline along the
  // Embarcadero, which swallows exactly the finger piers that make the
  // waterfront read as SF. Land-locked piers SLIDE seaward along their own
  // long axis until they hang off the traced coast; only piers with no water
  // within reach are dropped.
  const waterAt = ([x, z]) => !onLandUV(x / WORLD_W + 0.5, z / WORLD_H + 0.5);
  const waterFrac = pts.filter(waterAt).length / pts.length;
  if (waterFrac < 0.35) {
    // Only substantial closed piers earn the slide — swallowed marina slips
    // and walkways just drop.
    if (!isClosed) {
      landDrop++;
      continue;
    }
    // Principal axis from the farthest-apart vertex pair (piers are long).
    let ax = 1;
    let az = 0;
    let bestD = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = (pts[j][0] ?? 0) - (pts[i][0] ?? 0);
        const dz = (pts[j][1] ?? 0) - (pts[i][1] ?? 0);
        const d2 = dx * dx + dz * dz;
        if (d2 > bestD) {
          bestD = d2;
          ax = dx;
          az = dz;
        }
      }
    }
    const len = Math.sqrt(bestD) || 1;
    if (len < 15) {
      landDrop++;
      continue;
    }
    ax /= len;
    az /= len;
    let cx = 0;
    let cz = 0;
    for (const [x, z] of pts) {
      cx += x;
      cz += z;
    }
    cx /= pts.length;
    cz /= pts.length;
    // March both axis directions; the seaward one reaches water first.
    let shift = null;
    for (let d = 4; d <= 220; d += 4) {
      if (waterAt([cx + ax * d, cz + az * d])) {
        shift = [ax * (d + len * 0.28), az * (d + len * 0.28)];
        break;
      }
      if (waterAt([cx - ax * d, cz - az * d])) {
        shift = [-ax * (d + len * 0.28), -az * (d + len * 0.28)];
        break;
      }
    }
    if (!shift) {
      landDrop++;
      continue;
    }
    pts = pts.map(([x, z]) => [x + shift[0], z + shift[1]]);
    if (pts.some(([x, z]) => Math.abs(x) > WORLD_W / 2 || Math.abs(z) > WORLD_H / 2)) {
      landDrop++;
      continue;
    }
  }
  pts = rdp(pts, 0.25);
  if (isClosed && pts.length >= 3) {
    let ring = pts;
    if (ringArea(ring) < 0) ring = ring.reverse();
    const area = Math.abs(ringArea(ring));
    if (area < 8 || ring.length > 48) continue;
    closed.push({ p: ring.flat().map((n) => Math.round(n * 10) / 10), area });
  } else if (!isClosed && pts.length >= 2) {
    open.push({ p: pts.flat().map((n) => Math.round(n * 10) / 10) });
  }
}
closed.sort((a, b) => b.area - a.area);
console.log(`closed piers: ${closed.length}, open docks: ${open.length}, dropped on land: ${landDrop}`);

writeFileSync(
  new URL("../../src/world/sf-piers.ts", import.meta.url),
  `// AUTO-GENERATED by tools/sf-data/bake-piers.mjs — do not edit.
// Real pier/dock polygons (OSM man_made=pier), world units, water-clipped
// against the game's traced coast. Rendered by src/world/piers.ts.
export type PierPoly = { readonly p: readonly number[]; readonly area: number };

// Closed pier decks (CCW rings, [x0,z0,x1,z1,...]), largest first.
export const SF_PIERS: readonly PierPoly[] = [
${closed.map((c) => `  { p: [${c.p.join(",")}], area: ${Math.round(c.area)} },`).join("\n")}
];

// Open dock walkways (polylines).
export const SF_DOCKS: readonly (readonly number[])[] = [
${open.map((o) => `  [${o.p.join(",")}],`).join("\n")}
];
`,
);
console.log("Wrote src/world/sf-piers.ts");
