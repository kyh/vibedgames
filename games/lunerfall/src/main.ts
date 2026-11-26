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

declare global {
  interface Window {
    __game?: Game;
  }
}

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

window.__game = game;

installTestHooks(game);

const params = new URLSearchParams(window.location.search);

if (params.has("trailer")) {
  void (async () => {
    const m = await import("./trailer/trailer-director");
    m.initTrailer(game);
  })();
}

const activeGame = () => {
  const scene = game.scene.getScene("game");

  return game.scene.isActive("game") && scene instanceof GameScene ? scene : null;
};

let froze = false;
const pauseOverlay = createLunerfallPauseOverlay();

setPauseHandlers({
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
