import * as THREE from "three";
import { setPauseHandlers } from "@repo/embed";

import { FramePacer } from "./render/frame-pacer";
import { hasReleasedArrays } from "./render/gpu-only-geometry";
import { PerfGovernor } from "./render/perf-governor";
import { PostPipeline } from "./render/post";
import { setRenderCapabilities } from "./render/capabilities";
import { isCoarsePointer } from "./render/quality";
import { GameScene } from "./scenes/game-scene";
import { MAX_DT } from "./shared/constants";
import { createPauseOverlay } from "./ui/pause-overlay";

const container = document.querySelector("#game");
if (!container) {
  throw new Error("missing #game container");
}

let reloadOnVeilTap = false;
document.querySelector("#loading")?.addEventListener("click", () => {
  if (reloadOnVeilTap) {
    window.location.reload();
  }
});

const showFatal = (message: string, tapToReload = false): void => {
  const loading = document.querySelector<HTMLElement>("#loading");
  if (loading) {
    // Trailer boots keep the veil hidden from the first paint (see index.html)
    // — a dead context still has to be reported, so force it back on screen.
    loading.style.display = "flex";
    loading.innerHTML = `<div class="lt">CRAZY WAYMO</div><div class="ls" style="opacity:1;color:#ff8a8a">${message}</div>`;
    reloadOnVeilTap = tapToReload;
  }
};

const hideFatal = (): void => {
  const loading = document.querySelector<HTMLElement>("#loading");
  if (loading) {
    loading.style.display = "none";
  }
  reloadOnVeilTap = false;
};

// MSAA can't be changed after context creation. On dense phone screens the
// subpixel density plus the sub-native render ratio the governor picks hide
// the aliasing, and skipping the resolve pass buys real GPU time. Desktop
// keeps MSAA exactly as before.
const msaa = !(isCoarsePointer() && (window.devicePixelRatio || 1) >= 2);
// Context creation fails transiently on phones: Chrome's GPU process was just
// restarted (a background tab reclaimed it) or the page hit the per-process
// context cap. Retrying after a beat recovers those; the last attempt drops
// the high-performance / MSAA asks, which a blocklisted or low-power GPU may
// refuse outright. The browser's own reason is captured so the veil can show it.
const sleep = (ms: number): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps the setTimeout callback API
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const probeCanvas = () => {
  const canvas = document.createElement("canvas");
  let reason = "";
  canvas.addEventListener("webglcontextcreationerror", (event: Event) => {
    if (event instanceof WebGLContextEvent && event.statusMessage) {
      reason = event.statusMessage;
    }
  });
  return { canvas, reason: () => reason };
};
const createRenderer = async (): Promise<THREE.WebGLRenderer> => {
  const attempts: THREE.WebGLRendererParameters[] = [
    { antialias: msaa, powerPreference: "high-performance" },
    { antialias: msaa, powerPreference: "high-performance" },
    { antialias: false, powerPreference: "default" },
  ];
  let reason = "";
  let lastError: unknown;
  for (const [i, params] of attempts.entries()) {
    const probe = probeCanvas();
    try {
      return new THREE.WebGLRenderer({ ...params, canvas: probe.canvas });
    } catch (error) {
      lastError = error;
      reason = probe.reason() || reason;
      console.error(`[crazy-waymo] WebGL init attempt ${i + 1} failed`, reason || error);
      await sleep(350 * (i + 1));
    }
  }
  showFatal(
    `WebGL unavailable${reason ? ` (${reason})` : ""} — tap to retry, or enable hardware acceleration.`,
    true,
  );
  throw lastError instanceof Error ? lastError : new Error("WebGL init failed");
};
const renderer = await createRenderer();
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// three r184 removed PCFSoft (coerces it to PCF with a deprecation warn at
// the first shadow render) — ask for PCF directly. Identical output.
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.62;
container.append(renderer.domElement);

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
const pauseOverlay = createPauseOverlay({
  mute: {
    get: () => game.muted,
    set: (next) => {
      if (next !== game.muted) {
        game.toggleMute();
      }
    },
  },
  onRestart: () => game.restartRun(),
});
const renderHeightPx = (): number => window.innerHeight * renderer.getPixelRatio();
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

document.addEventListener("visibilitychange", () => {
  framePacer.setHidden(document.hidden);
  governor.resetTiming();
});

// A lost WebGL context is what a phone browser hands back when the tab runs
// out of memory: three stops drawing, the canvas goes blank, and the DOM HUD
// keeps updating over it as if nothing happened. Say so, and offer the one
// recovery that works on iOS — a reload (the world caches make it a short
// one). three already asks the browser for restoration; if it comes, resume.
renderer.domElement.addEventListener("webglcontextlost", () => {
  console.error("[crazy-waymo] WebGL context lost");
  showFatal("The browser stopped the graphics (usually low memory). Tap to reload.", true);
});
renderer.domElement.addEventListener("webglcontextrestored", () => {
  console.warn("[crazy-waymo] WebGL context restored");
  // Restoration re-uploads every geometry from its heap array. Phones have
  // released the static ones (render/gpu-only-geometry.ts), so the rebuilt
  // city would be empty — a reload is the only complete recovery there.
  if (hasReleasedArrays()) {
    showFatal("Graphics restored — reloading…");
    window.location.reload();
    return;
  }
  hideFatal();
  governor.resetTiming();
  framePacer.invalidate();
});

if (import.meta.env.DEV) {
  void (async () => {
    const { installDevHooks } = await import("./debug/dev-hooks");
    installDevHooks(game, governor);
  })();
  Object.assign(window, { __post: post, __renderer: renderer, __waymo: game });
}

const drawScene = (): void => {
  if (post) {
    post.render();
  } else {
    renderer.render(game.scene, game.camera);
  }
};

renderer.setAnimationLoop((t) => {
  const frame = framePacer.next(t);
  if (frame.kind === "skip") {
    return;
  }
  if (frame.kind === "draw") {
    drawScene();
    return;
  }
  // Build/paused frames are not gameplay cost. Phone pairs normalize 90 Hz
  // callback quantization while preserving the governor's elapsed wall time.
  if (game.isReady && frame.timing) {
    for (let i = 0; i < frame.timing.samples; i += 1) {
      governor.update(frame.timing.dt);
    }
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
  void (async () => {
    const [{ startEditor }] = await Promise.all([import("./editor/map-editor"), loaded]);
    // editor needs the fully built city
    await game.ready;
    await startEditor(game, renderer);
  })();
}

// TRAILER MODE: ?trailer=1 plays a fully staged in-game trailer (see
// src/trailer/). Lazy chunk, mirrors the editor wiring.
if (trailerMode) {
  void (async () => {
    const [{ startTrailer }] = await Promise.all([import("./trailer/trailer-director"), loaded]);
    // staging needs traffic/physics/cones — full readiness
    await game.ready;
    await game.prepareTrailer();
    startTrailer(game, () => {
      drawScene();
      return renderer.domElement;
    });
  })();
}
