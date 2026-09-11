import * as THREE from "three";
import { probeWebGL, setPauseHandlers, showWebGLVeil } from "@repo/embed";

import { setAudioPaused, unlockAudio } from "./audio/sfx";
import { FaceCamera } from "./input/face-camera";
import type { FaceCameraState } from "./input/face-camera";
import { IS_TOUCH } from "./input/input-mode";
import { pauseOverlay } from "./pause-overlay";
import { GameScene } from "./scenes/game-scene";
import type { GameDiagnostics } from "./scenes/game-scene";
import { MAX_DT, TONE_EXPOSURE } from "./shared/constants";

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
renderer.shadowMap.enabled = true;
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
if (IS_TOUCH) {
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
const diag: GameDiagnostics & { frame: number; paused: boolean } = {
  complete: false,
  entities: 0,
  frame: 0,
  paused: false,
  phase: "title",
  player: { x: 0, y: 0 },
  powerMs: 0,
  score: 0,
};
Reflect.set(globalThis, "__GAME_DIAGNOSTICS__", diag);

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
