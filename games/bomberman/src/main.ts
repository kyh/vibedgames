import { setPauseHandlers } from "@repo/embed";
import Phaser from "phaser";

import { createBombermanPauseOverlay } from "./pause-overlay";
import { BootScene } from "./scenes/boot-scene";
import { GameScene } from "./scenes/game-scene";
import { pauseAudio } from "./fx/sfx";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  parent: "game",
  backgroundColor: "#0e1020",
  scale: {
    // Fill the window; GameScene owns the follow-camera + zoom.
    mode: Phaser.Scale.RESIZE,
    width: "100%",
    height: "100%",
  },
  pixelArt: true,
  scene: [BootScene, GameScene],
};

const game = new Phaser.Game(config);
let disposed = false;

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

// Wrapper pause. The overlay always shows; we only truly FREEZE the game when
// no other human is in the arena — freezing a shared online round would stall
// the other players (their sim is wall-clock driven too). When we do freeze,
// `pauseClock()` stops the sim clock so fuses/round/AI deadlines hold: a bomb
// with 2s of fuse left before the pause still has ~2s after resume, instead of
// every stored deadline firing at once when the loop wakes. The embed package
// re-announces the game as started after onResume.
let froze = false;
const pauseOverlay = createBombermanPauseOverlay();
const releasePauseHandlers = setPauseHandlers({
  onPause: () => {
    if (disposed) return;
    pauseOverlay.show();
    pauseAudio(true);
    const scene = game.scene.getScene<GameScene>("Game");
    scene?.setPresentationPaused(true);
    // Other humans present (live online round) — leave the sim running.
    if (!scene || !scene.freezable) return;
    froze = true;
    scene.pauseSimulation(); // publishes a shared frozen anchor before sleeping
    game.sound.pauseAll();
  },
  onResume: () => {
    if (disposed) return;
    pauseOverlay.hide();
    pauseAudio(false);
    game.scene.getScene<GameScene>("Game")?.setPresentationPaused(false);
    if (!froze) return;
    froze = false;
    game.scene.getScene<GameScene>("Game")?.resumeSimulation();
    game.sound.resumeAll();
  },
});

game.events.once(Phaser.Core.Events.DESTROY, () => {
  if (disposed) return;
  disposed = true;
  clearTimeout(settle);
  settle = undefined;
  window.removeEventListener("resize", refreshScale);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  releasePauseHandlers();
  pauseOverlay.hide();
});
