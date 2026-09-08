import { isPausable, pauseGame, setPauseHandlers } from "@repo/embed";
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
type GraphicsState = { kind: "ready" } | { kind: "lost"; returnTo: "pause" | "title" };
let graphics: GraphicsState = { kind: "ready" };
let wrapperPausedAt: number | null = null;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
// Phones cap DPR lower — the antialiased 3D well is fill-rate bound at DPR 3.
const dprCap = isCoarsePointer() ? 1.5 : 2;
const applyPixelRatio = () => renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap));
applyPixelRatio();
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const game = new GameScene(window.innerWidth / window.innerHeight);
const diagnostics = () =>
  disposed
    ? { disposed: true, audio: soundDiagnostics() }
    : {
        ...game.diagnostics(),
        paused: wrapperPausedAt !== null,
        graphics: graphics.kind,
        audio: soundDiagnostics(),
      };
Object.defineProperty(window, "__GAME_DIAGNOSTICS__", {
  configurable: true,
  get: diagnostics,
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
  if (disposed || graphics.kind === "lost") return;
  game.resize(window.innerWidth / window.innerHeight);
  applyPixelRatio(); // DPR changes when the window moves between displays
  renderer.setSize(window.innerWidth, window.innerHeight);
};
window.addEventListener("resize", resize);

// Wrapper pause: skip update() (engine + collapse physics are dt-driven, so
// they freeze cleanly) and keep rendering the frozen scene behind the overlay.
// Wall-clock collapse/orbit deadlines shift by the paused gap on resume.
const timer = new THREE.Timer();
function pausePresentation(): void {
  if (wrapperPausedAt !== null) return;
  wrapperPausedAt = performance.now();
  game.setPresentationPaused(true);
  poseControls.setActionsPaused(true);
  setSoundPaused(true);
}
function resumePresentation(): void {
  if (wrapperPausedAt === null) return;
  game.shiftWallClock(performance.now() - wrapperPausedAt);
  wrapperPausedAt = null;
  timer.reset();
  poseControls.setActionsPaused(false);
  game.setPresentationPaused(false);
  setSoundPaused(false);
}
// Bespoke overlay (src/pause-overlay.ts) renders the same manifest the title
// legend teaches — filtered per device / pad at show(). Escape, P and pad
// START all funnel into this one pause state machine (@repo/embed).
const releasePause = setPauseHandlers({
  canResume: () => !disposed && graphics.kind === "ready",
  onPause: () => {
    if (disposed) return;
    pausePresentation();
    if (graphics.kind === "ready") pauseOverlay.show();
  },
  onResume: () => {
    if (disposed || graphics.kind === "lost" || wrapperPausedAt === null) return;
    resumePresentation();
    pauseOverlay.hide();
  },
});

const onContextLost = (event: Event): void => {
  if (disposed) return;
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
};
const onContextRestored = (): void => {
  if (disposed || graphics.kind === "ready") return;
  const returnTo = graphics.returnTo;
  graphics = { kind: "ready" };
  resize();
  pauseOverlay.hideRecovery();
  if (returnTo === "pause") pauseOverlay.show();
  else resumePresentation(); // The untouched title still requires its original START.
};
renderer.domElement.addEventListener("webglcontextlost", onContextLost);
renderer.domElement.addEventListener("webglcontextrestored", onContextRestored);

renderer.setAnimationLoop((time) => {
  if (disposed) return;
  timer.update(time);
  const dt = Math.min(timer.getDelta(), MAX_DT);
  if (wrapperPausedAt === null) game.update(dt);
  if (graphics.kind === "ready") renderer.render(game.scene, game.camera);
});

/** One final app owner; normal retries retain the renderer, camera and audio. */
function dispose(): void {
  if (disposed) return;
  disposed = true;
  renderer.setAnimationLoop(null);
  container.removeEventListener("contextmenu", onContextMenu);
  window.removeEventListener("resize", resize);
  renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
  renderer.domElement.removeEventListener("webglcontextrestored", onContextRestored);
  releasePause();
  pauseOverlay.hideRecovery();
  pauseOverlay.hide();
  poseCamera.destroy();
  poseControls.setActionsPaused(true);
  game.dispose();
  disposeSound();
  timer.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  renderer.domElement.remove();
  if (Object.getOwnPropertyDescriptor(window, "__GAME_DIAGNOSTICS__")?.get === diagnostics)
    Reflect.deleteProperty(window, "__GAME_DIAGNOSTICS__");
  for (const [key, owner] of Object.entries(devHandles)) {
    if (Object.getOwnPropertyDescriptor(window, key)?.value === owner)
      Reflect.deleteProperty(window, key);
  }
}

import.meta.hot?.dispose(dispose);

const devHandles = {
  __tetris: game,
  __pose: poseControls,
  __camera: poseCamera,
  __renderer: renderer,
  __tetrisDispose: dispose,
};
if (import.meta.env.DEV) {
  // __tetris: the scene; __pose: feed synthetic poses or recenter() in the console.
  Object.assign(window, devHandles);
}
