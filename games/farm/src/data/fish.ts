import type { Season } from "./calendar";

export type FishId =
  | "sardine"
  | "carp"
  | "bream"
  | "bass"
  | "trout"
  | "pike"
  | "salmon"
  | "catfish"
  | "tuna"
  | "pufferfish"
  | "legend";

export type FishDef = {
  id: FishId;
  name: string;
  value: number;
  difficulty: number; // 1..5 — affects reel speed/erraticness
  seasons: readonly Season[] | "all";
  weight: number; // relative spawn weight before season/skill modifiers
};

export const FISH: Record<FishId, FishDef> = {
  sardine: { id: "sardine", name: "Sardine", value: 18, difficulty: 1, seasons: "all", weight: 10 },
  carp: { id: "carp", name: "Carp", value: 22, difficulty: 1, seasons: "all", weight: 9 },
  bream: {
    id: "bream",
    name: "Bream",
    value: 32,
    difficulty: 2,
    seasons: ["spring", "summer"],
    weight: 7,
  },
  bass: {
    id: "bass",
    name: "Bass",
    value: 45,
    difficulty: 2,
    seasons: ["spring", "fall"],
    weight: 6,
  },
  trout: {
    id: "trout",
    name: "Rainbow Trout",
    value: 55,
    difficulty: 3,
    seasons: ["summer"],
    weight: 5,
  },
  pike: {
    id: "pike",
    name: "Pike",
    value: 70,
    difficulty: 3,
    seasons: ["fall", "winter"],
    weight: 4,
  },
  salmon: { id: "salmon", name: "Salmon", value: 85, difficulty: 3, seasons: ["fall"], weight: 4 },
  catfish: {
    id: "catfish",
    name: "Catfish",
    value: 110,
    difficulty: 4,
    seasons: ["spring", "fall"],
    weight: 3,
  },
  tuna: {
    id: "tuna",
    name: "Tuna",
    value: 130,
    difficulty: 4,
    seasons: ["summer", "winter"],
    weight: 3,
  },
  pufferfish: {
    id: "pufferfish",
    name: "Pufferfish",
    value: 160,
    difficulty: 5,
    seasons: ["summer"],
    weight: 2,
  },
  legend: {
    id: "legend",
    name: "The Legend",
    value: 600,
    difficulty: 5,
    seasons: "all",
    weight: 1,
  },
};

export const FISH_IDS = [
  "sardine",
  "carp",
  "bream",
  "bass",
  "trout",
  "pike",
  "salmon",
  "catfish",
  "tuna",
  "pufferfish",
  "legend",
] as const satisfies readonly FishId[];

function inSeason(def: FishDef, season: Season): boolean {
  return def.seasons === "all" || def.seasons.includes(season);
}

// Pick a fish weighted by season, with higher fishing skill nudging toward
// rarer (lower-weight, higher-value) catches. rng() -> [0,1).
export function rollFish(season: Season, fishingLevel: number, rng: () => number): FishDef {
  const pool = FISH_IDS.map((id) => FISH[id]).filter((f) => inSeason(f, season));
  // skill shifts weight from common toward rare: rarePull in [0..~0.9]
  const rarePull = Math.min(0.9, fishingLevel * 0.09);
  const weighted = pool.map((f) => {
    const rareness = 1 / f.weight; // higher for rarer fish
    const w = f.weight * (1 - rarePull) + rareness * 40 * rarePull;
    return { f, w };
  });
  const total = weighted.reduce((s, x) => s + x.w, 0);
  let r = rng() * total;
  for (const x of weighted) {
    r -= x.w;
    if (r <= 0) return x.f;
  }
  return weighted[0]?.f ?? FISH.sardine;
}
