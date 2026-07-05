import * as THREE from "three";

import { PerfGovernor } from "./render/perf-governor";
import { GameScene } from "./scenes/game-scene";
import { MAX_DT } from "./shared/constants";

const container = document.getElementById("game");
if (!container) throw new Error("missing #game container");

function showFatal(message: string): void {
  const loading = document.getElementById("loading");
  if (loading) {
    loading.innerHTML = `<div class="lt">CRAZY WAYMO</div><div class="ls" style="opacity:1;color:#ff8a8a">${message}</div>`;
  }
}

let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
} catch (err) {
  console.error("[crazy-waymo] WebGL init failed", err);
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
  Object.assign(window, { __renderer: renderer, __waymo: game });
}

function renderHeightPx(): number {
  return window.innerHeight * renderer.getPixelRatio();
}
game.resize(window.innerWidth / window.innerHeight, renderHeightPx());

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  game.resize(window.innerWidth / window.innerHeight, renderHeightPx());
});

// Adaptive quality: steps pixel ratio (and shadow size at the floor) to hold
// frame rate on slower GPUs. Feeds on RAW deltas — the clamped game dt hides
// exactly the slowness it needs to see.
const governor = new PerfGovernor(renderer, game.sunLight, () => {
  game.resize(window.innerWidth / window.innerHeight, renderHeightPx());
});

// Shadow scoping: at the governor's lower tiers the shadow map re-renders
// every OTHER frame — the light follows the car smoothly enough that a
// half-rate shadow is invisible, and it returns a full shadow pass of GPU
// time exactly when the machine needs it.
renderer.shadowMap.autoUpdate = false;
let frameParity = false;

const timer = new THREE.Timer();
renderer.setAnimationLoop((t) => {
  timer.update(t);
  const raw = timer.getDelta();
  governor.update(raw);
  const dt = Math.min(raw, MAX_DT);
  game.update(dt);
  frameParity = !frameParity;
  renderer.shadowMap.needsUpdate =
    governor.consumeShadowInvalidate() ||
    (game.shadowsActive && (governor.currentTier < 2 || frameParity));
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
