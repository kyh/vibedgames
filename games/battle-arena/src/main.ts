// Boot: load the lobby's assets, show the lobby, then run the chosen match.
//
// Asset loading is two-phase. The champion-select lobby needs six champion
// models, the weapons they hold and one idle clip library — ~3 MB. The arena
// (enemies, the dungeon prop vocabulary, the combat/movement clip libraries)
// is another ~13 MB that nothing on screen can show yet, so it is fetched on
// the first sign of intent and awaited when a match actually launches. A phone
// on cellular reaches champion select in a quarter of the bytes, and a visitor
// who never taps never pays for the arena at all.
import {
  createTouchControls,
  isOfflineRequested,
  notifyGameStarted,
  setPauseHandlers,
} from "@repo/embed";
import * as THREE from "three";
import { ModelLibrary } from "./render/models";
import { View } from "./render/view";
import { createPauseOverlay } from "./render/pause-overlay";
import { Controls } from "./input/controls";
import { TouchControls } from "./input/touch";
import { GameScene, chosenChamp, chosenName, type SceneOpts } from "./scenes/game-scene";
import { Menu } from "./scenes/menu-scene";
import { MenuStage } from "./render/menu-stage";
import { roomId } from "./net/protocol";
import { DUNGEON_MODELS, MAP_STORAGE_KEY, parseMapData, type MapData } from "./data/map-format";
import { applyMapData } from "./data/map";
import { setDecorOverride } from "./data/decor";

// Dev-console handles (assigned only in DEV builds).
declare global {
  interface Window {
    __ba?: GameScene;
    __view?: View;
  }
}

const container = document.getElementById("game")!;
const loadingEl = document.getElementById("loading");
const barFill = document.getElementById("bar-fill");

const CHAMP_MODELS = ["Knight", "Ranger", "Mage", "Rogue_Hooded", "Paladin_with_Helmet", "Witch"];
const BOSS_MODEL = "Skeleton_Golem";
const ENEMY_MODELS = ["Skeleton_Warrior", "Skeleton_Mage", "Skeleton_Minion", "FrostGolem"];
// what the roster holds in champion select — loaded with the champions
const CHAMP_WEAPON_MODELS = [
  "sword_2handed", // Garran (knight) — the one 2H greatsword champ
  "dagger", // Vesper (rogue) — dualwield
  "paladin_hammer", // Aurelius — hammer + shield
  "paladin_shield",
  "bow",
  "staff",
  "wand_A",
];
const ARENA_WEAPON_MODELS = [
  "Skeleton_Staff",
  "FrostGolem_Axe_Large",
  // Fantasy Weapons Bits — the creep-drop loot pickups (world-view syncCoins)
  "sword_A",
  "sword_D",
  "axe_A",
  "hammer_B",
  "dagger_A",
  "spear_A",
  "staff_B",
  "wand_B",
];
// Idle_B lives here, and it is the only clip the 3D roster plays.
const LOBBY_CLIP_LIB = "Rig_Medium_General";
const CLIP_LIBS = [
  "Rig_Medium_MovementBasic",
  "Rig_Medium_MovementAdvanced",
  "Rig_Medium_CombatMelee",
  "Rig_Medium_CombatRanged",
  "Rig_Medium_Special", // Spawn / Taunt / Skeletons_* flourishes
];
// Rig_Large clip names collide with Rig_Medium (Idle_A, Running_A, …), so these
// load under a "Large/" key prefix and resolve per-character via clipPrefix.
const CLIP_LIBS_LARGE = [
  "Rig_Large_General",
  "Rig_Large_MovementBasic",
  "Rig_Large_MovementAdvanced",
  "Rig_Large_CombatMelee",
  "Rig_Large_Simulation", // Flexing — the boss taunt fallback
];
// the dungeon prop vocabulary lives in data/map-format.ts (shared with the
// map editor's palette, which must not import this boot module)
type PropSpec = { name: string; url: string };
const PROP_SPECS: PropSpec[] = [
  ...DUNGEON_MODELS.map((m) => ({ name: m, url: `./models/dungeon/${m}.gltf` })),
  { name: "vampire_throne", url: "./models/props/Vampire_Throne.gltf" },
  { name: "paladin_statue", url: "./models/props/paladin_statue.gltf" },
  { name: "mushroom", url: "./models/props/Mushroom.gltf" }, // Witch hex-polymorph body
];

