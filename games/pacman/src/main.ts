import * as THREE from "three";
import { probeWebGL, setPauseHandlers, showWebGLVeil } from "@repo/embed";
import {
  isPlaytestRequested,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";
import type { Reflex } from "@vibedgames/playtest";

import { setAudioPaused, unlockAudio } from "./audio/sfx";
import { FaceCamera } from "./input/face-camera";
import type { FaceCameraState } from "./input/face-camera";
import { IS_TOUCH } from "./input/input-mode";
import { PELLET_CELLS, pelletClaimKey } from "./net/pellet-claims";
import { pauseOverlay } from "./pause-overlay";
import { GameScene } from "./scenes/game-scene";
import type { GameDiagnostics } from "./scenes/game-scene";
import { MAX_DT, OPPOSITE, TONE_EXPOSURE, TURN_LEFT } from "./shared/constants";
import type { Dir } from "./shared/constants";

const container = document.querySelector("#game");

if (!container) {
  throw new Error("missing #game container");
}

if (IS_TOUCH) {
  document.body.classList.add("touch");
}

const webgl = probeWebGL();

if (!webgl.ok) {
  showWebGLVeil(webgl);
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
}

const dense = IS_TOUCH && window.devicePixelRatio >= 2;

const renderer = new THREE.WebGLRenderer({
  antialias: !dense,
  powerPreference: "high-performance",
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.5 : 2));

renderer.setSize(window.innerWidth, window.innerHeight);

renderer.toneMapping = THREE.ACESFilmicToneMapping;

renderer.toneMappingExposure = TONE_EXPOSURE;

renderer.shadowMap.enabled = !IS_TOUCH;

renderer.shadowMap.type = THREE.PCFShadowMap;

container.append(renderer.domElement);

renderer.domElement.addEventListener("webglcontextlost", () => {
  console.error("WebGL context lost");
  showWebGLVeil(
    { blocked: false, ok: false, reason: "context lost" },
    "The browser stopped the graphics (usually low memory).",
  );
});

const game = new GameScene();

const elOf = <T extends HTMLElement>(id: string, ctor: new () => T) => {
  const node = document.querySelector(`#${id}`);

  if (!(node instanceof ctor)) {
    throw new TypeError(`missing #${id}`);
  }

  return node;
};

window.addEventListener("pointerdown", unlockAudio);

window.addEventListener("keydown", unlockAudio);

const webcamPanel = elOf("webcam", HTMLElement);
const webcamToggle = elOf("webcam-toggle", HTMLButtonElement);
const webcamCue = elOf("webcam-cue", HTMLElement);
let cameraState: FaceCameraState = { kind: "idle" };

const cameraAction = (state: FaceCameraState, collapsed: boolean) => {
  if (state.kind === "unavailable") {
    return "Retry face camera";
  }

  if (state.kind === "idle") {
    return "Enable face controls";
  }

  return collapsed ? "Expand face camera" : "Collapse face camera";
};

const cameraStatus = (state: FaceCameraState) => {
  switch (state.kind) {
    case "starting": {
      return "Starting camera";
    }

    case "live": {
      return state.tracking ? "Face ready" : "Find your face";
    }

    case "unavailable": {
      return "Camera unavailable";
    }

    case "idle": {
      return "Camera off";
    }

    default: {
      const unhandled: never = state;
      throw new Error("unknown camera state", { cause: unhandled });
    }
  }
};

const cameraCue = (state: FaceCameraState) => {
  switch (state.kind) {
    case "unavailable": {
      return "📷 RETRY";
    }

    case "starting": {
      return "📷 STARTING";
    }

    case "live": {
      return state.tracking ? "📷 FACE READY" : "📷 FIND FACE";
    }

    case "idle": {
      return "📷 CAMERA";
    }

    default: {
      const unhandled: never = state;
      throw new Error("unknown camera state", { cause: unhandled });
    }
  }
};

const renderCameraState = () => {
  const collapsed = webcamPanel.classList.contains("collapsed");
  webcamToggle.setAttribute("aria-expanded", String(!collapsed));
  webcamToggle.setAttribute(
    "aria-label",
    `${cameraAction(cameraState, collapsed)}. ${cameraStatus(cameraState)}`,
  );
  webcamCue.textContent = cameraCue(cameraState);
};

const face = new FaceCamera({
  onHeadTurnLeft: () => {
    game.onHeadTurnLeft();
  },
  onHeadTurnRight: () => {
    game.onHeadTurnRight();
  },
  onMouthChange: (open) => {
    game.onMouthChange(open);
  },
  onState: (state) => {
    cameraState = state;

    if (state.kind === "unavailable") {
      webcamPanel.classList.add("collapsed");
    }

    renderCameraState();
  },
  overlay: elOf("webcam-overlay", HTMLCanvasElement),
  status: elOf("webcam-status", HTMLElement),
  video: elOf("webcam-video", HTMLVideoElement),
});

webcamToggle.addEventListener("click", () => {
  unlockAudio();

  if (cameraState.kind === "idle" || cameraState.kind === "unavailable") {
    webcamPanel.classList.remove("collapsed");
    void face.start();
  } else {
    webcamPanel.classList.toggle("collapsed");
  }

  renderCameraState();
});

const sealCameraKey = (event: KeyboardEvent) => {
  if (event.code === "Space" || event.code === "Enter") {
    event.stopPropagation();
  }
};

webcamToggle.addEventListener("keydown", sealCameraKey);

webcamToggle.addEventListener("keyup", sealCameraKey);

if (IS_TOUCH || isPlaytestRequested()) {
  webcamPanel.classList.add("collapsed");
} else {
  void face.start();
}

renderCameraState();

window.addEventListener("resize", () => {
  game.resize(window.innerWidth / window.innerHeight);
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let paused = false;

setPauseHandlers({
  onPause: () => {
    pauseOverlay.show();
    paused = true;
    game.setPaused(true);
    face.setActionsPaused(true);
    setAudioPaused(true);
  },
  onResume: () => {
    pauseOverlay.hide();
    paused = false;
    game.setPaused(false);
    face.setActionsPaused(false);
    setAudioPaused(false);
  },
});

type PacmanDiagnostics = GameDiagnostics & { frame: number; paused: boolean };

const diag: PacmanDiagnostics = {
  complete: false,
  entities: 0,
  facing: "right",
  frame: 0,
  invulnerable: false,
  lives: 0,
  moving: false,
  nav: null,
  paused: false,
  pelletsLeft: 0,
  phase: "title",
  player: { x: 0, y: 0 },
  powerMs: 0,
  score: 0,
};

publishDiagnostics(() => diag);

const pelletStep = (d: PacmanDiagnostics) => d.nav?.pellet?.step ?? null;

const timer = new THREE.Timer();

renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), MAX_DT);

  if (!paused) {
    game.update(dt);
    diag.frame += 1;
  }

  game.updateNet(dt);
  renderer.render(game.scene, game.camera);
  diag.paused = paused;
  game.writeDiagnostics(diag);
});

