import { TILE } from "../config";
import { World, type WorldObject } from "./world";
import { CELL, type TracedMap, type TracedSprite } from "./traced";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type GenResult = { world: World; spawn: { tx: number; ty: number } };

// Interaction hotspots laid over traced buildings. Visuals AND collision come
// from the traced tiles — these are non-solid target zones reaching one row
// past each building's south face so the player can always face into them.
const ANCHORS: Omit<WorldObject, "id">[] = [
  { type: "house", tx: 31, ty: 15, w: 4, h: 3, hp: 1, maxHp: 1, solid: false },
  { type: "bin", tx: 6, ty: 10, w: 2, h: 3, hp: 1, maxHp: 1, solid: false },
  { type: "shop", tx: 56, ty: 28, w: 4, h: 3, hp: 1, maxHp: 1, solid: false },
  { type: "cave", tx: 44, ty: 41, w: 3, h: 3, hp: 1, maxHp: 1, solid: false },
  { type: "barn", tx: 62, ty: 10, w: 3, h: 4, hp: 1, maxHp: 1, solid: false },
  // the fenced pen SW of the barn — the GM scene's coop sits on a decorative
  // floating sky island with no walkable connection
  { type: "coop", tx: 58, ty: 13, w: 3, h: 3, hp: 1, maxHp: 1, solid: false },
];

export const SPAWN = { tx: 31, ty: 16 } as const;
export const MINE_EXIT = { tx: 44, ty: 42 } as const;

// the sandy excavation canyon by the mine cave — rocks respawn here (the
// bottom-left yard in the GM scene has no walkable connection to the map)
const ROCK_YARD = { x0: 23, y0: 41, x1: 30, y1: 43 } as const;

type Consumed = { sprite: TracedSprite; tx: number; ty: number; kind: "tree" | "forage" };

// Traced tree/mushroom placements that stand on walkable ground become live
// world objects (choppable / forageable). Depends only on the static traced
// terrain (never on live objects), so generation and every later render boot
// compute the identical set — chopped trees stay gone.
export function consumedSprites(map: TracedMap, world: World): Consumed[] {
  const out: Consumed[] = [];
  const taken = new Set<number>();
  for (const s of map.sprites) {
    const def = map.deco[s.sprite];
    if (!def) continue;
    const isTree = s.sprite === "spr_deco_tree_01" || s.sprite === "spr_deco_tree_02";
    const isMushroom = s.sprite.startsWith("spr_deco_mushroom_");
    if (!isTree && !isMushroom) continue;
    const baseX = s.x - def.ox + def.fw / 2;
    const baseY = s.y - def.oy + def.fh;
    const tx = Math.floor(baseX / TILE);
    const ty = Math.floor((baseY - 1) / TILE);
    const k = world.cellKind(tx, ty);
    const walkable = k === CELL.grass || k === CELL.sand || k === CELL.dirt;
    const key = ty * map.w + tx;
    if (!walkable || taken.has(key)) continue;
    taken.add(key);
    out.push({ sprite: s, tx, ty, kind: isTree ? "tree" : "forage" });
  }
  return out;
}

export function generateFarm(seed: number, traced: TracedMap): GenResult {
  const rng = mulberry32(seed);
  const w = new World(traced);

  for (const a of ANCHORS) w.addObject(a);

  for (const c of consumedSprites(traced, w)) {
    if (c.kind === "tree") {
      w.addObject({
        type: "tree",
        tx: c.tx,
        ty: c.ty,
        w: 1,
        h: 1,
        hp: 3,
        maxHp: 3,
        variant: c.sprite.sprite === "spr_deco_tree_02" ? "tree2" : "tree",
      });
    } else {
      w.addObject({
        type: "forage",
        tx: c.tx,
        ty: c.ty,
        w: 1,
        h: 1,
        hp: 1,
        maxHp: 1,
        variant: c.sprite.sprite.includes("blue") ? "mushroom_blue" : "mushroom_red",
        solid: false,
      });
    }
  }

  // rocks in the excavated yard
  let rocks = 0;
  for (let attempt = 0; attempt < 400 && rocks < 8; attempt++) {
    const tx = ROCK_YARD.x0 + Math.floor(rng() * (ROCK_YARD.x1 - ROCK_YARD.x0 + 1));
    const ty = ROCK_YARD.y0 + Math.floor(rng() * (ROCK_YARD.y1 - ROCK_YARD.y0 + 1));
    const k = w.cellKind(tx, ty);
    if ((k !== CELL.dirt && k !== CELL.sand) || w.objectAt(tx, ty) !== null) continue;
    w.addObject({ type: "rock", tx, ty, w: 1, h: 1, hp: 3, maxHp: 3 });
    rocks++;
  }

  return { world: w, spawn: SPAWN };
}
