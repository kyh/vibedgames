// Skills: five tracks that gain XP from related actions and grant perks.

import { SKILL_MAX_LEVEL, XP_BASE, XP_EXP } from "../config";

export type SkillId = "farming" | "mining" | "fishing" | "foraging" | "combat";
export const SKILL_IDS: readonly SkillId[] = [
  "farming",
  "mining",
  "fishing",
  "foraging",
  "combat",
] as const;

export const SKILL_NAMES = {
  farming: "Farming",
  mining: "Mining",
  fishing: "Fishing",
  foraging: "Foraging",
  combat: "Combat",
} satisfies Record<SkillId, string>;

export const SKILL_ICON = {
  farming: "🌾",
  mining: "⛏",
  fishing: "🎣",
  foraging: "🍄",
  combat: "⚔",
} satisfies Record<SkillId, string>;

// XP needed to advance FROM `level` to level+1. Level SKILL_MAX_LEVEL is the cap.
export function xpToNext(level: number): number {
  if (level >= SKILL_MAX_LEVEL) return Infinity;
  return Math.floor(XP_BASE * Math.pow(level + 1, XP_EXP));
}

export type SkillState = { xp: number; level: number };
export type SkillsJSON = { [K in SkillId]: SkillState };

function freshState(): SkillsJSON {
  return {
    farming: { xp: 0, level: 0 },
    mining: { xp: 0, level: 0 },
    fishing: { xp: 0, level: 0 },
    foraging: { xp: 0, level: 0 },
    combat: { xp: 0, level: 0 },
  };
}

export class Skills {
  private data = freshState();

  get(id: SkillId): SkillState {
    return this.data[id];
  }

  level(id: SkillId): number {
    return this.data[id].level;
  }

  // Adds XP; returns the new level if a level-up happened, else null.
  addXP(id: SkillId, amount: number): number | null {
    const s = this.data[id];
    if (s.level >= SKILL_MAX_LEVEL) return null;
    s.xp += amount;
    let leveled: number | null = null;
    while (s.level < SKILL_MAX_LEVEL && s.xp >= xpToNext(s.level)) {
      s.xp -= xpToNext(s.level);
      s.level += 1;
      leveled = s.level;
    }
    return leveled;
  }

  // ---- perks ----
  yieldBonusChance(): number {
    return this.data.farming.level * 0.07; // chance of +1 produce
  }
  oreBonusChance(): number {
    return this.data.mining.level * 0.06;
  }
  reelEase(): number {
    return this.data.fishing.level * 0.06; // widens the catch zone
  }
  forageBonusChance(): number {
    return this.data.foraging.level * 0.08;
  }
  swordDamage(base: number): number {
    return base + this.data.combat.level * 2;
  }
  bonusMaxHp(): number {
    return this.data.combat.level * 6;
  }

  toJSON(): SkillsJSON {
    return {
      farming: { ...this.data.farming },
      mining: { ...this.data.mining },
      fishing: { ...this.data.fishing },
      foraging: { ...this.data.foraging },
      combat: { ...this.data.combat },
    };
  }

  static fromJSON(d: SkillsJSON): Skills {
    const sk = new Skills();
    for (const id of SKILL_IDS) {
      const v = d[id];
      if (v) sk.data[id] = { xp: v.xp, level: v.level };
    }
    return sk;
  }

  static fresh(): Skills {
    return new Skills();
  }
}
