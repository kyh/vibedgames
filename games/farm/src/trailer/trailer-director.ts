import type Phaser from "phaser";
import { Math as PhaserMath, Scenes } from "phaser";
import { runTrailer } from "./trailer-shell";
import type { TrailerScene } from "./trailer-shell";
import { GameScene, enableTrailerStaging } from "../scenes/game-scene";
import { MineScene } from "../scenes/mine-scene";
import { MineHudScene } from "../scenes/mine-hud-scene";
import { disableSaves } from "../systems/save";
import type { AnimalSave } from "../systems/save";
import { store } from "../systems/store";
import { Skills, xpToNext } from "../systems/skills";
import type { SkillId, SkillsJSON } from "../systems/skills";
import { weatherForDay } from "../systems/weather";
import { Sound } from "../render/audio";
import { burst, floatText } from "../render/fx";
import { TILE, MAP_W, MAP_H, FARM_SEED, NET_TICK_HZ } from "../config";
import { CELL, FIELD_RECT } from "../world/worldmap";
import { inBounds, tileIdx } from "../world/world";
import { CROPS, isMature } from "../data/crops";
import type { CropId } from "../data/crops";
import { FISH } from "../data/fish";
import { randomAnimalName } from "../data/animals";
import type { AnimalKind, BuildingKind } from "../data/animals";
import type { Item, OreId } from "../data/items";
import { RemoteFarmers } from "../net/remote-farmers";
import { FixedRate } from "@vibedgames/multiplayer";
import type { PlayerMap } from "@vibedgames/multiplayer";

const WORLD_W = MAP_W * TILE;
const WORLD_H = MAP_H * TILE;
const MINE_W = 32;
const MINE_H = 24;

interface Tile {
  tx: number;
  ty: number;
}

type TileRef = Tile | (() => Tile | null);

const resolveTile = (r: TileRef) => ("tx" in r ? r : r());

const getGame = (game: Phaser.Game) => {
  const s = game.scene.getScene("Game");

  if (!(s instanceof GameScene)) {
    throw new TypeError("trailer: Game scene missing");
  }

  return s;
};

const getMine = (game: Phaser.Game) => {
  const s = game.scene.getScene("Mine");

  if (!(s instanceof MineScene)) {
    throw new TypeError("trailer: Mine scene missing");
  }

  return s;
};

const sceneReady = <T extends Phaser.Scene>(scene: T) =>
  // oxlint-disable-next-line promise/avoid-new -- wraps Phaser's one-shot CREATE event callback
  new Promise<T>((resolve) => {
    scene.events.once(Scenes.Events.CREATE, () => resolve(scene));
  });

const freshFarm = async (game: Phaser.Game) => {
  const mgr = game.scene;

  if (mgr.isActive("MineHud")) {
    mgr.stop("MineHud");
  }

  if (mgr.isActive("Mine")) {
    mgr.stop("Mine");
  }

  const gs = getGame(game);
  const ready = sceneReady(gs);

  if (mgr.isActive("Game")) {
    gs.scene.restart({ mode: "new" });
  } else {
    mgr.start("Game", { mode: "new" });
  }

  await ready;
  gs.input.enabled = false;
  const kb = gs.input.keyboard;

  if (kb) {
    kb.enabled = false;
  }

  gs.npcs.trailerVisible([]);
  store.energy = 100;
  store.hp = store.maxHp();
  gs.weather = "sunny";

  return gs;
};

const freshMine = async (game: Phaser.Game, depth: number) => {
  const mgr = game.scene;

  if (mgr.isActive("Game")) {
    mgr.stop("Game");
  }

  const hud = mgr.getScene("MineHud");

  if (hud instanceof MineHudScene) {
    hud.trailerHideUi = true;
  }

  PhaserMath.RND.sow(["vg-trailer-mine"]);
  const mine = getMine(game);
  mine.trailerNoInput = true;
  const ready = sceneReady(mine);

  if (mgr.isActive("Mine")) {
    mine.scene.restart({ depth });
  } else {
    mgr.start("Mine", { depth });
  }

  await ready;

  return mine;
};

const zoomFor = (scene: Phaser.Scene, worldWidth: number) => scene.cameras.main.width / worldWidth;

const fitZoom = (scene: Phaser.Scene) => {
  const cam = scene.cameras.main;

  return Math.max(1, cam.width / WORLD_W, cam.height / WORLD_H);
};

const clampCenter = (v: number, half: number, max: number) => {
  if (half * 2 >= max) {
    return max / 2;
  }

  return Math.min(max - half, Math.max(half, v));
};

const lockCam = (scene: Phaser.Scene) => {
  const cam = scene.cameras.main;
  cam.stopFollow();
  cam.useBounds = false;
};

const camPlace = (scene: Phaser.Scene, zoom: number, cx: number, cy: number) => {
  const cam = scene.cameras.main;
  cam.setZoom(zoom);
  const vw = cam.width / zoom;
  const vh = cam.height / zoom;
  cam.centerOn(clampCenter(cx, vw / 2, WORLD_W), clampCenter(cy, vh / 2, WORLD_H));
};

const trackCam = (gs: GameScene, zoom: number, offX: number, offY: number) => {
  let cx = gs.player.x + offX;
  let cy = gs.player.y + offY;
  lockCam(gs);
  camPlace(gs, zoom, cx, cy);
  gs.trailerFrame = (dt) => {
    const k = 1 - Math.exp(-dt * 5);
    cx += (gs.player.x + offX - cx) * k;
    cy += (gs.player.y + offY - cy) * k;
    camPlace(gs, zoom, cx, cy);
  };
};

const followCam = (gs: GameScene, zoom: number, offX: number, offY: number) => {
  const cam = gs.cameras.main;
  cam.setBounds(0, 0, WORLD_W, WORLD_H);
  cam.setZoom(zoom);
  cam.startFollow(gs.player, true, 0.12, 0.12, offX, offY);
};

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

