import { readPreference } from "./data/preferences";
import {
  createTouchControls,
  isOfflineRequested,
  notifyGameStarted,
  probeWebGL,
  setPauseHandlers,
  showWebGLVeil,
} from "@repo/embed";
import {
  isPlaytestRequested,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";
import * as THREE from "three";
import { ModelLibrary } from "./render/models";
import { View } from "./render/view";
import { createPauseOverlay } from "./render/pause-overlay";
import { Controls } from "./input/controls";
import { TouchControls } from "./input/touch";
import { GameScene, chosenChamp, chosenName } from "./scenes/game-scene";
import type { SceneOpts } from "./scenes/game-scene";
import { Menu } from "./scenes/menu-scene";
import { MenuStage } from "./render/menu-stage";
import { roomId } from "./net/protocol";
import { DUNGEON_MODELS, MAP_STORAGE_KEY, parseMapData } from "./data/map-format";
import { applyMapData } from "./data/map";
import { setDecorOverride } from "./data/decor";
import { buildPlaytestManifest } from "./playtest/manifest";
import type { BattleDiagnostics } from "./playtest/manifest";

const MENU_DIAGNOSTICS = {
  audio: null,
  complete: false,
  fight: null,
  kills: 0,
  online: null,
  phase: "menu",
  player: undefined,
  score: 0,
} as const;

/** What `window.__GAME_DIAGNOSTICS__` reads: the live scene's, or the menu's before a match. */
export type BattleArenaDiagnostics = { frame: number } & (
  | ReturnType<GameScene["diagnostics"]>
  | typeof MENU_DIAGNOSTICS
);

declare global {
  interface Window {
    __GAME_DIAGNOSTICS__?: BattleArenaDiagnostics;
    __ba?: GameScene;
    __view?: View;
  }
}

const requireEl = (selector: string) => {
  const node = document.querySelector<HTMLElement>(selector);

  if (!node) {
    throw new Error(`missing ${selector}`);
  }

  return node;
};

const container = requireEl("#game");
const MAX_FRAME_S = 0.25;
const loadingEl = document.querySelector<HTMLElement>("#loading");
const barFill = document.querySelector<HTMLElement>("#bar-fill");

const CHAMP_MODELS = ["Knight", "Ranger", "Mage", "Rogue_Hooded", "Paladin_with_Helmet", "Witch"];
const BOSS_MODEL = "Skeleton_Golem";
const ENEMY_MODELS = ["Skeleton_Warrior", "Skeleton_Mage", "Skeleton_Minion", "FrostGolem"];

const CHAMP_WEAPON_MODELS = [
  "sword_2handed",
  "dagger",
  "paladin_hammer",
  "paladin_shield",
  "bow",
  "staff",
  "wand_A",
];

const ARENA_WEAPON_MODELS = [
  "Skeleton_Staff",
  "FrostGolem_Axe_Large",
  "sword_A",
  "sword_D",
  "axe_A",
  "hammer_B",
  "dagger_A",
  "spear_A",
  "staff_B",
  "wand_B",
];

const LOBBY_CLIP_LIB = "Rig_Medium_General";

const CLIP_LIBS = [
  "Rig_Medium_MovementBasic",
  "Rig_Medium_MovementAdvanced",
  "Rig_Medium_CombatMelee",
  "Rig_Medium_CombatRanged",
  "Rig_Medium_Special",
];

const CLIP_LIBS_LARGE = [
  "Rig_Large_General",
  "Rig_Large_MovementBasic",
  "Rig_Large_MovementAdvanced",
  "Rig_Large_CombatMelee",
  "Rig_Large_Simulation",
];

interface PropSpec {
  name: string;
  url: string;
}

const PROP_SPECS: PropSpec[] = [
  ...DUNGEON_MODELS.map((m) => ({ name: m, url: `./models/dungeon/${m}.gltf` })),
  { name: "vampire_throne", url: "./models/props/Vampire_Throne.gltf" },
  { name: "paladin_statue", url: "./models/props/paladin_statue.gltf" },
  { name: "mushroom", url: "./models/props/Mushroom.gltf" },
];

const fetchBundledMap = async () => {
  try {
    const res = await fetch("./maps/default.json");

    if (!res.ok) {
      return null;
    }

    const parsed = parseMapData(await res.json());

    if (!parsed) {
      console.warn("[map] maps/default.json is invalid — using the procedural arena");
    }

    return parsed;
  } catch {
    return null;
  }
};

const readLocalMapDraft = () => {
  const raw = readPreference(MAP_STORAGE_KEY);

  if (raw === null) {
    return null;
  }

  try {
    const parsed = parseMapData(JSON.parse(raw));

    if (!parsed) {
      console.warn(`[map] localStorage ${MAP_STORAGE_KEY} is invalid — ignoring`);
    }

    return parsed;
  } catch {
    console.warn(`[map] localStorage ${MAP_STORAGE_KEY} is not JSON — ignoring`);

    return null;
  }
};

const runJobs = async (jobs: Promise<void>[]) => {
  let done = 0;

  if (barFill) {
    barFill.style.width = "0%";
  }

  const track = async (job: Promise<void>) => {
    await job;
    done += 1;

    if (barFill) {
      barFill.style.width = `${Math.round((done / jobs.length) * 100)}%`;
    }
  };

  await Promise.all(jobs.map(track));
};

const showLoading = (on: boolean) => {
  if (loadingEl) {
    loadingEl.style.display = on ? "flex" : "none";
  }
};

const showFailure = (cause: unknown) => {
  console.error(cause);

  if (!loadingEl) {
    return;
  }

  loadingEl.style.display = "flex";
  loadingEl.innerHTML = `<div style="color:#ff6a6a;font:14px monospace;padding:20px;text-align:center">Failed to load:<br>${cause instanceof Error ? cause.message : String(cause)}</div>`;
};

const main = async () => {
  const webgl = probeWebGL();

  if (!webgl.ok) {
    console.error(`WebGL unavailable: ${webgl.reason}`);
    showWebGLVeil(webgl);

    return;
  }

  const view = new View(container);
  view.renderer.domElement.addEventListener("webglcontextlost", () => {
    console.error("WebGL context lost");
    showWebGLVeil(
      { blocked: false, ok: false, reason: "context lost" },
      "The browser stopped the graphics (usually low memory).",
    );
  });
  const lib = new ModelLibrary();
  const bundledMapJob = fetchBundledMap();

  await runJobs([
    ...CHAMP_MODELS.map(async (m) => {
      await lib.loadCharacter(m, `./models/characters/${m}.glb`);
    }),
    ...CHAMP_WEAPON_MODELS.map(async (m) => {
      await lib.loadCharacter(m, `./models/weapons/${m}.gltf`);
    }),
    lib.loadClips(`./models/animations/${LOBBY_CLIP_LIB}.glb`),
  ]);

  let arenaJob: Promise<void> | null = null;
  let arenaReady = false;

  const loadArenaOnce = async () => {
    await runJobs([
      lib.loadCharacter(BOSS_MODEL, `./models/characters/${BOSS_MODEL}.glb`),
      ...ENEMY_MODELS.map(async (m) => {
        await lib.loadCharacter(m, `./models/characters/${m}.glb`);
      }),
      ...CLIP_LIBS.map(async (c) => {
        await lib.loadClips(`./models/animations/${c}.glb`);
      }),
      ...CLIP_LIBS_LARGE.map(async (c) => {
        await lib.loadClips(`./models/animations/${c}.glb`, "Large/");
      }),
      ...PROP_SPECS.map(async (p) => {
        await lib.loadCharacter(
          p.name,
          p.url,
          p.url.includes("/dungeon/") ? { matte: true, tint: 0xca_bb_9f } : { matte: true },
        );
      }),
      ...ARENA_WEAPON_MODELS.map(async (m) => {
        await lib.loadCharacter(m, `./models/weapons/${m}.gltf`);
      }),
    ]);
    arenaReady = true;
  };

  const loadArena = async () => {
    await (arenaJob ??= loadArenaOnce());
  };

  const params = new URLSearchParams(location.search);
  const playtest = isPlaytestRequested();

  if (
    params.has("trailer") ||
    params.has("editor") ||
    params.has("viewer") ||
    params.has("auto") ||
    params.has("online") ||
    playtest
  ) {
    await loadArena();
  }

  showLoading(false);

  if (params.has("trailer")) {
    const { runBattleArenaTrailer } = await import("./trailer/trailer-director");

    if (import.meta.env.DEV) {
      Object.assign(window, { __view: view });
    }

    runBattleArenaTrailer(view, lib);
    window.addEventListener("resize", () => {
      view.resize();
    });

    return;
  }

  if (params.has("editor")) {
    const { EditorScene } = await import("./scenes/editor-scene");
    const editor = new EditorScene(view, lib);
    await editor.init();

    if (import.meta.env.DEV) {
      Object.assign(window, { __ed: editor, __view: view });
    }

    const edTimer = new THREE.Timer();
    view.renderer.setAnimationLoop((t) => {
      edTimer.update(t);
      editor.update(Math.min(edTimer.getDelta(), 1 / 30));
    });
    window.addEventListener("resize", () => {
      view.resize();
    });

    return;
  }

  if (params.has("viewer")) {
    const { ViewerScene } = await import("./scenes/viewer-scene");
    const viewer = new ViewerScene(view, lib);
    viewer.init();

    if (import.meta.env.DEV) {
      Object.assign(window, { __view: view, __vw: viewer });
    }

    const vwTimer = new THREE.Timer();
    view.renderer.setAnimationLoop((t) => {
      vwTimer.update(t);
      viewer.update(Math.min(vwTimer.getDelta(), 1 / 30));
    });
    window.addEventListener("resize", () => {
      view.resize();
    });

    return;
  }

  const bundledMap = await bundledMapJob;
  const localMapDraft = readLocalMapDraft();

  const timer = new THREE.Timer();
  let activeScene: GameScene | null = null;
  let frame = 0;
  publishDiagnostics<BattleArenaDiagnostics>(() => ({
    frame,
    ...(activeScene?.diagnostics() ?? MENU_DIAGNOSTICS),
  }));
  let froze = false;

  const matchLoop = (t: number) => {
    frame += 1;
    timer.update(t);
    activeScene?.update(Math.min(timer.getDelta(), MAX_FRAME_S));
  };

  const startMatch = (opts: SceneOpts) => {
    notifyGameStarted();
    const custom = (opts.online ? null : localMapDraft) ?? bundledMap;

    if (custom) {
      applyMapData(custom);
      setDecorOverride(custom.props);
    }

    const controls = new Controls(view.renderer.domElement, {
      absoluteAim: import.meta.env.DEV || playtest,
    });

    const touch = new TouchControls();
    const scene = new GameScene(view, lib, controls, opts, touch);
    activeScene = scene;
    createTouchControls();

    if (import.meta.env.DEV) {
      window.__ba = scene;
      window.__view = view;
    }

    view.renderer.setAnimationLoop(matchLoop);
  };

  const startWhenLoaded = async (opts: SceneOpts) => {
    try {
      showLoading(true);
      await loadArena();
      showLoading(false);
      startMatch(opts);
    } catch (error) {
      showFailure(error);
    }
  };

  const launch = (requested: SceneOpts) => {
    const opts: SceneOpts =
      isOfflineRequested() && requested.online
        ? { ...requested, online: false, room: "" }
        : requested;

    if (arenaReady) {
      startMatch(opts);

      return;
    }

    void startWhenLoaded(opts);
  };

  const pauseOverlay = createPauseOverlay({
    isLive: () => activeScene?.isLive ?? false,
    mute: {
      get: () => activeScene?.audio.isMuted ?? true,
      set: (next) => activeScene?.audio.setMuted(next),
    },
  });

  setPauseHandlers({
    escapePauses: () => activeScene !== null && !activeScene.isGuideOpen,
    onPause: () => {
      pauseOverlay.show();
      activeScene?.pauseAudio();

      if (!activeScene || activeScene.isLive) {
        return;
      }

      froze = true;
      view.renderer.setAnimationLoop(null);
    },
    onResume: () => {
      pauseOverlay.hide();
      activeScene?.resumeAudio();

      if (!froze) {
        return;
      }

      froze = false;
      timer.reset();
      view.renderer.setAnimationLoop(matchLoop);
    },
  });

  let leaveLobby: (() => void) | null = null;

  if (import.meta.env.DEV || playtest) {
    let seed: number | undefined;
    publishTestHooks({
      seed: (next) => {
        seed = next;
        activeScene?.restartSolo(next);
      },
      setPausedForScreenshot: (paused) => {
        if (activeScene?.isOffline !== true) {
          return;
        }

        timer.reset();
        view.renderer.setAnimationLoop(paused ? null : matchLoop);
      },
      setState: (name) => {
        if (name !== "active-play" || activeScene?.isOffline === false) {
          return;
        }

        if (activeScene) {
          activeScene.restartSolo(seed ?? 0);
        } else {
          leaveLobby?.();
          launch({
            champId: chosenChamp(),
            name: chosenName(),
            online: false,
            room: "",
            seed,
            skipIntro: true,
          });
        }

        return { state: name };
      },
    });
    publishPlaytest<BattleDiagnostics>(buildPlaytestManifest(chosenChamp()));
  }

  if (params.has("auto") || params.has("online")) {
    launch({
      champId: chosenChamp(),
      name: chosenName(),
      online: params.has("online"),
      room: roomId(params.get("room") ?? ""),
    });
  } else {
    const canvas = view.renderer.domElement;
    const initialChamp = chosenChamp();
    let menu: Menu | null = null;
    const stage = new MenuStage(view.renderer, lib, (id) => menu?.setSelected(id));

    const onMove = (e: PointerEvent) => {
      stage.onPointerMove(e.clientX, e.clientY);
    };

    const onResize = () => {
      stage.resize();
    };

    const disposeLobby = () => {
      view.renderer.setAnimationLoop(null);
      canvas.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", onResize);
      stage.dispose();
    };

    const lobby = new Menu({
      initial: initialChamp,
      onSelect: (id) => {
        stage.select(id);
      },
      onStart: (opts) => {
        disposeLobby();
        launch(opts);
      },
    });

    menu = lobby;
    leaveLobby = () => {
      leaveLobby = null;
      lobby.remove();
      disposeLobby();
    };

    canvas.addEventListener("pointermove", onMove);
    window.addEventListener("resize", onResize);

    const warmArena = async () => {
      await loadArena().catch(() => null);
    };

    const onWarm = () => {
      window.removeEventListener("pointerdown", onWarm);
      window.removeEventListener("keydown", onWarm);
      void warmArena();
    };

    window.addEventListener("pointerdown", onWarm);
    window.addEventListener("keydown", onWarm);
    stage.select(initialChamp);
    const menuTimer = new THREE.Timer();
    view.renderer.setAnimationLoop((t) => {
      if (!menu) {
        return;
      }

      menu.update();

      if (!menu.active) {
        return;
      }

      menuTimer.update(t);
      stage.update(Math.min(menuTimer.getDelta(), 1 / 30));
      stage.render();
    });
  }

  window.addEventListener("resize", () => {
    view.resize();
  });
};

const boot = async () => {
  try {
    await main();
  } catch (error) {
    showFailure(error);
  }
};

void boot();
