import type { RawEdge } from "./sf-network";
import { ROAD_TILE } from "../shared/constants";

// Streets v3 spike: snap the baked OSM network to 8 directions on a
// half-tile lattice. SF is two grids (axis-aligned avenues + the ~45°
// SoMa/Market grid), so octilinear snapping keeps the geography while
// killing the wobble that reads as "messy".
//
// Nodes snap to the lattice; every edge is re-routed as at most two runs:
// one diagonal (45°) + one axis-aligned, ordered to best match the
// original polyline's midpoint (circuit-board routing).

const LATTICE = ROAD_TILE / 2;

const snapCoord = (v: number): number => Math.round(v / LATTICE) * LATTICE;

export function snapNetworkOctilinear(
  nodes: readonly (readonly [number, number])[],
  rawEdges: readonly (RawEdge | undefined)[],
): {
  nodes: readonly (readonly [number, number])[];
  edges: readonly (RawEdge | undefined)[];
} {
  const snappedNodes: (readonly [number, number])[] = nodes.map(([x, z]) => [
    snapCoord(x),
    snapCoord(z),
  ]);

  const route = (ax: number, az: number, bx: number, bz: number, midX: number, midZ: number): number[] => {
    const dx = bx - ax;
    const dz = bz - az;
    const adx = Math.abs(dx);
    const adz = Math.abs(dz);
    // Pure axis or pure diagonal: one straight run.
    if (adx < 1e-6 || adz < 1e-6 || Math.abs(adx - adz) < 1e-6) return [ax, az, bx, bz];
    // Diagonal run covers min(adx, adz); the remainder is axis-aligned.
    const d = Math.min(adx, adz);
    const sx = Math.sign(dx);
    const sz = Math.sign(dz);
    // Option 1: diagonal first, then axis. Option 2: axis first, then diagonal.
    const k1x = ax + sx * d;
    const k1z = az + sz * d;
    const k2x = bx - sx * d;
    const k2z = bz - sz * d;
    const d1 = Math.hypot(k1x - midX, k1z - midZ);
    const d2 = Math.hypot(k2x - midX, k2z - midZ);
    return d1 <= d2 ? [ax, az, k1x, k1z, bx, bz] : [ax, az, k2x, k2z, bx, bz];
  };

  const edges: (RawEdge | undefined)[] = rawEdges.map((raw) => {
    if (!raw) return undefined;
    const a = snappedNodes[raw.a];
    const b = snappedNodes[raw.b];
    if (!a || !b) return undefined;
    if (a[0] === b[0] && a[1] === b[1]) return undefined; // collapsed by snapping
    // Original midpoint steers which bend the route takes.
    const p = raw.p;
    const mi = Math.floor(p.length / 4) * 2;
    const midX = p[mi] ?? (a[0] + b[0]) / 2;
    const midZ = p[mi + 1] ?? (a[1] + b[1]) / 2;
    return { a: raw.a, b: raw.b, w: raw.w, p: route(a[0], a[1], b[0], b[1], midX, midZ) };
  });

  return { nodes: snappedNodes, edges };
}
