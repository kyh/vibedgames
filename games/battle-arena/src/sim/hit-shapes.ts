// THE one definition of each ability's hit geometry, used by BOTH the sim's
// hit test (abilities.ts → targetsInShape, for the instant AoE/cone/corridor
// abilities) AND the viewer's hit-surface overlay (scenes/viewer-scene.ts).
// Change a shape here once and the damage test + its visualisation both follow.
//
// Positioning is the consumer's job (the shape is geometry only, oriented along
// the caster's aim): cone/corridor/circleSelf sit at the caster; circleAt sits
// at the cast point; projectile is a travel line + splash (the sim spawns an
// actual projectile — this shape is for drawing/reasoning only).
import { valAt, type AbilityDef } from "../data/champions";
import {
  MELEE_HALF_ANGLE,
  MELEE_OVERREACH,
  RANGED_BASIC_HIT_RADIUS,
  ROGUE_EXECUTE_ARC,
  ROGUE_GASH_WIDTH,
  ROGUE_LUNGE_WIDTH,
  WITCH_HEXBOLT_SPLASH,
} from "./combat-geometry";

export type HitShape =
  | { kind: "cone"; radius: number; half: number } // sector from the caster along aim
  | { kind: "corridor"; length: number; halfWidth: number } // rectangle from the caster along aim
  | { kind: "circleSelf"; radius: number } // circle centred on the caster
  | { kind: "circleAt"; radius: number } // circle at the cast point (aim, clamped to castRange)
  | { kind: "projectile"; length: number; splash: number; width?: number }; // travel line (width = collision fatness) + impact splash

const deg2rad = (d: number): number => (d * Math.PI) / 180;

/** Basic-attack hit shape(s) for a champ — the current swing decides which the
 *  caller shows (melee cleave cone; the spin's `aoe` whirl is a circleSelf).
 *  Ranged basics are a straight fat-line projectile; caster bolts splash. */
export function basicAttackShape(
  attackType: "melee" | "ranged",
  attackRange: number,
  basic?: { pierce?: boolean; splash?: number },
): HitShape {
  return attackType === "melee"
    ? { kind: "cone", radius: attackRange + MELEE_OVERREACH, half: MELEE_HALF_ANGLE }
    : {
        kind: "projectile",
        length: attackRange + 5,
        splash: basic?.splash ?? 0,
        width: RANGED_BASIC_HIT_RADIUS,
      };
}

/** The hit geometry of an ability at `rank`. [] for pure-utility abilities
 *  (dashes, shields, buffs, stealth). Instant AoE/cone/corridor shapes are also
 *  consumed by the sim via targetsInShape; projectiles/zones use their own
 *  systems but their AREA is described here for the overlay. */
export function abilityShapes(def: AbilityDef, rank: number): HitShape[] {
  const v = (f: string): number => valAt(def.values[f], rank);
  switch (def.effect) {
    // frontal cones
    case "knight:Q":
    case "blackknight:Q":
      return [{ kind: "cone", radius: def.castRange, half: deg2rad(v("cone")) / 2 }];
    case "rogue:R": // scans a front arc, then single-strikes the nearest
      return [{ kind: "cone", radius: def.castRange, half: ROGUE_EXECUTE_ARC }];
    case "ranger:Q": // arrows fan over `spread`° (sim spawns the arrows)
      return [{ kind: "cone", radius: def.castRange, half: deg2rad(v("spread")) / 2 }];
    // corridors
    case "knight:W":
      return [{ kind: "corridor", length: def.castRange, halfWidth: v("width") / 2 }];
    case "rogue:Q":
      return [{ kind: "corridor", length: def.castRange, halfWidth: ROGUE_LUNGE_WIDTH }];
    case "rogue:W":
      return [{ kind: "corridor", length: def.castRange, halfWidth: ROGUE_GASH_WIDTH }];
    case "knight:JUMP":
    case "ranger:JUMP":
    case "mage:JUMP":
    case "rogue:JUMP":
    case "blackknight:JUMP":
    case "witch:JUMP":
      // the slam's blast reaches its radius past the touchdown point — the
      // leap itself shoves bodies forward, so the corridor must outreach them
      return [{ kind: "corridor", length: def.castRange + v("radius"), halfWidth: v("radius") }];
    // projectiles (travel line + splash)
    case "mage:Q":
      return [{ kind: "projectile", length: def.castRange, splash: v("radius") }];
    case "witch:Q":
      return [{ kind: "projectile", length: def.castRange, splash: WITCH_HEXBOLT_SPLASH }];
    // ground-target AoE circles (at the cast point)
    case "mage:W":
    case "mage:E":
    case "mage:R":
    case "ranger:E":
    case "ranger:R":
    case "blackknight:W":
    case "witch:W":
    case "witch:E":
    case "witch:R":
      return [{ kind: "circleAt", radius: v("radius") }];
    // self-centred AoE circles
    case "knight:R":
    case "blackknight:R":
      return [{ kind: "circleSelf", radius: v("radius") }];
    default:
      return [];
  }
}
