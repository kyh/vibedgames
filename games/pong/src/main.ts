import * as THREE from "three";

import { startHandTracking } from "./input/camera";
import { GameScene } from "./scenes/GameScene";
import { MAX_DT } from "./shared/constants";

const container = document.getElementById("game");
if (!container) throw new Error("missing #game container");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

const game = new GameScene();

// Webcam hand tracking auto-starts (legacy semantics — no start button);
// on failure it shows a status in its panel and pointer/keys keep working.
const handTracker = startHandTracking((x) => game.handleHandPosition(x));

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

if (import.meta.env.DEV) {
  // __pongHand(x): drive the gesture→paddle path synthetically (x ∈ [0,1]).
  Object.assign(window, {
    __pong: game,
    __pongHand: (x: number) => game.handleHandPosition(x),
    __pongCamera: handTracker,
  });
}
