import Phaser from "phaser";
import { setPauseHandlers } from "@repo/embed";

import { CONTROLS } from "./controls";
import { initPoseCamera, type PoseJumpHandler } from "./input/camera";
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

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  backgroundColor: "#c6ecff",
  scale: {
    // Fill the window; GameScene re-lays-out the backdrop + HUD on resize.
    mode: Phaser.Scale.RESIZE,
    width: "100%",
    height: "100%",
  },
  pixelArt: true,
  scene: [BootScene, GameScene],
};

const game = new Phaser.Game(config);

// Scale.RESIZE can read stale parent bounds when a resize lands while the tab
// is hidden or the browser throttles events (tab switch, phone rotation): the
// canvas lags one size behind. Re-check once layout settles and on tab return.
let settle: ReturnType<typeof setTimeout> | undefined;
const refreshScale = (): void => {
  clearTimeout(settle);
  settle = setTimeout(() => game.scale.refresh(), 150);
};
window.addEventListener("resize", refreshScale);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshScale();
});

// Webcam pose-jump (legacy signature feature): detected physical jumps route
// into the scene through the same path as tap/keyboard input.
const poseJump: PoseJumpHandler = (strength, refire) => {
  const scene = game.scene.getScene("Game");
  if (game.scene.isActive("Game") && scene instanceof GameScene) {
    scene.poseJump(strength, refire);
  }
};

initPoseCamera(poseJump);

// Wrapper-requested pause: never freeze a live race (other players are still
// flying), only the local sim. `froze` tracks whether onPause actually froze
// anything, so onResume only wakes what it put to sleep. The get-ready 3-2-1
// is local-only, so it pauses in BOTH paths (online it would otherwise keep
// ticking behind the overlay).
const gameScene = (): GameScene | null => {
  const scene = game.scene.getScene("Game");
  return game.scene.isActive("Game") && scene instanceof GameScene ? scene : null;
};
let froze = false;
// Mirrors the start screen's controls card (same manifest).
const pauseOverlay = createFlappyPauseOverlay(CONTROLS);
setPauseHandlers({
  onPause: () => {
    pauseOverlay.show();
    gameScene()?.setCountdownPaused(true);
    if (gameScene()?.isOnline() ?? false) return;
    froze = true;
    game.loop.sleep();
    game.sound.pauseAll();
  },
  onResume: () => {
    pauseOverlay.hide();
    gameScene()?.setCountdownPaused(false);
    if (!froze) return;
    froze = false;
    game.loop.wake();
    game.sound.resumeAll();
  },
});

if (import.meta.env.DEV) {
  // Synthetic driver for headless testing: window.__fbPoseJump(0.8, false)
  window.__fbPoseJump = poseJump;
}
