import type { Types } from "phaser";
import { Game, Scale, Scenes, WEBGL } from "phaser";
import { probeWebGL, setPauseHandlers, showWebGLVeil } from "@repo/embed";
import {
  isPlaytestRequested,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";

import { HERO_BY_ID } from "./data/heroes";
import { hide as hidePauseOverlay, show as showPauseOverlay } from "./pause-overlay";
import { createManifest } from "./playtest/manifest";
import type { MobaDiagnostics } from "./playtest/manifest";
import { setSoundPaused, soundDiagnostics } from "./render/audio";
import { BootScene } from "./scenes/boot-scene";
import { GameScene } from "./scenes/game-scene";
import { HudScene } from "./scenes/hud-scene";
import { MenuScene } from "./scenes/menu-scene";

const config: Types.Core.GameConfig = {
  backgroundColor: "#0a0e16",
  disableContextMenu: true,
  parent: "game",
  pixelArt: true,
  roundPixels: true,
  scale: {
    height: "100%",
    mode: Scale.RESIZE,
    width: "100%",
  },
  scene: [BootScene, MenuScene, GameScene, HudScene],
  type: WEBGL,
};

const fontReady = Promise.race([
  document.fonts.load('20px "Lilita One"'),
  // oxlint-disable-next-line no-promise-executor-return, promise/avoid-new -- setTimeout sleep has no promise form in the browser
  new Promise((resolve) => {
    setTimeout(resolve, 1500);
  }),
]);

declare global {
  interface Window {
    /** DEV-only hook for headless verification. */
    __game?: Game;
  }
}

const PLAYTEST_HERO = "stormcaller";

const publishPlaytestContract = (game: Game, activeGame: () => GameScene | null) => {
  const requested = new URLSearchParams(window.location.search).get("hero") ?? "";
  const heroId = HERO_BY_ID[requested] ? requested : PLAYTEST_HERO;
  let seed: number | undefined;
  let frozen = false;

  const startSolo = () => {
    game.scene.stop("Menu");
    game.scene.stop("Hud");
    game.scene.start("Game", { heroId, online: false, seed, skipToLane: true });
  };

  const publish = () => {
    publishTestHooks({
      seed: (next) => {
        seed = next;

        if (activeGame()) {
          startSolo();
        }
      },
      setPausedForScreenshot: (paused) => {
        if (paused === frozen || activeGame()?.isOnline() === true) {
          return;
        }

        frozen = paused;

        if (paused) {
          game.loop.sleep();
        } else {
          game.loop.wake();
        }
      },
      setState: (name) => {
        if (name === "active-play") {
          startSolo();
        }

        return { state: activeGame() || name === "active-play" ? "active-play" : "menu" };
      },
    });
    publishPlaytest<MobaDiagnostics & { audio: ReturnType<typeof soundDiagnostics> }>(
      createManifest(heroId),
    );
  };

  game.events.once("ready", () => {
    const menu = game.scene.getScene("Menu");

    if (game.scene.isActive("Menu") || activeGame()) {
      publish();
    } else {
      menu?.events.once(Scenes.Events.CREATE, publish);
    }
  });
};

const boot = async () => {
  await fontReady;
  const webgl = probeWebGL();

  if (!webgl.ok) {
    console.error(`WebGL unavailable: ${webgl.reason}`);
    showWebGLVeil(webgl);

    return;
  }

  const game = new Game(config);
  game.canvas.addEventListener("webglcontextlost", () => {
    console.error("WebGL context lost");
    showWebGLVeil(
      { blocked: false, ok: false, reason: "context lost" },
      "The browser stopped the graphics (usually low memory).",
    );
  });

  const activeGame = () => {
    const scene = game.scene.getScene("Game");

    return scene instanceof GameScene && game.scene.isActive("Game") ? scene : null;
  };

  publishDiagnostics(() => ({
    ...(activeGame()?.diagnostics() ?? {
      complete: false,
      frame: game.loop.frame,
      phase: "menu",
      score: 0,
    }),
    audio: soundDiagnostics(),
  }));

  if (import.meta.env.DEV) {
    window.__game = game;
  }

  if (import.meta.env.DEV || isPlaytestRequested()) {
    publishPlaytestContract(game, activeGame);
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

  let froze = false;
  setPauseHandlers({
    escapePauses: () => {
      const hud = game.scene.getScene("Hud");

      return !(hud instanceof HudScene && hud.escConsumed);
    },
    onPause: () => {
      const scene = activeGame();
      scene?.setControlsPaused(true);
      setSoundPaused(true);
      showPauseOverlay();

      if (scene?.isOnline() === true) {
        return;
      }

      froze = true;
      game.loop.sleep();
      game.sound.pauseAll();
    },
    onResume: () => {
      activeGame()?.setControlsPaused(false);
      setSoundPaused(false);
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
