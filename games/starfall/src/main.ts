import type { Types } from "phaser";
import { Game, Scale, WEBGL } from "phaser";
import { probeWebGL, showWebGLVeil } from "@repo/embed";

import { BootScene } from "./scenes/boot-scene";
import { GameScene } from "./scenes/game-scene";
import { reseed } from "./shared/rng";

const bootParams = new URLSearchParams(location.search);
const trailerMode = bootParams.has("trailer");

const seedParam = bootParams.get("seed");

if (seedParam !== null && seedParam !== "" && Number.isFinite(Number(seedParam))) {
  reseed(Number(seedParam));
} else if (trailerMode) {
  reseed(7);
}

const config: Types.Core.GameConfig = {
  parent: "game",
  scale: {
    height: "100%",
    mode: Scale.RESIZE,
    width: "100%",
  },
  scene: [BootScene, GameScene],
  transparent: true,
  type: WEBGL,
};

declare global {
  interface Window {
    /** DEV-only hook for headless verification. */
    __game?: Game;
  }
}

const webgl = probeWebGL();

if (!webgl.ok) {
  showWebGLVeil(webgl);
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
}

const game = new Game(config);

game.canvas.addEventListener("webglcontextlost", () => {
  console.error("WebGL context lost");
  showWebGLVeil(
    { blocked: false, ok: false, reason: "context lost" },
    "The browser stopped the graphics (usually low memory).",
  );
});

if (import.meta.env.DEV) {
  window.__game = game;
}

if (trailerMode) {
  void (async () => {
    const { bootTrailerDirector } = await import("./trailer/trailer-director");
    bootTrailerDirector(game);
  })();
}

let settle: ReturnType<typeof setTimeout> | undefined;

const refreshScale = () => {
  clearTimeout(settle);
  settle = setTimeout(() => {
    game.scale.refresh();
  }, 150);
};

window.addEventListener("resize", refreshScale);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshScale();
  }
});
