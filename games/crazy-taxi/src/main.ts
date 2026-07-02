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

if (import.meta.env.DEV) {
  void import("./debug/dev-hooks").then(({ installDevHooks }) => installDevHooks(game));
}

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

const loaded = game.load();

// Map editor: open with ?editor=1, place assets, export JSON for
// world/custom-props.ts. Lazy chunk — costs nothing on normal loads.
if (new URLSearchParams(window.location.search).has("editor")) {
  void Promise.all([import("./editor/map-editor"), loaded]).then(([{ startEditor }]) =>
    startEditor(game, renderer),
  );
}
