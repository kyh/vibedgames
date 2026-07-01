// Curated shop (build-doc §10e). Short on purpose — a few stat sticks plus a
// handful of actives. Balance with the game-balance skill once playable; audit
// for a dominant item. Shop is only usable in your own base.

export type ItemStats = {
  damage?: number;
  hp?: number;
  mp?: number;
  armor?: number;
  magicResist?: number; // additive fraction (0.2 = +20% mitigation)
  moveSpeed?: number;
  hpRegen?: number;
  mpRegen?: number;
  attackSpeed?: number; // attacks/sec bonus points ×100 (30 = +0.30 aps via stats)
  abilityPower?: number; // additive fraction to ability damage (0.2 = +20%)
  lifesteal?: number; // additive fraction
};

export type ActiveKind = "haste" | "heal" | "cleanse" | "blink" | "shield";

export type ItemDef = {
  id: string;
  name: string;
  cost: number;
  desc: string;
  icon: string;
  stats: ItemStats;
  active?: { kind: ActiveKind; cooldown: number; amount?: number; range?: number; desc: string };
};

export const ITEMS: ItemDef[] = [
  { id: "boots", name: "Sprinters", cost: 450, icon: "item-boots", stats: { moveSpeed: 0.8 }, desc: "+0.8 move speed." },
  { id: "vitality", name: "Vital Stone", cost: 550, icon: "item-vitality", stats: { hp: 260, hpRegen: 3 }, desc: "+260 HP, +3 HP regen." },
  { id: "whetstone", name: "Whetstone", cost: 700, icon: "item-whetstone", stats: { damage: 18 }, desc: "+18 attack damage." },
  { id: "ringmail", name: "Ringmail", cost: 650, icon: "item-ringmail", stats: { armor: 6 }, desc: "+6 armor." },
  { id: "wardstone", name: "Wardstone", cost: 800, icon: "item-wardstone", stats: { magicResist: 0.2 }, desc: "+20% magic resist." },
  { id: "quiver", name: "Swift Quiver", cost: 900, icon: "item-quiver", stats: { attackSpeed: 30, damage: 8 }, desc: "+0.30 attack speed, +8 damage." },
  { id: "tome", name: "Arcane Tome", cost: 950, icon: "item-tome", stats: { abilityPower: 0.18, hp: 150 }, desc: "+18% ability power, +150 health." },
  { id: "vampiric", name: "Vampiric Edge", cost: 1300, icon: "item-vampiric", stats: { lifesteal: 0.15, damage: 12 }, desc: "+15% lifesteal, +12 damage." },
  { id: "arcaneorb", name: "Arcane Orb", cost: 1700, icon: "item-arcaneorb", stats: { abilityPower: 0.3, hp: 180, damage: 10 }, desc: "+30% ability power, +180 health." },
  { id: "reaver", name: "Reaver's Edge", cost: 1700, icon: "item-reaver", stats: { damage: 38, attackSpeed: 15 }, desc: "+38 attack damage, +0.15 attack speed." },
  { id: "elixir", name: "Elixir Flask", cost: 700, icon: "item-elixir", stats: { hpRegen: 4 }, active: { kind: "heal", cooldown: 35, amount: 320, desc: "Heal 320 HP." }, desc: "+4 HP regen. Active: heal." },
  { id: "talisman", name: "Cleanse Talisman", cost: 900, icon: "item-talisman", stats: { magicResist: 0.12 }, active: { kind: "cleanse", cooldown: 24, desc: "Clear disables." }, desc: "+12% magic resist. Active: cleanse." },
  { id: "swiftboots", name: "Phase Sandals", cost: 1100, icon: "item-swiftboots", stats: { moveSpeed: 1.3, attackSpeed: 18 }, active: { kind: "haste", cooldown: 30, amount: 40, desc: "+40% move speed, 3s." }, desc: "+1.3 move speed, +0.18 attack speed. Active: haste." },
  { id: "bulwark", name: "Aegis Bulwark", cost: 1500, icon: "item-bulwark", stats: { hp: 320, armor: 5 }, active: { kind: "shield", cooldown: 45, amount: 350, desc: "Shield 350, 4s." }, desc: "+320 HP, +5 armor. Active: shield." },
  { id: "phaseband", name: "Phaseband", cost: 1600, icon: "item-phaseband", stats: { moveSpeed: 0.6, hp: 180 }, active: { kind: "blink", cooldown: 14, range: 9, desc: "Blink 9 units." }, desc: "+0.6 move speed, +180 HP. Active: blink." },
];

export const ITEM_BY_ID: Record<string, ItemDef> = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
export const MAX_ITEMS = 6;

/** Sum every stat across a held item list. */
export function sumItemStats(items: string[]): Required<ItemStats> {
  const acc: Required<ItemStats> = {
    damage: 0, hp: 0, mp: 0, armor: 0, magicResist: 0, moveSpeed: 0,
    hpRegen: 0, mpRegen: 0, attackSpeed: 0, abilityPower: 0, lifesteal: 0,
  };
  for (const id of items) {
    const it = ITEM_BY_ID[id];
    if (!it) continue;
    for (const k of Object.keys(acc) as (keyof ItemStats)[]) {
      acc[k] += it.stats[k] ?? 0;
    }
  }
  return acc;
}
