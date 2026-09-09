import type Phaser from "phaser";
import { Animations, Cameras, Math as PhaserMath, Scene, Scenes } from "phaser";
import { PhysicalGamepad } from "@vibedgames/gamepad";
import type { PhaserGamepad } from "@vibedgames/gamepad/phaser";
import { notifyGameStarted } from "@repo/embed";
import {
  TILE,
  zoomForWidth,
  MAP_W,
  MAP_H,
  WALK_SPEED,
  RUN_SPEED,
  CHAR_ORIGIN_Y,
  MAX_ENERGY,
  ENERGY_PER_SWING,
  CAN_MAX,
  DAY_START_MIN,
  DAY_END_MIN,
  GAME_MIN_PER_REAL_SEC,
  HP_REGEN_PER_DAY,
  DEPTH,
  MP_ROOM,
  MP_MAX_PLAYERS,
  OFFLINE_FALLBACK_MS,
  NET_TICK_HZ,
  CLOCK_TICK_HZ,
  FARM_SEED,
} from "../config";
import { isJsonNumber, isJsonObject, isJsonString } from "../json";
import type { JsonValue } from "../json";
import { NetSession } from "../net/session";
import { RemoteFarmers } from "../net/remote-farmers";
import { World, GROUND, inBounds, tileIdx } from "../world/world";
import type { WorldObject } from "../world/world";
import { generateFarm, MINE_EXIT, consumedSprites } from "../world/mapgen";
import { getWorldMap } from "../world/map-store";
import { buildWorldMap } from "../render/worldmap-render";
import { CELL } from "../world/worldmap";
import type { WorldMapSprite } from "../world/worldmap";
import { Inventory } from "../systems/inventory";
import { Skills, SKILL_NAMES } from "../systems/skills";
import type { SkillId } from "../systems/skills";
import { store } from "../systems/store";
import { CROPS, cropStage, isMature } from "../data/crops";
import type { CropId } from "../data/crops";
import { isSellable, sellValue } from "../data/items";
import type { Item, ForageId, ToolId } from "../data/items";
import { loadSave, writeSave } from "../systems/save";
import type { SaveData } from "../systems/save";
import { burst, floatText, shake, pop } from "../render/fx";
import { Sound } from "../render/audio";
import { seasonOfDay } from "../data/calendar";
import type { Season } from "../data/calendar";
import { isWet, weatherForDay } from "../systems/weather";
import type { Weather } from "../systems/weather";
import { Fishing } from "../systems/fishing";
import { makeGameKeys, NUM_KEY_NAMES } from "../systems/keys";
import type { GameKeys } from "../systems/keys";
import { stickMove } from "../systems/stick";
import type { StickMove } from "../systems/stick";
import { isTap } from "../systems/touch";
import { syncTouchControls } from "../touch-controls";
import { AnimalManager } from "../entities/animals";
import { NpcManager } from "../entities/npcs";

type CharAction = "dig" | "water" | "axe" | "mine" | "doing";

declare global {
  interface Window {
    /** DEV-only hook for headless verification. */
    __gs?: GameScene;
  }
}

/** Routine saves are debounced: flushed at most this often (seconds). */
const SAVE_FLUSH_SEC = 3;

// ---- trailer mode (src/trailer/) --------------------------------------------
// Set once by the trailer director before the scene boots. Keeps a staged demo
// run fully isolated: no co-op session, no HUD scene. Dead in normal play.
let trailerStaging = false;
export const enableTrailerStaging = (): void => {
  trailerStaging = true;
};

/** A single tile's synced state: tilled, watered, crop id (or null), grow-days. */
interface TileEdit {
  t: number;
  w: number;
  c: CropId | null;
  d: number;
}

/** A guest's farming action, parsed + validated at the wire boundary. */
interface TileIntent {
  idx: number;
  action: "till" | "water" | "plant" | "harvest";
  crop?: CropId;
}

const isCropId = (v: JsonValue | undefined): v is CropId => isJsonString(v) && v in CROPS;

const parseTileIntent = (payload: JsonValue): TileIntent | null => {
  if (!isJsonObject(payload)) {
    return null;
  }
  const { idx } = payload;
  const { action } = payload;
  const { crop } = payload;
  if (!isJsonNumber(idx) || !Number.isInteger(idx) || idx < 0 || idx >= MAP_W * MAP_H) {
    return null;
  }
  if (action === "till" || action === "water" || action === "harvest") {
    return { action, idx };
  }
  // A planted crop id must be a real crop: a bogus one would crash rendering
  // on every client AND poison the save (black screen on every reload).
  if (action === "plant" && isCropId(crop)) {
    return { action, crop, idx };
  }
  return null;
};
const ACTION_TIMING = {
  axe: [16, 10, 7],
  dig: [18, 13, 9],
  doing: [14, 8, 4],
  mine: [16, 10, 7],
  water: [9, 5, 3],
} satisfies Record<CharAction, [number, number, number]>;

interface NightTint {
  color: number;
  alpha: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * PhaserMath.Clamp(t, 0, 1);

// weather darkens the day a touch
const WEATHER_DIM: Record<Weather, number> = { rain: 0.12, snow: 0.08, storm: 0.22, sunny: 0 };

const tintFor = (timeMin: number, weather: Weather): NightTint => {
  const wx = WEATHER_DIM[weather];
  const wcol = isWet(weather) ? 0x2a_35_50 : 0x9f_b6_d8;
  let base: NightTint;
  if (timeMin < 9 * 60) {
    base = { alpha: lerp(0.16, 0, (timeMin - DAY_START_MIN) / (3 * 60)), color: 0xff_e2_a8 };
  } else if (timeMin < 17 * 60) {
    base = { alpha: 0, color: 0xff_ff_ff };
  } else if (timeMin < 20 * 60) {
    base = { alpha: lerp(0, 0.26, (timeMin - 17 * 60) / (3 * 60)), color: 0xff_8a_3a };
  } else if (timeMin < 24 * 60) {
    base = { alpha: lerp(0.28, 0.52, (timeMin - 20 * 60) / (4 * 60)), color: 0x14_22_4a };
  } else {
    base = { alpha: lerp(0.52, 0.64, (timeMin - 24 * 60) / (2 * 60)), color: 0x0a_12_30 };
  }
  if (wx > 0 && base.alpha < wx) {
    return { alpha: wx, color: base.alpha > 0.1 ? base.color : wcol };
  }
  return base;
};

/** Compact change-signature for a synced tile (skip redundant re-renders). */
const tileSig = (e: TileEdit): string => `${e.t}${e.w}${e.c ?? "-"}:${e.d}`;

/** A BFS flood: step count from the start per cell (-1 = unreachable), and the
 *  cell each one was reached from. */
interface Flood {
  dist: Int32Array;
  parent: Int32Array;
}

/** The clicked cell when it is reachable, else the nearest reachable cell
 *  beside it; -1 when nothing around it connects. */
const reachableGoal = (dist: Int32Array, tx: number, ty: number): number => {
  const clicked = ty * MAP_W + tx;
  if ((dist[clicked] ?? -1) >= 0) {
    return clicked;
  }
  let goal = -1;
  let best = Infinity;
  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      const nx = tx + ox;
      const ny = ty + oy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) {
        continue;
      }
      const d = dist[ny * MAP_W + nx] ?? -1;
      if (d >= 0 && d < best) {
        best = d;
        goal = ny * MAP_W + nx;
      }
    }
  }
  return goal;
};

export class GameScene extends Scene {
  world!: World;
  day = 1;
  timeMin = DAY_START_MIN;
  canCharge = CAN_MAX;
  uiOpen = false;
  weather: Weather = "sunny";

  private seed = 0;
  player!: Phaser.GameObjects.Sprite;
  private shadow!: Phaser.GameObjects.Sprite;
  facing = { x: 0, y: 1 };
  acting = false;
  private moving = false;
  // click-to-move: waypoint pixel positions the player walks through
  private clickPath: { x: number; y: number }[] = [];
  private pathStuck = 0;

  private soilImgs = new Map<number, Phaser.GameObjects.Image>();
  private cropImgs = new Map<number, Phaser.GameObjects.Image>();
  objSprites = new Map<number, Phaser.GameObjects.Sprite>();
  private highlight!: Phaser.GameObjects.Graphics;
  private nightOverlay!: Phaser.GameObjects.Rectangle;

