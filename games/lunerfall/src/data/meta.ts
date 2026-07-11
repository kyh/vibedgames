// Persistent meta-progress (localStorage). Runs bank "shards"; shards unlock the
// locked warriors in the hub. Parsed defensively at the boundary.
import type { HeroName } from "./animations";

export type MetaState = {
  shards: number;
  unlocked: string[];
  bestDepth: number;
  runs: number;
  upgrades: Record<string, number>; // permanent upgrade id → purchased level
};

const KEY = "lunerfall.meta.v1";
const DEFAULT_UNLOCKED = ["axion", "reaper"];

// Permanent meta upgrades bought with shards in the hub. Each level is applied at
// run start (see runBonuses / bankRun), so a death always advances something.
export type Upgrade = {
  id: string;
  name: string;
  desc: string;
  max: number;
  cost: (level: number) => number; // shards to go from `level` → level+1
};

export const UPGRADES: readonly Upgrade[] = [
  {
    id: "vitality",
    name: "Vitality",
    desc: "+1 starting max heart",
    max: 3,
    cost: (l) => 30 + l * 26,
  },
  {
    id: "edge",
    name: "Honed Edge",
    desc: "+10% starting damage",
    max: 4,
    cost: (l) => 22 + l * 20,
  },
  { id: "warding", name: "Warding", desc: "+8% block chance", max: 3, cost: (l) => 26 + l * 24 },
  { id: "fortune", name: "Fortune", desc: "+15% shards earned", max: 3, cost: (l) => 20 + l * 22 },
];

export const upgradeLevel = (m: MetaState, id: string): number => m.upgrades[id] ?? 0;

// Run-start bonuses derived from purchased upgrade levels.
export type RunBonuses = { hearts: number; dmg: number; armor: number };
export const runBonuses = (m: MetaState): RunBonuses => ({
  hearts: upgradeLevel(m, "vitality"),
  dmg: upgradeLevel(m, "edge") * 0.1,
  armor: upgradeLevel(m, "warding") * 0.08,
});

// Spend shards to buy the next level of an upgrade. Returns true on success.
export function buyUpgrade(m: MetaState, id: string): boolean {
  const up = UPGRADES.find((u) => u.id === id);
  if (!up) return false;
  const level = upgradeLevel(m, id);
  if (level >= up.max) return false;
  const price = up.cost(level);
  if (m.shards < price) return false;
  m.shards -= price;
  m.upgrades[id] = level + 1;
  saveMeta(m);
  return true;
}

// Warrior unlock costs in shards (0 = free from the start).
export const UNLOCK_COST: Record<HeroName, number> = {
  axion: 0,
  reaper: 0,
  riven: 20,
  mooni: 35,
  salamander: 45,
};

const fresh = (): MetaState => ({
  shards: 0,
  unlocked: [...DEFAULT_UNLOCKED],
  bestDepth: 0,
  runs: 0,
  upgrades: {},
});

export function loadMeta(): MetaState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const p: unknown = JSON.parse(raw);
    const o = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
    const unlocked = Array.isArray(o.unlocked)
      ? o.unlocked.filter((x): x is string => typeof x === "string")
      : [...DEFAULT_UNLOCKED];
    const upgrades: Record<string, number> = {};
    const rawUp = o.upgrades;
    if (typeof rawUp === "object" && rawUp !== null) {
      for (const [k, v] of Object.entries(rawUp)) {
        if (typeof v === "number" && Number.isFinite(v)) upgrades[k] = Math.max(0, Math.floor(v));
      }
    }
    return {
      shards: typeof o.shards === "number" ? o.shards : 0,
      unlocked: unlocked.length > 0 ? unlocked : [...DEFAULT_UNLOCKED],
      bestDepth: typeof o.bestDepth === "number" ? o.bestDepth : 0,
      runs: typeof o.runs === "number" ? o.runs : 0,
      upgrades,
    };
  } catch {
    return fresh();
  }
}

export function saveMeta(m: MetaState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* storage unavailable — meta is best-effort */
  }
}

export function isUnlocked(m: MetaState, name: HeroName): boolean {
  return UNLOCK_COST[name] === 0 || m.unlocked.includes(name);
}

// Best run score — its own key so it stays independent of the shard economy.
const SCORE_KEY = "lunerfall.bestscore.v1";
export function loadBestScore(): number {
  try {
    const v = Number(localStorage.getItem(SCORE_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}
// Record a finished run's score; returns the (possibly new) best.
export function recordBestScore(score: number): number {
  const best = loadBestScore();
  if (score <= best) return best;
  try {
    localStorage.setItem(SCORE_KEY, String(score));
  } catch {
    /* storage unavailable — best score is best-effort */
  }
  return score;
}

// Try to spend shards to unlock a warrior. Returns true if now unlocked.
export function unlockHero(m: MetaState, name: HeroName): boolean {
  if (isUnlocked(m, name)) return true;
  const cost = UNLOCK_COST[name];
  if (m.shards < cost) return false;
  m.shards -= cost;
  m.unlocked.push(name);
  saveMeta(m);
  return true;
}

// Bank a finished run; returns shards earned.
export function bankRun(m: MetaState, gold: number, depth: number, biome: number): number {
  const base = Math.floor(gold / 4) + depth * 2 + (biome - 1) * 6;
  const earned = Math.round(base * (1 + upgradeLevel(m, "fortune") * 0.15));
  m.shards += earned;
  m.bestDepth = Math.max(m.bestDepth, depth);
  m.runs += 1;
  saveMeta(m);
  return earned;
}
