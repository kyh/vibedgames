import { Game, Scale, WEBGL } from "phaser";
import type { Types } from "phaser";
import { probeWebGL, setPauseHandlers, showWebGLVeil } from "@repo/embed";

import { CONTROLS } from "./controls";
import { initPoseCamera } from "./input/camera";
import type { PoseJumpHandler } from "./input/camera";
import type { NetSession } from "./net/session";
import { createFlappyPauseOverlay } from "./pause-overlay";
import { BootScene } from "./scenes/boot-scene";
import { GameScene } from "./scenes/game-scene";

declare global {
  interface Window {
    /** Dev-only hook: live scene + net session for headless inspection. */
    __fb?: { scene: GameScene; net: NetSession };
    /** Dev-only synthetic pose-jump driver: window.__fbPoseJump(0.8, false) */
    __fbPoseJump?: PoseJumpHandler;
  }
}

const config: Types.Core.GameConfig = {
  backgroundColor: "#c6ecff",
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
  settle = setTimeout(() => {
    game.scale.refresh();
  }, 150);
};

window.addEventListener("resize", refreshScale);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshScale();
  }
});

const gameScene = () => {
  const scene = game.scene.getScene("Game");

  return game.scene.isActive("Game") && scene instanceof GameScene ? scene : null;
};

let wrapperPaused = false;

const poseJump: PoseJumpHandler = (strength, refire) => {
  if (!wrapperPaused) {
    gameScene()?.poseJump(strength, refire);
  }
};

initPoseCamera(poseJump);

let froze = false;

const pauseOverlay = createFlappyPauseOverlay(CONTROLS, {
  get: () => gameScene()?.isMuted() ?? true,
  set: (next) => gameScene()?.setMuted(next),
});

setPauseHandlers({
  onPause: () => {
    wrapperPaused = true;
    pauseOverlay.show();
    gameScene()?.setPresentationPaused(true);

    if (gameScene()?.isOnline() ?? false) {
      return;
    }

    froze = true;
    game.loop.sleep();
  },
  onResume: () => {
    wrapperPaused = false;
    pauseOverlay.hide();
    gameScene()?.setPresentationPaused(false);

    if (!froze) {
      return;
    }

    froze = false;
    game.loop.wake();
  },
});

if (import.meta.env.DEV) {
  window.__fbPoseJump = poseJump;
}
