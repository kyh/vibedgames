// Shared helpers for the sf-data bake tools (bake-network.mts, bake-piers.mjs,
// extract-footprints.mjs). ONE copy of the projection + land mask + polyline
// math — the per-script copies drifted and the land mask in particular must
// match src/world/sf-map.ts exactly (that file keeps the RUNTIME copy; change
// them together).

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

// --- landFactor — keep in sync with src/world/sf-map.ts ---
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
const EMBARCADERO_SHORE = [
  [0.021, 0.6596], // Pier 39
  [0.0415, 0.7146], // Pier 35
  [0.0838, 0.7458], // Pier 23
  [0.148, 0.7602], // Ferry Building
  [0.2, 0.796], // Bay Bridge anchorage
  [0.2634, 0.8114], // South Beach / Mission Rock
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
export function landFactor(u, v) {
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
