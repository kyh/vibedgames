import * as THREE from "three";
import { createTouchControls, setPauseHandlers } from "@repo/embed";

import { isMuted, resumeSound, setMuted, setSoundPaused } from "./fx/sfx";
import { createHandCamera } from "./input/camera";
import type { HandCamera } from "./input/camera";
import { createPongPauseOverlay } from "./pause-overlay";
import { DitherPass } from "./render/dither-pass";
import { GameScene } from "./scenes/game-scene";
import { DITHER_PIXEL, MAX_DT } from "./shared/constants";
import { COARSE_INPUT } from "./shared/input-mode";

const container = document.querySelector("#game");
if (!container) {
  throw new Error("missing #game container");
}

// No MSAA: the scene renders into the dither pass's low-res target, where
// hard pixels are the point — the canvas only ever shows the quantized quad.
const renderer = new THREE.WebGLRenderer({ antialias: false });
// Diagnostics count the scene pass and the dither quad together.
renderer.info.autoReset = false;

// Snap the pixel ratio so one dithered game pixel maps to a whole number of
// device pixels. A fractional DPR (1.25/1.75 display scaling) would otherwise
// upscale game pixels to alternating 2- and 3-device-px columns, visibly
// warping the Bayer cells. Recomputed on resize (monitor moves change DPR).
const applyPixelRatio = (): void => {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const gamePxDevice = Math.max(1, Math.round(DITHER_PIXEL * dpr));
  renderer.setPixelRatio(gamePxDevice / DITHER_PIXEL);
};
applyPixelRatio();
renderer.setSize(window.innerWidth, window.innerHeight);
container.append(renderer.domElement);

// Unlock audio on the first real gesture (capture: before that gesture serves).
for (const event of ["pointerdown", "keydown"]) {
  window.addEventListener(event, resumeSound, { capture: true });
}
const game = new GameScene();
const dither = new DitherPass(window.innerWidth, window.innerHeight);

// Wrapper pause: freeze the sim unless a live human opponent is connected
// (see GameScene.requestPause) — the wrapper's own overlay shows either way.
const pauseOverlay = createPongPauseOverlay(() => game.hasLiveOpponent(), {
  get: isMuted,
  set: setMuted,
});
setPauseHandlers({
  onPause: () => {
    game.requestPause();
    setSoundPaused(true);
    pauseOverlay.show();
  },
  onResume: () => {
    pauseOverlay.hide();
    game.requestResume();
    setSoundPaused(false);
  },
});

// Pause is Escape, so without this a phone plays a game it cannot leave.
createTouchControls();
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    // Space on a focused button already clicks it; confirming here too would double-fire.
    if (e.target instanceof HTMLElement && e.target.closest("button")) {
      return;
    }
    e.preventDefault();
    if (!e.repeat) {
      game.handleGestureConfirm();
    }
  } else if (e.code === "KeyM" && !e.repeat) {
    setMuted(!isMuted());
  }
});

// Webcam hand tracking. On failure it shows a status in its panel and the
// pointer keeps working; a closed fist serves, arms a power shot or rematches,
// so a cam-only player never has to touch. Starting it costs ~17 MB of
// third-party wasm + model and a camera-permission prompt, so it never runs
// during boot: a fine pointer still gets it automatically (the hand is the
// better paddle) but only once the court is up, while a phone — which already
// steers well with a finger, and pays for the download in cellular data —
// opts in by tapping the panel.
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
  renderer.info.reset();
  dither.setInverted(game.isScreenInverted());
  dither.render(renderer, game.scene, game.camera);
});

// See plugins/tooling/skills/playtest/references/bot-playtest.md. State hooks
// opt into a solo match, never write a staged score into a live room.
interface TestHooks {
  seed: (seed: number) => void;
  setState: (name: string) => void;
  setPausedForScreenshot: (paused: boolean) => void;
  setReducedMotion: (enabled: boolean) => void;
}
declare global {
  interface Window {
    /** Dev-only hooks; __pongHand(x) drives the gesture→paddle path synthetically (x ∈ [0,1]). */
    __pong?: GameScene;
    __pongHand?: (x: number) => void;
    __pongCamera?: HandCamera;
    __GAME_TEST_HOOKS__?: TestHooks;
  }
}
Object.defineProperty(window, "__GAME_DIAGNOSTICS__", {
  get: () => ({
    ...game.diagnostics(),
    renderer: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles },
  }),
});
if (import.meta.env.DEV || new URLSearchParams(window.location.search).get("test") === "1") {
  const hooks: TestHooks = {
    seed: (seed) => game.seed(seed),
    setPausedForScreenshot: (paused) => (paused ? game.requestPause() : game.requestResume()),
    setReducedMotion: (enabled) => game.setReducedMotion(enabled),
    setState: (name) => game.setTestState(name),
  };
  Object.assign(window, { __GAME_TEST_HOOKS__: hooks });
}
if (import.meta.env.DEV) {
  Object.assign(window, {
    __pong: game,
    __pongCamera: handCamera,
    __pongHand: (x: number) => game.handleHandPosition(x),
  });
}
