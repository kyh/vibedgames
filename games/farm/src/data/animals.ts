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
  scale: number;
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
    scale: 1,
  },
  duck: {
    kind: "duck",
    name: "Duck",
    building: "coop",
    price: 180,
    product: "egg",
    texture: "obj-duck",
    anim: "duck-walk",
    scale: 1,
  },
  cow: {
    kind: "cow",
    name: "Cow",
    building: "barn",
    price: 400,
    product: "milk",
    texture: "obj-cow",
    anim: "cow-idle",
    scale: 1,
  },
  sheep: {
    kind: "sheep",
    name: "Sheep",
    building: "barn",
    price: 360,
    product: "wool",
    texture: "obj-sheep",
    anim: "sheep-idle",
    scale: 1,
  },
  pig: {
    kind: "pig",
    name: "Pig",
    building: "barn",
    price: 480,
    product: "truffle",
    texture: "obj-pig",
    anim: "pig-idle",
    scale: 1,
  },
};

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
