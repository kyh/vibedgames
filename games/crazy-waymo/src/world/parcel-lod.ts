import { distToRing, pointInRing } from "./parcel-plan";
import type { ParcelPlan } from "./parcel-plan";

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

const area = (ring: Float32Array, n: number): number => {
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    sum +=
      (ring[i * 2] ?? 0) * (ring[j * 2 + 1] ?? 0) - (ring[j * 2] ?? 0) * (ring[i * 2 + 1] ?? 0);
  }
  return sum / 2;
};

/** Does a polygon boundary segment enter the OPEN rectangle? Touches are fine. */
const cutsBox = (
  ax: number,
  az: number,
  bx: number,
  bz: number,
  ha: number,
  hb: number,
): boolean => {
  let lo = 0;
  let hi = 1;
  const dx = bx - ax;
  const dz = bz - az;
  if (Math.abs(dx) < 1e-9) {
    if (Math.abs(ax) >= ha) {
      return false;
    }
  } else {
    const t0 = (-ha - ax) / dx;
    const t1 = (ha - ax) / dx;
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
  }
  if (Math.abs(dz) < 1e-9) {
    if (Math.abs(az) >= hb) {
      return false;
    }
  } else {
    const t0 = (-hb - az) / dz;
    const t1 = (hb - az) / dz;
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
  }
  return hi > lo + 1e-8;
};

/** The OBB is only a candidate. Every accepted core lies wholly inside the source polygon. */
const interiorBox = (p: ParcelPlan, sourceArea: number): Float32Array | null => {
  const o = p.obb;
  const local = new Float64Array(p.n * 2);
  for (let i = 0; i < p.n; i += 1) {
    const x = (p.ring[i * 2] ?? 0) - o.cx;
    const z = (p.ring[i * 2 + 1] ?? 0) - o.cz;
    local[i * 2] = x * o.ex + z * o.ez;
    local[i * 2 + 1] = -x * o.ez + z * o.ex;
  }
  for (const [scaleA, scaleB] of BOX_SCALES) {
    const ha = o.halfA * scaleA - 0.035;
    const hb = o.halfB * scaleB - 0.035;
    if (ha <= 0.1 || hb <= 0.1 || ha * hb * 4 < sourceArea * 0.72) {
      continue;
    }
    let fits = true;
    for (let i = 0; i < p.n; i += 1) {
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
    if (!fits) {
      continue;
    }
    const ring = new Float32Array(8);
    let k = 0;
    for (const [a, b] of [
      [-ha, -hb],
      [ha, -hb],
      [ha, hb],
      [-ha, hb],
    ]) {
      if (a === undefined || b === undefined) {
        continue;
      }
      const x = o.cx + a * o.ex - b * o.ez;
      const z = o.cz + a * o.ez + b * o.ex;
      ring[k] = x;
      k += 1;
      ring[k] = z;
      k += 1;
      if (!pointInRing(p.ring, p.n, x, z)) {
        fits = false;
      }
    }
    if (fits) {
      return ring;
    }
  }
  return null;
};

const ringX = (p: ParcelPlan, i: number): number => p.ring[i * 2] ?? 0;
const ringZ = (p: ParcelPlan, i: number): number => p.ring[i * 2 + 1] ?? 0;
const ringTurn = (p: ParcelPlan, a: number, b: number, c: number): number =>
  (ringX(p, b) - ringX(p, a)) * (ringZ(p, c) - ringZ(p, a)) -
  (ringZ(p, b) - ringZ(p, a)) * (ringX(p, c) - ringX(p, a));

/** Whether triangle (a, b, c) can be clipped: a straight-segment point may be
 *  dropped (never a folded/backtracking edge); a real ear must hold no other vertex. */
const clippable = (
  p: ParcelPlan,
  keep: readonly number[],
  a: number,
  b: number,
  c: number,
  triangle: number,
): boolean => {
  if (Math.abs(triangle) < 1e-8) {
    return (
      (ringX(p, b) - ringX(p, a)) * (ringX(p, c) - ringX(p, b)) +
        (ringZ(p, b) - ringZ(p, a)) * (ringZ(p, c) - ringZ(p, b)) >=
      0
    );
  }
  for (const v of keep) {
    if (v === a || v === b || v === c) {
      continue;
    }
    if (
      ringTurn(p, a, b, v) >= -1e-8 &&
      ringTurn(p, b, c, v) >= -1e-8 &&
      ringTurn(p, c, a, v) >= -1e-8
    ) {
      return false;
    }
  }
  return true;
};

/** Remove tiny convex ears only. Every removed triangle was inside the source footprint. */
const trimEars = (p: ParcelPlan, sourceArea: number): Float32Array | null => {
  const keep = Array.from({ length: p.n }, (_, i) => i);
  const px = (i: number): number => ringX(p, i);
  const pz = (i: number): number => ringZ(p, i);
  const turn = (a: number, b: number, c: number): number => ringTurn(p, a, b, c);
  let removed = 0;
  while (keep.length > 4) {
    let best = -1;
    let smallest = Infinity;
    for (let k = 0; k < keep.length; k += 1) {
      const a = keep[(k + keep.length - 1) % keep.length] ?? 0;
      const b = keep[k] ?? 0;
      const c = keep[(k + 1) % keep.length] ?? 0;
      const triangle = turn(a, b, c) / 2;
      if (triangle < -1e-8 || triangle >= smallest || removed + triangle > sourceArea * 0.16) {
        continue;
      }
      if (!clippable(p, keep, a, b, c, triangle)) {
        continue;
      }
      best = k;
      smallest = Math.max(0, triangle);
    }
    if (best < 0) {
      break;
    }
    removed += smallest;
    keep.splice(best, 1);
  }
  if (keep.length >= p.n) {
    return null;
  }
  const ring = new Float32Array(keep.length * 2);
  for (const [i, v] of keep.entries()) {
    ring[i * 2] = px(v);
    ring[i * 2 + 1] = pz(v);
  }
  return ring;
};

/** A few street-clipped source rings fold back along the kerb. Ear clipping
 *  assumes a simple ring, so validate the output against the original even
 *  when the source violated that premise; rejection keeps its exact shape. */
const withinSource = (p: ParcelPlan, ring: Float32Array, n: number): boolean => {
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    for (const f of [0, 0.25, 0.5, 0.75]) {
      const x = (ring[i * 2] ?? 0) * (1 - f) + (ring[j * 2] ?? 0) * f;
      const z = (ring[i * 2 + 1] ?? 0) * (1 - f) + (ring[j * 2 + 1] ?? 0) * f;
      if (!pointInRing(p.ring, p.n, x, z) && distToRing(p.ring, p.n, x, z) > 0.0008) {
        return false;
      }
    }
  }
  return true;
};