const smooth = (t: number) => {
  const s = clamp01(t);

  return s * s * (3 - 2 * s);
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp01(t);

const placeFeet = (gs: GameScene, tx: number, ty: number) => {
  gs.player.setPosition(tx * TILE + 8, ty * TILE + 12);
};

type SkillStage = number | { level: number; xp: number };

const isLevelOnly = (v: SkillStage): v is number => Number.isFinite(v);

const skillState = (v: SkillStage | undefined) =>
  v !== undefined && isLevelOnly(v)
    ? { level: v, xp: 0 }
    : { level: v?.level ?? 0, xp: v?.xp ?? 0 };

const stageSkills = (levels: Partial<Record<SkillId, SkillStage>>) => {
  const s: SkillsJSON = {
    combat: skillState(levels.combat),
    farming: skillState(levels.farming),
    fishing: skillState(levels.fishing),
    foraging: skillState(levels.foraging),
    mining: skillState(levels.mining),
  };

  store.skills = Skills.fromJSON(s);
};

const holdsLegend = () =>
  store.inv.slots.some((s) => s?.item.kind === "fish" && s.item.fish === "legend");

const selectTool = (match: (item: Item) => boolean) => {
  for (let i = 0; i < store.inv.slots.length; i += 1) {
    const s = store.inv.slots[i];

    if (s && match(s.item)) {
      store.inv.select(i);

      return;
    }
  }
};

const clearFieldObjects = (gs: GameScene) => {
  // oxlint-disable-next-line unicorn/no-useless-spread -- removeObject splices gs.world.objects, so the walk needs its own snapshot
  for (const o of [...gs.world.objects]) {
    if (o.type !== "tree" && o.type !== "rock" && o.type !== "forage") {
      continue;
    }

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
};

const clearField = (gs: GameScene) => {
  clearFieldObjects(gs);

  for (let ty = FIELD_RECT.y0; ty <= FIELD_RECT.y1; ty += 1) {
    for (let tx = FIELD_RECT.x0; tx <= FIELD_RECT.x1; tx += 1) {
      gs.stageTile(tx, ty, { crop: null, daysGrown: 0, tilled: false, watered: false });
    }
  }
};

const RIPE = (growthDays: number) => growthDays;
const ONE_NIGHT_SHORT = (growthDays: number) => Math.max(0, growthDays - 1);

const partGrown = (frac: number) => (growthDays: number) => Math.round(growthDays * frac);

const stageField = (
  gs: GameScene,
  rowCrops: (CropId | null)[],
  days: (growthDays: number) => number,
  watered: boolean,
  y0: number = FIELD_RECT.y0,
  y1: number = FIELD_RECT.y1,
) => {
  clearFieldObjects(gs);

  for (let ty = y0; ty <= y1; ty += 1) {
    const crop = rowCrops[(ty - FIELD_RECT.y0) % rowCrops.length] ?? null;

    for (let tx = FIELD_RECT.x0; tx <= FIELD_RECT.x1; tx += 1) {
      gs.stageTile(tx, ty, {
        crop,
        daysGrown: crop ? days(CROPS[crop].growthDays) : 0,
        tilled: true,
        watered,
      });
    }
  }
};

const standBeside = (gs: GameScene, t: Tile) => {
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

    if (inBounds(c.tx, c.ty) && !gs.world.isSolidTile(c.tx, c.ty)) {
      return c;
    }
  }

  return t;
};

const findOpenPatch = (
  gs: GameScene,
  cx: number,
  cy: number,
  w: number,
  h: number,
  maxR: number,
) => {
  const ok = (x0: number, y0: number) => {
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) {
        if (!inBounds(x, y) || gs.world.isSolidTile(x, y)) {
          return false;
        }
      }
    }

    return true;
  };

  for (let r = 0; r <= maxR; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) {
          continue;
        }

        const x0 = cx + dx - Math.trunc(w / 2);
        const y0 = cy + dy - Math.trunc(h / 2);

        if (ok(x0, y0)) {
          return { tx: x0, ty: y0 };
        }
      }
    }
  }

  return null;
};

const walkRegion = (gs: GameScene, origin: Tile, maxSteps: number) => {
  const open = (x: number, y: number) => inBounds(x, y) && !gs.world.isSolidTile(x, y);
  const dist = new Map<number, number>();

  if (!open(origin.tx, origin.ty)) {
    return dist;
  }

  const queue: Tile[] = [origin];
  dist.set(origin.ty * MAP_W + origin.tx, 0);

  for (const c of queue) {
    const d = dist.get(c.ty * MAP_W + c.tx) ?? 0;

    if (d >= maxSteps) {
      continue;
    }

    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        if (ox === 0 && oy === 0) {
          continue;
        }

        const nx = c.tx + ox;
        const ny = c.ty + oy;

        if (!open(nx, ny)) {
          continue;
        }

        if (ox !== 0 && oy !== 0 && (!open(nx, c.ty) || !open(c.tx, ny))) {
          continue;
        }

        const k = ny * MAP_W + nx;

        if (dist.has(k)) {
          continue;
        }

        dist.set(k, d + 1);
        queue.push({ tx: nx, ty: ny });
      }
    }
  }

  return dist;
};

const spreadTiles = (gs: GameScene, centre: Tile, n: number, gap: number, maxSteps: number) => {
  const reachable = [...walkRegion(gs, centre, maxSteps).entries()]
    .map(([k, d]) => ({ d, tx: k % MAP_W, ty: Math.trunc(k / MAP_W) }))
    .toSorted((a, b) => a.d - b.d);

  const out: Tile[] = [];

  for (const t of reachable) {
    if (out.length >= n) {
      break;
    }

    const clash = out.some((p) => Math.max(Math.abs(p.tx - t.tx), Math.abs(p.ty - t.ty)) < gap);

    if (!clash) {
      out.push({ tx: t.tx, ty: t.ty });
    }
  }

  return out;
};

interface Herd {
  cow: number;
  sheep: number;
  pig: number;
  hen: number;
  duck: number;
}

const stageHerd = (gs: GameScene) => {
  const yard = (type: BuildingKind) => {
    const o = gs.world.objects.find((b) => b.type === type);
    const base = o ? { tx: o.tx, ty: o.ty + 2 } : { tx: 12, ty: 12 };

    return findOpenPatch(gs, base.tx, base.ty, 1, 1, 6) ?? base;
  };

  const barnYard = yard("barn");
  const coopYard = yard("coop");
  const barn = spreadTiles(gs, barnYard, 3, 2, 6);
  const coop = spreadTiles(gs, coopYard, 4, 2, 6);

  const add = (kind: AnimalKind, building: BuildingKind, t: Tile) => {
    const id = store.animalSeq;
    store.animalSeq += 1;

    const d: AnimalSave = {
      building,
      fed: true,
      friendship: 60,
      id,
      kind,
      name: randomAnimalName(store.animalSeq),
      producedToday: false,
      x: t.tx * TILE + 8,
      y: t.ty * TILE + 12,
    };

    gs.animals.stageSpawn(d);

    return id;
  };

  const herd: Herd = {
    cow: add("cow", "barn", barn[0] ?? barnYard),
    duck: add("duck", "coop", coop[1] ?? coopYard),
    hen: add("chicken", "coop", coop[0] ?? coopYard),
    pig: add("pig", "barn", barn[2] ?? barnYard),
    sheep: add("sheep", "barn", barn[1] ?? barnYard),
  };

  add("chicken", "coop", coop[2] ?? coopYard);
  add("chicken", "coop", coop[3] ?? coopYard);

  return herd;
};

