import Phaser from "phaser";
import { setPauseHandlers } from "@repo/embed";

import { CONTROLS } from "./controls";
import { disposePoseCamera, initPoseCamera, type PoseJumpHandler } from "./input/camera";
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
let disposed = false;

// Scale.RESIZE can read stale parent bounds when a resize lands while the tab
// is hidden or the browser throttles events (tab switch, phone rotation): the
// canvas lags one size behind. Re-check once layout settles and on tab return.
let settle: ReturnType<typeof setTimeout> | undefined;
const refreshScale = (): void => {
  if (disposed) return;
  clearTimeout(settle);
  settle = setTimeout(() => {
    settle = undefined;
    if (!disposed) game.scale.refresh();
  }, 150);
};
window.addEventListener("resize", refreshScale);
const onVisibilityChange = (): void => {
  if (!document.hidden) refreshScale();
};
document.addEventListener("visibilitychange", onVisibilityChange);

// Webcam pose-jump (legacy signature feature): detected physical jumps route
// into the scene through the same path as tap/keyboard input — EXCEPT while
// wrapper-paused. Pose events aren't DOM input, so neither the pause overlay
// nor the embed key gate can block them; ungated, a jump in front of the
// camera would flap (or worse, restart into a fresh countdown) behind the
// PAUSED screen.
let wrapperPaused = false;
const poseJump: PoseJumpHandler = (strength, refire) => {
  if (disposed || wrapperPaused) return;
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
  if (disposed) return null;
  const scene = game.scene.getScene("Game");
  return game.scene.isActive("Game") && scene instanceof GameScene ? scene : null;
};
let froze = false;
// Mirrors the start screen's controls card (same manifest).
const pauseOverlay = createFlappyPauseOverlay(CONTROLS);
setPauseHandlers({
  onPause: () => {
    if (disposed) return;
    wrapperPaused = true;
    pauseOverlay.show();
    gameScene()?.setPresentationPaused(true);
    if (gameScene()?.isOnline() ?? false) return;
    froze = true;
    game.loop.sleep();
  },
  onResume: () => {
    if (disposed) return;
    wrapperPaused = false;
    pauseOverlay.hide();
    gameScene()?.setPresentationPaused(false);
    if (!froze) return;
    froze = false;
    game.loop.wake();
  },
});

// SceneManager is already destroyed at this final event; only app owners remain.
game.events.once(Phaser.Core.Events.DESTROY, () => {
  disposed = true;
  clearTimeout(settle);
  settle = undefined;
  window.removeEventListener("resize", refreshScale);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  setPauseHandlers({});
  pauseOverlay.hide();
  disposePoseCamera();
});

if (import.meta.env.DEV) {
  // Synthetic driver for headless testing: window.__fbPoseJump(0.8, false)
  window.__fbPoseJump = poseJump;
}
