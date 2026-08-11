import * as THREE from "three";
import { setPauseHandlers } from "@repo/embed";

import { music, unlockAudio } from "./audio/sfx";
import { FaceCamera } from "./input/face-camera";
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

// First tap/keypress unlocks the synth context and starts the lullaby loop.
// Keeping the listeners around lets a suspended context resume after tab
// switches. Face-only players get sound on their first click anywhere.
window.addEventListener("pointerdown", unlockAudio);
window.addEventListener("keydown", unlockAudio);

// Webcam face control — on denial/failure the panel shows a status line and
// keyboard/touch input keeps working.
const face = new FaceCamera({
  video: elOf("webcam-video", HTMLVideoElement),
  overlay: elOf("webcam-overlay", HTMLCanvasElement),
  status: elOf("webcam-status", HTMLElement),
  onMouthChange: (open) => game.onMouthChange(open),
  onHeadTurnLeft: () => game.onHeadTurnLeft(),
  onHeadTurnRight: () => game.onHeadTurnRight(),
});

// The porthole IS the camera switch: tapping it toggles between the full
// preview and a pill, and opening it starts the camera if it never ran.
// Touch boots collapsed — the full panel blankets the lower-right playfield,
// a phone only grants getUserMedia inside a gesture, and a player who never
// asks for the camera never pays for the 6 MB face stack behind it. Desktop
// keeps the legacy auto-start. Collapsing never stops tracking: a hidden
// <video> still decodes frames.
const webcamPanel = elOf("webcam", HTMLElement);
webcamPanel.addEventListener("click", () => {
  if (!webcamPanel.classList.toggle("collapsed")) void face.start();
});
if (IS_TOUCH) webcamPanel.classList.add("collapsed");
else void face.start();

window.addEventListener("resize", () => {
  game.resize(window.innerWidth / window.innerHeight);
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Wrapper-requested pause: show the game's plush clinic-sign overlay
// (./pause-overlay) and freeze the sim. `timer.update` keeps running every
// frame even while paused, so the delta never balloons across the gap —
// resuming needs no explicit reset.
let paused = false;
setPauseHandlers({
  onPause: () => {
    pauseOverlay.show();
    paused = true;
    music.pause();
  },
  onResume: () => {
    pauseOverlay.hide();
    paused = false;
    music.resume();
  },
});

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), MAX_DT);
  if (!paused) game.update(dt);
  renderer.render(game.scene, game.camera);
});

// Synthetic gesture hooks so the face pipeline can be driven without a webcam.
if (import.meta.env.DEV) {
  Object.assign(window, {
    __pacman: {
      game,
      face,
      mouth: (open: boolean) => game.onMouthChange(open),
      chomp: () => {
        game.onMouthChange(true);
        game.onMouthChange(false);
      },
      turnLeft: () => game.onHeadTurnLeft(),
      turnRight: () => game.onHeadTurnRight(),
    },
  });
}

function elOf<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof ctor)) throw new Error(`missing #${id}`);
  return node;
}
