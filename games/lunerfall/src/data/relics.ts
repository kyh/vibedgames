// In-run relics: passive run modifiers bought at shrines or found in caches.
export type RunMods = {
  dmg: number; // damage multiplier
  maxHearts: number;
  lifesteal: number; // chance to heal 1 on kill
  goldMult: number;
  armor: number; // chance to fully block a hit
};

export const baseMods = (): RunMods => ({ dmg: 1, maxHearts: 4, lifesteal: 0, goldMult: 1, armor: 0 });

export type Relic = { id: string; name: string; desc: string; price: number; apply: (m: RunMods) => void };

export const RELICS: Relic[] = [
  { id: "edge", name: "Moon Edge", desc: "+50% damage", price: 32, apply: (m) => (m.dmg += 0.5) },
  { id: "fury", name: "Fury Brand", desc: "+30% damage", price: 22, apply: (m) => (m.dmg += 0.3) },
  { id: "vigor", name: "Vigor Charm", desc: "+1 max heart", price: 24, apply: (m) => (m.maxHearts += 1) },
  { id: "heartroot", name: "Heartroot", desc: "+2 max hearts", price: 44, apply: (m) => (m.maxHearts += 2) },
  { id: "leech", name: "Leech Sigil", desc: "20% lifesteal", price: 34, apply: (m) => (m.lifesteal += 0.2) },
  { id: "ward", name: "Ward Stone", desc: "25% block", price: 30, apply: (m) => (m.armor += 0.25) },
  { id: "greed", name: "Greed Idol", desc: "+50% gold", price: 18, apply: (m) => (m.goldMult += 0.5) },
  { id: "fortune", name: "Fortune Coin", desc: "+100% gold", price: 38, apply: (m) => (m.goldMult += 1) },
];

// Pick n distinct relics at random (runtime — Math.random ok outside sim).
export function pickRelics(n: number, exclude: Set<string>): Relic[] {
  const pool = RELICS.filter((r) => !exclude.has(r.id));
  const out: Relic[] = [];
  while (out.length < n && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    const [r] = pool.splice(i, 1);
    if (r) out.push(r);
  }
  return out;
}