  private keys!: GameKeys;
  /** Attached by Hud — the pad must render there, outside this camera's zoom. */
  gamepad?: PhaserGamepad;
  /** Physical controller — polled here (this scene owns the frame while active). */
  private readonly pad = new PhysicalGamepad();
  transitioning = false;
  private pendingSpawn = { x: 0, y: 0 };
  private stepTimer = 0;

  fishing!: Fishing;
  animals!: AnimalManager;
  npcs!: NpcManager;
  /** Trailer-mode scripted movement — read like a stick when real input is silent. */
  trailerMove: { x: number; y: number; run: boolean } | null = null;
  /**
   * Trailer-mode per-frame choreography, run at the END of update() so a
   * camera placed from it frames the pose this frame is about to draw.
   *
   * The trailer shell drives scenes from its own rAF, which fires after
   * Phaser's game loop — a TrackCam placed straight from `run()` chases the
   * farmer's PREVIOUS position, so the offset it holds him at wobbles with the
   * frame time instead of staying put.
   */
  trailerFrame: ((dt: number) => void) | null = null;
  private fainted = false;
  private onResizeHandler?: (gs: Phaser.Structs.Size) => void;
  private saveHandler = (): void => this.save();
  /** Debounced-save state: actions mark dirty, update() flushes (see save). */
  private saveDirty = false;
  private saveAcc = 0;

  // ---- multiplayer (co-op shared farm) ---------------------------------------
  // The host owns the world (tilled/watered/crops) and the clock; guests adopt
  // both and send farming actions as intents. Inventory/energy stay per-player.
  // Created in create(), NOT at page load: Phaser constructs every scene at
  // boot, and a socket opened from the title screen would join (and possibly
  // HOST) the room with no world and no update loop — a dead room for everyone.
  private net?: NetSession;
  private remoteFarmers?: RemoteFarmers;
  private netAcc = 0;
  private clockAcc = 0;
  /** Whether this client has pushed its full farm to the room yet. */
  private worldPublished = false;
  /** Host actions received while the scene was stopped (host in the mine). */
  private pendingTileIntents: TileIntent[] = [];
  /** Identity of the last-processed shared tiles blob (skip re-scans). */
  private lastTilesRef: JsonValue | null = null;
  /** Host: authoritative per-tile edits (idx → packed state). */
  private tileEdits = new Map<number, TileEdit>();
  /** Signatures already applied locally, to skip redundant re-renders. */
  private appliedTiles = new Map<number, string>();

  constructor() {
    super("Game");
  }

  private get amHost(): boolean {
    // No session (multiplayer-ineligible save, or pre-create) = solo world.
    return this.net ? this.net.isHost : true;
  }

  create(data: { mode: "new" | "continue"; fromMine?: boolean; fainted?: boolean }): void {
    notifyGameStarted();
    document.querySelector("#veil")?.classList.add("hidden");
    // reset reused-instance state (Phaser keeps the scene instance across start/stop)
    this.soilImgs = new Map();
    this.cropImgs = new Map();
    this.objSprites = new Map();
    this.acting = false;
    this.transitioning = false;
    this.uiOpen = false;
    this.facing = { x: 0, y: 1 };
    this.fainted = false;
    this.stepTimer = 0;
    this.clickPath = [];
    this.pathStuck = 0;
    this.saveDirty = false;
    this.saveAcc = 0;
    this.trailerMove = null;

    if (data?.fromMine) {
      // returning from the mine — world/state already initialized; just rebuild
      this.restoreFromStore();
      if (data.fainted) {
        this.fainted = true;
      }
    } else {
      const s = data?.mode === "continue" ? loadSave() : null;
      if (s) {
        this.loadFrom(s);
      } else {
        this.startNew();
      }
    }
    this.weather = weatherForDay(this.seed, this.day);

    // Join the co-op room only for the shared fixed-seed farm. A continue-mode
    // save from before the fixed seed is a DIFFERENT map — half-merging two
    // worlds (tilling grass that is water elsewhere) is worse than playing it
    // solo (Phase 1). The session survives mine trips: only created once.
    if (!trailerStaging && !this.net && this.seed === FARM_SEED) {
      this.net = new NetSession({
        fallbackMs: OFFLINE_FALLBACK_MS,
        maxPlayers: MP_MAX_PLAYERS,
        onEvent: (event, payload, from) => this.handleNetEvent(event, payload, from),
        room: MP_ROOM,
      });
    }

    this.buildGround();
    this.buildObjects();
    this.buildSoilAndCrops();

    this.shadow = this.add
      .sprite(0, 0, "char-shadow-tex")
      .setOrigin(0.5, 0.5)
      .setScale(1.1, 1)
      .setAlpha(0.35);
    this.player = this.add.sprite(0, 0, "p-idle").setOrigin(0.5, CHAR_ORIGIN_Y).play("p-idle");
    this.player.setPosition(this.pendingSpawn.x, this.pendingSpawn.y);

    this.highlight = this.add.graphics().setDepth(DEPTH.highlight);

    this.nightOverlay = this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x14_22_4a, 0)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(DEPTH.night);
    if (this.onResizeHandler) {
      this.scale.off("resize", this.onResizeHandler);
    }
    this.onResizeHandler = (gs: Phaser.Structs.Size) => {
      this.nightOverlay.setSize(gs.width, gs.height);
      this.cameras.main.setZoom(zoomForWidth(gs.width));
    };
    this.scale.on("resize", this.onResizeHandler);
    this.events.once(Scenes.Events.SHUTDOWN, () => {
      if (this.onResizeHandler) {
        this.scale.off("resize", this.onResizeHandler);
      }
    });

    const cam = this.cameras.main;
    cam.setBounds(0, 0, MAP_W * TILE, MAP_H * TILE);
    cam.setZoom(zoomForWidth(this.scale.width));
    cam.startFollow(this.player, true, 0.12, 0.12);
    cam.setRoundPixels(true);

    this.fishing = new Fishing(this);
    this.animals = new AnimalManager(this, this.world);
    this.npcs = new NpcManager(this);
    this.animals.spawnAll();
    this.npcs.spawnAll();

    this.setupInput();
    // Prime the pad so an A still held from the title/mine doesn't read as a
    // fresh press (and swing a tool) on this scene's first frame.
    this.pad.update();

    if (!trailerStaging) {
      if (this.scene.isActive("Hud")) {
        this.scene.get("Hud").events.emit("hud-rebind");
      } else {
        this.scene.launch("Hud");
      }
    }

    this.game.events.off("hidden", this.saveHandler);
    this.game.events.on("hidden", this.saveHandler);
    window.removeEventListener("beforeunload", this.saveHandler);
    window.addEventListener("beforeunload", this.saveHandler);

    if (data?.fromMine) {
      cam.fadeIn(400, 0, 0, 0);
    } else {
      this.events.emit("daybanner", this.day, seasonOfDay(this.day), this.weather);
    }

    this.remoteFarmers = new RemoteFarmers(this);
    // Rebuild the edit ledger from the world we just built: clearing it alone
    // would make a host's next broadcast replace the room's whole tiles blob
    // with just its newest edit (the shared state merges per top-level key).
    this.appliedTiles.clear();
    this.tileEdits.clear();
    this.lastTilesRef = null;
    this.seedTileEditsFromWorld();
    // Guest actions relayed while we hosted from inside the mine.
    for (const intent of this.pendingTileIntents) {
      this.applyTileIntent(intent);
    }
    this.pendingTileIntents = [];

