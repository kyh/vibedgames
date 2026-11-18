import * as THREE from "three";
import {
  createTouchControls,
  isPausable,
  isPlayables,
  isSystemPaused,
  markGameReady,
  pauseGame,
  playablesAudio,
  probeWebGL,
  setPauseHandlers,
  showWebGLVeil,
  watchSystemPause,
} from "@repo/embed";
import {
  isPlaytestRequested,
  pointerTracker,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";

import { followSystemAudio, isMuted, resumeSound, setMuted, setSoundPaused } from "./fx/sfx";
import { createHandCamera } from "./input/camera";
import type { HandCamera } from "./input/camera";
import { createPongPauseOverlay } from "./pause-overlay";
import { DitherPass } from "./render/dither-pass";
import { GameScene } from "./scenes/game-scene";
import { DITHER_PIXEL, HIT_HALF_X, MAX_FRAME_DT } from "./shared/constants";
import { COARSE_INPUT } from "./shared/input-mode";

const container = document.querySelector("#game");

if (!container) {
  throw new Error("missing #game container");
}

const webgl = probeWebGL();

if (!webgl.ok) {
  showWebGLVeil(webgl);
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
}

const renderer = new THREE.WebGLRenderer({ antialias: false });

renderer.info.autoReset = false;

const applyPixelRatio = () => {
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

for (const event of ["pointerdown", "keydown"]) {
  window.addEventListener(event, resumeSound, { capture: true });
}

const game = new GameScene();
const dither = new DitherPass(window.innerWidth, window.innerHeight);

const systemAudio = playablesAudio();

if (systemAudio !== null) {
  followSystemAudio(systemAudio.enabled());
  systemAudio.watch(followSystemAudio);
}

const pauseOverlay = createPongPauseOverlay(
  () => game.hasLiveOpponent(),
  systemAudio === null ? { get: isMuted, set: setMuted } : undefined,
);

let playerPaused = false;

setPauseHandlers({
  onPause: () => {
    playerPaused = true;
    game.requestPause();
    setSoundPaused(true);
    pauseOverlay.show();
  },
  onResume: () => {
    playerPaused = false;
    pauseOverlay.hide();
    game.requestResume();
    setSoundPaused(false);
  },
});

createTouchControls();

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    if (e.target instanceof HTMLElement && e.target.closest("button")) {
      return;
    }

    e.preventDefault();

    if (!e.repeat) {
      game.handleGestureConfirm();
    }
  } else if (e.code === "KeyM" && !e.repeat && systemAudio === null) {
    setMuted(!isMuted());
  }
});

const handCamera = isPlayables()
  ? null
  : createHandCamera(
      (x) => game.handleHandPosition(x),
      () => game.handleGestureConfirm(),
    );

if (handCamera !== null && !COARSE_INPUT && !isPlaytestRequested() && !navigator.webdriver) {
  window.addEventListener("load", () => handCamera.enable(), { once: true });
}

watchSystemPause((paused) => {
  if (paused && isPausable()) {
    pauseGame();
  }

  setSoundPaused(paused || playerPaused);
});

window.addEventListener("resize", () => {
  game.resize(window.innerWidth / window.innerHeight);
  applyPixelRatio();
  renderer.setSize(window.innerWidth, window.innerHeight);
  dither.setSize(window.innerWidth, window.innerHeight);
});

const timer = new THREE.Timer();

renderer.setAnimationLoop((time) => {
  timer.update(time);

  if (isSystemPaused()) {
    return;
  }

  const dt = Math.min(timer.getDelta(), MAX_FRAME_DT);
  game.update(dt);
  renderer.info.reset();
  dither.setInverted(game.isScreenInverted());
  dither.render(renderer, game.scene, game.camera);
  markGameReady();
});

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

publishDiagnostics(() => ({
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
  const track = pointerTracker();
  const AIM_OFFSET = HIT_HALF_X * 0.6;
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
    goal: "You control the bottom paddle; it follows the pointer's x. A point is won when the rival (top paddle, game.opponent.x) fails to reach your return. `track_ball` returns the ball straight — safe, but the rival always reaches a straight ball, so it never wins a point. To WIN points choose `aim_away`: it returns every ball at an angle, to the side the rival is NOT on. Use `track_ball` only to play safe when game.opponentScore is one point from winning. Every 4 returns game.charge.ready turns true: confirm then, and the next return is a power shot. game.points is your points and game.opponentScore is theirs; game.score is 10 per point plus 1 per ball you return; first to the target wins.",
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
