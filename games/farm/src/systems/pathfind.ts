import { MAP_H, MAP_W, TILE } from "../config";
import type { World } from "../world/world";

export type Waypoint = { x: number; y: number };

/**
 * BFS over walkable cells (8-dir, no corner cutting) from `from` to (tx,ty),
 * as pixel waypoints. If the target cell is blocked (water, props, buildings)
 * the route leads to the nearest reachable cell beside it; empty when the
 * walker is already there or nothing connects.
 * Drives click-to-move, and the trailer director's scripted approaches — the
 * yards are split by fences, so a straight-line steer walks into a wall.
 */
export function pathTo(
  world: World,
  from: { tx: number; ty: number },
  tx: number,
  ty: number,
): Waypoint[] {
  const W = MAP_W;
  const H = MAP_H;
  const start = from.ty * W + from.tx;
  const dist = new Int32Array(W * H).fill(-1);
  const parent = new Int32Array(W * H).fill(-1);
  const queue: number[] = [start];
  dist[start] = 0;
  const walkable = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < W && y < H && !world.isSolidTile(x, y);
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    if (cur === undefined) break;
    const cx = cur % W;
    const cy = (cur / W) | 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const nx = cx + ox;
        const ny = cy + oy;
        if (!walkable(nx, ny)) continue;
        // diagonals only when both orthogonal cells are open
        if (ox !== 0 && oy !== 0 && (!walkable(cx + ox, cy) || !walkable(cx, cy + oy))) continue;
        const ni = ny * W + nx;
        if (dist[ni] !== -1) continue;
        dist[ni] = (dist[cur] ?? 0) + 1;
        parent[ni] = cur;
        queue.push(ni);
      }
    }
  }
  const clicked = ty * W + tx;
  let goal = -1;
  if ((dist[clicked] ?? -1) >= 0) goal = clicked;
  else {
    let best = Infinity;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nx = tx + ox;
        const ny = ty + oy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const d = dist[ny * W + nx] ?? -1;
        if (d >= 0 && d < best) {
          best = d;
          goal = ny * W + nx;
        }
      }
    }
  }
  if (goal < 0 || goal === start) return [];
  const path: Waypoint[] = [];
  for (let c = goal; c !== -1 && c !== start; c = parent[c] ?? -1) {
    path.push({ x: (c % W) * TILE + TILE / 2, y: ((c / W) | 0) * TILE + TILE / 2 + 1 });
  }
  path.reverse();
  return path;
}
