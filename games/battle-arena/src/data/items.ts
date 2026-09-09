// Curated shop (build-doc §10e). Short on purpose — a few stat sticks plus a
// handful of actives. Balance with the game-balance skill once playable; audit
// for a dominant item. Shop is only usable in your own base.

export interface ItemStats {
  damage?: number;
  hp?: number;
  mp?: number;
  armor?: number;
  // additive fraction (0.2 = +20% mitigation)
  magicResist?: number;
  moveSpeed?: number;
  hpRegen?: number;
  mpRegen?: number;
  // attacks/sec bonus points ×100 (30 = +0.30 aps via stats)
  attackSpeed?: number;
  // additive fraction to ability damage (0.2 = +20%)
  abilityPower?: number;
  // additive fraction
  lifesteal?: number;
}

export type ActiveKind = "haste" | "heal" | "cleanse" | "blink" | "shield";

export interface ItemDef {
  id: string;
  name: string;
  cost: number;
  desc: string;
  icon: string;
  stats: ItemStats;
  active?: { kind: ActiveKind; cooldown: number; amount?: number; range?: number; desc: string };
}

export const ITEMS: ItemDef[] = [
  {
    cost: 450,
    desc: "+0.8 move speed.",
    icon: "item-boots",
    id: "boots",
    name: "Sprinters",
    stats: { moveSpeed: 0.8 },
  },
  {
    cost: 550,
    desc: "+260 HP, +3 HP regen.",
    icon: "item-vitality",
    id: "vitality",
    name: "Vital Stone",
    stats: { hp: 260, hpRegen: 3 },
  },
  {
    cost: 700,
    desc: "+18 attack damage.",
    icon: "item-whetstone",
    id: "whetstone",
    name: "Whetstone",
    stats: { damage: 18 },
  },
  {
    cost: 650,
    desc: "+6 armor.",
    icon: "item-ringmail",
    id: "ringmail",
    name: "Ringmail",
    stats: { armor: 6 },
  },
  {
    cost: 800,
    desc: "+20% magic resist.",
    icon: "item-wardstone",
    id: "wardstone",
    name: "Wardstone",
    stats: { magicResist: 0.2 },
  },
  {
    cost: 900,
    desc: "+0.30 attack speed, +8 damage.",
    icon: "item-quiver",
    id: "quiver",
    name: "Swift Quiver",
    stats: { attackSpeed: 30, damage: 8 },
  },
  {
    cost: 950,
    desc: "+18% ability power, +150 health.",
    icon: "item-tome",
    id: "tome",
    name: "Arcane Tome",
    stats: { abilityPower: 0.18, hp: 150 },
  },
  {
    cost: 1300,
    desc: "+15% lifesteal, +12 damage.",
    icon: "item-vampiric",
    id: "vampiric",
    name: "Vampiric Edge",
    stats: { damage: 12, lifesteal: 0.15 },
  },
  {
    cost: 1700,
    desc: "+30% ability power, +180 health.",
    icon: "item-arcaneorb",
    id: "arcaneorb",
    name: "Arcane Orb",
    stats: { abilityPower: 0.3, damage: 10, hp: 180 },
  },
  {
    cost: 1700,
    desc: "+38 attack damage, +0.15 attack speed.",
    icon: "item-reaver",
    id: "reaver",
    name: "Reaver's Edge",
    stats: { attackSpeed: 15, damage: 38 },
  },
  {
    active: { amount: 320, cooldown: 35, desc: "Heal 320 HP.", kind: "heal" },
    cost: 700,
    desc: "+4 HP regen. Active: heal.",
    icon: "item-elixir",
    id: "elixir",
    name: "Elixir Flask",
    stats: { hpRegen: 4 },
  },
  {
    active: { cooldown: 24, desc: "Clear disables.", kind: "cleanse" },
    cost: 900,
    desc: "+12% magic resist. Active: cleanse.",
    icon: "item-talisman",
    id: "talisman",
    name: "Cleanse Talisman",
    stats: { magicResist: 0.12 },
  },
  {
    active: { amount: 40, cooldown: 30, desc: "+40% move speed, 3s.", kind: "haste" },
    cost: 1100,
    desc: "+1.3 move speed, +0.18 attack speed. Active: haste.",
    icon: "item-swiftboots",
    id: "swiftboots",
    name: "Phase Sandals",
    stats: { attackSpeed: 18, moveSpeed: 1.3 },
  },
  {
    active: { amount: 350, cooldown: 45, desc: "Shield 350, 4s.", kind: "shield" },
    cost: 1500,
    desc: "+320 HP, +5 armor. Active: shield.",
    icon: "item-bulwark",
    id: "bulwark",
    name: "Aegis Bulwark",
    stats: { armor: 5, hp: 320 },
  },
  {
    active: { cooldown: 14, desc: "Blink 9 units.", kind: "blink", range: 9 },
    cost: 1600,
    desc: "+0.6 move speed, +180 HP. Active: blink.",
    icon: "item-phaseband",
    id: "phaseband",
    name: "Phaseband",
    stats: { hp: 180, moveSpeed: 0.6 },
  },
];

export const ITEM_BY_ID: Record<string, ItemDef> = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
export const MAX_ITEMS = 6;

/** Sum every stat across a held item list. */
export const sumItemStats = (items: string[]): Required<ItemStats> => {
  const acc: Required<ItemStats> = {
    abilityPower: 0,
    armor: 0,
    attackSpeed: 0,
    damage: 0,
    hp: 0,
    hpRegen: 0,
    lifesteal: 0,
    magicResist: 0,
    moveSpeed: 0,
    mp: 0,
    mpRegen: 0,
  };
  for (const id of items) {
    const it = ITEM_BY_ID[id];
    if (!it) {
      continue;
    }
    // SAFETY: acc is the literal built just above with exactly the ItemStats
    // keys, so Object.keys over it is precisely keyof ItemStats.
    for (const k of Object.keys(acc) as (keyof ItemStats)[]) {
      acc[k] += it.stats[k] ?? 0;
    }
  }
  return acc;
};