    if (import.meta.env.DEV) {
      window.__gs = this;
    }
  }

  // ---------------------------------------------------------------- init

  private startNew(): void {
    // Fixed seed so every client builds the identical co-op farm (no seed
    // exchange needed). Solo new games are deterministic too — acceptable for
    // a demo, and it keeps the shared world trivially consistent.
    this.seed = FARM_SEED;
    const gen = generateFarm(this.seed, getWorldMap());
    this.world = gen.world;
    store.initNew();
    this.day = 1;
    this.timeMin = DAY_START_MIN;
    this.canCharge = CAN_MAX;
    this.pendingSpawn = { x: gen.spawn.tx * TILE + 8, y: gen.spawn.ty * TILE + 12 };
  }

  private loadFrom(s: SaveData): void {
    this.seed = s.seed;
    this.world = World.fromJSON(s.world, getWorldMap());
    store.inv = Inventory.fromJSON(s.inv);
    store.skills = Skills.fromJSON(s.skills);
    store.gold = s.gold;
    store.energy = s.energy;
    store.hp = s.hp;
    this.day = s.day;
    this.timeMin = s.timeMin;
    this.canCharge = s.canCharge;
    this.pendingSpawn = { x: s.player.x, y: s.player.y };
    if (s.animals) {
      store.loadAnimals(s.animals, s.animalSeq ?? 1);
    }
    if (s.npcFriendship) {
      store.npcFriendship = s.npcFriendship;
    }
  }

  // Coming back from the mine: GameScene was stopped, so rebuild the WORLD and
  // clock from the save — but keep inv/skills/gold/hp/energy/animals live in the
  // store (they changed during the mine run and must not be reverted).
  private restoreFromStore(): void {
    const s = loadSave();
    if (!s) {
      this.startNew();
      return;
    }
    this.seed = s.seed;
    this.world = World.fromJSON(s.world, getWorldMap());
    this.day = s.day;
    this.timeMin = s.timeMin;
    this.canCharge = s.canCharge;
    this.pendingSpawn = { x: MINE_EXIT.tx * TILE + 8, y: MINE_EXIT.ty * TILE + 8 };
  }

  private setupInput(): void {
    const kb = this.input.keyboard;
    if (!kb) {
      return;
    }
    // scene instances + Key objects persist across restart — clear stale listeners
    this.input.removeAllListeners();
    kb.removeAllListeners();
    kb.on("keydown", () => Sound.resume());
    this.input.on("pointerdown", () => Sound.resume());
    this.keys = makeGameKeys(kb);
    for (const k of Object.values(this.keys)) {
      k.removeAllListeners();
    }
    this.keys.M.on("down", () => {
      this.toast(Sound.toggleMute() ? "Sound off" : "Sound on", "#dfe9ff");
      syncTouchControls();
    });
    Sound.startMusic("farm");

    for (const [i, name] of NUM_KEY_NAMES.entries()) {
      this.keys[name].on("down", () => !this.uiOpen && store.inv.select(i));
    }

    this.keys.SPACE.on("down", () => this.tryAction());
    this.keys.E.on("down", () => this.tryAction());
    // click / tap: act on the cell when it's within reach, else walk to it
    const actOrWalk = (p: Phaser.Input.Pointer): void => {
      const wp = this.cameras.main.getWorldPoint(p.x, p.y);
      const tx = Math.floor(wp.x / TILE);
      const ty = Math.floor(wp.y / TILE);
      if (!inBounds(tx, ty)) {
        return;
      }
      const f = this.feetTile();
      const dist = Math.max(Math.abs(tx - f.tx), Math.abs(ty - f.ty));
      if (dist <= 1) {
        this.clickPath = [];
        if (dist > 0) {
          this.faceTowards(tx, ty);
        }
        this.tryAction({ tx, ty });
      } else {
        this.startClickMove(tx, ty, wp.x, wp.y);
      }
    };
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      if (this.uiOpen || p.button !== 0) {
        return;
      }
      const hud = this.scene.get("Hud");
      if (hud.input.hitTestPointer(p).length > 0) {
        return;
        // hotbar click
      }
      if (this.fishing.active) {
        this.tryAction();
        return;
      }
      // touches feed the virtual stick on the way down — a tile tap is only
      // recognisable at pointerup (see below), so mouse-only here
      if (p.wasTouch) {
        return;
      }
      actOrWalk(p);
    });
    this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (!p.wasTouch || this.uiOpen || this.fishing.active) {
        return;
      }
      const hud = this.scene.get("Hud");
      if (hud.input.hitTestPointer(p).length > 0) {
        return;
        // hotbar tap
      }
      if (!isTap(p)) {
        return;
        // a drag was the stick, not a tap
      }
      actOrWalk(p);
    });
    this.keys.I.on("down", () => this.toggleInventory());
    kb.on("keydown-T", () => this.toggleCollisionOverlay());
    // scroll wheel cycles the hotbar selection (documented in the help modal)
    this.input.on(
      "wheel",
      (_p: Phaser.Input.Pointer, _o: Phaser.GameObjects.GameObject[], _dx: number, dy: number) => {
        if (!this.uiOpen) {
          store.inv.cycle(Math.sign(dy));
        }
      },
    );
  }

  // debug aid (T): tint blocked cells — red solid, blue water/void (fishable)
  private collisionOverlay: Phaser.GameObjects.Graphics | null = null;
  private toggleCollisionOverlay(): void {
    if (this.collisionOverlay) {
      this.collisionOverlay.destroy();
      this.collisionOverlay = null;
      return;
    }
    const g = this.add.graphics();
    g.setDepth(650_000);
    for (let ty = 0; ty < MAP_H; ty += 1) {
      for (let tx = 0; tx < MAP_W; tx += 1) {
        const k = this.world.cellKind(tx, ty);
        if (k === CELL.water || k === CELL.void) {
          g.fillStyle(0x35_b8_ff, 0.35);
        } else if (this.world.isSolidTile(tx, ty)) {
          g.fillStyle(0xff_3b_3b, 0.4);
        } else {
          continue;
        }
        g.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      }
    }
    this.collisionOverlay = g;
  }

  toggleInventory(): void {
    if (this.fishing.active) {
      return;
    }
    if (this.scene.isActive("Inventory")) {
      this.scene.stop("Inventory");
      this.uiOpen = false;
    } else if (!this.uiOpen) {
      this.uiOpen = true;
      this.scene.launch("Inventory");
    }
  }

  // ---------------------------------------------------------------- render build

  // Render the world map; placements that became live world
  // objects (trees/mushrooms) are skipped — their sprites come from objects.
  private buildGround(): void {
    const worldMap = getWorldMap();
    const skip = new Set<WorldMapSprite>(
      consumedSprites(worldMap, this.world).map((c) => c.sprite),
    );
    buildWorldMap(this, worldMap, skip);
  }

  private buildObjects(): void {
    for (const o of this.world.objects) {
      this.spawnObjectSprite(o);
    }
  }

  // Visuals for buildings/doors come from the world-map tiles — those objects are
  // interaction hotspots only and spawn no sprite.
  spawnObjectSprite(o: WorldObject): void {
    const cx = o.tx * TILE + TILE / 2;
    const by = (o.ty + 1) * TILE;
    let spr: Phaser.GameObjects.Sprite;
    switch (o.type) {
      case "tree": {
        const name = o.variant === "tree2" ? "spr_deco_tree_02" : "spr_deco_tree_01";
        spr = this.add
          .sprite(cx, by, "deco-atlas", `${name}/0`)
          .setOrigin(0.5, 1)
          .play(`deco-${name}`);
        spr.anims.setProgress(Math.random());
        break;
      }
      case "rock": {
        spr = this.add.sprite(cx, by + 1, "obj-rock").setOrigin(0.5, 1);
        break;
      }
      case "ore": {
        spr = this.add.sprite(cx, by + 1, `obj-ore-${o.variant ?? "coal"}`).setOrigin(0.5, 1);
        break;
      }
      case "forage": {
        const key = o.variant === "mushroom_blue" ? "obj-mushroom-blue" : "obj-mushroom-red";
        spr = this.add
          .sprite(cx, by - 1, key, 0)
          .setOrigin(0.5, 1)
          .play(o.variant === "mushroom_blue" ? "mushroom-blue-bob" : "mushroom-red-bob");
        break;
      }
      case "house":
      case "shop":
      case "bin":
      case "cave":
      case "barn":
      case "coop": {
        return;
      }
      // no default
    }
    spr.setDepth(DEPTH.entityBase + by);
    this.objSprites.set(o.id, spr);
  }

  private buildSoilAndCrops(): void {
    for (let i = 0; i < MAP_W * MAP_H; i += 1) {
      if (this.world.tilled[i]) {
        this.ensureSoil(i);
      }
    }
    for (const [i, cs] of this.world.crops) {
      this.ensureCrop(i, cs.crop, cropStage(CROPS[cs.crop], cs.daysGrown));
    }
  }

  private ensureSoil(i: number): void {
    if (this.soilImgs.has(i)) {
      return;
    }
    const tx = i % MAP_W;
    const ty = Math.trunc(i / MAP_W);
    const img = this.add
      .image(tx * TILE, ty * TILE + 4, "obj-soil")
      .setOrigin(0, 0)
      .setDepth(DEPTH.soil);
    this.soilImgs.set(i, img);
    this.refreshSoilTint(i);
  }

  private refreshSoilTint(i: number): void {
    this.soilImgs.get(i)?.setTint(this.world.watered[i] ? 0x6b_4f_33 : 0xff_ff_ff);
  }

  private ensureCrop(i: number, crop: CropId, stage: number): void {
    const tx = i % MAP_W;
    const ty = Math.trunc(i / MAP_W);
    let img = this.cropImgs.get(i);
    if (img) {
      img.setTexture(`crop-${crop}`, stage);
    } else {
      img = this.add
        .image(tx * TILE + 8, ty * TILE + 15, `crop-${crop}`, stage)
        .setOrigin(0.5, 1)
        .setDepth(DEPTH.crop);
      this.cropImgs.set(i, img);
    }
  }

  /** Trailer staging: set a tile's full farm state (soil/water/crop) with
   *  correct art in one call. Uses the same render helpers as gameplay. */
  stageTile(
    tx: number,
    ty: number,
    s: { tilled: boolean; watered: boolean; crop: CropId | null; daysGrown: number },
  ): void {
    if (!inBounds(tx, ty)) {
      return;
    }
    const idx = tileIdx(tx, ty);
    this.world.crops.delete(idx);
    this.cropImgs.get(idx)?.destroy();
    this.cropImgs.delete(idx);
    this.world.tilled[idx] = s.tilled ? 1 : 0;
    this.world.watered[idx] = s.tilled && s.watered ? 1 : 0;
    if (s.tilled) {
      this.ensureSoil(idx);
    } else {
      this.soilImgs.get(idx)?.destroy();
      this.soilImgs.delete(idx);
    }
    this.refreshSoilTint(idx);
    if (s.tilled && s.crop) {
      this.world.crops.set(idx, { crop: s.crop, daysGrown: s.daysGrown });
      this.ensureCrop(idx, s.crop, cropStage(CROPS[s.crop], s.daysGrown));
    }
  }

  // ---------------------------------------------------------------- update

  override update(_t: number, dms: number): void {
    const dt = Math.min(dms, 50) / 1000;
    this.gamepad?.update();
    // Physical pad: A mirrors E/SPACE (tryAction guards busy states itself),
    // Y mirrors I, LB/RB mirror the scroll wheel's hotbar cycle.
    this.pad.update();
    if (this.pad.justPressed("a")) {
      this.tryAction();
    }
    if (this.pad.justPressed("y")) {
      this.toggleInventory();
    }
    if (!this.uiOpen) {
      if (this.pad.justPressed("lb")) {
        store.inv.cycle(-1);
      }
      if (this.pad.justPressed("rb")) {
        store.inv.cycle(1);
      }
    }
    this.net?.tick();
    this.reconcileClock();
    this.reconcileTiles();
    const busy = this.uiOpen || this.transitioning || this.fishing.active;
    if (!busy) {
      // The host drives the shared clock; guests adopt it (reconcileClock).
      // While still handshaking (not live yet) run it locally — a frozen
      // clock during the connect window reads as a hang.
      if (this.amHost || !this.net?.live) {
        this.advanceTime(dt);
      }
      this.handleMovement(dt);
    } else if (!this.acting && !this.fishing.active) {
      this.setAnim("idle");
    }
    this.fishing.update(dt);
    this.animals.update(dt);
    this.npcs.update(dt);
    this.updateHighlight();
    this.updateNightTint();
    this.player.setDepth(DEPTH.entityBase + this.player.y);
    // shadow rides the feet, always one depth step under its owner
    this.shadow.setPosition(this.player.x, this.player.y + 1);
    this.shadow.setDepth(this.player.depth - 1);
    this.updateNet(dt);
    this.trailerFrame?.(dt);
    // flush debounced saves (transitions and tab-hide/unload still save at once)
    this.saveAcc += dt;
    if (this.saveDirty && this.saveAcc >= SAVE_FLUSH_SEC) {
      this.save();
    }
  }

  // ---- multiplayer: sync ----------------------------------------------------

  /**
   * True only when actually connected to a live co-op room (not the solo
   * fallback) — used by the wrapper's pause handler so it never freezes a
   * session other players are relying on.
   */
  isOnline(): boolean {
    return this.net !== undefined && this.net.live && !this.net.offline;
  }

  private handleNetEvent(event: string, payload: JsonValue, _from: string): void {
    // Host applies a guest's farming action to the authoritative world.
    if (event !== "tile" || !this.amHost) {
      return;
    }
    const intent = parseTileIntent(payload);
    if (!intent) {
      return;
    }
    // While the host is in the mine this scene is stopped: its world is a
    // stale copy (rebuilt from the save on return) and rendering would touch
    // dead objects — hold the intent and apply it in create().
    if (!this.scene.isActive()) {
      this.pendingTileIntents.push(intent);
      return;
    }
    this.applyTileIntent(intent);
  }

  private applyTileIntent(intent: TileIntent): void {
    const { idx } = intent;
    switch (intent.action) {
      case "till": {
        this.world.tilled[idx] = 1;
        break;
      }
      case "water": {
        this.world.watered[idx] = 1;
        break;
      }
      case "plant": {
        if (intent.crop) {
          this.world.crops.set(idx, { crop: intent.crop, daysGrown: 0 });
        }
        break;
      }
      case "harvest": {
        this.world.crops.delete(idx);
        this.world.watered[idx] = 0;
        break;
      }
      // no default
    }
    this.recordTileEdit(idx);
    const e = this.tileEdits.get(idx);
    if (e) {
      this.applyTileState(idx, e);
      // render the guest's action on the host too
    }
    this.broadcastTiles();
  }

  /** Capture every farmed tile as an edit, so a host's first broadcast carries
   *  the WHOLE farm (a save-loaded farm included) — not just edits made since
   *  this scene instance started. */
  private seedTileEditsFromWorld(): void {
    if (!this.net) {
      return;
    }
    for (let idx = 0; idx < MAP_W * MAP_H; idx += 1) {
      if ((this.world.tilled[idx] ?? 0) !== 0 || (this.world.watered[idx] ?? 0) !== 0) {
        this.recordTileEdit(idx);
      }
    }
    for (const idx of this.world.crops.keys()) {
      if (!this.tileEdits.has(idx)) {
        this.recordTileEdit(idx);
      }
    }
  }

  /** Called by the farming actions after a local mutation, to propagate it. */
  private netTileAction(idx: number, action: string, crop?: CropId): void {
    const { net } = this;
    if (!net || net.offline) {
      return;
      // solo: nothing to sync
    }
    if (this.amHost) {
      this.recordTileEdit(idx);
      this.broadcastTiles();
    } else {
      net.sendEvent("tile", crop ? { action, crop, idx } : { action, idx });
    }
  }

  private recordTileEdit(idx: number): void {
    const cs = this.world.crops.get(idx);
    const e: TileEdit = {
      c: cs ? cs.crop : null,
      d: cs ? cs.daysGrown : 0,
      t: this.world.tilled[idx] ?? 0,
      w: this.world.watered[idx] ?? 0,
    };
    this.tileEdits.set(idx, e);
    this.appliedTiles.set(idx, tileSig(e));
  }

  private broadcastTiles(): void {
    const { net } = this;
    if (!net || net.offline) {
      return;
    }
    const tiles: Record<string, [number, number, string | null, number]> = {};
    for (const [idx, e] of this.tileEdits) {
      tiles[idx] = [e.t, e.w, e.c, e.d];
    }
    net.patchShared({ tiles });
  }

  /** Adopt the host's authoritative tile edits (a rival's farming, overnight
   *  growth, etc.), re-rendering only the tiles whose state actually changed. */
  private reconcileTiles(): void {
    if (this.amHost) {
      return;
      // host owns the truth
    }
    const s = this.net?.sharedState;
    const raw = s?.["tiles"];
    if (!isJsonObject(raw)) {
      return;
    }
    // The blob's identity only changes when a tiles patch arrives — skip the
    // full 60 Hz rescan (hundreds of tiles) in between.
    if (raw === this.lastTilesRef) {
      return;
    }
    this.lastTilesRef = raw;
    for (const [key, packed] of Object.entries(raw)) {
      if (!Array.isArray(packed)) {
        continue;
      }
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= MAP_W * MAP_H) {
        continue;
      }
      const [tilled, watered, cropRaw, days] = packed;
      const e: TileEdit = {
        // Validate at the boundary: an unknown crop id from the wire must not
        // enter the world (it would crash rendering AND poison the save).
        c: isCropId(cropRaw) ? cropRaw : null,
        d: Number(days) || 0,
        t: Number(tilled) || 0,
        w: Number(watered) || 0,
      };
      const sig = tileSig(e);
      if (this.appliedTiles.get(idx) === sig) {
        continue;
      }
      this.appliedTiles.set(idx, sig);
      // Mirror adoptions into the edit ledger: if the host leaves and WE get
      // promoted, our first broadcast must carry the accumulated farm, not
      // wipe the room's blob down to our own edits.
      this.tileEdits.set(idx, e);
      this.applyTileState(idx, e);
    }
  }

  /** Set a tile's world state and re-render it (no fx / inventory / sound). */
  private applyTileState(idx: number, e: TileEdit): void {
    this.world.tilled[idx] = e.t;
    this.world.watered[idx] = e.w;
    if (e.c !== null) {
      this.world.crops.set(idx, { crop: e.c, daysGrown: e.d });
      this.ensureCrop(idx, e.c, cropStage(CROPS[e.c], e.d));
    } else if (this.world.crops.has(idx)) {
      this.world.crops.delete(idx);
      this.cropImgs.get(idx)?.destroy();
      this.cropImgs.delete(idx);
    }
    if (e.t) {
      this.ensureSoil(idx);
    } else {
      this.soilImgs.get(idx)?.destroy();
      this.soilImgs.delete(idx);
    }
    this.refreshSoilTint(idx);
  }

  /** Host: after overnight growth/withering/re-watering, re-capture every
   *  tracked (and crop) tile so guests see the new day's farm. */
  private refreshTileEditsAfterOvernight(): void {
    if (!this.net || this.net.offline || !this.amHost) {
      return;
    }
    for (const idx of this.tileEdits.keys()) {
      this.recordTileEdit(idx);
    }
    for (const idx of this.world.crops.keys()) {
      if (!this.tileEdits.has(idx)) {
        this.recordTileEdit(idx);
      }
    }
    this.broadcastTiles();
  }

  private reconcileClock(): void {
    if (this.amHost) {
      return;
    }
    const s = this.net?.sharedState;
    const c = s?.["clock"];
    if (!isJsonObject(c)) {
      return;
    }
    const { time } = c;
    const { weather } = c;
    const { day } = c;
    if (isJsonNumber(time)) {
      this.timeMin = time;
    }
    if (weather === "sunny" || weather === "rain" || weather === "storm" || weather === "snow") {
      this.weather = weather;
    }
    if (isJsonNumber(day) && day !== this.day) {
      this.day = day;
      this.events.emit("daybanner", this.day, seasonOfDay(this.day), this.weather);
    }
  }

  private updateNet(dt: number): void {
    const { net } = this;
    if (!net) {
      return;
    }
    if (!net.offline) {
      this.netAcc += dt;
      if (this.netAcc >= 1 / NET_TICK_HZ) {
        this.netAcc = 0;
        net.updateMyState({
          f: this.player.flipX,
          m: this.moving,
          x: this.player.x,
          y: this.player.y,
        });
      }
      if (this.amHost) {
        // First tick as a live host: push the whole farm (a save-loaded world
        // included) so guests inherit the real state, not a bare map.
        if (!this.worldPublished && net.live) {
          this.worldPublished = true;
          this.broadcastTiles();
        }
        this.clockAcc += dt;
        if (this.clockAcc >= 1 / CLOCK_TICK_HZ) {
          this.clockAcc = 0;
          net.patchShared({
            clock: { day: this.day, time: this.timeMin, weather: this.weather },
          });
        }
      }
    }
    this.remoteFarmers?.sync(net.players, net.playerId);
    this.remoteFarmers?.update(dt);
  }

  private advanceTime(dt: number): void {
    this.timeMin += dt * GAME_MIN_PER_REAL_SEC;
    if (this.timeMin >= DAY_END_MIN) {
      this.passOut();
    }
  }

  /** Keyboard first; then the sticks (virtual touch, then physical pad) and
   *  finally trailer choreography fill in while real input is silent. */
  private moveIntent(): StickMove {
    const k = this.keys;
    let dx = 0;
    let dy = 0;
    if (k.A.isDown || k.LEFT.isDown) {
      dx -= 1;
    }
    if (k.D.isDown || k.RIGHT.isDown) {
      dx += 1;
    }
    if (k.W.isDown || k.UP.isDown) {
      dy -= 1;
    }
    if (k.S.isDown || k.DOWN.isDown) {
      dy += 1;
    }
    if (dx !== 0 || dy !== 0) {
      return { dx, dy, run: false };
    }
    const move =
      (this.gamepad ? stickMove(this.gamepad.getStick()) : null) ?? stickMove(this.pad.getStick());
    if (move) {
      return move;
    }
    if (this.trailerMove) {
      return { dx: this.trailerMove.x, dy: this.trailerMove.y, run: this.trailerMove.run };
    }
    return { dx: 0, dy: 0, run: false };
  }

  /** Steer along the click-to-move path; returns the leg's unit direction, or
   *  null once the next waypoint is reached (or there is no path). */
  private pathStep(): { dx: number; dy: number } | null {
    const [wpt] = this.clickPath;
    if (!wpt) {
      return null;
    }
    const vx = wpt.x - this.player.x;
    const vy = wpt.y - this.player.y;
    const d = Math.hypot(vx, vy);
    if (d < 2.5) {
      this.clickPath.shift();
      return null;
    }
    return { dx: vx / d, dy: vy / d };
  }

  /** A click path that makes no progress (snagged on a corner) gets dropped. */
  private trackPathProgress(moved: number, expected: number, dt: number): void {
    if (this.clickPath.length === 0) {
      return;
    }
    this.pathStuck = moved < expected * 0.25 ? this.pathStuck + dt : 0;
    if (this.pathStuck > 0.4) {
      this.clickPath = [];
      this.pathStuck = 0;
    }
  }

  private handleMovement(dt: number): void {
    if (this.acting) {
      this.moving = false;
      return;
    }
    const k = this.keys;
    const intent = this.moveIntent();
    let { dx, dy } = intent;
    const { run: stickRun } = intent;

    // keyboard/stick input cancels click-to-move; otherwise steer along the path
    if (dx !== 0 || dy !== 0) {
      this.clickPath = [];
    } else if (this.clickPath.length > 0) {
      const step = this.pathStep();
      if (step) {
        ({ dx, dy } = step);
      }
    }

    this.moving = dx !== 0 || dy !== 0;
    if (this.moving) {
      this.facing =
        Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) };
      const run = (k.SHIFT.isDown || stickRun) && store.energy > 0;
      const speed = run ? RUN_SPEED : WALK_SPEED;
      const len = Math.hypot(dx, dy) || 1;
      const beforeX = this.player.x;
      const beforeY = this.player.y;
      this.moveResolved((dx / len) * speed * dt, (dy / len) * speed * dt);
      this.trackPathProgress(
        Math.hypot(this.player.x - beforeX, this.player.y - beforeY),
        speed * dt,
        dt,
      );
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        Sound.footstep();
        this.stepTimer = run ? 0.22 : 0.32;
      }
      this.setAnim(run ? "run" : "walk");
      if (dx < 0) {
        this.player.setFlipX(true);
      } else if (dx > 0) {
        this.player.setFlipX(false);
      }
      this.tryForagePickup();
    } else {
      this.setAnim("idle");
    }
  }

  // ---------------------------------------------------------- click-to-move

  /**
   * BFS over walkable cells (8-dir, no corner cutting) from the player's feet
   * to (tx,ty), as pixel waypoints. If the target cell is blocked (water,
   * props, buildings) the route leads to the nearest reachable cell beside it;
   * empty when the player is already there or nothing connects.
   * Drives click-to-move, and the trailer director's scripted approaches — the
   * yards are split by fences, so a straight-line steer walks into a wall.
   */
  pathTo(tx: number, ty: number): { x: number; y: number }[] {
    const f = this.feetTile();
    const start = f.ty * MAP_W + f.tx;
    const { dist, parent } = this.floodFrom(start);
    const goal = reachableGoal(dist, tx, ty);
    if (goal < 0 || goal === start) {
      return [];
    }
    const path: { x: number; y: number }[] = [];
    for (let c = goal; c !== -1 && c !== start; c = parent[c] ?? -1) {
      path.push({
        x: (c % MAP_W) * TILE + TILE / 2,
        y: Math.trunc(c / MAP_W) * TILE + TILE / 2 + 1,
      });
    }
    path.reverse();
    return path;
  }

  /** Breadth-first flood over walkable cells, 8-dir without corner cutting. */
  private floodFrom(start: number): Flood {
    const dist = new Int32Array(MAP_W * MAP_H).fill(-1);
    const parent = new Int32Array(MAP_W * MAP_H).fill(-1);
    const queue: number[] = [start];
    dist[start] = 0;
    const walkable = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && !this.world.isSolidTile(x, y);
    for (const cur of queue) {
      const cx = cur % MAP_W;
      const cy = Math.trunc(cur / MAP_W);
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) {
            continue;
          }
          const nx = cx + ox;
          const ny = cy + oy;
          if (!walkable(nx, ny)) {
            continue;
          }
          if (ox !== 0 && oy !== 0 && (!walkable(cx + ox, cy) || !walkable(cx, cy + oy))) {
            continue;
          }
          const ni = ny * MAP_W + nx;
          if (dist[ni] !== -1) {
            continue;
          }
          dist[ni] = (dist[cur] ?? 0) + 1;
          parent[ni] = cur;
          queue.push(ni);
        }
      }
    }
    return { dist, parent };
  }

  private startClickMove(tx: number, ty: number, wx: number, wy: number): void {
    if (this.acting) {
      return;
    }
    const path = this.pathTo(tx, ty);
    if (path.length === 0) {
      return;
    }
    this.clickPath = path;
    this.pathStuck = 0;
    this.showClickMarker(wx, wy);
  }

  private showClickMarker(wx: number, wy: number): void {
    const g = this.add.graphics({ x: wx, y: wy });
    g.setDepth(600_000);
    g.lineStyle(1.2, 0xff_ff_ff, 0.9);
    g.strokeCircle(0, 0, 5);
    this.tweens.add({
      alpha: 0,
      duration: 300,
      onComplete: () => g.destroy(),
      scaleX: 0.3,
      scaleY: 0.3,
      targets: g,
    });
  }

  private moveResolved(mx: number, my: number): void {
    const hh = 3;
    const hw = 4;
    const solid = (x: number, y: number) =>
      this.world.isSolidTile(Math.floor(x / TILE), Math.floor(y / TILE));
    const collides = (px: number, py: number) =>
      solid(px - hw, py - hh) ||
      solid(px + hw, py - hh) ||
      solid(px - hw, py + hh) ||
      solid(px + hw, py + hh);
    const nx = this.player.x + mx;
    if (!collides(nx, this.player.y)) {
      this.player.x = nx;
    }
    const ny = this.player.y + my;
    if (!collides(this.player.x, ny)) {
      this.player.y = ny;
    }
    this.player.x = PhaserMath.Clamp(this.player.x, hw, MAP_W * TILE - hw);
    this.player.y = PhaserMath.Clamp(this.player.y, hh + 4, MAP_H * TILE - hh);
  }

  private setAnim(name: "idle" | "walk" | "run" | null): void {
    if (name === null) {
      return;
    }
    const key = `p-${name}`;
    if (this.player.anims.currentAnim?.key !== key || !this.player.anims.isPlaying) {
      this.player.play(key, true);
    }
  }

  feetTile() {
    return { tx: Math.floor(this.player.x / TILE), ty: Math.floor((this.player.y - 1) / TILE) };
  }
  targetTile() {
    const f = this.feetTile();
    return { tx: f.tx + this.facing.x, ty: f.ty + this.facing.y };
  }

  private updateHighlight(): void {
    this.highlight.clear();
    if (trailerStaging) {
      return;
      // trailer shots: no target-tile chrome
    }
    if (this.uiOpen || this.transitioning || this.fishing.active) {
      return;
    }
    const { tx, ty } = this.targetTile();
    if (!inBounds(tx, ty)) {
      return;
    }
    const x = tx * TILE;
    const y = ty * TILE;
    this.highlight.lineStyle(1, 0xff_ff_ff, 0.55);
    this.highlight.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
    this.highlight.fillStyle(0xff_ff_ff, 0.08);
    this.highlight.fillRect(x, y, TILE, TILE);
  }

  // walk-over pickup of forage at the player's feet
  private tryForagePickup(): void {
    const f = this.feetTile();
    const o = this.world.objectAt(f.tx, f.ty);
    if (o && o.type === "forage") {
      this.pickForage(o);
    }
  }

  // ---------------------------------------------------------------- actions

  /** Public: the trailer director drives staged actions through this exact path. */
  tryAction(target?: { tx: number; ty: number }): void {
    if (this.uiOpen || this.acting || this.transitioning) {
      return;
    }
    if (this.fishing.active) {
      this.fishing.onActionPress();
      return;
    }
    const { tx, ty } = target ?? this.targetTile();
    const obj = inBounds(tx, ty) ? this.world.objectAt(tx, ty) : null;
    const item = store.inv.selectedItem();

    if (obj) {
      this.actOnObject(obj, tx, ty, item);
      return;
    }

    // harvest a ripe crop in front takes priority over petting/gifting nearby
    const idx = inBounds(tx, ty) ? tileIdx(tx, ty) : -1;
    const cs = idx >= 0 ? this.world.crops.get(idx) : undefined;
    if (cs && isMature(CROPS[cs.crop], cs.daysGrown)) {
      this.beginAction("doing", () => this.harvest(idx));
      return;
    }

    // animal or NPC in front?
    if (this.animals.tryPet(tx, ty)) {
      return;
    }
    if (this.npcs.tryTalk(tx, ty, item)) {
      return;
    }
    if (!item) {
      return;
    }
    if (item.kind === "tool") {
      this.useTool(item.tool, tx, ty, idx);
    } else if (item.kind === "seed") {
      this.plantSeed(item.crop, idx);
    }
  }

  private actOnObject(obj: WorldObject, tx: number, ty: number, item: Item | null): void {
    switch (obj.type) {
      case "shop": {
        this.faceTowards(tx, ty);
        this.openShop();
        break;
      }
      case "house": {
        this.faceTowards(tx, ty);
        this.confirmSleep();
        break;
      }
      case "bin": {
        this.faceTowards(tx, ty);
        this.shipProduce();
        break;
      }
      case "cave": {
        this.faceTowards(tx, ty);
        this.enterMine();
        break;
      }
      case "barn":
      case "coop": {
        this.faceTowards(tx, ty);
        this.events.emit("open-animal-shop", obj.type);
        this.uiOpen = true;
        break;
      }
      case "forage": {
        this.pickForage(obj);
        break;
      }
      case "tree": {
        if (item?.kind === "tool" && item.tool === "axe") {
          this.beginAction("axe", () => this.chop(obj));
        } else {
          this.toast("You need an axe.", "#ffd27a");
        }
        break;
      }
      case "rock": {
        if (item?.kind === "tool" && item.tool === "pickaxe") {
          this.beginAction("mine", () => this.mineRock(obj));
        } else {
          this.toast("You need a pickaxe.", "#ffd27a");
        }
        break;
      }
      // ore lives in the mine
      case "ore": {
        break;
      }
      // no default
    }
  }

  private useTool(tool: ToolId, tx: number, ty: number, idx: number): void {
    if (tool === "hoe") {
      if (this.world.canTill(tx, ty)) {
        this.beginAction("dig", () => this.till(idx));
      } else {
        this.toast("Can't till there.", "#ffd27a");
      }
    } else if (tool === "can") {
      this.useCan(tx, ty, idx);
    } else if (tool === "rod") {
      if (inBounds(tx, ty) && this.world.getGround(tx, ty) === GROUND.water) {
        this.fishing.startCast(tx, ty);
      } else {
        this.toast("Face the water to fish.", "#9fd8ff");
      }
    } else if (tool === "sword") {
      this.beginAction("doing", () => {
        /* swung at nothing on the farm */
      });
    }
  }

  private useCan(tx: number, ty: number, idx: number): void {
    if (inBounds(tx, ty) && this.world.getGround(tx, ty) === GROUND.water) {
      this.beginAction("water", () => this.refillCan());
    } else if (idx >= 0 && this.world.tilled[idx]) {
      if (this.canCharge <= 0) {
        this.toast("Out of water — refill at the pond.", "#9fd8ff");
      } else {
        this.beginAction("water", () => this.waterTile(idx));
      }
    } else {
      this.toast("Till the soil first.", "#ffd27a");
    }
  }

  private plantSeed(crop: CropId, idx: number): void {
    if (idx >= 0 && this.world.tilled[idx] && !this.world.crops.has(idx)) {
      if (!CROPS[crop].seasons.includes(seasonOfDay(this.day))) {
        this.toast(`${CROPS[crop].name} won't grow in ${seasonOfDay(this.day)}.`, "#ffd27a");
        return;
      }
      this.beginAction("doing", () => this.plant(idx, crop));
    } else {
      this.toast(this.world.tilled[idx] ? "Already planted." : "Till the soil first.", "#ffd27a");
    }
  }

  faceTowards(tx: number, ty: number): void {
    const f = this.feetTile();
    if (tx < f.tx) {
      this.player.setFlipX(true);
    } else if (tx > f.tx) {
      this.player.setFlipX(false);
    }
    this.facing = { x: Math.sign(tx - f.tx), y: tx === f.tx ? Math.sign(ty - f.ty) : 0 };
  }

  beginAction(action: CharAction, onImpact: () => void): void {
    if (store.energy <= 0 && action !== "doing") {
      this.toast("Too tired… time to sleep.", "#c8b6ff");
      return;
    }
    this.clickPath = [];
    this.acting = true;
    const [rate, , impactFrame] = ACTION_TIMING[action];
    this.player.play(`p-${action}`, true);
    if (action !== "doing") {
      store.spendEnergy(ENERGY_PER_SWING);
    }
    this.time.delayedCall((impactFrame / rate) * 1000, () => {
      if (this.acting) {
        onImpact();
      }
    });
    this.player.once(Animations.Events.ANIMATION_COMPLETE, () => {
      this.acting = false;
      this.player.play("p-idle", true);
    });
  }

  awardXP(skill: SkillId, amount: number): void {
    const newLevel = store.skills.addXP(skill, amount);
    if (newLevel !== null) {
      this.events.emit("levelup", skill, newLevel);
      Sound.wake();
      floatText(
        this,
        this.player.x,
        this.player.y - 24,
        `${SKILL_NAMES[skill]} Lv.${newLevel}!`,
        "#ffe27a",
      );
    }
  }

  // ---- effects ----

  private till(idx: number): void {
    if (idx < 0) {
      return;
    }
    this.world.tilled[idx] = 1;
    this.ensureSoil(idx);
    const tx = idx % MAP_W;
    const ty = Math.trunc(idx / MAP_W);
    burst(this, tx * TILE + 8, ty * TILE + 12, {
      colors: [0x8a_6a_43, 0x6b_4f_33, 0xa0_7b_4c],
      count: 9,
      speed: 45,
      up: true,
    });
    shake(this, 0.0025, 90);
    Sound.dig();
    this.awardXP("farming", 2);
    this.requestSave();
    this.netTileAction(idx, "till");
  }

  private waterTile(idx: number): void {
    this.world.watered[idx] = 1;
    this.canCharge = Math.max(0, this.canCharge - 1);
    this.refreshSoilTint(idx);
    const tx = idx % MAP_W;
    const ty = Math.trunc(idx / MAP_W);
    burst(this, tx * TILE + 8, ty * TILE + 8, {
      colors: [0x6f_c6_ff, 0x9f_e0_ff, 0xff_ff_ff],
      count: 8,
      gravity: 200,
      speed: 40,
      up: true,
    });
    Sound.water();
    this.awardXP("farming", 1);
    this.netTileAction(idx, "water");
  }

  private refillCan(): void {
    this.canCharge = CAN_MAX;
    burst(this, this.player.x, this.player.y - 8, {
      colors: [0x6f_c6_ff, 0x9f_e0_ff],
      count: 12,
      speed: 35,
    });
    Sound.water();
    this.toast("Watering can refilled!", "#9fd8ff");
  }

  private plant(idx: number, crop: CropId): void {
    if (!store.inv.consumeSlot(store.inv.selected, 1)) {
      return;
    }
    this.world.crops.set(idx, { crop, daysGrown: 0 });
    this.ensureCrop(idx, crop, 0);
    const img = this.cropImgs.get(idx);
    if (img) {
      pop(this, img);
    }
    const tx = idx % MAP_W;
    const ty = Math.trunc(idx / MAP_W);
    burst(this, tx * TILE + 8, ty * TILE + 12, {
      colors: [0x7e_c8_50, 0x4a_9d_3f],
      count: 5,
      speed: 30,
      up: true,
    });
    Sound.plant();
    this.awardXP("farming", 2);
    this.requestSave();
    this.netTileAction(idx, "plant", crop);
  }

  private harvest(idx: number): void {
    const cs = this.world.crops.get(idx);
    if (!cs) {
      return;
    }
    const def = CROPS[cs.crop];
    const [lo, hi] = def.yield;
    let n = lo + Math.trunc(Math.random() * (hi - lo + 1));
    if (Math.random() < store.skills.yieldBonusChance()) {
      n += 1;
    }
    store.inv.add({ crop: cs.crop, kind: "produce" }, n);
    this.world.crops.delete(idx);
    const img = this.cropImgs.get(idx);
    if (img) {
      pop(this, img);
      this.time.delayedCall(80, () => img.destroy());
    }
    this.cropImgs.delete(idx);
    this.world.watered[idx] = 0;
    this.refreshSoilTint(idx);
    const tx = idx % MAP_W;
    const ty = Math.trunc(idx / MAP_W);
    burst(this, tx * TILE + 8, ty * TILE + 8, {
      colors: [0x7e_c8_50, 0xff_e2_7a, 0xff_9e_d2],
      count: 12,
      speed: 55,
      up: true,
    });
    floatText(this, tx * TILE + 8, ty * TILE + 4, `+${n} ${def.name}`, "#d8ffb0");
    Sound.harvest();
    this.awardXP("farming", 12);
    this.requestSave();
    this.netTileAction(idx, "harvest");
  }

  private chop(o: WorldObject): void {
    o.hp -= 1;
    const spr = this.objSprites.get(o.id);
    if (spr) {
      this.tweens.add({ duration: 50, repeat: 2, targets: spr, x: spr.x + 1.5, yoyo: true });
      burst(this, spr.x, spr.y - 16, {
        colors: [0x4a_9d_3f, 0x7e_c8_50, 0x2f_6b_3a],
        count: 7,
        speed: 50,
      });
    }
    shake(this, 0.004, 110);
    Sound.chop();
    this.awardXP("foraging", 2);
    if (o.hp <= 0) {
      Sound.thud();
      const got = 2 + Math.trunc(Math.random() * 2);
      store.inv.add({ kind: "resource", res: "wood" }, got);
      if (spr) {
        this.tweens.add({
          alpha: 0,
          duration: 220,
          onComplete: () => spr.destroy(),
          scaleX: 0.7,
          scaleY: 0.6,
          targets: spr,
          y: spr.y + 3,
        });
      }
      this.objSprites.delete(o.id);
      this.world.removeObject(o);
      floatText(this, o.tx * TILE + 8, o.ty * TILE - 8, `+${got} Wood`, "#e8c79a");
      this.awardXP("foraging", 6);
    }
    this.requestSave();
  }

  private mineRock(o: WorldObject): void {
    o.hp -= 1;
    const spr = this.objSprites.get(o.id);
    if (spr) {
      this.tweens.add({ duration: 60, scaleX: 1.12, scaleY: 0.9, targets: spr, yoyo: true });
      burst(this, spr.x, spr.y - 8, {
        colors: [0xbf_ca_d6, 0x8a_98_a8, 0xff_ff_ff],
        count: 8,
        speed: 55,
      });
    }
    shake(this, 0.005, 110);
    Sound.mine();
    this.awardXP("mining", 3);
    if (o.hp <= 0) {
      Sound.thud();
      const got = 1 + Math.trunc(Math.random() * 2);
      store.inv.add({ kind: "resource", res: "stone" }, got);
      if (Math.random() < 0.25) {
        store.inv.add({ kind: "resource", res: "coal" }, 1);
      }
      if (spr) {
        this.tweens.add({
          alpha: 0,
          duration: 200,
          onComplete: () => spr.destroy(),
          scaleX: 0.5,
          scaleY: 0.5,
          targets: spr,
        });
      }
      this.objSprites.delete(o.id);
      this.world.removeObject(o);
      floatText(this, o.tx * TILE + 8, o.ty * TILE - 8, `+${got} Stone`, "#cdd6e0");
      this.awardXP("mining", 5);
    }
    this.requestSave();
  }

  private pickForage(o: WorldObject): void {
    const kind: ForageId = o.variant === "mushroom_blue" ? "mushroom_blue" : "mushroom_red";
    let n = 1;
    if (Math.random() < store.skills.forageBonusChance()) {
      n += 1;
    }
    store.inv.add({ forage: kind, kind: "forage" }, n);
    const spr = this.objSprites.get(o.id);
    if (spr) {
      burst(this, spr.x, spr.y - 4, {
        colors: [0xff_8a_8a, 0x9f_d8_ff, 0xff_ff_ff],
        count: 8,
        speed: 45,
        up: true,
      });
      this.tweens.add({
        alpha: 0,
        duration: 200,
        onComplete: () => spr.destroy(),
        targets: spr,
        y: spr.y - 6,
      });
    }
    this.objSprites.delete(o.id);
    this.world.removeObject(o);
    floatText(
      this,
      o.tx * TILE + 8,
      o.ty * TILE - 4,
      `+${n} ${kind === "mushroom_blue" ? "Blue" : "Red"} Mushroom`,
      "#ffd0e0",
    );
    Sound.plant();
    this.awardXP("foraging", 8);
    this.requestSave();
  }

  // ---------------------------------------------------------------- economy / ui

  private openShop(): void {
    this.uiOpen = true;
    this.events.emit("open-shop");
  }

  buySeed(crop: CropId, qty: number): boolean {
    return this.buyItem({ crop, kind: "seed" }, qty, CROPS[crop].seedPrice);
  }

  // Deduct gold first, then refund any units that didn't fit — so a partial add
  // can never leave the player with free items.
  buyItem(item: Item, qty: number, unitCost: number): boolean {
    const cost = unitCost * qty;
    if (store.gold < cost) {
      this.toast("Not enough gold.", "#ffb0b0");
      return false;
    }
    store.gold -= cost;
    const left = store.inv.add(item, qty);
    if (left === qty) {
      store.gold += cost;
      this.toast("Inventory full.", "#ffb0b0");
      return false;
    }
    if (left > 0) {
      store.gold += unitCost * left;
      this.toast("Only some fit — inventory full.", "#ffd27a");
    }
    Sound.coins();
    this.requestSave();
    return true;
  }

  sellAll(): number {
    let total = 0;
    const sellFrom = (arr: typeof store.inv.slots) => {
      for (let i = 0; i < arr.length; i += 1) {
        const s = arr[i];
        if (s && isSellable(s.item)) {
          total += sellValue(s.item) * s.qty;
          arr[i] = null;
        }
      }
    };
    sellFrom(store.inv.slots);
    sellFrom(store.inv.pack);
    if (total > 0) {
      store.gold += total;
      Sound.coins();
      this.requestSave();
    }
    return total;
  }

  private shipProduce(): void {
    const total = this.sellAll();
    if (total > 0) {
      const bin = this.world.objects.find((o) => o.type === "bin");
      if (bin) {
        burst(this, bin.tx * TILE + 8, bin.ty * TILE + 4, {
          colors: [0xff_d3_4d, 0xff_e2_7a, 0xff_ff_ff],
          count: 14,
          speed: 55,
          up: true,
        });
        floatText(this, bin.tx * TILE + 8, bin.ty * TILE - 6, `+${total}g`, "#ffe27a");
      }
      this.toast(`Shipped goods for ${total}g!`, "#ffe27a");
    } else {
      this.toast("Nothing to ship. Gather produce first.", "#ffd27a");
    }
  }

  closeUi(): void {
    this.uiOpen = false;
  }

  private confirmSleep(): void {
    this.uiOpen = true;
    this.events.emit("confirm-sleep");
  }

  // ---------------------------------------------------------------- mine handoff

  private enterMine(): void {
    if (store.inv.count((it) => it.kind === "tool" && it.tool === "pickaxe") === 0) {
      this.toast("You need a pickaxe to mine.", "#ffd27a");
      return;
    }
    this.transitioning = true;
    this.save();
    this.cameras.main.fadeOut(450, 0, 0, 0);
    this.cameras.main.once(Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.stop("Hud");
      this.scene.start("Mine", { depth: 1 });
    });
  }

  // ---------------------------------------------------------------- day cycle

  doSleep(): void {
    this.uiOpen = false;
    // Only the host may end the day: a guest's overnight pass would advance
    // crops + refill energy locally, then snap back to the host clock —
    // leaving the worlds diverged (and a free-energy exploit).
    if (!this.amHost) {
      this.toast("Only the host can end the day — ask them to sleep!", "#ffd27a");
      return;
    }
    this.endDay();
  }

  private passOut(): void {
    if (this.transitioning) {
      return;
    }
    this.toast("You passed out from exhaustion…", "#c8b6ff");
    this.endDay(true);
  }

  endDay(exhausted = false): void {
    this.transitioning = true;
    const cam = this.cameras.main;
    cam.fadeOut(600, 6, 10, 24);
    cam.once(Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      // Only the host advances the shared world/clock. A guest reaching here
      // (passOut) still gets the personal recovery — but running overnight
      // growth locally would diverge from the world the host broadcasts.
      if (this.amHost) {
        this.runOvernight();
        this.refreshTileEditsAfterOvernight();
        this.day += 1;
        this.timeMin = DAY_START_MIN;
        this.weather = weatherForDay(this.seed, this.day);
      }
      store.energy = exhausted || this.fainted ? Math.floor(MAX_ENERGY * 0.55) : MAX_ENERGY;
      store.hp = this.fainted
        ? Math.floor(store.maxHp() * 0.5)
        : Math.min(store.maxHp(), store.hp + HP_REGEN_PER_DAY);
      this.fainted = false;
      this.save();
      if (this.amHost) {
        this.events.emit("daybanner", this.day, seasonOfDay(this.day), this.weather);
      }
      Sound.wake();
      cam.fadeIn(700, 6, 10, 24);
      cam.once(Cameras.Scene2D.Events.FADE_IN_COMPLETE, () => {
        this.transitioning = false;
      });
    });
  }

  private runOvernight(): void {
    const nextDay = this.day + 1;
    const nextSeason = seasonOfDay(nextDay);
    const nextWeather = weatherForDay(this.seed, nextDay);
    const rainy = isWet(nextWeather);

    // grow watered crops; wither out-of-season; then reset/refresh watering
    for (const [i, cs] of this.world.crops) {
      const def = CROPS[cs.crop];
      if (!def.seasons.includes(nextSeason)) {
        this.cropImgs.get(i)?.destroy();
        this.cropImgs.delete(i);
        this.world.crops.delete(i);
        continue;
      }
      const watered = this.world.watered[i] === 1 || rainy;
      if (watered && cs.daysGrown < def.growthDays) {
        cs.daysGrown += 1;
        this.ensureCrop(i, cs.crop, cropStage(def, cs.daysGrown));
      }
    }
    for (let i = 0; i < this.world.watered.length; i += 1) {
      const wet = rainy && this.world.tilled[i] === 1 ? 1 : 0;
      if (this.world.watered[i] !== wet) {
        this.world.watered[i] = wet;
        this.refreshSoilTint(i);
      }
    }
    this.canCharge = CAN_MAX;
    this.animals.runOvernight();
    this.npcs.runOvernight();
  }

  // ---------------------------------------------------------------- misc

  private updateNightTint(): void {
    const { color, alpha } = tintFor(this.timeMin, this.weather);
    this.nightOverlay.setFillStyle(color);
    this.nightOverlay.setAlpha(alpha);
  }

  toast(text: string, color = "#fff6d5"): void {
    this.events.emit("toast", text, color);
  }

  /** Mark the save dirty; update() flushes at most every SAVE_FLUSH_SEC.
   *  Transitions (enterMine/endDay) and hidden/beforeunload call save() directly. */
  requestSave(): void {
    this.saveDirty = true;
  }

  save(): void {
    this.saveDirty = false;
    this.saveAcc = 0;
    const d: SaveData = {
      animalSeq: store.animalSeq,
      animals: store.animalSave(),
      canCharge: this.canCharge,
      day: this.day,
      energy: store.energy,
      gold: store.gold,
      hp: store.hp,
      inv: store.inv.toJSON(),
      npcFriendship: store.npcFriendship,
      player: { x: this.player.x, y: this.player.y },
      seed: this.seed,
      skills: store.skills.toJSON(),
      timeMin: this.timeMin,
      v: 3,
      world: this.world.toJSON(),
    };
    writeSave(d);
  }

  season(): Season {
    return seasonOfDay(this.day);
  }
  actionHeld(): boolean {
    return (
      this.keys.SPACE.isDown ||
      this.keys.E.isDown ||
      this.input.activePointer.isDown ||
      this.pad.isButtonDown("a")
    );
  }
  playerAnim(key: string): void {
    this.player.play(key, true);
  }
}
