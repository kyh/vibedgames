// Shared helpers for the sf-data bake tools (bake-network.mts, bake-piers.mjs,
// extract-footprints.mjs): ONE copy of the projection and the polyline math,
// which the per-script copies used to drift on. The land mask below is the
// exception — see the note above landFactor.

export const GRID_X = 244;
export const GRID_Z = 200;
export const ROAD_TILE = 13;
export const WORLD_W = GRID_X * ROAD_TILE;
export const WORLD_H = GRID_Z * ROAD_TILE;

// Calibrated lon/lat → (u,v) projection (see calibrate.mjs; R² ~0.999).
const U_M = 6.2462,
  U_B = 765.2557;
const V_M = -9.6095,
  V_B = 363.344;
export const projU = (lon) => U_M * lon + U_B;
export const projV = (lat) => V_M * lat + V_B;

// --- landFactor: a PLAIN-NODE TWIN of src/world/sf-map.ts's ----------------
// sf-map.ts is the single source of truth, and bake-network.mts (vite-node, so
// it can import TS) uses it directly — nothing that emits the GEN_ID-stamped
// street pair reads the copy below. This copy exists only for the .mjs-only
// tools that plain `node` runs and that cannot import TS: bake-piers.mjs and
// the extract-*-obj.mjs miners. Change both together.
export function smooth(x, a, b) {
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
function stationAt(S, x) {
  if (x <= S[0][0] || x >= S[S.length - 1][0]) return null;
  let i = 1;
  while (i < S.length - 1 && S[i][0] < x) i++;
  const a = S[i - 1];
  const b = S[i];
  const t = (x - a[0]) / (b[0] - a[0] || 1);
  return a[1] + (b[1] - a[1]) * t;
}
const EMBARCADERO_SHORE = [
  [0.021, 0.6596], // Pier 39
  [0.0415, 0.7146], // Pier 35
  [0.0838, 0.7458], // Pier 23
  [0.148, 0.7602], // Ferry Building
  [0.2, 0.796], // Bay Bridge anchorage
  [0.2634, 0.8114], // South Beach / Mission Rock
];
function shoreCut(u, v) {
  const su = stationAt(EMBARCADERO_SHORE, v);
  return su === null ? 1 : 1 - smooth(u, su - 0.004, su + 0.008);
}
// The Golden Gate strait's south shore and the Marin coast (see sf-map.ts
// GATE_SHORE / MARIN_COAST for why the strait's water comes out of the
// Presidio's north edge rather than out of the Marin strip).
const NORTH_SHORE_V = 0.0475;
const NORTH_SHORE_FEATHER = 0.0225;
const GATE_SHORE = [
  [0.155, 0.124],
  [0.2, 0.116],
  [0.25, 0.104],
  [0.3, 0.0995],
  [0.34, 0.1015],
  [0.38, 0.0965],
  [0.41, 0.077],
  [0.43, 0.058],
  [0.445, NORTH_SHORE_V],
];
const MARIN_FEATHER = 0.005;
const MARIN_COAST = [
  [0.085, -0.006],
  [0.13, 0.004],
  [0.18, 0.0135],
  [0.21, 0.0135],
  [0.24, 0.0075], // Kirby Cove
  [0.265, 0.017],
  [0.285, 0.0215], // Lime Point
  [0.325, 0.0205],
  [0.355, 0.012],
  [0.385, -0.004],
  [0.42, -0.028],
];
function marinLand(u, v) {
  const cv = stationAt(MARIN_COAST, u);
  return cv === null ? 0 : 1 - smooth(v, cv - MARIN_FEATHER, cv + MARIN_FEATHER);
}
// Mission Creek's true outline (see sf-map.ts MISSION_CREEK) and the feather,
// in world units, that a 20u-wide channel needs.
const RING_FEATHER = 5;
const MISSION_CREEK = [
  [0.7804, 0.3358],
  [0.7328, 0.3918],
  [0.7313, 0.393],
  [0.7297, 0.3884],
  [0.7396, 0.3754],
  [0.7809, 0.327],
  [0.868, 0.3255],
  [0.868, 0.3375],
];
const YERBA_BUENA = { u: 0.938, v: -0.005, ru: 95, rv: 190 };
function ringFactor(u, v, ring) {
  const px = u * WORLD_W;
  const pz = v * WORLD_H;
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[i][0] * WORLD_W,
      az = ring[i][1] * WORLD_H;
    const cx = ring[j][0] * WORLD_W,
      cz = ring[j][1] * WORLD_H;
    if (az > pz !== cz > pz && px < ((cx - ax) * (pz - az)) / (cz - az) + ax) inside = !inside;
    const dx = cx - ax,
      dz = cz - az;
    const t = Math.max(
      0,
      Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)),
    );
    const d = Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
    if (d < best) best = d;
  }
  return 1 - smooth(inside ? -best : best, -RING_FEATHER, RING_FEATHER);
}
function isle(u, v, c) {
  return (
    1 - smooth(Math.hypot(((u - c.u) * WORLD_W) / c.ru, ((v - c.v) * WORLD_H) / c.rv), 0.72, 1)
  );
}
export function landFactor(u, v) {
  const ns = stationAt(GATE_SHORE, u) ?? NORTH_SHORE_V;
  let land = Math.min(
    smooth(u, 0.025, 0.06),
    1 - smooth(u, 0.78, 0.85),
    smooth(v, ns - NORTH_SHORE_FEATHER, ns + NORTH_SHORE_FEATHER),
  );
  land = Math.min(land, smooth(lineSide(u, v, 0.03, 0.26, 0.25, 0.03), -0.015, 0.02));
  land = Math.min(land, shoreCut(u, v));
  land = Math.max(land, box(u, v, 0.82, 0.99, 0.7, 0.84));
  land = Math.max(land, box(u, v, 0.82, 0.98, 0.87, 0.97));
  land = Math.min(land, 1 - ringFactor(u, v, MISSION_CREEK));
  land = Math.min(land, 1 - box(u, v, 0.71, 0.82, 0.57, 0.63));
  land = Math.min(land, 1 - box(u, v, 0.08, 0.18, 0.72, 0.86));
  land = Math.max(land, isle(u, v, YERBA_BUENA));
  // Marin headlands (the Golden Gate has to DELIVER somewhere).
  land = Math.max(land, marinLand(u, v));
  return land;
}
export const onLandUV = (u, v) => landFactor(u, v) > 0.5;
export const onLandXZ = (x, z) => onLandUV(x / WORLD_W + 0.5, z / WORLD_H + 0.5);

// --- polyline math ---
export function ringArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

// The exact recursive variant bake-network always used — byte-identical
// network output depends on its ≤3-point handling (it may drop an in-eps
// middle point where an early-return variant keeps it).
export function rdp(pts, eps) {
  if (pts.length <= 2) return pts;
  const [x0, z0] = pts[0];
  const [x1, z1] = pts[pts.length - 1];
  const dx = x1 - x0,
    dz = z1 - z0;
  const len = Math.hypot(dx, dz) || 1;
  let maxD = -1,
    maxI = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const d = Math.abs((pts[i][0] - x0) * dz - (pts[i][1] - z0) * dx) / len;
    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const l = rdp(pts.slice(0, maxI + 1), eps);
  const r = rdp(pts.slice(maxI), eps);
  return [...l.slice(0, -1), ...r];
}

export function plLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++)
    L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}