const nearestObject = (gs: GameScene, type: "tree" | "rock" | "forage", near: Tile) => {
  let best: Tile | null = null;
  let bd = Infinity;

  for (const o of gs.world.objects) {
    if (o.type !== type) {
      continue;
    }

    const d = Math.abs(o.tx - near.tx) + Math.abs(o.ty - near.ty);

    if (d < bd) {
      bd = d;
      best = { tx: o.tx, ty: o.ty };
    }
  }

  return best;
};

interface FishSpot {
  stand: Tile;
  target: Tile;
}

const findFishingSpot = (gs: GameScene) => {
  const dirs = [
    { bias: 0, x: 0, y: 1 },
    { bias: 6, x: 1, y: 0 },
    { bias: 6, x: -1, y: 0 },
    { bias: 10, x: 0, y: -1 },
  ];

  let best: FishSpot | null = null;
  let bd = Infinity;

  for (let ty = 1; ty < MAP_H - 1; ty += 1) {
    for (let tx = 1; tx < MAP_W - 1; tx += 1) {
      if (gs.world.isSolidTile(tx, ty)) {
        continue;
      }

      for (const d of dirs) {
        const x3 = tx + d.x * 3;
        const y3 = ty + d.y * 3;

        if (!inBounds(x3, y3)) {
          continue;
        }

        let water = true;

        for (let k = 1; k <= 3 && water; k += 1) {
          if (gs.world.cellKind(tx + d.x * k, ty + d.y * k) !== CELL.water) {
            water = false;
          }
        }

        if (!water) {
          continue;
        }

        const dist = Math.abs(tx - 38) + Math.abs(ty - 27) + d.bias;

        if (dist < bd) {
          bd = dist;
          best = { stand: { tx, ty }, target: { tx: tx + d.x * 2, ty: ty + d.y * 2 } };
        }
      }
    }
  }

  return best ?? { stand: { tx: 31, ty: 18 }, target: { tx: 31, ty: 20 } };
};

const findOpenNearMine = (
  mine: MineScene,
  tx: number,
  ty: number,
  ok: (t: Tile) => boolean = () => true,
) => {
  for (let r = 0; r <= 5; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) {
          continue;
        }

        const x = Math.min(MINE_W - 2, Math.max(1, tx + dx));
        const y = Math.min(MINE_H - 2, Math.max(1, ty + dy));

        if (mine.isOpenTile(x, y) && ok({ tx: x, ty: y })) {
          return { tx: x, ty: y };
        }
      }
    }
  }

  return { tx: Math.trunc(MINE_W / 2), ty: 3 };
};

const rowOpen = (mine: MineScene, x0: number, x1: number, ty: number) => {
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 1) {
    if (!mine.isOpenTile(x, ty)) {
      return false;
    }
  }

  return true;
};

interface OreSpot {
  dx: number;
  dy: number;
  kind: OreId;
}

const stageOreAround = (mine: MineScene, at: Tile, spots: OreSpot[], hp = 4) => {
  const placed: Tile[] = [];

  for (const s of spots) {
    const ok = (c: Tile) =>
      Math.abs(c.tx - at.tx) + Math.abs(c.ty - at.ty) >= 3 &&
      placed.every((p) => Math.max(Math.abs(p.tx - c.tx), Math.abs(p.ty - c.ty)) >= 2);

    const t = findOpenNearMine(mine, at.tx + s.dx, at.ty + s.dy, ok);

    if (!ok(t) || !mine.isOpenTile(t.tx, t.ty)) {
      continue;
    }

    if (mine.trailerStageNode(t.tx, t.ty, s.kind, hp)) {
      placed.push(t);
    }
  }
};

const openHeading = (mine: MineScene, from: Tile, n: number) => {
  const dirs = [
    { x: 0, y: 1 },
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ];

  for (const d of dirs) {
    let open = true;

    for (let k = 1; k <= n && open; k += 1) {
      if (!mine.isOpenTile(from.tx + d.x * k, from.ty + d.y * k)) {
        open = false;
      }
    }

    if (open) {
      return d;
    }
  }

  return null;
};

