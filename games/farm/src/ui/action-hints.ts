import { CROPS, isMature } from "../data/crops";
import type { Item, ToolId } from "../data/items";
import type { Season } from "../data/calendar";
import { GROUND, tileIdx } from "../world/world";
import type { World, WorldObject } from "../world/world";

/** What the farmer is looking at, read from the scene at the moment of the ask. */
export interface HintContext {
  world: World;
  tx: number;
  ty: number;
  item: Item | null;
  energy: number;
  canCharge: number;
  season: Season;
  hasPickaxe: boolean;
  amHost: boolean;
}

const REST = "Out of energy — rest at home";

const holdsTool = (item: Item | null, tool: ToolId): boolean =>
  item?.kind === "tool" && item.tool === tool;

const objectHint = (c: HintContext, object: WorldObject): string | null => {
  switch (object.type) {
    case "house": {
      return c.amHost
        ? "Sleep to restore energy and begin a new day"
        : "The host starts the next day";
    }
    case "shop": {
      return "Buy seeds and supplies";
    }
    case "bin": {
      return "Ship produce for gold";
    }
    case "cave": {
      return c.hasPickaxe ? "Enter the mine" : "Bring a pickaxe to enter the mine";
    }
    case "barn":
    case "coop": {
      return "Visit the animal shop";
    }
    case "forage": {
      return "Collect wild produce";
    }
    case "tree": {
      if (!holdsTool(c.item, "axe")) {
        return "Equip an axe to chop";
      }
      return c.energy > 0 ? "Chop wood" : REST;
    }
    case "rock": {
      if (!holdsTool(c.item, "pickaxe")) {
        return "Equip a pickaxe to mine";
      }
      return c.energy > 0 ? "Break stone" : REST;
    }
    default: {
      return null;
    }
  }
};

const seedHint = (c: HintContext, item: Extract<Item, { kind: "seed" }>, idx: number): string => {
  if (!c.world.tilled[idx]) {
    return "Till the soil before planting";
  }
  if (c.world.crops.has(idx)) {
    return "A crop is already growing here";
  }
  const crop = CROPS[item.crop];
  return crop.seasons.includes(c.season)
    ? `Plant ${crop.name}`
    : `${crop.name} needs another season`;
};

const hoeHint = (c: HintContext): string => {
  if (c.energy <= 0) {
    return REST;
  }
  return c.world.canTill(c.tx, c.ty) ? "Till soil for seeds" : "Find bare soil to till";
};

const canHint = (c: HintContext): string => {
  if (c.energy <= 0) {
    return REST;
  }
  if (c.world.getGround(c.tx, c.ty) === GROUND.water) {
    return "Refill your watering can";
  }
  if (c.canCharge <= 0) {
    return "Empty can — refill at the pond";
  }
  return c.world.tilled[tileIdx(c.tx, c.ty)]
    ? "Water the soil for overnight growth"
    : "Till the soil before watering";
};

const rodHint = (c: HintContext): string =>
  c.world.getGround(c.tx, c.ty) === GROUND.water ? "Cast into the water" : "Face the pond to fish";

const TOOL_HINTS = {
  axe: () => "Face a tree to chop wood",
  can: canHint,
  hoe: hoeHint,
  pickaxe: () => "Face a rock to gather stone",
  rod: rodHint,
  sword: () => "Bring your sword into the mine",
} satisfies { [K in ToolId]: (c: HintContext) => string };

/** Read-only teaching beside the selected tool; action resolution stays in GameScene.tryAction. */
export const hintFor = (c: HintContext): string | null => {
  const { world, tx, ty, item } = c;
  const object = world.objectAt(tx, ty);
  if (object) {
    return objectHint(c, object);
  }
  const idx = tileIdx(tx, ty);
  const crop = world.crops.get(idx);
  if (crop && isMature(CROPS[crop.crop], crop.daysGrown)) {
    return "Harvest the ripe crop";
  }
  if (!item) {
    return "Select a tool or seeds from your hotbar";
  }
  if (item.kind === "seed") {
    return seedHint(c, item, idx);
  }
  if (item.kind !== "tool") {
    return "Gift to a villager or ship produce at the bin";
  }
  return TOOL_HINTS[item.tool](c);
};
