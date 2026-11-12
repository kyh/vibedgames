import "./style.css";

import {
  notifyGameStarted,
  probeWebGL,
  resumeGame,
  setPauseHandlers,
  showWebGLVeil,
} from "@repo/embed";
import { isPlaytestRequested } from "@vibedgames/playtest";

import { bootStrikeforce } from "./core/strikeforce-core.js";
import type { GameState, StrikeforceGame } from "./core/types";
import { Garrison } from "./garrison/garrison";
import { Match } from "./net/match";
import { BOTS } from "./net/rules";
import { openRoom } from "./net/session";
import { installPlaytest } from "./playtest";

declare global {
  interface Window {
    /** Dev-only handle for tools/two-client.mjs. */
    __strikeforce?: { match: Match };
  }
}

const webgl = probeWebGL();
if (!webgl.ok) {
  showWebGLVeil(webgl);
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
}

const params = new URLSearchParams(location.search);
// A playtest must own its match: it never shares a room.
const solo = isPlaytestRequested() || params.has("bench") || params.has("show");
// A playtest keeps the dock to itself; `?bots=0` turns them off, `?bots=4` sets the fill.
const botFill = isPlaytestRequested()
  ? 0
  : Math.max(0, Math.min(16, Number(params.get("bots") ?? BOTS.fill) || 0));
const match = new Match(() => openRoom(params, { solo }), { botFill });
if (import.meta.env.DEV) {
  window.__strikeforce = { match };
}
let game: StrikeforceGame | null = null;
let prevState: GameState = "title";

// The wrapper's pause opens the game's own pause menu; the game owns Escape
// (and its own touch pause button), and its Resume hands back to the wrapper.
// A match never freezes: the round plays on behind the menu.
setPauseHandlers({
  escapePauses: () => false,
  onPause: () => game?.game.pause(),
  onResume: () => game?.game.resume(),
});

match.watchState((state, g) => {
  game = g;
  if (state === "intro" || state === "playing") {
    notifyGameStarted();
  }
  if (prevState === "paused" && state === "playing") {
    resumeGame();
  }
  prevState = state;
});

const boot = async (): Promise<void> => {
  await bootStrikeforce(match, { enemies: (g) => new Garrison(g) });
  if (game) {
    installPlaytest(game, match);
  }
};

void boot();
