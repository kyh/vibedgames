import type { Types } from "phaser";
import { Game, Scale, WEBGL } from "phaser";
import { probeWebGL, setPauseHandlers, showWebGLVeil } from "@repo/embed";
import {
  isPlaytestRequested,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";

import { pauseOverlay } from "./pause-overlay";
import { farmManifest, readDiagnostics } from "./playtest";
import type { FarmDiagnostics } from "./playtest";
import { BootScene } from "./scenes/boot-scene";
import { TitleScene } from "./scenes/title-scene";
import { GameScene } from "./scenes/game-scene";
import { MineScene } from "./scenes/mine-scene";
import { MineHudScene } from "./scenes/mine-hud-scene";
import { HudScene } from "./scenes/hud-scene";
import { InventoryScene } from "./scenes/inventory-scene";
import { Sound } from "./render/audio";
import { disableSaves } from "./systems/save";

const config: Types.Core.GameConfig = {
  backgroundColor: "#1c2030",
  parent: "game",
  physics: { arcade: { debug: false, gravity: { x: 0, y: 0 } }, default: "arcade" },
  pixelArt: true,
  roundPixels: true,
  scale: { height: "100%", mode: Scale.RESIZE, width: "100%" },
  scene: [BootScene, TitleScene, GameScene, MineScene, MineHudScene, HudScene, InventoryScene],
  type: WEBGL,
};

declare global {
  interface Window {
    /** DEV-only hook for headless verification. */
    __game?: Game;
    __GAME_DIAGNOSTICS__?: FarmDiagnostics;
  }
}

const webgl = probeWebGL();

if (!webgl.ok) {
  showWebGLVeil(webgl);
  throw new Error(`WebGL unavailable: ${webgl.reason}`);
}

const game = new Game(config);

game.canvas.addEventListener("webglcontextlost", () => {
  console.error("WebGL context lost");
  showWebGLVeil(
    { blocked: false, ok: false, reason: "context lost" },
    "The browser stopped the graphics (usually low memory).",
  );
});

if (import.meta.env.DEV) {
  window.__game = game;
}

publishDiagnostics(() => readDiagnostics(game));

if (import.meta.env.DEV || isPlaytestRequested()) {
  const DEFAULT_SEED = 12_345;
  let soloSeed: number | null = null;

  const startSolo = (seed: number) => {
    disableSaves();
    soloSeed = seed;

    for (const key of ["Title", "Mine", "MineHud", "Inventory"]) {
      game.scene.stop(key);
    }

    game.scene.start("Game", { mode: "new", solo: { seed } });
  };

  const publishHooks = () => {
    publishTestHooks({
      seed: startSolo,
      setPausedForScreenshot: (paused) => {
        if (paused) {
          game.loop.sleep();
        } else {
          game.loop.wake();
        }
      },
      setState: (name) => {
        if (name !== "active-play") {
          return { state: "unsupported" };
        }

        if (soloSeed === null || !game.scene.isActive("Game")) {
          startSolo(soloSeed ?? DEFAULT_SEED);
        }

        return { state: name };
      },
    });
    publishPlaytest(farmManifest);
  };

  const publishWhenBooted = () => {
    if (game.scene.isActive("Title")) {
      game.events.off("poststep", publishWhenBooted);
      publishHooks();
    }
  };

  game.events.on("poststep", publishWhenBooted);
}

let settle: ReturnType<typeof setTimeout> | undefined;

const refreshScale = () => {
  clearTimeout(settle);
  settle = setTimeout(() => {
    game.scale.refresh();
  }, 150);
};

window.addEventListener("resize", refreshScale);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshScale();
  }
});

const activeWorld = () => {
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

const freeze = () => {
  froze = true;
  game.loop.sleep();
  game.sound.pauseAll();
};

game.events.on("farm-enter-mine", (mine: MineScene) => {
  if (!paused) {
    return;
  }

  mine.setControlsPaused(true);

  if (!froze && !mine.isOnline()) {
    freeze();
  }
});

setPauseHandlers({
  escapePauses: () => {
    if (game.scene.isActive("Inventory")) {
      return false;
    }

    const hud = game.scene.getScene("Hud");

    return !(hud instanceof HudScene && hud.modalOpen);
  },
  onPause: () => {
    paused = true;
    const world = activeWorld();
    world?.setControlsPaused(true);
    Sound.setPaused(true);
    pauseOverlay.show();

    if (world?.isOnline() !== true) {
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
});
