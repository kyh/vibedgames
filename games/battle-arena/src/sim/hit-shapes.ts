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
  | { kind: "cone"; radius: number; half: number }
  | { kind: "corridor"; length: number; halfWidth: number }
  | { kind: "circleSelf"; radius: number }
  | { kind: "circleAt"; radius: number }
  | { kind: "projectile"; length: number; splash: number; width?: number };

const deg2rad = (d: number) => (d * Math.PI) / 180;

/** Basic-attack hit shape(s) for a champ — the current swing decides which the
 *  caller shows (melee cleave cone; the spin's `aoe` whirl is a circleSelf).
 *  Ranged basics are a straight fat-line projectile; caster bolts splash. */
export const basicAttackRegion: (
  attackType: "melee" | "ranged",
  attackRange: number,
  basic?: { pierce?: boolean; splash?: number },
) => HitRegion = (attackType, attackRange, basic?) =>
  attackType === "melee"
    ? { half: MELEE_HALF_ANGLE, kind: "cone", radius: attackRange + MELEE_OVERREACH }
    : {
        kind: "projectile",
        length: attackRange + 5,
        splash: basic?.splash ?? 0,
        width: RANGED_BASIC_HIT_RADIUS,
      };

const aimedRegions: (def: AbilityDef, v: (f: string) => number) => HitRegion[] | null = (
  def,
  v,
) => {
  switch (def.effect) {
    case "knight:Q":
    case "blackknight:Q": {
      return [{ half: deg2rad(v("cone")) / 2, kind: "cone", radius: def.castRange }];
    }

    case "rogue:R": {
      return [{ half: ROGUE_EXECUTE_ARC, kind: "cone", radius: def.castRange }];
    }

    case "ranger:Q": {
      return [{ half: deg2rad(v("spread")) / 2, kind: "cone", radius: def.castRange }];
    }

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
      return [{ halfWidth: v("radius"), kind: "corridor", length: def.castRange + v("radius") }];
    }

    case "mage:Q": {
      return [{ kind: "projectile", length: def.castRange, splash: v("radius") }];
    }

    case "witch:Q": {
      return [{ kind: "projectile", length: def.castRange, splash: WITCH_HEXBOLT_SPLASH }];
    }

    default: {
      return null;
    }
  }
};

const circleRegions: (def: AbilityDef, v: (f: string) => number) => HitRegion[] = (def, v) => {
  switch (def.effect) {
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
export const abilityRegions: (def: AbilityDef, rank: number) => HitRegion[] = (def, rank) => {
  const v = (f: string) => valAt(def.values[f], rank);

  return aimedRegions(def, v) ?? circleRegions(def, v);
};