const findArena = (mine: MineScene) => {
  const scan = (x0: number, x1: number, y0: number, y1: number) => {
    let best: Tile | null = null;
    let bd = Infinity;

    for (let ty = y0; ty <= y1; ty += 1) {
      for (let tx = x0; tx <= x1; tx += 1) {
        let ok = true;

        for (let y = ty; y < ty + 5 && ok; y += 1) {
          for (let x = tx; x < tx + 5 && ok; x += 1) {
            if (!mine.isOpenTile(x, y)) {
              ok = false;
            }
          }
        }

        if (!ok) {
          continue;
        }

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
    scan(2, MINE_W - 7, 2, MINE_H - 7) ?? { tx: Math.trunc(MINE_W / 2), ty: Math.trunc(MINE_H / 2) }
  );
};

interface Steerable {
  player: Phaser.GameObjects.Sprite;
  trailerMove: { x: number; y: number; run: boolean } | null;
}

const moveToward = (s: Steerable, tx: number, ty: number, run = false) => {
  const gx = tx * TILE + 8;
  const gy = ty * TILE + 12;
  const dx = gx - s.player.x;
  const dy = gy - s.player.y;
  const d = Math.hypot(dx, dy);

  if (d < 3) {
    s.trailerMove = null;

    return true;
  }

  s.trailerMove = { run, x: dx / d, y: dy / d };

  return false;
};

type Step =
  | { kind: "walk"; at: TileRef; run?: boolean }
  | { kind: "select"; match: (item: Item) => boolean }
  | { kind: "act"; at: TileRef }
  | { kind: "pet"; at: TileRef }
  | { kind: "gift"; at: TileRef }
  | { kind: "face"; at: TileRef }
  | { kind: "pause"; ms: number };

class FarmScript {
  private i = 0;
  private phase = 0;
  private t = 0;
  private route: { x: number; y: number }[] = [];
  private repath = 0;

  private readonly gs: GameScene;
  private readonly steps: Step[];

  constructor(gs: GameScene, steps: Step[]) {
    this.gs = gs;
    this.steps = steps;
  }

  tick(dt: number) {
    const { gs } = this;
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

      if (this.t * 1000 >= step.ms) {
        this.next();
      }

      return;
    }

    const at = resolveTile(step.at);

    if (!at) {
      this.next();

      return;
    }

    switch (step.kind) {
      case "walk": {
        if (this.walk(at, step.run ?? false, dt) || this.t > 2.5) {
          this.next();
        }

        break;
      }

      case "face": {
        gs.faceTowards(at.tx, at.ty);
        this.next();
        break;
      }

      case "act": {
        this.act(at);
        break;
      }

      case "pet": {
        gs.trailerMove = null;
        gs.faceTowards(at.tx, at.ty);

        if (gs.animals.tryPet(at.tx, at.ty) || this.t > 1.2) {
          this.next();
        }

        break;
      }

      case "gift": {
        this.gift(at);
        break;
      }

      default: {
        break;
      }
    }
  }

  private act(at: Tile) {
    const { gs } = this;
    gs.trailerMove = null;

    if (this.phase === 0) {
      if (gs.acting) {
        if (this.t > 2) {
          this.next();
        }

        return;
      }

      gs.faceTowards(at.tx, at.ty);
      gs.tryAction({ tx: at.tx, ty: at.ty });
      this.phase = 1;
      this.t = 0;

      return;
    }

    if (this.phase === 1) {
      if (gs.acting) {
        this.phase = 2;
      } else if (this.t > 0.3) {
        this.next();
      }

      return;
    }

    if (!gs.acting) {
      this.next();
    }
  }

  private gift(at: Tile) {
    const { gs } = this;
    gs.trailerMove = null;

    if (this.phase !== 0) {
      if (!gs.acting || this.t > 2) {
        this.next();
      }

      return;
    }

    gs.faceTowards(at.tx, at.ty);
    this.phase = 1;
    this.t = 0;
    gs.beginAction("doing", () => {
      if (!gs.npcs.tryTalk(at.tx, at.ty, store.inv.selectedItem())) {
        return;
      }

      const mid = (at.tx * TILE + 8 + gs.player.x) / 2;

      const heart = (dx: number) =>
        floatText(gs, mid + dx, at.ty * TILE + 14, "♥", "#ff3d6e", 20, 1200);

      heart(0);
      gs.time.delayedCall(500, () => heart(7));
    });
  }

  private walk(at: Tile, run: boolean, dt: number) {
    const { gs } = this;
    this.repath -= dt;

    if (this.repath <= 0) {
      this.repath = 0.3;
      this.route = gs.pathTo(at.tx, at.ty);
    }

    while (this.route.length > 0) {
      const [wp] = this.route;

      if (!wp) {
        break;
      }

      const dx = wp.x - gs.player.x;
      const dy = wp.y - gs.player.y;
      const d = Math.hypot(dx, dy);

      if (d < 4) {
        this.route.shift();
        continue;
      }

      gs.trailerMove = { run, x: dx / d, y: dy / d };

      return false;
    }

    return moveToward(gs, at.tx, at.ty, run);
  }

  private next() {
    this.i += 1;
    this.phase = 0;
    this.t = 0;
    this.route = [];
    this.repath = 0;
    this.gs.trailerMove = null;
  }
}

const MATURE_ROWS: (CropId | null)[] = [
  "wheat",
  "sunflower",
  "cauliflower",
  "pumpkin",
  "beetroot",
  null,
];

const FALL_ROWS: (CropId | null)[] = ["pumpkin", "wheat", "beetroot", "carrot", "sunflower", null];

const sceneColdOpen = (game: Phaser.Game) => {
  let gs: GameScene | null = null;

  return {
    duration: 3200,
    id: "cold-open-harvest",
    run: () => {
      const g = gs;

      if (!g) {
        return;
      }

      if (g.acting) {
        return;
      }

      const feet = g.feetTile();
      const cs = g.world.crops.get(tileIdx(feet.tx + 1, feet.ty));

      if (cs && isMature(CROPS[cs.crop], cs.daysGrown)) {
        g.trailerMove = null;
        g.faceTowards(feet.tx + 1, feet.ty);
        g.tryAction({ tx: feet.tx + 1, ty: feet.ty });
      } else {
        g.trailerMove = { run: false, x: 1, y: 0 };
      }
    },
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ farming: { level: 4, xp: xpToNext(4) - 18 } });
      gs.timeMin = 720;
      stageField(gs, MATURE_ROWS, RIPE, true);

      for (let tx = FIELD_RECT.x0; tx <= 10; tx += 1) {
        gs.stageTile(tx, 9, { crop: null, daysGrown: 0, tilled: true, watered: false });
      }

      placeFeet(gs, 11, 9);
      gs.faceTowards(12, 9);
      trackCam(gs, zoomFor(gs, 250), 52, -6);
    },
    teardown: () => {
      if (gs) {
        gs.trailerMove = null;
      }
    },
  };
};

const sceneShipping: (game: Phaser.Game) => TrailerScene = (game) => {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let bin: Tile = { tx: 6, ty: 10 };
  let stand: Tile = { tx: 8, ty: 10 };

  return {
    duration: 2300,
    id: "shipping-bin",
    run: (t, dt) => {
      const g = gs;

      if (!g) {
        return;
      }

      script?.tick(dt / 1000);
      const cx = lerp((stand.tx + 5) * TILE, (stand.tx + 4) * TILE, smooth(t / 1400));
      camPlace(g, zoomFor(g, 260), cx, stand.ty * TILE - 4);
    },
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ farming: 5 });
      gs.timeMin = 660;
      stageField(gs, MATURE_ROWS, RIPE, true);
      const o = gs.world.objects.find((b) => b.type === "bin");

      if (o) {
        bin = { tx: o.tx + 1, ty: o.ty };
      }

      stand = standBeside(gs, bin);
      store.inv.add({ crop: "pumpkin", kind: "produce" }, 18);
      store.inv.add({ crop: "cauliflower", kind: "produce" }, 9);
      store.inv.add({ kind: "animal_product", product: "truffle" }, 3);
      store.inv.add({ kind: "animal_product", product: "wool" }, 2);
      store.inv.add({ kind: "animal_product", product: "milk" }, 4);
      store.inv.add({ fish: "tuna", kind: "fish" }, 2);
      store.inv.add({ kind: "resource", res: "crystal" }, 3);
      placeFeet(gs, stand.tx + 4, stand.ty);
      lockCam(gs);
      script = new FarmScript(gs, [
        { at: { tx: stand.tx + 1, ty: stand.ty }, kind: "walk" },
        { at: stand, kind: "walk" },
        { at: bin, kind: "act" },
        { kind: "pause", ms: 1400 },
      ]);
    },
    teardown: () => {
      if (gs) {
        gs.trailerMove = null;
      }
    },
  };
};

