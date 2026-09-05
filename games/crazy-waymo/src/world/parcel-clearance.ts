import { pointInRing, type ParcelPlan } from "./parcel-plan";

export type PropFootprint = {
  readonly x: number;
  readonly z: number;
  readonly halfWidth: number;
  readonly halfDepth: number;
  readonly yaw: number;
};
export type ParcelClearance = (footprint: PropFootprint, margin: number) => boolean;
type ParcelFootprint = Pick<ParcelPlan, "ring" | "n" | "obb">;
const CELL = 32;

function visitCells(
  x: number,
  z: number,
  rx: number,
  rz: number,
  visit: (key: string) => void,
): void {
  for (let ix = Math.floor((x - rx) / CELL); ix <= Math.floor((x + rx) / CELL); ix++) {
    for (let iz = Math.floor((z - rz) / CELL); iz <= Math.floor((z + rz) / CELL); iz++) {
      visit(`${ix},${iz}`);
    }
  }
}

/** Exact closed-segment intersection with an axis-aligned rectangle. */
function crossesBox(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  hw: number,
  hd: number,
): boolean {
  let start = 0;
  let end = 1;
  const axes: readonly (readonly [number, number, number])[] = [
    [ax, bx, hw],
    [az, bz, hd],
  ];
  for (const [a, b, half] of axes) {
    const delta = b - a;
    if (Math.abs(delta) < 1e-10) {
      if (Math.abs(a) > half) return false;
      continue;
    }
    const enter = (-half - a) / delta;
    const leave = (half - a) / delta;
    start = Math.max(start, Math.min(enter, leave));
    end = Math.min(end, Math.max(enter, leave));
    if (start > end) return false;
  }
  return true;
}

/** Index authoritative parcel rings once; query the entire rotated prop envelope.
 * Margin reserves room for facade projections. Vertex-only probes miss narrow
 * crossing walls, and the prop-claim hash contains no building geometry.
 */
export function buildParcelClearance(parcels: readonly ParcelFootprint[]): ParcelClearance {
  const cells = new Map<string, ParcelFootprint[]>();
  for (const parcel of parcels) {
    const o = parcel.obb;
    const rx = Math.abs(o.ex * o.halfA) + Math.abs(o.ez * o.halfB);
    const rz = Math.abs(o.ez * o.halfA) + Math.abs(o.ex * o.halfB);
    visitCells(o.cx, o.cz, rx, rz, (key) => {
      const bucket = cells.get(key);
      if (bucket) bucket.push(parcel);
      else cells.set(key, [parcel]);
    });
  }
  return (footprint, margin) => {
    const { x, z, yaw } = footprint;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const hw = footprint.halfWidth + margin;
    const hd = footprint.halfDepth + margin;
    const rx = Math.abs(cos * hw) + Math.abs(sin * hd);
    const rz = Math.abs(sin * hw) + Math.abs(cos * hd);
    const candidates = new Set<ParcelFootprint>();
    visitCells(x, z, rx, rz, (key) => {
      for (const parcel of cells.get(key) ?? []) candidates.add(parcel);
    });
    for (const parcel of candidates) {
      // Containment with no boundary intersection: the whole prop is indoors.
      if (pointInRing(parcel.ring, parcel.n, x, z)) return false;
      for (let i = 0; i < parcel.n; i++) {
        const j = (i + 1) % parcel.n;
        const ax = (parcel.ring[i * 2] ?? 0) - x;
        const az = (parcel.ring[i * 2 + 1] ?? 0) - z;
        const bx = (parcel.ring[j * 2] ?? 0) - x;
        const bz = (parcel.ring[j * 2 + 1] ?? 0) - z;
        if (
          crossesBox(
            ax * cos - az * sin,
            ax * sin + az * cos,
            bx * cos - bz * sin,
            bx * sin + bz * cos,
            hw,
            hd,
          )
        )
          return false;
      }
    }
    return true;
  };
}
