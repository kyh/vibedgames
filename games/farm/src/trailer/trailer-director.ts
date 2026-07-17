// Trailer director for FARM (?trailer=1). Owns the whole staged run: boots a
// deterministic offline farm (no co-op session, saves disabled), restages the
// world per scene through the game's own staging verbs, choreographs the
// farmer via the real movement/action code paths, and drives the camera.
// Loaded lazily from BootScene only when the URL asks for trailer mode —
// nothing in here executes during normal play.

import Phaser from "phaser";
import { runTrailer, type TrailerScene } from "./trailer-shell";
import { GameScene, enableTrailerStaging } from "../scenes/game-scene";
import { MineScene } from "../scenes/mine-scene";
import { MineHudScene } from "../scenes/mine-hud-scene";
import { disableSaves, type AnimalSave } from "../systems/save";
import { store } from "../systems/store";
import { Skills, type SkillId, type SkillsJSON } from "../systems/skills";
import { Sound } from "../render/audio";
import { burst, floatText } from "../render/fx";
import { TILE, MAP_W, MAP_H } from "../config";
import { CELL, FIELD_RECT } from "../world/worldmap";
import { inBounds } from "../world/world";
import { CROPS, isMature, type CropId } from "../data/crops";
import { FISH } from "../data/fish";
import { randomAnimalName, type AnimalKind, type BuildingKind } from "../data/animals";
import type { Item } from "../data/items";

const WORLD_W = MAP_W * TILE;
const WORLD_H = MAP_H * TILE;
/** Mine floor size (mirrors MW/MH in mine-scene.ts). */
const MINE_W = 32;
const MINE_H = 24;

type Tile = { tx: number; ty: number };
/** A scripted target: fixed tile, or a thunk resolving a live (wandering)
 *  entity's tile each tick — null when the entity is gone. */
type TileRef = Tile | (() => Tile | null);

const resolveTile = (r: TileRef): Tile | null => (typeof r === "function" ? r() : r);

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- scene access

function getGame(game: Phaser.Game): GameScene {
  const s = game.scene.getScene("Game");
  if (!(s instanceof GameScene)) throw new Error("trailer: Game scene missing");
  return s;
}

function getMine(game: Phaser.Game): MineScene {
  const s = game.scene.getScene("Mine");
  if (!(s instanceof MineScene)) throw new Error("trailer: Mine scene missing");
  return s;
}

function sceneReady<T extends Phaser.Scene>(scene: T): Promise<T> {
  return new Promise((resolve) => {
    scene.events.once(Phaser.Scenes.Events.CREATE, () => resolve(scene));
  });
}

/** Boot (or reboot) a fresh deterministic solo farm. Runs under the shell's
 *  black, so the heavy world rebuild is never visible. */
async function freshFarm(game: Phaser.Game): Promise<GameScene> {
  const mgr = game.scene;
  if (mgr.isActive("MineHud")) mgr.stop("MineHud");
  if (mgr.isActive("Mine")) mgr.stop("Mine");
  const gs = getGame(game);
  const ready = sceneReady(gs);
  if (mgr.isActive("Game")) gs.scene.restart({ mode: "new" });
  else mgr.start("Game", { mode: "new" });
  await ready;
  // Block stray real input during capture; the director speaks through
  // trailerMove + the public action verbs instead.
  gs.input.enabled = false;
  const kb = gs.input.keyboard;
  if (kb) kb.enabled = false;
  store.energy = 100;
  store.hp = store.maxHp();
  gs.weather = "sunny";
  return gs;
}

async function freshMine(game: Phaser.Game, depth: number): Promise<MineScene> {
  const mgr = game.scene;
  if (mgr.isActive("Game")) mgr.stop("Game");
  const hud = mgr.getScene("MineHud");
  if (hud instanceof MineHudScene) hud.trailerHideUi = true;
  // Deterministic floor layout: mine generation draws from Phaser's global RND.
  Phaser.Math.RND.sow(["vg-trailer-mine"]);
  const mine = getMine(game);
  const ready = sceneReady(mine);
  if (mgr.isActive("Mine")) mine.scene.restart({ depth });
  else mgr.start("Mine", { depth });
  await ready;
  mine.input.enabled = false;
  const kb = mine.input.keyboard;
  if (kb) kb.enabled = false;
  return mine;
}

// ---------------------------------------------------------------- camera rig

function zoomFor(scene: Phaser.Scene, worldWidth: number): number {
  return scene.cameras.main.width / worldWidth;
}

/** Smallest zoom that keeps the whole viewport inside the farm map — clamped
 *  to >=1 so the screen-sized night-tint overlay always covers the frame. */
function fitZoom(scene: Phaser.Scene): number {
  const cam = scene.cameras.main;
  return Math.max(1, cam.width / WORLD_W, cam.height / WORLD_H);
}

function clampCenter(v: number, half: number, max: number): number {
  if (half * 2 >= max) return max / 2;
  return Math.min(max - half, Math.max(half, v));
}

