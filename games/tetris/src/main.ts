import { isPausable, pauseGame, probeWebGL, setPauseHandlers, showWebGLVeil } from "@repo/embed";
import {
  isPlaytestRequested,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";
import * as THREE from "three";

import { setSoundPaused } from "./fx/sfx";
import { PoseCamera } from "./input/camera";
import { PoseControls } from "./input/pose-control";
import { isCoarsePointer } from "./input/touch";
import * as pauseOverlay from "./pause-overlay";
import { playtestManifest } from "./playtest";
import type { PlaytestDiagnostics } from "./playtest";
import { GameScene } from "./scenes/game-scene";
import { MAX_DT } from "./shared/constants";

const container = document.querySelector("#game");

if (!container) {
  throw new Error("missing #game container");
}

container.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

const webgl = probeWebGL();

if (!webgl.ok) {
  showWebGLVeil(webgl);
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
}

const dense = isCoarsePointer() && window.devicePixelRatio >= 2;

const renderer = new THREE.WebGLRenderer({
  antialias: !dense,
  powerPreference: "high-performance",
});

const dprCap = isCoarsePointer() ? 1.5 : 2;

const applyPixelRatio = () => {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap));
};

applyPixelRatio();

renderer.setSize(window.innerWidth, window.innerHeight);

renderer.outputColorSpace = THREE.SRGBColorSpace;

container.append(renderer.domElement);

const game = new GameScene(window.innerWidth / window.innerHeight);

const poseControls = new PoseControls(game.poseActions);

game.attachPoseControls(poseControls);

const poseCamera = new PoseCamera(poseControls.handlePose);

if (!isCoarsePointer() && !isPlaytestRequested()) {
  void poseCamera.start();
}

const resize = () => {
  game.resize(window.innerWidth / window.innerHeight);
  applyPixelRatio();
  renderer.setSize(window.innerWidth, window.innerHeight);
};

window.addEventListener("resize", resize);

let wrapperPausedAt: number | null = null;

const pausePresentation = () => {
  if (wrapperPausedAt !== null) {
    return;
  }

  wrapperPausedAt = performance.now();
  game.releaseInputs();
  poseControls.setActionsPaused(true);
  setSoundPaused(true);
};

const resumePresentation = () => {
  if (wrapperPausedAt === null) {
    return;
  }

  game.shiftWallClock(performance.now() - wrapperPausedAt);
  wrapperPausedAt = null;
  game.releaseInputs();
  poseControls.setActionsPaused(false);
  setSoundPaused(false);
};

type Graphics = { kind: "ready" } | { kind: "lost"; returnTo: "pause" | "title" };

let graphics: Graphics = { kind: "ready" };

setPauseHandlers({
  canResume: () => graphics.kind === "ready",
  onPause: () => {
    pausePresentation();

    if (graphics.kind === "ready") {
      pauseOverlay.show();
    }
  },
  onResume: () => {
    resumePresentation();
    pauseOverlay.hide();
  },
});

renderer.domElement.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();

  if (graphics.kind === "lost") {
    return;
  }

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
  if (graphics.kind === "ready") {
    return;
  }

  const { returnTo } = graphics;
  graphics = { kind: "ready" };
  resize();
  pauseOverlay.hideRecovery();

  if (returnTo === "pause") {
    pauseOverlay.show();
  } else {
    resumePresentation();
  }
});

let frozenForScreenshot = false;

const timer = new THREE.Timer();

renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), MAX_DT);

  if (wrapperPausedAt === null && !frozenForScreenshot) {
    game.update(dt);
  }

  if (graphics.kind === "ready") {
    renderer.render(game.scene, game.camera);
  }
});

publishDiagnostics(
  () =>
    ({
      ...game.diagnostics(),
      paused: wrapperPausedAt !== null,
    }) satisfies PlaytestDiagnostics,
);

if (import.meta.env.DEV || isPlaytestRequested()) {
  publishTestHooks({
    seed: (seed) => {
      game.seed(seed);
    },
    setPausedForScreenshot: (paused) => {
      frozenForScreenshot = paused;
    },
    setState: (name) => (game.setTestState(name) ? { state: name } : undefined),
  });
  publishPlaytest(playtestManifest);
}

if (import.meta.env.DEV) {
  Object.assign(window, { __camera: poseCamera, __pose: poseControls, __tetris: game });
}
