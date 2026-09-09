// A hero's own base: its spawn pad, shop, and fountain. Separate from world.ts
// so the bot AI can shop without importing the tick loop back.
import { SHOP_RADIUS } from "../data/config";
import { ITEM_BY_ID, MAX_ITEMS } from "../data/items";
import { SPAWNS } from "../data/map";
import type { SpawnPoint } from "../data/map";
import { recomputeStats } from "./stats";
import type { Unit, World } from "./types";

/** The base pad for a slot (slots wrap around the pads). */
export const homeSpawn = (slot: number): SpawnPoint => {
  const sp = SPAWNS[slot % SPAWNS.length];
  if (!sp) {
    throw new Error("no spawn points");
  }
  return sp;
};

/** Is this unit standing in its own base (shop usable / fountain heals)? */
export const inOwnBase = (u: Unit): boolean => {
  const sp = homeSpawn(u.slot);
  return (u.x - sp.x) ** 2 + (u.y - sp.y) ** 2 <= SHOP_RADIUS * SHOP_RADIUS;
};

/** Host-side purchase. Returns true on success. */
export const buyItem = (w: World, u: Unit, itemId: string): boolean => {
  const it = ITEM_BY_ID[itemId];
  if (!it || !u.alive) {
    return false;
  }
  if (!inOwnBase(u)) {
    return false;
  }
  if (u.items.length >= MAX_ITEMS) {
    return false;
  }
  if (u.gold < it.cost) {
    return false;
  }
  u.gold -= it.cost;
  u.items.push(itemId);
  recomputeStats(u);
  return true;
};
