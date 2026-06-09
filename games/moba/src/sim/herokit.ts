// Hero stat assembly: turn a HeroDef + level + owned items into the live combat
// fields on a Unit. Called at spawn, on level-up, and on item purchase. Level/
// item changes ADD the maxHp/maxMp delta to current hp/mp (Dota-style).

import { HERO_MAGIC_RESIST } from "../data/config";
import { HERO_BY_ID, heroStatAt } from "../data/heroes";
import type { HeroStats } from "../data/heroes";
import { ITEM_BY_ID } from "../data/items";
import type { Unit } from "./types";

function sumItems(itemIds: string[]) {
  const acc = {
    damage: 0,
    hp: 0,
    mp: 0,
    armor: 0,
    moveSpeed: 0,
    hpRegen: 0,
    mpRegen: 0,
    attackSpeed: 0,
    spellAmp: 0,
    lifesteal: 0,
  };
  for (const id of itemIds) {
    const it = ITEM_BY_ID[id];
    if (!it) continue;
    const s = it.stats;
    acc.damage += s.damage ?? 0;
    acc.hp += s.hp ?? 0;
    acc.mp += s.mp ?? 0;
    acc.armor += s.armor ?? 0;
    acc.moveSpeed += s.moveSpeed ?? 0;
    acc.hpRegen += s.hpRegen ?? 0;
    acc.mpRegen += s.mpRegen ?? 0;
    acc.attackSpeed += s.attackSpeed ?? 0;
    acc.spellAmp += s.spellAmpPct ?? 0;
    acc.lifesteal += s.lifestealPct ?? 0;
  }
  return acc;
}

/** Recompute the unit's combat fields from def+level+items. Returns max deltas. */
export function recomputeHeroStats(u: Unit): { hpDelta: number; mpDelta: number } {
  const h = u.hero;
  if (!h) return { hpDelta: 0, mpDelta: 0 };
  const def = HERO_BY_ID[h.defId];
  if (!def) return { hpDelta: 0, mpDelta: 0 };
  const lvl = h.level;
  const st = (s: keyof HeroStats) => heroStatAt(def, s, lvl);
  const items = sumItems(h.items);

  const oldMaxHp = u.maxHp || st("hp");
  const oldMaxMp = u.maxMp || st("mp");

  u.maxHp = st("hp") + items.hp;
  u.maxMp = st("mp") + items.mp;
  u.baseDamage = st("damage") + items.damage;
  u.armor = st("armor") + items.armor;
  u.attackRange = def.base.attackRange; // range doesn't grow
  u.attackSpeedBase = st("attackSpeed") * (1 + items.attackSpeed / 100);
  u.moveSpeedBase = st("moveSpeed") + items.moveSpeed;
  u.projectileSpeed = def.base.projectileSpeed;
  u.hpRegen = st("hpRegen") + items.hpRegen;
  u.mpRegen = st("mpRegen") + items.mpRegen;
  u.magicResist = HERO_MAGIC_RESIST;
  u.bonusSpellAmp = items.spellAmp / 100;
  u.bonusLifesteal = items.lifesteal / 100;
  u.radius = 30;

  const hpDelta = u.maxHp - oldMaxHp;
  const mpDelta = u.maxMp - oldMaxMp;
  return { hpDelta, mpDelta };
}

export function applyHeroLevel(u: Unit): void {
  const { hpDelta, mpDelta } = recomputeHeroStats(u);
  if (u.alive) {
    u.hp = Math.min(u.maxHp, u.hp + Math.max(0, hpDelta));
    u.mp = Math.min(u.maxMp, u.mp + Math.max(0, mpDelta));
  }
}

export function applyItemPurchase(u: Unit, itemId: string): void {
  if (!u.hero) return;
  const { hpDelta, mpDelta } = recomputeHeroStats(u);
  u.hp = Math.min(u.maxHp, u.hp + Math.max(0, hpDelta));
  u.mp = Math.min(u.maxMp, u.mp + Math.max(0, mpDelta));
  void itemId;
}
