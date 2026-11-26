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
  combat: "Combat",
  farming: "Farming",
  fishing: "Fishing",
  foraging: "Foraging",
  mining: "Mining",
} satisfies Record<SkillId, string>;

export const SKILL_ICON = {
  combat: "⚔",
  farming: "🌾",
  fishing: "🎣",
  foraging: "🍄",
  mining: "⛏",
} satisfies Record<SkillId, string>;

export const xpToNext = (level: number) => {
  if (level >= SKILL_MAX_LEVEL) {
    return Infinity;
  }

  return Math.floor(XP_BASE * (level + 1) ** XP_EXP);
};

export interface SkillState {
  xp: number;
  level: number;
}

export type SkillsJSON = { [K in SkillId]: SkillState };

const freshState = () => ({
  combat: { level: 0, xp: 0 },
  farming: { level: 0, xp: 0 },
  fishing: { level: 0, xp: 0 },
  foraging: { level: 0, xp: 0 },
  mining: { level: 0, xp: 0 },
});

export class Skills {
  private data = freshState();

  get(id: SkillId) {
    return this.data[id];
  }

  level(id: SkillId) {
    return this.data[id].level;
  }

  addXP(id: SkillId, amount: number) {
    const s = this.data[id];

    if (s.level >= SKILL_MAX_LEVEL) {
      return null;
    }

    s.xp += amount;
    let leveled: number | null = null;

    while (s.level < SKILL_MAX_LEVEL && s.xp >= xpToNext(s.level)) {
      s.xp -= xpToNext(s.level);
      s.level += 1;
      leveled = s.level;
    }

    return leveled;
  }

  yieldBonusChance() {
    return this.data.farming.level * 0.07;
  }
  oreBonusChance() {
    return this.data.mining.level * 0.06;
  }
  reelEase() {
    return this.data.fishing.level * 0.06;
  }
  forageBonusChance() {
    return this.data.foraging.level * 0.08;
  }
  swordDamage(base: number) {
    return base + this.data.combat.level * 2;
  }
  bonusMaxHp() {
    return this.data.combat.level * 6;
  }

  toJSON() {
    return {
      combat: { ...this.data.combat },
      farming: { ...this.data.farming },
      fishing: { ...this.data.fishing },
      foraging: { ...this.data.foraging },
      mining: { ...this.data.mining },
    };
  }

  static fromJSON(d: Partial<SkillsJSON>) {
    const sk = new Skills();

    for (const id of SKILL_IDS) {
      const v = d[id];

      if (v) {
        sk.data[id] = { level: v.level, xp: v.xp };
      }
    }

    return sk;
  }

  static fresh() {
    return new Skills();
  }
}
