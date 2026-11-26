import { Game } from "../src/game";

import { Game } from "../src/game";

import { Input } from "../src/input";

const DECIDE_EVERY = 15;

const round = (value: number) => Math.round(value * 1e6) / 1e6;

const chooseMove = (sense: {
  hpPct?: any;
  underFire?: any;
  enemiesNear?: any;
  nearestLoot?: any;
  bestTarget?: any;
  zone?: any;
}) => {
  const { bestTarget, zone } = sense;

  if (zone.outside || (zone.closing && zone.margin < 4)) {
    return "to_zone";
  }

  if (sense.hpPct < 0.35 && (sense.underFire || sense.enemiesNear >= 2)) {
    return "flee";
  }

  if (bestTarget && (bestTarget.canHit || bestTarget.weakerThanYou || bestTarget.dist < 8)) {
    return "fight";
  }

  return sense.nearestLoot ? "loot" : "fight";
};

const tapSuper = (sense: { superReady: any; bestTarget: { canHit: any } }) => {
  if (sense.superReady && sense.bestTarget?.canHit) {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
  }
};

const applyInputs = (input: Input, out: { keys: any; pointer?: any }) => {
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
  game.brawlers.map((b: { name: any; def: { id: any }; x: any; z: any; hp: any; cubes: any }) => [
    b.name,
    b.def.id,
    round(b.x),
    round(b.z),
    b.hp,
    b.cubes,
  ]);

const summarise = (game: Game, samples: any[], survived: number) => {
  const { player } = game;
  const alive = game.brawlers.filter((b: { alive: any }) => b.alive).length;

  return {
    cubes: player?.cubes ?? 0,
    downs: game.brawlers
      .filter((b: { alive: any }) => !b.alive)
      .toSorted((a: { rank: number }, b: { rank: number }) => b.rank - a.rank)
      .map((b: { name: any }) => b.name),
    ended: game.state === "ended",
    kills: player?.kills ?? 0,
    rank: player?.alive ? alive : (player?.rank ?? 0),
    roster: game.brawlers.map((b: { name: any; def: { id: any } }) => `${b.name}:${b.def.id}`),
    samples,
    survived: Math.round(survived * 10) / 10,
  };
};

const playMatch = ({ hz, moveName, sampleEvery, seed, ticks, tune, untilEnded }) => {
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
  const samples = [];
  let current = moveName === "rules" ? "fight" : moveName;
  let survived = 0;

  for (let tick = 0; tick < ticks; tick += 1) {
    if (moveName === "rules" && tick % DECIDE_EVERY === 0 && game.player?.alive) {
      const sense = window.__GAME_DIAGNOSTICS__;
      current = chooseMove(sense);
      tapSuper(sense);
    }

    applyInputs(input, moves[current].reflex());
    game.update(1 / hz);
    game.camera.updateMatrixWorld();

    if (game.player?.alive) {
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
