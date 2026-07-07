// Lazily-built navigation grid for the (static) map. Heroes A* against this;
// creeps follow authored lane waypoints and only steer locally.

import { WORLD, buildBlockers, cellElev, isRampCell } from "../data/map";
import { NavGrid } from "./grid";
import type { Vec2 } from "./math";

let _nav: NavGrid | null = null;

export function nav(): NavGrid {
  if (!_nav)
    _nav = new NavGrid(WORLD.width, WORLD.height, WORLD.cell, buildBlockers(), {
      elev: (c, r) => cellElev(c, r),
      ramp: (c, r) => isRampCell(c, r),
    });
  return _nav;
}

export function findPath(from: Vec2, to: Vec2): Vec2[] {
  const path = nav().findPath(from, to);
  return path ?? [{ x: to.x, y: to.y }];
}
