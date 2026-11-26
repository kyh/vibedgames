/** A planar point: `[x, z]` in world units, or `[u, v]` in map fractions. */
export type Point = readonly [number, number];

/** Read item `i` of a list whose index the caller has already bounded. */
export const at = <T,>(items: ArrayLike<T>, i: number) => {
  const item = items[i];

  if (item === undefined) {
    throw new RangeError(`item ${i} of ${items.length}`);
  }

  return item;
};

export const GRID_X = 244;
export const GRID_Z = 200;
export const ROAD_TILE = 13;
export const WORLD_W = GRID_X * ROAD_TILE;
export const WORLD_H = GRID_Z * ROAD_TILE;

const U_B = 765.2557;
const U_M = 6.2462;
const V_M = -9.6095;
const V_B = 363.344;
export const projU = (lon: number) => U_M * lon + U_B;
export const projV = (lat: number) => V_M * lat + V_B;

export const smooth = (x: number, a: number, b: number) => {
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

const stationAt = (S: readonly Point[], x: number) => {
  if (x <= at(S, 0)[0] || x >= at(S, S.length - 1)[0]) {
    return null;
  }

  let i = 1;

  while (i < S.length - 1 && at(S, i)[0] < x) {
    i += 1;
  }

  const a = at(S, i - 1);
  const b = at(S, i);
  const t = (x - a[0]) / (b[0] - a[0] || 1);

  return a[1] + (b[1] - a[1]) * t;
};

const EMBARCADERO_SHORE: readonly Point[] = [
  [0.021, 0.6596],
  [0.0415, 0.7146],
  [0.0838, 0.7458],
  [0.148, 0.7602],
  [0.2, 0.796],
  [0.2634, 0.8114],
];

const shoreCut = (u: number, v: number) => {
  const su = stationAt(EMBARCADERO_SHORE, v);

  return su === null ? 1 : 1 - smooth(u, su - 0.004, su + 0.008);
};

const NORTH_SHORE_V = 0.0475;
const NORTH_SHORE_FEATHER = 0.0225;

const GATE_SHORE: readonly Point[] = [
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

const MARIN_COAST: readonly Point[] = [
  [0.085, -0.006],
  [0.13, 0.004],
  [0.18, 0.0135],
  [0.21, 0.0135],
  [0.24, 0.0075],
  [0.265, 0.017],
  [0.285, 0.0215],
  [0.325, 0.0205],
  [0.355, 0.012],
  [0.385, -0.004],
  [0.42, -0.028],
];

const marinLand = (u: number, v: number) => {
  const cv = stationAt(MARIN_COAST, u);

  return cv === null ? 0 : 1 - smooth(v, cv - MARIN_FEATHER, cv + MARIN_FEATHER);
};

const RING_FEATHER = 5;

const MISSION_CREEK: readonly Point[] = [
  [0.7804, 0.3358],
  [0.7328, 0.3918],
  [0.7313, 0.393],
  [0.7297, 0.3884],
  [0.7396, 0.3754],
  [0.7809, 0.327],
  [0.868, 0.3255],
  [0.868, 0.3375],
];

const YERBA_BUENA = { ru: 95, rv: 190, u: 0.938, v: -0.005 };

const ringFactor = (u: number, v: number, ring: readonly Point[]) => {
  const px = u * WORLD_W;
  const pz = v * WORLD_H;
  let best = Infinity;
  let inside = false;

  for (let i = 0; i < ring.length; i += 1) {
    const j = (i + ring.length - 1) % ring.length;
    const ax = at(ring, i)[0] * WORLD_W;
    const az = at(ring, i)[1] * WORLD_H;
    const cx = at(ring, j)[0] * WORLD_W;
    const cz = at(ring, j)[1] * WORLD_H;

    if (az > pz !== cz > pz && px < ((cx - ax) * (pz - az)) / (cz - az) + ax) {
      inside = !inside;
    }

    const dx = cx - ax;
    const dz = cz - az;

    const t = Math.max(
      0,
      Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)),
    );

    const d = Math.hypot(px - (ax + t * dx), pz - (az + t * dz));

    if (d < best) {
      best = d;
    }
  }

  return 1 - smooth(inside ? -best : best, -RING_FEATHER, RING_FEATHER);
};

const isle = (u: number, v: number, c: { ru: number; rv: number; u: number; v: number }) =>
  1 - smooth(Math.hypot(((u - c.u) * WORLD_W) / c.ru, ((v - c.v) * WORLD_H) / c.rv), 0.72, 1);

export const landFactor = (u: number, v: number) => {
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
  land = Math.max(land, marinLand(u, v));

  return land;
};

export const onLandUV = (u: number, v: number) => landFactor(u, v) > 0.5;
export const onLandXZ = (x: number, z: number) => onLandUV(x / WORLD_W + 0.5, z / WORLD_H + 0.5);

export const ringArea = (pts: readonly Point[]) => {
  let a = 0;

  for (let i = 0; i < pts.length; i += 1) {
    const [x0, z0] = at(pts, i);
    const [x1, z1] = at(pts, (i + 1) % pts.length);
    a += x0 * z1 - x1 * z0;
  }

  return a / 2;
};

export const rdp: <P extends Point>(pts: readonly P[], eps: number) => P[] = (pts, eps) => {
  if (pts.length <= 2) {
    return [...pts];
  }

  const first = at(pts, 0);
  const last = at(pts, pts.length - 1);
  const [x0, z0] = first;
  const [x1, z1] = last;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz) || 1;
  let maxD = -1;
  let maxI = 0;

  for (let i = 1; i + 1 < pts.length; i += 1) {
    const [px, pz] = at(pts, i);
    const d = Math.abs((px - x0) * dz - (pz - z0) * dx) / len;

    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }

  if (maxD <= eps) {
    return [first, last];
  }

  const l = rdp(pts.slice(0, maxI + 1), eps);
  const r = rdp(pts.slice(maxI), eps);

  return [...l.slice(0, -1), ...r];
};

export const plLen = (pts: readonly Point[]) => {
  let L = 0;

  for (let i = 1; i < pts.length; i += 1) {
    const [x1, z1] = at(pts, i);
    const [x0, z0] = at(pts, i - 1);
    L += Math.hypot(x1 - x0, z1 - z0);
  }

  return L;
};
