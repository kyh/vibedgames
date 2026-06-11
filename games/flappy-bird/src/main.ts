import Phaser from "phaser";

import { initPoseCamera, type PoseJumpHandler } from "./input/camera";
import { BootScene } from "./scenes/BootScene";
import { GameScene } from "./scenes/GameScene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  backgroundColor: "#70c5ce",
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

// Webcam pose-jump (legacy signature feature): detected physical jumps route
// into the scene through the same path as tap/keyboard input.
const poseJump: PoseJumpHandler = (strength, refire) => {
  const scene = game.scene.getScene("Game");
  if (game.scene.isActive("Game") && scene instanceof GameScene) {
    scene.poseJump(strength, refire);
  }
};

initPoseCamera(poseJump);

if (import.meta.env.DEV) {
  // Synthetic driver for headless testing: window.__fbPoseJump(0.8, false)
  (window as unknown as { __fbPoseJump?: PoseJumpHandler }).__fbPoseJump = poseJump;
}
