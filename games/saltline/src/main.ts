import "./style.css";

import {
  notifyGameStarted,
  probeWebGL,
  resumeGame,
  setPauseHandlers,
  showWebGLVeil,
} from "@repo/embed";
import { isPlaytestRequested } from "@vibedgames/playtest";

import { bootSaltline } from "./core/saltline-core.js";
import type { GameState, SaltlineGame } from "./core/types";
import { Coop } from "./net/coop";
import { openRoom } from "./net/session";
import { installPlaytest } from "./playtest";

const webgl = probeWebGL();
if (!webgl.ok) {
  showWebGLVeil(webgl);
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
}

declare global {
  interface Window {
    /** Dev-only handle for tools/two-client.mjs. */
    __saltline?: { coop: Coop };
  }
}

const params = new URLSearchParams(location.search);
const coop = new Coop();
if (import.meta.env.DEV) {
  window.__saltline = { coop };
}
let game: SaltlineGame | null = null;
let prevState: GameState = "title";

// The wrapper's pause opens the game's own pause menu; the game owns Escape
// (and its own touch pause button), and its Resume hands back to the wrapper.
// The world keeps running behind a pause whenever a squad shares it.
setPauseHandlers({
  escapePauses: () => false,
  onPause: () => game?.game.pause(),
  onResume: () => game?.game.resume(),
});

coop.watchState((state, g) => {
  game = g;
  if (state === "intro" || state === "playing") {
    notifyGameStarted();
  }
  if (prevState === "paused" && state === "playing") {
    resumeGame();
  }
  prevState = state;
});

// A playtest must own its world: it never shares a room.
const solo = isPlaytestRequested() || params.has("bench") || params.has("show");
const connect = async (): Promise<void> => {
  coop.connect(await openRoom(params, { solo }));
};

const boot = async (): Promise<void> => {
  await bootSaltline(coop);
  if (game) {
    installPlaytest(game, () => coop.squadSize);
  }
};

void connect();
void boot();
