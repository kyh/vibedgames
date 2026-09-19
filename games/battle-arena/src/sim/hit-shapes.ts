// THE one definition of each ability's hit geometry, used by BOTH the sim's
// hit test (abilities.ts → targetsInRegion, for the instant AoE/cone/corridor
// abilities) AND the viewer's hit-surface overlay (scenes/viewer-scene.ts).
// Change a shape here once and the damage test + its visualisation both follow.
//
// Positioning is the consumer's job (the shape is geometry only, oriented along
// the caster's aim): cone/corridor/circleSelf sit at the caster; circleAt sits
// at the cast point; projectile is a travel line + splash (the sim spawns an
// actual projectile — this shape is for drawing/reasoning only).
import { valAt } from "../data/champions";
import type { AbilityDef } from "../data/champions";
import {
  MELEE_HALF_ANGLE,
  MELEE_OVERREACH,
  RANGED_BASIC_HIT_RADIUS,
  ROGUE_EXECUTE_ARC,
  ROGUE_GASH_WIDTH,
  ROGUE_LUNGE_WIDTH,
  WITCH_HEXBOLT_SPLASH,
} from "./combat-geometry";

export type HitRegion =
  // sector from the caster along aim
  | { kind: "cone"; radius: number; half: number }
  // rectangle from the caster along aim
  | { kind: "corridor"; length: number; halfWidth: number }
  // circle centred on the caster
  | { kind: "circleSelf"; radius: number }
  // circle at the cast point (aim, clamped to castRange)
  | { kind: "circleAt"; radius: number }
  // travel line (width = collision fatness) + impact splash
  | { kind: "projectile"; length: number; splash: number; width?: number };

const deg2rad = (d: number): number => (d * Math.PI) / 180;

/** Basic-attack hit shape(s) for a champ — the current swing decides which the
 *  caller shows (melee cleave cone; the spin's `aoe` whirl is a circleSelf).
 *  Ranged basics are a straight fat-line projectile; caster bolts splash. */
export const basicAttackRegion = (
  attackType: "melee" | "ranged",
  attackRange: number,
  basic?: { pierce?: boolean; splash?: number },
): HitRegion =>
  attackType === "melee"
    ? { half: MELEE_HALF_ANGLE, kind: "cone", radius: attackRange + MELEE_OVERREACH }
    : {
        kind: "projectile",
        length: attackRange + 5,
        splash: basic?.splash ?? 0,
        width: RANGED_BASIC_HIT_RADIUS,
      };

/** Shapes oriented along the caster's aim: cones, corridors, projectiles.
 *  undefined when the ability isn't one of those. */
const aimedRegions = (def: AbilityDef, v: (f: string) => number): HitRegion[] | undefined => {
  switch (def.effect) {
    // frontal cones
    case "knight:Q":
    case "blackknight:Q": {
      return [{ half: deg2rad(v("cone")) / 2, kind: "cone", radius: def.castRange }];
    }
    case "rogue:R": {
      // scans a front arc, then single-strikes the nearest
      return [{ half: ROGUE_EXECUTE_ARC, kind: "cone", radius: def.castRange }];
    }
    case "ranger:Q": {
      // arrows fan over `spread`° (sim spawns the arrows)
      return [{ half: deg2rad(v("spread")) / 2, kind: "cone", radius: def.castRange }];
    }
    // corridors
    case "knight:W": {
      return [{ halfWidth: v("width") / 2, kind: "corridor", length: def.castRange }];
    }
    case "rogue:Q": {
      return [{ halfWidth: ROGUE_LUNGE_WIDTH, kind: "corridor", length: def.castRange }];
    }
    case "rogue:W": {
      return [{ halfWidth: ROGUE_GASH_WIDTH, kind: "corridor", length: def.castRange }];
    }
    case "knight:JUMP":
    case "ranger:JUMP":
    case "mage:JUMP":
    case "rogue:JUMP":
    case "blackknight:JUMP":
    case "witch:JUMP": {
      // the slam's blast reaches its radius past the touchdown point — the
      // leap itself shoves bodies forward, so the corridor must outreach them
      return [{ halfWidth: v("radius"), kind: "corridor", length: def.castRange + v("radius") }];
    }
    // projectiles (travel line + splash)
    case "mage:Q": {
      return [{ kind: "projectile", length: def.castRange, splash: v("radius") }];
    }
    case "witch:Q": {
      return [{ kind: "projectile", length: def.castRange, splash: WITCH_HEXBOLT_SPLASH }];
    }
    default: {
      return undefined;
    }
  }
};

/** Circles: at the cast point or centred on the caster. [] otherwise. */
const circleRegions = (def: AbilityDef, v: (f: string) => number): HitRegion[] => {
  switch (def.effect) {
    // ground-target AoE circles (at the cast point)
    case "mage:W":
    case "mage:E":
    case "mage:R":
    case "ranger:E":
    case "ranger:R":
    case "blackknight:W":
    case "witch:W":
    case "witch:E":
    case "witch:R": {
      return [{ kind: "circleAt", radius: v("radius") }];
    }
    // self-centred AoE circles
    case "knight:R":
    case "blackknight:R": {
      return [{ kind: "circleSelf", radius: v("radius") }];
    }
    default: {
      return [];
    }
  }
};

/** The hit geometry of an ability at `rank`. [] for pure-utility abilities
 *  (dashes, shields, buffs, stealth). Instant AoE/cone/corridor shapes are also
 *  consumed by the sim via targetsInRegion; projectiles/zones use their own
 *  systems but their AREA is described here for the overlay. */
export const abilityRegions = (def: AbilityDef, rank: number): HitRegion[] => {
  const v = (f: string): number => valAt(def.values[f], rank);
  return aimedRegions(def, v) ?? circleRegions(def, v);
};
