import type { Types } from "phaser";
import { Game, Scale, WEBGL } from "phaser";
import { probeWebGL, setPauseHandlers, showWebGLVeil } from "@repo/embed";

import { sfx } from "./audio/sfx";
import { BASE_H, BASE_W } from "./config";
import { createLunerfallPauseOverlay } from "./pause-overlay";
import { BootScene } from "./scenes/boot-scene";
import { installTestHooks } from "./sys/diag";
import { GameScene } from "./scenes/game-scene";
import { SelectScene } from "./scenes/select-scene";

const config: Types.Core.GameConfig = {
  backgroundColor: "#05070b",
  parent: "game",
  pixelArt: true,
  roundPixels: true,
  scale: {
    autoCenter: Scale.CENTER_BOTH,
    height: BASE_H,
    mode: Scale.FIT,
    width: BASE_W,
  },
  scene: [BootScene, SelectScene, GameScene],
  type: WEBGL,
};

const webgl = probeWebGL();
if (!webgl.ok) {
  showWebGLVeil(webgl);
  // Module-level boot has no early return: the uncaught throw logs the reason and stops.
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
}

const game = new Game(config);
game.canvas.addEventListener("webglcontextlost", () => {
  console.error("WebGL context lost");
  showWebGLVeil(
    { blocked: false, ok: false, reason: "context lost" },
    "The browser stopped the graphics (usually low memory).",
  );
});
// Debug handle for perf/inspection probes (see globalThis.__game).
Reflect.set(globalThis, "__game", game);
// __GAME_DIAGNOSTICS__ / __GAME_TEST_HOOKS__ for bot playtests (sys/diag.ts).
installTestHooks(game);

const params = new URLSearchParams(window.location.search);

// Trailer mode (?trailer=1): hand the boot to the trailer director. Lazy import
// so the trailer module never loads — and trailer code stays dead — in normal play.
if (params.has("trailer")) {
  void (async () => {
    const m = await import("./trailer/trailer-director");
    m.initTrailer(game);
  })();
}

// Wrapper-requested pause: never freeze a live co-op/versus session another
// player is relying on, only the local sim (controls + audio). `froze` tracks
// whether onPause actually froze the loop, so onResume only wakes what it put
// to sleep.
const activeGame = (): GameScene | null => {
  const scene = game.scene.getScene("game");
  return game.scene.isActive("game") && scene instanceof GameScene ? scene : null;
};
let froze = false;
const pauseOverlay = createLunerfallPauseOverlay();
setPauseHandlers({
  // Versus binds Escape to "leave the duel", and the hub's dialogs own Escape
  // themselves — only a co-op/solo run pauses on it.
  escapePauses: () => {
    const scene = activeGame();
    return scene !== null && !scene.isVersus();
  },
  onPause: () => {
    sfx.setPaused(true);
    activeGame()?.setControlsPaused(true);
    pauseOverlay.show();
    if (activeGame()?.isOnline()) {
      return;
    }
    froze = true;
    game.loop.sleep();
  },
  onResume: () => {
    sfx.setPaused(false);
    activeGame()?.setControlsPaused(false);
    pauseOverlay.hide();
    if (!froze) {
      return;
    }
    froze = false;
    game.loop.wake();
  },
});
