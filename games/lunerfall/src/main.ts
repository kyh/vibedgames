import Phaser from "phaser";
import { setPauseHandlers } from "@repo/embed";

import { sfx } from "./audio/sfx";
import { BASE_H, BASE_W } from "./config";
import { createLunerfallPauseOverlay } from "./pause-overlay";
import { BootScene } from "./scenes/boot-scene";
import { installTestHooks } from "./sys/diag";
import { GameScene } from "./scenes/game-scene";
import { SelectScene } from "./scenes/select-scene";
import { destroyTouchHud, mountTouchHud } from "./touch-hud";

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
Object.defineProperty(window, "__LUNERFALL_AUDIO__", {
  configurable: true,
  get: () => sfx.diagnostics(),
});
game.events.once(Phaser.Core.Events.DESTROY, () => sfx.dispose());
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
// Custom audio pauses locally in either mode; online simulation keeps advancing.
const isOnline = (): boolean => {
  const scene = game.scene.getScene("game");
  return game.scene.isActive("game") && scene instanceof GameScene && scene.isOnline();
};
let froze = false;
const pauseOverlay = createLunerfallPauseOverlay();
setPauseHandlers({
  onPause: () => {
    sfx.setPaused(true);
    const scene = game.scene.getScene("game");
    if (game.scene.isActive("game") && scene instanceof GameScene) scene.setControlsPaused(true);
    pauseOverlay.show();
    if (isOnline()) return;
    froze = true;
    game.loop.sleep();
  },
  onResume: () => {
    sfx.setPaused(false);
    const scene = game.scene.getScene("game");
    if (game.scene.isActive("game") && scene instanceof GameScene) scene.setControlsPaused(false);
    pauseOverlay.hide();
    if (!froze) return;
    froze = false;
    game.loop.wake();
  },
  // Versus binds Escape to "leave the duel" — defer to it there.
  escapePauses: () => {
    const scene = game.scene.getScene("game");
    return game.scene.isActive("game") && scene instanceof GameScene && !scene.isVersus();
  },
});

// Select owns its responsive screen-space viewport. Runs retain BASE_W/H,
// including after rotation; returning to the hub never erases its receipt.
game.events.once(Phaser.Core.Events.DESTROY, () => {
  setPauseHandlers({});
  pauseOverlay.hide();
  destroyTouchHud();
});
