// Shop items: flat stat bonuses + a few actives. Pure data.

export type ItemStats = {
  damage?: number;
  hp?: number;
  mp?: number;
  armor?: number;
  moveSpeed?: number;
  hpRegen?: number;
  mpRegen?: number;
  attackSpeed?: number; // percent points (e.g. 35 = +35)
  lifestealPct?: number;
  spellAmpPct?: number;
};

export type ActiveKind = "haste" | "barrier" | "blink";

export type ItemDef = {
  id: string;
  name: string;
  cost: number;
  desc: string;
  icon: string; // logical icon key (ui-icon-NN)
  stats: ItemStats;
  active?: { kind: ActiveKind; cooldown: number; desc: string };
};

export const ITEMS: ItemDef[] = [
  { id: "boots", name: "Boots of the March", cost: 450, icon: "ui-icon-01", desc: "+45 move speed.", stats: { moveSpeed: 45 } },
  { id: "ringmail", name: "Ringmail Vest", cost: 550, icon: "ui-icon-02", desc: "+6 armor, +2 hp regen.", stats: { armor: 6, hpRegen: 2 } },
  { id: "whetstone", name: "Whetstone Blade", cost: 700, icon: "ui-icon-03", desc: "+22 attack damage.", stats: { damage: 22 } },
  { id: "quiver", name: "Huntsman's Quiver", cost: 900, icon: "ui-icon-04", desc: "+35 attack speed, +10 damage.", stats: { attackSpeed: 35, damage: 10 } },
  { id: "tome", name: "Tome of Embers", cost: 950, icon: "ui-icon-05", desc: "+250 mana, +2.5 mp regen, +10% spell amp.", stats: { mp: 250, mpRegen: 2.5, spellAmpPct: 10 } },
  { id: "bulwark", name: "Bulwark Plate", cost: 1300, icon: "ui-icon-06", desc: "+450 hp, +5 armor, +3 hp regen.", stats: { hp: 450, armor: 5, hpRegen: 3 } },
  { id: "fang", name: "Vampiric Fang", cost: 1400, icon: "ui-icon-07", desc: "+28 damage, +18% lifesteal.", stats: { damage: 28, lifestealPct: 18 } },
  { id: "sash", name: "Sash of Haste", cost: 1600, icon: "ui-icon-08", desc: "+60 move speed, +200 hp.", stats: { moveSpeed: 60, hp: 200 }, active: { kind: "haste", cooldown: 30, desc: "Haste: +120 move speed for 3.5s, ignore unit collision." } },
  { id: "aegis", name: "Aegis Pendant", cost: 2100, icon: "ui-icon-09", desc: "+300 hp, +4 armor, +1.5 mp regen.", stats: { hp: 300, armor: 4, mpRegen: 1.5 }, active: { kind: "barrier", cooldown: 45, desc: "Barrier: shield 350 damage for 5s and cleanse slows." } },
  { id: "scepter", name: "Scepter of Ruin", cost: 2600, icon: "ui-icon-10", desc: "+30 damage, +250 hp, +12% spell amp, +20 attack speed.", stats: { damage: 30, hp: 250, spellAmpPct: 12, attackSpeed: 20 }, active: { kind: "blink", cooldown: 14, desc: "Blink up to 600px toward the cursor." } },
];

export const ITEM_BY_ID: Record<string, ItemDef> = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
export const MAX_ITEMS = 6;
