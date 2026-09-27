import * as THREE from "three";
import { probeWebGL, setPauseHandlers, showWebGLVeil } from "@repo/embed";
import {
  isPlaytestRequested,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";
import type { Reflex, ReflexInputs } from "@vibedgames/playtest";

import { setAudioPaused, unlockAudio } from "./audio/sfx";
import { FaceCamera } from "./input/face-camera";
import type { FaceCameraState } from "./input/face-camera";
import { IS_TOUCH } from "./input/input-mode";
import { pauseOverlay } from "./pause-overlay";
import { GameScene } from "./scenes/game-scene";
import type { GameDiagnostics } from "./scenes/game-scene";
import { MAX_DT, OPPOSITE, TONE_EXPOSURE, TURN_LEFT } from "./shared/constants";
import type { Dir } from "./shared/constants";

const container = document.querySelector("#game");
if (!container) {
  throw new Error("missing #game container");
}

// Touch layouts get the selfie/restart pills and re-docked stats (CSS keys
// off this class); detection is at boot, not after the first touch.
if (IS_TOUCH) {
  document.body.classList.add("touch");
}

const webgl = probeWebGL();
if (!webgl.ok) {
  showWebGLVeil(webgl);
  // Module-level boot has no early return: the uncaught throw logs the reason and stops.
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
}

// Phones share one GPU process across every tab; a 4× multisampled buffer at
// DPR 2 plus soft shadows is the desktop recipe, and on a phone it is the
// allocation that gets the process killed a few seconds after boot. Dense
// screens hide the aliasing the resolve pass would have removed.
const dense = IS_TOUCH && window.devicePixelRatio >= 2;
const renderer = new THREE.WebGLRenderer({
  antialias: !dense,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_TOUCH ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// r3f Canvas defaults the legacy build rendered through, plus a touch of
// extra exposure for the airy cream look.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_EXPOSURE;
// Phone drivers have died under the shadow pass alone; touch devices skip it.
renderer.shadowMap.enabled = !IS_TOUCH;
renderer.shadowMap.type = IS_TOUCH ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
container.append(renderer.domElement);
renderer.domElement.addEventListener("webglcontextlost", () => {
  console.error("WebGL context lost");
  showWebGLVeil(
    { blocked: false, ok: false, reason: "context lost" },
    "The browser stopped the graphics (usually low memory).",
  );
});

const game = new GameScene();

const elOf = <T extends HTMLElement>(id: string, ctor: new () => T): T => {
  const node = document.querySelector(`#${id}`);
  if (!(node instanceof ctor)) {
    throw new Error(`missing #${id}`);
  }
  return node;
};

// First tap/keypress unlocks the synth context and starts the lullaby loop.
// Keeping the listeners around lets a suspended context resume after tab
// switches. Face-only players get sound on their first click anywhere.
window.addEventListener("pointerdown", unlockAudio);
window.addEventListener("keydown", unlockAudio);

// Webcam face control — on denial/failure the panel shows a status line and
// keyboard/touch input keeps working.
const webcamPanel = elOf("webcam", HTMLElement);
const webcamToggle = elOf("webcam-toggle", HTMLButtonElement);
const webcamCue = elOf("webcam-cue", HTMLElement);
let cameraState: FaceCameraState = { kind: "idle" };
const cameraAction = (state: FaceCameraState, collapsed: boolean): string => {
  if (state.kind === "unavailable") {
    return "Retry face camera";
  }
  if (state.kind === "idle") {
    return "Enable face controls";
  }
  return collapsed ? "Expand face camera" : "Collapse face camera";
};
const cameraStatus = (state: FaceCameraState): string => {
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
    default: {
      return "Camera off";
    }
  }
};
const cameraCue = (state: FaceCameraState): string => {
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
    default: {
      return "📷 CAMERA";
    }
  }
};
const renderCameraState = (): void => {
  const collapsed = webcamPanel.classList.contains("collapsed");
  webcamToggle.setAttribute("aria-expanded", String(!collapsed));
  webcamToggle.setAttribute(
    "aria-label",
    `${cameraAction(cameraState, collapsed)}. ${cameraStatus(cameraState)}`,
  );
  webcamCue.textContent = cameraCue(cameraState);
};
const face = new FaceCamera({
  onHeadTurnLeft: () => game.onHeadTurnLeft(),
  onHeadTurnRight: () => game.onHeadTurnRight(),
  onMouthChange: (open) => game.onMouthChange(open),
  onState: (state) => {
    cameraState = state;
    // A dead camera has nothing to preview: fold to the retry pill rather than
    // park a status card over the maze.
    if (state.kind === "unavailable") {
      webcamPanel.classList.add("collapsed");
    }
    renderCameraState();
  },
  overlay: elOf("webcam-overlay", HTMLCanvasElement),
  status: elOf("webcam-status", HTMLElement),
  video: elOf("webcam-video", HTMLVideoElement),
});

// The porthole IS the camera switch: tapping it toggles between the full
// preview and a pill, and opening it starts (or retries) the camera if it
// isn't running. Touch boots collapsed — the full panel blankets the
// lower-right playfield, a phone only grants getUserMedia inside a gesture,
// and a player who never asks for the camera never pays for the 6 MB face
// stack behind it. Desktop keeps the legacy auto-start. Collapsing never
// stops tracking: a hidden <video> still decodes frames.
webcamToggle.addEventListener("click", () => {
  // Keyboard activation never reaches the window unlock listeners (see below).
  unlockAudio();
  if (cameraState.kind === "idle" || cameraState.kind === "unavailable") {
    webcamPanel.classList.remove("collapsed");
    void face.start();
  } else {
    webcamPanel.classList.toggle("collapsed");
  }
  renderCameraState();
});
// Native button activation owns Enter/Space — the window keydown handler
// must not also chomp or start the round.
const sealCameraKey = (event: KeyboardEvent): void => {
  if (event.code === "Space" || event.code === "Enter") {
    event.stopPropagation();
  }
};
webcamToggle.addEventListener("keydown", sealCameraKey);
webcamToggle.addEventListener("keyup", sealCameraKey);
// A playtest browser denies the camera, and the rejection is a console error
// — a failed run for a reason that has nothing to do with the maze.
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

// Wrapper-requested pause: show the game's plush clinic-sign overlay
// (./pause-overlay) and freeze the sim + input. `timer.update` keeps running
// every frame even while paused, so the delta never balloons across the gap —
// resuming needs no explicit reset.
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

// Bot-playtest telemetry (playtest skill contract): one object mutated in place.
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
const pelletStep = (d: PacmanDiagnostics): Dir | null => d.nav?.pellet?.step ?? null;

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), MAX_DT);
  if (!paused) {
    game.update(dt);
    diag.frame += 1;
  }
  renderer.render(game.scene, game.camera);
  diag.paused = paused;
  game.writeDiagnostics(diag);
});

