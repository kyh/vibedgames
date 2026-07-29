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
import { Skills, xpToNext, type SkillId, type SkillsJSON } from "../systems/skills";
import { weatherForDay } from "../systems/weather";
import { Sound } from "../render/audio";
import { burst, floatText } from "../render/fx";
import { TILE, MAP_W, MAP_H, FARM_SEED } from "../config";
import { CELL, FIELD_RECT } from "../world/worldmap";
import { inBounds } from "../world/world";
import { CROPS, isMature, type CropId } from "../data/crops";
import { FISH } from "../data/fish";
import { randomAnimalName, type AnimalKind, type BuildingKind } from "../data/animals";
import type { Item, OreId } from "../data/items";
import { RemoteFarmers } from "../net/remote-farmers";
import type { PlayerMap } from "@vibedgames/multiplayer";

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
  // Villagers are the player's own sprite with a pale tint, and Willow's home
  // sits inside the farm plot — unstaged, she reads as a motionless duplicate
  // of the hero in every farm shot. Scenes that want a villager opt in.
  gs.npcs.trailerVisible([]);
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
  // Set before boot: create() re-applies it, so the lockout survives the
  // scene restart descend() runs mid-shot.
  mine.trailerNoInput = true;
  const ready = sceneReady(mine);
  if (mgr.isActive("Mine")) mine.scene.restart({ depth });
  else mgr.start("Mine", { depth });
  await ready;
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

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
/** Smoothstep. Clamped, because a shot whose ease finishes before the shot does
 *  feeds it t>1 — and the raw cubic turns back on itself there, reversing the
 *  camera move it was easing. */
const smooth = (t: number): number => {
  const s = clamp01(t);
  return s * s * (3 - 2 * s);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * clamp01(t);

// ---------------------------------------------------------------- staging verbs

function placeFeet(gs: GameScene, tx: number, ty: number): void {
  gs.player.setPosition(tx * TILE + 8, ty * TILE + 12);
}

/** A staged skill: level only, or level plus banked XP so a scripted action can
 *  cross the threshold on camera. */
type SkillStage = number | { level: number; xp: number };

const skillState = (v: SkillStage | undefined): { xp: number; level: number } =>
  typeof v === "number" ? { xp: 0, level: v } : { xp: v?.xp ?? 0, level: v?.level ?? 0 };

function stageSkills(levels: Partial<Record<SkillId, SkillStage>>): void {
  const s: SkillsJSON = {
    farming: skillState(levels.farming),
    mining: skillState(levels.mining),
    fishing: skillState(levels.fishing),
    foraging: skillState(levels.foraging),
    combat: skillState(levels.combat),
  };
  store.skills = Skills.fromJSON(s);
}

/** True while the Legend is in the pack. land() puts it there and the gift
 *  takes it out, so the fishing and villager beats can key their choreography
 *  off the real state change instead of the wall clock. */
const holdsLegend = (): boolean =>
  store.inv.slots.some((s) => s?.item.kind === "fish" && s.item.fish === "legend");

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

/** Days-grown pickers for stageField: growth is expressed against each crop's
 *  own growthDays so a mixed-species field reads at one uniform stage. */
const RIPE = (growthDays: number): number => growthDays;
const ONE_NIGHT_SHORT = (growthDays: number): number => Math.max(0, growthDays - 1);
const partGrown =
  (frac: number) =>
  (growthDays: number): number =>
    Math.round(growthDays * frac);

/** Plant rows of the field, one crop per row (null = bare tilled walking row). */
function stageField(
  gs: GameScene,
  rowCrops: (CropId | null)[],
  days: (growthDays: number) => number,
  watered: boolean,
  y0: number = FIELD_RECT.y0,
  y1: number = FIELD_RECT.y1,
): void {
  clearFieldObjects(gs);
  for (let ty = y0; ty <= y1; ty++) {
    const crop = rowCrops[(ty - FIELD_RECT.y0) % rowCrops.length] ?? null;
    for (let tx = FIELD_RECT.x0; tx <= FIELD_RECT.x1; tx++) {
      gs.stageTile(tx, ty, {
        tilled: true,
        watered,
        crop,
        daysGrown: crop ? days(CROPS[crop].growthDays) : 0,
      });
    }
  }
}

/** A walkable tile touching `t` — animals and hotspots sit on ledges the player
 *  cannot share, so every scripted approach resolves a reachable neighbour. */
function standBeside(gs: GameScene, t: Tile): Tile {
  const ring = [
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: -1 },
    { dx: -1, dy: 1 },
    { dx: 1, dy: 1 },
    { dx: -1, dy: -1 },
    { dx: 1, dy: -1 },
  ];
  for (const d of ring) {
    const c = { tx: t.tx + d.dx, ty: t.ty + d.dy };
    if (inBounds(c.tx, c.ty) && !gs.world.isSolidTile(c.tx, c.ty)) return c;
  }
  return t;
}

/** Walk distance (in steps) from `origin` to every tile within `maxSteps`, over
 *  the same 8-dir, no-corner-cutting walkability the player moves on. */
function walkRegion(gs: GameScene, origin: Tile, maxSteps: number): Map<number, number> {
  const open = (x: number, y: number): boolean => inBounds(x, y) && !gs.world.isSolidTile(x, y);
  const dist = new Map<number, number>();
  if (!open(origin.tx, origin.ty)) return dist;
  const queue: Tile[] = [origin];
  dist.set(origin.ty * MAP_W + origin.tx, 0);
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    if (!c) break;
    const d = dist.get(c.ty * MAP_W + c.tx) ?? 0;
    if (d >= maxSteps) continue;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const nx = c.tx + ox;
        const ny = c.ty + oy;
        if (!open(nx, ny)) continue;
        if (ox !== 0 && oy !== 0 && (!open(nx, c.ty) || !open(c.tx, ny))) continue;
        const k = ny * MAP_W + nx;
        if (dist.has(k)) continue;
        dist.set(k, d + 1);
        queue.push({ tx: nx, ty: ny });
      }
    }
  }
  return dist;
}

/** `n` tiles around a centre, each at least `gap` tiles from the rest, all
 *  within `maxSteps` of walking from it — a herd staged from one anchor
 *  otherwise piles into one silhouette, and one picked on raw walkability
 *  strands animals across the yard's fence columns, where the scripted walk to
 *  the next one burns the shot pushing into a wall. Nearest-first, so the pen
 *  stays compact and every leg of a petting chain is a couple of steps. */
function spreadTiles(
  gs: GameScene,
  centre: Tile,
  n: number,
  gap: number,
  maxSteps: number,
): Tile[] {
  const reachable = [...walkRegion(gs, centre, maxSteps).entries()]
    .map(([k, d]) => ({ tx: k % MAP_W, ty: (k / MAP_W) | 0, d }))
    .sort((a, b) => a.d - b.d);
  const out: Tile[] = [];
  for (const t of reachable) {
    if (out.length >= n) break;
    const clash = out.some((p) => Math.max(Math.abs(p.tx - t.tx), Math.abs(p.ty - t.ty)) < gap);
    if (!clash) out.push({ tx: t.tx, ty: t.ty });
  }
  return out;
}

type Herd = {
  cow: number;
  sheep: number;
  pig: number;
  hen: number;
  duck: number;
};

/** Populate the barn and coop yards with a small herd (real spawn path, wander
 *  anchors on the yard the player can actually reach — the building's own
 *  anchor row lands them on a ledge behind the fence). Returns the ids of the
 *  pettable stars so scripts can track them as they wander. */
