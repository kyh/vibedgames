// The page half of tools/seed-smoke.mjs, injected as a script tag: steps the
// sim by hand at a fixed rate inside one task, so no animation frame (and no
// wall clock) gets between two steps, with a playtest reflex as the player.

/** Four decisions a second, at the 60 Hz the harness steps at. */
const DECIDE_EVERY = 15;

const round = (value) => Math.round(value * 1e6) / 1e6;

/**
 * "rules" is the manifest goal's own priority list read off the diagnostics:
 * what the decision model is told to do, without the model.
 */
const chooseMove = (sense) => {
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

const tapSuper = (sense) => {
  if (sense.superReady && sense.bestTarget?.canHit) {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
  }
};

const applyInputs = (input, out) => {
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

const sample = (game) =>
  game.brawlers.map((b) => [b.name, b.def.id, round(b.x), round(b.z), b.hp, b.cubes]);

const summarise = (game, samples, survived) => {
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
    rank: player?.alive ? alive : (player?.rank ?? 0),
    roster: game.brawlers.map((b) => `${b.name}:${b.def.id}`),
    samples,
    survived: Math.round(survived * 10) / 10,
  };
};

/** Plays one seeded solo match for up to `ticks` fixed steps. */
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
  // The cursor is an input too: park it, or the last run decides where this one first aims.
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
    // Rendering is what normally refreshes the camera matrices that mouse aim unprojects through.
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
