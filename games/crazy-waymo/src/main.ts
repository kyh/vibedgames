import * as THREE from "three";
import { describeGpu, setPauseHandlers } from "@repo/embed";

import { FramePacer } from "./render/frame-pacer";
import { hasReleasedArrays } from "./render/gpu-only-geometry";
import { PerfGovernor } from "./render/perf-governor";
import { PostPipeline } from "./render/post";
import { setRenderCapabilities } from "./render/capabilities";
import { recordContextLoss, safeMode } from "./render/safe-mode";
import { isCoarsePointer } from "./render/quality";
import { installPlaytest } from "./playtest/install";
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

const showFatal = (message: string, tapToReload = false, detail = "") => {
  const loading = document.querySelector<HTMLElement>("#loading");

  if (loading) {
    loading.style.display = "flex";
    loading.innerHTML = `<div class="lt">CRAZY WAYMO</div><div class="ls" style="opacity:1;color:#ff8a8a">${message}</div>`;

    if (detail) {
      const line = document.createElement("div");
      line.style.cssText =
        "margin-top:12px;font-size:11px;color:#8b95a1;word-break:break-word;max-width:28em";
      line.textContent = detail;
      loading.append(line);
    }

    reloadOnVeilTap = tapToReload;
  }
};

const hideFatal = () => {
  const loading = document.querySelector<HTMLElement>("#loading");

  if (loading) {
    loading.style.display = "none";
  }

  reloadOnVeilTap = false;
};

const msaa = !(isCoarsePointer() && (window.devicePixelRatio || 1) >= 2);

const sleep: (ms: number) => Promise<void> = (ms) =>
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

const createRenderer = async () => {
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

  const blocked = /blocked/iu.test(reason);
  showFatal(
    blocked
      ? "Chrome paused graphics for this site after a crash. Wait two minutes, then tap to reload."
      : `WebGL unavailable${reason ? ` (${reason})` : ""} — tap to retry, or enable hardware acceleration.`,
    true,
    [
      reason,
      `${Math.round(performance.now() / 1000)} s after load`,
      `${screen.width}×${screen.height} @${window.devicePixelRatio}`,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  throw lastError instanceof Error ? lastError : new Error("WebGL init failed");
};

const renderer = await createRenderer();

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

renderer.setSize(window.innerWidth, window.innerHeight);

renderer.shadowMap.enabled = true;

renderer.shadowMap.type = THREE.PCFShadowMap;

renderer.toneMapping = THREE.ACESFilmicToneMapping;

renderer.toneMappingExposure = 0.62;

container.append(renderer.domElement);

const trailerMode = new URLSearchParams(window.location.search).has("trailer");

setRenderCapabilities({ multiDraw: renderer.extensions.has("WEBGL_multi_draw") });

const gpu = describeGpu(renderer.getContext());

if (safeMode()) {
  renderer.shadowMap.enabled = false;
}

const game = new GameScene(window.innerWidth / window.innerHeight, trailerMode);

game.applyEnvironment(renderer);

const post = isCoarsePointer() ? null : new PostPipeline(renderer, game.scene, game.camera);

if (!post) {
  renderer.toneMapping = THREE.CustomToneMapping;
}

post?.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());

const framePacer = new FramePacer(isCoarsePointer() ? "60hz" : "display");

framePacer.setHidden(document.hidden);

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

const renderHeightPx = () => window.innerHeight * renderer.getPixelRatio();

game.resize(window.innerWidth / window.innerHeight, renderHeightPx());

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  post?.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());
  game.resize(window.innerWidth / window.innerHeight, renderHeightPx());
  framePacer.invalidate();
});

const governor = new PerfGovernor(renderer, game.sunLight, (features) => {
  game.applyQuality(features);
  post?.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());
  game.resize(window.innerWidth / window.innerHeight, renderHeightPx());
});

setPauseHandlers({
  escapePauses: () => !game.mapOpen,
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

renderer.domElement.addEventListener("webglcontextlost", () => {
  console.error("[crazy-waymo] WebGL context lost");
  recordContextLoss();
  const { memory, render } = renderer.info;
  showFatal(
    "The browser stopped the graphics (usually low memory). Tap to reload — the game will come back in low-graphics mode.",
    true,
    [
      gpu,
      `${Math.round(performance.now() / 1000)} s after load`,
      `tier ${governor.currentTier}/${governor.tierCount - 1}`,
      safeMode() ? "safe mode" : "full quality",
      game.modeKind,
      `${memory.geometries} geo · ${memory.textures} tex · ${render.triangles} tris`,
      `${screen.width}×${screen.height} @${window.devicePixelRatio}`,
    ].join(" · "),
  );
});

renderer.domElement.addEventListener("webglcontextrestored", () => {
  console.warn("[crazy-waymo] WebGL context restored");

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

const drawScene = () => {
  if (post) {
    post.render();
  } else {
    renderer.render(game.scene, game.camera);
  }
};

renderer.setAnimationLoop((t) => {
  const frame = framePacer.next(t);

  if (frame.kind !== "advance") {
    game.updatePaused();
  }

  if (frame.kind === "skip") {
    return;
  }

  if (frame.kind === "draw") {
    drawScene();

    return;
  }

  if (game.isReady && frame.timing) {
    for (let i = 0; i < frame.timing.samples; i += 1) {
      governor.update(frame.timing.dt);
    }
  }

  const dt = Math.min(frame.dt, MAX_DT);
  const tU = performance.now();
  game.update(dt);
  governor.syncShadow(game.shadowsOn);
  const tR = performance.now();
  drawScene();
  const tEnd = performance.now();

  if (tEnd - tU > 1000) {
    console.log(`[slow-frame] update ${Math.round(tR - tU)}ms render ${Math.round(tEnd - tR)}ms`);
  }
});

const loaded = game.load();

if (!trailerMode) {
  void (async () => {
    await loaded;
    await game.ready;
    installPlaytest(game);
  })();
}

if (new URLSearchParams(window.location.search).has("editor")) {
  void (async () => {
    const [{ startEditor }] = await Promise.all([import("./editor/map-editor"), loaded]);
    await game.ready;
    await startEditor(game, renderer);
  })();
}

if (trailerMode) {
  void (async () => {
    const [{ startTrailer }] = await Promise.all([import("./trailer/trailer-director"), loaded]);
    await game.ready;
    await game.prepareTrailer();
    startTrailer(game, () => {
      drawScene();

      return renderer.domElement;
    });
  })();
}
