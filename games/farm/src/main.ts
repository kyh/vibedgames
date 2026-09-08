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
import { fxCounts } from "./render/fx";
import { Sound } from "./render/audio";
import { store } from "./systems/store";
import { destroyTouchControls } from "./touch-controls";

type FarmDiagnostics = {
  frame: number;
  phase: "farm" | "mine" | "menu";
  score: number;
  complete: false;
  player: { x: number; y: number } | null;
  fx: ReturnType<typeof fxCounts>;
  audio: ReturnType<typeof Sound.diagnostics>;
};

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
    readonly __GAME_DIAGNOSTICS__: FarmDiagnostics;
  }
}

const game = new Phaser.Game(config);
let disposed = false;
if (import.meta.env.DEV) window["__game"] = game;
const getDiagnostics = (): FarmDiagnostics => {
  const scene = disposed
    ? undefined
    : game.scene?.getScenes(true).find((s) => s instanceof GameScene || s instanceof MineScene);
  const playing = scene instanceof GameScene || scene instanceof MineScene;
  return {
    frame: game.loop?.frame ?? 0,
    phase: scene instanceof GameScene ? "farm" : scene instanceof MineScene ? "mine" : "menu",
    score: store.gold,
    complete: false, // This world is open-ended; there is no victory flag.
    player: playing ? { x: scene.player.x, y: scene.player.y } : null,
    fx: scene ? fxCounts(scene) : null,
    audio: Sound.diagnostics(),
  };
};
Object.defineProperty(window, "__GAME_DIAGNOSTICS__", {
  configurable: true,
  get: getDiagnostics,
});

// Scale.RESIZE can read stale parent bounds when a resize lands while the tab
// is hidden or the browser throttles events (tab switch, phone rotation): the
// canvas lags one size behind. Re-check once layout settles and on tab return.
let settle: ReturnType<typeof setTimeout> | undefined;
const refreshScale = (): void => {
  if (disposed) return;
  clearTimeout(settle);
  settle = setTimeout(() => {
    settle = undefined;
    if (!disposed) game.scale.refresh();
  }, 150);
};
const onVisibilityChange = (): void => {
  if (!document.hidden) refreshScale();
};
window.addEventListener("resize", refreshScale);
document.addEventListener("visibilitychange", onVisibilityChange);

// Sim is entirely delta-driven (update(_t, dms)), so the wrapper's pause can
// freeze/resume the loop directly — except in live co-op, where freezing would
// stall heartbeats and desync the room. `froze` ensures onResume only wakes
// what onPause put to sleep.
const activeFarm = (): GameScene | null => {
  if (disposed || !game.scene?.isActive("Game")) return null;
  const scene = game.scene.getScene("Game");
  return scene instanceof GameScene ? scene : null;
};
let froze = false;
let paused = false;
// An already-committed mine fade can finish while the online farm is paused.
// Mine emits only after create completes; apply its existing offline pause then.
const onEnterMine = (): void => {
  if (disposed || !paused || froze) return;
  froze = true;
  game.loop.sleep();
  game.sound.pauseAll();
};
game.events.on("farm-enter-mine", onEnterMine);
// Bespoke wooden-sign pause overlay (./pause-overlay) — renders CONTROLS and
// the How-to-Play systems knowledge in the game's own cozy pixel-farm look.
const releasePause = setPauseHandlers({
  onPause: () => {
    if (disposed) return;
    paused = true;
    const farm = activeFarm();
    farm?.setControlsPaused(true);
    Sound.setPaused(true);
    pauseOverlay.show();
    if (farm?.isOnline()) return;
    froze = true;
    game.loop.sleep();
    game.sound.pauseAll();
  },
  onResume: () => {
    if (disposed) return;
    paused = false;
    activeFarm()?.setControlsPaused(false);
    pauseOverlay.hide();
    Sound.setPaused(false);
    if (!froze) return;
    froze = false;
    game.loop.wake();
    game.sound.resumeAll();
  },
  // Escape closes an open inventory/modal first; only a bare Escape pauses.
  escapePauses: () => {
    if (disposed) return false;
    if (game.scene.isActive("Inventory")) return false;
    const hud = game.scene.getScene("Hud");
    return !(hud instanceof HudScene && hud.modalOpen);
  },
});

// Phaser destroys its SceneManager before this final game event. Close app
// owners directly; scene-owned network/save cleanup has already run.
game.events.once(Phaser.Core.Events.DESTROY, () => {
  disposed = true;
  clearTimeout(settle);
  settle = undefined;
  window.removeEventListener("resize", refreshScale);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  game.events.off("farm-enter-mine", onEnterMine);
  releasePause();
  pauseOverlay.hide();
  destroyTouchControls();
  Sound.dispose();
  if (window["__game"] === game) delete window["__game"];
  if (Object.getOwnPropertyDescriptor(window, "__GAME_DIAGNOSTICS__")?.get === getDiagnostics) {
    Reflect.deleteProperty(window, "__GAME_DIAGNOSTICS__");
  }
});
