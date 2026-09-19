import "./style.css";

import {
  createTouchControls,
  notifyGameStarted,
  probeWebGL,
  setPauseHandlers,
  showWebGLVeil,
} from "@repo/embed";

import { Game } from "./game";
import { mustGet } from "./dom";

const webgl = probeWebGL();
if (!webgl.ok) {
  showWebGLVeil(webgl);
  // Module-level boot has no early return: the uncaught throw logs the reason and stops.
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
}

const game = new Game({ onMatchStart: notifyGameStarted });

// Wrapper pause (Escape, or the play view's own button): freeze the sim behind
// the settings-free frozen frame and silence the mix, then put the player's own
// mute choice back on resume. The in-game P key keeps its toast; this path is
// silent because the wrapper shows its chrome instead.
let mutedBeforePause = false;
setPauseHandlers({
  // Escape closes the settings panel first; the next press pauses.
  escapePauses: () => !mustGet("settings").classList.contains("open"),
  onPause: () => {
    game.setPaused(true, false);
    mutedBeforePause = game.audio.muted;
    game.audio.setMuted(true);
  },
  onResume: () => {
    game.audio.setMuted(mutedBeforePause);
    game.setPaused(false, false);
  },
});

// Pause is Escape, so without this a phone plays a game it cannot leave.
createTouchControls();
