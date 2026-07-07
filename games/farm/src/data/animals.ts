import type { AnimalProductId } from "./items";

export type AnimalKind = "chicken" | "duck" | "cow" | "sheep" | "pig";
export type BuildingKind = "barn" | "coop";

export type AnimalDef = {
  kind: AnimalKind;
  name: string;
  building: BuildingKind;
  price: number;
  product: AnimalProductId;
  texture: string;
  anim: string;
  // sprite origin Y so the art's feet sit exactly on the anchor (the frames
  // have empty space below the body), and the ground-shadow width to match
  originY: number;
  shadowScale: number;
};

export const ANIMALS: Record<AnimalKind, AnimalDef> = {
  chicken: {
    kind: "chicken",
    name: "Chicken",
    building: "coop",
    price: 120,
    product: "egg",
    texture: "obj-chicken",
    anim: "chicken-walk",
    originY: 0.83,
    shadowScale: 1.1,
  },
  duck: {
    kind: "duck",
    name: "Duck",
    building: "coop",
    price: 180,
    product: "egg",
    texture: "obj-duck",
    anim: "duck-walk",
    originY: 1,
    shadowScale: 0.9,
  },
  cow: {
    kind: "cow",
    name: "Cow",
    building: "barn",
    price: 400,
    product: "milk",
    texture: "obj-cow",
    anim: "cow-idle",
    originY: 0.92,
    shadowScale: 1.6,
  },
  sheep: {
    kind: "sheep",
    name: "Sheep",
    building: "barn",
    price: 360,
    product: "wool",
    texture: "obj-sheep",
    anim: "sheep-idle",
    originY: 0.86,
    shadowScale: 1.3,
  },
  pig: {
    kind: "pig",
    name: "Pig",
    building: "barn",
    price: 480,
    product: "truffle",
    texture: "obj-pig",
    anim: "pig-idle",
    originY: 0.86,
    shadowScale: 1.3,
  },
};

export function isAnimalKind(k: string): k is AnimalKind {
  return k in ANIMALS;
}

export const COOP_ANIMALS: AnimalKind[] = ["chicken", "duck"];
export const BARN_ANIMALS: AnimalKind[] = ["cow", "sheep", "pig"];

const NAMES = [
  "Daisy",
  "Bella",
  "Coco",
  "Pip",
  "Maple",
  "Rusty",
  "Clover",
  "Mochi",
  "Olive",
  "Biscuit",
  "Hazel",
  "Pumpkin",
];
export function randomAnimalName(seq: number): string {
  return NAMES[seq % NAMES.length] ?? `Pet ${seq}`;
}
