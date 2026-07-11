import { rand } from "../sys/rng";

// In-run relics: passive run modifiers bought at shrines or found in caches.
// Effects fold into RunMods, consumed at a few choke points: dmgOut (dmg, rage,
// crit), the kill handler (lifesteal), the hit handler (armor), room-clear
// (regen) and gainGold (goldMult). Relics are grouped by rarity, which sets how
// often they're offered and roughly what they cost. Synergy relics deliberately
// key off other stats (missing hearts, crit) so builds compound.
export type RunMods = {
  dmg: number; // flat damage multiplier
  maxHearts: number;
  lifesteal: number; // chance to heal 1 on kill
  goldMult: number;
  armor: number; // chance to fully block a hit
  crit: number; // chance to land a critical hit
  critMult: number; // critical-hit damage multiplier
  regen: number; // hearts healed when a room is cleared
  rage: number; // extra damage multiplier per missing heart
};

export const baseMods = (): RunMods => ({
  dmg: 1,
  maxHearts: 4,
  lifesteal: 0,
  goldMult: 1,
  armor: 0,
  crit: 0,
  critMult: 1.5,
  regen: 0,
  rage: 0,
});

export type Rarity = "common" | "rare" | "legendary";
export type Relic = {
  id: string;
  name: string;
  desc: string;
  price: number;
  rarity: Rarity;
  apply: (m: RunMods) => void;
};

// How often each rarity surfaces in an offer (relative weights).
const RARITY_WEIGHT: Record<Rarity, number> = { common: 60, rare: 28, legendary: 10 };

// Shop colour per rarity, so value reads at a glance (grey / blue / gold).
export const RARITY_COLOR: Record<Rarity, number> = {
  common: 0x9fb0c4,
  rare: 0x5ca8ff,
  legendary: 0xffb43c,
};

