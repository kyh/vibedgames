import { distToRing, type ParcelPlan, pointInRing } from "./parcel-plan";

/** Render-only footprint. Collision plans and their exact lot lines never change. */
type Footprint = Pick<ParcelPlan, "ring" | "n" | "front" | "blind">;

const BOX_SCALES: readonly (readonly [number, number])[] = [
  [1, 1],
  [0.96, 1],
  [1, 0.96],
  [0.96, 0.96],
  [0.9, 1],
  [1, 0.9],
  [0.9, 0.96],
  [0.96, 0.9],
  [0.9, 0.9],
  [0.8, 1],
  [1, 0.8],
  [0.85, 0.9],
  [0.9, 0.85],
  [0.8, 0.9],
  [0.9, 0.8],
];

function area(ring: Float32Array, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum +=
      (ring[i * 2] ?? 0) * (ring[j * 2 + 1] ?? 0) - (ring[j * 2] ?? 0) * (ring[i * 2 + 1] ?? 0);
  }
  return sum / 2;
}

/** Does a polygon boundary segment enter the OPEN rectangle? Touches are fine. */
function cutsBox(ax: number, az: number, bx: number, bz: number, ha: number, hb: number): boolean {
  let lo = 0;
  let hi = 1;
  const dx = bx - ax;
  const dz = bz - az;
  if (Math.abs(dx) < 1e-9) {
    if (Math.abs(ax) >= ha) return false;
  } else {
    const t0 = (-ha - ax) / dx;
    const t1 = (ha - ax) / dx;
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
  }
  if (Math.abs(dz) < 1e-9) {
    if (Math.abs(az) >= hb) return false;
  } else {
    const t0 = (-hb - az) / dz;
    const t1 = (hb - az) / dz;
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
  }
  return hi > lo + 1e-8;
}

/** The OBB is only a candidate. Every accepted core lies wholly inside the source polygon. */
function interiorBox(p: ParcelPlan, sourceArea: number): Float32Array | null {
  const o = p.obb;
  const local = new Float64Array(p.n * 2);
  for (let i = 0; i < p.n; i++) {
    const x = (p.ring[i * 2] ?? 0) - o.cx;
    const z = (p.ring[i * 2 + 1] ?? 0) - o.cz;
    local[i * 2] = x * o.ex + z * o.ez;
    local[i * 2 + 1] = -x * o.ez + z * o.ex;
  }
  for (const [scaleA, scaleB] of BOX_SCALES) {
    const ha = o.halfA * scaleA - 0.035;
    const hb = o.halfB * scaleB - 0.035;
    if (ha <= 0.1 || hb <= 0.1 || ha * hb * 4 < sourceArea * 0.72) continue;
    let fits = true;
    for (let i = 0; i < p.n; i++) {
      const j = (i + 1) % p.n;
      if (
        cutsBox(
          local[i * 2] ?? 0,
          local[i * 2 + 1] ?? 0,
          local[j * 2] ?? 0,
          local[j * 2 + 1] ?? 0,
          ha - 1e-5,
          hb - 1e-5,
        )
      ) {
        fits = false;
        break;
      }
    }
    if (!fits) continue;
    const ring = new Float32Array(8);
    let k = 0;
    for (const [a, b] of [
      [-ha, -hb],
      [ha, -hb],
      [ha, hb],
      [-ha, hb],
    ]) {
      if (a === undefined || b === undefined) continue;
      const x = o.cx + a * o.ex - b * o.ez;
      const z = o.cz + a * o.ez + b * o.ex;
      ring[k++] = x;
      ring[k++] = z;
      if (!pointInRing(p.ring, p.n, x, z)) fits = false;
    }
    if (fits) return ring;
  }
  return null;
}

