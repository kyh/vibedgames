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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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