/** Fetch the bundled custom map (public/maps/default.json). Absence or an
 *  invalid file = keep the procedural arena — today's behavior exactly. */
async function fetchBundledMap(): Promise<MapData | null> {
  try {
    const res = await fetch("./maps/default.json");
    if (!res.ok) return null;
    const parsed = parseMapData(await res.json());
    if (!parsed) console.warn("[map] maps/default.json is invalid — using the procedural arena");
    return parsed;
  } catch {
    return null;
  }
}

/** The editor's localStorage draft (offline test loop). */
function readLocalMapDraft(): MapData | null {
  const raw = localStorage.getItem(MAP_STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed = parseMapData(JSON.parse(raw));
    if (!parsed) console.warn(`[map] localStorage ${MAP_STORAGE_KEY} is invalid — ignoring`);
    return parsed;
  } catch {
    console.warn(`[map] localStorage ${MAP_STORAGE_KEY} is not JSON — ignoring`);
    return null;
  }
}

/** Await `jobs`, driving the boot progress bar as they land. */
async function runJobs(jobs: Promise<void>[]): Promise<void> {
  let done = 0;
  if (barFill) barFill.style.width = "0%";
  const track = async (job: Promise<void>): Promise<void> => {
    await job;
    done++;
    if (barFill) barFill.style.width = `${Math.round((done / jobs.length) * 100)}%`;
  };
  await Promise.all(jobs.map(track));
}

function showLoading(on: boolean): void {
  if (loadingEl) loadingEl.style.display = on ? "flex" : "none";
}

/** A load that never resolves leaves the veil up forever, so both the boot and
 *  the deferred arena load report through here instead. */
function showFailure(cause: unknown): void {
  console.error(cause);
  if (!loadingEl) return;
  // Trailer mode hides the veil via html.trailer; an inline display beats that
  // rule, so a failed load still surfaces instead of dying to a black frame.
  loadingEl.style.display = "flex";
  loadingEl.innerHTML = `<div style="color:#ff6a6a;font:14px monospace;padding:20px;text-align:center">Failed to load:<br>${cause instanceof Error ? cause.message : String(cause)}</div>`;
}

