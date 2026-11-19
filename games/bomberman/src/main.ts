import { probeWebGL, setPauseHandlers, showWebGLVeil } from "@repo/embed";
import type { Types } from "phaser";
import { Game, Scale, WEBGL } from "phaser";

import { isMuted, pauseAudio, setMuted } from "./fx/sfx";
import { createBombermanPauseOverlay } from "./pause-overlay";
import { BootScene } from "./scenes/boot-scene";
import { GameScene } from "./scenes/game-scene";

const config: Types.Core.GameConfig = {
  backgroundColor: "#0e1020",
  parent: "game",
  pixelArt: true,
  scale: {
    height: "100%",
    mode: Scale.RESIZE,
    width: "100%",
  },
  scene: [BootScene, GameScene],
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

let settle: ReturnType<typeof setTimeout> | undefined;

const refreshScale = () => {
  clearTimeout(settle);
  settle = setTimeout(() => game.scale.refresh(), 150);
};

window.addEventListener("resize", refreshScale);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshScale();
  }
});

let froze = false;
const pauseOverlay = createBombermanPauseOverlay({ get: isMuted, set: setMuted });

const gameScene = () =>
  game.scene.isActive("Game") ? game.scene.getScene<GameScene>("Game") : null;

setPauseHandlers({
  onPause: () => {
    pauseOverlay.show();
    pauseAudio(true);
    const scene = gameScene();
    scene?.setPresentationPaused(true);

    if (!scene || !scene.freezable) {
      return;
    }

    froze = true;
    scene.pauseSimulation();
    game.sound.pauseAll();
  },
  onResume: () => {
    pauseOverlay.hide();
    pauseAudio(false);
    const scene = gameScene();
    scene?.setPresentationPaused(false);

    if (!froze) {
      return;
    }

    froze = false;
    scene?.resumeSimulation();
    game.sound.resumeAll();
  },
});
