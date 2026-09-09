import { rand } from "../sys/rng";

// In-run relics: passive run modifiers bought at shrines or found in caches.
// Effects fold into RunMods, consumed at a few choke points: dmgOut (dmg, rage,
// crit), the kill handler (lifesteal), the hit handler (armor), room-clear
// (regen) and gainGold (goldMult). Relics are grouped by rarity, which sets how
// often they're offered and roughly what they cost. Synergy relics deliberately
// key off other stats (missing hearts, crit) so builds compound.
export interface RunMods {
  // flat damage multiplier
  dmg: number;
  maxHearts: number;
  // chance to heal 1 on kill
  lifesteal: number;
  goldMult: number;
  // chance to fully block a hit
  armor: number;
  // chance to land a critical hit
  crit: number;
  // critical-hit damage multiplier
  critMult: number;
  // hearts healed when a room is cleared
  regen: number;
  // extra damage multiplier per missing heart
  rage: number;
}

export const baseMods = (): RunMods => ({
  armor: 0,
  crit: 0,
  critMult: 1.5,
  dmg: 1,
  goldMult: 1,
  lifesteal: 0,
  maxHearts: 4,
  rage: 0,
  regen: 0,
});

export type Rarity = "common" | "rare" | "legendary";
export interface Relic {
  id: string;
  name: string;
  desc: string;
  price: number;
  rarity: Rarity;
  apply: (m: RunMods) => void;
}

// How often each rarity surfaces in an offer (relative weights).
const RARITY_WEIGHT = { common: 60, legendary: 10, rare: 28 } satisfies Record<Rarity, number>;

// Shop colour per rarity, so value reads at a glance (grey / blue / gold).
export const RARITY_COLOR = {
  common: 0x9f_b0_c4,
  legendary: 0xff_b4_3c,
  rare: 0x5c_a8_ff,
} satisfies Record<Rarity, number>;

