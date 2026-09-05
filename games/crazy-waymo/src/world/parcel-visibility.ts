import { type ParcelPlan, pointInRing } from "./parcel-plan";
import { roofVariantOf } from "./parcel-roofs";

const CELL = 32;
type Bounds = { minX: number; minZ: number; maxX: number; maxZ: number };
type Volume = { plan: ParcelPlan; bounds: Bounds; area: number; top: number; solidTop: number };

function volume(plan: ParcelPlan): Volume {
  const bounds: Bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  let twiceArea = 0;
  for (let i = 0; i < plan.n; i++) {
    const j = (i + 1) % plan.n;
    const x = plan.ring[i * 2] ?? 0,
      z = plan.ring[i * 2 + 1] ?? 0;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minZ = Math.min(bounds.minZ, z);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxZ = Math.max(bounds.maxZ, z);
    twiceArea += x * (plan.ring[j * 2 + 1] ?? 0) - z * (plan.ring[j * 2] ?? 0);
  }
  const top = plan.seatY + plan.height;
  return {
    plan,
    bounds,
    area: Math.abs(twiceArea) / 2,
    top,
    solidTop: top - (roofVariantOf(plan)?.rise ?? 0),
  };
}

/** Boundary membership is exact; a nearby facade is never rounded into its neighbor. */
function covered(plan: ParcelPlan, x: number, z: number): boolean {
  if (pointInRing(plan.ring, plan.n, x, z)) return true;
  for (let i = 0; i < plan.n; i++) {
    const j = (i + 1) % plan.n;
    const ax = plan.ring[i * 2] ?? 0,
      az = plan.ring[i * 2 + 1] ?? 0;
    const bx = plan.ring[j * 2] ?? 0,
      bz = plan.ring[j * 2 + 1] ?? 0;
    if (
      (x - ax) * (bz - az) === (z - az) * (bx - ax) &&
      x >= Math.min(ax, bx) &&
      x <= Math.max(ax, bx) &&
      z >= Math.min(az, bz) &&
      z <= Math.max(az, bz)
    )
      return true;
  }
  return false;
}

/** Split a tested edge at every boundary crossing, including touches and collinear ends. */
function edgeCovered(outer: ParcelPlan, ax: number, az: number, bx: number, bz: number): boolean {
  const dx = bx - ax,
    dz = bz - az;
  const length2 = dx * dx + dz * dz;
  if (length2 === 0) return covered(outer, ax, az);
  const cuts = [0, 1];
  for (let i = 0; i < outer.n; i++) {
    const j = (i + 1) % outer.n;
    const cx = outer.ring[i * 2] ?? 0,
      cz = outer.ring[i * 2 + 1] ?? 0;
    const ex = (outer.ring[j * 2] ?? 0) - cx,
      ez = (outer.ring[j * 2 + 1] ?? 0) - cz;
    const determinant = dx * ez - dz * ex;
    if (determinant === 0) {
      if ((cx - ax) * dz !== (cz - az) * dx) continue;
      for (const t of [
        ((cx - ax) * dx + (cz - az) * dz) / length2,
        ((cx + ex - ax) * dx + (cz + ez - az) * dz) / length2,
      ]) {
        if (t > 0 && t < 1) cuts.push(t);
      }
    } else {
      const t = ((cx - ax) * ez - (cz - az) * ex) / determinant;
      const u = ((cx - ax) * dz - (cz - az) * dx) / determinant;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
    }
  }
  cuts.sort((a, b) => a - b);
  for (let i = 1; i < cuts.length; i++) {
    const t = ((cuts[i - 1] ?? 0) + (cuts[i] ?? 1)) * 0.5;
    if (!covered(outer, ax + dx * t, az + dz * t)) return false;
  }
  return true;
}

function contains(outer: Volume, inner: Volume): boolean {
  const a = outer.bounds,
    b = inner.bounds;
  if (
    outer.plan === inner.plan ||
    outer.plan.kind === "tower" ||
    outer.area < inner.area ||
    a.minX > b.minX ||
    a.minZ > b.minZ ||
    a.maxX < b.maxX ||
    a.maxZ < b.maxZ ||
    outer.plan.footY > inner.plan.footY ||
    outer.solidTop < inner.top
  )
    return false;
  // Equal volumes keep one deterministic representative, preferring measured survey data.
  if (
    outer.area === inner.area &&
    outer.plan.footY === inner.plan.footY &&
    outer.top === inner.top &&
    (outer.plan.hero === inner.plan.hero ? outer.plan.id >= inner.plan.id : !outer.plan.hero)
  )
    return false;
  for (let i = 0; i < inner.plan.n; i++) {
    const j = (i + 1) % inner.plan.n;
    const x = inner.plan.ring[i * 2] ?? 0,
      z = inner.plan.ring[i * 2 + 1] ?? 0;
    if (
      !covered(outer.plan, x, z) ||
      !edgeCovered(outer.plan, x, z, inner.plan.ring[j * 2] ?? 0, inner.plan.ring[j * 2 + 1] ?? 0)
    )
      return false;
  }
  return true;
}

/**
 * Survey/OSM overlap can put a second shop inside the same wall. Cull only fully
 * enclosed render volumes. Run once against the COMPLETE plan, before skyline /
 * cell / LOD partitioning. Authoritative plans and collision solids stay intact.
 */
export function visibleParcelPlans(plans: readonly ParcelPlan[]): readonly ParcelPlan[] {
  const volumes = plans.map(volume);
  const cells = new Map<string, Volume[]>();
  for (const candidate of volumes) {
    if (candidate.plan.kind === "tower") continue; // upper shafts have setbacks
    const bounds = candidate.bounds;
    for (let x = Math.floor(bounds.minX / CELL); x <= Math.floor(bounds.maxX / CELL); x++) {
      for (let z = Math.floor(bounds.minZ / CELL); z <= Math.floor(bounds.maxZ / CELL); z++) {
        const key = `${x},${z}`;
        const bucket = cells.get(key);
        if (bucket) bucket.push(candidate);
        else cells.set(key, [candidate]);
      }
    }
  }
  return volumes
    .filter((inner) => {
      const key = `${Math.floor((inner.plan.ring[0] ?? 0) / CELL)},${Math.floor((inner.plan.ring[1] ?? 0) / CELL)}`;
      return !(cells.get(key) ?? []).some((outer) => contains(outer, inner));
    })
    .map((candidate) => candidate.plan);
}
