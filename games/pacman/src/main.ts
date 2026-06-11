import * as THREE from "three";

import { FaceCamera } from "./input/face-camera";
import { GameScene } from "./scenes/game-scene";
import { MAX_DT } from "./shared/constants";

const container = document.getElementById("game");
if (!container) throw new Error("missing #game container");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// r3f Canvas defaults the legacy build rendered through.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const game = new GameScene();

// Webcam face control — auto-starts like the legacy build; on denial/failure
// the panel shows a status line and keyboard input keeps working.
const face = new FaceCamera({
  video: elOf("webcam-video", HTMLVideoElement),
  overlay: elOf("webcam-overlay", HTMLCanvasElement),
  status: elOf("webcam-status", HTMLElement),
  onMouthChange: (open) => game.onMouthChange(open),
  onHeadTurnLeft: () => game.onHeadTurnLeft(),
  onHeadTurnRight: () => game.onHeadTurnRight(),
});
void face.start();

window.addEventListener("resize", () => {
  game.resize(window.innerWidth / window.innerHeight);
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), MAX_DT);
  game.update(dt);
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
