// Maps simulation units to texture/animation keys. Radiant = blue/knight,
// Dire = red/goblin, giving the two teams a clean faction silhouette.

import { HERO_BY_ID } from "../data/heroes";
import type { Team } from "../data/config";
import type { Unit } from "../sim/types";

export function teamColor(team: Team): "blue" | "red" {
  return team === "radiant" ? "blue" : "red";
}

/** Texture key + display scale for a unit's body sprite. */
export function unitSprite(u: Unit): { tex: string; scale: number; tint: number } {
  const color = teamColor(u.team);
  if (u.kind === "hero" && u.hero) {
    const def = HERO_BY_ID[u.hero.defId];
    const sheet = def?.sheet ?? "warrior";
    return { tex: `u-${sheet}-${color}`, scale: 0.62, tint: 0xffffff };
  }
  if (u.kind === "creep" && u.creep) {
    // neutrals (jungle/Roshan) wear a neutral palette so they read as non-team.
    if (u.neutral) {
      if (u.creep.boss) return { tex: "u-warrior-yellow", scale: 1.05, tint: 0xffffff };
      const big = u.radius >= 32;
      return { tex: big ? "u-warrior-purple" : "u-torch-purple", scale: big ? 0.62 : 0.46, tint: 0xffffff };
    }
    const ck = u.creep.ckind;
    if (ck === "melee") return { tex: u.team === "radiant" ? "u-pawn-blue" : "u-torch-red", scale: 0.42, tint: 0xffffff };
    if (ck === "ranged") return { tex: u.team === "radiant" ? "u-archer-blue" : "u-tnt-red", scale: 0.42, tint: 0xffffff };
    return { tex: `u-barrel-${color}`, scale: 0.5, tint: 0xffffff };
  }
  return { tex: `u-pawn-${color}`, scale: 0.5, tint: 0xffffff };
}

/** Texture for a hero by id+team — for menus/portraits without a live Unit. */
export function heroSheetTex(defId: string, team: Team = "radiant"): string {
  const sheet = HERO_BY_ID[defId]?.sheet ?? "warrior";
  return `u-${sheet}-${teamColor(team)}`;
}

export function heroTint(u: Unit): number {
  if (u.kind === "hero" && u.hero) return HERO_BY_ID[u.hero.defId]?.tint ?? 0xffffff;
  return 0xffffff;
}

/** Structure texture by tier + team. */
export function structureSprite(u: Unit): { tex: string; scale: number } {
  const color = teamColor(u.team);
  const tier = u.structure?.tier ?? "t1";
  if (tier === "ancient") return { tex: `b-castle-${color}`, scale: 1.7 };
  if (tier === "base") return { tex: `b-tower-${color}`, scale: 1.15 };
  return { tex: `b-tower-${color}`, scale: 1.35 };
}

export function structureDestroyedTex(tier: string): string {
  return tier === "ancient" ? "b-castle-destroyed" : "b-tower-destroyed";
}

export function animKey(u: Unit, name: "idle" | "walk" | "attack"): string {
  return `${unitSprite(u).tex}-${name}`;
}