/** The simplified edge best aligned with the source front, or -1 without one. */
const alignedFront = (p: ParcelPlan, ring: Float32Array, n: number): number => {
  if (p.front < 0) {
    return -1;
  }
  let front = -1;
  let best = -Infinity;
  const j = (p.front + 1) % p.n;
  const dx = ringX(p, j) - ringX(p, p.front);
  const dz = ringZ(p, j) - ringZ(p, p.front);
  for (let i = 0; i < n; i += 1) {
    const next = (i + 1) % n;
    const ex = (ring[next * 2] ?? 0) - (ring[i * 2] ?? 0);
    const ez = (ring[next * 2 + 1] ?? 0) - (ring[i * 2 + 1] ?? 0);
    const alignment = (dx * ex + dz * ez) / (Math.hypot(ex, ez) || 1);
    if (alignment > best) {
      best = alignment;
      front = i;
    }
  }
  return front;
};

/** Small roof/bay jogs are subpixel at this LOD. Preserve at least 72% of footprint area. */
export const distantFootprint = (p: ParcelPlan): Footprint => {
  if (p.hero || p.n <= 4) {
    return p;
  }
  const sourceArea = area(p.ring, p.n);
  if (sourceArea <= 0) {
    return p;
  }
  const ring = interiorBox(p, sourceArea) ?? trimEars(p, sourceArea);
  if (!ring || ring.length >= p.ring.length) {
    return p;
  }
  const n = ring.length / 2;
  if (!withinSource(p, ring, n)) {
    return p;
  }
  const front = alignedFront(p, ring, n);
  return { blind: new Uint8Array(n), front, n, ring };
};
