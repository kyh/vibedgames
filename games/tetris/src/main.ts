import { setPauseHandlers } from "@repo/embed";
import * as THREE from "three";

import { disposeSound, setSoundPaused, soundDiagnostics } from "./fx/sfx";
import { PoseCamera } from "./input/camera";
import { PoseControls } from "./input/pose-control";
import { isCoarsePointer } from "./input/touch";
import * as pauseOverlay from "./pause-overlay";
import { GameScene } from "./scenes/game-scene";
import { MAX_DT } from "./shared/constants";

function gameContainer(): HTMLElement {
  const node = document.getElementById("game");
  if (!node) throw new Error("missing #game container");
  return node;
}
const container = gameContainer();
const onContextMenu = (event: Event): void => event.preventDefault();
container.addEventListener("contextmenu", onContextMenu); // long-press menus
let disposed = false;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
// Phones cap DPR lower — the antialiased 3D well is fill-rate bound at DPR 3.
const dprCap = isCoarsePointer() ? 1.5 : 2;
const applyPixelRatio = () => renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap));
applyPixelRatio();
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const game = new GameScene(window.innerWidth / window.innerHeight);
Object.defineProperty(window, "__GAME_DIAGNOSTICS__", {
  configurable: true,
  get: () =>
    disposed
      ? { disposed: true, audio: soundDiagnostics() }
      : { ...game.diagnostics(), audio: soundDiagnostics() },
});

// Pose control + webcam: degrades to keyboard if the camera is denied or the
// model fails to load. A mouse-and-keyboard session auto-starts it; a phone
// opts in by tapping the panel, so first paint isn't racing a permission
// prompt and a multi-megabyte model download.
const poseControls = new PoseControls(game.poseActions);
game.attachPoseControls(poseControls);
const poseCamera = new PoseCamera(poseControls.handlePose);
if (!isCoarsePointer()) void poseCamera.start();

const resize = (): void => {
  if (disposed) return;
  game.resize(window.innerWidth / window.innerHeight);
  applyPixelRatio(); // DPR changes when the window moves between displays
  renderer.setSize(window.innerWidth, window.innerHeight);
};
window.addEventListener("resize", resize);

// Wrapper pause: skip update() (engine + collapse physics are dt-driven, so
// they freeze cleanly) and keep rendering the frozen scene behind the overlay.
// Wall-clock collapse/orbit deadlines shift by the paused gap on resume.
let wrapperPausedAt: number | null = null;
// Bespoke overlay (src/pause-overlay.ts) renders the same manifest the title
// legend teaches — filtered per device / pad at show(). Escape, P and pad
// START all funnel into this one pause state machine (@repo/embed).
setPauseHandlers({
  onPause: () => {
    if (disposed || wrapperPausedAt !== null) return;
    wrapperPausedAt = performance.now();
    game.setPresentationPaused(true);
    poseControls.setActionsPaused(true);
    setSoundPaused(true);
    pauseOverlay.show();
  },
  onResume: () => {
    if (disposed || wrapperPausedAt === null) return;
    game.shiftWallClock(performance.now() - wrapperPausedAt);
    wrapperPausedAt = null;
    poseControls.setActionsPaused(false);
    game.setPresentationPaused(false);
    setSoundPaused(false);
    pauseOverlay.hide();
  },
});

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  if (disposed) return;
  timer.update(time);
  const dt = Math.min(timer.getDelta(), MAX_DT);
  if (wrapperPausedAt === null) game.update(dt);
  renderer.render(game.scene, game.camera);
});

/** One final app owner; normal retries retain the renderer, camera and audio. */
function dispose(): void {
  if (disposed) return;
  disposed = true;
  renderer.setAnimationLoop(null);
  container.removeEventListener("contextmenu", onContextMenu);
  window.removeEventListener("resize", resize);
  setPauseHandlers({});
  pauseOverlay.hide();
  poseCamera.destroy();
  poseControls.setActionsPaused(true);
  game.dispose();
  disposeSound();
  timer.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  renderer.domElement.remove();
}

import.meta.hot?.dispose(dispose);

if (import.meta.env.DEV) {
  // __tetris: the scene; __pose: feed synthetic poses or recenter() in the console.
  Object.assign(window, {
    __tetris: game,
    __pose: poseControls,
    __camera: poseCamera,
    __renderer: renderer,
    __tetrisDispose: dispose,
  });
}
