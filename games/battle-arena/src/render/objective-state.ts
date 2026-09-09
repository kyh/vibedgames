import { MAX_ITEMS } from "../data/items";
import type { Coin, Delivery, Unit, World } from "../sim/types";

/** Keep a valid target until it leaves the authoritative snapshot. */
const nearest = <T extends { id: string; x: number; y: number }>(
  choices: readonly T[],
  me: Pick<Unit, "x" | "y"> | null,
  previousId: string | null,
): T | null => {
  const previous = choices.find((choice) => choice.id === previousId);
  if (previous) {
    return previous;
  }
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
};

export const liveBossCoins = (w: World): Coin[] =>
  w.coins.filter((coin) => !coin.loot && coin.expireAt > w.now);

export const coinObjective = (w: World, me: Unit | null, previousId: string | null = null) => {
  const target = nearest(liveBossCoins(w), me, previousId);
  if (target) {
    const flying = target.landAt > w.now;
    const remaining = Math.max(
      1,
      Math.ceil(((flying ? target.landAt : target.expireAt) - w.now) / 1000),
    );
    return {
      live: !flying,
      target,
      text: flying ? `◈ COIN LANDING ${remaining}s` : `◈ COIN ${remaining}s LEFT`,
    };
  }
  const text =
    w.boss.alive && w.nextCoinAt > w.gameTime
      ? `◈ COIN ${Math.ceil(w.nextCoinAt - w.gameTime)}s`
      : "";
  return { live: false, target: null, text };
};

export const deliveryObjective = (w: World, me: Unit | null, previousId: string | null = null) => {
  const choices: Delivery[] = w.deliveries.filter((drop) => drop.expireAt > w.now);
  const target = nearest(choices, me, previousId);
  if (target) {
    const reward = me && me.items.length >= MAX_ITEMS ? "GOLD" : "ITEM";
    return {
      live: true,
      target,
      text: `▣ ${reward} ${Math.max(1, Math.ceil((target.expireAt - w.now) / 1000))}s LEFT`,
    };
  }
  return {
    live: false,
    target: null,
    text:
      w.nextDeliveryAt > w.gameTime ? `▣ DROP ${Math.ceil(w.nextDeliveryAt - w.gameTime)}s` : "",
  };
};
