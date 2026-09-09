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

export const TOOL_NAMES = {
  axe: "Axe",
  can: "Watering Can",
  hoe: "Hoe",
  pickaxe: "Pickaxe",
  rod: "Fishing Rod",
  sword: "Sword",
} satisfies Record<ToolId, string>;

const TOOL_ICON = {
  axe: "ui-axe",
  can: "ui-water",
  hoe: "ui-shovel",
  pickaxe: "ui-pickaxe",
  rod: "ui-rod",
  sword: "ui-sword",
} satisfies Record<ToolId, string>;

const RES_ICON = {
  coal: "obj-ore-coal",
  copper: "obj-ore-copper",
  crystal: "obj-ore-crystal",
  stone: "obj-stone",
  wood: "obj-wood",
} satisfies Record<ResourceId, string>;

const RES_NAME = {
  coal: "Coal",
  copper: "Copper",
  crystal: "Crystal",
  stone: "Stone",
  wood: "Wood",
} satisfies Record<ResourceId, string>;

const RES_VALUE = {
  coal: 16,
  copper: 28,
  crystal: 75,
  stone: 6,
  wood: 4,
} satisfies Record<ResourceId, number>;

const AP_ICON = {
  egg: "obj-egg",
  milk: "obj-milk",
  truffle: "icon-truffle",
  wool: "icon-wool",
} satisfies Record<AnimalProductId, string>;
const AP_NAME = {
  egg: "Egg",
  milk: "Milk",
  truffle: "Truffle",
  wool: "Wool",
} satisfies Record<AnimalProductId, string>;
const AP_VALUE = { egg: 22, milk: 55, truffle: 180, wool: 120 } satisfies Record<
  AnimalProductId,
  number
>;

const FORAGE_ICON = {
  mushroom_blue: "obj-mushroom-blue",
  mushroom_red: "obj-mushroom-red",
} satisfies Record<ForageId, string>;
const FORAGE_NAME = {
  mushroom_blue: "Blue Mushroom",
  mushroom_red: "Red Mushroom",
} satisfies Record<ForageId, string>;
const FORAGE_VALUE = { mushroom_blue: 70, mushroom_red: 45 } satisfies Record<ForageId, number>;

export interface ItemIcon {
  key: string;
  frame?: number;
}

export const itemIcon = (item: Item): ItemIcon => {
  switch (item.kind) {
    case "tool": {
      return { key: TOOL_ICON[item.tool] };
    }
    case "seed": {
      return { key: "obj-seeds" };
    }
    case "produce": {
      return { key: `crop-${item.crop}-icon` };
    }
    case "resource": {
      return { key: RES_ICON[item.res] };
    }
    case "fish": {
      return { key: "obj-fish" };
    }
    case "animal_product": {
      return { key: AP_ICON[item.product] };
    }
    case "forage": {
      return { frame: 0, key: FORAGE_ICON[item.forage] };
    }
    // no default
  }
};

export const itemName = (item: Item): string => {
  switch (item.kind) {
    case "tool": {
      return TOOL_NAMES[item.tool];
    }
    case "seed": {
      return `${CROPS[item.crop].name} Seeds`;
    }
    case "produce": {
      return CROPS[item.crop].name;
    }
    case "resource": {
      return RES_NAME[item.res];
    }
    case "fish": {
      return FISH[item.fish].name;
    }
    case "animal_product": {
      return AP_NAME[item.product];
    }
    case "forage": {
      return FORAGE_NAME[item.forage];
    }
    // no default
  }
};

export const itemStackable = (item: Item): boolean => item.kind !== "tool";

export const sameItem = (a: Item, b: Item): boolean => {
  switch (a.kind) {
    case "tool": {
      return b.kind === "tool" && a.tool === b.tool;
    }
    case "seed": {
      return b.kind === "seed" && a.crop === b.crop;
    }
    case "produce": {
      return b.kind === "produce" && a.crop === b.crop;
    }
    case "resource": {
      return b.kind === "resource" && a.res === b.res;
    }
    case "fish": {
      return b.kind === "fish" && a.fish === b.fish;
    }
    case "animal_product": {
      return b.kind === "animal_product" && a.product === b.product;
    }
    case "forage": {
      return b.kind === "forage" && a.forage === b.forage;
    }
    // no default
  }
};

export const sellValue = (item: Item): number => {
  switch (item.kind) {
    case "produce": {
      return CROPS[item.crop].sellPrice;
    }
    case "resource": {
      return RES_VALUE[item.res];
    }
    case "seed": {
      return Math.floor(CROPS[item.crop].seedPrice / 2);
    }
    case "fish": {
      return FISH[item.fish].value;
    }
    case "animal_product": {
      return AP_VALUE[item.product];
    }
    case "forage": {
      return FORAGE_VALUE[item.forage];
    }
    case "tool": {
      return 0;
    }
    // no default
  }
};

// Sellable = anything but tools.
export const isSellable = (item: Item): boolean => item.kind !== "tool";
