import * as THREE from "three";

import { PoseCamera } from "./input/camera";
import { PoseControls } from "./input/pose-control";
import { isCoarsePointer } from "./input/touch";
import { GameScene } from "./scenes/game-scene";
import { MAX_DT } from "./shared/constants";

const container = document.getElementById("game");
if (!container) throw new Error("missing #game container");
container.addEventListener("contextmenu", (e) => e.preventDefault()); // long-press menus

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
// Phones cap DPR lower — the antialiased 3D well is fill-rate bound at DPR 3.
const dprCap = isCoarsePointer() ? 1.5 : 2;
const applyPixelRatio = () => renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap));
applyPixelRatio();
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
  applyPixelRatio(); // DPR changes when the window moves between displays
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// No setPauseHandlers freeze here on purpose: GameScene's collapse phase
// gates game-over off a wall-clock deadline (collapseStartedAt vs
// CATCH_WINDOW_MS in scenes/game-scene.ts, both performance.now()-based).
// Skipping update() while paused wouldn't stop that clock — a pause longer
// than the 1.3s catch window would insta-finalize game-over on resume. The
// embed package's overlay still shows without registering handlers (per its
// own doc comment: "the game just keeps running behind it"), which is the
// correct fallback for a sim that can't tolerate the gap.
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