if (import.meta.env.DEV || isPlaytestRequested()) {
  game.enableNavDiagnostics();
  publishTestHooks({
    seed: (seed) => {
      game.seed(seed);
    },
    setPausedForScreenshot: (next) => {
      paused = next;
      game.setPaused(next);
    },
    setState: (name) => (game.setTestState(name) ? { state: name } : undefined),
  });

  let pressedLastFrame = false;

  const press = (keys: string[]) => {
    if (pressedLastFrame || keys.length === 0) {
      pressedLastFrame = false;

      return { keys: [] };
    }

    pressedLastFrame = true;

    return { keys };
  };

  const stepTowards = (d: PacmanDiagnostics, dir: Dir | null) => {
    if (dir === null || d.paused || (d.phase !== "playing" && d.phase !== "ready")) {
      return press([]);
    }

    if (d.facing !== dir) {
      if (OPPOSITE[d.facing] === dir) {
        return press(["ArrowDown"]);
      }

      return press([TURN_LEFT[d.facing] === dir ? "ArrowLeft" : "ArrowRight"]);
    }

    return press(d.moving || d.nav?.open[dir] !== true ? [] : ["Space"]);
  };

  const follow: (choose: (d: PacmanDiagnostics) => Dir | null) => Reflex<PacmanDiagnostics> =
    (choose) => (d) =>
      d ? stepTowards(d, choose(d)) : undefined;

  publishPlaytest<PacmanDiagnostics>({
    goal: [
      "Pac-Man in a maze: eat every pellet to win (score +10 each, power hearts +50, frightened ghosts +200). Touching a ghost that is NOT frightened costs one of game.lives; at 0 lives the run is lost.",
      "Coordinates are maze cells: +dx is right, +dy is down. game.nav is what you see from your cell: open.up/down/left/right says which ways are not walls; pellet, power and ghosts[] each give straight-line dx,dy, the real path length in cells as steps, and step, the first direction of the shortest path there. Trust steps and step, not dx/dy: walls bend every route.",
      "Default to eat_pellets. You move 5 cells a second and ghosts 1.5, but your view is a quarter-second old, so react EARLY: when ghosts[0].frightened is false and ghosts[0].steps is 5 or less, choose flee (or grab_power if nav.power.steps is smaller than ghosts[0].steps). Never take a direction equal to ghosts[0].step while that ghost is within 5 steps. game.invulnerable true means ghosts cannot hurt you yet.",
      "While game.powerMs is above 2500 ghosts are frightened and slow: hunt_ghost if ghosts[0].steps is 8 or less, otherwise keep eating. Below 2500 treat them as dangerous again.",
    ].join(" "),
    minDisplacement: 0.5,
    move: {
      down: {
        description: "Step down (+dy) — only if nav.open.down",
        reflex: follow(() => "down"),
      },
      eat_pellets: {
        description:
          "Walk the shortest path to the nearest pellet, cell after cell (the default when no dangerous ghost is within 5 steps)",
        reflex: follow(pelletStep),
      },
      flee: {
        description:
          "Keep eating, but only along routes the ghosts cannot cut off, retreating when none is left — choose it as soon as a dangerous ghost is within 5 steps",
        reflex: follow((d) => d.nav?.fleeStep ?? pelletStep(d)),
      },
      grab_power: {
        description:
          "Walk the shortest path to the nearest power heart, which frightens every ghost for 10 s (eats pellets instead if no heart is left)",
        reflex: follow((d) => d.nav?.power?.step ?? pelletStep(d)),
      },
      hunt_ghost: {
        description:
          "Chase the nearest ghost to eat it for +200 — only while ghosts are frightened with powerMs above 2500 (eats pellets instead if none is frightened)",
        reflex: follow((d) => d.nav?.ghosts.find((g) => g.frightened)?.step ?? pelletStep(d)),
      },
      left: {
        description: "Step left (-dx) — only if nav.open.left",
        reflex: follow(() => "left"),
      },
      right: {
        description: "Step right (+dx) — only if nav.open.right",
        reflex: follow(() => "right"),
      },
      up: { description: "Step up (-dy) — only if nav.open.up", reflex: follow(() => "up") },
    },
  });
}

const devHooks = () => ({
  cells: PELLET_CELLS,
  chomp: () => {
    game.onMouthChange(true);
    game.onMouthChange(false);
  },
  claimKey: pelletClaimKey,
  face,
  game,
  mouth: (open: boolean) => {
    game.onMouthChange(open);
  },
  turnLeft: () => {
    game.onHeadTurnLeft();
  },
  turnRight: () => {
    game.onHeadTurnRight();
  },
});

declare global {
  interface Window {
    /** DEV-only hooks tools/two-client.mts drives. */
    __pacman?: ReturnType<typeof devHooks>;
  }
}

if (import.meta.env.DEV) {
  window.__pacman = devHooks();
}
