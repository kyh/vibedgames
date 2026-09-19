// Shop items: flat stat bonuses + a few actives. Pure data.

export interface ItemStats {
  damage?: number;
  hp?: number;
  mp?: number;
  armor?: number;
  moveSpeed?: number;
  hpRegen?: number;
  mpRegen?: number;
  // percent points (e.g. 35 = +35)
  attackSpeed?: number;
  lifestealPct?: number;
  spellAmpPct?: number;
}

export type ActiveKind = "haste" | "barrier" | "blink";

export interface ItemDef {
  id: string;
  name: string;
  cost: number;
  desc: string;
  // frame in the packed ui icon sheet (assets/ui/icons.webp)
  icon: number;
  stats: ItemStats;
  active?: { kind: ActiveKind; cooldown: number; desc: string };
}

export const ITEMS: ItemDef[] = [
  {
    cost: 450,
    desc: "+45 move speed.",
    icon: 0,
    id: "boots",
    name: "Boots of the March",
    stats: { moveSpeed: 45 },
  },
  {
    cost: 550,
    desc: "+6 armor, +2 hp regen.",
    icon: 1,
    id: "ringmail",
    name: "Ringmail Vest",
    stats: { armor: 6, hpRegen: 2 },
  },
  {
    cost: 700,
    desc: "+22 attack damage.",
    icon: 2,
    id: "whetstone",
    name: "Whetstone Blade",
    stats: { damage: 22 },
  },
  {
    cost: 900,
    desc: "+35 attack speed, +10 damage.",
    icon: 3,
    id: "quiver",
    name: "Huntsman's Quiver",
    stats: { attackSpeed: 35, damage: 10 },
  },
  {
    cost: 950,
    desc: "+250 mana, +2.5 mp regen, +10% spell amp.",
    icon: 4,
    id: "tome",
    name: "Tome of Embers",
    stats: { mp: 250, mpRegen: 2.5, spellAmpPct: 10 },
  },
  {
    cost: 1300,
    desc: "+450 hp, +5 armor, +3 hp regen.",
    icon: 5,
    id: "bulwark",
    name: "Bulwark Plate",
    stats: { armor: 5, hp: 450, hpRegen: 3 },
  },
  {
    cost: 1400,
    desc: "+28 damage, +18% lifesteal.",
    icon: 6,
    id: "fang",
    name: "Vampiric Fang",
    stats: { damage: 28, lifestealPct: 18 },
  },
  {
    active: {
      cooldown: 30,
      desc: "Haste: +120 move speed for 3.5s, ignore unit collision.",
      kind: "haste",
    },
    cost: 1600,
    desc: "+60 move speed, +200 hp.",
    icon: 7,
    id: "sash",
    name: "Sash of Haste",
    stats: { hp: 200, moveSpeed: 60 },
  },
  {
    active: {
      cooldown: 45,
      desc: "Barrier: shield 350 damage for 5s and cleanse slows.",
      kind: "barrier",
    },
    cost: 2100,
    desc: "+300 hp, +4 armor, +1.5 mp regen.",
    icon: 8,
    id: "aegis",
    name: "Aegis Pendant",
    stats: { armor: 4, hp: 300, mpRegen: 1.5 },
  },
  {
    active: { cooldown: 14, desc: "Blink up to 600px toward the cursor.", kind: "blink" },
    cost: 2600,
    desc: "+30 damage, +250 hp, +12% spell amp, +20 attack speed.",
    icon: 9,
    id: "scepter",
    name: "Scepter of Ruin",
    stats: { attackSpeed: 20, damage: 30, hp: 250, spellAmpPct: 12 },
  },
];

export const ITEM_BY_ID: Record<string, ItemDef> = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
export const MAX_ITEMS = 6;
