import * as THREE from "three";
import { createTouchControls, probeWebGL, setPauseHandlers, showWebGLVeil } from "@repo/embed";
import {
  isPlaytestRequested,
  pointerTracker,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";

import { isMuted, resumeSound, setMuted, setSoundPaused } from "./fx/sfx";
import { createHandCamera } from "./input/camera";
import type { HandCamera } from "./input/camera";
import { createPongPauseOverlay } from "./pause-overlay";
import { DitherPass } from "./render/dither-pass";
import { GameScene } from "./scenes/game-scene";
import { DITHER_PIXEL, HIT_HALF_X, MAX_DT } from "./shared/constants";
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
// A playtest browser denies the camera, and the rejection is a console error
// — which is a failed playtest for a reason that has nothing to do with pong.
if (!COARSE_INPUT && !isPlaytestRequested()) {
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
type PongDiagnostics = ReturnType<GameScene["diagnostics"]> & {
  renderer: { calls: number; triangles: number };
};
declare global {
  interface Window {
    /** Dev-only hooks; __pongHand(x) drives the gesture→paddle path synthetically (x ∈ [0,1]). */
    __pong?: GameScene;
    __pongHand?: (x: number) => void;
    __pongCamera?: HandCamera;
  }
}
publishDiagnostics((): PongDiagnostics => ({
  ...game.diagnostics(),
  renderer: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles },
}));
if (import.meta.env.DEV || isPlaytestRequested()) {
  publishTestHooks({
    seed: (seed) => game.seed(seed),
    setPausedForScreenshot: (paused) => (paused ? game.requestPause() : game.requestResume()),
    setReducedMotion: (enabled) => game.setReducedMotion(enabled),
    setState: (name) => {
      game.setTestState(name);
      return { state: name };
    },
  });
  // What `vg playtest run` may do to this game, in the words the decision
  // model chooses between. The paddle follows the pointer's x, so the
  // playtester steers by parking the cursor; five lanes are enough to get
  // under the ball. `track_ball` is the fast-game path: a per-frame reflex
  // that walks the pointer until the paddle sits under the ball. The
  // pointer→paddle map is a raycast, so rather than invert it the tracker
  // nudges the cursor by the paddle's error each frame and lets the game
  // close the loop — the model decides a few times a second, this runs at
  // 60 fps while it is the model's intent.
  const track = pointerTracker();
  // A dead-centre return goes straight back and the rival never misses one;
  // the angle comes from where on the paddle the ball lands. Holding the
  // paddle this far to one side of the ball is an off-centre hit on purpose.
  const AIM_OFFSET = HIT_HALF_X * 0.6;
  // Which way to send it is a per-ball read of where the rival stands — too
  // fast and too fiddly for a decision a few times a second, so the reflex
  // makes it. The side only flips once the rival is clearly across the ball,
  // or a rival hovering under it would flip the paddle every frame.
  let aimSide: 1 | -1 = 1;
  const aimAway = (diag: PongDiagnostics) => {
    const rivalOffset = diag.opponent.x - diag.ball.x;
    if (Math.abs(rivalOffset) > HIT_HALF_X / 2) {
      aimSide = rivalOffset > 0 ? 1 : -1;
    }
    return track(diag.ball.x + aimSide * AIM_OFFSET - diag.player.x);
  };
  publishPlaytest<PongDiagnostics>({
    actions: {
      confirm: {
        description:
          'press Space — yes when game.phase is "serving" (it serves), and yes when game.charge.ready is true during a rally (it arms a power shot: your next return is 40% faster). Otherwise no',
        keys: ["Space"],
      },
    },
    goal: "You control the bottom paddle; it follows the pointer's x. A point is won when the rival (top paddle, game.opponent.x) fails to reach your return. `track_ball` returns the ball straight — safe, but the rival always reaches a straight ball, so it never wins a point. To WIN points choose `aim_away`: it returns every ball at an angle, to the side the rival is NOT on. Use `track_ball` only to play safe when game.opponentScore is one point from winning. Every 4 returns game.charge.ready turns true: confirm then, and the next return is a power shot. game.score is your points; game.opponentScore is theirs; first to the target wins.",
    // The court is a few world units wide, not a few hundred pixels.
    minDisplacement: 0.05,
    move: {
      aim_away: {
        description:
          "Follow the ball and return it at an angle, away from wherever the rival is standing — the way to win points (the default for a rally)",
        reflex: (diag) => (diag ? aimAway(diag) : null),
      },
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
        description: "Follow the ball dead-centre — a safe, straight return that wins nothing",
        reflex: (diag) => (diag ? track(diag.ball.x - diag.player.x) : null),
      },
    },
  });
}
if (import.meta.env.DEV) {
  Object.assign(window, {
    __pong: game,
    __pongCamera: handCamera,
    __pongHand: (x: number) => game.handleHandPosition(x),
  });
}
