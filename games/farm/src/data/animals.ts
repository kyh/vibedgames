import type { AnimalProductId } from "./items";

export type AnimalKind = "chicken" | "duck" | "cow" | "sheep" | "pig";
export type BuildingKind = "barn" | "coop";

export interface AnimalDef {
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
}

export type AnimalTable = { [K in AnimalKind]: AnimalDef };

export const ANIMALS: AnimalTable = {
  chicken: {
    anim: "chicken-walk",
    building: "coop",
    kind: "chicken",
    name: "Chicken",
    originY: 0.83,
    price: 120,
    product: "egg",
    shadowScale: 1.1,
    texture: "obj-chicken",
  },
  cow: {
    anim: "cow-idle",
    building: "barn",
    kind: "cow",
    name: "Cow",
    originY: 0.92,
    price: 400,
    product: "milk",
    shadowScale: 1.6,
    texture: "obj-cow",
  },
  duck: {
    anim: "duck-walk",
    building: "coop",
    kind: "duck",
    name: "Duck",
    originY: 1,
    price: 180,
    product: "egg",
    shadowScale: 0.9,
    texture: "obj-duck",
  },
  pig: {
    anim: "pig-idle",
    building: "barn",
    kind: "pig",
    name: "Pig",
    originY: 0.86,
    price: 480,
    product: "truffle",
    shadowScale: 1.3,
    texture: "obj-pig",
  },
  sheep: {
    anim: "sheep-idle",
    building: "barn",
    kind: "sheep",
    name: "Sheep",
    originY: 0.86,
    price: 360,
    product: "wool",
    shadowScale: 1.3,
    texture: "obj-sheep",
  },
};

export const isAnimalKind = (k: string): k is AnimalKind => k in ANIMALS;

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
export const randomAnimalName = (seq: number): string => NAMES[seq % NAMES.length] ?? `Pet ${seq}`;
