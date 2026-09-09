import { isPausable, pauseGame, setPauseHandlers } from "@repo/embed";
import * as THREE from "three";

import { setSoundPaused } from "./fx/sfx";
import { PoseCamera } from "./input/camera";
import { PoseControls } from "./input/pose-control";
import { isCoarsePointer } from "./input/touch";
import * as pauseOverlay from "./pause-overlay";
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

// Pose control + webcam: degrades to keyboard if the camera is denied or the
// model fails to load. A mouse-and-keyboard session auto-starts it; a phone
// opts in by tapping the panel, so first paint isn't racing a permission
// prompt and a multi-megabyte model download.
const poseControls = new PoseControls(game.poseActions);
game.attachPoseControls(poseControls);
const poseCamera = new PoseCamera(poseControls.handlePose);
if (!isCoarsePointer()) void poseCamera.start();

const resize = (): void => {
  game.resize(window.innerWidth / window.innerHeight);
  applyPixelRatio(); // DPR changes when the window moves between displays
  renderer.setSize(window.innerWidth, window.innerHeight);
};
window.addEventListener("resize", resize);

// Wrapper pause: skip update() (engine + collapse physics are dt-driven, so
// they freeze cleanly) and keep rendering the frozen scene behind the overlay.
// Wall-clock deadlines (collapse catch window, camera swing) shift by the
// paused gap on resume so a long pause can't insta-finalize game-over.
let wrapperPausedAt: number | null = null;
function pausePresentation(): void {
  if (wrapperPausedAt !== null) return;
  wrapperPausedAt = performance.now();
  game.releaseInputs();
  poseControls.setActionsPaused(true);
  setSoundPaused(true);
}
function resumePresentation(): void {
  if (wrapperPausedAt === null) return;
  game.shiftWallClock(performance.now() - wrapperPausedAt);
  wrapperPausedAt = null;
  game.releaseInputs();
  poseControls.setActionsPaused(false);
  setSoundPaused(false);
}

// A lost WebGL context freezes play under a recovery notice; the embed pause
// stays held (canResume) until the browser restores the context.
type Graphics = { kind: "ready" } | { kind: "lost"; returnTo: "pause" | "title" };
let graphics: Graphics = { kind: "ready" };

// Bespoke overlay (src/pause-overlay.ts) renders the same manifest the title
// legend teaches — filtered per device / pad at show(). Escape, P and pad
// START all funnel into this one pause state machine (@repo/embed).
setPauseHandlers({
  canResume: () => graphics.kind === "ready",
  onPause: () => {
    pausePresentation();
    if (graphics.kind === "ready") pauseOverlay.show();
  },
  onResume: () => {
    resumePresentation();
    pauseOverlay.hide();
  },
});

renderer.domElement.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  if (graphics.kind === "lost") return;
  graphics = {
    kind: "lost",
    returnTo: wrapperPausedAt !== null || isPausable() ? "pause" : "title",
  };
  pausePresentation();
  pauseGame();
  pauseOverlay.hide();
  pauseOverlay.showRecovery();
});
renderer.domElement.addEventListener("webglcontextrestored", () => {
  if (graphics.kind === "ready") return;
  const { returnTo } = graphics;
  graphics = { kind: "ready" };
  resize();
  pauseOverlay.hideRecovery();
  // A title screen was never pausable, so nothing re-announces it: unfreeze directly.
  if (returnTo === "pause") pauseOverlay.show();
  else resumePresentation();
});

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), MAX_DT);
  if (wrapperPausedAt === null) game.update(dt);
  if (graphics.kind === "ready") renderer.render(game.scene, game.camera);
});

Object.defineProperty(window, "__GAME_DIAGNOSTICS__", {
  get: () => ({ ...game.diagnostics(), paused: wrapperPausedAt !== null }),
});

if (import.meta.env.DEV) {
  // __tetris: the scene; __pose: feed synthetic poses or recenter() in the console.
  Object.assign(window, { __tetris: game, __pose: poseControls, __camera: poseCamera });
}
