import type { Solid } from "../shared/types";
import { waterBodyContains, type WaterBody } from "./water";

type Box = Pick<Solid, "minX" | "maxX" | "minZ" | "maxZ">;
type Point = { readonly x: number; readonly z: number };
const EDGE_RESOLUTION = 0.4;

function corners(box: Box): Point[] {
  return [
    { x: box.minX, z: box.minZ },
    { x: box.maxX, z: box.minZ },
    { x: box.maxX, z: box.maxZ },
    { x: box.minX, z: box.maxZ },
  ];
}

/** Exact convex footprint overlap: ellipse becomes a unit circle in local
 * coordinates; rectangle uses separating axes against the unit square. */
export function waterIntersectsReservation(body: WaterBody, box: Box): boolean {
  const reach = body.halfX + body.halfZ;
  if (
    box.minX > body.x + reach ||
    box.maxX < body.x - reach ||
    box.minZ > body.z + reach ||
    box.maxZ < body.z - reach
  )
    return false;
  if (body.x >= box.minX && body.x <= box.maxX && body.z >= box.minZ && body.z <= box.maxZ)
    return true;
  const c = Math.cos(body.yaw),
    s = Math.sin(body.yaw);
  const polygon = corners(box).map((p) => ({
    x: ((p.x - body.x) * c - (p.z - body.z) * s) / body.halfX,
    z: ((p.x - body.x) * s + (p.z - body.z) * c) / body.halfZ,
  }));
  if (body.kind === "ellipse") {
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length];
      if (!a || !b) continue;
      const dx = b.x - a.x,
        dz = b.z - a.z,
        length2 = dx * dx + dz * dz;
      const t = length2 > 0 ? Math.max(0, Math.min(1, -(a.x * dx + a.z * dz) / length2)) : 0;
      if ((a.x + t * dx) ** 2 + (a.z + t * dz) ** 2 <= 1) return true;
    }
    return false;
  }
  const axes = [
    { x: 1, z: 0 },
    { x: 0, z: 1 },
  ];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    if (a && b) axes.push({ x: a.z - b.z, z: b.x - a.x });
  }
  return axes.every((axis) => {
    const projections = polygon.map((p) => p.x * axis.x + p.z * axis.z);
    const radius = Math.abs(axis.x) + Math.abs(axis.z);
    return Math.min(...projections) <= radius && Math.max(...projections) >= -radius;
  });
}

/** Generic lot-cell monument reservations cannot occupy authored water.
 * Preserve their exterior with adaptive boxes; only the boundary's final
 * <0.4u cells are opened. Real rim/architectural solids never enter here.
 * The narrow exterior tolerance stays below a tire width, while exact overlap
 * testing guarantees no retained box reaches into the water footprint. */
export function carveWaterReservations(
  reservations: readonly Solid[],
  bodies: readonly WaterBody[],
): Solid[] {
  const retained: Solid[] = [];
  const visit = (box: Solid, candidates: readonly WaterBody[]): void => {
    const overlapping = candidates.filter((body) => waterIntersectsReservation(body, box));
    if (overlapping.length === 0) {
      retained.push(box);
      return;
    }
    const points = corners(box);
    if (overlapping.some((body) => points.every((p) => waterBodyContains(body, p.x, p.z)))) return;
    const width = box.maxX - box.minX,
      depth = box.maxZ - box.minZ;
    if (Math.max(width, depth) <= EDGE_RESOLUTION) return;
    if (width >= depth) {
      const mid = (box.minX + box.maxX) / 2;
      visit({ ...box, maxX: mid }, overlapping);
      visit({ ...box, minX: mid }, overlapping);
    } else {
      const mid = (box.minZ + box.maxZ) / 2;
      visit({ ...box, maxZ: mid }, overlapping);
      visit({ ...box, minZ: mid }, overlapping);
    }
  };
  for (const reservation of reservations) {
    if (reservation.yaw !== undefined && reservation.yaw !== 0)
      throw new Error("Water reservation must be axis-aligned");
    visit(reservation, bodies);
  }
  return retained;
}