const sceneSow: (game: Phaser.Game) => TrailerScene = (game) => {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;

  return {
    duration: 3600,
    id: "verb-sow",
    run: (t, dt) => {
      const g = gs;

      if (!g) {
        return;
      }

      script?.tick(dt / 1000);
      camPlace(g, zoomFor(g, 260), lerp(246, 266, t / 3600), 158);
    },
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({});
      gs.day = 1;
      gs.timeMin = 520;
      clearField(gs);
      stageField(gs, MATURE_ROWS, RIPE, true, FIELD_RECT.y0, 8);
      placeFeet(gs, 14, 9);
      gs.faceTowards(15, 9);
      lockCam(gs);
      script = new FarmScript(gs, [
        { at: { tx: 15, ty: 9 }, kind: "walk" },
        { kind: "select", match: (it) => it.kind === "tool" && it.tool === "hoe" },
        { at: { tx: 15, ty: 10 }, kind: "act" },
        { kind: "select", match: (it) => it.kind === "seed" },
        { at: { tx: 15, ty: 10 }, kind: "act" },
        { kind: "select", match: (it) => it.kind === "tool" && it.tool === "can" },
        { at: { tx: 15, ty: 10 }, kind: "act" },
        { at: { tx: 16, ty: 9 }, kind: "walk" },
        { kind: "select", match: (it) => it.kind === "tool" && it.tool === "hoe" },
        { at: { tx: 16, ty: 10 }, kind: "act" },
      ]);
    },
    teardown: () => {
      if (gs) {
        gs.trailerMove = null;
      }
    },
  };
};

interface Worker {
  id: string;
  ty: number;
  x: number;
  y: number;
  dir: number;
  job: "till" | "plant" | "water";
  lastTx: number;
}

const applyWorkerEdit = (g: GameScene, w: Worker, tx: number) => {
  const cx = tx * TILE + 8;
  const cy = w.ty * TILE + 8;

  if (w.job === "till") {
    g.stageTile(tx, w.ty, { crop: null, daysGrown: 0, tilled: true, watered: false });
    burst(g, cx, cy + 4, {
      colors: [0x8a_6a_43, 0x6b_4f_33, 0xa0_7b_4c],
      count: 7,
      speed: 40,
      up: true,
    });
  } else if (w.job === "plant") {
    g.stageTile(tx, w.ty, { crop: "carrot", daysGrown: 0, tilled: true, watered: false });
    burst(g, cx, cy + 4, { colors: [0x7e_c8_50, 0x4a_9d_3f], count: 5, speed: 30, up: true });
  } else {
    const cs = g.world.crops.get(tileIdx(tx, w.ty));
    g.stageTile(tx, w.ty, {
      crop: cs ? cs.crop : null,
      daysGrown: cs ? cs.daysGrown : 0,
      tilled: true,
      watered: true,
    });
    burst(g, cx, cy, {
      colors: [0x6f_c6_ff, 0x9f_e0_ff, 0xff_ff_ff],
      count: 6,
      gravity: 200,
      speed: 35,
      up: true,
    });
  }
};

const sceneCoop: (game: Phaser.Game) => TrailerScene = (game) => {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let remote: RemoteFarmers | null = null;
  let workers: Worker[] = [];
  const net = new FixedRate(NET_TICK_HZ);

  return {
    duration: 3800,
    id: "coop-farm",
    run: (t, dt) => {
      const g = gs;
      const r = remote;

      if (!g || !r) {
        return;
      }

      const s = dt / 1000;
      script?.tick(s);

      for (const w of workers) {
        w.x += w.dir * 46 * s;
        const tx = Math.floor(w.x / TILE);

        if (tx !== w.lastTx && tx >= FIELD_RECT.x0 && tx <= FIELD_RECT.x1) {
          w.lastTx = tx;
          applyWorkerEdit(g, w, tx);
        }

        if (w.x < (FIELD_RECT.x0 + 1) * TILE) {
          w.dir = 1;
        }

        if (w.x > FIELD_RECT.x1 * TILE) {
          w.dir = -1;
        }
      }

      if (net.due(dt)) {
        const stamp = Math.round(performance.now());
        const players: PlayerMap = {};

        for (const w of workers) {
          players[w.id] = {
            id: w.id,
            state: { f: w.dir < 0, m: true, t: stamp, x: w.x, y: w.y },
          };
        }

        r.sync(players, "you");
      }

      r.update();
      camPlace(g, zoomFor(g, lerp(250, 232, smooth(t / 3800))), 248, 146);
    },
    setup: async () => {
      gs = await freshFarm(game);
      const g = gs;
      stageSkills({ farming: 3 });
      g.timeMin = 640;
      clearField(g);
      stageField(g, ["parsnip", "carrot", null, null, null, null], partGrown(0.5), true, 6, 7);
      placeFeet(g, 15, 10);
      g.faceTowards(15, 11);
      remote = new RemoteFarmers(g);
      workers = [
        { dir: 1, id: "mira", job: "till", lastTx: -1, ty: 8, x: 11 * TILE, y: 8 * TILE + 12 },
        { dir: -1, id: "otto", job: "plant", lastTx: -1, ty: 9, x: 20 * TILE, y: 9 * TILE + 12 },
        { dir: 1, id: "juno", job: "water", lastTx: -1, ty: 7, x: 14 * TILE, y: 7 * TILE + 12 },
      ];
      net.reset();
      script = new FarmScript(g, [
        { kind: "select", match: (it) => it.kind === "tool" && it.tool === "hoe" },
        { at: { tx: 15, ty: 11 }, kind: "act" },
        { kind: "select", match: (it) => it.kind === "seed" },
        { at: { tx: 15, ty: 11 }, kind: "act" },
        { at: { tx: 16, ty: 10 }, kind: "walk" },
        { kind: "select", match: (it) => it.kind === "tool" && it.tool === "hoe" },
        { at: { tx: 16, ty: 11 }, kind: "act" },
        { kind: "select", match: (it) => it.kind === "seed" },
        { at: { tx: 16, ty: 11 }, kind: "act" },
      ]);
      lockCam(g);
      camPlace(g, zoomFor(g, 250), 248, 146);
    },
    teardown: () => {
      if (gs) {
        gs.trailerMove = null;
      }

      remote?.sync({}, "you");
      remote = null;
    },
  };
};

