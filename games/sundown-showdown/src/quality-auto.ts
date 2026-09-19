// Automatic quality selection for players who never touched the setting: a
// startup benchmark of the most expensive lighting (full night) steps the
// tier down until a frame is cheap enough, and a running fps average during
// play steps it down again if the machine still cannot keep up.

import { QUALITIES } from "./config";
import type { QualityName } from "./config";
import type { Game } from "./game";

/** Most to least expensive; auto-tuning only ever walks toward the end. */
const QUALITY_ORDER: readonly QualityName[] = ["ultra", "high", "medium", "low"];

/** Median frame above this (ms) at startup drops a tier. */
const BENCH_BUDGET_MS = 20;
const BENCH_ROUNDS = 3;
const BENCH_FRAMES = 10;
/** Shader compiles land in the first frames; they are not the steady-state cost. */
const BENCH_WARMUP_FRAMES = 4;
/** Hour used for the benchmark: every lamp lit and casting. */
const BENCH_HOUR = 21.5;

/** Sampling window (s) for the in-match fps check and the fps that triggers a drop. */
const ADAPT_WINDOW_S = 6;
const ADAPT_MIN_FPS = 24;
/** A single frame longer than this (s) is a stall, not a measure of the GPU. */
const ADAPT_STALL_S = 0.1;

const nextLowerQuality = (current: QualityName): QualityName | undefined =>
  QUALITY_ORDER[QUALITY_ORDER.indexOf(current) + 1];

/** Render a night frame to completion and time it; readPixels forces the GPU to finish. */
const timeFrame = (game: Game, pixel: Uint8Array): number => {
  const { renderer } = game.pipeline;
  const gl = renderer.getContext();
  const start = performance.now();
  game.lighting.update(0, game.elapsed, game.camera, game.focus, true);
  game.pipeline.render(0);
  renderer.setRenderTarget(null);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  return performance.now() - start;
};

export const benchmarkQuality = (game: Game): void => {
  if (game.userPickedQuality) {
    return;
  }
  const pixel = new Uint8Array(4);
  const hourBefore = game.lighting.time;
  game.lighting.setTime(BENCH_HOUR);
  for (let round = 0; round < BENCH_ROUNDS; round += 1) {
    const samples: number[] = [];
    for (let i = 0; i < BENCH_FRAMES; i += 1) {
      samples.push(timeFrame(game, pixel));
    }
    samples.splice(0, BENCH_WARMUP_FRAMES);
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] ?? 0;
    game.perf.benchMs = median;
    const lower = nextLowerQuality(game.pipeline.qualityName);
    if (median <= BENCH_BUDGET_MS || !lower) {
      break;
    }
    game.setQuality(lower);
    game.hud.toast(
      `${QUALITIES[lower].label} quality picked for this GPU - change it any time under ⚙`,
    );
  }
  game.lighting.setTime(hourBefore);
};

export const adaptQuality = (game: Game, dt: number): void => {
  const { perf } = game;
  if (game.userPickedQuality || game.state !== "playing" || game.paused || document.hidden) {
    return;
  }
  if (dt > ADAPT_STALL_S) {
    return;
  }
  perf.t += dt;
  perf.frames += 1;
  if (perf.t < ADAPT_WINDOW_S) {
    return;
  }
  const fps = perf.frames / perf.t;
  perf.t = 0;
  perf.frames = 0;
  const lower = nextLowerQuality(game.pipeline.qualityName);
  if (fps < ADAPT_MIN_FPS && lower) {
    game.setQuality(lower);
    game.hud.toast(
      `Running at ${Math.round(fps)} fps - switched to ${QUALITIES[lower].label} quality`,
    );
  }
};
