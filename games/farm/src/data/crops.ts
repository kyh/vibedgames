// Crop definitions. Each crop has 6 art stages (00..05). `growthDays` is the
// number of *watered* days from planting to fully grown (stage 5). Stages are
// distributed across that span. Seeds bought in shop; produce sold there/bin.

export type CropId =
  | "parsnip"
  | "potato"
  | "carrot"
  | "cauliflower"
  | "kale"
  | "cabbage"
  | "beetroot"
  | "radish"
  | "pumpkin"
  | "wheat"
  | "sunflower";

import type { Season } from "./calendar";

export type CropDef = {
  id: CropId;
  name: string;
  growthDays: number; // watered days to reach final stage
  seedPrice: number;
  sellPrice: number; // per produce
  yield: [number, number]; // min,max produce on harvest
  seasons: readonly Season[]; // seasons this crop can be planted/grow
};

export const CROPS: Record<CropId, CropDef> = {
  parsnip: {
    id: "parsnip",
    name: "Parsnip",
    growthDays: 4,
    seedPrice: 20,
    sellPrice: 35,
    yield: [1, 1],
    seasons: ["spring"],
  },
  potato: {
    id: "potato",
    name: "Potato",
    growthDays: 5,
    seedPrice: 30,
    sellPrice: 50,
    yield: [1, 2],
    seasons: ["spring"],
  },
  carrot: {
    id: "carrot",
    name: "Carrot",
    growthDays: 3,
    seedPrice: 18,
    sellPrice: 30,
    yield: [1, 1],
    seasons: ["spring", "fall"],
  },
  cauliflower: {
    id: "cauliflower",
    name: "Cauliflower",
    growthDays: 6,
    seedPrice: 50,
    sellPrice: 110,
    yield: [1, 1],
    seasons: ["spring"],
  },
  kale: {
    id: "kale",
    name: "Kale",
    growthDays: 5,
    seedPrice: 40,
    sellPrice: 80,
    yield: [1, 1],
    seasons: ["spring", "summer"],
  },
  cabbage: {
    id: "cabbage",
    name: "Cabbage",
    growthDays: 5,
    seedPrice: 40,
    sellPrice: 85,
    yield: [1, 1],
    seasons: ["summer"],
  },
  beetroot: {
    id: "beetroot",
    name: "Beetroot",
    growthDays: 4,
    seedPrice: 25,
    sellPrice: 45,
    yield: [1, 1],
    seasons: ["fall"],
  },
  radish: {
    id: "radish",
    name: "Radish",
    growthDays: 4,
    seedPrice: 24,
    sellPrice: 45,
    yield: [1, 1],
    seasons: ["summer"],
  },
  pumpkin: {
    id: "pumpkin",
    name: "Pumpkin",
    growthDays: 7,
    seedPrice: 60,
    sellPrice: 160,
    yield: [1, 1],
    seasons: ["fall"],
  },
  wheat: {
    id: "wheat",
    name: "Wheat",
    growthDays: 3,
    seedPrice: 12,
    sellPrice: 18,
    yield: [1, 3],
    seasons: ["summer", "fall"],
  },
  sunflower: {
    id: "sunflower",
    name: "Sunflower",
    growthDays: 5,
    seedPrice: 35,
    sellPrice: 70,
    yield: [1, 1],
    seasons: ["summer", "fall"],
  },
};

export const CROP_ORDER: CropId[] = [
  "parsnip",
  "carrot",
  "potato",
  "beetroot",
  "radish",
  "cabbage",
  "kale",
  "sunflower",
  "cauliflower",
  "pumpkin",
  "wheat",
];

// Maps daysGrown (watered) -> art stage index 0..5.
export function cropStage(def: CropDef, daysGrown: number): number {
  const t = Math.min(1, daysGrown / def.growthDays);
  return Math.min(5, Math.floor(t * 5 + 0.0001));
}

export function isMature(def: CropDef, daysGrown: number): boolean {
  return daysGrown >= def.growthDays;
}
