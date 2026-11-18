import { isJsonNumber, isJsonObject, isJsonString } from "../net/json";
import type { JsonValue } from "../net/json";
import type { HeroName } from "./animations";

export interface MetaState {
  shards: number;
  unlocked: string[];
  bestDepth: number;
  runs: number;
  upgrades: Record<string, number>;
}

const KEY = "lunerfall.meta.v1";
const DEFAULT_UNLOCKED = ["axion", "reaper"];

export interface Upgrade {
  id: string;
  name: string;
  desc: string;
  max: number;
  cost: (level: number) => number;
}

export const UPGRADES: readonly Upgrade[] = [
  {
    cost: (l) => 30 + l * 26,
    desc: "+1 starting max heart",
    id: "vitality",
    max: 3,
    name: "Vitality",
  },
  {
    cost: (l) => 22 + l * 20,
    desc: "+10% starting damage",
    id: "edge",
    max: 4,
    name: "Honed Edge",
  },
  { cost: (l) => 26 + l * 24, desc: "+8% block chance", id: "warding", max: 3, name: "Warding" },
  { cost: (l) => 20 + l * 22, desc: "+15% shards earned", id: "fortune", max: 3, name: "Fortune" },
];

export const upgradeLevel = (m: MetaState, id: string) => m.upgrades[id] ?? 0;

export interface RunBonuses {
  hearts: number;
  dmg: number;
  armor: number;
}

export const runBonuses = (m: MetaState) => ({
  armor: upgradeLevel(m, "warding") * 0.08,
  dmg: upgradeLevel(m, "edge") * 0.1,
  hearts: upgradeLevel(m, "vitality"),
});

export const saveMeta = (m: MetaState) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));

    return true;
  } catch {
    return false;
  }
};

export const buyUpgrade = (m: MetaState, id: string) => {
  const up = UPGRADES.find((u) => u.id === id);

  if (!up) {
    return false;
  }

  const level = upgradeLevel(m, id);

  if (level >= up.max) {
    return false;
  }

  const price = up.cost(level);

  if (m.shards < price) {
    return false;
  }

  m.shards -= price;
  m.upgrades[id] = level + 1;
  saveMeta(m);

  return true;
};

export const UNLOCK_COST = {
  axion: 0,
  mooni: 35,
  reaper: 0,
  riven: 20,
  salamander: 45,
} satisfies Record<HeroName, number>;

const fresh: () => MetaState = () => ({
  bestDepth: 0,
  runs: 0,
  shards: 0,
  unlocked: [...DEFAULT_UNLOCKED],
  upgrades: {},
});

export const loadMeta: () => MetaState = () => {
  try {
    const raw = localStorage.getItem(KEY);

    if (!raw) {
      return fresh();
    }

    const p: JsonValue = JSON.parse(raw);
    const o = isJsonObject(p) ? p : {};

    const unlocked = Array.isArray(o.unlocked)
      ? o.unlocked.filter(isJsonString)
      : [...DEFAULT_UNLOCKED];

    const upgrades: Record<string, number> = {};
    const rawUp = o.upgrades;

    if (isJsonObject(rawUp)) {
      for (const [k, v] of Object.entries(rawUp)) {
        if (isJsonNumber(v)) {
          upgrades[k] = Math.max(0, Math.floor(v));
        }
      }
    }

    return {
      bestDepth: isJsonNumber(o.bestDepth) ? o.bestDepth : 0,
      runs: isJsonNumber(o.runs) ? o.runs : 0,
      shards: isJsonNumber(o.shards) ? o.shards : 0,
      unlocked: unlocked.length > 0 ? unlocked : [...DEFAULT_UNLOCKED],
      upgrades,
    };
  } catch {
    return fresh();
  }
};

export const isUnlocked = (m: MetaState, name: HeroName) =>
  UNLOCK_COST[name] === 0 || m.unlocked.includes(name);

const SCORE_KEY = "lunerfall.bestscore.v1";

export const loadBestScore = () => {
  try {
    const v = Number(localStorage.getItem(SCORE_KEY));

    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
};

export const recordBestScore = (score: number) => {
  const best = loadBestScore();

  if (score <= best) {
    return best;
  }

  try {
    localStorage.setItem(SCORE_KEY, String(score));
  } catch {
    return score;
  }

  return score;
};

export const unlockHero = (m: MetaState, name: HeroName) => {
  if (isUnlocked(m, name)) {
    return true;
  }

  const cost = UNLOCK_COST[name];

  if (m.shards < cost) {
    return false;
  }

  m.shards -= cost;
  m.unlocked.push(name);
  saveMeta(m);

  return true;
};

export const bankRun = (m: MetaState, gold: number, depth: number, biome: number) => {
  const base = Math.floor(gold / 4) + depth * 2 + (biome - 1) * 6;
  const earned = Math.round(base * (1 + upgradeLevel(m, "fortune") * 0.15));
  m.shards += earned;
  m.bestDepth = Math.max(m.bestDepth, depth);
  m.runs += 1;
  saveMeta(m);

  return earned;
};
