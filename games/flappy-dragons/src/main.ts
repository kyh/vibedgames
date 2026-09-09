import { Game, Scale, WEBGL } from "phaser";
import type { Types } from "phaser";
import { setPauseHandlers } from "@repo/embed";

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
    /** Read-only per-frame telemetry for bot playtests (plugins/tooling/skills/playtest). */
    __GAME_DIAGNOSTICS__?: ReturnType<GameScene["diagnostics"]>;
  }
}

const config: Types.Core.GameConfig = {
  backgroundColor: "#c6ecff",
  parent: "game",
  pixelArt: true,
  scale: {
    // Fill the window; GameScene re-lays-out the backdrop + HUD on resize.
    height: "100%",
    mode: Scale.RESIZE,
    width: "100%",
  },
  scene: [BootScene, GameScene],
  type: WEBGL,
};

const game = new Game(config);

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
  if (!document.hidden) {
    refreshScale();
  }
});

const gameScene = (): GameScene | null => {
  const scene = game.scene.getScene("Game");
  return game.scene.isActive("Game") && scene instanceof GameScene ? scene : null;
};

// Webcam pose-jump (legacy signature feature): detected physical jumps route
// into the scene through the same path as tap/keyboard input — EXCEPT while
// wrapper-paused. Pose events aren't DOM input, so neither the pause overlay
// nor the embed key gate can block them; ungated, a jump in front of the
// camera would flap (or worse, restart into a fresh countdown) behind the
// PAUSED screen.
let wrapperPaused = false;
const poseJump: PoseJumpHandler = (strength, refire) => {
  if (!wrapperPaused) {
    gameScene()?.poseJump(strength, refire);
  }
};

initPoseCamera(poseJump);

// Wrapper-requested pause: never freeze a live race (other players are still
// flying), only the local sim. `froze` tracks whether onPause actually froze
// anything, so onResume only wakes what it put to sleep. Presentation (the
// get-ready 3-2-1, sound, fanfares) is local-only, so it pauses in BOTH paths.
let froze = false;
// Mirrors the start screen's controls card (same manifest).
const pauseOverlay = createFlappyPauseOverlay(CONTROLS);
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
  // Synthetic driver for headless testing: window.__fbPoseJump(0.8, false)
  window.__fbPoseJump = poseJump;
}