/** Scripted camera: kill follow/bounds, then hard-place per frame (clamped so
 *  no void ever shows — Phaser 4's bounds clamp misbehaves under zoom). */
function lockCam(scene: Phaser.Scene): void {
  const cam = scene.cameras.main;
  cam.stopFollow();
  cam.useBounds = false;
}

function camPlace(scene: Phaser.Scene, zoom: number, cx: number, cy: number): void {
  const cam = scene.cameras.main;
  cam.setZoom(zoom);
  const vw = cam.width / zoom;
  const vh = cam.height / zoom;
  cam.centerOn(clampCenter(cx, vw / 2, WORLD_W), clampCenter(cy, vh / 2, WORLD_H));
}

/** Smoothed follow with a lead offset, clamped to the map every frame — the
 *  built-in follow relies on camera bounds, which misclamp under zoom near the
 *  map's edges (the field sits by the top edge; void would show). */
class TrackCam {
  private cx: number;
  private cy: number;

  constructor(
    private readonly gs: GameScene,
    private readonly zoom: number,
    private readonly offX: number,
    private readonly offY: number,
  ) {
    this.cx = gs.player.x + offX;
    this.cy = gs.player.y + offY;
    lockCam(gs);
    camPlace(gs, zoom, this.cx, this.cy);
  }

  tick(dt: number): void {
    const k = 1 - Math.exp(-dt * 5);
    this.cx += (this.gs.player.x + this.offX - this.cx) * k;
    this.cy += (this.gs.player.y + this.offY - this.cy) * k;
    camPlace(this.gs, this.zoom, this.cx, this.cy);
  }
}

/** The game's own smooth-follow — safe away from map edges. */
function followCam(gs: GameScene, zoom: number, offX: number, offY: number): void {
  const cam = gs.cameras.main;
  cam.setBounds(0, 0, WORLD_W, WORLD_H);
  cam.setZoom(zoom);
  cam.startFollow(gs.player, true, 0.12, 0.12, offX, offY);
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * Math.min(1, Math.max(0, t));

// ---------------------------------------------------------------- staging verbs

function placeFeet(gs: GameScene, tx: number, ty: number): void {
  gs.player.setPosition(tx * TILE + 8, ty * TILE + 12);
}

function stageSkills(levels: Partial<Record<SkillId, number>>): void {
  const s: SkillsJSON = {
    farming: { xp: 0, level: levels.farming ?? 0 },
    mining: { xp: 0, level: levels.mining ?? 0 },
    fishing: { xp: 0, level: levels.fishing ?? 0 },
    foraging: { xp: 0, level: levels.foraging ?? 0 },
    combat: { xp: 0, level: levels.combat ?? 0 },
  };
  store.skills = Skills.fromJSON(s);
}

function selectTool(match: (item: Item) => boolean): void {
  for (let i = 0; i < store.inv.slots.length; i++) {
    const s = store.inv.slots[i];
    if (s && match(s.item)) {
      store.inv.select(i);
      return;
    }
  }
}

/** Remove trees/rocks/forage from the field plateau so plots stage clean. */
function clearFieldObjects(gs: GameScene): void {
  for (const o of [...gs.world.objects]) {
    if (o.type !== "tree" && o.type !== "rock" && o.type !== "forage") continue;
    if (
      o.tx < FIELD_RECT.x0 - 1 ||
      o.tx > FIELD_RECT.x1 + 1 ||
      o.ty < FIELD_RECT.y0 - 1 ||
      o.ty > FIELD_RECT.y1 + 1
    ) {
      continue;
    }
    gs.objSprites.get(o.id)?.destroy();
    gs.objSprites.delete(o.id);
    gs.world.removeObject(o);
  }
}

function clearField(gs: GameScene): void {
  clearFieldObjects(gs);
  for (let ty = FIELD_RECT.y0; ty <= FIELD_RECT.y1; ty++) {
    for (let tx = FIELD_RECT.x0; tx <= FIELD_RECT.x1; tx++) {
      gs.stageTile(tx, ty, { tilled: false, watered: false, crop: null, daysGrown: 0 });
    }
  }
}

/** Plant the whole field, one crop per row (null = bare tilled walking row). */
function stageField(
  gs: GameScene,
  rowCrops: (CropId | null)[],
  growthFrac: number,
  watered: boolean,
): void {
  clearFieldObjects(gs);
  for (let ty = FIELD_RECT.y0; ty <= FIELD_RECT.y1; ty++) {
    const crop = rowCrops[(ty - FIELD_RECT.y0) % rowCrops.length] ?? null;
    for (let tx = FIELD_RECT.x0; tx <= FIELD_RECT.x1; tx++) {
      const days = crop ? Math.round(CROPS[crop].growthDays * growthFrac) : 0;
      gs.stageTile(tx, ty, { tilled: true, watered, crop, daysGrown: days });
    }
  }
}

function buildingHome(gs: GameScene, type: BuildingKind): { x: number; y: number } {
  const o = gs.world.objects.find((b) => b.type === type);
  if (o) return { x: o.tx * TILE + 8, y: (o.ty + 2) * TILE };
  return { x: 12 * TILE, y: 12 * TILE };
}

type Herd = {
  barn: { x: number; y: number };
  coop: { x: number; y: number };
  cow: number;
  sheep: number;
  hen: number;
};

/** Populate barn + coop with a small herd (real spawn path, wander anchors at
 *  their actual homes so nothing drifts across the map). Returns the ids of
 *  the pettable stars so scripts can track them as they wander. */
function stageHerd(gs: GameScene): Herd {
  const barn = buildingHome(gs, "barn");
  const coop = buildingHome(gs, "coop");
  const add = (kind: AnimalKind, building: BuildingKind, dx: number, dy: number): number => {
    const home = building === "barn" ? barn : coop;
    const id = store.animalSeq++;
    const d: AnimalSave = {
      id,
      kind,
      building,
      name: randomAnimalName(store.animalSeq),
      friendship: 60,
      fed: true,
      producedToday: false,
      x: home.x + dx,
      y: home.y + dy,
    };
    gs.animals.stageSpawn(d);
    return id;
  };
  const cow = add("cow", "barn", -14, 4);
  const sheep = add("sheep", "barn", 16, 10);
  add("pig", "barn", 2, 22);
  const hen = add("chicken", "coop", -12, 2);
  add("chicken", "coop", 10, 8);
  add("chicken", "coop", -2, 18);
  add("duck", "coop", 20, 14);
  return { barn, coop, cow, sheep, hen };
}

// ---------------------------------------------------------------- tile scans

/** Straight walk between two tiles with every step tile open. */
function lineOpen(gs: GameScene, a: Tile, b: Tile): boolean {
  let { tx, ty } = a;
  for (let guard = 0; guard < 40; guard++) {
    if (tx === b.tx && ty === b.ty) return true;
    if (tx !== b.tx) tx += Math.sign(b.tx - tx);
    else ty += Math.sign(b.ty - ty);
    if (!inBounds(tx, ty) || gs.world.isSolidTile(tx, ty)) return false;
  }
  return false;
}

/** A walk-in start tile with a clean straight approach to `stand`. */
function approachFrom(gs: GameScene, stand: Tile): Tile {
  const candidates = [
    { tx: stand.tx - 3, ty: stand.ty },
    { tx: stand.tx + 3, ty: stand.ty },
    { tx: stand.tx, ty: stand.ty + 3 },
    { tx: stand.tx - 2, ty: stand.ty + 2 },
  ];
  for (const c of candidates) {
    if (inBounds(c.tx, c.ty) && !gs.world.isSolidTile(c.tx, c.ty) && lineOpen(gs, c, stand)) {
      return c;
    }
  }
  return stand;
}

/** Top-left of the nearest all-walkable w×h rect around (cx,cy). */
function findOpenPatch(
  gs: GameScene,
  cx: number,
  cy: number,
  w: number,
  h: number,
  maxR: number,
): Tile | null {
  const ok = (x0: number, y0: number): boolean => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (!inBounds(x, y) || gs.world.isSolidTile(x, y)) return false;
      }
    }
    return true;
  };
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x0 = cx + dx - ((w / 2) | 0);
        const y0 = cy + dy - ((h / 2) | 0);
        if (ok(x0, y0)) return { tx: x0, ty: y0 };
      }
    }
  }
  return null;
}