const sceneAnimals: (game: Phaser.Game) => TrailerScene = (game) => {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;

  return {
    duration: 4400,
    id: "animals",
    run: (_t, dt) => script?.tick(dt / 1000),
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({});
      gs.timeMin = 780;
      const g = gs;
      const herd = stageHerd(g);

      const beside = (id: number) =>
        function besideAnimal() {
          const t = g.animals.trailerTileOf(id);

          return t ? standBeside(g, t) : null;
        };

      const at = (id: number) => () => g.animals.trailerTileOf(id);
      const cow0 = g.animals.trailerTileOf(herd.cow) ?? { tx: 61, ty: 11 };
      const start = findOpenPatch(g, cow0.tx + 3, cow0.ty, 1, 1, 3) ?? standBeside(g, cow0);
      placeFeet(g, start.tx, start.ty);
      followCam(g, zoomFor(g, 280), -34, -16);
      script = new FarmScript(g, [
        { at: beside(herd.cow), kind: "walk" },
        { at: at(herd.cow), kind: "pet" },
        { kind: "pause", ms: 380 },
        { at: beside(herd.pig), kind: "walk" },
        { at: at(herd.pig), kind: "pet" },
        { kind: "pause", ms: 340 },
        { at: beside(herd.hen), kind: "walk", run: true },
        { at: at(herd.hen), kind: "pet" },
        { kind: "pause", ms: 400 },
        { at: beside(herd.cow), kind: "walk", run: true },
      ]);
      const first = beside(herd.cow)();

      if (first) {
        moveToward(g, first.tx, first.ty);
      }
    },
    teardown: () => {
      if (gs) {
        gs.trailerMove = null;
      }
    },
  };
};

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

const sceneMine: (game: Phaser.Game) => TrailerScene = (game) => {
  let mine: MineScene | null = null;
  let emberAcc = 0;

  return {
    duration: 3600,
    id: "mine-combat",
    run: (_t, dt) => {
      const m = mine;

      if (!m) {
        return;
      }

      emberAcc += dt;

      if (emberAcc > 90) {
        emberAcc = 0;
        burst(m, m.player.x + (Math.random() - 0.5) * 12, m.player.y - 10, {
          colors: [0xff_b4_5c, 0xff_d3_4d],
          count: 1,
          gravity: -14,
          life: 520,
          size: 2,
          speed: 8,
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
        m.trailerMove = { run: false, x: dx / d, y: dy / d };
      } else {
        m.trailerMove = null;
        m.tryAction();
      }
    },
    setup: async () => {
      mine = await freshMine(game, 6);
      stageSkills({ combat: 4, mining: 3 });
      store.hp = store.maxHp();
      store.energy = 100;
      selectTool((it) => it.kind === "tool" && it.tool === "sword");
      const c = findArena(mine);
      mine.player.setPosition(c.tx * TILE + 8, c.ty * TILE + 8);
      mine.trailerZoom = zoomFor(mine, 260);
      mine.cameras.main.setZoom(mine.trailerZoom);
      emberAcc = 0;
      stageOreAround(mine, c, ARENA_ORE);

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

          return { hp: o.hp, tx: s.tx, ty: s.ty };
        }),
      );
    },
    teardown: () => {
      if (mine) {
        mine.trailerMove = null;
      }
    },
  };
};

const LANDING_ORE: OreSpot[] = [
  { dx: -5, dy: 1, kind: "coal" },
  { dx: -3, dy: 4, kind: "copper" },
  { dx: 3, dy: 3, kind: "crystal" },
  { dx: 6, dy: 1, kind: "copper" },
  { dx: 5, dy: 4, kind: "coal" },
  { dx: -6, dy: 4, kind: "crystal" },
];

const DESCEND_AT_MS = 2400;

const sceneMineDeeper: (game: Phaser.Game) => TrailerScene = (game) => {
  let mine: MineScene | null = null;
  let ladder: Tile = { tx: 0, ty: 0 };
  let descended = false;
  let staged = false;
  let heading: { x: number; y: number } | null = null;
  let landingOre: Tile | null = null;
  let emberAcc = 0;

  return {
    duration: 5600,
    id: "mine-deeper",
    run: (t, dt) => {
      const m = mine;

      if (!m) {
        return;
      }

      emberAcc += dt;

      if (emberAcc > 90) {
        emberAcc = 0;
        burst(m, m.player.x + (Math.random() - 0.5) * 12, m.player.y - 10, {
          colors: [0xff_b4_5c, 0xff_d3_4d],
          count: 1,
          gravity: -14,
          life: 520,
          size: 2,
          speed: 8,
        });
      }

      if (descended) {
        m.trailerMove = heading ? { run: false, x: heading.x, y: heading.y } : null;

        if (landingOre && !m.isOpenTile(landingOre.tx, landingOre.ty)) {
          const d = Math.hypot(
            landingOre.tx * TILE + 8 - m.player.x,
            landingOre.ty * TILE + 8 - m.player.y,
          );

          if (d < 20) {
            m.tryAction();
          }
        }

        return;
      }

      if (staged && t < 1200) {
        m.trailerMove = null;
        m.tryAction();

        return;
      }

      if (t < DESCEND_AT_MS) {
        moveToward(m, ladder.tx, ladder.ty);

        return;
      }

      m.trailerMove = null;
      descended = true;
      m.events.once(Scenes.Events.CREATE, () => {
        const feet = {
          tx: Math.floor(m.player.x / TILE),
          ty: Math.floor((m.player.y - 1) / TILE),
        };

        heading = openHeading(m, feet, 3);

        if (heading && (heading.x === 0 || heading.y === 0)) {
          const ahead = { tx: feet.tx + heading.x * 4, ty: feet.ty + heading.y * 4 };

          if (
            m.isOpenTile(ahead.tx, ahead.ty) &&
            m.trailerStageNode(ahead.tx, ahead.ty, "crystal", 2)
          ) {
            landingOre = ahead;
          }
        }

        stageOreAround(m, feet, LANDING_ORE);
      });
      m.descend();
    },
    setup: async () => {
      mine = await freshMine(game, 8);
      stageSkills({ combat: 4, mining: 6 });
      store.hp = store.maxHp();
      store.energy = 100;
      selectTool((it) => it.kind === "tool" && it.tool === "pickaxe");
      const m = mine;
      descended = false;
      heading = null;
      landingOre = null;
      emberAcc = 0;
      ladder = m.trailerLadderDown();
      const floorBelow = (t: Tile) => t.ty <= MINE_H - 3 && m.isOpenTile(t.tx, t.ty + 1);

      const straightToLadder = (t: Tile) => t.ty === ladder.ty && rowOpen(m, t.tx, ladder.tx, t.ty);

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
      m.trailerStageEnemies([]);
      m.trailerZoom = zoomFor(m, 250);
      m.cameras.main.setZoom(m.trailerZoom);
    },
    teardown: () => {
      if (mine) {
        mine.trailerMove = null;
      }
    },
  };
};

