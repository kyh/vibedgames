import { TILE } from "../config";
import { World } from "./world";
import type { WorldObject } from "./world";
import { CELL } from "./worldmap";
import type { WorldMap, WorldMapSprite } from "./worldmap";

/* oxlint-disable no-bitwise, unicorn/prefer-math-trunc -- mulberry32: the int32 wraps and xor-shift mixing ARE the algorithm */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};
/* oxlint-enable no-bitwise, unicorn/prefer-math-trunc */

export interface GenResult {
  world: World;
  spawn: { tx: number; ty: number };
}

// Interaction hotspots laid over the map's buildings. Visuals AND collision come
// from the map tiles — these are non-solid target zones reaching one row
// past each building's south face so the player can always face into them.
const ANCHORS: Omit<WorldObject, "id">[] = [
  { h: 3, hp: 1, maxHp: 1, solid: false, tx: 31, ty: 15, type: "house", w: 4 },
  { h: 3, hp: 1, maxHp: 1, solid: false, tx: 6, ty: 10, type: "bin", w: 2 },
  { h: 3, hp: 1, maxHp: 1, solid: false, tx: 56, ty: 28, type: "shop", w: 4 },
  { h: 3, hp: 1, maxHp: 1, solid: false, tx: 44, ty: 41, type: "cave", w: 3 },
  { h: 4, hp: 1, maxHp: 1, solid: false, tx: 62, ty: 10, type: "barn", w: 3 },
  // the fenced pen SW of the barn — the GM scene's coop sits on a decorative
  // floating sky island with no walkable connection
  { h: 3, hp: 1, maxHp: 1, solid: false, tx: 58, ty: 13, type: "coop", w: 3 },
];

export const SPAWN = { tx: 31, ty: 16 } as const;
export const MINE_EXIT = { tx: 44, ty: 42 } as const;

// the sandy excavation canyon by the mine cave — rocks respawn here (the
// bottom-left yard in the GM scene has no walkable connection to the map)
const ROCK_YARD = { x0: 23, x1: 30, y0: 41, y1: 43 } as const;

interface Consumed {
  sprite: WorldMapSprite;
  tx: number;
  ty: number;
  kind: "tree" | "forage";
}

// World-map tree/mushroom placements that stand on walkable ground become live
// world objects (choppable / forageable). Depends only on the static map
// terrain (never on live objects), so generation and every later render boot
// compute the identical set — chopped trees stay gone.
export const consumedSprites = (map: WorldMap, world: World): Consumed[] => {
  const out: Consumed[] = [];
  const taken = new Set<number>();
  for (const s of map.sprites) {
    const def = map.deco[s.sprite];
    if (!def) {
      continue;
    }
    const isTree = s.sprite === "spr_deco_tree_01" || s.sprite === "spr_deco_tree_02";
    const isMushroom = s.sprite.startsWith("spr_deco_mushroom_");
    if (!isTree && !isMushroom) {
      continue;
    }
    const baseX = s.x - def.ox + def.fw / 2;
    const baseY = s.y - def.oy + def.fh;
    const tx = Math.floor(baseX / TILE);
    const ty = Math.floor((baseY - 1) / TILE);
    const k = world.cellKind(tx, ty);
    const walkable = k === CELL.grass || k === CELL.sand || k === CELL.dirt;
    const key = ty * map.w + tx;
    if (!walkable || taken.has(key)) {
      continue;
    }
    taken.add(key);
    out.push({ kind: isTree ? "tree" : "forage", sprite: s, tx, ty });
  }
  return out;
};

export const generateFarm = (seed: number, worldMap: WorldMap): GenResult => {
  const rng = mulberry32(seed);
  const w = new World(worldMap);

  for (const a of ANCHORS) {
    w.addObject(a);
  }

  for (const c of consumedSprites(worldMap, w)) {
    if (c.kind === "tree") {
      w.addObject({
        h: 1,
        hp: 3,
        maxHp: 3,
        tx: c.tx,
        ty: c.ty,
        type: "tree",
        variant: c.sprite.sprite === "spr_deco_tree_02" ? "tree2" : "tree",
        w: 1,
      });
    } else {
      w.addObject({
        h: 1,
        hp: 1,
        maxHp: 1,
        solid: false,
        tx: c.tx,
        ty: c.ty,
        type: "forage",
        variant: c.sprite.sprite.includes("blue") ? "mushroom_blue" : "mushroom_red",
        w: 1,
      });
    }
  }

  // rocks in the excavated yard
  let rocks = 0;
  for (let attempt = 0; attempt < 400 && rocks < 8; attempt += 1) {
    const tx = ROCK_YARD.x0 + Math.floor(rng() * (ROCK_YARD.x1 - ROCK_YARD.x0 + 1));
    const ty = ROCK_YARD.y0 + Math.floor(rng() * (ROCK_YARD.y1 - ROCK_YARD.y0 + 1));
    const k = w.cellKind(tx, ty);
    if ((k !== CELL.dirt && k !== CELL.sand) || w.objectAt(tx, ty) !== null) {
      continue;
    }
    w.addObject({ h: 1, hp: 3, maxHp: 3, tx, ty, type: "rock", w: 1 });
    rocks += 1;
  }

  return { spawn: SPAWN, world: w };
};