function stageHerd(gs: GameScene): Herd {
  const yard = (type: BuildingKind): Tile => {
    const o = gs.world.objects.find((b) => b.type === type);
    const base = o ? { tx: o.tx, ty: o.ty + 2 } : { tx: 12, ty: 12 };
    return findOpenPatch(gs, base.tx, base.ty, 1, 1, 6) ?? base;
  };
  const barnYard = yard("barn");
  const coopYard = yard("coop");
  // A tight pocket can return fewer tiles than asked for; the yard anchor they
  // were searched from is the only sane fallback (a magic tile teleports the
  // animal into the crop field, which the finale then holds in frame).
  const barn = spreadTiles(gs, barnYard, 3, 2, 6);
  const coop = spreadTiles(gs, coopYard, 4, 2, 6);
  const add = (kind: AnimalKind, building: BuildingKind, t: Tile): number => {
    const id = store.animalSeq++;
    const d: AnimalSave = {
      id,
      kind,
      building,
      name: randomAnimalName(store.animalSeq),
      friendship: 60,
      fed: true,
      producedToday: false,
      x: t.tx * TILE + 8,
      y: t.ty * TILE + 12,
    };
    gs.animals.stageSpawn(d);
    return id;
  };
  const herd: Herd = {
    cow: add("cow", "barn", barn[0] ?? barnYard),
    sheep: add("sheep", "barn", barn[1] ?? barnYard),
    pig: add("pig", "barn", barn[2] ?? barnYard),
    hen: add("chicken", "coop", coop[0] ?? coopYard),
    duck: add("duck", "coop", coop[1] ?? coopYard),
  };
  // pen dressing — never scripted, just there so the coop reads as a flock
  add("chicken", "coop", coop[2] ?? coopYard);
  add("chicken", "coop", coop[3] ?? coopYard);
  return herd;
}

// ---------------------------------------------------------------- tile scans

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

/** Nearest live world object of a type, for scripted gathering beats. */
function nearestObject(gs: GameScene, type: "tree" | "rock" | "forage", near: Tile): Tile | null {
  let best: Tile | null = null;
  let bd = Infinity;
  for (const o of gs.world.objects) {
    if (o.type !== type) continue;
    const d = Math.abs(o.tx - near.tx) + Math.abs(o.ty - near.ty);
    if (d < bd) {
      bd = d;
      best = { tx: o.tx, ty: o.ty };
    }
  }
  return best;
}

type FishSpot = {
  stand: Tile;
  target: Tile;
};

/** Best casting spot: walkable bank with 3 straight tiles of open water,
 *  preferring the open pond bend mid-valley and casting toward the camera —
 *  water below the angler, grass and a tree line behind him. */
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
        const dist = Math.abs(tx - 38) + Math.abs(ty - 27) + d.bias;
        if (dist < bd) {
          bd = dist;
          best = { stand: { tx, ty }, target: { tx: tx + d.x * 2, ty: ty + d.y * 2 } };
        }
      }
    }
  }
  return best ?? { stand: { tx: 31, ty: 18 }, target: { tx: 31, ty: 20 } };
}

/** Nearest open mine tile to (tx,ty), optionally constrained — the pickaxe beat
 *  needs floor UNDER its stand tile to put the ore node on. */
function findOpenNearMine(
  mine: MineScene,
  tx: number,
  ty: number,
  ok: (t: Tile) => boolean = () => true,
): Tile {
  for (let r = 0; r <= 5; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = Math.min(MINE_W - 2, Math.max(1, tx + dx));
        const y = Math.min(MINE_H - 2, Math.max(1, ty + dy));
        if (mine.isOpenTile(x, y) && ok({ tx: x, ty: y })) return { tx: x, ty: y };
      }
    }
  }
  return { tx: (MINE_W / 2) | 0, ty: 3 }; // cleared area under the entry ladder
}

/** Every tile from `x0` to `x1` inclusive on row `ty` is walkable. */
function rowOpen(mine: MineScene, x0: number, x1: number, ty: number): boolean {
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
    if (!mine.isOpenTile(x, ty)) return false;
  }
  return true;
}

type OreSpot = { dx: number; dy: number; kind: OreId };

/**
 * Put real ore nodes around a staged spot, through the mine's own node path.
 *
 * Both mine beats need this for the same reason: generation avoids exactly the
 * tiles a staged shot uses. `findArena` demands a clear 5×5, and the generator
 * holds every node three tiles clear of the entry ladder — so the arena a fight
 * is staged in, and the tile a descent lands on, are bare floor by
 * construction. Under the cave vignette bare floor is a black rectangle.
 *
 * Nodes are solid, so they are kept ≥3 tiles off the staged spot and ≥2 tiles
 * apart: an isolated node is something the axis-separated walk slides around,
 * a cluster is a pocket a chase can snag in.
 */
function stageOreAround(mine: MineScene, at: Tile, spots: OreSpot[], hp = 4): void {
  const placed: Tile[] = [];
  for (const s of spots) {
    const ok = (c: Tile): boolean =>
      Math.abs(c.tx - at.tx) + Math.abs(c.ty - at.ty) >= 3 &&
      placed.every((p) => Math.max(Math.abs(p.tx - c.tx), Math.abs(p.ty - c.ty)) >= 2);
    const t = findOpenNearMine(mine, at.tx + s.dx, at.ty + s.dy, ok);
    // findOpenNearMine returns its own fallback tile when the ring search comes
    // up empty; that tile sits under the entry ladder, which is the one place
    // ore must never block.
    if (!ok(t) || !mine.isOpenTile(t.tx, t.ty)) continue;
    if (mine.trailerStageNode(t.tx, t.ty, s.kind, hp)) placed.push(t);
  }
}

/** A heading out of `from` with `n` open tiles in a row, so a scripted walk onto
 *  a freshly generated floor heads into the room instead of into a wall. */
function openHeading(mine: MineScene, from: Tile, n: number): { x: number; y: number } | null {
  const dirs = [
    { x: 0, y: 1 },
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ];
  for (const d of dirs) {
    let open = true;
    for (let k = 1; k <= n && open; k++) {
      if (!mine.isOpenTile(from.tx + d.x * k, from.ty + d.y * k)) open = false;
    }
    if (open) return d;
  }
  return null;
}

/** Centre of an open 5×5 arena nearest the floor's middle. Searched inside a
 *  safe band first: the mine keeps its own bounded follow camera, and an arena
 *  near a wall makes that camera clamp and shove the whole fight into a frame
 *  corner. */
