import { MAX_ITEMS } from "../data/items";
import type { Coin, Delivery, Unit, World } from "../sim/types";

/** Keep a valid target until it leaves the authoritative snapshot. */
function nearest<T extends { id: string; x: number; y: number }>(
  choices: readonly T[],
  me: Pick<Unit, "x" | "y"> | null,
  previousId: string | null,
): T | null {
  const previous = choices.find((choice) => choice.id === previousId);
  if (previous) return previous;
  let selected: T | null = null;
  let distance = Infinity;
  for (const choice of choices) {
    const next = me ? (choice.x - me.x) ** 2 + (choice.y - me.y) ** 2 : 0;
    if (next < distance || (next === distance && selected && choice.id < selected.id)) {
      selected = choice;
      distance = next;
    }
  }
  return selected;
}

export function liveBossCoins(w: World): Coin[] {
  return w.coins.filter((coin) => !coin.loot && coin.expireAt > w.now);
}

export function coinObjective(w: World, me: Unit | null, previousId: string | null = null) {
  const target = nearest(liveBossCoins(w), me, previousId);
  if (target) {
    const flying = target.landAt > w.now;
    const remaining = Math.max(
      1,
      Math.ceil(((flying ? target.landAt : target.expireAt) - w.now) / 1000),
    );
    return {
      target,
      live: !flying,
      text: flying ? `◈ COIN LANDING ${remaining}s` : `◈ COIN ${remaining}s LEFT`,
    };
  }
  const text =
    w.boss.alive && w.nextCoinAt > w.gameTime
      ? `◈ COIN ${Math.ceil(w.nextCoinAt - w.gameTime)}s`
      : "";
  return { target: null, live: false, text };
}

export function deliveryObjective(w: World, me: Unit | null, previousId: string | null = null) {
  const choices: Delivery[] = w.deliveries.filter((drop) => drop.expireAt > w.now);
  const target = nearest(choices, me, previousId);
  if (target) {
    const reward = me && me.items.length >= MAX_ITEMS ? "GOLD" : "ITEM";
    return {
      target,
      live: true,
      text: `▣ ${reward} ${Math.max(1, Math.ceil((target.expireAt - w.now) / 1000))}s LEFT`,
    };
  }
  return {
    target: null,
    live: false,
    text:
      w.nextDeliveryAt > w.gameTime ? `▣ DROP ${Math.ceil(w.nextDeliveryAt - w.gameTime)}s` : "",
  };
}
