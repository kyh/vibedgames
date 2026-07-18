import type Phaser from "phaser";

import { reseed } from "./rng";

// Bot-playtest diagnostics contract (see the playwright skill's
// references/bot-playtest.md): __GAME_DIAGNOSTICS__ is read-only per-frame
// telemetry, __GAME_TEST_HOOKS__ are the mutations a test may perform.
// Always exposed, like the existing __game / __lf probes — JSON-serializable
// primitives only, one object mutated in place (no per-frame allocation).

export type Diagnostics = {
  frame: number;
  score: number;
  complete: boolean;
  player: { x: number; y: number; speed: number };
  entities: number;
};

export const diag: Diagnostics = {
  frame: 0,
  score: 0,
  complete: false,
  player: { x: 0, y: 0, speed: 0 },
  entities: 0,
};

export function installTestHooks(game: Phaser.Game): void {
  Reflect.set(globalThis, "__GAME_DIAGNOSTICS__", diag);
  Reflect.set(globalThis, "__GAME_TEST_HOOKS__", {
    // Contract: seed() reseeds the gameplay RNG AND restarts the run, so
    // everything a bot measures is deterministic from this seed (frames
    // rendered before the call were unseeded).
    seed(n: number): void {
      reseed(n);
      restartSolo(game);
    },
    // 'active-play' = a fresh solo run, skipping the select screen.
    setState(name: string): void {
      if (name === "active-play") restartSolo(game);
    },
    setPausedForScreenshot(paused: boolean): void {
      if (paused) game.loop.sleep();
      else game.loop.wake();
    },
  });
}

function restartSolo(game: Phaser.Game): void {
  for (const key of ["select", "game", "viewer"]) {
    if (game.scene.isActive(key)) game.scene.stop(key);
  }
  diag.frame = 0;
  diag.score = 0;
  diag.complete = false;
  diag.player.x = 0;
  diag.player.y = 0;
  diag.player.speed = 0;
  diag.entities = 0;
  game.scene.start("game", { hero: "axion" });
}
