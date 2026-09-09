// Player/bot intents applied by the host: order queuing and shop purchases.
// Separate from world.ts so the bot AI can issue them without importing back
// into the module that drives it.

import { BASES } from "../data/map";
import { ITEM_BY_ID, MAX_ITEMS } from "../data/items";
import { breakChannel } from "./abilities";
import { applyItemPurchase } from "./herokit";
import { dist } from "./math";
import { findPath } from "./nav";
import { disabled } from "./stats";
import type { Order, Unit, World } from "./types";

export const issueOrder = (w: World, u: Unit, order: Order): void => {
  if (!u.alive) {
    return;
  }
  // While disabled (stunned) only a STOP may be queued — so releasing a movement
  // key mid-stun clears the stale moveDir instead of resuming it when the stun ends.
  if (disabled(u)) {
    if (order.type === "hold" || order.type === "idle") {
      u.order = order;
      u.path = [];
    }
    return;
  }
  if (u.hero?.channel) {
    breakChannel(w, u);
  }
  u.order = order;
  if (order.type === "move" || order.type === "attackMove") {
    u.path = findPath(u, order.to);
    u.pathIdx = 0;
    u.repathAt = w.now + 1500;
  } else {
    u.path = [];
  }
  u.pendingAttack = null;
};

/** Buy an item: requires the hero be in its base shop radius and have the gold. */
export const buyItem = (w: World, u: Unit, itemId: string): boolean => {
  const h = u.hero;
  if (!h || !u.alive) {
    return false;
  }
  if (h.items.length >= MAX_ITEMS) {
    return false;
  }
  if (h.items.includes(itemId)) {
    return false;
    // no duplicate items
  }
  const it = ITEM_BY_ID[itemId];
  if (!it) {
    return false;
  }
  const home = BASES[u.team];
  if (dist(u, home.fountain) > home.shopRadius) {
    return false;
  }
  if (h.gold < it.cost) {
    return false;
  }
  h.gold -= it.cost;
  h.items.push(itemId);
  applyItemPurchase(u);
  return true;
};
