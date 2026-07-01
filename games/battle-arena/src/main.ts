// Boot: load assets, show the lobby, then run the chosen match.
import * as THREE from "three";
import { ModelLibrary } from "./render/models";
import { View } from "./render/view";
import { Controls } from "./input/controls";
import { TouchControls } from "./input/touch";
import { GameScene, chosenChamp, type SceneOpts } from "./scenes/game-scene";
import { Menu } from "./scenes/menu-scene";
import { MenuStage } from "./render/menu-stage";
import { CHAMPIONS } from "./data/champions";
import { roomId } from "./net/protocol";

const container = document.getElementById("game")!;
const loadingEl = document.getElementById("loading");
const barFill = document.getElementById("bar-fill");

const CHAMP_MODELS = ["Knight", "Ranger", "Mage", "Rogue_Hooded", "Barbarian", "Necromancer"];
const BOSS_MODEL = "Skeleton_Golem";
const ENEMY_MODELS = ["Skeleton_Warrior", "Skeleton_Mage", "Skeleton_Minion"];
const WEAPON_MODELS = ["sword_1handed", "shield_round", "bow", "staff", "dagger", "axe_2handed", "Skeleton_Staff"];
const CLIP_LIBS = [
  "Rig_Medium_General",
  "Rig_Medium_MovementBasic",
  "Rig_Medium_MovementAdvanced",
  "Rig_Medium_CombatMelee",
  "Rig_Medium_CombatRanged",
  "Rig_Medium_Special", // Spawn / Taunt / Skeletons_* flourishes
];
const PROP_MODELS = [
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
];

async function main(): Promise<void> {
  const view = new View(container);
  const lib = new ModelLibrary();

  const jobs: Promise<void>[] = [
    ...CHAMP_MODELS.map((m) => lib.loadCharacter(m, `./models/characters/${m}.glb`)),
    lib.loadCharacter(BOSS_MODEL, `./models/characters/${BOSS_MODEL}.glb`),
    ...ENEMY_MODELS.map((m) => lib.loadCharacter(m, `./models/characters/${m}.glb`)),
    ...CLIP_LIBS.map((c) => lib.loadClips(`./models/animations/${c}.glb`)),
    ...PROP_MODELS.map((m) => lib.loadCharacter(m, `./models/dungeon/${m}.gltf`)),
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

  // quick-start hooks for testing / deep links
  const params = new URLSearchParams(location.search);
  if (params.has("auto") || params.has("online")) {
    launch({
      champId: chosenChamp(),
      name: params.get("name") ?? "Player",
      online: params.has("online"),
      room: roomId(params.get("room") ?? ""),
    });
  } else {
    // 3D character-select lobby: render the champion row behind the DOM overlay
    const canvas = view.renderer.domElement;
    let menu: Menu;
    const stage = new MenuStage(view.renderer, lib, (id) => menu.setSelected(id));
    const onMove = (e: PointerEvent): void => stage.onPointerMove(e.clientX, e.clientY);
    const onClick = (e: MouseEvent): void => void stage.onClick(e.clientX, e.clientY);
    const onResize = (): void => stage.resize();
    menu = new Menu({
      initial: CHAMPIONS[0]!.id,
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
