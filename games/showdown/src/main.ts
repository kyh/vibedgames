import {
  createTouchControls,
  isOfflineRequested,
  notifyGameStarted,
  probeWebGL,
  setPauseHandlers,
  showWebGLVeil,
} from "@repo/embed";

import { isPlaytestRequested } from "@vibedgames/playtest";

import { isBrawlerId } from "./config";
import { CONTROLS, METHOD_LABEL } from "./controls";
import { installDiagnostics } from "./diagnostics";
import { createShowdownPauseOverlay } from "./pause-overlay";
import { installPlaytest } from "./playtest";
import { sensePlaytest } from "./playtest-sense";
import { mountStartLegend } from "./polish/start-legend";
import { Game } from "./game";
import { mustGet } from "./dom";
import { chosenName } from "./hud-lobby";
import { roomId } from "./net/protocol";

declare global {
  interface Window {
    __game?: Game;
  }
}

const webgl = probeWebGL();

if (!webgl.ok) {
  showWebGLVeil(webgl);
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
}

const params = new URLSearchParams(location.search);
const auto = params.get("auto");
const autoKit = auto && isBrawlerId(auto) ? auto : undefined;

const updateLoading = (progress: number, label: string) => {
  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  mustGet("loading-fill").style.transform = `scaleX(${percent / 100})`;
  mustGet("loading-progress").setAttribute("aria-valuenow", String(percent));
  mustGet("loading-status").textContent = label;
};

updateLoading(0.08, "Opening the gates…");

const game = new Game({
  onLoadProgress: updateLoading,
  onMatchStart: notifyGameStarted,
  selected: autoKit,
});

game.pipeline.renderer.domElement.addEventListener("webglcontextlost", () => {
  console.error("WebGL context lost");
  showWebGLVeil(
    { blocked: false, ok: false, reason: "context lost" },
    "The browser stopped the graphics (usually low memory).",
  );
});

installDiagnostics(game, () => sensePlaytest(game));

if (import.meta.env.DEV || isPlaytestRequested()) {
  installPlaytest(game);
}

mountStartLegend(mustGet("menu-legend"), CONTROLS, METHOD_LABEL);

if (import.meta.env.DEV) {
  window.__game = game;
}

const launch = () => {
  if (params.has("online") && !isOfflineRequested()) {
    game.startOnline({ name: chosenName(params), room: roomId(params.get("room") ?? "") });

    return;
  }

  if (autoKit || params.has("online")) {
    game.startMatch(autoKit ?? game.hud.selected);
  }
};

launch();

const pauseOverlay = createShowdownPauseOverlay({
  isLive: () => game.mode !== "solo",
  mute: { get: () => game.audio.muted, set: (muted) => game.setMuted(muted) },
});

setPauseHandlers({
  escapePauses: () => game.state !== "menu" && !mustGet("settings").classList.contains("open"),
  onPause: () => {
    game.setPaused(true);
    pauseOverlay.show();
  },
  onResume: () => {
    pauseOverlay.hide();
    game.setPaused(false);
  },
});

createTouchControls();
