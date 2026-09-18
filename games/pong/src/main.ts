import * as THREE from "three";
import { createTouchControls, probeWebGL, setPauseHandlers, showWebGLVeil } from "@repo/embed";

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

const webgl = probeWebGL();
if (!webgl.ok) {
  showWebGLVeil(webgl);
  // Module-level boot has no early return: the uncaught throw logs the reason and stops.
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
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
renderer.domElement.addEventListener("webglcontextlost", () => {
  console.error("WebGL context lost");
  showWebGLVeil(
    { blocked: false, ok: false, reason: "context lost" },
    "The browser stopped the graphics (usually low memory).",
  );
});

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
/**
 * What `vg playtest run` may do to this game, in the words the decision model
 * chooses between. A move may carry a `reflex`: while it is the model's
 * current intent, the reflex runs every frame and its inputs are what is
 * held — the model decides a few times a second, the reflex acts at 60 fps.
 */
interface PlaytestManifest {
  goal: string;
  move: Record<
    string,
    {
      description: string;
      keys?: string[];
      pointer?: { x: number; y: number; down?: boolean };
      reflex?: (game: ReturnType<GameScene["diagnostics"]>) => {
        keys?: string[];
        pointer?: { x: number; y: number; down?: boolean } | null;
      } | null;
    }
  >;
  actions?: Record<string, { description: string; keys: string[] }>;
}
declare global {
  interface Window {
    /** Dev-only hooks; __pongHand(x) drives the gesture→paddle path synthetically (x ∈ [0,1]). */
    __pong?: GameScene;
    __pongHand?: (x: number) => void;
    __pongCamera?: HandCamera;
    __GAME_TEST_HOOKS__?: TestHooks;
    __GAME_PLAYTEST__?: PlaytestManifest;
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
  // The paddle follows the pointer's x, so the playtester steers by parking
  // the cursor; five lanes are enough to get under the ball. Read at launch by
  // `vg playtest run` so no --controls file is needed for this game.
  // `track_ball` is the fast-game path: a per-frame controller that walks
  // the pointer until the paddle sits under the ball. The pointer→paddle map
  // is a raycast, so rather than invert it the reflex nudges the cursor by
  // the paddle's error each frame and lets the game close the loop.
  let cursorX = 0.5;
  const trackBall: NonNullable<PlaytestManifest["move"][string]["reflex"]> = (diag) => {
    const error = diag.ball.x - diag.player.x;
    cursorX = Math.min(
      0.95,
      Math.max(0.05, cursorX + Math.min(0.04, Math.max(-0.04, error * 0.03))),
    );
    return { pointer: { x: cursorX, y: 0.5 } };
  };
  const manifest: PlaytestManifest = {
    actions: {
      serve: {
        description: "serve the ball, or fire a charged power shot (Space)",
        keys: ["Space"],
      },
    },
    goal: "You control the bottom paddle; it follows the pointer's x. Return every ball: `track_ball` keeps the paddle under it automatically, the parked positions are for waiting or baiting. Serve when the ball is not moving (game.phase). game.score is your points; game.opponentScore is theirs.",
    move: {
      centre: {
        description: "Park the paddle in the centre of the court",
        pointer: { x: 0.5, y: 0.5 },
      },
      far_left: {
        description: "Park the paddle at the far left of the court",
        pointer: { x: 0.1, y: 0.5 },
      },
      far_right: {
        description: "Park the paddle at the far right of the court",
        pointer: { x: 0.9, y: 0.5 },
      },
      left: { description: "Park the paddle left of centre", pointer: { x: 0.3, y: 0.5 } },
      right: { description: "Park the paddle right of centre", pointer: { x: 0.7, y: 0.5 } },
      track_ball: {
        description:
          "Follow the ball — keep the paddle under it every frame (the default for a rally)",
        reflex: trackBall,
      },
    },
  };
  Object.assign(window, { __GAME_PLAYTEST__: manifest, __GAME_TEST_HOOKS__: hooks });
}
if (import.meta.env.DEV) {
  Object.assign(window, {
    __pong: game,
    __pongCamera: handCamera,
    __pongHand: (x: number) => game.handleHandPosition(x),
  });
}