export const RELICS: Relic[] = [
  // ── common ──────────────────────────────────────────────────────────────
  {
    apply: (m) => (m.dmg += 0.3),
    desc: "+30% damage",
    id: "fury",
    name: "Fury Brand",
    price: 22,
    rarity: "common",
  },
  {
    apply: (m) => (m.crit += 0.12),
    desc: "+12% crit chance",
    id: "keen",
    name: "Keen Fang",
    price: 24,
    rarity: "common",
  },
  {
    apply: (m) => (m.maxHearts += 1),
    desc: "+1 max heart",
    id: "vigor",
    name: "Vigor Charm",
    price: 24,
    rarity: "common",
  },
  {
    apply: (m) => (m.armor += 0.22),
    desc: "22% block",
    id: "ward",
    name: "Ward Stone",
    price: 26,
    rarity: "common",
  },
  {
    apply: (m) => (m.lifesteal += 0.2),
    desc: "20% lifesteal",
    id: "leech",
    name: "Leech Sigil",
    price: 30,
    rarity: "common",
  },
  {
    apply: (m) => (m.goldMult += 0.5),
    desc: "+50% gold",
    id: "greed",
    name: "Greed Idol",
    price: 16,
    rarity: "common",
  },
  {
    apply: (m) => (m.regen += 1),
    desc: "heal 1 per room cleared",
    id: "mend",
    name: "Mending Moss",
    price: 28,
    rarity: "common",
  },
  // ── rare ────────────────────────────────────────────────────────────────
  {
    apply: (m) => (m.dmg += 0.6),
    desc: "+60% damage",
    id: "edge",
    name: "Moon Edge",
    price: 40,
    rarity: "rare",
  },
  {
    apply: (m) => {
      m.crit += 0.2;
      m.critMult += 0.5;
    },
    desc: "+20% crit, +50% crit damage",
    id: "assassin",
    name: "Assassin's Mark",
    price: 46,
    rarity: "rare",
  },
  {
    apply: (m) => (m.maxHearts += 2),
    desc: "+2 max hearts",
    id: "heartroot",
    name: "Heartroot",
    price: 44,
    rarity: "rare",
  },
  {
    apply: (m) => (m.armor += 0.4),
    desc: "40% block",
    id: "aegis",
    name: "Aegis Sigil",
    price: 44,
    rarity: "rare",
  },
  {
    apply: (m) => (m.lifesteal += 0.35),
    desc: "35% lifesteal",
    id: "sanguine",
    name: "Sanguine Crown",
    price: 46,
    rarity: "rare",
  },
  {
    apply: (m) => (m.goldMult += 1),
    desc: "+100% gold",
    id: "fortune",
    name: "Fortune Coin",
    price: 34,
    rarity: "rare",
  },
  {
    apply: (m) => (m.rage += 0.12),
    desc: "+12% damage per missing heart",
    id: "bloodpact",
    name: "Blood Pact",
    price: 42,
    rarity: "rare",
  },
  {
    apply: (m) => {
      m.maxHearts += 1;
      m.armor += 0.25;
    },
    desc: "+1 heart, 25% block",
    id: "warden",
    name: "Warden's Oath",
    price: 42,
    rarity: "rare",
  },
  {
    apply: (m) => {
      m.maxHearts += 1;
      m.regen += 1;
    },
    desc: "+1 heart, heal 1 per room",
    id: "moonwell",
    name: "Moonwell",
    price: 44,
    rarity: "rare",
  },
  // ── legendary ───────────────────────────────────────────────────────────
  {
    apply: (m) => {
      m.dmg += 1.2;
      m.maxHearts -= 1;
    },
    desc: "+120% damage, −1 max heart",
    id: "glassmoon",
    name: "Glass Moon",
    price: 58,
    rarity: "legendary",
  },
  {
    apply: (m) => {
      m.crit += 0.25;
      m.critMult += 1;
    },
    desc: "+25% crit, +100% crit damage",
    id: "executioner",
    name: "Executioner",
    price: 62,
    rarity: "legendary",
  },
  {
    apply: (m) => {
      m.dmg += 0.8;
      m.lifesteal += 0.25;
      m.maxHearts -= 1;
    },
    desc: "+80% damage, 25% lifesteal, −1 heart",
    id: "berserker",
    name: "Berserker's Heart",
    price: 66,
    rarity: "legendary",
  },
  {
    apply: (m) => {
      m.maxHearts += 1;
      m.regen += 2;
    },
    desc: "+1 heart, heal 2 per room",
    id: "phoenix",
    name: "Phoenix Ember",
    price: 60,
    rarity: "legendary",
  },
  {
    apply: (m) => (m.rage += 0.22),
    desc: "+22% damage per missing heart",
    id: "wrath",
    name: "Wrathblood",
    price: 64,
    rarity: "legendary",
  },
  {
    apply: (m) => {
      m.goldMult += 1.5;
      m.crit += 0.12;
    },
    desc: "+150% gold, +12% crit",
    id: "midas",
    name: "Midas Relic",
    price: 52,
    rarity: "legendary",
  },
  {
    apply: (m) => {
      m.crit += 0.22;
      m.lifesteal += 0.25;
    },
    desc: "+22% crit, 25% lifesteal",
    id: "deathbloom",
    name: "Deathbloom",
    price: 60,
    rarity: "legendary",
  },
];

// Pick n distinct relics, weighted by rarity so legendaries stay rare.
export const pickRelics = (n: number, exclude: Set<string>): Relic[] => {
  const pool = RELICS.filter((r) => !exclude.has(r.id));
  const out: Relic[] = [];
  while (out.length < n && pool.length > 0) {
    let total = 0;
    for (const r of pool) {
      total += RARITY_WEIGHT[r.rarity];
    }
    let roll = rand() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i += 1) {
      const r = pool[i];
      if (!r) {
        continue;
      }
      roll -= RARITY_WEIGHT[r.rarity];
      if (roll <= 0) {
        idx = i;
        break;
      }
    }
    const [r] = pool.splice(idx, 1);
    if (r) {
      out.push(r);
    }
  }
  return out;
};
