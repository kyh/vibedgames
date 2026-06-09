// Maps simulation units to texture/animation keys. Radiant = blue/knight,
// Dire = red/goblin, giving the two teams a clean faction silhouette.

import { HERO_BY_ID } from "../data/heroes";
import type { Team } from "../data/config";
import type { Unit } from "../sim/types";

export function teamColor(team: Team): "blue" | "red" {
  return team === "radiant" ? "blue" : "red";
}

type SpriteInfo = { tex: string; scale: number; tint: number; animBase: string };

/** Texture key + display scale for a unit's body sprite. `animBase` is the prefix
 * animKey appends idle/walk/... to (usually == tex, but differs for enemy creatures
 * whose actions live in separate sheets). */
export function unitSprite(u: Unit): SpriteInfo {
  const color = teamColor(u.team);
  if (u.kind === "hero" && u.hero) {
    const def = HERO_BY_ID[u.hero.defId];
    const sheet = def?.sheet ?? "warrior";
    const tex = `u-${sheet}-${color}`;
    return { tex, scale: 0.62, tint: 0xffffff, animBase: tex };
  }
  if (u.kind === "creep" && u.creep) {
    // neutrals (jungle camps / Roshan) use Enemy-Pack monsters so they read as a
    // distinct, threatening faction. Actions live in separate sheets, hence animBase.
    if (u.neutral) {
      if (u.creep.boss) return { tex: "e-minotaur-idle", scale: 0.42, tint: 0xffffff, animBase: "e-minotaur" };
      const big = u.radius >= 32;
      const base = big ? "e-gnoll" : "e-skull";
      return { tex: `${base}-idle`, scale: big ? 0.52 : 0.46, tint: 0xffffff, animBase: base };
    }
    const ck = u.creep.ckind;
    if (ck === "melee") { const t = u.team === "radiant" ? "u-pawn-blue" : "u-torch-red"; return { tex: t, scale: 0.42, tint: 0xffffff, animBase: t }; }
    if (ck === "ranged") { const t = u.team === "radiant" ? "u-archer-blue" : "u-tnt-red"; return { tex: t, scale: 0.42, tint: 0xffffff, animBase: t }; }
    const t = `u-barrel-${color}`;
    return { tex: t, scale: 0.5, tint: 0xffffff, animBase: t };
  }
  const t = `u-pawn-${color}`;
  return { tex: t, scale: 0.5, tint: 0xffffff, animBase: t };
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

export function animKey(u: Unit, name: "idle" | "walk" | "attack" | "death"): string {
  return `${unitSprite(u).animBase}-${name}`;
}
