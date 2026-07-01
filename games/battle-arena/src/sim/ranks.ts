// Auto-leveling rank curve, in its own module so both world.ts and economy.ts
// can import it without a cycle. Twin-stick deathmatch: abilities rank up with
// hero level automatically — Q/W/E every 2 levels, ult at 4 / 8 / 12.
import type { AbilityKey, Unit } from "./types";
import { ABILITY_KEYS } from "./types";

export function abilityRankCap(key: AbilityKey, level: number): number {
  if (key === "R") return level >= 12 ? 3 : level >= 8 ? 2 : level >= 4 ? 1 : 0;
  return Math.min(4, Math.ceil(level / 2));
}

export function syncAbilityRanks(u: Unit): void {
  for (const key of ABILITY_KEYS) {
    u.abilities[key].rank = abilityRankCap(key, u.level);
  }
}
