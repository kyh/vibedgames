// Where a bot goes when it is not fighting: out of the gas, away from a
// stronger opponent, or toward the nearest loot that is still safe to reach.

import type { Cube, LootBox } from "../combat/combat";
import type { Gas } from "../combat/gas";
import type { Brawler } from "../entities/brawler";
import type { Game } from "../game";
import { clamp, dist } from "../utils";
import type { World } from "../world/world";
import type { Point } from "./bot";

/** Pull straight toward the arena centre until well inside the safe zone. */
export const escapeGoal = (world: World, gas: Gas, b: Brawler): Point => {
  const safeHalf = Math.max(0, gas.half - 4.5);
  const reach = Math.max(Math.abs(b.x), Math.abs(b.z), 0.001);
  const scale = Math.min(1, safeHalf / reach);
  return world.nearestOpen(b.x * scale, b.z * scale);
};

/** Run away from the target, biased a little toward the centre so we never flee into the gas. */
export const fleeGoal = (
  world: World,
  gas: Gas,
  b: Brawler,
  target: Brawler,
  range: number,
): Point => {
  const ux = (b.x - target.x) / (range || 1);
  const uz = (b.z - target.z) / (range || 1);
  const bound = Math.max(2, gas.half - 3);
  const x = clamp(b.x + ux * 6 - b.x * 0.15, -bound, bound);
  const z = clamp(b.z + uz * 6 - b.z * 0.15, -bound, bound);
  return world.nearestOpen(x, z);
};

/** Closest dropped power cube within 9 units that is not already in the gas. */
export const nearestCube = (game: Game, b: Brawler): Cube | null => {
  let best: Cube | null = null;
  let bestRange = 9;
  for (const cube of game.combat.cubes) {
    const range = dist(b.x, b.z, cube.x, cube.z);
    if (range < bestRange && game.gas.depthAt(cube.x, cube.z) < -0.5) {
      best = cube;
      bestRange = range;
    }
  }
  return best;
};

/** Closest intact loot box within 26 units, comfortably clear of the gas, that this bot has not given up on. */
export const nearestBox = (game: Game, b: Brawler): LootBox | null => {
  let best: LootBox | null = null;
  let bestRange = 26;
  for (const box of game.combat.boxes) {
    if (!box.alive || box.skipBy === b.id) {
      continue;
    }
    const range = dist(b.x, b.z, box.x, box.z);
    if (range < bestRange && game.gas.depthAt(box.x, box.z) < -2) {
      best = box;
      bestRange = range;
    }
  }
  return best;
};
