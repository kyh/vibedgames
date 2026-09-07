import * as THREE from "three";
import { setPauseHandlers } from "@repo/embed";

import { disposeAudio, setAudioPaused, unlockAudio } from "./audio/sfx";
import { FaceCamera, type FaceCameraState } from "./input/face-camera";
import { IS_TOUCH } from "./input/input-mode";
import { pauseOverlay } from "./pause-overlay";
import { GameScene } from "./scenes/game-scene";
import { MAX_DT, TONE_EXPOSURE } from "./shared/constants";

const container = document.getElementById("game");
if (!container) throw new Error("missing #game container");

// Touch layouts get the selfie/restart pills and re-docked stats (CSS keys
// off this class); detection is at boot, not after the first touch.
if (IS_TOUCH) document.body.classList.add("touch");

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// r3f Canvas defaults the legacy build rendered through, plus a touch of
// extra exposure for the airy cream look.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_EXPOSURE;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const game = new GameScene();
let disposed = false;

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
let cameraState: Readonly<FaceCameraState> = { kind: "idle" };
const renderCameraState = (): void => {
  const collapsed = webcamPanel.classList.contains("collapsed");
  webcamToggle.setAttribute("aria-expanded", String(!collapsed));
  webcamToggle.disabled = disposed;
  const action =
    cameraState.kind === "unavailable"
      ? "Retry face camera"
      : cameraState.kind === "idle"
        ? "Enable face controls"
        : collapsed
          ? "Expand face camera"
          : "Collapse face camera";
  const status =
    cameraState.kind === "starting"
      ? "Starting camera"
      : cameraState.kind === "live"
        ? cameraState.tracking
          ? "Face ready"
          : "Find your face"
        : cameraState.kind === "unavailable"
          ? "Camera unavailable"
          : "Camera off";
  webcamToggle.setAttribute("aria-label", `${action}. ${status}`);
  webcamCue.textContent =
    cameraState.kind === "unavailable"
      ? "📷 RETRY"
      : cameraState.kind === "starting"
        ? "📷 STARTING"
        : cameraState.kind === "live"
          ? cameraState.tracking
            ? "📷 FACE READY"
            : "📷 FIND FACE"
          : "📷 CAMERA";
};
const face = new FaceCamera({
  video: elOf("webcam-video", HTMLVideoElement),
  overlay: elOf("webcam-overlay", HTMLCanvasElement),
  status: elOf("webcam-status", HTMLElement),
  onMouthChange: (open) => game.onMouthChange(open),
  onHeadTurnLeft: () => game.onHeadTurnLeft(),
  onHeadTurnRight: () => game.onHeadTurnRight(),
  onState: (state) => {
    cameraState = state;
    renderCameraState();
  },
});

// The porthole IS the camera switch: tapping it toggles between the full
// preview and a pill, and opening it starts the camera if it never ran.
// Touch boots collapsed — the full panel blankets the lower-right playfield,
// a phone only grants getUserMedia inside a gesture, and a player who never
// asks for the camera never pays for the 6 MB face stack behind it. Desktop
// keeps the legacy auto-start. Collapsing never stops tracking: a hidden
// <video> still decodes frames.
const onCameraClick = (event: MouseEvent): void => {
  event.stopPropagation();
  if (disposed) return;
  unlockAudio();
  if (cameraState.kind === "idle" || cameraState.kind === "unavailable") {
    webcamPanel.classList.remove("collapsed");
    void face.start();
  } else webcamPanel.classList.toggle("collapsed");
  renderCameraState();
};
// Native button activation owns Enter/Space without also starting or chomping.
const sealCameraKey = (event: KeyboardEvent): void => {
  if (event.code === "Space" || event.code === "Enter") event.stopPropagation();
};
webcamToggle.addEventListener("click", onCameraClick);
webcamToggle.addEventListener("keydown", sealCameraKey);
webcamToggle.addEventListener("keyup", sealCameraKey);
if (IS_TOUCH) webcamPanel.classList.add("collapsed");
else void face.start();
renderCameraState();

const resize = (): void => {
  if (disposed) return;
  game.resize(window.innerWidth / window.innerHeight);
  renderer.setSize(window.innerWidth, window.innerHeight);
};
window.addEventListener("resize", resize);

// Wrapper-requested pause: show the game's plush clinic-sign overlay
// (./pause-overlay) and freeze the sim. `timer.update` keeps running every
// frame even while paused, so the delta never balloons across the gap —
// resuming needs no explicit reset.
let paused = false;
setPauseHandlers({
  onPause: () => {
    if (disposed) return;
    pauseOverlay.show();
    paused = true;
    game.setPresentationPaused(true);
    face.setActionsPaused(true);
    setAudioPaused(true);
  },
  onResume: () => {
    if (disposed) return;
    pauseOverlay.hide();
    paused = false;
    game.setPresentationPaused(false);
    face.setActionsPaused(false);
    setAudioPaused(false);
  },
});

const timer = new THREE.Timer();
let frame = 0;
renderer.setAnimationLoop((time) => {
  if (disposed) return;
  timer.update(time);
  const dt = Math.min(timer.getDelta(), MAX_DT);
  if (!paused) {
    game.update(dt);
    frame++;
  }
  renderer.render(game.scene, game.camera);
  Object.assign(window, { __GAME_DIAGNOSTICS__: { frame, paused, ...game.diagnostics() } });
});

function dispose(): void {
  if (disposed) return;
  disposed = true;
  renderer.setAnimationLoop(null);
  window.removeEventListener("pointerdown", unlockAudio);
  window.removeEventListener("keydown", unlockAudio);
  window.removeEventListener("resize", resize);
  webcamToggle.removeEventListener("click", onCameraClick);
  webcamToggle.removeEventListener("keydown", sealCameraKey);
  webcamToggle.removeEventListener("keyup", sealCameraKey);
  setPauseHandlers({});
  pauseOverlay.hide();
  face.dispose();
  webcamPanel.hidden = true;
  game.dispose();
  disposeAudio();
  timer.dispose();
  renderer.dispose();
  renderer.domElement.remove();
}

import.meta.hot?.dispose(dispose);

// Synthetic gesture hooks so the face pipeline can be driven without a webcam.
if (import.meta.env.DEV) {
  Object.assign(window, {
    __pacman: {
      game,
      face,
      renderer,
      mouth: (open: boolean) => game.onMouthChange(open),
      chomp: () => {
        game.onMouthChange(true);
        game.onMouthChange(false);
      },
      turnLeft: () => game.onHeadTurnLeft(),
      turnRight: () => game.onHeadTurnRight(),
    },
    __pacmanDispose: dispose,
  });
}

function elOf<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof ctor)) throw new Error(`missing #${id}`);
  return node;
}