function findArena(mine: MineScene): Tile {
  const scan = (x0: number, x1: number, y0: number, y1: number): Tile | null => {
    let best: Tile | null = null;
    let bd = Infinity;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
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
    return best;
  };
  return (
    scan(7, MINE_W - 12, 3, MINE_H - 8) ??
    scan(2, MINE_W - 7, 2, MINE_H - 7) ?? { tx: (MINE_W / 2) | 0, ty: (MINE_H / 2) | 0 }
  );
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
  /** Live BFS route for the current walk step, refreshed on `repath` (targets
   *  wander) and consumed waypoint by waypoint. */
  private route: { x: number; y: number }[] = [];
  private repath = 0;

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
        if (this.walk(at, step.run ?? false, dt) || this.t > 2.5) this.next();
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
        if (this.phase === 0) {
          gs.faceTowards(at.tx, at.ty);
          // Hand it over through the game's own use-item action, landing the
          // gift on the animation's impact frame: two idle sprites swapping an
          // invisible item is not an exchange a viewer can see.
          this.phase = 1;
          this.t = 0;
          gs.beginAction("doing", () => {
            if (!gs.npcs.tryTalk(at.tx, at.ty, store.inv.selectedItem())) return;
            // The reaction line and heart meter are HudScene-only and suppressed
            // in trailer mode, so the in-world ♥ carries the beat: big, in the
            // gap between the two of them, started at their feet so its whole
            // 22px rise happens inside the pair's silhouette (pinned higher it
            // floats off alone), and beaten twice so the reaction spans the shot
            // instead of flashing past in a third of a second.
            const mid = (at.tx * TILE + 8 + gs.player.x) / 2;
            const heart = (dx: number): void =>
              floatText(gs, mid + dx, at.ty * TILE + 14, "♥", "#ff3d6e", 20, 1200);
            heart(0);
            gs.time.delayedCall(500, () => heart(7));
          });
        } else if (!gs.acting || this.t > 2) {
          this.next();
        }
        break;
    }
  }

  /** Steer along the game's own click-to-move BFS, so an approach that has to
   *  go around a fence does instead of pushing into it. True = arrived. */
  private walk(at: Tile, run: boolean, dt: number): boolean {
    const gs = this.gs;
    this.repath -= dt;
    if (this.repath <= 0) {
      this.repath = 0.3;
      this.route = gs.pathTo(at.tx, at.ty);
    }
    while (this.route.length > 0) {
      const wp = this.route[0];
      if (!wp) break;
      const dx = wp.x - gs.player.x;
      const dy = wp.y - gs.player.y;
      const d = Math.hypot(dx, dy);
      if (d < 4) {
        this.route.shift();
        continue;
      }
      gs.trailerMove = { x: dx / d, y: dy / d, run };
      return false;
    }
    // on the goal tile (or nothing connects) — straight-line the last few px
    return moveToward(gs, at.tx, at.ty, run);
  }

  private next(): void {
    this.i += 1;
    this.phase = 0;
    this.t = 0;
    this.route = [];
    this.repath = 0;
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

/** Fall-legal rows — nothing withers when the day-rollover beat steps a season
 *  boundary-free night. */
const FALL_ROWS: (CropId | null)[] = ["pumpkin", "wheat", "beetroot", "carrot", "sunflower", null];

/** COLD OPEN — scything down a ripe pumpkin row, pops trailing behind, and the
 *  second cut crossing a Farming level threshold on camera. */
function sceneColdOpen(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let cam: TrackCam | null = null;
  return {
    id: "cold-open-harvest",
    duration: 3200,
    setup: async () => {
      gs = await freshFarm(game);
      // banked one harvest short of Lv.5: harvest awards 12 farming XP, so the
      // second cut of the sweep fires the level float + chime mid-stride
      stageSkills({ farming: { level: 4, xp: xpToNext(4) - 18 } });
      gs.timeMin = 720;
      stageField(gs, MATURE_ROWS, RIPE, true);
      // the strip behind the farmer reads already-harvested
      for (let tx = FIELD_RECT.x0; tx <= 10; tx++) {
        gs.stageTile(tx, 9, { tilled: true, watered: false, crop: null, daysGrown: 0 });
      }
      placeFeet(gs, 11, 9);
      gs.faceTowards(12, 9);
      // manual clamped follow: the field hugs the map's top edge, where the
      // built-in bounds clamp shows void under zoom. 250px across is ~2x
      // tighter than normal play, and the six crop rows then fill two thirds of
      // the frame height instead of floating over empty plateau.
      cam = new TrackCam(gs, zoomFor(gs, 250), 52, -6);
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

/** SHIPPING DAY — a season's haul cashed at the bin in one action: gold burst
 *  off the crate, the payout floating over it, coin arpeggio. */
function sceneShipping(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let bin: Tile = { tx: 6, ty: 10 };
  let stand: Tile = { tx: 8, ty: 10 };
  return {
    id: "shipping-bin",
    // measured: he reaches the crate at ~1.2s and the payout float lives 900ms,
    // so the cut lands on the number rather than on a held pose after it
    duration: 2300,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ farming: 5 });
      gs.timeMin = 660;
      stageField(gs, MATURE_ROWS, RIPE, true);
      const o = gs.world.objects.find((b) => b.type === "bin");
      if (o) bin = { tx: o.tx + 1, ty: o.ty };
      stand = standBeside(gs, bin);
      // the backpack a real day ends with: crops, animal produce, a big fish
      // and mine crystal — the payout number has to be earned by the reel
      store.inv.add({ kind: "produce", crop: "pumpkin" }, 18);
      store.inv.add({ kind: "produce", crop: "cauliflower" }, 9);
      store.inv.add({ kind: "animal_product", product: "truffle" }, 3);
      store.inv.add({ kind: "animal_product", product: "wool" }, 2);
      store.inv.add({ kind: "animal_product", product: "milk" }, 4);
      store.inv.add({ kind: "fish", fish: "tuna" }, 2);
      store.inv.add({ kind: "resource", res: "crystal" }, 3);
      placeFeet(gs, stand.tx + 4, stand.ty);
      lockCam(gs);
      script = new FarmScript(gs, [
        { kind: "walk", at: { tx: stand.tx + 1, ty: stand.ty } },
        { kind: "walk", at: stand },
        { kind: "act", at: bin },
        { kind: "pause", ms: 1400 },
      ]);
    },
    run: (t, dt) => {
      const g = gs;
      if (!g) return;
      script?.tick(dt / 1000);
      // Settle west with him, ending framed on the crate. The bin sits on the
      // island's west edge, so the centre is held east of it — far enough that
      // the open sea is a margin, not a third of the frame.
      const cx = lerp((stand.tx + 5) * TILE, (stand.tx + 4) * TILE, smooth(t / 1400));
      camPlace(g, zoomFor(g, 260), cx, stand.ty * TILE - 4);
    },
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

/** SOW — the whole tending loop on one tile: hoe bites, seed goes in, the can
 *  darkens the soil; then the next tile opens up as the shot ends. */
function sceneSow(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  return {
    id: "verb-sow",
    duration: 3600,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({});
      gs.day = 1;
      gs.timeMin = 520;
      clearField(gs);
      // mature rows behind back the empty row so the frame is never bare dirt
      stageField(gs, MATURE_ROWS, RIPE, true, FIELD_RECT.y0, 8);
      placeFeet(gs, 14, 9);
      gs.faceTowards(15, 9);
      lockCam(gs);
      script = new FarmScript(gs, [
        { kind: "walk", at: { tx: 15, ty: 9 } },
        { kind: "select", match: (it) => it.kind === "tool" && it.tool === "hoe" },
        { kind: "act", at: { tx: 15, ty: 10 } }, // till — dirt burst
        { kind: "select", match: (it) => it.kind === "seed" },
        { kind: "act", at: { tx: 15, ty: 10 } }, // plant — pop + seed burst
        { kind: "select", match: (it) => it.kind === "tool" && it.tool === "can" },
        { kind: "act", at: { tx: 15, ty: 10 } }, // water — droplets, soil darkens
        { kind: "walk", at: { tx: 16, ty: 9 } },
        { kind: "select", match: (it) => it.kind === "tool" && it.tool === "hoe" },
        { kind: "act", at: { tx: 16, ty: 10 } },
      ]);
    },
    run: (t, dt) => {
      const g = gs;
      if (!g) return;
      script?.tick(dt / 1000);
      // a slow lateral push so the plot block never reads as a locked-off take
      camPlace(g, zoomFor(g, 260), lerp(246, 266, t / 3600), 158);
    },
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

type Worker = {
  id: string;
  ty: number;
  x: number;
  y: number;
  dir: number;
  job: "till" | "plant" | "water";
  lastTx: number;
};

/** THE SHARED PLOT — co-op: three name-tagged farmers working the same field in
 *  real time while the local farmer sows the near row. The renderer, the name
 *  tags, the 12Hz lerp and every tile edit are the shipping co-op code paths;
 *  only the wire payload is scripted, since one page cannot host four clients. */
function sceneCoop(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let remote: RemoteFarmers | null = null;
  let workers: Worker[] = [];
  let netAcc = 0;
  return {
    id: "coop-farm",
    duration: 3800,
    setup: async () => {
      gs = await freshFarm(game);
      const g = gs;
      stageSkills({ farming: 3 });
      g.timeMin = 640;
      clearField(g);
      // the far rows are already half worked — the crew has been at it a while
      stageField(g, ["parsnip", "carrot", null, null, null, null], partGrown(0.5), true, 6, 7);
      placeFeet(g, 15, 10);
      g.faceTowards(15, 11);
      remote = new RemoteFarmers(g);
      workers = [
        { id: "mira", ty: 8, x: 11 * TILE, y: 8 * TILE + 12, dir: 1, job: "till", lastTx: -1 },
        { id: "otto", ty: 9, x: 20 * TILE, y: 9 * TILE + 12, dir: -1, job: "plant", lastTx: -1 },
        { id: "juno", ty: 7, x: 14 * TILE, y: 7 * TILE + 12, dir: 1, job: "water", lastTx: -1 },
      ];
      netAcc = 0;
      script = new FarmScript(g, [
        { kind: "select", match: (it) => it.kind === "tool" && it.tool === "hoe" },
        { kind: "act", at: { tx: 15, ty: 11 } },
        { kind: "select", match: (it) => it.kind === "seed" },
        { kind: "act", at: { tx: 15, ty: 11 } },
        { kind: "walk", at: { tx: 16, ty: 10 } },
        { kind: "select", match: (it) => it.kind === "tool" && it.tool === "hoe" },
        { kind: "act", at: { tx: 16, ty: 11 } },
        { kind: "select", match: (it) => it.kind === "seed" },
        { kind: "act", at: { tx: 16, ty: 11 } },
      ]);
      lockCam(g);
      // the plot is 208x96 world px — a 250px frame on its centre fits it at
      // 83% of frame width, so four farmers read at full size with no ocean
      camPlace(g, zoomFor(g, 250), 248, 146);
    },
    run: (t, dt) => {
      const g = gs;
      const r = remote;
      if (!g || !r) return;
      const s = dt / 1000;
      script?.tick(s);
      for (const w of workers) {
        w.x += w.dir * 46 * s;
        const tx = Math.floor(w.x / TILE);
        if (tx !== w.lastTx && tx >= FIELD_RECT.x0 && tx <= FIELD_RECT.x1) {
          w.lastTx = tx;
          applyWorkerEdit(g, w, tx);
        }
        // turn back at the plot edges so the crew stays in frame
        if (w.x < (FIELD_RECT.x0 + 1) * TILE) w.dir = 1;
        if (w.x > FIELD_RECT.x1 * TILE) w.dir = -1;
      }
      netAcc += dt;
      if (netAcc >= 1000 / 12) {
        netAcc = 0;
        const players: PlayerMap = {};
        for (const w of workers) {
          players[w.id] = { id: w.id, state: { x: w.x, y: w.y, f: w.dir < 0, m: true } };
        }
        r.sync(players, "you");
      }
      r.update(s);
      // slow push-in so the crew tightens up as the beat lands
      camPlace(g, zoomFor(g, lerp(250, 232, smooth(t / 3800))), 248, 146);
    },
    teardown: () => {
      if (gs) gs.trailerMove = null;
      remote?.sync({}, "you");
      remote = null;
    },
  };
}

/** One crew member's pass over a tile — a real world edit through the same
 *  staging path the host's tile sync drives, with the matching burst. */
function applyWorkerEdit(g: GameScene, w: Worker, tx: number): void {
  const cx = tx * TILE + 8;
  const cy = w.ty * TILE + 8;
  if (w.job === "till") {
    g.stageTile(tx, w.ty, { tilled: true, watered: false, crop: null, daysGrown: 0 });
    burst(g, cx, cy + 4, { colors: [0x8a6a43, 0x6b4f33, 0xa07b4c], count: 7, up: true, speed: 40 });
  } else if (w.job === "plant") {
    g.stageTile(tx, w.ty, { tilled: true, watered: false, crop: "carrot", daysGrown: 0 });
    burst(g, cx, cy + 4, { colors: [0x7ec850, 0x4a9d3f], count: 5, up: true, speed: 30 });
  } else {
    const cs = g.world.crops.get(g.world.idx(tx, w.ty));
    g.stageTile(tx, w.ty, {
      tilled: true,
      watered: true,
      crop: cs ? cs.crop : null,
      daysGrown: cs ? cs.daysGrown : 0,
    });
    burst(g, cx, cy, {
      colors: [0x6fc6ff, 0x9fe0ff, 0xffffff],
      count: 6,
      up: true,
      speed: 35,
      gravity: 200,
    });
  }
}

/** Barn morning: pet the cow, the truffle pig, then dash to a hen — heart chain
 *  on the yard the player can actually walk. */
function sceneAnimals(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  return {
    id: "animals",
    // Three pets across two pens. Measured: cow ~0.4s, truffle pig ~1.7s, then
    // the run to the coop lands the hen at 2.7-3.9s (the stars wander) — a
    // chain cut short is the defect this beat exists to fix, so the shot is
    // sized to the slowest leg and no longer.
    duration: 4400,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({});
      gs.timeMin = 780;
      const g = gs;
      const herd = stageHerd(g);
      // the stars wander — every approach/pet resolves their live tile
      const beside = (id: number) => (): Tile | null => {
        const t = g.animals.trailerTileOf(id);
        return t ? standBeside(g, t) : null;
      };
      const at = (id: number) => (): Tile | null => g.animals.trailerTileOf(id);
      const cow0 = g.animals.trailerTileOf(herd.cow) ?? { tx: 61, ty: 11 };
      // a few tiles down the yard from the cow, so the shot opens on him
      // walking in past the sheep rather than standing on top of one
      const start = findOpenPatch(g, cow0.tx + 3, cow0.ty, 1, 1, 3) ?? standBeside(g, cow0);
      placeFeet(g, start.tx, start.ty);
      // lead west and up: the yards sit on the map's east shoulder, so a
      // centred follow gives half the frame to the river behind them
      followCam(g, zoomFor(g, 280), -34, -16);
      script = new FarmScript(g, [
        { kind: "walk", at: beside(herd.cow) },
        { kind: "pet", at: at(herd.cow) },
        { kind: "pause", ms: 380 },
        { kind: "walk", at: beside(herd.pig) },
        { kind: "pet", at: at(herd.pig) },
        { kind: "pause", ms: 340 },
        { kind: "walk", at: beside(herd.hen), run: true }, // dash to the coop pen
        { kind: "pet", at: at(herd.hen) },
        { kind: "pause", ms: 400 },
        // The pets land anywhere from 2.7s to 3.9s (the stars wander), so the
        // beat ends on him heading back up the yard rather than on a held pose.
        // Deliberately a walk he cannot finish: the cut catches him mid-stride
        // with the pens still in frame, however the chain timed out.
        { kind: "walk", at: beside(herd.cow), run: true },
      ]);
      const first = beside(herd.cow)();
      if (first) moveToward(g, first.tx, first.ty);
    },
    run: (_t, dt) => script?.tick(dt / 1000),
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

/** Ore ringing the fight. Held to the rows above and below the pack (whose
 *  spawns all sit within ±2 rows) so nothing lands between the farmer and a
 *  skeleton, and spread wide enough to reach both edges of the 260px frame. */
const ARENA_ORE: OreSpot[] = [
  { dx: -6, dy: -3, kind: "copper" },
  { dx: -2, dy: -4, kind: "coal" },
  { dx: 3, dy: -3, kind: "crystal" },
  { dx: 6, dy: -4, kind: "coal" },
  { dx: -5, dy: 3, kind: "coal" },
  { dx: -1, dy: 4, kind: "copper" },
  { dx: 4, dy: 3, kind: "copper" },
  { dx: 7, dy: 4, kind: "crystal" },
];

/** BENEATH THE VALLEY — torch-dark floor 6, a skeleton pack already on him:
 *  he eats the first hit, then cuts back through them. */
function sceneMine(game: Phaser.Game): TrailerScene {
  let mine: MineScene | null = null;
  let emberAcc = 0;
  return {
    id: "mine-combat",
    duration: 3600,
    setup: async () => {
      mine = await freshMine(game, 6);
      stageSkills({ combat: 4, mining: 3 });
      store.hp = store.maxHp();
      store.energy = 100;
      selectTool((it) => it.kind === "tool" && it.tool === "sword");
      const c = findArena(mine);
      mine.player.setPosition(c.tx * TILE + 8, c.ty * TILE + 8);
      // 260px across (vs 492 in normal play) so the pack fills the frame; the
      // hit-punch reads this same base, so a landed swing no longer resets it.
      mine.trailerZoom = zoomFor(mine, 260);
      mine.cameras.main.setZoom(mine.trailerZoom);
      emberAcc = 0;
      // Ore first: enemy spawns snap to open tiles, and a node already on a
      // tile makes that tile unopen, so staging in this order keeps a skeleton
      // from landing inside a rock.
      stageOreAround(mine, c, ARENA_ORE);
      // Staggered in distance AND health so the pack dies in a rolling order.
      // A tight equal-hp ring is worse than useless: one swing hits everything
      // inside an 18px box, so they all drop on the same frame and the rest of
      // the shot is an empty room. The first is one tile out — inside the
      // contact ring within a frame, so the reveal opens on the farmer TAKING a
      // hit; the far three walk in from the dark (110px aggro radius).
      const spawns = [
        { dx: 1, dy: 0, hp: 28 },
        { dx: -2, dy: 1, hp: 28 },
        { dx: 2, dy: -2, hp: 42 },
        { dx: -5, dy: -2, hp: 56 },
        { dx: 5, dy: 1, hp: 56 },
        { dx: -6, dy: 2, hp: 70 },
      ];
      const m = mine;
      m.trailerStageEnemies(
        spawns.map((o) => {
          const s = findOpenNearMine(m, c.tx + o.dx, c.ty + o.dy);
          return { tx: s.tx, ty: s.ty, hp: o.hp };
        }),
      );
    },
    run: (_t, dt) => {
      const m = mine;
      if (!m) return;
      // a lantern's worth of embers: the cave grades to near-black and the
      // hero's sprite has no light on him otherwise
      emberAcc += dt;
      if (emberAcc > 90) {
        emberAcc = 0;
        burst(m, m.player.x + (Math.random() - 0.5) * 12, m.player.y - 10, {
          colors: [0xffb45c, 0xffd34d],
          count: 1,
          speed: 8,
          gravity: -14,
          size: 2,
          life: 520,
        });
      }
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

/**
 * Ore for the tile a descent lands on. The generator holds every node three
 * tiles clear of the entry ladder, so the landing is guaranteed-bare floor;
 * this puts the floor's own ore back where the camera is. Offsets stay at or
 * below the landing row because the entry ladder sits two tiles from the top
 * wall, and the mine camera's bounds clamp means there is nothing above it to
 * fill.
 */
const LANDING_ORE: OreSpot[] = [
  { dx: -5, dy: 1, kind: "coal" },
  { dx: -3, dy: 4, kind: "copper" },
  { dx: 3, dy: 3, kind: "crystal" },
  { dx: 6, dy: 1, kind: "copper" },
  { dx: 5, dy: 4, kind: "coal" },
  { dx: -6, dy: 4, kind: "crystal" },
];

/**
 * Fixed moment the descent starts. The transition is a real 350ms fade-out plus
 * a 400ms fade-in — measured end to end off the capture, 760ms of unusable
 * frame — and review samples the shot at 12/37/63/88%, so the blackout has to
 * fall inside one 25% gap with room either side. At this duration that gap is
 * 2100→3500ms, and firing on arrival instead put the blackout straight over the
 * 63% sample: the reviewed still was a black frame whose only legible content
 * was the floor banner. Held rather than triggered so the walk's own variance
 * cannot drift it back over a sample.
 */
const DESCEND_AT_MS = 2400;

/** DEEPER — pickaxe through a crystal node, then onto the down ladder and a
 *  floor further into a mine that has no bottom. */
function sceneMineDeeper(game: Phaser.Game): TrailerScene {
  let mine: MineScene | null = null;
  let ladder: Tile = { tx: 0, ty: 0 };
  let descended = false;
  let staged = false;
  let heading: { x: number; y: number } | null = null;
  let landingOre: Tile | null = null;
  let emberAcc = 0;
  return {
    id: "mine-deeper",
    // 5600, not 3600: see DESCEND_AT_MS. The beat also now has two halves to
    // pay for — the crystal and the walk on floor 8, then a real arrival on
    // floor 9 rather than a cut two frames after the fade-in.
    duration: 5600,
    setup: async () => {
      mine = await freshMine(game, 8);
      stageSkills({ mining: 6, combat: 4 });
      store.hp = store.maxHp();
      store.energy = 100;
      selectTool((it) => it.kind === "tool" && it.tool === "pickaxe");
      const m = mine;
      descended = false;
      heading = null;
      landingOre = null;
      emberAcc = 0;
      ladder = m.trailerLadderDown();
      // Floor UNDER him is the requirement, not just a free tile: the node goes
      // there, and the mine's default facing is down, so the first tryAction
      // swings straight into it. Staging a node on a wall tile would draw a
      // crystal over a cave block.
      const floorBelow = (t: Tile): boolean => t.ty <= MINE_H - 3 && m.isOpenTile(t.tx, t.ty + 1);
      // Preferred stand: same row as the ladder with an unobstructed row
      // between, so the cross to the ladder is a straight line that always
      // arrives — the descent now fires on a clock, and a farmer stalled
      // against a wall blob when it does reads as a bug. Falls back to the
      // looser "any tile with floor under it" when the floor has no such row.
      const straightToLadder = (t: Tile): boolean =>
        t.ty === ladder.ty && rowOpen(m, t.tx, ladder.tx, t.ty);
      let stand = findOpenNearMine(
        m,
        ladder.tx - 4,
        ladder.ty,
        (t) => straightToLadder(t) && floorBelow(t),
      );
      if (!straightToLadder(stand) || !floorBelow(stand)) {
        stand = findOpenNearMine(m, ladder.tx - 3, ladder.ty, floorBelow);
      }
      m.player.setPosition(stand.tx * TILE + 8, stand.ty * TILE + 8);
      staged = m.trailerStageNode(stand.tx, stand.ty + 1, "crystal", 2);
      // this beat is about the ore and the descent, not another fight
      m.trailerStageEnemies([]);
      m.trailerZoom = zoomFor(m, 250);
      m.cameras.main.setZoom(m.trailerZoom);
    },
    run: (t, dt) => {
      const m = mine;
      if (!m) return;
      // a lantern's worth of embers, as in the fight above: the cave grades to
      // near-black and the hero's sprite has no light on him otherwise
      emberAcc += dt;
      if (emberAcc > 90) {
        emberAcc = 0;
        burst(m, m.player.x + (Math.random() - 0.5) * 12, m.player.y - 10, {
          colors: [0xffb45c, 0xffd34d],
          count: 1,
          speed: 8,
          gravity: -14,
          size: 2,
          life: 520,
        });
      }
      if (descended) {
        // walking into the room, so the new floor reveals under motion instead
        // of a held pose (heading resolves once the restart has built it)
        m.trailerMove = heading ? { x: heading.x, y: heading.y, run: false } : null;
        // The node dead ahead is solid, so the walk stalls against it with
        // facing already pointing at the ore and tryAction's ordinary "node in
        // front of me" branch takes over — the arrival ends on a landed pickaxe
        // rather than on a farmer walking into the dark.
        if (landingOre && !m.isOpenTile(landingOre.tx, landingOre.ty)) {
          const d = Math.hypot(
            landingOre.tx * TILE + 8 - m.player.x,
            landingOre.ty * TILE + 8 - m.player.y,
          );
          if (d < 20) m.tryAction();
        }
        return;
      }
      // two 625ms pickaxe swings shatter the 2hp crystal; the window closes
      // before a third could start and swing at nothing
      if (staged && t < 1200) {
        m.trailerMove = null;
        m.tryAction();
        return;
      }
      // Arrives around 2.2s and holds the last beat on the ladder itself; the
      // descent is on the clock, not on arrival (see DESCEND_AT_MS).
      if (t < DESCEND_AT_MS) {
        moveToward(m, ladder.tx, ladder.ty);
        return;
      }
      m.trailerMove = null;
      descended = true;
      // the floor he walks out onto only exists after the restart
      m.events.once(Phaser.Scenes.Events.CREATE, () => {
        const feet = {
          tx: Math.floor(m.player.x / TILE),
          ty: Math.floor((m.player.y - 1) / TILE),
        };
        heading = openHeading(m, feet, 3);
        // One node four tiles dead ahead — one past the run of open floor the
        // heading was picked for. Cardinal headings only: facing snaps to a
        // single axis, so on a diagonal approach tryAction would look past the
        // node and swing at nothing.
        if (heading && (heading.x === 0 || heading.y === 0)) {
          const ahead = { tx: feet.tx + heading.x * 4, ty: feet.ty + heading.y * 4 };
          if (
            m.isOpenTile(ahead.tx, ahead.ty) &&
            m.trailerStageNode(ahead.tx, ahead.ty, "crystal", 2)
          )
            landingOre = ahead;
        }
        stageOreAround(m, feet, LANDING_ORE);
      });
      m.descend(); // real fade → brand-new procedural floor 9 → "Floor 9"
    },
    teardown: () => {
      if (mine) mine.trailerMove = null;
    },
  };
}

/** OUT ACROSS THE VALLEY — a run down the southern flats, mushrooms popping
 *  underfoot, then the axe puts a tree on the ground. */
function sceneGather(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let cam: TrackCam | null = null;
  return {
    id: "gather-run",
    // measured: two pickups + three axe swings land the fell at ~3.2s, so the
    // shrink-fade and the "+3 Wood" float still get a beat on camera
    duration: 3600,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ foraging: 4 });
      gs.timeMin = 900;
      const g = gs;
      const tree = nearestObject(g, "tree", { tx: 5, ty: 40 }) ?? { tx: 5, ty: 40 };
      const shrooms: Tile[] = [];
      for (const o of g.world.objects) {
        if (o.type !== "forage") continue;
        if (Math.abs(o.tx - tree.tx) + Math.abs(o.ty - tree.ty) <= 5) {
          shrooms.push({ tx: o.tx, ty: o.ty });
        }
      }
      shrooms.sort((a, b) => b.tx - a.tx); // run east → west, picking as he goes
      const chopFrom = standBeside(g, tree);
      const start = findOpenPatch(g, tree.tx + 5, tree.ty + 3, 1, 1, 4) ?? chopFrom;
      placeFeet(g, start.tx, start.ty);
      g.faceTowards(start.tx - 1, start.ty);
      const steps: Step[] = shrooms
        .slice(0, 2)
        .map((s): Step => ({ kind: "walk", at: s, run: true }));
      steps.push({ kind: "walk", at: chopFrom });
      steps.push({ kind: "select", match: (it) => it.kind === "tool" && it.tool === "axe" });
      for (let i = 0; i < 3; i++) steps.push({ kind: "act", at: tree });
      script = new FarmScript(g, steps);
      cam = new TrackCam(g, zoomFor(g, 300), -26, 4);
      moveToward(g, start.tx - 1, start.ty, true);
    },
    run: (_t, dt) => {
      cam?.tick(dt / 1000);
      script?.tick(dt / 1000);
    },
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

/** Golden-hour cast → bite → the reel duel → the rarest fish in the valley,
 *  played perfectly by the machine through the real state machine. */
function sceneFishing(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let cx = 0;
  let cy = 0;
  let caught = -1;
  return {
    id: "fishing",
    // The reel is a live duel against a wandering fish, so the catch is not
    // frame-exact: sown, it lands at ~3.0s and the caught pose holds 650ms
    // after it, but an unlucky roll ran to 4.1s before the sow. Sized for the
    // slow case; the tail is driven off the catch itself, not the clock, so a
    // fast one just walks the bank for longer.
    duration: 4800,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ fishing: 10 }); // widest catch zone
      gs.timeMin = 1185; // 19:45 — the strongest amber the pre-dusk grade offers
      // the fish's wander draws from Phaser's global RND: sow it so the reel is
      // the same duel every capture
      Phaser.Math.RND.sow(["vg-trailer-fish"]);
      const spot = findFishingSpot(gs);
      placeFeet(gs, spot.stand.tx, spot.stand.ty);
      selectTool((it) => it.kind === "tool" && it.tool === "rod");
      lockCam(gs);
      // Fishing.unzoom parks the reel meter in a fixed screen box in trailer
      // mode, so this beat is no longer stuck at the play-parity framing that
      // made it the widest shot in the reel: 340px puts the angler, the rod
      // line, the bobber and the meter in one readable frame. The lead holds
      // him left of centre, clear of the meter.
      caught = -1;
      cx = spot.stand.tx * TILE + 8 + 34;
      cy = spot.stand.ty * TILE + 12 + 16;
      camPlace(gs, zoomFor(gs, 340), cx, cy);
      gs.fishing.trailerAuto = true;
      gs.fishing.trailerFish = FISH.legend; // the rarest thing in the valley
      gs.fishing.startCast(spot.target.tx, spot.target.ty);
    },
    run: (t, dt) => {
      const g = gs;
      if (!g) return;
      if (caught < 0) {
        if (t > 1200 && holdsLegend()) caught = t; // land() puts it in the pack
        return;
      }
      // The meter dies with the catch, so the space it was holding dies with
      // it: push in on the payoff, drop the lead that kept him clear of it, and
      // trail him as he pockets the fish and walks the bank toward the angler
      // who wants it. Driven off the catch, not the clock — however much tail
      // the reel leaves, the shot uses all of it.
      // 600ms, not a leisurely one: the "The Legend!" float lives 900ms, and it
      // is the payoff that has to be readable when the frame arrives
      const k = smooth((t - caught) / 600);
      const follow = 1 - Math.exp(-(dt / 1000) * 4);
      cx += (g.player.x + lerp(34, -14, k) - cx) * follow;
      cy += (g.player.y + lerp(16, 4, k) - cy) * follow;
      camPlace(g, zoomFor(g, lerp(340, 250, k)), cx, cy);
      // the caught pose owns the first 650ms; walking would cut it short
      if (!g.fishing.active) g.trailerMove = { x: -1, y: 0, run: false };
    },
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

/** THE ANGLER — hand Finn the fish he has been talking about all game: a real
 *  gift reaction, his friendship jumping 25, framed as an exchange. */
function sceneVillager(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let cam: TrackCam | null = null;
  let away: Tile = { tx: 0, ty: 0 };
  /** When the fish left the pack (ms into the shot); 0 = still holding it. */
  let handedAt = 0;
  let sent = false;
  return {
    id: "villager-gift",
    // the handover lands at ~0.9s and holds a beat; the rest is Finn walking
    // off with it, so the shot is never two idle sprites waiting for the cut
    duration: 2800,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ fishing: 10 });
      gs.timeMin = 1185;
      const g = gs;
      const spot = findFishingSpot(g); // the same bank the catch just happened on
      // 5 tiles out, not 1: the farmer needs a walk-in to read as the one who
      // came bearing something, and the exchange should land mid-shot rather
      // than 0.3s in with two seconds of aftermath behind it.
      const finn = { tx: spot.stand.tx - 5, ty: spot.stand.ty };
      g.npcs.trailerVisible(["finn"]);
      g.npcs.placeNpc("finn", finn.tx, finn.ty);
      // Pin him on his anchor (a walk order to the tile he is already on parks
      // his wander for 6s): left to drift he closes the tile the farmer walks
      // in to, and the two sprites end the shot standing inside each other.
      g.npcs.trailerWalkTo("finn", finn.tx, finn.ty);
      store.inv.add({ kind: "fish", fish: "legend" }, 1);
      selectTool((it) => it.kind === "fish");
      placeFeet(g, spot.stand.tx, spot.stand.ty);
      const finnAt = (): Tile | null => g.npcs.trailerTileOf("finn");
      const beside = (): Tile | null => {
        const t = finnAt();
        return t ? { tx: t.tx + 1, ty: t.ty } : null;
      };
      script = new FarmScript(g, [
        { kind: "walk", at: beside },
        { kind: "gift", at: finnAt }, // Finn loves fish
        { kind: "pause", ms: 1600 },
      ]);
      // where he takes it: further down the bank, away from the farmer
      // 3 tiles: far enough to read as leaving, close enough to stay in a
      // 280px frame that is still centred on the farmer
      away = findOpenPatch(g, finn.tx - 3, finn.ty, 1, 1, 3) ?? { tx: finn.tx - 3, ty: finn.ty };
      handedAt = 0;
      sent = false;
      // 215 world px: at the old 280 the two of them were 7% of frame height
      // and the reaction read as a speck. The lead splits the difference
      // between the pair so both stay centred through the handover.
      cam = new TrackCam(g, zoomFor(g, 215), -20, -6);
      const first = beside();
      if (first) moveToward(g, first.tx, first.ty);
    },
    run: (t, dt) => {
      const g = gs;
      if (!g) return;
      cam?.tick(dt / 1000);
      script?.tick(dt / 1000);
      // driven off the fish actually changing hands, not off the clock
      if (handedAt === 0 && !holdsLegend()) handedAt = t;
      // ...but hold the pair facing each other while the ♥ is still up, so the
      // reaction reads before he turns his back and walks it home
      if (!sent && handedAt > 0 && t - handedAt > 400) {
        sent = true;
        g.npcs.trailerWalkTo("finn", away.tx, away.ty);
      }
    },
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

/** A YEAR IN THE VALLEY — locked-off frame, four seasons swapping behind a
 *  farmer walking the foreground row, landing on the fall bounty. */
function sceneSeasons(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let seg = -1;
  // Only two levers actually repaint this world — the crops and the time/weather
  // grade — because the terrain art is season-invariant. Winter sits third so
  // the shot lands on the fullest frame, not the emptiest.
  const stageSeason = (g: GameScene, idx: number): void => {
    if (idx === 0) {
      g.day = 1;
      g.weather = "sunny";
      g.timeMin = 430; // spring dawn wash
      stageField(
        g,
        ["parsnip", "carrot", "potato", "parsnip", "carrot", null],
        partGrown(0.45),
        true,
      );
    } else if (idx === 1) {
      g.day = 30;
      g.weather = "sunny";
      g.timeMin = 760; // flat high-summer noon
      stageField(g, ["radish", "kale", "sunflower", "cabbage", "radish", null], RIPE, true);
    } else if (idx === 2) {
      g.day = 90;
      g.weather = "snow";
      // Snow's own wash is only alpha 0.08, so at noon winter reads as summer
      // with white flecks. A blue dusk is the coldest grade the game owns.
      g.timeMin = 1220;
      stageField(g, ["kale", null, "kale", null, null, null], partGrown(0.6), false);
    } else {
      g.day = 60;
      g.weather = "rain";
      g.timeMin = 1150; // fall amber over the wet cast
      stageField(g, ["pumpkin", "beetroot", "pumpkin", "wheat", "beetroot", null], RIPE, false);
    }
  };
  return {
    id: "seasons-timelapse",
    duration: 4200,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({});
      seg = -1;
      stageSeason(gs, 0);
      placeFeet(gs, 12, 11);
      gs.faceTowards(13, 11);
      script = new FarmScript(gs, [
        { kind: "walk", at: { tx: 19, ty: 11 } },
        { kind: "walk", at: { tx: 13, ty: 11 } },
      ]);
      lockCam(gs);
      // 300px on FIELD_RECT's centre: crop rows across ~70% of frame, no ocean
      camPlace(gs, Math.max(zoomFor(gs, 300), fitZoom(gs)), 248, 148);
    },
    run: (t, dt) => {
      const g = gs;
      if (!g) return;
      script?.tick(dt / 1000);
      const idx = Math.min(3, Math.floor(t / 1050));
      if (idx !== seg) {
        seg = idx;
        stageSeason(g, idx);
      }
      if (idx === 2) {
        // winter: snowfall through the real particle system, dense enough to read
        const view = g.cameras.main.worldView;
        for (let i = 0; i < 2; i++) {
          burst(
            g,
            view.x + Math.random() * view.width,
            view.y + Math.random() * view.height * 0.4,
            {
              colors: [0xffffff, 0xeef4ff],
              count: 3,
              speed: 10,
              gravity: 16,
              size: 3,
              life: 2200,
            },
          );
        }
      }
    },
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

/** DUSK, THEN THE MORNING — fireflies at the farmhouse door, sleep, and the
 *  overnight the whole genre turns on: crops step to ripe under rain-dark soil. */
function sceneNight(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let fireflyAcc = 0;
  let slept = false;
  let reframed = false;
  const SLEEP_AT = 2300;
  return {
    id: "night-sleep",
    duration: 4800,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ farming: 5 });
      const g = gs;
      // A fall day whose next morning is rainy: the overnight then auto-waters
      // every tilled tile, so the wake reveals darkened soil for free.
      let day = 57;
      while (day < 83 && weatherForDay(FARM_SEED, day + 1) !== "rain") day += 1;
      g.day = day;
      g.weather = weatherForDay(FARM_SEED, day);
      g.timeMin = 1245; // 20:45 — already blue at the reveal
      stageField(g, FALL_ROWS, ONE_NIGHT_SHORT, true);
      fireflyAcc = 0;
      slept = false;
      reframed = false;
      const house = g.world.objects.find((o) => o.type === "house");
      const door = house ? { tx: house.tx, ty: house.ty + 1 } : { tx: 31, ty: 16 };
      placeFeet(g, door.tx - 3, door.ty + 1);
      lockCam(g);
      script = new FarmScript(g, [
        { kind: "walk", at: { tx: door.tx - 1, ty: door.ty + 1 } },
        { kind: "walk", at: door },
        { kind: "face", at: { tx: door.tx, ty: door.ty - 1 } }, // at the door, facing home
      ]);
      moveToward(g, door.tx - 1, door.ty + 1, false);
      camPlace(g, zoomFor(g, 360), 494, 246);
    },
    run: (t, dt) => {
      const g = gs;
      if (!g) return;
      if (!slept) {
        g.timeMin = lerp(1245, 1350, t / SLEEP_AT); // 20:45 → 22:30, still readable
        camPlace(g, zoomFor(g, lerp(360, 300, smooth(t / SLEEP_AT))), 494, 246);
        script?.tick(dt / 1000);
        fireflyAcc += dt;
        if (fireflyAcc > 60) {
          fireflyAcc = 0;
          // clustered on the hero: scattered across the whole view they were
          // nine two-pixel dots in a 1600x900 frame
          burst(g, g.player.x + (Math.random() - 0.5) * 150, g.player.y - 12 - Math.random() * 70, {
            colors: [0xffe27a, 0xfff3c4, 0xffd34d],
            count: 3,
            speed: 7,
            gravity: -6,
            size: 3,
            life: 2200,
          });
        }
        if (t >= SLEEP_AT) {
          slept = true;
          g.trailerMove = null;
          g.doSleep(); // 600ms dip to indigo → overnight → 700ms fade in + chime
        }
        return;
      }
      // recomposed under the black, so the fade-in opens on what the night grew
      if (!reframed && t > SLEEP_AT + 400) {
        reframed = true;
        camPlace(g, zoomFor(g, 300), 248, 150);
      }
    },
    teardown: () => {
      if (gs) gs.trailerMove = null;
    },
  };
}

/** RELEASE — one last harvest held tight, then the pull back over the valley. */
function sceneFullFarm(game: Phaser.Game): TrailerScene {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let startCx = 0;
  let startCy = 0;
  const HOLD = 1000;
  const DUR = 3900;
  /** The plot's south row carries a crate/barrel cluster at tx 17.8-18.9 whose
   *  y-sort puts it in FRONT of anyone standing on the beetroot row behind it —
   *  the old harvest tile (18,10) left the actor invisible for the whole hold.
   *  tx 15 is the nearest column with nothing drawn over it. */
  const STAND: Tile = { tx: 14, ty: 10 };
  const CROP: Tile = { tx: 14, ty: 9 }; // the pumpkin row he reaps
  /** Where the pull stops. Wide enough to be a release — plot, mill, pond and
   *  village all in one frame — but not so wide that the farmer walking the
   *  rows stops reading (he is ~45px tall here, ~28px at full fit). Centred
   *  east of him so the pull opens the valley up ahead of his walk rather than
   *  sliding him off the edge. */
  const END_W = 560;
  const END_CX = 360;
  const END_CY = 190;
  return {
    id: "full-farm",
    duration: DUR,
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ farming: 5 });
      gs.timeMin = 1190; // the strongest amber before the blue night branch
      stageField(gs, MATURE_ROWS, RIPE, true);
      stageHerd(gs);
      placeFeet(gs, STAND.tx, STAND.ty);
      gs.faceTowards(CROP.tx, CROP.ty);
      startCx = gs.player.x;
      startCy = gs.player.y - 10;
      lockCam(gs);
      camPlace(gs, zoomFor(gs, 300), startCx, startCy);
      // ty 9 is the pumpkin row; ty 10 (his feet) is beetroot — the old script
      // targeted the bare walking row and the pop never fired.
      // The two walks keep him moving under the whole pull: a wide that ends on
      // a motionless frame is a photograph, not the last shot of a trailer.
      // The walk climbs the rows away from the lens (and clear of the crate
      // cluster on the south row) so the last frame has a farmer moving through
      // his own crops instead of a still landscape.
      script = new FarmScript(gs, [
        { kind: "act", at: CROP },
        { kind: "walk", at: { tx: 18, ty: 9 } },
        { kind: "walk", at: { tx: 21, ty: 8 } },
        { kind: "walk", at: { tx: 21, ty: 6 } },
        { kind: "walk", at: { tx: 18, ty: 6 } },
      ]);
    },
    run: (t, dt) => {
      const g = gs;
      if (!g) return;
      script?.tick(dt / 1000);
      const cam = g.cameras.main;
      // hold tight through the harvest, then ease OUT (fast off the mark, slow
      // into the wide) so the shot lingers where windmills and cloud shadows
      // still read, and stops on a frame the farmer is still inside
      const x = clamp01((t - HOLD) / (DUR - HOLD));
      const k = 1 - Math.pow(1 - x, 1.7);
      const w = lerp(300, END_W, k);
      camPlace(g, cam.width / w, lerp(startCx, END_CX, k), lerp(startCy, END_CY, k));
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
  Sound.muted = true; // ignore any saved preference; onGesture owns the unmute

  runTrailer({
    vignette: false, // keep the pixel art clean edge-to-edge
    cutMs: 200,
    // The trailer rolls with no user gesture, so the audio context would stay
    // suspended: stay muted (Sound skips scheduling entirely) until a real
    // click/keypress lands, then resume and unmute from that beat on.
    onGesture: () => {
      Sound.resume();
      Sound.muted = false;
    },
    // hook → payout → craft → co-op → warmth → danger → depth → expedition →
    // tension → exchange → the year → the night → release
    scenes: [
      sceneColdOpen(game),
      sceneShipping(game),
      sceneSow(game),
      sceneCoop(game),
      sceneAnimals(game),
      sceneMine(game),
      sceneMineDeeper(game),
      sceneGather(game),
      sceneFishing(game),
      sceneVillager(game),
      sceneSeasons(game),
      sceneNight(game),
      sceneFullFarm(game),
    ],
  });
}