type FishSpot = {
  stand: Tile;
  target: Tile;
};

/** Best casting spot: walkable bank with 3 straight tiles of open water,
 *  preferring the pond by Finn's place and casting toward the camera. */
function findFishingSpot(gs: GameScene): FishSpot {
  const dirs = [
    { x: 0, y: 1, bias: 0 },
    { x: 1, y: 0, bias: 6 },
    { x: -1, y: 0, bias: 6 },
    { x: 0, y: -1, bias: 10 },
  ];
  let best: FishSpot | null = null;
  let bd = Infinity;
  for (let ty = 1; ty < MAP_H - 1; ty++) {
    for (let tx = 1; tx < MAP_W - 1; tx++) {
      if (gs.world.isSolidTile(tx, ty)) continue;
      for (const d of dirs) {
        const x3 = tx + d.x * 3;
        const y3 = ty + d.y * 3;
        if (!inBounds(x3, y3)) continue;
        let water = true;
        for (let k = 1; k <= 3 && water; k++) {
          if (gs.world.cellKind(tx + d.x * k, ty + d.y * k) !== CELL.water) water = false;
        }
        if (!water) continue;
        const dist = Math.abs(tx - 70) + Math.abs(ty - 33) + d.bias;
        if (dist < bd) {
          bd = dist;
          best = { stand: { tx, ty }, target: { tx: tx + d.x * 2, ty: ty + d.y * 2 } };
        }
      }
    }
  }
  return best ?? { stand: { tx: 31, ty: 18 }, target: { tx: 31, ty: 20 } };
}

