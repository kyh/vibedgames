import type { Point } from "./types";
import { WORLD_WIDTH, WORLD_HEIGHT } from "./constants";

const PI = Math.PI;
const TWO_PI = PI * 2;
export const DEG_TO_RAD = PI / 180;

export const point = (x = 0, y = 0): Point => ({ x, y });

export const add = (a: Point, b: Point): Point => ({
  x: a.x + b.x,
  y: a.y + b.y,
});

export const sub = (a: Point, b: Point): Point => ({
  x: a.x - b.x,
  y: a.y - b.y,
});

export const scale = (p: Point, s: number): Point => ({
  x: p.x * s,
  y: p.y * s,
});

export const length = (p: Point): number =>
  Math.sqrt(p.x * p.x + p.y * p.y);

export const normalize = (p: Point, thickness = 1): Point => {
  const len = length(p);
  if (len === 0) return { x: 0, y: 0 };
  return { x: (p.x / len) * thickness, y: (p.y / len) * thickness };
};

export const angle = (p: Point): number => Math.atan2(p.y, p.x);

export const polar = (len: number, ang: number): Point => ({
  x: len * Math.cos(ang),
  y: len * Math.sin(ang),
});

export const distance = (a: Point, b: Point): number =>
  length(sub(a, b));

export const randUniform = (max: number, min = 0): number =>
  Math.random() * (max - min) + min;

export const randInt = (max: number, min = 0): number =>
  Math.floor(Math.random() * (max - min + 1) + min);

/** Wrap a coordinate into [0, max) */
export const wrap = (v: number, max: number): number =>
  ((v % max) + max) % max;

/** Wrap a point into world bounds */
export const wrapPoint = (p: Point): Point => ({
  x: wrap(p.x, WORLD_WIDTH),
  y: wrap(p.y, WORLD_HEIGHT),
});

/**
 * Shortest signed distance on a wrapping axis.
 * Returns value in [-max/2, max/2].
 */
export const wrapDelta = (from: number, to: number, max: number): number => {
  const d = ((to - from) % max + max) % max;
  return d > max / 2 ? d - max : d;
};

/** Shortest vector from a to b in wrapping world */
export const wrapSub = (a: Point, b: Point): Point => ({
  x: wrapDelta(a.x, b.x, WORLD_WIDTH),
  y: wrapDelta(a.y, b.y, WORLD_HEIGHT),
});

/**
 * Line segment intersection test.
 * Returns true if segment (a1,a2) intersects segment (b1,b2).
 */
export const segmentsIntersect = (
  a1: Point,
  a2: Point,
  b1: Point,
  b2: Point,
): boolean => {
  const ax = a2.x - a1.x;
  const ay = a2.y - a1.y;
  const bx = b2.x - b1.x;
  const by = b2.y - b1.y;
  return (
    (ax * (b1.y - a1.y) - ay * (b1.x - a1.x)) *
      (ax * (b2.y - a1.y) - ay * (b2.x - a1.x)) <=
      0 &&
    (bx * (a1.y - b1.y) - by * (a1.x - b1.x)) *
      (bx * (a2.y - b1.y) - by * (a2.x - b1.x)) <=
      0
  );
};

/** Check if a point is within radius of another point (circle collision) */
export const circleContains = (
  center: Point,
  radius: number,
  p: Point,
): boolean => {
  const dx = wrapDelta(center.x, p.x, WORLD_WIDTH);
  const dy = wrapDelta(center.y, p.y, WORLD_HEIGHT);
  return dx * dx + dy * dy <= radius * radius;
};

/**
 * Check if a line segment intersects a circle.
 * Uses closest-point-on-segment approach.
 */
export const segmentCircleIntersect = (
  p1: Point,
  p2: Point,
  center: Point,
  radius: number,
): boolean => {
  // Work in wrap-relative coords from p1
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const cx = wrapDelta(p1.x, center.x, WORLD_WIDTH);
  const cy = wrapDelta(p1.y, center.y, WORLD_HEIGHT);

  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return cx * cx + cy * cy <= radius * radius;

  let t = (cx * dx + cy * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const closestX = t * dx;
  const closestY = t * dy;
  const distSq = (cx - closestX) * (cx - closestX) + (cy - closestY) * (cy - closestY);
  return distSq <= radius * radius;
};

/** Clamp a point to world bounds */
export const clampPoint = (p: Point): Point => ({
  x: Math.max(0, Math.min(WORLD_WIDTH, p.x)),
  y: Math.max(0, Math.min(WORLD_HEIGHT, p.y)),
});

/** Check if a point is inside the world (with optional margin) */
export const inWorld = (p: Point, margin = 0): boolean =>
  p.x >= -margin && p.x <= WORLD_WIDTH + margin &&
  p.y >= -margin && p.y <= WORLD_HEIGHT + margin;

/** Generate a random point in the world, away from edges */
export const randomWorldPoint = (margin = 300): Point => ({
  x: randUniform(WORLD_WIDTH - margin * 2, margin),
  y: randUniform(WORLD_HEIGHT - margin * 2, margin),
});

export { PI, TWO_PI };
