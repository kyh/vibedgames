import type { Types } from "phaser";
import { Game, Scale, WEBGL } from "phaser";
import { setPauseHandlers } from "@repo/embed";

import { hide as hidePauseOverlay, show as showPauseOverlay } from "./pause-overlay";
import { BootScene } from "./scenes/boot-scene";
import { GameScene } from "./scenes/game-scene";
import { HudScene } from "./scenes/hud-scene";
import { MenuScene } from "./scenes/menu-scene";

const config: Types.Core.GameConfig = {
  backgroundColor: "#0a0e16",
  // GameScene owns its own pointer handling; disable the right-click menu so
  // right-click can drive move orders the way a MOBA expects.
  disableContextMenu: true,
  parent: "game",
  pixelArt: true,
  roundPixels: true,
  scale: {
    height: "100%",
    mode: Scale.RESIZE,
    width: "100%",
  },
  // Dev surfaces (ShowcaseScene, GalleryScene) are lazy-added by BootScene /
  // gallery-nav via dev-scenes.ts — keep them out of this array so their code
  // stays out of the main chunk.
  scene: [BootScene, MenuScene, GameScene, HudScene],
  type: WEBGL,
};

// The display font must be resolved before any Phaser Text is created, or those
// texts rasterise with the fallback. Cap the wait so a blocked font CDN can
// never hold the game hostage.
const fontReady = Promise.race([
  document.fonts.load('20px "Lilita One"'),
  // oxlint-disable-next-line no-promise-executor-return, promise/avoid-new -- setTimeout sleep has no promise form in the browser
  new Promise((resolve) => setTimeout(resolve, 1500)),
]);
declare global {
  interface Window {
    /** DEV-only hook for headless verification. */
    __game?: Game;
  }
}

const boot = async (): Promise<void> => {
  await fontReady;
  const game = new Game(config);
  if (import.meta.env.DEV) {
    window.__game = game;
  }
  // Scale.RESIZE can read stale parent bounds when a resize lands while the
  // tab is hidden or the browser throttles events (tab switch, phone
  // rotation): the canvas lags one size behind. Re-check once layout settles
  // and on tab return.
  let settle: ReturnType<typeof setTimeout> | undefined;
  const refreshScale = (): void => {
    clearTimeout(settle);
    settle = setTimeout(() => game.scale.refresh(), 150);
  };
  window.addEventListener("resize", refreshScale);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshScale();
    }
  });

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
    // Escape closes an open shop/scoreboard first; only a bare Escape pauses.
    escapePauses: () => {
      const hud = game.scene.getScene("Hud");
      return !(hud instanceof HudScene && hud.escConsumed);
    },
    onPause: () => {
      showPauseOverlay();
      if (isOnline()) {
        return;
      }
      froze = true;
      game.loop.sleep();
      game.sound.pauseAll();
    },
    onResume: () => {
      hidePauseOverlay();
      if (!froze) {
        return;
      }
      froze = false;
      game.loop.wake();
      game.sound.resumeAll();
    },
  });
};
void boot();
