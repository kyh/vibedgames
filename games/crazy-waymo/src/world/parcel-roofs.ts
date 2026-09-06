import type { ParcelPlan } from "./parcel-plan";

/** Roof accents replace the top of the original volume; never increase clearance. */
export type RoofVariant =
  | { readonly kind: "mansard"; readonly rise: number; readonly inset: Float32Array }
  | {
      readonly kind: "turret";
      readonly rise: number;
      readonly cx: number;
      readonly cz: number;
      readonly radius: number;
    };

/** Rare historic corner roofs. Strict convexity makes every generated face stay in the parcel. */
export function roofVariantOf(p: ParcelPlan): RoofVariant | null {
  if (
    p.kind !== "rowhouse" ||
    p.character !== "victorian" ||
    p.storeys < 3 ||
    p.storeys > 5 ||
    p.front < 0 ||
    p.n < 4 ||
    p.n > 8
  )
    return null;
  const roll = (p.seed >>> 4) % 19;
  if (roll > 1) return null;
  const edges: { x: number; z: number; tx: number; tz: number; length: number }[] = [];
  for (let i = 0; i < p.n; i++) {
    const j = (i + 1) % p.n;
    const x = p.ring[i * 2] ?? 0;
    const z = p.ring[i * 2 + 1] ?? 0;
    const dx = (p.ring[j * 2] ?? 0) - x;
    const dz = (p.ring[j * 2 + 1] ?? 0) - z;
    const length = Math.hypot(dx, dz);
    if (length < 0.1) return null;
    edges.push({ x, z, tx: dx / length, tz: dz / length, length });
  }
  // Every vertex must be on the interior side of every edge. This also rejects folded rings.
  for (const edge of edges) {
    for (const vertex of edges) {
      if (edge.tx * (vertex.z - edge.z) - edge.tz * (vertex.x - edge.x) < -0.001) return null;
    }
  }
  const front = edges[p.front];
  if (!front || front.length < 3 || p.blind[p.front] === 1) return null;
  const candidates = [p.front, (p.front + 1) % p.n];
  for (const corner of candidates) {
    const before = (corner + p.n - 1) % p.n;
    const a = edges[before];
    const b = edges[corner];
    if (!a || !b || p.blind[before] === 1 || p.blind[corner] === 1 || a.length < 3 || b.length < 3)
      continue;
    const turn = a.tx * b.tz - a.tz * b.tx;
    if (turn < 0.7) continue;
    const radius = Math.min(0.95, Math.min(a.length, b.length) * 0.23);
    const nx = -a.tz - b.tz;
    const nz = a.tx + b.tx;
    const length = Math.hypot(nx, nz);
    const bisectorX = nx / length;
    const bisectorZ = nz / length;
    const insetDistance = (radius + 0.27) / Math.max(0.1, -b.tz * bisectorX + b.tx * bisectorZ);
    const cx = b.x + bisectorX * insetDistance;
    const cz = b.z + bisectorZ * insetDistance;
    // Entire circle inside all half-planes, not just a few sample points.
    if (edges.some((edge) => edge.tx * (cz - edge.z) - edge.tz * (cx - edge.x) < radius + 0.25))
      continue;
    if (roll === 0) return { kind: "turret", rise: 1.2, cx, cz, radius };
    const centerX = edges.reduce((sum, edge) => sum + edge.x, 0) / edges.length;
    const centerZ = edges.reduce((sum, edge) => sum + edge.z, 0) / edges.length;
    const inset = p.ring.map(
      (value, index) => value * 0.74 + (index % 2 === 0 ? centerX : centerZ) * 0.26,
    );
    return { kind: "mansard", rise: 0.85, inset };
  }
  return null;
}