if (import.meta.env.DEV || isPlaytestRequested()) {
  game.enableNavDiagnostics();
  publishTestHooks({
    seed: (seed) => game.seed(seed),
    setPausedForScreenshot: (next) => {
      paused = next;
      game.setPaused(next);
    },
    setState: (name) => (game.setTestState(name) ? { state: name } : undefined),
  });

  // Pac steers RELATIVE to his heading and advances one cell per SPACE keydown,
  // so no held key means "go up". Every move is a reflex that turns a compass
  // direction into the edge presses a player would make: turn until facing it,
  // then chomp once per cell. A press lasts one frame and the next frame
  // releases, because both verbs only fire on the keydown edge.
  let pressedLastFrame = false;
  const press = (keys: string[]): ReflexInputs => {
    if (pressedLastFrame || keys.length === 0) {
      pressedLastFrame = false;
      return { keys: [] };
    }
    pressedLastFrame = true;
    return { keys };
  };
  const stepTowards = (d: PacmanDiagnostics, dir: Dir | null): ReflexInputs => {
    if (dir === null || d.paused || (d.phase !== "playing" && d.phase !== "ready")) {
      return press([]);
    }
    if (d.facing !== dir) {
      if (OPPOSITE[d.facing] === dir) {
        return press(["ArrowDown"]);
      }
      return press([TURN_LEFT[d.facing] === dir ? "ArrowLeft" : "ArrowRight"]);
    }
    // A chomp into a wall or mid-step is dropped by the game; don't spend it.
    return press(d.moving || d.nav?.open[dir] !== true ? [] : ["Space"]);
  };
  const follow =
    (choose: (d: PacmanDiagnostics) => Dir | null): Reflex<PacmanDiagnostics> =>
    (d) =>
      d ? stepTowards(d, choose(d)) : undefined;

  publishPlaytest<PacmanDiagnostics>({
    goal: [
      "Pac-Man in a maze: eat every pellet to win (score +10 each, power hearts +50, frightened ghosts +200). Touching a ghost that is NOT frightened costs one of game.lives; at 0 lives the run is lost.",
      "Coordinates are maze cells: +dx is right, +dy is down. game.nav is what you see from your cell: open.up/down/left/right says which ways are not walls; pellet, power and ghosts[] each give straight-line dx,dy, the real path length in cells as steps, and step, the first direction of the shortest path there. Trust steps and step, not dx/dy: walls bend every route.",
      "Default to eat_pellets. You move 5 cells a second and ghosts 1.5, but your view is a quarter-second old, so react EARLY: when ghosts[0].frightened is false and ghosts[0].steps is 5 or less, choose flee (or grab_power if nav.power.steps is smaller than ghosts[0].steps). Never take a direction equal to ghosts[0].step while that ghost is within 5 steps. game.invulnerable true means ghosts cannot hurt you yet.",
      "While game.powerMs is above 2500 ghosts are frightened and slow: hunt_ghost if ghosts[0].steps is 8 or less, otherwise keep eating. Below 2500 treat them as dangerous again.",
    ].join(" "),
    // One decision is about one cell of travel; pac's coordinates are cells, not pixels.
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

// Synthetic gesture hooks so the face pipeline can be driven without a webcam.
if (import.meta.env.DEV) {
  Object.assign(window, {
    __pacman: {
      chomp: () => {
        game.onMouthChange(true);
        game.onMouthChange(false);
      },
      face,
      game,
      mouth: (open: boolean) => game.onMouthChange(open),
      turnLeft: () => game.onHeadTurnLeft(),
      turnRight: () => game.onHeadTurnRight(),
    },
  });
}
