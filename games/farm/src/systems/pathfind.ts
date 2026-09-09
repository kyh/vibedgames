import { MAP_H, MAP_W, TILE } from "../config";
import type { World } from "../world/world";

export interface Waypoint {
  x: number;
  y: number;
}

const W = MAP_W;
const H = MAP_H;

const inMap = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;

interface Flood {
  dist: Int32Array;
  parent: Int32Array;
}

// BFS from `start` over walkable cells (8-dir, no corner cutting). The queue
// is iterated while it grows — array iterators read length lazily.
const flood = (world: World, start: number): Flood => {
  const dist = new Int32Array(W * H).fill(-1);
  const parent = new Int32Array(W * H).fill(-1);
  const queue: number[] = [start];
  dist[start] = 0;
  const walkable = (x: number, y: number) => inMap(x, y) && !world.isSolidTile(x, y);
  for (const cur of queue) {
    const cx = cur % W;
    const cy = Math.trunc(cur / W);
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        if (ox === 0 && oy === 0) {
          continue;
        }
        const nx = cx + ox;
        const ny = cy + oy;
        if (!walkable(nx, ny)) {
          continue;
        }
        // diagonals only when both orthogonal cells are open
        if (ox !== 0 && oy !== 0 && (!walkable(cx + ox, cy) || !walkable(cx, cy + oy))) {
          continue;
        }
        const ni = ny * W + nx;
        if (dist[ni] !== -1) {
          continue;
        }
        dist[ni] = (dist[cur] ?? 0) + 1;
        parent[ni] = cur;
        queue.push(ni);
      }
    }
  }
  return { dist, parent };
};

// The clicked cell if reachable, else the nearest reachable cell beside it.
const pickGoal = (dist: Int32Array, tx: number, ty: number): number => {
  const clicked = ty * W + tx;
  if ((dist[clicked] ?? -1) >= 0) {
    return clicked;
  }
  let goal = -1;
  let best = Infinity;
  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      const nx = tx + ox;
      const ny = ty + oy;
      if (!inMap(nx, ny)) {
        continue;
      }
      const d = dist[ny * W + nx] ?? -1;
      if (d >= 0 && d < best) {
        best = d;
        goal = ny * W + nx;
      }
    }
  }
  return goal;
};

const tracePath = (parent: Int32Array, start: number, goal: number): Waypoint[] => {
  const path: Waypoint[] = [];
  for (let c = goal; c !== -1 && c !== start; c = parent[c] ?? -1) {
    path.push({ x: (c % W) * TILE + TILE / 2, y: Math.trunc(c / W) * TILE + TILE / 2 + 1 });
  }
  path.reverse();
  return path;
};

/**
 * BFS over walkable cells (8-dir, no corner cutting) from `from` to (tx,ty),
 * as pixel waypoints. If the target cell is blocked (water, props, buildings)
 * the route leads to the nearest reachable cell beside it; empty when the
 * walker is already there or nothing connects.
 * Drives click-to-move, and the trailer director's scripted approaches — the
 * yards are split by fences, so a straight-line steer walks into a wall.
 */
export const pathTo = (
  world: World,
  from: { tx: number; ty: number },
  tx: number,
  ty: number,
): Waypoint[] => {
  const start = from.ty * W + from.tx;
  const { dist, parent } = flood(world, start);
  const goal = pickGoal(dist, tx, ty);
  if (goal < 0 || goal === start) {
    return [];
  }
  return tracePath(parent, start, goal);
};