export const RELICS: Relic[] = [
  // ── common ──────────────────────────────────────────────────────────────
  {
    id: "fury",
    name: "Fury Brand",
    desc: "+30% damage",
    price: 22,
    rarity: "common",
    apply: (m) => (m.dmg += 0.3),
  },
  {
    id: "keen",
    name: "Keen Fang",
    desc: "+12% crit chance",
    price: 24,
    rarity: "common",
    apply: (m) => (m.crit += 0.12),
  },
  {
    id: "vigor",
    name: "Vigor Charm",
    desc: "+1 max heart",
    price: 24,
    rarity: "common",
    apply: (m) => (m.maxHearts += 1),
  },
  {
    id: "ward",
    name: "Ward Stone",
    desc: "22% block",
    price: 26,
    rarity: "common",
    apply: (m) => (m.armor += 0.22),
  },
  {
    id: "leech",
    name: "Leech Sigil",
    desc: "20% lifesteal",
    price: 30,
    rarity: "common",
    apply: (m) => (m.lifesteal += 0.2),
  },
  {
    id: "greed",
    name: "Greed Idol",
    desc: "+50% gold",
    price: 16,
    rarity: "common",
    apply: (m) => (m.goldMult += 0.5),
  },
  {
    id: "mend",
    name: "Mending Moss",
    desc: "heal 1 per room cleared",
    price: 28,
    rarity: "common",
    apply: (m) => (m.regen += 1),
  },
  // ── rare ────────────────────────────────────────────────────────────────
  {
    id: "edge",
    name: "Moon Edge",
    desc: "+60% damage",
    price: 40,
    rarity: "rare",
    apply: (m) => (m.dmg += 0.6),
  },
  {
    id: "assassin",
    name: "Assassin's Mark",
    desc: "+20% crit, +50% crit damage",
    price: 46,
    rarity: "rare",
    apply: (m) => ((m.crit += 0.2), (m.critMult += 0.5)),
  },
  {
    id: "heartroot",
    name: "Heartroot",
    desc: "+2 max hearts",
    price: 44,
    rarity: "rare",
    apply: (m) => (m.maxHearts += 2),
  },
  {
    id: "aegis",
    name: "Aegis Sigil",
    desc: "40% block",
    price: 44,
    rarity: "rare",
    apply: (m) => (m.armor += 0.4),
  },
  {
    id: "sanguine",
    name: "Sanguine Crown",
    desc: "35% lifesteal",
    price: 46,
    rarity: "rare",
    apply: (m) => (m.lifesteal += 0.35),
  },
  {
    id: "fortune",
    name: "Fortune Coin",
    desc: "+100% gold",
    price: 34,
    rarity: "rare",
    apply: (m) => (m.goldMult += 1),
  },
  {
    id: "bloodpact",
    name: "Blood Pact",
    desc: "+12% damage per missing heart",
    price: 42,
    rarity: "rare",
    apply: (m) => (m.rage += 0.12),
  },
  {
    id: "warden",
    name: "Warden's Oath",
    desc: "+1 heart, 25% block",
    price: 42,
    rarity: "rare",
    apply: (m) => ((m.maxHearts += 1), (m.armor += 0.25)),
  },
  {
    id: "moonwell",
    name: "Moonwell",
    desc: "+1 heart, heal 1 per room",
    price: 44,
    rarity: "rare",
    apply: (m) => ((m.maxHearts += 1), (m.regen += 1)),
  },
  // ── legendary ───────────────────────────────────────────────────────────
  {
    id: "glassmoon",
    name: "Glass Moon",
    desc: "+120% damage, −1 max heart",
    price: 58,
    rarity: "legendary",
    apply: (m) => ((m.dmg += 1.2), (m.maxHearts -= 1)),
  },
  {
    id: "executioner",
    name: "Executioner",
    desc: "+25% crit, +100% crit damage",
    price: 62,
    rarity: "legendary",
    apply: (m) => ((m.crit += 0.25), (m.critMult += 1)),
  },
  {
    id: "berserker",
    name: "Berserker's Heart",
    desc: "+80% damage, 25% lifesteal, −1 heart",
    price: 66,
    rarity: "legendary",
    apply: (m) => ((m.dmg += 0.8), (m.lifesteal += 0.25), (m.maxHearts -= 1)),
  },
  {
    id: "phoenix",
    name: "Phoenix Ember",
    desc: "+1 heart, heal 2 per room",
    price: 60,
    rarity: "legendary",
    apply: (m) => ((m.maxHearts += 1), (m.regen += 2)),
  },
  {
    id: "wrath",
    name: "Wrathblood",
    desc: "+22% damage per missing heart",
    price: 64,
    rarity: "legendary",
    apply: (m) => (m.rage += 0.22),
  },
  {
    id: "midas",
    name: "Midas Relic",
    desc: "+150% gold, +12% crit",
    price: 52,
    rarity: "legendary",
    apply: (m) => ((m.goldMult += 1.5), (m.crit += 0.12)),
  },
  {
    id: "deathbloom",
    name: "Deathbloom",
    desc: "+22% crit, 25% lifesteal",
    price: 60,
    rarity: "legendary",
    apply: (m) => ((m.crit += 0.22), (m.lifesteal += 0.25)),
  },
];

// Pick n distinct relics, weighted by rarity so legendaries stay rare.
export function pickRelics(n: number, exclude: Set<string>): Relic[] {
  const pool = RELICS.filter((r) => !exclude.has(r.id));
  const out: Relic[] = [];
  while (out.length < n && pool.length > 0) {
    let total = 0;
    for (const r of pool) total += RARITY_WEIGHT[r.rarity];
    let roll = rand() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      const r = pool[i];
      if (!r) continue;
      roll -= RARITY_WEIGHT[r.rarity];
      if (roll <= 0) {
        idx = i;
        break;
      }
    }
    const [r] = pool.splice(idx, 1);
    if (r) out.push(r);
  }
  return out;
}
