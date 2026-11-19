import type { AbilityKey, Unit } from "./types";
import { ABILITY_KEYS } from "./types";

export const abilityRankCap = (key: AbilityKey, level: number) => {
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

export const syncAbilityRanks = (u: Unit) => {
  for (const key of ABILITY_KEYS) {
    u.abilities[key].rank = abilityRankCap(key, u.level);
  }
};
