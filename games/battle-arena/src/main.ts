// Boot: load assets, show the lobby, then run the chosen match.
import * as THREE from "three";
import { ModelLibrary } from "./render/models";
import { View } from "./render/view";
import { Controls } from "./input/controls";
import { TouchControls } from "./input/touch";
import { GameScene, chosenChamp, chosenName, type SceneOpts } from "./scenes/game-scene";
import { Menu } from "./scenes/menu-scene";
import { MenuStage } from "./render/menu-stage";
import { roomId } from "./net/protocol";
import { DUNGEON_MODELS, MAP_STORAGE_KEY, parseMapData, type MapData } from "./data/map-format";
import { applyMapData } from "./data/map";
import { setDecorOverride } from "./data/decor";

const container = document.getElementById("game")!;
const loadingEl = document.getElementById("loading");
const barFill = document.getElementById("bar-fill");

const CHAMP_MODELS = [
  "Knight",
  "Ranger",
  "Mage",
  "Rogue_Hooded",
  "Paladin_with_Helmet",
  "Witch",
];
const BOSS_MODEL = "Skeleton_Golem";
const ENEMY_MODELS = ["Skeleton_Warrior", "Skeleton_Mage", "Skeleton_Minion", "FrostGolem", "Skeleton_Rogue"];
const WEAPON_MODELS = [
  "sword_2handed", // Garran (knight) — the one 2H greatsword champ
  "dagger", // Vesper (rogue) — dualwield
  "paladin_hammer", // Aurelius — hammer + shield
  "paladin_shield",
  "bow",
  "staff",
  "Skeleton_Staff",
  "Skeleton_Dagger", // skrogue creep
  "FrostGolem_Axe_Large",
  "wand_A",
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
const CLIP_LIBS = [
  "Rig_Medium_General",
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

async function main(): Promise<void> {
  const view = new View(container);
  const lib = new ModelLibrary();
  const bundledMapJob = fetchBundledMap(); // in parallel with the model loads

  const jobs: Promise<void>[] = [
    ...CHAMP_MODELS.map((m) => lib.loadCharacter(m, `./models/characters/${m}.glb`)),
    lib.loadCharacter(BOSS_MODEL, `./models/characters/${BOSS_MODEL}.glb`),
    ...ENEMY_MODELS.map((m) => lib.loadCharacter(m, `./models/characters/${m}.glb`)),
    ...CLIP_LIBS.map((c) => lib.loadClips(`./models/animations/${c}.glb`)),
    ...CLIP_LIBS_LARGE.map((c) => lib.loadClips(`./models/animations/${c}.glb`, "Large/")),
    // scenery gets a matte grade (KayKit ships glossy); the dungeon atlas also
    // takes a warm-dark tint so the pale floor mortar stops reading as neon
    ...PROP_SPECS.map((p) => lib.loadCharacter(p.name, p.url, p.url.includes("/dungeon/") ? { matte: true, tint: 0xcabb9f } : { matte: true })),
    ...WEAPON_MODELS.map((m) => lib.loadCharacter(m, `./models/weapons/${m}.gltf`)),
  ];
  let done = 0;
  await Promise.all(
    jobs.map((j) =>
      j.then(() => {
        done++;
        if (barFill) barFill.style.width = `${Math.round((done / jobs.length) * 100)}%`;
      }),
    ),
  );

  if (loadingEl) loadingEl.style.display = "none";

  const params = new URLSearchParams(location.search);

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
  const launch = (opts: SceneOpts): void => {
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
    if (import.meta.env.DEV) {
      (window as unknown as { __ba: GameScene }).__ba = scene;
      (window as unknown as { __view: View }).__view = view;
    }
    view.renderer.setAnimationLoop((t) => {
      timer.update(t);
      const dt = Math.min(timer.getDelta(), 1 / 30);
      scene.update(dt);
    });
  };

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

void main().catch((e) => {
  console.error(e);
  if (loadingEl) loadingEl.innerHTML = `<div style="color:#ff6a6a;font:14px monospace;padding:20px;text-align:center">Failed to load:<br>${e instanceof Error ? e.message : String(e)}</div>`;
});