const sceneGather: (game: Phaser.Game) => TrailerScene = (game) => {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;

  return {
    duration: 3600,
    id: "gather-run",
    run: (_t, dt) => {
      script?.tick(dt / 1000);
    },
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ foraging: 4 });
      gs.timeMin = 900;
      const g = gs;
      const tree = nearestObject(g, "tree", { tx: 5, ty: 40 }) ?? { tx: 5, ty: 40 };
      const shrooms: Tile[] = [];

      for (const o of g.world.objects) {
        if (o.type !== "forage") {
          continue;
        }

        if (Math.abs(o.tx - tree.tx) + Math.abs(o.ty - tree.ty) <= 5) {
          shrooms.push({ tx: o.tx, ty: o.ty });
        }
      }

      shrooms.sort((a, b) => b.tx - a.tx);
      const chopFrom = standBeside(g, tree);
      const start = findOpenPatch(g, tree.tx + 5, tree.ty + 3, 1, 1, 4) ?? chopFrom;
      placeFeet(g, start.tx, start.ty);
      g.faceTowards(start.tx - 1, start.ty);

      const steps: Step[] = shrooms
        .slice(0, 2)
        .map((s) => ({ at: s, kind: "walk", run: true }) satisfies Step);

      steps.push(
        { at: chopFrom, kind: "walk" },
        { kind: "select", match: (it) => it.kind === "tool" && it.tool === "axe" },
      );

      for (let i = 0; i < 3; i += 1) {
        steps.push({ at: tree, kind: "act" });
      }

      script = new FarmScript(g, steps);
      trackCam(g, zoomFor(g, 300), -26, 4);
      moveToward(g, start.tx - 1, start.ty, true);
    },
    teardown: () => {
      if (gs) {
        gs.trailerMove = null;
      }
    },
  };
};

const sceneFishing: (game: Phaser.Game) => TrailerScene = (game) => {
  let gs: GameScene | null = null;
  let cx = 0;
  let cy = 0;
  let caught = -1;

  return {
    duration: 4800,
    id: "fishing",
    run: (t, dt) => {
      const g = gs;

      if (!g) {
        return;
      }

      if (caught < 0) {
        if (t > 1200 && holdsLegend()) {
          caught = t;
        }

        return;
      }

      const k = smooth((t - caught) / 600);
      const follow = 1 - Math.exp(-(dt / 1000) * 4);
      cx += (g.player.x + lerp(34, -14, k) - cx) * follow;
      cy += (g.player.y + lerp(16, 4, k) - cy) * follow;
      camPlace(g, zoomFor(g, lerp(340, 250, k)), cx, cy);

      if (!g.fishing.active) {
        g.trailerMove = { run: false, x: -1, y: 0 };
      }
    },
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ fishing: 10 });
      gs.timeMin = 1185;
      PhaserMath.RND.sow(["vg-trailer-fish"]);
      const spot = findFishingSpot(gs);
      placeFeet(gs, spot.stand.tx, spot.stand.ty);
      selectTool((it) => it.kind === "tool" && it.tool === "rod");
      lockCam(gs);
      caught = -1;
      cx = spot.stand.tx * TILE + 8 + 34;
      cy = spot.stand.ty * TILE + 12 + 16;
      camPlace(gs, zoomFor(gs, 340), cx, cy);
      gs.fishing.trailerAuto = true;
      gs.fishing.trailerFish = FISH.legend;
      gs.fishing.startCast(spot.target.tx, spot.target.ty);
    },
    teardown: () => {
      if (gs) {
        gs.trailerMove = null;
      }
    },
  };
};

const sceneVillager: (game: Phaser.Game) => TrailerScene = (game) => {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let away: Tile = { tx: 0, ty: 0 };
  let handedAt = 0;
  let sent = false;

  return {
    duration: 2800,
    id: "villager-gift",
    run: (t, dt) => {
      const g = gs;

      if (!g) {
        return;
      }

      script?.tick(dt / 1000);

      if (handedAt === 0 && !holdsLegend()) {
        handedAt = t;
      }

      if (!sent && handedAt > 0 && t - handedAt > 400) {
        sent = true;
        g.npcs.trailerWalkTo("finn", away.tx, away.ty);
      }
    },
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ fishing: 10 });
      gs.timeMin = 1185;
      const g = gs;
      const spot = findFishingSpot(g);
      const finn = { tx: spot.stand.tx - 5, ty: spot.stand.ty };
      g.npcs.trailerVisible(["finn"]);
      g.npcs.placeNpc("finn", finn.tx, finn.ty);
      g.npcs.trailerWalkTo("finn", finn.tx, finn.ty);
      store.inv.add({ fish: "legend", kind: "fish" }, 1);
      selectTool((it) => it.kind === "fish");
      placeFeet(g, spot.stand.tx, spot.stand.ty);
      const finnAt = () => g.npcs.trailerTileOf("finn");

      const beside = () => {
        const t = finnAt();

        return t ? { tx: t.tx + 1, ty: t.ty } : null;
      };

      script = new FarmScript(g, [
        { at: beside, kind: "walk" },
        { at: finnAt, kind: "gift" },
        { kind: "pause", ms: 1600 },
      ]);
      away = findOpenPatch(g, finn.tx - 3, finn.ty, 1, 1, 3) ?? { tx: finn.tx - 3, ty: finn.ty };
      handedAt = 0;
      sent = false;
      trackCam(g, zoomFor(g, 215), -20, -6);
      const first = beside();

      if (first) {
        moveToward(g, first.tx, first.ty);
      }
    },
    teardown: () => {
      if (gs) {
        gs.trailerMove = null;
      }
    },
  };
};

const stageSeason = (g: GameScene, idx: number) => {
  if (idx === 0) {
    g.day = 1;
    g.weather = "sunny";
    g.timeMin = 430;
    stageField(
      g,
      ["parsnip", "carrot", "potato", "parsnip", "carrot", null],
      partGrown(0.45),
      true,
    );
  } else if (idx === 1) {
    g.day = 30;
    g.weather = "sunny";
    g.timeMin = 760;
    stageField(g, ["radish", "kale", "sunflower", "cabbage", "radish", null], RIPE, true);
  } else if (idx === 2) {
    g.day = 90;
    g.weather = "snow";
    g.timeMin = 1220;
    stageField(g, ["kale", null, "kale", null, null, null], partGrown(0.6), false);
  } else {
    g.day = 60;
    g.weather = "rain";
    g.timeMin = 1150;
    stageField(g, ["pumpkin", "beetroot", "pumpkin", "wheat", "beetroot", null], RIPE, false);
  }
};

