// Crop definitions. Each crop has 6 art stages (00..05). `growthDays` is the
// number of *watered* days from planting to fully grown (stage 5). Stages are
// distributed across that span. Seeds bought in shop; produce sold there/bin.

import type { Season } from "./calendar";

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

export interface CropDef {
  id: CropId;
  name: string;
  // watered days to reach final stage
  growthDays: number;
  seedPrice: number;
  // per produce
  sellPrice: number;
  // min,max produce on harvest
  yield: [number, number];
  // seasons this crop can be planted/grow
  seasons: readonly Season[];
}

export type CropTable = { [K in CropId]: CropDef };

export const CROPS: CropTable = {
  beetroot: {
    growthDays: 4,
    id: "beetroot",
    name: "Beetroot",
    seasons: ["fall"],
    seedPrice: 25,
    sellPrice: 45,
    yield: [1, 1],
  },
  cabbage: {
    growthDays: 5,
    id: "cabbage",
    name: "Cabbage",
    seasons: ["summer"],
    seedPrice: 40,
    sellPrice: 85,
    yield: [1, 1],
  },
  carrot: {
    growthDays: 3,
    id: "carrot",
    name: "Carrot",
    seasons: ["spring", "fall"],
    seedPrice: 18,
    sellPrice: 30,
    yield: [1, 1],
  },
  cauliflower: {
    growthDays: 6,
    id: "cauliflower",
    name: "Cauliflower",
    seasons: ["spring"],
    seedPrice: 50,
    sellPrice: 110,
    yield: [1, 1],
  },
  kale: {
    growthDays: 5,
    id: "kale",
    name: "Kale",
    seasons: ["spring", "summer"],
    seedPrice: 40,
    sellPrice: 80,
    yield: [1, 1],
  },
  parsnip: {
    growthDays: 4,
    id: "parsnip",
    name: "Parsnip",
    seasons: ["spring"],
    seedPrice: 20,
    sellPrice: 35,
    yield: [1, 1],
  },
  potato: {
    growthDays: 5,
    id: "potato",
    name: "Potato",
    seasons: ["spring"],
    seedPrice: 30,
    sellPrice: 50,
    yield: [1, 2],
  },
  pumpkin: {
    growthDays: 7,
    id: "pumpkin",
    name: "Pumpkin",
    seasons: ["fall"],
    seedPrice: 60,
    sellPrice: 160,
    yield: [1, 1],
  },
  radish: {
    growthDays: 4,
    id: "radish",
    name: "Radish",
    seasons: ["summer"],
    seedPrice: 24,
    sellPrice: 45,
    yield: [1, 1],
  },
  sunflower: {
    growthDays: 5,
    id: "sunflower",
    name: "Sunflower",
    seasons: ["summer", "fall"],
    seedPrice: 35,
    sellPrice: 70,
    yield: [1, 1],
  },
  wheat: {
    growthDays: 3,
    id: "wheat",
    name: "Wheat",
    seasons: ["summer", "fall"],
    seedPrice: 12,
    sellPrice: 18,
    yield: [1, 3],
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
export const cropStage = (def: CropDef, daysGrown: number): number => {
  const t = Math.min(1, daysGrown / def.growthDays);
  return Math.min(5, Math.floor(t * 5 + 0.0001));
};

export const isMature = (def: CropDef, daysGrown: number): boolean => daysGrown >= def.growthDays;
