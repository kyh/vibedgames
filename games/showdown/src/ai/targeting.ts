import type { Brawler } from "../entities/brawler";
import type { Game } from "../game";
import { dist } from "../utils";
import type { Bot } from "./bot";

/** Nobody is noticed beyond this distance. */
export const SIGHT_RANGE = 9;

/** Another bot is only worth fighting inside this range unless it hit us recently. */
export const BOT_NOTICE_RANGE = 4.5;

/** A brawler hiding in a bush is only spotted this close. */
export const BUSH_SIGHT_RANGE = 2.4;

export interface TargetPick {
  range: number;
  target: Brawler | null;
}

const countHunters = (game: Game, prey: Brawler, self: Bot) => {
  let count = 0;

  for (const brain of game.brains) {
    if (brain !== self && brain.b.alive && brain.target === prey) {
      count += 1;
    }
  }

  return count;
};

const playerOffLimits = (bot: Bot, player: Brawler, range: number) => {
  const { difficulty } = bot.game;

  if (range > difficulty.engage) {
    return true;
  }

  return countHunters(bot.game, player, bot) >= difficulty.hunters && range > 2.5;
};

const isWorthFighting = (bot: Bot, other: Brawler, range: number) => {
  const { b, game } = bot;
  const grudge = b.lastAttacker === other && game.elapsed - b.lastHitTime < 4;

  if (!other.isHuman && !grudge && range > BOT_NOTICE_RANGE) {
    return false;
  }

  if (other.isHuman && !grudge && bot.target !== other && playerOffLimits(bot, other, range)) {
    return false;
  }

  return true;
};

/** The nearest visible brawler worth fighting, and how far away it is. */
export const pickTarget = (bot: Bot) => {
  const { b, game } = bot;

  const calmStart =
    game.state !== "menu" && game.matchTime < 14 && game.elapsed - b.lastCombat > 2.5;

  let target: Brawler | null = null;
  let range = calmStart ? 3.5 : Number.POSITIVE_INFINITY;

  for (const other of game.brawlers) {
    if (other === b || !other.alive || other.airborne) {
      continue;
    }

    const d = dist(b.x, b.z, other.x, other.z);

    if (!isWorthFighting(bot, other, d)) {
      continue;
    }

    if (d < range && bot.canSee(other, d)) {
      target = other;
      range = d;
    }
  }

  return { range, target };
};
