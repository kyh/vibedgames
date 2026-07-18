import Phaser from "phaser";
import { setPauseHandlers } from "@repo/embed";

import { pauseOverlay } from "./pause-overlay";
import { BootScene } from "./scenes/boot-scene";
import { TitleScene } from "./scenes/title-scene";
import { GameScene } from "./scenes/game-scene";
import { MineScene } from "./scenes/mine-scene";
import { MineHudScene } from "./scenes/mine-hud-scene";
import { HudScene } from "./scenes/hud-scene";
import { InventoryScene } from "./scenes/inventory-scene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  backgroundColor: "#1c2030",
  scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
  pixelArt: true,
  roundPixels: true,
  physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
  scene: [BootScene, TitleScene, GameScene, MineScene, MineHudScene, HudScene, InventoryScene],
};

declare global {
  interface Window {
    /** DEV-only hook for headless verification. */
    __game?: Phaser.Game;
  }
}

const game = new Phaser.Game(config);
if (import.meta.env.DEV) window.__game = game;

// Scale.RESIZE can read stale parent bounds when a resize lands while the tab
// is hidden or the browser throttles events (tab switch, phone rotation): the
// canvas lags one size behind. Re-check once layout settles and on tab return.
let settle: ReturnType<typeof setTimeout> | undefined;
const refreshScale = (): void => {
  clearTimeout(settle);
  settle = setTimeout(() => game.scale.refresh(), 150);
};
window.addEventListener("resize", refreshScale);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshScale();
});

// Sim is entirely delta-driven (update(_t, dms)), so the wrapper's pause can
// freeze/resume the loop directly — except in live co-op, where freezing would
// stall heartbeats and desync the room. `froze` ensures onResume only wakes
// what onPause put to sleep.
const isOnline = (): boolean => {
  const scene = game.scene.getScene("Game");
  return game.scene.isActive("Game") && scene instanceof GameScene && scene.isOnline();
};
let froze = false;
// Bespoke wooden-sign pause overlay (./pause-overlay) — renders CONTROLS and
// the How-to-Play systems knowledge in the game's own cozy pixel-farm look.
setPauseHandlers({
  onPause: () => {
    pauseOverlay.show();
    if (isOnline()) return;
    froze = true;
    game.loop.sleep();
    game.sound.pauseAll();
  },
  onResume: () => {
    pauseOverlay.hide();
    if (!froze) return;
    froze = false;
    game.loop.wake();
    game.sound.resumeAll();
  },
  // Escape closes an open inventory/modal first; only a bare Escape pauses.
  escapePauses: () => {
    if (game.scene.isActive("Inventory")) return false;
    const hud = game.scene.getScene("Hud");
    return !(hud instanceof HudScene && hud.modalOpen);
  },
});