function findOpenNearMine(mine: MineScene, tx: number, ty: number): Tile {
  for (let r = 0; r <= 5; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = Math.min(MINE_W - 2, Math.max(1, tx + dx));
        const y = Math.min(MINE_H - 2, Math.max(1, ty + dy));
        if (mine.isOpenTile(x, y)) return { tx: x, ty: y };
      }
    }
  }
  return { tx: (MINE_W / 2) | 0, ty: 3 }; // cleared area under the entry ladder
}

/** Center of the largest open 5×5 arena nearest the floor's middle. */
function findArena(mine: MineScene): Tile {
  let best: Tile | null = null;
  let bd = Infinity;
  for (let ty = 2; ty <= MINE_H - 7; ty++) {
    for (let tx = 2; tx <= MINE_W - 7; tx++) {
      let ok = true;
      for (let y = ty; y < ty + 5 && ok; y++) {
        for (let x = tx; x < tx + 5 && ok; x++) {
          if (!mine.isOpenTile(x, y)) ok = false;
        }
      }
      if (!ok) continue;
      const d = Math.abs(tx + 2 - MINE_W / 2) + Math.abs(ty + 2 - MINE_H / 2);
      if (d < bd) {
        bd = d;
        best = { tx: tx + 2, ty: ty + 2 };
      }
    }
  }
  return best ?? { tx: (MINE_W / 2) | 0, ty: 3 };
}

// ---------------------------------------------------------------- actor script

type Steerable = {
  player: Phaser.GameObjects.Sprite;
  trailerMove: { x: number; y: number; run: boolean } | null;
};

/** Steer feet toward a tile through the real movement code; true = arrived. */
function moveToward(s: Steerable, tx: number, ty: number, run = false): boolean {
  const gx = tx * TILE + 8;
  const gy = ty * TILE + 12;
  const dx = gx - s.player.x;
  const dy = gy - s.player.y;
  const d = Math.hypot(dx, dy);
  if (d < 3) {
    s.trailerMove = null;
    return true;
  }
  s.trailerMove = { x: dx / d, y: dy / d, run };
  return false;
}

type Step =
  | { kind: "walk"; at: TileRef; run?: boolean }
  | { kind: "select"; match: (item: Item) => boolean }
  | { kind: "act"; at: TileRef }
  | { kind: "pet"; at: TileRef }
  | { kind: "gift"; at: TileRef }
  | { kind: "face"; at: TileRef }
  | { kind: "pause"; ms: number };

/** Ticks a declarative step list through the farm's real verbs. Every step is
 *  time-boxed so a blocked walk or missed target degrades to the next beat
 *  instead of stalling the shot. */
class FarmScript {
  private i = 0;
  private phase = 0;
  private t = 0;

  constructor(
    private readonly gs: GameScene,
    private readonly steps: Step[],
  ) {}

  tick(dt: number): void {
    const gs = this.gs;
    const step = this.steps[this.i];
    if (!step) {
      gs.trailerMove = null;
      return;
    }
    this.t += dt;
    if (step.kind === "select") {
      selectTool(step.match);
      this.next();
      return;
    }
    if (step.kind === "pause") {
      gs.trailerMove = null;
      if (this.t * 1000 >= step.ms) this.next();
      return;
    }
    const at = resolveTile(step.at);
    if (!at) {
      this.next(); // target vanished — fail soft to the next beat
      return;
    }
    switch (step.kind) {
      case "walk":
        if (moveToward(gs, at.tx, at.ty, step.run ?? false) || this.t > 2.5) this.next();
        break;
      case "face":
        gs.faceTowards(at.tx, at.ty);
        this.next();
        break;
      case "act":
        gs.trailerMove = null;
        if (this.phase === 0) {
          if (!gs.acting) {
            gs.faceTowards(at.tx, at.ty);
            gs.tryAction({ tx: at.tx, ty: at.ty });
            this.phase = 1;
            this.t = 0;
          } else if (this.t > 2) {
            this.next();
          }
        } else if (this.phase === 1) {
          if (gs.acting) this.phase = 2;
          else if (this.t > 0.3) this.next(); // action refused — fail soft
        } else if (!gs.acting) {
          this.next();
        }
        break;
      case "pet":
        gs.trailerMove = null;
        gs.faceTowards(at.tx, at.ty);
        if (gs.animals.tryPet(at.tx, at.ty) || this.t > 1.2) this.next();
        break;
      case "gift":
        gs.trailerMove = null;
        gs.faceTowards(at.tx, at.ty);
        if (gs.npcs.tryTalk(at.tx, at.ty, store.inv.selectedItem())) {
          floatText(gs, at.tx * TILE + 8, at.ty * TILE - 10, "♥", "#ff8aa8");
          this.next();
        } else if (this.t > 2) {
          this.next();
        }
        break;
    }
  }

  private next(): void {
    this.i += 1;
    this.phase = 0;
    this.t = 0;
    this.gs.trailerMove = null;
  }
}

// ---------------------------------------------------------------- scenes

const MATURE_ROWS: (CropId | null)[] = [
  "wheat",
  "sunflower",
  "cauliflower",
  "pumpkin",
  "beetroot",
  null, // bare southern row doubles as the farmer's walking path
];

