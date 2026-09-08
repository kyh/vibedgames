import * as THREE from "three";
import { createTouchControls, setPauseHandlers } from "@repo/embed";

import { disposeSound, isMuted, resumeSound, setMuted, setSoundPaused } from "./fx/sfx";
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
// Count the scene and existing dither pass together in diagnostics.
renderer.info.autoReset = false;

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

const inputOwner = new AbortController();
let disposed = false;
for (const event of ["pointerdown", "keydown"]) {
  window.addEventListener(event, resumeSound, { capture: true, signal: inputOwner.signal });
}
const game = new GameScene();
const dither = new DitherPass(window.innerWidth, window.innerHeight);

// Wrapper pause: freeze the sim unless a live human opponent is connected
// (see GameScene.requestPause) — the wrapper's own overlay shows either way.
const pauseOverlay = createPongPauseOverlay(() => game.hasLiveOpponent());
const releasePause = setPauseHandlers({
  onPause: () => {
    if (disposed) return;
    game.requestPause();
    setSoundPaused(true);
    pauseOverlay.show();
  },
  onResume: () => {
    if (disposed) return;
    pauseOverlay.hide();
    game.requestResume();
    setSoundPaused(false);
  },
});

// Mute is the M key and pause is Escape, so without this a phone plays a
// permanently silent game it cannot leave.
const soundButton = document.getElementById("sound-toggle");
if (!soundButton) throw new Error("missing #sound-toggle");
function syncSound(): void {
  if (!soundButton) return;
  soundButton.textContent = isMuted() ? "SOUND OFF" : "SOUND ON";
  soundButton.setAttribute("aria-pressed", String(!isMuted()));
  soundButton.setAttribute("aria-label", isMuted() ? "Turn sound on" : "Turn sound off");
}
function changeSound(muted: boolean): void {
  if (disposed) return;
  setMuted(muted);
  syncSound();
}
const touchControls = createTouchControls({
  mute: { get: isMuted, set: changeSound },
});
soundButton.addEventListener("pointerdown", (event) => event.stopPropagation(), {
  signal: inputOwner.signal,
});
soundButton.addEventListener("pointerup", (event) => event.stopPropagation(), {
  signal: inputOwner.signal,
});
soundButton.addEventListener(
  "click",
  () => {
    changeSound(!isMuted());
    touchControls.sync();
  },
  { signal: inputOwner.signal },
);
window.addEventListener(
  "keydown",
  (e) => {
    if (e.code !== "KeyM" || e.repeat) return;
    changeSound(!isMuted());
    touchControls.sync();
  },
  { signal: inputOwner.signal },
);
syncSound();

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
  window.addEventListener("load", () => handCamera.enable(), {
    once: true,
    signal: inputOwner.signal,
  });
}

window.addEventListener(
  "resize",
  () => {
    game.resize(window.innerWidth / window.innerHeight);
    applyPixelRatio();
    renderer.setSize(window.innerWidth, window.innerHeight);
    dither.setSize(window.innerWidth, window.innerHeight);
  },
  { signal: inputOwner.signal },
);

const timer = new THREE.Timer();
type Diagnostics = ReturnType<GameScene["diagnostics"]> & {
  renderer: { calls: number; triangles: number };
};
let diagnostics: Diagnostics | undefined;
renderer.setAnimationLoop((time) => {
  if (disposed) return;
  timer.update(time);
  const dt = Math.min(timer.getDelta(), MAX_DT);
  game.update(dt);
  renderer.info.reset();
  dither.setInverted(game.isScreenInverted());
  dither.render(renderer, game.scene, game.camera);
  diagnostics = {
    ...game.diagnostics(),
    renderer: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles },
  };
  window.__GAME_DIAGNOSTICS__ = diagnostics;
});

// Final owner only: visibility and BFCache leave the match recoverable.
function dispose(): void {
  if (disposed) return;
  disposed = true;
  renderer.setAnimationLoop(null);
  inputOwner.abort();
  releasePause();
  pauseOverlay.hide();
  touchControls.destroy();
  handCamera.stop();
  game.dispose();
  disposeSound();
  dither.dispose();
  timer.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  renderer.domElement.remove();
  if (window.__pong === game) delete window.__pong;
  if (window.__pongHand === handleHand) delete window.__pongHand;
  if (window.__pongCamera === handCamera) delete window.__pongCamera;
  if (window.__pongDispose === dispose) delete window.__pongDispose;
  if (window.__GAME_TEST_HOOKS__ === testHooks) delete window.__GAME_TEST_HOOKS__;
  if (window.__GAME_DIAGNOSTICS__ === diagnostics) delete window.__GAME_DIAGNOSTICS__;
}
import.meta.hot?.dispose(dispose);

function handleHand(x: number): void {
  if (!disposed) game.handleHandPosition(x);
}
const testHooks = {
  seed: (seed: number) => {
    if (!disposed) game.seed(seed);
  },
  setState: (name: string) => {
    if (!disposed) game.setTestState(name);
  },
  setPausedForScreenshot: (paused: boolean) => {
    if (!disposed) paused ? game.requestPause() : game.requestResume();
  },
  setReducedMotion: (enabled: boolean) => {
    if (!disposed) game.setReducedMotion(enabled);
  },
  hand: handleHand,
};
declare global {
  interface Window {
    __pong?: GameScene;
    __pongHand?: typeof handleHand;
    __pongCamera?: ReturnType<typeof createHandCamera>;
    __pongDispose?: typeof dispose;
    __GAME_TEST_HOOKS__?: typeof testHooks;
    __GAME_DIAGNOSTICS__?: Diagnostics;
  }
}

// See plugins/tooling/skills/playtest/references/bot-playtest.md. State hooks
// opt into a solo match, never write a staged score into a live room.
if (import.meta.env.DEV || new URLSearchParams(window.location.search).get("test") === "1") {
  window.__GAME_TEST_HOOKS__ = testHooks;
}

if (import.meta.env.DEV) {
  // __pongHand(x): drive the gesture→paddle path synthetically (x ∈ [0,1]).
  Object.assign(window, {
    __pong: game,
    __pongHand: handleHand,
    __pongCamera: handCamera,
    __pongDispose: dispose,
  });
}
