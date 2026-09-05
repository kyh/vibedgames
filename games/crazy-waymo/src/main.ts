import * as THREE from "three";
import { setPauseHandlers } from "@repo/embed";

import { FramePacer } from "./render/frame-pacer";
import { PerfGovernor } from "./render/perf-governor";
import { PostPipeline } from "./render/post";
import { setRenderCapabilities } from "./render/capabilities";
import { isCoarsePointer } from "./render/quality";
import { GameScene } from "./scenes/game-scene";
import { MAX_DT } from "./shared/constants";
import { createPauseOverlay } from "./ui/pause-overlay";

const container = document.getElementById("game");
if (!container) throw new Error("missing #game container");

function showFatal(message: string): void {
  const loading = document.getElementById("loading");
  if (loading) {
    // Trailer boots keep the veil hidden from the first paint (see index.html)
    // — a dead context still has to be reported, so force it back on screen.
    loading.style.display = "flex";
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

// Trailer mode (?trailer=1): forces an offline solo session at construction
// and skips the landing screen; the director itself is a lazy chunk loaded
// below — zero cost normally.
const trailerMode = new URLSearchParams(window.location.search).has("trailer");
setRenderCapabilities({ multiDraw: renderer.extensions.has("WEBGL_multi_draw") });
const game = new GameScene(window.innerWidth / window.innerHeight, trailerMode);
game.applyEnvironment(renderer);

// Post chain (bloom + grade) is desktop-only; phones keep the single pass.
const post = isCoarsePointer() ? null : new PostPipeline(renderer, game.scene, game.camera);
post?.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());
const framePacer = new FramePacer(isCoarsePointer() ? "60hz" : "display");
framePacer.setHidden(document.hidden);

// Wrapper pause: solo game, safe to fully freeze (see GameScene.requestPause).
const pauseOverlay = createPauseOverlay(() => game.restartRun());
setPauseHandlers({
  onPause: () => {
    pauseOverlay.show();
    game.requestPause();
    framePacer.setPaused(true);
    governor.resetTiming();
  },
  onResume: () => {
    pauseOverlay.hide();
    game.requestResume();
    framePacer.setPaused(false);
    governor.resetTiming();
  },
});

function renderHeightPx(): number {
  return window.innerHeight * renderer.getPixelRatio();
}
game.resize(window.innerWidth / window.innerHeight, renderHeightPx());

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  post?.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());
  game.resize(window.innerWidth / window.innerHeight, renderHeightPx());
  framePacer.invalidate();
});

// Adaptive quality: steps pixel ratio (and, on mobile, a feature tier —
// shadows/sky/clouds) to hold frame rate on slower GPUs. Feeds on RAW deltas
// — the clamped game dt hides exactly the slowness it needs to see.
const governor = new PerfGovernor(renderer, game.sunLight, (features) => {
  game.applyQuality(features);
  post?.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());
  game.resize(window.innerWidth / window.innerHeight, renderHeightPx());
});

document.addEventListener("visibilitychange", () => {
  framePacer.setHidden(document.hidden);
  governor.resetTiming();
});

if (import.meta.env.DEV) {
  void import("./debug/dev-hooks").then(({ installDevHooks }) => installDevHooks(game, governor));
  Object.assign(window, { __renderer: renderer, __waymo: game, __post: post });
}

function drawScene(): void {
  if (post) post.render();
  else renderer.render(game.scene, game.camera);
}

renderer.setAnimationLoop((t) => {
  const frame = framePacer.next(t);
  if (frame.kind === "skip") return;
  if (frame.kind === "draw") {
    drawScene();
    return;
  }
  // Build/paused frames are not gameplay cost. Phone pairs normalize 90 Hz
  // callback quantization while preserving the governor's elapsed wall time.
  if (game.isReady && frame.timing) {
    for (let i = 0; i < frame.timing.samples; i++) governor.update(frame.timing.dt);
  }
  const dt = Math.min(frame.dt, MAX_DT);
  const tU = performance.now();
  game.update(dt);
  // Mobile low tiers re-render the shadow map every Nth frame (no-op on
  // desktop / full tiers). Must run after update (the sun target moved) and
  // before render.
  governor.syncShadow(game.shadowsOn);
  const tR = performance.now();
  drawScene();
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
    await startEditor(game, renderer);
  });
}

// TRAILER MODE: ?trailer=1 plays a fully staged in-game trailer (see
// src/trailer/). Lazy chunk, mirrors the editor wiring.
if (trailerMode) {
  void Promise.all([import("./trailer/trailer-director"), loaded]).then(
    async ([{ startTrailer }]) => {
      await game.ready; // staging needs traffic/physics/cones — full readiness
      startTrailer(game);
    },
  );
}
