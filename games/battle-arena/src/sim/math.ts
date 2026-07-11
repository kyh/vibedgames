// Pure 2D math + deterministic RNG. The sim runs on a top-down plane (x, y);
// the renderer maps sim-y → world-z. No Three.js, no Math.random here — all
// randomness flows through the World's rngState so host migration is seamless.

export type Vec2 = { x: number; y: number };

export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });

export const dist2 = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

export const dist = (a: Vec2, b: Vec2): number => Math.sqrt(dist2(a, b));

export const len = (x: number, y: number): number => Math.sqrt(x * x + y * y);

/** Normalize (x,y); returns {x:0,y:0} for the zero vector. */
export function norm(x: number, y: number): Vec2 {
  const l = Math.sqrt(x * x + y * y);
  return l > 1e-6 ? { x: x / l, y: y / l } : { x: 0, y: 0 };
}

export const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Shortest signed angle delta from a to b, in (-π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Angle of a direction vector; 0 = +x, CCW positive. */
export const angleOf = (x: number, y: number): number => Math.atan2(y, x);

// ── Deterministic RNG (mulberry32) ───────────────────────────────────────────
// State is a plain int carried on the World, so the whole World stays JSON-
// serializable and a guest that takes over hosting continues the exact stream.

export type RngHolder = { rngState: number };

/** Advance the RNG; returns [0,1). Mutates holder.rngState. */
export function rand(h: RngHolder): number {
  let s = h.rngState | 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  h.rngState = s;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Uniform float in [lo, hi). */
export const randRange = (h: RngHolder, lo: number, hi: number): number => lo + rand(h) * (hi - lo);

/** Integer in [0, n). */
export const randInt = (h: RngHolder, n: number): number => Math.floor(rand(h) * n);

/** Pick a random element (undefined for an empty array). */
export const randPick = <T>(h: RngHolder, arr: readonly T[]): T | undefined =>
  arr.length ? arr[randInt(h, arr.length)] : undefined;
