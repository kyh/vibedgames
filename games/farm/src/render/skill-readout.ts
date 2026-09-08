import type { SkillId, Skills } from "../systems/skills";

/** Current, already-earned perks. This view never grants XP or changes a skill. */
export function skillPerk(skills: Skills, id: SkillId): string {
  switch (id) {
    case "farming":
      return `${Math.round(skills.yieldBonusChance() * 100)}% chance: +1 crop`;
    case "mining":
      return `${Math.round(skills.oreBonusChance() * 100)}% chance: +1 ore`;
    case "fishing":
      return skills.reelEase() > 0 ? "Wider catch zone" : "Base catch zone";
    case "foraging":
      return `${Math.round(skills.forageBonusChance() * 100)}% chance: +1 forage`;
    case "combat":
      return `Sword +${skills.swordDamage(0)} · Max HP +${skills.bonusMaxHp()}`;
  }
}