/** COLD OPEN — scything down a ripe pumpkin row, pops trailing behind. */
function sceneColdOpen(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let cam: TrackCam | null = null;
  return {
    id: "cold-open-harvest",
    duration: 4000,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ farming: 2 });
      gs.timeMin = 720;
      stageField(gs, MATURE_ROWS, 1, true);
      // the strip behind the farmer reads already-harvested
      for (let tx = FIELD_RECT.x0; tx <= 11; tx++) {
        gs.stageTile(tx, 9, { tilled: true, watered: false, crop: null, daysGrown: 0 });
      }
      placeFeet(gs, 10, 9);
      // manual clamped follow: the field hugs the map's top edge, where the
      // built-in bounds clamp shows void under zoom
      cam = new TrackCam(gs, zoomFor(gs, 560), 34, -4);
      gs.trailerMove = { x: 1, y: 0, run: false };
      await wait(350); // pre-roll: reveal lands mid-stride
    },
    run: (_t, dt) => {
      const g = gs;
      if (!g) return;
      cam?.tick(dt / 1000);
      if (g.acting) return;
      const feet = g.feetTile();
      const cs = g.world.crops.get(g.world.idx(feet.tx + 1, feet.ty));
      if (cs && isMature(CROPS[cs.crop], cs.daysGrown)) {
        g.trailerMove = null;
        g.faceTowards(feet.tx + 1, feet.ty);
        g.tryAction({ tx: feet.tx + 1, ty: feet.ty });
      } else {
        g.trailerMove = { x: 1, y: 0, run: false };
      }
    },
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

