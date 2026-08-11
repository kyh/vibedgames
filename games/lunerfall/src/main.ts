import Phaser from "phaser";
import { setPauseHandlers } from "@repo/embed";

import { BASE_H, BASE_W, clampAspect } from "./config";
import { createLunerfallPauseOverlay } from "./pause-overlay";
import { BootScene } from "./scenes/boot-scene";
import { installTestHooks } from "./sys/diag";
import { GameScene } from "./scenes/game-scene";
import { SelectScene } from "./scenes/select-scene";
import { mountTouchHud } from "./touch-hud";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  backgroundColor: "#05070b",
  pixelArt: true,
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: BASE_W,
    height: BASE_H,
  },
  scene: [BootScene, SelectScene, GameScene],
};

const game = new Phaser.Game(config);
// Debug handle for perf/inspection probes (see globalThis.__game).
Reflect.set(globalThis, "__game", game);
// __GAME_DIAGNOSTICS__ / __GAME_TEST_HOOKS__ for bot playtests (sys/diag.ts).
installTestHooks(game);

const params = new URLSearchParams(window.location.search);

// Trailer mode (?trailer=1): hand the boot to the trailer director. Lazy import
// so the trailer module never loads — and trailer code stays dead — in normal play.
if (params.has("trailer")) {
  void import("./trailer/trailer-director").then((m) => m.initTrailer(game));
}

// The trailer rolls itself and the viewer is a dev tool with its own chrome;
// neither wants floating buttons over it.
if (!params.has("trailer") && !params.has("viewer")) mountTouchHud(false);

// Wrapper-requested pause: never freeze a live co-op/versus session another
// player is relying on, only the local sim. `froze` tracks whether onPause
// actually froze anything, so onResume only wakes what it put to sleep.
// Audio (sfx.ts, a self-contained WebAudio synth) has no pause hook and is
// left running — it's cosmetic and out of scope for a surgical freeze fix.
const isOnline = (): boolean => {
  const scene = game.scene.getScene("game");
  return game.scene.isActive("game") && scene instanceof GameScene && scene.isOnline();
};
let froze = false;
const pauseOverlay = createLunerfallPauseOverlay();
setPauseHandlers({
  onPause: () => {
    pauseOverlay.show();
    if (isOnline()) return;
    froze = true;
    game.loop.sleep();
  },
  onResume: () => {
    pauseOverlay.hide();
    if (!froze) return;
    froze = false;
    game.loop.wake();
  },
  // Versus binds Escape to "leave the duel" — defer to it there.
  escapePauses: () => {
    const scene = game.scene.getScene("game");
    return !(game.scene.isActive("game") && scene instanceof GameScene && scene.isVersus());
  },
});

// BASE_W bakes the load-time aspect into every scene's layout, so a rotation
// (or any resize that lands on a materially different clamped aspect) can only
// re-fit via a reload. Debounced, and gated on the clamped ratio actually
// moving, so browser-chrome resize noise can't loop reloads: after a reload
// the baked aspect equals the live one and the check goes quiet.
//
// A reload also erases the run in progress, which is far worse than a badly
// fitted one — a phone rolling over in bed must not cost a descent. So while
// the run scene is live the re-fit is deferred and polled for: rotating back
// (or reaching the hub) settles it, either by cancelling or by reloading a
// screen that holds no state.
const bakedAspect = BASE_W / BASE_H;
const aspectMoved = (): boolean => {
  if (window.innerHeight <= 0) return false;
  const live = clampAspect(window.innerWidth / window.innerHeight);
  return Math.abs(live - bakedAspect) / bakedAspect > 0.2;
};
let aspectTimer: ReturnType<typeof setTimeout> | undefined;
let refitTimer: ReturnType<typeof setInterval> | undefined;
const refit = (): void => {
  if (!aspectMoved()) {
    clearInterval(refitTimer);
    refitTimer = undefined;
    return;
  }
  if (game.scene.isActive("game")) {
    refitTimer ??= setInterval(refit, 1000);
    return;
  }
  location.reload();
};
window.addEventListener("resize", () => {
  clearTimeout(aspectTimer);
  aspectTimer = setTimeout(refit, 400);
});
