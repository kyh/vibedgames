// Maps simulation units to texture/animation keys. Radiant = blue/knight,
// Dire = red/goblin, giving the two teams a clean faction silhouette.

import { HERO_BY_ID } from "../data/heroes";
import type { Team } from "../data/config";
import type { Unit } from "../sim/types";

export const teamColor = (team: Team): "blue" | "red" => (team === "radiant" ? "blue" : "red");

interface SpriteInfo {
  tex: string;
  scale: number;
  tint: number;
  animBase: string;
}

/** Texture key + display scale for a unit's body sprite. `animBase` is the prefix
 * animKey appends idle/walk/... to (usually == tex, but differs for enemy creatures
 * whose actions live in separate sheets). */
export const unitSprite = (u: Unit): SpriteInfo => {
  const color = teamColor(u.team);
  if (u.kind === "hero" && u.hero) {
    const def = HERO_BY_ID[u.hero.defId];
    const sheet = def?.sheet ?? "warrior";
    const tex = `u-${sheet}-${color}`;
    return { animBase: tex, scale: 0.62, tex, tint: 0xff_ff_ff };
  }
  if (u.kind === "creep" && u.creep) {
    // neutrals (jungle camps / Roshan) use Enemy-Pack monsters so they read as a
    // distinct, threatening faction. Actions live in separate sheets, hence animBase.
    if (u.neutral) {
      if (u.creep.boss) {
        return { animBase: "e-minotaur", scale: 0.42, tex: "e-minotaur-idle", tint: 0xff_ff_ff };
      }
      const big = u.radius >= 32;
      const base = big ? "e-gnoll" : "e-skull";
      return { animBase: base, scale: big ? 0.52 : 0.46, tex: `${base}-idle`, tint: 0xff_ff_ff };
    }
    const ck = u.creep.ckind;
    if (ck === "melee") {
      const t = u.team === "radiant" ? "u-pawn-blue" : "u-torch-red";
      return { animBase: t, scale: 0.42, tex: t, tint: 0xff_ff_ff };
    }
    if (ck === "ranged") {
      const t = u.team === "radiant" ? "u-archer-blue" : "u-tnt-red";
      return { animBase: t, scale: 0.42, tex: t, tint: 0xff_ff_ff };
    }
    // barrel frames are 128px (others 192) — scale up so it reads the same size
    const t = `u-barrel-${color}`;
    return { animBase: t, scale: 0.72, tex: t, tint: 0xff_ff_ff };
  }
  const t = `u-pawn-${color}`;
  return { animBase: t, scale: 0.5, tex: t, tint: 0xff_ff_ff };
};

/** Texture for a hero by id+team — for menus/portraits without a live Unit. */
export const heroSheetTex = (defId: string, team: Team = "radiant"): string => {
  const sheet = HERO_BY_ID[defId]?.sheet ?? "warrior";
  return `u-${sheet}-${teamColor(team)}`;
};

export const structureDestroyedTex = (tier: string): string =>
  tier === "ancient" ? "b-castle-destroyed" : "b-tower-destroyed";

export const animKey = (u: Unit, name: "idle" | "walk" | "attack" | "death"): string =>
  `${unitSprite(u).animBase}-${name}`;
