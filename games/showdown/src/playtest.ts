// The playtest contract beyond diagnostics: the hooks that stage a solo brawl
// and the manifest `vg playtest run`'s decision model chooses from. See
// plugins/tooling/skills/playtest/references/autonomous-playtest.md.

import { publishPlaytest, publishTestHooks } from "@vibedgames/playtest";

import type { Game } from "./game";
import { Pilot } from "./playtest-pilot";

const GOAL = [
  "Top-down battle royale: you against 7 bots, last brawler standing wins. game.score = kills x100 + power cubes x10, so BOTH kills and cubes are progress. You lose when game.player.alive turns false. The reflexes walk, aim and shoot for you — you only choose the plan.",
  "Fields (all relative to you, +dx is right, +dz is down-screen): game.hpPct is your health 0-1; game.ammo is shots loaded (0-3, reloads by itself); game.bestTarget is the one opponent worth fighting, or null when nobody is on screen — canHit means a shot fired now would reach, weakerThanYou compares health; game.enemiesNear counts opponents within 9 units; game.underFire means you were hit in the last 1.5 s; game.nearestLoot is a power cube to walk over or a box to shoot open (boxes drop cubes; each cube is +10% damage and extra health); game.zone.margin is the safe ground left before the poison gas (negative = you are IN the gas and taking heavy damage every second), zone.closing means it is shrinking towards the centre.",
  "Rules, in priority order: (1) zone.outside true, or zone.closing with zone.margin under 4 -> to_zone, the gas kills faster than any bot. (2) hpPct under 0.35 while underFire or enemiesNear >= 2 -> flee; health regenerates a few seconds after the last hit. (3) bestTarget exists and (canHit, or weakerThanYou, or dist under 8) and hpPct is 0.35 or more -> fight. (4) otherwise, nearestLoot exists -> loot. (5) nothing in sight -> fight, which hunts the nearest opponent. Decide early: what you see is a quarter second old.",
].join(" ");

/**
 * Publish the test hooks and the autonomous-playtest manifest. Every staged state
 * is a solo brawl against bots — a room is shared, so nothing here may write
 * into one.
 */
export const installPlaytest = (game: Game): void => {
  const pilot = new Pilot(game);
  publishTestHooks({
    seed: (seed) => game.startSeeded(seed),
    setPausedForScreenshot: (paused) => game.setPaused(paused, false),
    setState: (name) => {
      if (name !== "active-play") {
        return;
      }
      const live = game.state === "countdown" || game.state === "playing";
      if (game.mode !== "solo" || !live) {
        game.startSeeded(game.nextSeed);
      }
      game.skipCountdown();
      return { state: name };
    },
  });
  publishPlaytest({
    actions: {
      super: {
        description:
          "release the charged super at game.bestTarget — yes ONLY when game.superReady is true and game.bestTarget.canHit is true; otherwise no",
        keys: ["Space"],
      },
    },
    goal: GOAL,
    // Brawlers run ~3 units a second, so one decision's hold is about half a unit.
    minDisplacement: 0.15,
    move: {
      fight: {
        description:
          "Attack game.bestTarget: close to weapon range, circle-strafe, lead the aim and fire. With nobody in view, hunt the nearest opponent",
        reflex: pilot.fight,
      },
      flee: {
        description:
          "Run away from game.bestTarget to break off a losing fight and let health regenerate, shooting back while it stays in reach",
        reflex: pilot.flee,
      },
      loot: {
        description:
          "Go to game.nearestLoot: walk over a power cube, or shoot a loot box open. Still returns fire at anyone in reach",
        reflex: pilot.loot,
      },
      to_zone: {
        description:
          "Run for the middle of the safe zone, out of the poison gas — when game.zone.outside is true or game.zone.margin is small",
        reflex: pilot.toZone,
      },
    },
  });
};