/** Sunrise establishing wide: chimney smoke, herd waking, slow eastward drift. */
function sceneDawn(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let zoom = 1;
  return {
    id: "dawn-farm",
    duration: 3000,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({});
      gs.timeMin = 400; // 6:40 — warm dawn grade
      stageField(gs, MATURE_ROWS, 1, true);
      stageHerd(gs);
      placeFeet(gs, 12, 11);
      script = new FarmScript(gs, [
        { kind: "walk", at: { tx: 16, ty: 11 } },
        { kind: "walk", at: { tx: 20, ty: 11 } },
      ]);
      lockCam(gs);
      zoom = Math.max(zoomFor(gs, 1000), fitZoom(gs));
      camPlace(gs, zoom, 540, 300);
      gs.trailerMove = { x: 1, y: 0, run: false };
      await wait(400);
    },
    run: (t, dt) => {
      if (!gs) return;
      // drift east: field + farmhouse first, the waking herd rolls in late
      camPlace(gs, zoom, lerp(540, 700, t / 3000), 300);
      script?.tick(dt / 1000);
    },
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

// Scenes 3–5 share one fixed frame on one plot: dirt → tended → gold.
const PLOT_CAM = { cx: 15.5 * TILE, cy: 158, worldW: 400 } as const;

function plotCam(gs: GameScene): void {
  lockCam(gs);
  camPlace(gs, zoomFor(gs, PLOT_CAM.worldW), PLOT_CAM.cx, PLOT_CAM.cy);
}

/** SOW — hoe bites, seeds go in, the grid forms. */
function sceneTill(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let alive = false;
  return {
    id: "verb-till",
    duration: 2500,
    card: { title: "SOW" },
    setup: async () => {
      gs = await freshFarm(game);
      alive = true;
      stageSkills({});
      gs.day = 1;
      gs.timeMin = 480;
      clearField(gs);
      gs.stageTile(15, 10, { tilled: true, watered: false, crop: null, daysGrown: 0 });
      gs.stageTile(16, 10, { tilled: true, watered: false, crop: "parsnip", daysGrown: 0 });
      gs.stageTile(17, 10, { tilled: true, watered: false, crop: null, daysGrown: 0 });
      placeFeet(gs, 12, 9);
      plotCam(gs);
      script = new FarmScript(gs, [
        { kind: "walk", at: { tx: 14, ty: 9 } },
        { kind: "select", match: (it) => it.kind === "tool" && it.tool === "hoe" },
        { kind: "act", at: { tx: 14, ty: 10 } }, // till — dirt burst
        { kind: "select", match: (it) => it.kind === "seed" },
        { kind: "act", at: { tx: 14, ty: 10 } }, // plant
        { kind: "walk", at: { tx: 15, ty: 9 } },
        { kind: "act", at: { tx: 15, ty: 10 } }, // plant
      ]);
      // The card holds ~1400ms after setup resolves, with the game loop live
      // beneath it — start the walk-in late so the reveal catches mid-stride
      // (an immediate trailerMove would overshoot the plot under the card).
      const g = gs;
      void wait(1150).then(() => {
        if (alive) g.trailerMove = { x: 1, y: 0, run: false };
      });
    },
    run: (_t, dt) => script?.tick(dt / 1000),
    teardown: () => {
      alive = false;
      if (gs) gs.trailerMove = null;
    },
  };
}

/** TEND — watering-can sweep down the seedling row, soil darkening. */
function sceneWater(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  return {
    id: "verb-water",
    duration: 2500,
    caption: "TEND",
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({});
      gs.day = 1;
      gs.timeMin = 600;
      clearField(gs);
      for (let tx = 13; tx <= 17; tx++) {
        gs.stageTile(tx, 10, { tilled: true, watered: false, crop: "parsnip", daysGrown: 1 });
      }
      placeFeet(gs, 12, 9);
      plotCam(gs);
      script = new FarmScript(gs, [
        { kind: "walk", at: { tx: 14, ty: 9 } },
        { kind: "select", match: (it) => it.kind === "tool" && it.tool === "can" },
        { kind: "act", at: { tx: 14, ty: 10 } },
        { kind: "walk", at: { tx: 15, ty: 9 } },
        { kind: "act", at: { tx: 15, ty: 10 } },
        { kind: "walk", at: { tx: 16, ty: 9 } },
        { kind: "act", at: { tx: 16, ty: 10 } },
      ]);
      gs.trailerMove = { x: 1, y: 0, run: false };
      await wait(300);
    },
    run: (_t, dt) => script?.tick(dt / 1000),
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

/** GROW — the same row bursting; bounty pull, rule-of-three payoff. */
function sceneGrow(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  return {
    id: "verb-grow",
    duration: 2500,
    caption: "GROW",
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ farming: 4 });
      gs.day = 1;
      gs.timeMin = 720;
      clearField(gs);
      const row: CropId[] = ["kale", "sunflower", "pumpkin", "sunflower", "cauliflower"];
      row.forEach((crop, i) => {
        const g = gs;
        if (g) g.stageTile(13 + i, 10, { tilled: true, watered: true, crop, daysGrown: 99 });
      });
      placeFeet(gs, 12, 9);
      plotCam(gs);
      script = new FarmScript(gs, [
        { kind: "walk", at: { tx: 14, ty: 9 } },
        { kind: "act", at: { tx: 14, ty: 10 } },
        { kind: "walk", at: { tx: 15, ty: 9 } },
        { kind: "act", at: { tx: 15, ty: 10 } },
        { kind: "walk", at: { tx: 16, ty: 9 } },
        { kind: "act", at: { tx: 16, ty: 10 } },
      ]);
      gs.trailerMove = { x: 1, y: 0, run: false };
      await wait(300);
    },
    run: (_t, dt) => script?.tick(dt / 1000),
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

/** A YEAR IN THE VALLEY — locked-off frame, four seasons swap in place. */
function sceneSeasons(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let seg = 0;
  const stageSeason = (g: GameScene, idx: number): void => {
    if (idx === 0) {
      g.day = 1;
      g.weather = "sunny";
      g.timeMin = 450;
      stageField(g, ["parsnip", "carrot", "potato", "parsnip", "carrot", null], 0.45, true);
    } else if (idx === 1) {
      g.day = 30;
      g.weather = "sunny";
      g.timeMin = 720;
      stageField(g, ["radish", "kale", "sunflower", "cabbage", "radish", null], 1, true);
    } else if (idx === 2) {
      g.day = 60;
      g.weather = "sunny";
      g.timeMin = 1120;
      stageField(g, ["pumpkin", "beetroot", "pumpkin", "wheat", "beetroot", null], 1, false);
    } else {
      g.day = 90;
      g.weather = "snow";
      g.timeMin = 570;
      stageField(g, [null], 0, false); // bare rows asleep under the cold
    }
  };
  return {
    id: "seasons-timelapse",
    duration: 6000,
    card: { title: "A YEAR IN THE VALLEY" },
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({});
      seg = 0;
      stageSeason(gs, 0);
      placeFeet(gs, 21, 11);
      gs.faceTowards(20, 11); // the farmer stands watch through the year
      lockCam(gs);
      camPlace(gs, Math.max(zoomFor(gs, 620), fitZoom(gs)), 260, 170);
    },
    run: (t) => {
      const g = gs;
      if (!g) return;
      const idx = Math.min(3, Math.floor(t / 1500));
      if (idx !== seg) {
        seg = idx;
        stageSeason(g, idx);
      }
      if (idx === 3) {
        // winter: light snowfall through the real particle system
        const view = g.cameras.main.worldView;
        for (let i = 0; i < 2; i++) {
          burst(
            g,
            view.x + Math.random() * view.width,
            view.y + Math.random() * view.height * 0.5,
            {
              colors: [0xffffff, 0xeef4ff],
              count: 1,
              speed: 10,
              gravity: 16,
              size: 2,
              life: 1600,
            },
          );
        }
      }
    },
  };
}

