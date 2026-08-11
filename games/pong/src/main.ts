import * as THREE from "three";
import { createTouchControls, setPauseHandlers } from "@repo/embed";

import { isMuted, setMuted } from "./fx/sfx";
import { createHandCamera } from "./input/camera";
import { createPongPauseOverlay } from "./pause-overlay";
import { DitherPass } from "./render/dither-pass";
import { GameScene } from "./scenes/game-scene";
import { DITHER_PIXEL, MAX_DT } from "./shared/constants";
import { COARSE_INPUT } from "./shared/input-mode";

const container = document.getElementById("game");
if (!container) throw new Error("missing #game container");

// No MSAA: the scene renders into the dither pass's low-res target, where
// hard pixels are the point — the canvas only ever shows the quantized quad.
const renderer = new THREE.WebGLRenderer({ antialias: false });

// Snap the pixel ratio so one dithered game pixel maps to a whole number of
// device pixels. A fractional DPR (1.25/1.75 display scaling) would otherwise
// upscale game pixels to alternating 2- and 3-device-px columns, visibly
// warping the Bayer cells. Recomputed on resize (monitor moves change DPR).
function applyPixelRatio(): void {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const gamePxDevice = Math.max(1, Math.round(DITHER_PIXEL * dpr));
  renderer.setPixelRatio(gamePxDevice / DITHER_PIXEL);
}
applyPixelRatio();
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

const game = new GameScene();
const dither = new DitherPass(window.innerWidth, window.innerHeight);

// Wrapper pause: freeze the sim unless a live human opponent is connected
// (see GameScene.requestPause) — the wrapper's own overlay shows either way.
const pauseOverlay = createPongPauseOverlay();
setPauseHandlers({
  onPause: () => {
    pauseOverlay.show();
    game.requestPause();
  },
  onResume: () => {
    pauseOverlay.hide();
    game.requestResume();
  },
});

// Mute is the M key and pause is Escape, so without this a phone plays a
// permanently silent game it cannot leave.
const touchControls = createTouchControls({
  mute: { get: isMuted, set: setMuted },
});
window.addEventListener("keydown", (e) => {
  if (e.code !== "KeyM") return;
  setMuted(!isMuted());
  touchControls.sync();
});

// Webcam hand tracking. On failure it shows a status in its panel and the
// pointer keeps working; a closed fist serves/rematches so a cam-only player
// never has to touch. Starting it costs ~17 MB of third-party wasm + model and
// a camera-permission prompt, so it never runs during boot: a fine pointer
// still gets it automatically (the hand is the better paddle) but only once
// the court is up, while a phone — which already steers well with a finger,
// and pays for the download in cellular data — opts in by tapping the panel.
const handCamera = createHandCamera(
  (x) => game.handleHandPosition(x),
  () => game.handleGestureConfirm(),
);
if (!COARSE_INPUT) {
  window.addEventListener("load", () => handCamera.enable(), { once: true });
}

window.addEventListener("resize", () => {
  game.resize(window.innerWidth / window.innerHeight);
  applyPixelRatio();
  renderer.setSize(window.innerWidth, window.innerHeight);
  dither.setSize(window.innerWidth, window.innerHeight);
});

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), MAX_DT);
  game.update(dt);
  dither.setInverted(game.isScreenInverted());
  dither.render(renderer, game.scene, game.camera);
});

if (import.meta.env.DEV) {
  // __pongHand(x): drive the gesture→paddle path synthetically (x ∈ [0,1]).
  Object.assign(window, {
    __pong: game,
    __pongHand: (x: number) => game.handleHandPosition(x),
    __pongCamera: handCamera,
  });
}
