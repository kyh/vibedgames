// Destructible props — the camp stashes and partition-end supplies that used
// to be render-only decor (data/decor.ts) promoted into REAL sim entities:
// they block movement, take damage from anything that deals it, break into
// debris (kegs explode), sometimes drop gold, and respawn.
//
// Pure data + deterministic math (same placement formulas the decor used, so
// the arena looks identical until something gets smashed). Sim-safe: no
// engine imports. The sim spawns one "prop" unit per spec (unit.slot = the
// spec index); the renderer looks the spec back up by that index.
import { CAMPS, PARTITION_RUNS, SPAWNS } from "./map";

export interface PropSpec {
  // dungeon GLB the renderer instances
  model: string;
  x: number;
  y: number;
  // render yaw (radians)
  rot: number;
  // render scale
  scale: number;
  // sim collision radius
  radius: number;
  hp: number;
  // breaks with a damaging blast (kegs)
  explosive?: boolean;
}

// per-model base stats (radius/hp scale with the placement's `scale`)
const BARREL = { hp: 60, radius: 0.48 };
const CRATE = { hp: 100, radius: 0.58 };
const STACK = { hp: 150, radius: 0.78 };
const KEG = { hp: 60, radius: 0.45 };

/** Blast stats for an exploding keg (damage is dealt to ENEMIES of whoever
 *  broke it — chain-detonating your own kegs onto foes is the fun part). */
export const KEG_BLAST = { damage: 70, radius: 2.4 };

/** Gold coin a lucky prop drops (deterministic per-world roll on break). */
export const PROP_COIN_GOLD = 20;
export const PROP_COIN_CHANCE = 0.35;
export const PROP_RESPAWN_MS = 50_000;

/** The destructible prop layout for the current map. Deterministic — every
 *  client computes the identical list (order matters: unit.slot = index). */
export const destructibleProps = (): PropSpec[] => {
  const out: PropSpec[] = [];
  const add = (
    model: string,
    base: { radius: number; hp: number },
    x: number,
    y: number,
    rot: number,
    scale: number,
    explosive?: boolean,
  ): void => {
    const spec: PropSpec = {
      hp: Math.round(base.hp * scale),
      model,
      radius: base.radius * scale,
      rot,
      scale,
      x,
      y,
    };
    if (explosive) {
      spec.explosive = true;
    }
    out.push(spec);
  };

  // ── camp stashes (was decor: crate + barrel 2.6u outward of each lair;
  //    cellar kegs/stack + the woodstore keg were themed extras) ──
  const lairs = CAMPS.filter((c) => c.id.startsWith("camp"));
  for (const [i, c] of lairs.entries()) {
    const ang = Math.atan2(c.y, c.x);
    const ox = Math.cos(ang);
    const oy = Math.sin(ang);
    const tx = -Math.sin(ang);
    const ty = Math.cos(ang);
    add("crate_large", CRATE, c.x + ox * 2.6, c.y + oy * 2.6, i, 0.85);
    add("barrel_large", BARREL, c.x + ox * 2.6 + oy * 1, c.y + oy * 2.6 - ox * 1, i * 2, 0.78);
    if (i === 3) {
      // Cellar: the keg hoard — every keg is a bomb
      add("keg", KEG, c.x + ox * 2.6 + tx * 0.8, c.y + oy * 2.6 + ty * 0.8, 1.1, 0.9, true);
      add("keg", KEG, c.x + ox * 2.6 - tx * 0.6, c.y + oy * 2.6 - ty * 0.6, 2.3, 0.9, true);
      add("crates_stacked", STACK, c.x - tx * 2.8, c.y - ty * 2.8, ang + 1.1, 0.85);
    } else if (i === 4) {
      // Woodstore: one decorated keg by the timber
      add(
        "keg_decorated",
        KEG,
        c.x + ox * 1.7 + tx * 2.4,
        c.y + oy * 1.7 + ty * 2.4,
        0.7,
        0.9,
        true,
      );
    }
  }

  // ── base outposts (was decor: supply crates flanking each spawn) — if it
  //    looks like a barrel it breaks; no two barrel classes in one arena ──
  for (const [i, s] of SPAWNS.entries()) {
    const ang = Math.atan2(s.y, s.x);
    const rx = -Math.sin(ang);
    const ry = Math.cos(ang);
    add("crate_large", CRATE, s.x + rx * 3.4, s.y + ry * 3.4, i, 0.8);
    add("barrel_large", BARREL, s.x - rx * 3.4, s.y - ry * 3.4, i * 2, 0.78);
  }

  // ── partition ends (was decor: a barrel/crate closing each cover run) ──
  for (const [i, run] of PARTITION_RUNS.entries()) {
    const tx = Math.cos(run.dir);
    const ty = Math.sin(run.dir);
    const end = (run.offsets.at(-1) ?? 3) + 2.2;
    const side = i % 2 === 0 ? 1 : -1;
    if (i % 3 === 0) {
      add("barrel_large", BARREL, run.x + tx * end * side, run.y + ty * end * side, i * 1.7, 0.8);
    } else {
      add("crate_large", CRATE, run.x + tx * end * side, run.y + ty * end * side, i * 1.7, 0.8);
    }
  }

  return out;
};