/** BENEATH THE VALLEY — torch-dark floor 6, skeleton pack, real combat. */
function sceneMine(game: Phaser.Game): TrailerScene {
  let mine: MineScene | null = null;
  return {
    id: "mine-combat",
    duration: 4000,
    card: { title: "BENEATH THE VALLEY" },
    setup: async () => {
      mine = await freshMine(game, 6);
      stageSkills({ combat: 4, mining: 3 });
      store.hp = store.maxHp();
      store.energy = 100;
      selectTool((it) => it.kind === "tool" && it.tool === "sword");
      const c = findArena(mine);
      mine.player.setPosition(c.tx * TILE + 8, c.ty * TILE + 8);
      // ~5.5 tiles out: inside the 110px aggro radius even after the open-tile
      // ring shifts a spawn, far enough that the pack converges under the card
      // and arrives at sword's reach right as the reveal lands
      const offsets = [
        { dx: -5, dy: -1 },
        { dx: 5, dy: -2 },
        { dx: -4, dy: 3 },
        { dx: 5, dy: 3 },
      ];
      const m = mine;
      m.trailerStageEnemies(
        offsets.map((o) => {
          const s = findOpenNearMine(m, c.tx + o.dx, c.ty + o.dy);
          return { tx: s.tx, ty: s.ty, hp: 26 };
        }),
      );
    },
    run: () => {
      const m = mine;
      if (!m) return;
      const e = m.trailerNearestEnemy();
      if (!e) {
        m.trailerMove = null;
        return;
      }
      const dx = e.x - m.player.x;
      const dy = e.y - m.player.y;
      const d = Math.hypot(dx, dy);
      if (d > 18) {
        m.trailerMove = { x: dx / d, y: dy / d, run: false };
      } else {
        m.trailerMove = null;
        m.tryAction(); // internally debounced while a swing is playing
      }
    },
    teardown: () => {
      if (mine) mine.trailerMove = null;
    },
  };
}

/** Golden-hour cast → bite → reel → catch, played perfectly by the machine. */
function sceneFishing(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  return {
    id: "fishing",
    // +1s over the beat sheet: a hard-fish reel could push the land past 4s
    // and cut the celebration — the beat's payoff. 5s guarantees it on camera.
    duration: 5000,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ fishing: 9 }); // wide catch zone
      gs.timeMin = 1110; // 18:30 — golden hour
      const spot = findFishingSpot(gs);
      placeFeet(gs, spot.stand.tx, spot.stand.ty);
      selectTool((it) => it.kind === "tool" && it.tool === "rod");
      lockCam(gs);
      // Wide enough that the reel meter (screen-anchored right of centre and
      // scaled by camera zoom) stays inside the 16:9 stage; angler and bobber
      // sit left of centre, meter fills the right.
      const cx = ((spot.stand.tx + spot.target.tx) / 2) * TILE + 44;
      const cy = ((spot.stand.ty + spot.target.ty) / 2) * TILE + 2;
      camPlace(gs, zoomFor(gs, 520), cx, cy);
      gs.fishing.trailerAuto = true;
      // Pin a mid-difficulty fish: skill 9 biases rollFish hard toward
      // difficulty 4-5, whose reel can outlast the scene. Bass lands by ~t4s
      // worst case, so the caught pose + burst always plays out on camera.
      gs.fishing.trailerFish = FISH.bass;
      gs.fishing.startCast(spot.target.tx, spot.target.ty);
      await wait(250); // reveal mid-cast arc
    },
  };
}

