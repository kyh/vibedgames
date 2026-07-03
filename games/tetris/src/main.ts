import * as THREE from "three";

import { PoseCamera } from "./input/camera";
import { PoseControls } from "./input/pose-control";
import { GameScene } from "./scenes/game-scene";
import { MAX_DT } from "./shared/constants";

const container = document.getElementById("game");
if (!container) throw new Error("missing #game container");

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const game = new GameScene(window.innerWidth / window.innerHeight);

// Pose control + webcam: auto-starts (no button), degrades to keyboard if the
// camera is denied or the model fails to load.
const poseControls = new PoseControls(game.poseActions);
game.attachPoseControls(poseControls);
const poseCamera = new PoseCamera(poseControls.handlePose);
void poseCamera.start();

window.addEventListener("resize", () => {
  game.resize(window.innerWidth / window.innerHeight);
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Keyboard events only reach the frame that holds focus. When the game runs
// inside an iframe (the vibedgames hub, a forked embed), the parent document
// keeps focus on load, so our window keydown handlers never fire and the
// controls appear dead until the player clicks in. Claim focus on load and on
// any pointer interaction so the keys work immediately, no stray click first.
const claimFocus = (): void => window.focus();
claimFocus();
window.addEventListener("pointerdown", claimFocus);

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), MAX_DT);
  game.update(dt);
  renderer.render(game.scene, game.camera);
});

if (import.meta.env.DEV) {
  // __tetris: the scene; __pose: feed synthetic poses or recenter() in the console.
  Object.assign(window, { __tetris: game, __pose: poseControls });
}
