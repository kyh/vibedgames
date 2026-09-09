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
import { Sound } from "./render/audio";
import { store } from "./systems/store";

interface FarmDiagnostics {
  frame: number;
  phase: "farm" | "mine" | "menu";
  score: number;
  /** The valley is open-ended; there is no victory flag. */
  complete: false;
  player: { x: number; y: number } | null;
}

const config: Phaser.Types.Core.GameConfig = {
  backgroundColor: "#1c2030",
  parent: "game",
  physics: { arcade: { debug: false, gravity: { x: 0, y: 0 } }, default: "arcade" },
  pixelArt: true,
  roundPixels: true,
  scale: { height: "100%", mode: Phaser.Scale.RESIZE, width: "100%" },
  scene: [BootScene, TitleScene, GameScene, MineScene, MineHudScene, HudScene, InventoryScene],
  type: Phaser.WEBGL,
};

declare global {
  interface Window {
    /** DEV-only hook for headless verification. */
    __game?: Phaser.Game;
    readonly __GAME_DIAGNOSTICS__: FarmDiagnostics;
  }
}

const game = new Phaser.Game(config);
if (import.meta.env.DEV) {
  window.__game = game;
}
Object.defineProperty(window, "__GAME_DIAGNOSTICS__", {
  get: (): FarmDiagnostics => {
    const scene = game.scene
      .getScenes(true)
      .find((s) => s instanceof GameScene || s instanceof MineScene);
    return {
      complete: false,
      frame: game.loop.frame,
      phase: scene instanceof GameScene ? "farm" : scene instanceof MineScene ? "mine" : "menu",
      player: scene ? { x: scene.player.x, y: scene.player.y } : null,
      score: store.gold,
    };
  },
});

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
  if (!document.hidden) {
    refreshScale();
  }
});

// Sim is entirely delta-driven (update(_t, dms)), so the wrapper's pause can
// freeze/resume the loop directly — except in live co-op, where freezing would
// stall heartbeats and desync the room; there only the local farmer is fenced.
// The farm owns the session and survives mine trips, so the mine answers
// isOnline() through it and follows the same rule.
// `froze` ensures onResume only wakes what onPause put to sleep.
const activeWorld = (): GameScene | MineScene | null => {
  for (const key of ["Game", "Mine"]) {
    if (!game.scene.isActive(key)) {
      continue;
    }
    const scene = game.scene.getScene(key);
    if (scene instanceof GameScene || scene instanceof MineScene) {
      return scene;
    }
  }
  return null;
};
let froze = false;
let paused = false;
const freeze = (): void => {
  froze = true;
  game.loop.sleep();
  game.sound.pauseAll();
};
// A mine fade committed before an online pause finishes while still paused:
// the new floor is fenced like the farm was (frozen only if the room is gone).
game.events.on("farm-enter-mine", (mine: MineScene) => {
  if (!paused) {
    return;
  }
  mine.setControlsPaused(true);
  if (!froze && !mine.isOnline()) {
    freeze();
  }
});
// Bespoke wooden-sign pause overlay (./pause-overlay) — renders CONTROLS and
// the How-to-Play systems knowledge in the game's own cozy pixel-farm look.
setPauseHandlers({
  onPause: () => {
    paused = true;
    const world = activeWorld();
    world?.setControlsPaused(true);
    Sound.setPaused(true);
    pauseOverlay.show();
    if (!world?.isOnline()) {
      freeze();
    }
  },
  onResume: () => {
    paused = false;
    activeWorld()?.setControlsPaused(false);
    pauseOverlay.hide();
    Sound.setPaused(false);
    if (!froze) {
      return;
    }
    froze = false;
    game.loop.wake();
    game.sound.resumeAll();
  },
  // Escape closes an open inventory/modal first; only a bare Escape pauses.
  escapePauses: () => {
    if (game.scene.isActive("Inventory")) {
      return false;
    }
    const hud = game.scene.getScene("Hud");
    return !(hud instanceof HudScene && hud.modalOpen);
  },
});