/** Barn morning: pet the cow, the sheep, then a hen — heart chain. */
function sceneAnimals(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  return {
    id: "animals",
    duration: 3500,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({});
      gs.timeMin = 780;
      const g = gs;
      const herd = stageHerd(g);
      // the stars wander — every approach/pet resolves their live tile
      const beside = (id: number) => (): Tile | null => {
        const t = g.animals.trailerTileOf(id);
        return t ? { tx: t.tx, ty: t.ty + 1 } : null;
      };
      const at = (id: number) => (): Tile | null => g.animals.trailerTileOf(id);
      const cow0 = g.animals.trailerTileOf(herd.cow) ?? { tx: 61, ty: 12 };
      const start = approachFrom(g, { tx: cow0.tx, ty: cow0.ty + 1 });
      placeFeet(g, start.tx, start.ty);
      followCam(g, zoomFor(g, 440), 0, -6);
      script = new FarmScript(g, [
        { kind: "walk", at: beside(herd.cow) },
        { kind: "pet", at: at(herd.cow) },
        { kind: "pause", ms: 420 },
        { kind: "walk", at: beside(herd.sheep) },
        { kind: "pet", at: at(herd.sheep) },
        { kind: "pause", ms: 350 },
        { kind: "walk", at: beside(herd.hen), run: true }, // dash to the coop pen
        { kind: "pet", at: at(herd.hen) },
      ]);
      const first = beside(herd.cow)();
      if (first) moveToward(g, first.tx, first.ty);
      await wait(300);
    },
    run: (_t, dt) => script?.tick(dt / 1000),
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

/** Village square at noon: three neighbours milling, a gift, a heart. */
function sceneVillage(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  return {
    id: "village-life",
    duration: 3500,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({});
      gs.timeMin = 780;
      const g = gs;
      const patch = findOpenPatch(g, 56, 31, 5, 4, 10) ?? { tx: 54, ty: 30 };
      const willow = { tx: patch.tx + 2, ty: patch.ty + 1 };
      g.npcs.placeNpc("willow", willow.tx, willow.ty);
      g.npcs.placeNpc("finn", patch.tx + 4, patch.ty + 2);
      g.npcs.placeNpc("hazel", patch.tx, patch.ty + 2);
      store.inv.add({ kind: "forage", forage: "mushroom_red" }, 3);
      selectTool((it) => it.kind === "forage");
      placeFeet(g, patch.tx + 2, patch.ty + 3);
      lockCam(g);
      camPlace(g, zoomFor(g, 460), willow.tx * TILE + 8, (willow.ty + 1) * TILE);
      const willowAt = (): Tile | null => g.npcs.trailerTileOf("willow");
      const belowWillow = (): Tile | null => {
        const t = willowAt();
        return t ? { tx: t.tx, ty: t.ty + 1 } : null;
      };
      script = new FarmScript(g, [
        { kind: "walk", at: belowWillow },
        { kind: "gift", at: willowAt }, // Willow loves forage
        { kind: "pause", ms: 700 },
        { kind: "walk", at: { tx: patch.tx + 4, ty: patch.ty + 3 } }, // drift on toward Finn
      ]);
      const first = belowWillow();
      if (first) moveToward(g, first.tx, first.ty);
      await wait(350);
    },
    run: (_t, dt) => script?.tick(dt / 1000),
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

/** Dusk settling over the farmhouse; fireflies rise as the farmer heads home. */
function sceneNight(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let fireflyAcc = 0;
  return {
    id: "night-cozy",
    duration: 3000,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({});
      gs.timeMin = 1170; // 19:30, sliding into night below
      stageField(gs, MATURE_ROWS, 1, true);
      fireflyAcc = 0;
      placeFeet(gs, 27, 17);
      lockCam(gs);
      script = new FarmScript(gs, [
        { kind: "walk", at: { tx: 29, ty: 17 } },
        { kind: "walk", at: { tx: 31, ty: 16 } },
        { kind: "face", at: { tx: 31, ty: 15 } }, // at the door, facing home
      ]);
      moveToward(gs, 29, 17);
      await wait(300);
    },
    run: (t, dt) => {
      const g = gs;
      if (!g) return;
      g.timeMin = lerp(1170, 1440, t / 3000); // 19:30 → midnight
      camPlace(g, zoomFor(g, lerp(500, 380, smooth(t / 3000))), 504, 226);
      script?.tick(dt / 1000);
      fireflyAcc += dt;
      if (fireflyAcc > 150) {
        fireflyAcc = 0;
        const view = g.cameras.main.worldView;
        burst(
          g,
          view.x + Math.random() * view.width,
          view.y + view.height * (0.4 + Math.random() * 0.5),
          {
            colors: [0xffe27a, 0xfff3c4, 0xffd34d],
            count: 1,
            speed: 7,
            gravity: -6,
            size: 2,
            life: 1400,
          },
        );
      }
    },
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

/** RELEASE — one last harvest, then the slow pull back over everything built. */
function sceneFullFarm(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let startCx = 0;
  let startCy = 0;
  return {
    id: "full-farm",
    duration: 5000,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ farming: 4 });
      gs.timeMin = 1140; // deep sunset amber
      stageField(gs, MATURE_ROWS, 1, true);
      stageHerd(gs);
      placeFeet(gs, 18, 11);
      startCx = gs.player.x;
      startCy = gs.player.y - 8;
      lockCam(gs);
      camPlace(gs, zoomFor(gs, 430), startCx, startCy);
      script = new FarmScript(gs, [
        { kind: "act", at: { tx: 18, ty: 10 } }, // one last pop as the pull starts
      ]);
    },
    run: (t, dt) => {
      const g = gs;
      if (!g) return;
      script?.tick(dt / 1000);
      const cam = g.cameras.main;
      const k = smooth(t / 5000);
      const endW = cam.width / fitZoom(g);
      const w = lerp(430, endW, k);
      camPlace(g, cam.width / w, lerp(startCx, WORLD_W / 2, k), lerp(startCy, WORLD_H / 2, k));
    },
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

// ---------------------------------------------------------------- entry

export function startTrailer(game: Phaser.Game): void {
  enableTrailerStaging();
  disableSaves();
  document.getElementById("veil")?.classList.add("hidden");
  // The shell's click gate is the audio-unlocking user gesture; resume the
  // procedural audio context inside it so music + SFX play from scene one.
  Sound.muted = false;
  window.addEventListener("pointerdown", () => Sound.resume(), { capture: true });

  runTrailer({
    title: "FARM",
    url: "farm.vibedgames.com",
    tagline: "Your little life awaits",
    accent: "#ffd34d",
    fontFamily: "ui-monospace, monospace",
    vignette: false, // keep the pixel art clean edge-to-edge
    cutMs: 320, // gentler dips — the calm is the message
    scenes: [
      sceneColdOpen(game),
      sceneDawn(game),
      sceneTill(game),
      sceneWater(game),
      sceneGrow(game),
      sceneSeasons(game),
      sceneMine(game),
      sceneFishing(game),
      sceneAnimals(game),
      sceneVillage(game),
      sceneNight(game),
      sceneFullFarm(game),
    ],
  });
}
