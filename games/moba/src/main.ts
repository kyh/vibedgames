import Phaser from "phaser";
import { setPauseHandlers } from "@repo/embed";

import { hide as hidePauseOverlay, show as showPauseOverlay } from "./pause-overlay";
import { disposeSound, setSoundPaused, soundDiagnostics } from "./render/audio";
import { BootScene } from "./scenes/boot-scene";
import { GameScene } from "./scenes/game-scene";
import { HudScene } from "./scenes/hud-scene";
import { MenuScene } from "./scenes/menu-scene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  backgroundColor: "#0a0e16",
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: "100%",
    height: "100%",
  },
  pixelArt: true,
  roundPixels: true,
  // GameScene owns its own pointer handling; disable the right-click menu so
  // right-click can drive move orders the way a MOBA expects.
  disableContextMenu: true,
  // Dev surfaces (ShowcaseScene, GalleryScene) are lazy-added by BootScene /
  // gallery-nav via dev-scenes.ts — keep them out of this array so their code
  // stays out of the main chunk.
  scene: [BootScene, MenuScene, GameScene, HudScene],
};

// The display font must be resolved before any Phaser Text is created, or those
// texts rasterise with the fallback. Cap the wait so a blocked font CDN can
// never hold the game hostage.
let fontTimeout: ReturnType<typeof setTimeout> | undefined;
const fontReady = Promise.race([
  document.fonts.load('20px "Lilita One"'),
  new Promise((resolve) => {
    fontTimeout = setTimeout(resolve, 1500);
  }),
]);
declare global {
  interface Window {
    /** DEV-only hook for headless verification. */
    __game?: Phaser.Game;
  }
}

void fontReady.then(() => {
  clearTimeout(fontTimeout);
  const game = new Phaser.Game(config);
  let disposed = false;
  Object.defineProperty(window, "__GAME_DIAGNOSTICS__", {
    configurable: true,
    get: () => {
      if (disposed)
        return {
          frame: game.loop.frame,
          phase: "disposed",
          player: null,
          score: 0,
          complete: false,
          audio: soundDiagnostics(),
        };
      const scene = game.scene.getScene("Game");
      return scene instanceof GameScene && game.scene.isActive("Game")
        ? { ...scene.diagnostics(), audio: soundDiagnostics() }
        : {
            frame: game.loop.frame,
            phase: "menu",
            player: null,
            score: 0,
            complete: false,
            audio: soundDiagnostics(),
          };
    },
  });
  if (import.meta.env.DEV) window.__game = game;
  // Scale.RESIZE can read stale parent bounds when a resize lands while the
  // tab is hidden or the browser throttles events (tab switch, phone
  // rotation): the canvas lags one size behind. Re-check once layout settles
  // and on tab return.
  let settle: ReturnType<typeof setTimeout> | undefined;
  const refreshScale = (): void => {
    if (disposed) return;
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (!disposed) game.scale.refresh();
    }, 150);
  };
  const onVisibility = (): void => {
    if (!document.hidden) refreshScale();
  };
  window.addEventListener("resize", refreshScale);
  document.addEventListener("visibilitychange", onVisibility);
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimeout(settle);
    window.removeEventListener("resize", refreshScale);
    document.removeEventListener("visibilitychange", onVisibility);
    setPauseHandlers({});
    hidePauseOverlay();
    disposeSound();
  };
  // Game DESTROY runs after the scene manager is destroyed. Do not look up scenes here.
  game.events.once(Phaser.Core.Events.DESTROY, dispose);

  // Sim is entirely delta-driven (update(_t, deltaMs)), so the wrapper's
  // pause can freeze/resume the loop directly — except in online mode, where
  // freezing the host would stall every client. `froze` ensures onResume only
  // wakes what onPause put to sleep.
  const isOnline = (): boolean => {
    const scene = game.scene.getScene("Game");
    return game.scene.isActive("Game") && scene instanceof GameScene && scene.isOnline();
  };
  let froze = false;
  setPauseHandlers({
    onPause: () => {
      if (disposed) return;
      const scene = game.scene.getScene("Game");
      if (scene instanceof GameScene && game.scene.isActive("Game")) scene.setControlsPaused(true);
      setSoundPaused(true);
      showPauseOverlay();
      if (isOnline()) return;
      froze = true;
      game.loop.sleep();
      game.sound.pauseAll();
    },
    onResume: () => {
      if (disposed) return;
      const scene = game.scene.getScene("Game");
      if (scene instanceof GameScene && game.scene.isActive("Game")) scene.setControlsPaused(false);
      setSoundPaused(false);
      hidePauseOverlay();
      if (!froze) return;
      froze = false;
      game.loop.wake();
      game.sound.resumeAll();
    },
    // Escape closes an open shop/scoreboard first; only a bare Escape pauses.
    escapePauses: () => {
      if (disposed) return false;
      const hud = game.scene.getScene("Hud");
      return !(hud instanceof HudScene && hud.escConsumed);
    },
  });
});
