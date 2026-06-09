// Item model — a tagged union so illegal states can't be represented.

import type { CropId } from "./crops";
import { CROPS } from "./crops";
import type { FishId } from "./fish";
import { FISH } from "./fish";

export type ToolId = "hoe" | "can" | "axe" | "pickaxe" | "rod" | "sword";
export type OreId = "coal" | "copper" | "crystal";
export type ResourceId = "wood" | "stone" | OreId;
export type AnimalProductId = "egg" | "milk" | "wool" | "truffle";
export type ForageId = "mushroom_red" | "mushroom_blue";

export type Item =
  | { kind: "tool"; tool: ToolId }
  | { kind: "seed"; crop: CropId }
  | { kind: "produce"; crop: CropId }
  | { kind: "resource"; res: ResourceId }
  | { kind: "fish"; fish: FishId }
  | { kind: "animal_product"; product: AnimalProductId }
  | { kind: "forage"; forage: ForageId };

export type Slot = { item: Item; qty: number } | null;

export const TOOL_NAMES: Record<ToolId, string> = {
  hoe: "Hoe",
  can: "Watering Can",
  axe: "Axe",
  pickaxe: "Pickaxe",
  rod: "Fishing Rod",
  sword: "Sword",
};

const TOOL_ICON: Record<ToolId, string> = {
  hoe: "ui-shovel",
  can: "ui-water",
  axe: "ui-axe",
  pickaxe: "ui-pickaxe",
  rod: "ui-rod",
  sword: "ui-sword",
};

const RES_ICON: Record<ResourceId, string> = {
  wood: "obj-wood",
  stone: "obj-stone",
  coal: "obj-ore-coal",
  copper: "obj-ore-copper",
  crystal: "obj-ore-crystal",
};

const RES_NAME: Record<ResourceId, string> = {
  wood: "Wood",
  stone: "Stone",
  coal: "Coal",
  copper: "Copper",
  crystal: "Crystal",
};

const RES_VALUE: Record<ResourceId, number> = {
  wood: 4,
  stone: 6,
  coal: 16,
  copper: 28,
  crystal: 75,
};

const AP_ICON: Record<AnimalProductId, string> = {
  egg: "obj-egg",
  milk: "obj-milk",
  wool: "icon-wool",
  truffle: "icon-truffle",
};
const AP_NAME: Record<AnimalProductId, string> = {
  egg: "Egg",
  milk: "Milk",
  wool: "Wool",
  truffle: "Truffle",
};
const AP_VALUE: Record<AnimalProductId, number> = { egg: 22, milk: 55, wool: 120, truffle: 180 };

const FORAGE_ICON: Record<ForageId, string> = {
  mushroom_red: "obj-mushroom-red",
  mushroom_blue: "obj-mushroom-blue",
};
const FORAGE_NAME: Record<ForageId, string> = {
  mushroom_red: "Red Mushroom",
  mushroom_blue: "Blue Mushroom",
};
const FORAGE_VALUE: Record<ForageId, number> = { mushroom_red: 45, mushroom_blue: 70 };

export function itemIcon(item: Item): { key: string; frame?: number } {
  switch (item.kind) {
    case "tool":
      return { key: TOOL_ICON[item.tool] };
    case "seed":
      return { key: "obj-seeds" };
    case "produce":
      return { key: `crop-${item.crop}-icon` };
    case "resource":
      return { key: RES_ICON[item.res] };
    case "fish":
      return { key: "obj-fish" };
    case "animal_product":
      return { key: AP_ICON[item.product] };
    case "forage":
      return { key: FORAGE_ICON[item.forage], frame: 0 };
  }
}

export function itemName(item: Item): string {
  switch (item.kind) {
    case "tool":
      return TOOL_NAMES[item.tool];
    case "seed":
      return `${CROPS[item.crop].name} Seeds`;
    case "produce":
      return CROPS[item.crop].name;
    case "resource":
      return RES_NAME[item.res];
    case "fish":
      return FISH[item.fish].name;
    case "animal_product":
      return AP_NAME[item.product];
    case "forage":
      return FORAGE_NAME[item.forage];
  }
}

export function itemStackable(item: Item): boolean {
  return item.kind !== "tool";
}

export function sameItem(a: Item, b: Item): boolean {
  switch (a.kind) {
    case "tool":
      return b.kind === "tool" && a.tool === b.tool;
    case "seed":
      return b.kind === "seed" && a.crop === b.crop;
    case "produce":
      return b.kind === "produce" && a.crop === b.crop;
    case "resource":
      return b.kind === "resource" && a.res === b.res;
    case "fish":
      return b.kind === "fish" && a.fish === b.fish;
    case "animal_product":
      return b.kind === "animal_product" && a.product === b.product;
    case "forage":
      return b.kind === "forage" && a.forage === b.forage;
  }
}

export function sellValue(item: Item): number {
  switch (item.kind) {
    case "produce":
      return CROPS[item.crop].sellPrice;
    case "resource":
      return RES_VALUE[item.res];
    case "seed":
      return Math.floor(CROPS[item.crop].seedPrice / 2);
    case "fish":
      return FISH[item.fish].value;
    case "animal_product":
      return AP_VALUE[item.product];
    case "forage":
      return FORAGE_VALUE[item.forage];
    case "tool":
      return 0;
  }
}

// Sellable = anything but tools.
export function isSellable(item: Item): boolean {
  return item.kind !== "tool";
}
