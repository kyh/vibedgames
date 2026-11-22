import { BASES } from "../data/map";
import { ITEM_BY_ID, MAX_ITEMS } from "../data/items";
import { breakChannel } from "./abilities";
import { applyItemPurchase } from "./herokit";
import { dist } from "./math";
import { findPath } from "./nav";
import { disabled } from "./stats";
import type { Order, Unit, World } from "./types";

export const issueOrder = (w: World, u: Unit, order: Order) => {
  if (!u.alive) {
    return;
  }

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
export const buyItem = (w: World, u: Unit, itemId: string) => {
  const h = u.hero;

  if (!h || !u.alive) {
    return false;
  }

  if (h.items.length >= MAX_ITEMS) {
    return false;
  }

  if (h.items.includes(itemId)) {
    return false;
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
