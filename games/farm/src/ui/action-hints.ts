import { CROPS, isMature } from "../data/crops";
import type { Item } from "../data/items";
import type { Season } from "../data/calendar";
import { GROUND, type World } from "../world/world";

/** What the farmer is looking at, read from the scene at the moment of the ask. */
export type HintContext = {
  world: World;
  tx: number;
  ty: number;
  item: Item | null;
  energy: number;
  canCharge: number;
  season: Season;
  hasPickaxe: boolean;
  amHost: boolean;
};

const REST = "Out of energy — rest at home";

/** Read-only teaching beside the selected tool; action resolution stays in GameScene.tryAction. */
export function hintFor(c: HintContext): string | null {
  const { world, tx, ty, item } = c;
  const object = world.objectAt(tx, ty);
  if (object) {
    switch (object.type) {
      case "house":
        return c.amHost
          ? "Sleep to restore energy and begin a new day"
          : "The host starts the next day";
      case "shop":
        return "Buy seeds and supplies";
      case "bin":
        return "Ship produce for gold";
      case "cave":
        return c.hasPickaxe ? "Enter the mine" : "Bring a pickaxe to enter the mine";
      case "barn":
      case "coop":
        return "Visit the animal shop";
      case "forage":
        return "Collect wild produce";
      case "tree":
        if (item?.kind !== "tool" || item.tool !== "axe") return "Equip an axe to chop";
        return c.energy > 0 ? "Chop wood" : REST;
      case "rock":
        if (item?.kind !== "tool" || item.tool !== "pickaxe") return "Equip a pickaxe to mine";
        return c.energy > 0 ? "Break stone" : REST;
      case "ore":
        return null;
    }
  }
  const idx = world.idx(tx, ty);
  const crop = world.crops.get(idx);
  if (crop && isMature(CROPS[crop.crop], crop.daysGrown)) return "Harvest the ripe crop";
  if (!item) return "Select a tool or seeds from your hotbar";
  if (item.kind === "seed") {
    if (!world.tilled[idx]) return "Till the soil before planting";
    if (crop) return "A crop is already growing here";
    return CROPS[item.crop].seasons.includes(c.season)
      ? `Plant ${CROPS[item.crop].name}`
      : `${CROPS[item.crop].name} needs another season`;
  }
  if (item.kind !== "tool") return "Gift to a villager or ship produce at the bin";
  switch (item.tool) {
    case "hoe":
      return c.energy <= 0
        ? REST
        : world.canTill(tx, ty)
          ? "Till soil for seeds"
          : "Find bare soil to till";
    case "can":
      if (c.energy <= 0) return REST;
      if (world.getGround(tx, ty) === GROUND.water) return "Refill your watering can";
      if (c.canCharge <= 0) return "Empty can — refill at the pond";
      return world.tilled[idx]
        ? "Water the soil for overnight growth"
        : "Till the soil before watering";
    case "rod":
      return world.getGround(tx, ty) === GROUND.water
        ? "Cast into the water"
        : "Face the pond to fish";
    case "axe":
      return "Face a tree to chop wood";
    case "pickaxe":
      return "Face a rock to gather stone";
    case "sword":
      return "Bring your sword into the mine";
  }
}
