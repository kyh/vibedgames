// Pure 2D vector + geometry helpers shared by the simulation and renderer.
// No Phaser imports — this stays runnable in plain node for tests/headless sim.

export type Vec2 = { x: number; y: number };

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function len(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function scale(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, y: v.y * s };
}

/** Unit vector from a toward b; returns {0,0} if coincident. */
export function dir(a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { x: 0, y: 0 };
  return { x: dx / d, y: dy / d };
}

export function normalize(v: Vec2): Vec2 {
  const d = Math.hypot(v.x, v.y);
  if (d < 1e-6) return { x: 0, y: 0 };
  return { x: v.x / d, y: v.y / d };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Move `from` toward `to` by at most `maxStep` px. Returns the new point. */
export function moveToward(from: Vec2, to: Vec2, maxStep: number): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d <= maxStep || d < 1e-6) return { x: to.x, y: to.y };
  return { x: from.x + (dx / d) * maxStep, y: from.y + (dy / d) * maxStep };
}

/** Shortest distance from point p to segment ab (for skillshot-line hits). */
export function pointSegDist(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const ab2 = abx * abx + aby * aby;
  const t = ab2 < 1e-9 ? 0 : clamp((apx * abx + apy * aby) / ab2, 0, 1);
  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  return Math.hypot(p.x - cx, p.y - cy);
}

// The seedable PRNG now lives on the World as a plain integer state (see
// sim/types.ts `rand`) so the World stays JSON-serializable for multiplayer.
