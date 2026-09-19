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

export interface FishDef {
  id: FishId;
  name: string;
  value: number;
  // 1..5 — affects reel speed/erraticness
  difficulty: number;
  seasons: readonly Season[] | "all";
  // relative spawn weight before season/skill modifiers
  weight: number;
}

export type FishTable = { [K in FishId]: FishDef };

export const FISH: FishTable = {
  bass: {
    difficulty: 2,
    id: "bass",
    name: "Bass",
    seasons: ["spring", "fall"],
    value: 45,
    weight: 6,
  },
  bream: {
    difficulty: 2,
    id: "bream",
    name: "Bream",
    seasons: ["spring", "summer"],
    value: 32,
    weight: 7,
  },
  carp: { difficulty: 1, id: "carp", name: "Carp", seasons: "all", value: 22, weight: 9 },
  catfish: {
    difficulty: 4,
    id: "catfish",
    name: "Catfish",
    seasons: ["spring", "fall"],
    value: 110,
    weight: 3,
  },
  legend: {
    difficulty: 5,
    id: "legend",
    name: "The Legend",
    seasons: "all",
    value: 600,
    weight: 1,
  },
  pike: {
    difficulty: 3,
    id: "pike",
    name: "Pike",
    seasons: ["fall", "winter"],
    value: 70,
    weight: 4,
  },
  pufferfish: {
    difficulty: 5,
    id: "pufferfish",
    name: "Pufferfish",
    seasons: ["summer"],
    value: 160,
    weight: 2,
  },
  salmon: { difficulty: 3, id: "salmon", name: "Salmon", seasons: ["fall"], value: 85, weight: 4 },
  sardine: { difficulty: 1, id: "sardine", name: "Sardine", seasons: "all", value: 18, weight: 10 },
  trout: {
    difficulty: 3,
    id: "trout",
    name: "Rainbow Trout",
    seasons: ["summer"],
    value: 55,
    weight: 5,
  },
  tuna: {
    difficulty: 4,
    id: "tuna",
    name: "Tuna",
    seasons: ["summer", "winter"],
    value: 130,
    weight: 3,
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

const inSeason = (def: FishDef, season: Season): boolean =>
  def.seasons === "all" || def.seasons.includes(season);

// Pick a fish weighted by season, with higher fishing skill nudging toward
// rarer (lower-weight, higher-value) catches. rng() -> [0,1).
export const rollFish = (season: Season, fishingLevel: number, rng: () => number): FishDef => {
  const pool = FISH_IDS.map((id) => FISH[id]).filter((f) => inSeason(f, season));
  // skill shifts weight from common toward rare: rarePull in [0..~0.9]
  const rarePull = Math.min(0.9, fishingLevel * 0.09);
  const weighted = pool.map((f) => {
    // higher for rarer fish
    const rareness = 1 / f.weight;
    const w = f.weight * (1 - rarePull) + rareness * 40 * rarePull;
    return { f, w };
  });
  const total = weighted.reduce((s, x) => s + x.w, 0);
  let r = rng() * total;
  for (const x of weighted) {
    r -= x.w;
    if (r <= 0) {
      return x.f;
    }
  }
  return weighted[0]?.f ?? FISH.sardine;
};
