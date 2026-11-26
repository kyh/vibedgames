import type { ReflexInputs } from "@vibedgames/playtest";

import type { Diagnostics } from "../src/diagnostics.ts";
import type { Game } from "../src/game.ts";
import type { Input } from "../src/input.ts";

declare global {
  interface Window {
    __seedPilot?: { playMatch: typeof playMatch };
  }
}

export interface MatchOptions {
  hz: number;
  moveName: string;
  sampleEvery: number;
  seed: number;
  ticks: number;
  tune: Partial<Game["difficulty"]>;
  untilEnded: boolean;
}

const DECIDE_EVERY = 15;

const round = (value: number) => Math.round(value * 1e6) / 1e6;

const chooseMove = (sense: Diagnostics) => {
  const { bestTarget, zone } = sense;

  if (zone !== undefined && (zone.outside || (zone.closing && zone.margin < 4))) {
    return "to_zone";
  }

  if ((sense.hpPct ?? 1) < 0.35 && (sense.underFire === true || (sense.enemiesNear ?? 0) >= 2)) {
    return "flee";
  }

  if (bestTarget && (bestTarget.canHit || bestTarget.weakerThanYou || bestTarget.dist < 8)) {
    return "fight";
  }

  return sense.nearestLoot ? "loot" : "fight";
};

const tapSuper = (sense: Diagnostics) => {
  if (sense.superReady === true && sense.bestTarget?.canHit === true) {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
  }
};

const applyInputs = (input: Input, out: ReflexInputs) => {
  input.keys.clear();

  for (const key of out.keys ?? []) {
    input.keys.add(key);
  }

  input.fire = out.pointer?.down ?? false;

  if (out.pointer) {
    input.ndcX = out.pointer.x * 2 - 1;
    input.ndcY = 1 - out.pointer.y * 2;
  }
};

const sample = (game: Game) =>
  game.brawlers.map((b) => [b.name, b.def.id, round(b.x), round(b.z), b.hp, b.cubes] as const);

const summarise = (game: Game, samples: ReturnType<typeof sample>[], survived: number) => {
  const { player } = game;
  const alive = game.brawlers.filter((b) => b.alive).length;

  return {
    cubes: player?.cubes ?? 0,
    downs: game.brawlers
      .filter((b) => !b.alive)
      .toSorted((a, b) => b.rank - a.rank)
      .map((b) => b.name),
    ended: game.state === "ended",
    kills: player?.kills ?? 0,
    rank: player?.alive === true ? alive : (player?.rank ?? 0),
    roster: game.brawlers.map((b) => `${b.name}:${b.def.id}`),
    samples,
    survived: Math.round(survived * 10) / 10,
  };
};

const decideByRules = (current: string) => {
  const sense = window.__GAME_DIAGNOSTICS__;

  if (!sense) {
    return current;
  }

  const next = chooseMove(sense);
  tapSuper(sense);

  return next;
};

const playMatch = ({ hz, moveName, sampleEvery, seed, ticks, tune, untilEnded }: MatchOptions) => {
  const game = window.__game;
  const moves = window.__GAME_PLAYTEST__?.move;

  if (!game || !moves || (moveName !== "rules" && !moves[moveName])) {
    throw new Error("the dev build did not publish __game and the playtest manifest");
  }

  const { input } = game;
  Object.assign(game, { difficulty: { ...game.difficulty, ...tune } });
  game.startSeeded(seed);
  game.skipCountdown();
  input.ndcX = 0;
  input.ndcY = 0;
  const samples: ReturnType<typeof sample>[] = [];
  let current = moveName === "rules" ? "fight" : moveName;
  let survived = 0;

  for (let tick = 0; tick < ticks; tick += 1) {
    if (moveName === "rules" && tick % DECIDE_EVERY === 0 && game.player?.alive === true) {
      current = decideByRules(current);
    }

    applyInputs(input, moves[current]?.reflex?.(null) ?? {});
    game.update(1 / hz);
    game.camera.updateMatrixWorld();

    if (game.player?.alive === true) {
      survived = game.matchTime;
    }

    if ((tick + 1) % sampleEvery === 0) {
      samples.push(sample(game));
    }

    if (untilEnded && game.state === "ended") {
      break;
    }
  }

  applyInputs(input, { keys: [] });

  return summarise(game, samples, survived);
};

window.__seedPilot = { playMatch };
