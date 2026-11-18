import { WORLD, buildBlockers, cellElev, isRampCell } from "../data/map";
import { NavGrid } from "./grid";
import type { Vec2 } from "./math";

let _nav: NavGrid | null = null;

export const nav = () => {
  if (!_nav) {
    _nav = new NavGrid(WORLD.width, WORLD.height, WORLD.cell, buildBlockers(), {
      elev: (c, r) => cellElev(c, r),
      ramp: (c, r) => isRampCell(c, r),
    });
  }

  return _nav;
};

export const findPath = (from: Vec2, to: Vec2) => {
  const path = nav().findPath(from, to);

  return path ?? [{ x: to.x, y: to.y }];
};
