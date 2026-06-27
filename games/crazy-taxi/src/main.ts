import * as THREE from "three";

import { GameScene } from "./scenes/game-scene";
import { MAX_DT } from "./shared/constants";

const container = document.getElementById("game");
if (!container) throw new Error("missing #game container");

function showFatal(message: string): void {
  const loading = document.getElementById("loading");
  if (loading) {
    loading.innerHTML = `<div class="lt">CRAZY TAXI</div><div class="ls" style="opacity:1;color:#ff8a8a">${message}</div>`;
  }
}

let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
} catch (err) {
  console.error("[crazy-taxi] WebGL init failed", err);
  showFatal("WebGL unavailable — try a different browser or enable hardware acceleration.");
  throw err instanceof Error ? err : new Error("WebGL init failed");
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.62;
container.appendChild(renderer.domElement);

const game = new GameScene(window.innerWidth / window.innerHeight);
game.applyEnvironment(renderer);

function renderHeightPx(): number {
  return window.innerHeight * renderer.getPixelRatio();
}
game.resize(window.innerWidth / window.innerHeight, renderHeightPx());

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  game.resize(window.innerWidth / window.innerHeight, renderHeightPx());
});

const timer = new THREE.Timer();
renderer.setAnimationLoop((t) => {
  timer.update(t);
  const dt = Math.min(timer.getDelta(), MAX_DT);
  game.update(dt);
  renderer.render(game.scene, game.camera);
});

void game.load();

if (import.meta.env.DEV) {
  Object.assign(window, {
    __game: game,
    __start: () => game.debugStart(),
    __set: (btn: "gas" | "brake" | "left" | "right" | "drift", down: boolean) =>
      game.debugSet(btn, down),
    __info: () => game.debugInfo,
    __freeze: (b: boolean) => game.debugFreezeTime(b),
    __warp: () => game.debugWarpToObjective(),
    __obj: () => game.debugObjective(),
    __top: (on: boolean) => game.debugTopView(on),
    __cam: (px: number, py: number, pz: number, lx: number, ly: number, lz: number) =>
      game.debugSetCam(px, py, pz, lx, ly, lz),
    __tp: (x: number, z: number) => game.debugTeleport(x, z),
    __rack: () => game.debugTileRack(),
  });
}
