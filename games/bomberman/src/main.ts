import { setPauseHandlers } from "@repo/embed";
import Phaser from "phaser";

import { createBombermanPauseOverlay } from "./pause-overlay";
import { BootScene } from "./scenes/boot-scene";
import { GameScene } from "./scenes/game-scene";
import { pauseClock, resumeClock } from "./util/clock";

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

// Wrapper pause. The overlay always shows; we only truly FREEZE the game when
// no other human is in the arena — freezing a shared online round would stall
// the other players (their sim is wall-clock driven too). When we do freeze,
// `pauseClock()` stops the sim clock so fuses/round/AI deadlines hold: a bomb
// with 2s of fuse left before the pause still has ~2s after resume, instead of
// every stored deadline firing at once when the loop wakes. The embed package
// re-announces the game as started after onResume.
let froze = false;
const pauseOverlay = createBombermanPauseOverlay();
setPauseHandlers({
  onPause: () => {
    pauseOverlay.show();
    const scene = game.scene.getScene<GameScene>("Game");
    // Other humans present (live online round) — leave the sim running.
    if (!scene || !scene.freezable) return;
    froze = true;
    pauseClock();
    game.loop.sleep(); // stops update() until wake()
    game.sound.pauseAll();
  },
  onResume: () => {
    pauseOverlay.hide();
    if (!froze) return;
    froze = false;
    resumeClock();
    game.loop.wake();
    game.sound.resumeAll();
  },
});