const sceneSeasons: (game: Phaser.Game) => TrailerScene = (game) => {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let seg = -1;

  return {
    duration: 4200,
    id: "seasons-timelapse",
    run: (t, dt) => {
      const g = gs;

      if (!g) {
        return;
      }

      script?.tick(dt / 1000);
      const idx = Math.min(3, Math.floor(t / 1050));

      if (idx !== seg) {
        seg = idx;
        stageSeason(g, idx);
      }

      if (idx === 2) {
        const view = g.cameras.main.worldView;

        for (let i = 0; i < 2; i += 1) {
          burst(
            g,
            view.x + Math.random() * view.width,
            view.y + Math.random() * view.height * 0.4,
            {
              colors: [0xff_ff_ff, 0xee_f4_ff],
              count: 3,
              gravity: 16,
              life: 2200,
              size: 3,
              speed: 10,
            },
          );
        }
      }
    },
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({});
      seg = -1;
      stageSeason(gs, 0);
      placeFeet(gs, 12, 11);
      gs.faceTowards(13, 11);
      script = new FarmScript(gs, [
        { at: { tx: 19, ty: 11 }, kind: "walk" },
        { at: { tx: 13, ty: 11 }, kind: "walk" },
      ]);
      lockCam(gs);
      camPlace(gs, Math.max(zoomFor(gs, 300), fitZoom(gs)), 248, 148);
    },
    teardown: () => {
      if (gs) {
        gs.trailerMove = null;
      }
    },
  };
};

const sceneNight: (game: Phaser.Game) => TrailerScene = (game) => {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let fireflyAcc = 0;
  let slept = false;
  let reframed = false;
  const SLEEP_AT = 2300;

  return {
    duration: 4800,
    id: "night-sleep",
    run: (t, dt) => {
      const g = gs;

      if (!g) {
        return;
      }

      if (!slept) {
        g.timeMin = lerp(1245, 1350, t / SLEEP_AT);
        camPlace(g, zoomFor(g, lerp(360, 300, smooth(t / SLEEP_AT))), 494, 246);
        script?.tick(dt / 1000);
        fireflyAcc += dt;

        if (fireflyAcc > 60) {
          fireflyAcc = 0;
          burst(g, g.player.x + (Math.random() - 0.5) * 150, g.player.y - 12 - Math.random() * 70, {
            colors: [0xff_e2_7a, 0xff_f3_c4, 0xff_d3_4d],
            count: 3,
            gravity: -6,
            life: 2200,
            size: 3,
            speed: 7,
          });
        }

        if (t >= SLEEP_AT) {
          slept = true;
          g.trailerMove = null;
          g.doSleep();
        }

        return;
      }

      if (!reframed && t > SLEEP_AT + 400) {
        reframed = true;
        camPlace(g, zoomFor(g, 300), 248, 150);
      }
    },
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ farming: 5 });
      const g = gs;
      let day = 57;

      while (day < 83 && weatherForDay(FARM_SEED, day + 1) !== "rain") {
        day += 1;
      }

      g.day = day;
      g.weather = weatherForDay(FARM_SEED, day);
      g.timeMin = 1245;
      stageField(g, FALL_ROWS, ONE_NIGHT_SHORT, true);
      fireflyAcc = 0;
      slept = false;
      reframed = false;
      const house = g.world.objects.find((o) => o.type === "house");
      const door = house ? { tx: house.tx, ty: house.ty + 1 } : { tx: 31, ty: 16 };
      placeFeet(g, door.tx - 3, door.ty + 1);
      lockCam(g);
      script = new FarmScript(g, [
        { at: { tx: door.tx - 1, ty: door.ty + 1 }, kind: "walk" },
        { at: door, kind: "walk" },
        { at: { tx: door.tx, ty: door.ty - 1 }, kind: "face" },
      ]);
      moveToward(g, door.tx - 1, door.ty + 1, false);
      camPlace(g, zoomFor(g, 360), 494, 246);
    },
    teardown: () => {
      if (gs) {
        gs.trailerMove = null;
      }
    },
  };
};

const sceneFullFarm: (game: Phaser.Game) => TrailerScene = (game) => {
  let gs: GameScene | null = null;
  let script: FarmScript | null = null;
  let startCx = 0;
  let startCy = 0;
  const HOLD = 1000;
  const DUR = 3900;
  const STAND: Tile = { tx: 14, ty: 10 };
  const CROP: Tile = { tx: 14, ty: 9 };
  const END_W = 560;
  const END_CX = 360;
  const END_CY = 190;

  return {
    duration: DUR,
    id: "full-farm",
    run: (t, dt) => {
      const g = gs;

      if (!g) {
        return;
      }

      script?.tick(dt / 1000);
      const cam = g.cameras.main;
      const x = clamp01((t - HOLD) / (DUR - HOLD));
      const k = 1 - (1 - x) ** 1.7;
      const w = lerp(300, END_W, k);
      camPlace(g, cam.width / w, lerp(startCx, END_CX, k), lerp(startCy, END_CY, k));
    },
    setup: async () => {
      gs = await freshFarm(game);
      stageSkills({ farming: 5 });
      gs.timeMin = 1190;
      stageField(gs, MATURE_ROWS, RIPE, true);
      stageHerd(gs);
      placeFeet(gs, STAND.tx, STAND.ty);
      gs.faceTowards(CROP.tx, CROP.ty);
      startCx = gs.player.x;
      startCy = gs.player.y - 10;
      lockCam(gs);
      camPlace(gs, zoomFor(gs, 300), startCx, startCy);
      script = new FarmScript(gs, [
        { at: CROP, kind: "act" },
        { at: { tx: 18, ty: 9 }, kind: "walk" },
        { at: { tx: 21, ty: 8 }, kind: "walk" },
        { at: { tx: 21, ty: 6 }, kind: "walk" },
        { at: { tx: 18, ty: 6 }, kind: "walk" },
      ]);
    },
    teardown: () => {
      if (gs) {
        gs.trailerMove = null;
      }
    },
  };
};

export const startTrailer = (game: Phaser.Game) => {
  enableTrailerStaging();
  disableSaves();
  Sound.muted = true;

  runTrailer({
    cutMs: 200,
    onGesture: () => {
      Sound.resume();
      Sound.muted = false;
    },
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
    ].map((scene) => ({
      ...scene,
      setup: () => {
        getGame(game).trailerFrame = null;

        return scene.setup();
      },
    })),
    vignette: false,
  });
};
