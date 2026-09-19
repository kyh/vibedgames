// The gear-button settings panel: quality and bot-difficulty segments, the
// time-of-day scrubber, effect toggles and the live renderer stats readout.

import { DIFFICULTIES, QUALITIES, isDifficultyName, isQualityName } from "./config";
import type { Game } from "./game";
import { mustGet, mustGetInput } from "./dom";

const buildQualitySegment = (game: Game): void => {
  const seg = mustGet("quality-seg");
  for (const [name, quality] of Object.entries(QUALITIES)) {
    if (!isQualityName(name)) {
      continue;
    }
    const button = document.createElement("button");
    button.textContent = quality.label;
    button.dataset.q = name;
    button.addEventListener("click", () => game.setQuality(name, true));
    seg.append(button);
  }
};

const buildDifficultySegment = (game: Game): void => {
  const seg = mustGet("difficulty-seg");
  for (const [name, difficulty] of Object.entries(DIFFICULTIES)) {
    if (!isDifficultyName(name)) {
      continue;
    }
    const button = document.createElement("button");
    button.textContent = difficulty.label;
    button.dataset.d = name;
    button.addEventListener("click", () => game.setDifficulty(name));
    seg.append(button);
  }
};

/** Wire every control in the panel to the game's setters. Runs once. */
export const buildSettingsPanel = (game: Game): void => {
  const panel = mustGet("settings");
  mustGet("gear").addEventListener("click", () => panel.classList.toggle("open"));
  buildQualitySegment(game);
  buildDifficultySegment(game);
  const autoTime = mustGetInput("auto-time");
  autoTime.addEventListener("change", () => game.setAutoTime(autoTime.checked));
  const slider = mustGetInput("time-slider");
  slider.addEventListener("input", () => {
    game.setAutoTime(false);
    game.lighting.setTime(Number(slider.value));
  });
  const ao = mustGetInput("tog-ao");
  ao.addEventListener("change", () => game.setToggle("ao", ao.checked));
  const bloom = mustGetInput("tog-bloom");
  bloom.addEventListener("change", () => game.setToggle("bloom", bloom.checked));
  const mute = mustGetInput("tog-mute");
  mute.addEventListener("change", () => game.setMuted(mute.checked));
};

/** Push the game's current settings into the panel's controls. */
export const syncSettingsPanel = (game: Game): void => {
  for (const button of document.querySelectorAll<HTMLElement>("#quality-seg button")) {
    button.classList.toggle("on", button.dataset.q === game.pipeline.qualityName);
  }
  for (const button of document.querySelectorAll<HTMLElement>("#difficulty-seg button")) {
    button.classList.toggle("on", button.dataset.d === game.difficultyName);
  }
  mustGetInput("auto-time").checked = game.autoTime;
  const ao = mustGetInput("tog-ao");
  ao.checked = game.pipeline.toggles.ao;
  ao.disabled = !game.pipeline.quality.ao;
  mustGetInput("tog-bloom").checked = game.pipeline.toggles.bloom;
  mustGetInput("tog-mute").checked = game.audio.muted;
};

/** Frame-rate and shadow diagnostics shown at the bottom of the panel. */
export const renderStats = (game: Game, fps: number): void => {
  const { frameStats, lighting, pipeline } = game;
  const lit = lighting.lampSlots.filter((lamp) => lamp.intensity > 0.01).length;
  const casting = lighting.lampSlots.filter(
    (lamp) => lamp.castShadow && lamp.shadow.autoUpdate,
  ).length;
  const poolLit = lighting.pool.filter((light) => light.intensity > 0).length;
  const shadowKind = pipeline.usingPCSS ? "PCSS" : "PCF";
  const bench = game.perf.benchMs ? game.perf.benchMs.toFixed(1) : "?";
  const qualityLine = game.userPickedQuality
    ? "quality: your choice"
    : `quality: auto  (night frame ${bench} ms at startup)`;
  const tris = (frameStats.triangles / 1000).toFixed(0);
  const span = (lighting.shadowRadius * 2).toFixed(0);
  mustGet("stats").textContent = `${fps} fps   ${frameStats.calls} draws   ${tris}k tris
sun shadow ${lighting.mapSize}px over ${span}m  (${shadowKind})
lamps lit ${lit}  casting ${casting}   pool lights ${poolLit}/${lighting.pool.length}
${qualityLine}`;
};
