import { baseWeaponForLevel } from "../shared/constants";
import type { BoosterKind, Weapon } from "../shared/constants";
import { WeaponMastery } from "../shared/weapon-mastery";

/** My ship: pose, life cycle and loadout. One mutable record the scene owns
 *  and hands to every collaborator that flies, arms or draws the local pilot;
 *  they mutate it in place. */
export interface Pilot {
  shipX: number;
  shipY: number;
  shipVX: number;
  shipVY: number;
  shipAngle: number;
  /** 0–1 throttle this frame (drives the thruster trail). */
  thrust: number;
  /** Directional camera recoil (omni shake comes from TraumaCamera). */
  kickX: number;
  kickY: number;
  alive: boolean;
  /** False until the first spawn and while docked out as a paused spectator. */
  spawned: boolean;
  /** 0 = no respawn pending. */
  respawnAt: number;
  invulnUntil: number;
  weapon: Weapon;
  /** 0 on the base weapon; a held special reverts when this passes. */
  weaponUntil: number;
  /** Unscaled base of the held special (null on base weapon) — re-scaled per
   *  level so specials grow with you without compounding. */
  specialBase: Weapon | null;
  /** Shield-regen speed multiplier from the current level (baseRegenMult). */
  regenMult: number;
  /** Timed boosters by kind → expiry; stack across kinds, mirrored on the wire. */
  boosts: Map<BoosterKind, number>;
  mastery: WeaponMastery;
}

export const newPilot = (): Pilot => ({
  alive: true,
  boosts: new Map(),
  invulnUntil: 0,
  kickX: 0,
  kickY: 0,
  mastery: new WeaponMastery(),
  regenMult: 1,
  respawnAt: 0,
  shipAngle: 0,
  shipVX: 0,
  shipVY: 0,
  shipX: 0,
  shipY: 0,
  spawned: false,
  specialBase: null,
  thrust: 0,
  // Boot at the real L1 base loadout so the HUD never shows a name the level
  // system would immediately rewrite (WEAPON_DEFAULT is the template,
  // baseWeaponForLevel is the loadout).
  weapon: baseWeaponForLevel(1),
  weaponUntil: 0,
});
