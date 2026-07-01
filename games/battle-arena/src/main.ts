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

const container = document.getElementById("game")!;
const loadingEl = document.getElementById("loading");
const barFill = document.getElementById("bar-fill");

const CHAMP_MODELS = [
  "Knight",
  "Ranger",
  "Mage",
  "Rogue_Hooded",
  "Barbarian",
  "Necromancer",
  "Paladin",
  "BlackKnight",
  "Vampire",
  "Witch",
  "Barbarian_Large", // render-only enrage swap for barbarian R (Rig_Large)
];
const BOSS_MODEL = "Skeleton_Golem";
const ENEMY_MODELS = ["Skeleton_Warrior", "Skeleton_Mage", "Skeleton_Minion", "FrostGolem", "OrcRaider", "Skeleton_Rogue"];
const WEAPON_MODELS = [
  "sword_1handed",
  "shield_round",
  "bow",
  "staff",
  "dagger",
  "axe_2handed",
  "Skeleton_Staff",
  "paladin_hammer",
  "paladin_shield",
  "BlackKnight_Sword_Large",
  "BlackKnight_Shield_Large",
  "Vampire_Sword",
  "FrostGolem_Axe_Large",
  "wand_A",
  "Skeleton_Dagger",
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
const DUNGEON_NAMES = [
  "floor_tile_large",
  "wall",
  "pillar",
  "pillar_decorated",
  "column",
  "torch_lit",
  "crate_large",
  "barrel_large",
  "banner_red",
  "banner_blue",
  "floor_foundation_allsides",
  "floor_foundation_corner",
  "stairs",
  "wall_corner",
  // Sunken Court buildout
  "wall_broken",
  "wall_gated",
  "wall_pillar",
  "stairs_wide",
  "floor_tile_large_rocks",
  "floor_dirt_large",
  "floor_tile_small_weeds_A",
  "rubble_half",
  "rocks",
  "rocks_small",
  "rocks_gold",
  "chest_gold",
  "chest_large_gold",
  "chest_mimic",
  "chest",
  "coin_stack_small",
  "coin_stack_medium",
  "keg",
  "keg_decorated",
  "crates_stacked",
  "trunk_large_A",
  "post",
  "candle_triple",
  "sword_shield_broken",
  "scaffold_frame_small",
  "bucket_pickaxes",
  "banner_thin_yellow",
  "banner_white",
];
type PropSpec = { name: string; url: string };
const PROP_SPECS: PropSpec[] = [
  ...DUNGEON_NAMES.map((m) => ({ name: m, url: `./models/dungeon/${m}.gltf` })),
  { name: "tree_a", url: "./models/forest/Tree_1_B_Color1.gltf" },
  { name: "tree_b", url: "./models/forest/Tree_2_C_Color1.gltf" },
  { name: "tree_c", url: "./models/forest/Tree_5_A_Color1.gltf" },
  { name: "tree_bare", url: "./models/forest/Tree_Bare_1_A_Color1.gltf" },
  { name: "bush_a", url: "./models/forest/Bush_1_C_Color1.gltf" },
  { name: "bush_b", url: "./models/forest/Bush_2_B_Color1.gltf" },
  { name: "rock_a", url: "./models/forest/Rock_3_D_Color1.gltf" },
  { name: "rock_b", url: "./models/forest/Rock_5_C_Color1.gltf" },
  { name: "grass_a", url: "./models/forest/Grass_1_A_Singlesided_Color1.gltf" },
  { name: "vampire_throne", url: "./models/props/Vampire_Throne.gltf" },
  { name: "paladin_statue", url: "./models/props/paladin_statue.gltf" },
  { name: "mushroom", url: "./models/props/Mushroom.gltf" }, // Witch hex-polymorph body
];

async function main(): Promise<void> {
  const view = new View(container);
  const lib = new ModelLibrary();

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
    // Orc pack ships self-contained ".gltf.glb" binaries — url form differs.
    lib.loadCharacter("Orc_Axe", "./models/weapons/Orc_Axe.gltf.glb"),
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

  const timer = new THREE.Timer();
  const launch = (opts: SceneOpts): void => {
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

  // Boot flow: bare URL = instant solo vs bots (time-to-first-input ≈ load
  // time; first click grabs pointer lock). The lobby lives at ?menu; the old
  // ?auto/?online deep links keep working. Champ/name persist in localStorage.
  const params = new URLSearchParams(location.search);
  if (!params.has("menu")) {
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
