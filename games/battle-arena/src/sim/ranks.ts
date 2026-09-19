// Auto-leveling rank curve, in its own module so both world.ts and economy.ts
// can import it without a cycle. Twin-stick deathmatch: abilities rank up with
// hero level automatically — Q/W/E every 2 levels, ult at 4 / 8 / 12.
import type { AbilityKey, Unit } from "./types";
import { ABILITY_KEYS } from "./types";

export const abilityRankCap = (key: AbilityKey, level: number): number => {
  if (key === "R") {
    if (level >= 12) {
      return 3;
    }
    if (level >= 8) {
      return 2;
    }
    if (level >= 4) {
      return 1;
    }
    return 0;
  }
  return Math.min(4, Math.ceil(level / 2));
};

export const syncAbilityRanks = (u: Unit): void => {
  for (const key of ABILITY_KEYS) {
    u.abilities[key].rank = abilityRankCap(key, u.level);
  }
};