async function main(): Promise<void> {
  const view = new View(container);
  const lib = new ModelLibrary();
  const bundledMapJob = fetchBundledMap(); // in parallel with the model loads

  await runJobs([
    ...CHAMP_MODELS.map((m) => lib.loadCharacter(m, `./models/characters/${m}.glb`)),
    ...CHAMP_WEAPON_MODELS.map((m) => lib.loadCharacter(m, `./models/weapons/${m}.gltf`)),
    lib.loadClips(`./models/animations/${LOBBY_CLIP_LIB}.glb`),
  ]);

  let arenaJob: Promise<void> | null = null;
  let arenaReady = false;
  const loadArenaOnce = async (): Promise<void> => {
    await runJobs([
      lib.loadCharacter(BOSS_MODEL, `./models/characters/${BOSS_MODEL}.glb`),
      ...ENEMY_MODELS.map((m) => lib.loadCharacter(m, `./models/characters/${m}.glb`)),
      ...CLIP_LIBS.map((c) => lib.loadClips(`./models/animations/${c}.glb`)),
      ...CLIP_LIBS_LARGE.map((c) => lib.loadClips(`./models/animations/${c}.glb`, "Large/")),
      // scenery gets a matte grade (KayKit ships glossy); the dungeon atlas also
      // takes a warm-dark tint so the pale floor mortar stops reading as neon
      ...PROP_SPECS.map((p) =>
        lib.loadCharacter(
          p.name,
          p.url,
          p.url.includes("/dungeon/") ? { matte: true, tint: 0xcabb9f } : { matte: true },
        ),
      ),
      ...ARENA_WEAPON_MODELS.map((m) => lib.loadCharacter(m, `./models/weapons/${m}.gltf`)),
    ]);
    arenaReady = true;
  };
  const loadArena = (): Promise<void> => (arenaJob ??= loadArenaOnce());

  const params = new URLSearchParams(location.search);

  // Every branch below the lobby renders the arena itself, so they pay for it
  // up front behind the same progress bar the champion set just used.
  if (
    params.has("trailer") ||
    params.has("editor") ||
    params.has("viewer") ||
    params.has("auto") ||
    params.has("online")
  ) {
    await loadArena();
  }
  showLoading(false);

  // ── Gameplay trailer (?trailer=1): scripted, letterboxed, offline-staged
  //    showcase; its own scene/loop + a separate vite chunk so gameplay never
  //    pays for trailer code. No menus, no pause wiring, no network. ──
  if (params.has("trailer")) {
    const { runBattleArenaTrailer } = await import("./trailer/trailer-director");
    // Same handle the editor and viewer branches publish — headless trailer
    // checks need the renderer and camera to measure what was actually drawn.
    if (import.meta.env.DEV) Object.assign(window, { __view: view });
    runBattleArenaTrailer(view, lib);
    window.addEventListener("resize", () => view.resize());
    return;
  }

  // ── Map editor (?editor=1): its own scene + input; a separate vite chunk so
  //    gameplay never pays for the editor code ──
  if (params.has("editor")) {
    const { EditorScene } = await import("./scenes/editor-scene");
    const editor = new EditorScene(view, lib);
    await editor.init();
    if (import.meta.env.DEV) Object.assign(window, { __ed: editor, __view: view });
    const edTimer = new THREE.Timer();
    view.renderer.setAnimationLoop((t) => {
      edTimer.update(t);
      editor.update(Math.min(edTimer.getDelta(), 1 / 30));
    });
    window.addEventListener("resize", () => view.resize());
    return;
  }

  // ── Character & animation viewer (?viewer=1): its own scene + input; a
  //    separate vite chunk so gameplay never pays for the viewer code ──
  if (params.has("viewer")) {
    const { ViewerScene } = await import("./scenes/viewer-scene");
    const viewer = new ViewerScene(view, lib);
    viewer.init();
    if (import.meta.env.DEV) Object.assign(window, { __vw: viewer, __view: view });
    const vwTimer = new THREE.Timer();
    view.renderer.setAnimationLoop((t) => {
      vwTimer.update(t);
      viewer.update(Math.min(vwTimer.getDelta(), 1 / 30));
    });
    window.addEventListener("resize", () => view.resize());
    return;
  }

  // ── Custom map resolution (applied per-launch, before the world/renderer
  //    read OBSTACLES/decor): the bundled maps/default.json applies everywhere
  //    (identical for every client, so online-safe); a localStorage draft (the
  //    editor's TEST loop) overrides it in OFFLINE matches only — colliders
  //    are sim state and must match across clients. ──
  const bundledMap = await bundledMapJob;
  const localMapDraft = readLocalMapDraft();

  const timer = new THREE.Timer();
  // Wrapper-pause bookkeeping (see setPauseHandlers below): which match loop is
  // live, whether it's online, and whether onPause actually froze it.
  let activeScene: GameScene | null = null;
  let onlineMatch = false;
  let froze = false;
  const matchLoop = (t: number): void => {
    timer.update(t);
    const dt = Math.min(timer.getDelta(), 1 / 30);
    activeScene?.update(dt);
  };
  const startMatch = (opts: SceneOpts): void => {
    notifyGameStarted();
    onlineMatch = opts.online;
    const custom = (opts.online ? null : localMapDraft) ?? bundledMap;
    if (custom) {
      applyMapData(custom);
      setDecorOverride(custom.props);
    }
    // create input only when a match starts, so menu clicks never grab the
    // pointer (Controls' mousedown requests pointer lock).
    const controls = new Controls(view.renderer.domElement);
    const touch = new TouchControls();
    const scene = new GameScene(view, lib, controls, opts, touch);
    activeScene = scene;
    // Escape and M are keyboard-only, so a phone otherwise has no way to pause
    // the arena or ever hear it (sound is opt-in, see render/audio.ts).
    createTouchControls({
      mute: { get: () => scene.audio.isMuted, set: (next) => scene.audio.setMuted(next) },
    });
    if (import.meta.env.DEV) {
      window.__ba = scene;
      window.__view = view;
    }
    view.renderer.setAnimationLoop(matchLoop);
  };
  const startWhenLoaded = async (opts: SceneOpts): Promise<void> => {
    showLoading(true);
    await loadArena();
    showLoading(false);
    startMatch(opts);
  };
  const launch = (requested: SceneOpts): void => {
    // The one choke point for online matches — the lobby's PLAY ONLINE button
    // and the `?online[&room=]` deep link both land here, so `?offline=1` is
    // enforced once and no socket can be opened behind it. Dropping the room
    // too keeps the offline branch's localStorage map draft applicable.
    const opts: SceneOpts =
      isOfflineRequested() && requested.online
        ? { ...requested, online: false, room: "" }
        : requested;
    if (arenaReady) {
      startMatch(opts);
      return;
    }
    void startWhenLoaded(opts).catch(showFailure);
  };

  // Wrapper-requested pause (registered once at boot — the embed package
  // no-ops pause until notifyGameStarted has fired, i.e. only during a match).
  // HARD RULE: never freeze a live online session — it's host-authoritative
  // and shared with another client, so stopping our loop just desyncs/stalls
  // them; the wrapper's overlay alone is the pause UI there. Offline is safe:
  // sim time only ever advances inside matchLoop (world.ts step() does
  // `w.now += dt * 1000`; abilities/PendingStrike run off that sim clock, not
  // Date.now/performance.now), so simply not scheduling the loop holds
  // everything — cooldowns included — dead in place with nothing to unwind.
  // timer.reset() on resume avoids a huge first delta from the real-time gap
  // (belt-and-suspenders: matchLoop already clamps dt to 1/30 regardless).
  const pauseOverlay = createPauseOverlay({ isLive: () => onlineMatch });
  setPauseHandlers({
    onPause: () => {
      pauseOverlay.show();
      if (onlineMatch || !activeScene) return;
      froze = true;
      view.renderer.setAnimationLoop(null);
      activeScene.pauseAudio();
    },
    onResume: () => {
      pauseOverlay.hide();
      if (!froze) return;
      froze = false;
      timer.reset();
      view.renderer.setAnimationLoop(matchLoop);
      activeScene?.resumeAudio();
    },
  });

  // Boot flow: bare URL = champion-select lobby (the right default for a cold
  // shared link — first-time visitors choose a champion instead of being
  // dropped into a match). Quick-start deep-links skip it: ?auto = instant solo
  // vs bots, ?online[&room=] = instant online. Champ/name persist in localStorage.
  if (params.has("auto") || params.has("online")) {
    launch({
      champId: chosenChamp(),
      name: chosenName(),
      online: params.has("online"),
      room: roomId(params.get("room") ?? ""),
    });
  } else {
    // 3D character-select lobby: render the champion row behind the DOM overlay
    const canvas = view.renderer.domElement;
    const initialChamp = chosenChamp(); // remember the last pick across visits
    let menu: Menu;
    const stage = new MenuStage(view.renderer, lib, (id) => menu.setSelected(id));
    const onMove = (e: PointerEvent): void => stage.onPointerMove(e.clientX, e.clientY);
    const onClick = (e: MouseEvent): void => void stage.onClick(e.clientX, e.clientY);
    const onResize = (): void => stage.resize();
    menu = new Menu({
      initial: initialChamp,
      onSelect: (id) => stage.select(id),
      onStart: (opts) => {
        view.renderer.setAnimationLoop(null);
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("click", onClick);
        window.removeEventListener("resize", onResize);
        stage.dispose();
        launch(opts);
      },
    });
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("click", onClick);
    window.addEventListener("resize", onResize);
    // First touch or keypress in the lobby = someone who is going to play, so
    // the arena streams in behind champion select and START usually finds it
    // already there. A visitor who only looks never downloads it.
    const warmArena = (): void => {
      window.removeEventListener("pointerdown", warmArena);
      window.removeEventListener("keydown", warmArena);
      // loadArena is memoised, so a failure here is reported by launch()'s own
      // handler; swallow it now rather than raising it over champion select.
      void loadArena().catch(() => undefined);
    };
    window.addEventListener("pointerdown", warmArena);
    window.addEventListener("keydown", warmArena);
    stage.select(initialChamp); // sync the 3D row with the persisted pick
    const menuTimer = new THREE.Timer();
    view.renderer.setAnimationLoop((t) => {
      menuTimer.update(t);
      stage.update(Math.min(menuTimer.getDelta(), 1 / 30));
      stage.render();
    });
  }

  window.addEventListener("resize", () => view.resize());
}

void main().catch(showFailure);
