import type { SkillId, Skills } from "../systems/skills";

const pct = (chance: number): string => `${Math.round(chance * 100)}% chance`;

const PERK: Record<SkillId, (skills: Skills) => string> = {
  combat: (skills) => `Sword +${skills.swordDamage(0)} · Max HP +${skills.bonusMaxHp()}`,
  farming: (skills) => `${pct(skills.yieldBonusChance())}: +1 crop`,
  fishing: (skills) => (skills.reelEase() > 0 ? "Wider catch zone" : "Base catch zone"),
  foraging: (skills) => `${pct(skills.forageBonusChance())}: +1 forage`,
  mining: (skills) => `${pct(skills.oreBonusChance())}: +1 ore`,
};

/** Current, already-earned perks. This view never grants XP or changes a skill. */
export const skillPerk = (skills: Skills, id: SkillId): string => PERK[id](skills);
