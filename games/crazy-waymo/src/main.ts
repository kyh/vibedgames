import * as THREE from "three";

import { PerfGovernor } from "./render/perf-governor";
import { isCoarsePointer } from "./render/quality";
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

// MSAA can't be changed after context creation. On dense phone screens the
// subpixel density plus the sub-native render ratio the governor picks hide
// the aliasing, and skipping the resolve pass buys real GPU time. Desktop
// keeps MSAA exactly as before.
const msaa = !(isCoarsePointer() && (window.devicePixelRatio || 1) >= 2);
let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: msaa, powerPreference: "high-performance" });
} catch (err) {
  console.error("[crazy-waymo] WebGL init failed", err);
  showFatal("WebGL unavailable — try a different browser or enable hardware acceleration.");
  throw err instanceof Error ? err : new Error("WebGL init failed");
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// three r184 removed PCFSoft (coerces it to PCF with a deprecation warn at
// the first shadow render) — ask for PCF directly. Identical output.
renderer.shadowMap.type = THREE.PCFShadowMap;
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

// Adaptive quality: steps pixel ratio (and, on mobile, a feature tier —
// shadows/sky/clouds) to hold frame rate on slower GPUs. Feeds on RAW deltas
// — the clamped game dt hides exactly the slowness it needs to see.
const governor = new PerfGovernor(renderer, game.sunLight, (features) => {
  game.applyQuality(features);
  game.resize(window.innerWidth / window.innerHeight, renderHeightPx());
});

if (import.meta.env.DEV) {
  void import("./debug/dev-hooks").then(({ installDevHooks }) => installDevHooks(game, governor));
  Object.assign(window, { __renderer: renderer, __waymo: game });
}

const timer = new THREE.Timer();
renderer.setAnimationLoop((t) => {
  timer.update(t);
  const raw = timer.getDelta();
  if (game.isReady) governor.update(raw); // build-phase frames are not render cost
  const dt = Math.min(raw, MAX_DT);
  const tU = performance.now();
  game.update(dt);
  // Mobile low tiers re-render the shadow map every Nth frame (no-op on
  // desktop / full tiers). Must run after update (the sun target moved) and
  // before render.
  governor.syncShadow(game.shadowsOn);
  const tR = performance.now();
  renderer.render(game.scene, game.camera);
  const tEnd = performance.now();
  if (tEnd - tU > 1000) {
    console.log(`[slow-frame] update ${Math.round(tR - tU)}ms render ${Math.round(tEnd - tR)}ms`);
  }
});

const loaded = game.load();

// Map editor: open with ?editor=1, place assets, export JSON for
// world/custom-props.ts. Lazy chunk — costs nothing on normal loads.
if (new URLSearchParams(window.location.search).has("editor")) {
  void Promise.all([import("./editor/map-editor"), loaded]).then(async ([{ startEditor }]) => {
    await game.ready; // editor needs the fully built city
    startEditor(game, renderer);
  });
}
