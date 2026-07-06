// Persistent meta-progress (localStorage). Runs bank "shards"; shards unlock the
// locked warriors in the hub. Parsed defensively at the boundary.
import type { HeroName } from "./animations";

export type MetaState = { shards: number; unlocked: string[]; bestDepth: number; runs: number };

const KEY = "lunerfall.meta.v1";
const DEFAULT_UNLOCKED = ["axion", "reaper"];

// Warrior unlock costs in shards (0 = free from the start).
export const UNLOCK_COST: Record<HeroName, number> = {
  axion: 0,
  reaper: 0,
  riven: 20,
  mooni: 35,
  salamander: 45,
};

export function loadMeta(): MetaState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { shards: 0, unlocked: [...DEFAULT_UNLOCKED], bestDepth: 0, runs: 0 };
    const p: unknown = JSON.parse(raw);
    const o = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
    const unlocked = Array.isArray(o.unlocked) ? o.unlocked.filter((x): x is string => typeof x === "string") : [...DEFAULT_UNLOCKED];
    return {
      shards: typeof o.shards === "number" ? o.shards : 0,
      unlocked: unlocked.length > 0 ? unlocked : [...DEFAULT_UNLOCKED],
      bestDepth: typeof o.bestDepth === "number" ? o.bestDepth : 0,
      runs: typeof o.runs === "number" ? o.runs : 0,
    };
  } catch {
    return { shards: 0, unlocked: [...DEFAULT_UNLOCKED], bestDepth: 0, runs: 0 };
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
  const earned = Math.floor(gold / 4) + depth * 2 + (biome - 1) * 6;
  m.shards += earned;
  m.bestDepth = Math.max(m.bestDepth, depth);
  m.runs += 1;
  saveMeta(m);
  return earned;
}
