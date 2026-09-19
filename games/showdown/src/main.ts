import "./style.css";

import {
  createTouchControls,
  isOfflineRequested,
  notifyGameStarted,
  probeWebGL,
  setPauseHandlers,
  showWebGLVeil,
} from "@repo/embed";

import { isPlaytestRequested } from "@vibedgames/playtest";

import { isBrawlerId } from "./config";
import { CONTROLS, METHOD_LABEL } from "./controls";
import { installDiagnostics } from "./diagnostics";
import { createShowdownPauseOverlay } from "./pause-overlay";
import { installPlaytest } from "./playtest";
import { sensePlaytest } from "./playtest-sense";
import { mountStartLegend } from "./polish/start-legend";
import { Game } from "./game";
import { mustGet } from "./dom";
import { chosenName } from "./hud-lobby";
import { roomId } from "./net/protocol";

// Dev-console handle (assigned only in DEV builds) for the two-client harness.
declare global {
  interface Window {
    __game?: Game;
  }
}

const webgl = probeWebGL();
if (!webgl.ok) {
  showWebGLVeil(webgl);
  // Module-level boot has no early return: the uncaught throw logs the reason and stops.
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
}

const params = new URLSearchParams(location.search);
const auto = params.get("auto");
const autoKit = auto && isBrawlerId(auto) ? auto : undefined;

const game = new Game({ onMatchStart: notifyGameStarted, selected: autoKit });
installDiagnostics(game, () => sensePlaytest(game));
if (import.meta.env.DEV || isPlaytestRequested()) {
  installPlaytest(game);
}
mountStartLegend(mustGet("menu-legend"), CONTROLS, METHOD_LABEL);
if (import.meta.env.DEV) {
  window.__game = game;
}

// The one launch choke point for deep links: `?online[&room=][&name=]` joins a
// room, `?auto=<brawler>` starts solo; `?offline=1` turns any of them into a
// solo brawl so no socket can open behind it (the menu's buttons call the same
// game methods, and startOnline applies the same rule).
const launch = (): void => {
  if (params.has("online") && !isOfflineRequested()) {
    game.startOnline({ name: chosenName(params), room: roomId(params.get("room") ?? "") });
    return;
  }
  if (autoKit || params.has("online")) {
    game.startMatch(autoKit ?? game.hud.selected);
  }
};
launch();

// Wrapper pause (Escape, the play view's own button, or START on a pad): the
// shared pause overlay carries the controls legend, a how-to-play page and the
// sound toggle. Online the world is shared, so only solo ever freezes the sim —
// the overlay alone is the pause there, and it says so.
const pauseOverlay = createShowdownPauseOverlay({
  isLive: () => game.mode !== "solo",
  mute: { get: () => game.audio.muted, set: (muted) => game.setMuted(muted) },
});
setPauseHandlers({
  // Escape closes the settings panel first; the next press pauses.
  escapePauses: () => !mustGet("settings").classList.contains("open"),
  onPause: () => {
    if (game.mode === "solo") {
      game.setPaused(true, false);
    }
    pauseOverlay.show();
  },
  onResume: () => {
    pauseOverlay.hide();
    if (game.mode === "solo") {
      game.setPaused(false, false);
    }
  },
});

// Pause is Escape, so without this a phone plays a game it cannot leave.
createTouchControls();
