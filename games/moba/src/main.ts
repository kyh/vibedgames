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

// A ranged carry: last hits land from behind the creep line, so a playtester's
// first minute is about the lane, not about surviving the melee scrum.
const PLAYTEST_HERO = "stormcaller";

/** See plugins/tooling/skills/playtest/references/model-playtest.md. Every hook
 *  starts a SOLO match against bots — never a staged state in a live room. */
const publishPlaytestContract = (game: Game, activeGame: () => GameScene | null): void => {
  const requested = new URLSearchParams(window.location.search).get("hero") ?? "";
  const heroId = HERO_BY_ID[requested] ? requested : PLAYTEST_HERO;
  let seed: number | undefined;
  let frozen = false;
  const startSolo = (): void => {
    game.scene.stop("Menu");
    game.scene.stop("Hud");
    game.scene.start("Game", { heroId, online: false, seed, skipToLane: true });
  };
  const publish = (): void => {
    publishTestHooks({
      seed: (next) => {
        seed = next;
        if (activeGame()) {
          startSolo();
        }
      },
      setPausedForScreenshot: (paused) => {
        if (paused === frozen || activeGame()?.isOnline()) {
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
  // The hooks are what a playtest waits on, and a match started before the
  // boot scene has loaded its textures renders nothing — so they appear only
  // once the menu (which boot hands over to) is up.
  game.events.once("ready", () => {
    const menu = game.scene.getScene("Menu");
    if (game.scene.isActive("Menu") || activeGame()) {
      publish();
    } else {
      menu?.events.once(Scenes.Events.CREATE, publish);
    }
  });
};

const boot = async (): Promise<void> => {
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
  const activeGame = (): GameScene | null => {
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
  // freezing the host would stall every client; there only the local player's
  // input stops. `froze` ensures onResume only wakes what onPause put to sleep.
  let froze = false;
  setPauseHandlers({
    // Escape closes an open shop/scoreboard/guide first; only a bare Escape pauses.
    escapePauses: () => {
      const hud = game.scene.getScene("Hud");
      return !(hud instanceof HudScene && hud.escConsumed);
    },
    onPause: () => {
      const scene = activeGame();
      scene?.setControlsPaused(true);
      setSoundPaused(true);
      showPauseOverlay();
      if (scene?.isOnline()) {
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
