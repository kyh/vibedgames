import { MAX_LEVEL, XP_CURVE, abilityRankCap, enemyOf } from "../data/config";
import type { Team } from "../data/config";
import { HERO_BY_ID, valAt } from "../data/heroes";
import type { AbilityKey, Targeting } from "../data/heroes";
import type { HeroState } from "../sim/types";

type Upgrade =
  | { kind: "available" }
  | { kind: "points" }
  | { kind: "level"; level: number }
  | { kind: "max" }
  | { kind: "unavailable" };

/** Reads the same cap as levelAbility; never spends an ability point. */
export function abilityUpgrade(hero: HeroState, key: AbilityKey): Upgrade {
  const def = HERO_BY_ID[hero.defId]?.abilities[key];
  if (!def) return { kind: "unavailable" };
  const rank = hero.abilities[key].rank;
  if (rank >= def.maxRank) return { kind: "max" };
  if (rank >= abilityRankCap(key, hero.level)) {
    for (let level = hero.level + 1; level <= MAX_LEVEL; level++) {
      if (abilityRankCap(key, level) > rank) return { kind: "level", level };
    }
    return { kind: "max" };
  }
  return hero.abilityPoints > 0 ? { kind: "available" } : { kind: "points" };
}

const TARGET_COPY = {
  unit: "Target a unit",
  point: "Aim at the ground",
  none: "No target needed",
  passive: "Passive",
} satisfies Record<Targeting, string>;

export function abilityExplanation(hero: HeroState, key: AbilityKey) {
  const def = HERO_BY_ID[hero.defId]?.abilities[key];
  if (!def) return null;
  const rank = hero.abilities[key].rank;
  const previewRank = Math.max(1, rank);
  const upgrade = abilityUpgrade(hero, key);
  const unlock =
    upgrade.kind === "level"
      ? `${rank ? "Next rank" : "Unlocks"} at level ${upgrade.level}`
      : upgrade.kind === "available"
        ? "Upgrade available · use + on the ability"
        : upgrade.kind === "max"
          ? "Maximum rank"
          : "Earn an ability point to upgrade";
  const costs =
    def.targeting === "passive"
      ? "No cast or mana cost"
      : `${valAt(def.manaCost, previewRank)} mana · ${valAt(def.cooldown, previewRank)}s cooldown${
          def.castRange > 0 ? ` · ${def.castRange} range` : ""
        }`;
  return {
    name: `${key} · ${def.name}`,
    description: def.desc,
    rank: `${TARGET_COPY[def.targeting]} · ${rank > 0 ? `Rank ${rank}/${def.maxRank}` : "Rank 1 preview"}`,
    costs,
    unlock,
  };
}

/** XP is cumulative in the sim; the strip shows progress within this level. */
export function experienceProgress(hero: HeroState) {
  if (hero.level >= MAX_LEVEL) return { fraction: 1, text: "MAX LEVEL" };
  const start = XP_CURVE[Math.max(0, hero.level - 1)] ?? 0;
  const end = XP_CURVE[hero.level] ?? start;
  const total = Math.max(1, end - start);
  const earned = Math.max(0, Math.min(total, hero.xp - start));
  return { fraction: earned / total, text: `${Math.floor(earned)} / ${total} XP` };
}

/** Kill.team is the credited team, including environmental deaths. */
export function killFeedText(
  event: { killer: string; victim: string; team: Team },
  localTeam: Team | null,
): string {
  const side = (team: Team): string =>
    localTeam ? (team === localTeam ? "Ally" : "Enemy") : team === "radiant" ? "Radiant" : "Dire";
  const victim = `${side(enemyOf(event.team))} ${event.victim}`;
  return event.killer ? `${side(event.team)} ${event.killer} → ${victim}` : `${victim} has fallen`;
}