/** Remove tiny convex ears only. Every removed triangle was inside the source footprint. */
function trimEars(p: ParcelPlan, sourceArea: number): Float32Array | null {
  const keep = Array.from({ length: p.n }, (_, i) => i);
  const px = (i: number): number => p.ring[i * 2] ?? 0;
  const pz = (i: number): number => p.ring[i * 2 + 1] ?? 0;
  const turn = (a: number, b: number, c: number): number =>
    (px(b) - px(a)) * (pz(c) - pz(a)) - (pz(b) - pz(a)) * (px(c) - px(a));
  let removed = 0;
  while (keep.length > 4) {
    let best = -1;
    let smallest = Infinity;
    for (let k = 0; k < keep.length; k++) {
      const a = keep[(k + keep.length - 1) % keep.length] ?? 0;
      const b = keep[k] ?? 0;
      const c = keep[(k + 1) % keep.length] ?? 0;
      const triangle = turn(a, b, c) / 2;
      if (triangle < -1e-8 || triangle >= smallest || removed + triangle > sourceArea * 0.16)
        continue;
      if (Math.abs(triangle) < 1e-8) {
        // Drop a point on a straight segment, never a folded/backtracking edge.
        if ((px(b) - px(a)) * (px(c) - px(b)) + (pz(b) - pz(a)) * (pz(c) - pz(b)) < 0) continue;
      } else {
        let ear = true;
        for (const v of keep) {
          if (v === a || v === b || v === c) continue;
          if (turn(a, b, v) >= -1e-8 && turn(b, c, v) >= -1e-8 && turn(c, a, v) >= -1e-8) {
            ear = false;
            break;
          }
        }
        if (!ear) continue;
      }
      best = k;
      smallest = Math.max(0, triangle);
    }
    if (best < 0) break;
    removed += smallest;
    keep.splice(best, 1);
  }
  if (keep.length >= p.n) return null;
  const ring = new Float32Array(keep.length * 2);
  keep.forEach((v, i) => {
    ring[i * 2] = px(v);
    ring[i * 2 + 1] = pz(v);
  });
  return ring;
}

/** Small roof/bay jogs are subpixel at this LOD. Preserve at least 72% of footprint area. */
export function distantFootprint(p: ParcelPlan): Footprint {
  if (p.hero || p.n <= 4) return p;
  const sourceArea = area(p.ring, p.n);
  if (sourceArea <= 0) return p;
  const ring = interiorBox(p, sourceArea) ?? trimEars(p, sourceArea);
  if (!ring || ring.length >= p.ring.length) return p;
  const n = ring.length / 2;
  // A few street-clipped source rings fold back along the kerb. Ear clipping
  // assumes a simple ring, so validate the output against the original even
  // when the source violated that premise; rejection keeps its exact shape.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    for (const f of [0, 0.25, 0.5, 0.75]) {
      const x = (ring[i * 2] ?? 0) * (1 - f) + (ring[j * 2] ?? 0) * f;
      const z = (ring[i * 2 + 1] ?? 0) * (1 - f) + (ring[j * 2 + 1] ?? 0) * f;
      if (!pointInRing(p.ring, p.n, x, z) && distToRing(p.ring, p.n, x, z) > 0.0008) return p;
    }
  }
  let front = -1;
  let best = -Infinity;
  if (p.front >= 0) {
    const j = (p.front + 1) % p.n;
    const dx = (p.ring[j * 2] ?? 0) - (p.ring[p.front * 2] ?? 0);
    const dz = (p.ring[j * 2 + 1] ?? 0) - (p.ring[p.front * 2 + 1] ?? 0);
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const ex = (ring[next * 2] ?? 0) - (ring[i * 2] ?? 0);
      const ez = (ring[next * 2 + 1] ?? 0) - (ring[i * 2 + 1] ?? 0);
      const alignment = (dx * ex + dz * ez) / (Math.hypot(ex, ez) || 1);
      if (alignment > best) {
        best = alignment;
        front = i;
      }
    }
  }
  return { ring, n, front, blind: new Uint8Array(n) };
}
