import type Phaser from "phaser";
import { Animations, Cameras, Math as PhaserMath, Scene, Scenes } from "phaser";
import { PhysicalGamepad } from "@vibedgames/gamepad";
import type { PhaserGamepad } from "@vibedgames/gamepad/phaser";
import type { MultiplayerClient } from "@vibedgames/multiplayer";
import { notifyGameStarted } from "@repo/embed";
import {
  TILE,
  zoomForWidth,
  MAP_W,
  MAP_H,
  WALK_SPEED,
  RUN_SPEED,
  CHAR_ORIGIN_Y,
  ENERGY_PER_SWING,
  CAN_MAX,
  DAY_START_MIN,
  DAY_END_MIN,
  GAME_MIN_PER_REAL_SEC,
  DEPTH,
  MP_ROOM,
  MP_INTEREST_RADIUS,
  MP_LIMITS,
  MP_MAX_PLAYERS,
  OFFLINE_FALLBACK_MS,
  FARM_SEED,
} from "../config";
import type { JsonObject, JsonValue } from "../json";
import { anchorClock, clockPatch, clockTime, readClock, turnDay } from "../net/clock-sync";
import type { ClockAnchor } from "../net/clock-sync";
import { ClaimBook } from "../net/claim-book";
import { ClaimTicket, WORK_HOLD_MS, claimKey, claimPrefix, parseClaimKey } from "../net/claims";
import type { ClaimTarget } from "../net/claims";
import { FarmSync, roomEpoch } from "../net/farm-sync";
import { FarmerSender } from "../net/farmer-wire";
import { openSession } from "../net/session";
import { RemoteFarmers, farmerTag } from "../net/remote-farmers";
import { parseTileIntent } from "../net/tile-codec";
import type { TileIntent } from "../net/tile-codec";
import { World, GROUND, inBounds, tileIdx } from "../world/world";
import type { WorldObject } from "../world/world";
import { hintFor } from "../ui/action-hints";
import { tintFor } from "../render/night-tint";
import { pathTo } from "../systems/pathfind";
import type { Waypoint } from "../systems/pathfind";
import { generateFarm, MINE_EXIT, consumedSprites } from "../world/mapgen";
import { getWorldMap } from "../world/map-store";
import { buildWorldMap } from "../render/worldmap-render";
import { CELL } from "../world/worldmap";
import type { WorldMapSprite } from "../world/worldmap";
import { Inventory } from "../systems/inventory";
import { Collections } from "../systems/collections";
import type { CollectionDiscovery } from "../systems/collections";
import { Skills, SKILL_NAMES } from "../systems/skills";
import type { SkillId } from "../systems/skills";
import { store } from "../systems/store";
import { CROPS, cropStage, isMature } from "../data/crops";
import type { CropId } from "../data/crops";
import type { Item, ForageId, ToolId } from "../data/items";
import { loadSave, writeSave } from "../systems/save";
import type { SaveData } from "../systems/save";
import { burst, floatText, shake, pop, rewardArc } from "../render/fx";
import { FarmAmbience } from "../render/farm-ambience";
import { Sound } from "../render/audio";
import { seasonOfDay } from "../data/calendar";
import { isWet, weatherForDay } from "../systems/weather";
import type { Weather } from "../systems/weather";
import { Fishing } from "../systems/fishing";
import { allGameKeys, makeGameKeys, NUM_KEY_NAMES } from "../systems/keys";
import type { GameKeys } from "../systems/keys";
import { stickMove } from "../systems/stick";
import { isTap } from "../systems/touch";
import { AnimalManager } from "../entities/animals";
import { NpcManager } from "../entities/npcs";

type CharAction = "dig" | "water" | "axe" | "mine" | "doing";

/** Presentation receipt for this visit. Never persisted or used to award gold. */
export type DayRecap = Readonly<{ day: number; shippedGold: number; shipments: number }>;

export type MineRecap = Readonly<{
  deepest: number;
  defeated: number;
  gathered: number;
  gold: number;
  fainted: boolean;
}>;

declare global {
  interface Window {
    /** DEV-only hook for headless verification. */
    __gs?: GameScene;
  }
}

const SAVE_FLUSH_SEC = 3;

const coopObjects = () => generateFarm(FARM_SEED, getWorldMap()).world.objects;

let trailerStaging = false;

export const enableTrailerStaging = () => {
  trailerStaging = true;
};

const ROOM_PARAM = import.meta.env.DEV ? new URLSearchParams(location.search).get("room") : null;
const ROOM = ROOM_PARAM === null || ROOM_PARAM === "" ? MP_ROOM : ROOM_PARAM;

const ACTION_TIMING = {
  axe: [16, 10, 7],
  dig: [18, 13, 9],
  doing: [14, 8, 4],
  mine: [16, 10, 7],
  water: [9, 5, 3],
} satisfies Record<CharAction, [number, number, number]>;

interface HintKey {
  idx: number;
  item: Item | null;
}

export class GameScene extends Scene {
  world!: World;
  day = 1;
  timeMin = DAY_START_MIN;
  canCharge = CAN_MAX;
  uiOpen = false;
  private uiClosedFrame = -1;
  controlsPaused = false;
  weather: Weather = "sunny";
  private shipping: DayRecap = { day: 1, shipments: 0, shippedGold: 0 };

  private seed = 0;
  private solo = false;
  player!: Phaser.GameObjects.Sprite;
  private shadow!: Phaser.GameObjects.Sprite;
  facing = { x: 0, y: 1 };
  acting = false;
  private moving = false;
  private clickPath: Waypoint[] = [];
  private pathStuck = 0;

  private soilImgs = new Map<number, Phaser.GameObjects.Image>();
  private cropImgs = new Map<number, Phaser.GameObjects.Image>();
  private ambience: FarmAmbience | null = null;
  objSprites = new Map<number, Phaser.GameObjects.Sprite>();
  private highlight!: Phaser.GameObjects.Graphics;
  private highlightIdx = -1;
  private nightOverlay!: Phaser.GameObjects.Rectangle;

  private keys!: GameKeys;
  /** Attached by Hud — the pad must render there, outside this camera's zoom. */
  gamepad?: PhaserGamepad;
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
  private readonly saveHandler = () => {
    this.save();
  };
  private saveDirty = false;
  private saveAcc = 0;
  private saveFailed = false;
  private farmReady = false;
  private farmPosition = { x: 0, y: 0 };

  net?: MultiplayerClient;
  remoteFarmers?: RemoteFarmers;
  private readonly farmerSender = new FarmerSender();
  private poseRevision = 0;
  private readonly farmSync = new FarmSync(
    {
      objectBack: (o) => {
        this.objectBack(o);
      },
      objectGone: (o) => {
        this.objectGone(o);
      },
      redrawTile: (idx) => {
        this.redrawTile(idx);
      },
      world: () => this.world,
    },
    coopObjects,
  );
  private clockAnchor: ClockAnchor | null = null;
  private publishedAnchor: ClockAnchor | null = null;
  private publishedAs: string | null = null;
  private lastShared: JsonObject | null = null;
  private readonly claims = new ClaimBook();
  private readonly hintKey: HintKey = { idx: -1, item: null };
  private hint: string | null = null;

  constructor() {
    super("Game");
  }

  private get amHost() {
    return this.net ? this.net.isHost : true;
  }

  // oxlint-disable-next-line class-methods-use-this -- passthrough to the module store
  get inv() {
    return store.inv;
  }

  create(data: {
    mode: "new" | "continue";
    fromMine?: boolean;
    fainted?: boolean;
    mineRecap?: MineRecap;
    /** Test hooks only: a fresh farm that never touches the shared room. */
    solo?: { seed: number };
  }) {
    notifyGameStarted();
    document.querySelector("#veil")?.classList.add("hidden");
    this.soilImgs = new Map();
    this.cropImgs = new Map();
    this.objSprites = new Map();
    this.acting = false;
    this.transitioning = false;
    this.uiOpen = false;
    this.controlsPaused = false;
    this.facing = { x: 0, y: 1 };
    this.fainted = false;
    this.stepTimer = 0;
    this.clickPath = [];
    this.pathStuck = 0;

    if (data?.fromMine !== true) {
      this.saveDirty = false;
    }

    this.saveAcc = 0;
    this.trailerMove = null;

    this.adoptSolo(data);

    if (data?.fromMine === true) {
      this.restoreFromStore();

      if (data.fainted === true) {
        this.fainted = true;
      }
    } else {
      this.openFarm(data);
    }

    this.weather = weatherForDay(this.seed, this.day);

    if (!trailerStaging && !this.solo && !this.net && this.seed === FARM_SEED) {
      this.net = openSession({
        fallbackMs: OFFLINE_FALLBACK_MS,
        interest: { radius: MP_INTEREST_RADIUS },
        limits: MP_LIMITS,
        maxPlayers: MP_MAX_PLAYERS,
        onClaim: (key, owner) => {
          this.handleClaim(key, owner);
        },
        onEvent: (event, payload, from) => {
          this.handleNetEvent(event, payload, from);
        },
        room: ROOM,
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
    this.player.on(Animations.Events.ANIMATION_START, () => {
      this.poseRevision += 1;
    });
    this.player.setPosition(this.pendingSpawn.x, this.pendingSpawn.y);
    this.farmPosition = { ...this.pendingSpawn };
    this.farmReady = true;

    this.highlight = this.add.graphics().setDepth(DEPTH.highlight);
    this.highlightIdx = -1;

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
    this.ambience = new FarmAmbience(this);

    this.fishing = new Fishing(this);
    this.animals = new AnimalManager(this, this.world);
    this.npcs = new NpcManager(this);
    this.animals.spawnAll();
    this.npcs.spawnAll();

    this.setupInput();
    const releaseMusic = Sound.startMusic("farm");
    this.events.once(Scenes.Events.SHUTDOWN, () => {
      releaseMusic();
      this.ambience = null;
      this.collisionOverlay = null;
    });
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

    if (data?.fromMine === true) {
      cam.fadeIn(400, 0, 0, 0);
      this.showMineRecap(data.mineRecap);
    } else {
      this.events.emit("daybanner", this.day, seasonOfDay(this.day), this.weather);
    }

    this.remoteFarmers = new RemoteFarmers(this);

    if (data?.fromMine === true) {
      this.farmSync.reset();
    } else {
      this.farmSync.forget();
      this.claims.clear();
    }

    this.publishedAs = null;
    this.publishedAnchor = null;
    this.lastShared = null;
    this.farmerSender.arrive();

    if (import.meta.env.DEV) {
      window.__gs = this;
    }
  }

  private showMineRecap(recap: MineRecap | undefined) {
    if (!recap) {
      return;
    }

    this.time.delayedCall(420, () => {
      this.toast(
        `${recap.fainted ? "Rescued" : "Home"} · Floor ${recap.deepest} · ${recap.gathered} minerals · ${recap.defeated} defeated · ${recap.gold >= 0 ? "+" : ""}${recap.gold}g`,
        recap.fainted ? "#ffb3b3" : "#d8ffb0",
      );
    });
  }

  private openFarm(data: { mode: "new" | "continue"; solo?: { seed: number } }) {
    this.clockAnchor = null;
    const s = data.mode === "continue" ? loadSave() : null;

    if (s === null) {
      this.startNew(data.solo?.seed);
    } else {
      this.loadFrom(s);
    }

    this.shipping = { day: this.day, shipments: 0, shippedGold: 0 };
  }

  private adoptSolo(data: { fromMine?: boolean; solo?: { seed: number } }) {
    if (data.fromMine !== true) {
      this.solo = data.solo !== undefined;
    }

    if (this.solo) {
      this.net?.destroy();
      this.net = undefined;
    }
  }

  private startNew(seed = FARM_SEED) {
    this.seed = seed;
    const gen = generateFarm(this.seed, getWorldMap());
    this.world = gen.world;
    store.initNew();
    this.day = 1;
    this.timeMin = DAY_START_MIN;
    this.canCharge = CAN_MAX;
    this.pendingSpawn = { x: gen.spawn.tx * TILE + 8, y: gen.spawn.ty * TILE + 12 };
  }

  private loadFrom(s: SaveData) {
    this.seed = s.seed;
    this.world = World.fromJSON(s.world, getWorldMap());
    store.inv = Inventory.fromJSON(s.inv);
    store.skills = Skills.fromJSON(s.skills);
    store.collections = Collections.fromJSON(s.collections);
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

  private restoreFromStore() {
    if (!this.farmReady) {
      this.startNew();
    }

    this.pendingSpawn = { x: MINE_EXIT.tx * TILE + 8, y: MINE_EXIT.ty * TILE + 8 };
  }

  private setupInput() {
    const kb = this.input.keyboard;

    if (!kb) {
      return;
    }

    this.input.removeAllListeners();
    kb.removeAllListeners();
    kb.on("keydown", () => {
      Sound.resume();
    });
    this.input.on("pointerdown", () => {
      Sound.resume();
    });
    this.keys = makeGameKeys(kb);

    for (const k of allGameKeys(this.keys)) {
      k.removeAllListeners();
    }

    this.keys.M.on("down", () => {
      this.toast(Sound.toggleMute() ? "Sound off" : "Sound on", "#dfe9ff");
    });

    for (const [i, name] of NUM_KEY_NAMES.entries()) {
      this.keys[name].on("down", () => {
        if (!this.controlsPaused && !this.uiOpen) {
          store.inv.select(i);
        }
      });
    }

    this.keys.SPACE.on("down", () => {
      this.tryAction();
    });
    this.keys.E.on("down", () => {
      this.tryAction();
    });

    const actOrWalk = (p: Phaser.Input.Pointer) => {
      if (this.controlsPaused) {
        return;
      }

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
      if (this.controlsPaused || this.uiOpen || p.button !== 0) {
        return;
      }

      const hud = this.scene.get("Hud");

      if (hud.input.hitTestPointer(p).length > 0) {
        return;
      }

      if (this.fishing.active) {
        this.tryAction();

        return;
      }

      if (p.wasTouch) {
        return;
      }

      actOrWalk(p);
    });
    this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (this.controlsPaused || !p.wasTouch || this.uiOpen || this.fishing.active) {
        return;
      }

      const hud = this.scene.get("Hud");

      if (hud.input.hitTestPointer(p).length > 0) {
        return;
      }

      if (!isTap(p)) {
        return;
      }

      actOrWalk(p);
    });
    this.keys.I.on("down", () => {
      this.toggleInventory();
    });
    kb.on("keydown-T", () => {
      this.toggleCollisionOverlay();
    });
    this.input.on(
      "wheel",
      (_p: Phaser.Input.Pointer, _o: Phaser.GameObjects.GameObject[], _dx: number, dy: number) => {
        if (!this.controlsPaused && !this.uiOpen) {
          store.inv.cycle(Math.sign(dy));
        }
      },
    );
  }

  private collisionOverlay: Phaser.GameObjects.Graphics | null = null;
  private toggleCollisionOverlay() {
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

  toggleInventory() {
    if (this.controlsPaused || this.fishing.active) {
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

  private buildGround() {
    const worldMap = getWorldMap();

    const skip = new Set<WorldMapSprite>(
      consumedSprites(worldMap, this.world).map((c) => c.sprite),
    );

    buildWorldMap(this, worldMap, skip);
  }

  private buildObjects() {
    for (const o of this.world.objects) {
      this.spawnObjectSprite(o);
    }
  }

  spawnObjectSprite(o: WorldObject) {
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

      default: {
        return;
      }
    }

    spr.setDepth(DEPTH.entityBase + by);
    this.objSprites.set(o.id, spr);
  }

  private buildSoilAndCrops() {
    for (let i = 0; i < MAP_W * MAP_H; i += 1) {
      if ((this.world.tilled[i] ?? 0) !== 0) {
        this.ensureSoil(i);
      }
    }

    for (const [i, cs] of this.world.crops) {
      this.ensureCrop(i, cs.crop, cropStage(CROPS[cs.crop], cs.daysGrown));
    }
  }

  private ensureSoil(i: number) {
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

  private refreshSoilTint(i: number) {
    this.soilImgs.get(i)?.setTint((this.world.watered[i] ?? 0) === 0 ? 0xff_ff_ff : 0x6b_4f_33);
  }

  private ensureCrop(i: number, crop: CropId, stage: number) {
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
  ) {
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

  private pollPad() {
    this.pad.update();

    if (this.pad.justPressed("a")) {
      this.tryAction();
    }

    if (this.pad.justPressed("y")) {
      this.toggleInventory();
    }

    if (!this.controlsPaused && !this.uiOpen) {
      if (this.pad.justPressed("lb")) {
        store.inv.cycle(-1);
      }

      if (this.pad.justPressed("rb")) {
        store.inv.cycle(1);
      }
    }
  }

  override update(_t: number, dms: number) {
    const dt = Math.min(dms, 50) / 1000;
    this.gamepad?.update();
    this.pollPad();

    if (this.net && this.isOnline()) {
      this.claims.poll(this.net);
    }

    this.followHost();
    const busy = this.uiOpen || this.transitioning || this.fishing.active;
    this.runClock(dt, !busy);

    if (!busy) {
      if (!this.controlsPaused) {
        this.handleMovement(dt);
      }
    } else if (!this.acting && !this.fishing.active) {
      this.setAnim("idle");
    }

    if (!this.controlsPaused) {
      this.fishing.update(dt);
    }

    this.animals.update(dt);
    this.npcs.update(dt);
    this.updateHighlight();
    this.updateNightTint();
    this.ambience?.update(dt, this.weather, this.season(), this.timeMin);
    this.player.setDepth(DEPTH.entityBase + this.player.y);
    this.shadow.setPosition(this.player.x, this.player.y + 1);
    this.shadow.setDepth(this.player.depth - 1);
    this.updateNet();
    this.trailerFrame?.(dt);
    this.retryPendingSave(dt);
  }

  /**
   * True only while in a live co-op room: not still connecting, not dropped
   * and waiting to be readmitted, not offline. Used by the wrapper's pause
   * handler so it never freezes a session other players are relying on.
   */
  isOnline() {
    return this.net?.connectionStatus === "connected";
  }

  /** Where this farmer stands with the co-op room, for the HUD's notice; null
   *  on a farm that never joins it (an older save's map, a staged run). */
  connectionStatus() {
    return this.net?.connectionStatus ?? null;
  }

  /** Live co-op keeps its clock and connection; only this farmer takes a break. */
  setControlsPaused(paused: boolean) {
    this.controlsPaused = paused;
    this.moving = false;
    this.clickPath = [];
    this.pathStuck = 0;

    for (const key of allGameKeys(this.keys)) {
      key.reset();
    }

    this.gamepad?.pad.reset();
    this.pad.update();
    this.fishing.setPaused(paused);

    if (!this.acting && !this.fishing.active) {
      this.setAnim("idle");
    }
  }

  private handleNetEvent(event: string, payload: JsonValue, from: string) {
    const { net } = this;

    if (!net || !this.amHost || event !== "tile") {
      return;
    }

    const intent = parseTileIntent(payload);

    if (!intent) {
      return;
    }

    if (intent.action === "plant") {
      const target: ClaimTarget = { gen: intent.gen, idx: intent.idx, kind: "plant" };
      const key = this.claimKeyFor(target);

      if (key === null || net.ownerOf(key) !== from) {
        return;
      }
    }

    if (this.farmSync.applyIntent(intent)) {
      this.redrawTile(intent.idx);
      this.farmSync.publishTiles(net, [intent.idx]);

      if (intent.action === "plant") {
        this.releaseSpent(net, intent.idx, intent.gen);
      }
    }
  }

  private handleClaim(key: string, owner: string | null) {
    const { net } = this;

    if (!net) {
      return;
    }

    if (this.isOnline()) {
      this.claims.hear(net, key, owner);
    }

    if (owner !== null && this.amHost) {
      this.applyGrant(net, key, owner);
    }
  }

  private applyGrant(net: MultiplayerClient, key: string, owner: string) {
    const claim = parseClaimKey(key);

    if (!claim || claim.epoch !== this.farmSync.epoch) {
      return;
    }

    const { target } = claim;

    switch (target.kind) {
      case "harvest": {
        if (this.farmSync.harvest(net, target.idx, target.gen)) {
          this.redrawTile(target.idx);
        }

        break;
      }

      case "clear": {
        const gone = this.farmSync.clear(net, target.id);

        if (gone) {
          this.objectGone(gone);
        }

        break;
      }

      case "plant": {
        if (owner === net.playerId) {
          this.farmSync.publishTiles(net, [target.idx]);
          this.releaseSpent(net, target.idx, target.gen);
        }

        break;
      }

      case "hold": {
        break;
      }

      default: {
        break;
      }
    }
  }

  private applyHeldGrants(net: MultiplayerClient) {
    for (const [key, { owner }] of Object.entries(net.claims)) {
      this.applyGrant(net, key, owner);
    }
  }

  private releaseSpent(net: MultiplayerClient, idx: number, gen: number) {
    if (gen <= 1) {
      return;
    }

    const spent: ClaimTarget[] = [
      { gen: gen - 1, idx, kind: "plant" },
      { gen: gen - 1, idx, kind: "harvest" },
    ];

    for (const target of spent) {
      const key = this.claimKeyFor(target);

      if (key !== null && net.ownerOf(key) !== null) {
        net.release(key);
      }
    }
  }

  private claimKeyFor(target: ClaimTarget) {
    const { epoch } = this.farmSync;

    return this.isOnline() && epoch !== null ? claimKey(epoch, target) : null;
  }

  private otherHolder(target: ClaimTarget) {
    const { net } = this;
    const key = this.claimKeyFor(target);
    const owner = net && key !== null ? net.ownerOf(key) : null;

    return owner === null || owner === net?.playerId ? null : owner;
  }

  private claim(target: ClaimTarget, ttlMs?: number) {
    const { net } = this;
    const key = this.claimKeyFor(target);

    return net && key !== null ? this.claims.ask(net, key, ttlMs) : ClaimTicket.won();
  }

  private netTileAction(intent: TileIntent) {
    const { net } = this;

    if (!net || net.connectionStatus === "offline") {
      return;
    }

    if (this.amHost) {
      if (intent.action !== "plant") {
        this.farmSync.publishTiles(net, [intent.idx]);
      }

      return;
    }

    this.farmSync.protectTile(intent.idx, performance.now());
    net.sendToHost("tile", intent);
  }

  private shieldTile(idx: number) {
    if (!this.amHost) {
      this.farmSync.protectTile(idx, performance.now());
    }
  }

  private shieldClear(id: number) {
    if (!this.amHost) {
      this.farmSync.protectClear(id, performance.now());
    }
  }

  private redrawTile(idx: number) {
    if (!this.sys.isActive()) {
      return;
    }

    if (idx === this.hintKey.idx) {
      this.hintKey.idx = -1;
    }

    const cs = this.world.crops.get(idx);

    if (cs) {
      this.ensureCrop(idx, cs.crop, cropStage(CROPS[cs.crop], cs.daysGrown));
    } else {
      this.cropImgs.get(idx)?.destroy();
      this.cropImgs.delete(idx);
    }

    if ((this.world.tilled[idx] ?? 0) === 0) {
      this.soilImgs.get(idx)?.destroy();
      this.soilImgs.delete(idx);
    } else {
      this.ensureSoil(idx);
    }

    this.refreshSoilTint(idx);
  }

  private objectGone(o: WorldObject) {
    this.hintKey.idx = -1;
    const spr = this.objSprites.get(o.id);
    this.objSprites.delete(o.id);

    if (spr && this.sys.isActive()) {
      this.tweens.add({
        alpha: 0,
        duration: 200,
        onComplete: () => {
          spr.destroy();
        },
        targets: spr,
      });
    }
  }

  private objectBack(o: WorldObject) {
    this.hintKey.idx = -1;

    if (this.sys.isActive()) {
      this.spawnObjectSprite(o);
    }
  }

  private followHost() {
    const { net } = this;

    if (!net || this.amHost) {
      return;
    }

    const shared = net.sharedState;
    const now = performance.now();

    if (shared !== this.lastShared) {
      this.farmSync.adopt(shared, now);
      this.adoptClock(net, shared);
    }

    this.lastShared = shared;
    this.farmSync.expire(shared, now);
  }

  private adoptClock(net: MultiplayerClient, shared: JsonObject) {
    const anchor = readClock(shared);

    if (!anchor) {
      return;
    }

    const turn = turnDay(this, anchor);
    this.clockAnchor = anchor;
    this.weather = anchor.weather;

    if (!turn) {
      return;
    }

    this.day = anchor.day;
    this.timeMin = clockTime(anchor, net.serverNow());
    const recap = this.shipping.shipments > 0 ? this.shipping : undefined;
    this.shipping = { day: this.day, shipments: 0, shippedGold: 0 };

    if (turn.rested) {
      this.wakeUp(turn.exhausted);
    }

    this.events.emit("daybanner", this.day, seasonOfDay(this.day), this.weather, recap);
  }

  private updateNet() {
    const { net } = this;

    if (!net) {
      return;
    }

    if (this.isOnline()) {
      const update = net.serverClock.synced
        ? this.farmerSender.tick(this.player, this.moving, this.poseRevision, net.serverNow())
        : null;

      if (update) {
        net.updateMyState(update);
      }

      if (this.amHost) {
        this.publishHost(net);
      } else {
        this.publishedAs = null;
      }
    }

    this.remoteFarmers?.sync(net.players, net.playerId);
    this.remoteFarmers?.update();
  }

  private publishHost(net: MultiplayerClient) {
    if (this.publishedAs !== net.playerId) {
      this.publishedAs = net.playerId;
      this.publishedAnchor = null;
      const before = roomEpoch(net.sharedState);
      this.applyHeldGrants(net);
      this.farmSync.publishWorld(net, net.sharedState, Date.now());

      if (before !== null && before !== this.farmSync.epoch) {
        net.clearClaims(claimPrefix(before));
      }
    }

    const anchor = this.clockAnchor;

    if (anchor && anchor !== this.publishedAnchor) {
      net.updateSharedState(clockPatch(anchor));
      this.publishedAnchor = anchor;
    }
  }

  private runClock(dt: number, running: boolean) {
    const { net } = this;

    if (!net || !this.isOnline() || !net.serverClock.synced) {
      if (running) {
        this.advanceTime(dt);
      }

      return;
    }

    const now = net.serverNow();
    const held = this.clockAnchor;

    if (
      this.amHost &&
      (!held || held.day !== this.day || held.weather !== this.weather || held.running !== running)
    ) {
      this.clockAnchor = anchorClock(this.day, this.timeMin, this.weather, running, now);
    }

    const anchor = this.clockAnchor;

    if (!anchor) {
      return;
    }

    this.timeMin = clockTime(anchor, now);

    if (this.amHost && this.timeMin >= DAY_END_MIN) {
      this.passOut();
    }
  }

  private advanceTime(dt: number) {
    this.timeMin += dt * GAME_MIN_PER_REAL_SEC;

    if (this.timeMin >= DAY_END_MIN) {
      this.passOut();
    }
  }

  private moveIntent() {
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

  private pathStep() {
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

  private trackPathProgress(moved: number, expected: number, dt: number) {
    if (this.clickPath.length === 0) {
      return;
    }

    this.pathStuck = moved < expected * 0.25 ? this.pathStuck + dt : 0;

    if (this.pathStuck > 0.4) {
      this.clickPath = [];
      this.pathStuck = 0;
    }
  }

  private handleMovement(dt: number) {
    if (this.acting) {
      this.moving = false;

      return;
    }

    const k = this.keys;
    const intent = this.moveIntent();
    let { dx, dy } = intent;
    const { run: stickRun } = intent;

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

  /** Waypoints from the farmer's feet to (tx,ty); see systems/pathfind. */
  pathTo(tx: number, ty: number) {
    return pathTo(this.world, this.feetTile(), tx, ty);
  }

  private startClickMove(tx: number, ty: number, wx: number, wy: number) {
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

  private showClickMarker(wx: number, wy: number) {
    const g = this.add.graphics({ x: wx, y: wy });
    g.setDepth(600_000);
    g.lineStyle(1.2, 0xff_ff_ff, 0.9);
    g.strokeCircle(0, 0, 5);
    this.tweens.add({
      alpha: 0,
      duration: 300,
      onComplete: () => {
        g.destroy();
      },
      scaleX: 0.3,
      scaleY: 0.3,
      targets: g,
    });
  }

  private moveResolved(mx: number, my: number) {
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

  private setAnim(name: "idle" | "walk" | "run" | null) {
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
  private targetIdx() {
    const tx = Math.floor(this.player.x / TILE) + this.facing.x;
    const ty = Math.floor((this.player.y - 1) / TILE) + this.facing.y;

    return inBounds(tx, ty) ? tileIdx(tx, ty) : -1;
  }

  private updateHighlight() {
    const hidden = trailerStaging || this.uiOpen || this.transitioning || this.fishing.active;
    const idx = hidden ? -1 : this.targetIdx();

    if (idx === this.highlightIdx) {
      return;
    }

    this.highlightIdx = idx;
    this.highlight.clear();

    if (idx < 0) {
      return;
    }

    const { tx, ty } = this.targetTile();
    const x = tx * TILE;
    const y = ty * TILE;
    this.highlight.lineStyle(1, 0xff_ff_ff, 0.55);
    this.highlight.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
    this.highlight.fillStyle(0xff_ff_ff, 0.08);
    this.highlight.fillRect(x, y, TILE, TILE);
  }

  private tryForagePickup() {
    const f = this.feetTile();
    const o = this.world.objectAt(f.tx, f.ty);

    if (o && o.type === "forage") {
      this.pickForage(o);
    }
  }

  /** Public: the trailer director drives staged actions through this exact path. */
  tryAction(target?: { tx: number; ty: number }) {
    if (this.controlsPaused || this.uiOpen || this.acting || this.transitioning) {
      return;
    }

    if (this.game.loop.frame === this.uiClosedFrame) {
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

    const idx = inBounds(tx, ty) ? tileIdx(tx, ty) : -1;

    if (this.tryHarvest(idx)) {
      return;
    }

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

  private tryHarvest(idx: number) {
    const cs = idx >= 0 ? this.world.crops.get(idx) : undefined;

    if (!cs || !isMature(CROPS[cs.crop], cs.daysGrown)) {
      return false;
    }

    const holder = this.otherHolder({ gen: this.world.gens[idx] ?? 0, idx, kind: "harvest" });

    if (holder === null) {
      this.beginAction("doing", () => {
        this.harvest(idx);
      });
    } else {
      this.toast(`${farmerTag(holder)} is harvesting that.`, "#ffd27a");
    }

    return true;
  }

  private actOnObject(obj: WorldObject, tx: number, ty: number, item: Item | null) {
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
          this.workObject(obj, "axe");
        } else {
          this.toast("You need an axe.", "#ffd27a");
        }

        break;
      }

      case "rock": {
        if (item?.kind === "tool" && item.tool === "pickaxe") {
          this.workObject(obj, "mine");
        } else {
          this.toast("You need a pickaxe.", "#ffd27a");
        }

        break;
      }

      case "ore": {
        break;
      }

      default: {
        break;
      }
    }
  }

  private useTool(tool: ToolId, tx: number, ty: number, idx: number) {
    if (tool === "hoe") {
      if (this.world.canTill(tx, ty)) {
        this.beginAction("dig", () => {
          this.till(idx);
        });
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
      this.beginAction("doing", null);
    }
  }

  private useCan(tx: number, ty: number, idx: number) {
    if (inBounds(tx, ty) && this.world.getGround(tx, ty) === GROUND.water) {
      this.beginAction("water", () => {
        this.refillCan();
      });
    } else if (idx >= 0 && (this.world.tilled[idx] ?? 0) !== 0) {
      if (this.canCharge <= 0) {
        this.toast("Out of water — refill at the pond.", "#9fd8ff");
      } else {
        this.beginAction("water", () => {
          this.waterTile(idx);
        });
      }
    } else {
      this.toast("Till the soil first.", "#ffd27a");
    }
  }

  private plantSeed(crop: CropId, idx: number) {
    if (idx >= 0 && (this.world.tilled[idx] ?? 0) !== 0 && !this.world.crops.has(idx)) {
      if (!CROPS[crop].seasons.includes(seasonOfDay(this.day))) {
        this.toast(`${CROPS[crop].name} won't grow in ${seasonOfDay(this.day)}.`, "#ffd27a");

        return;
      }

      const holder = this.otherHolder({ gen: (this.world.gens[idx] ?? 0) + 1, idx, kind: "plant" });

      if (holder !== null) {
        this.toast(`${farmerTag(holder)} is planting there.`, "#ffd27a");

        return;
      }

      this.beginAction("doing", () => {
        this.plant(idx, crop);
      });
    } else {
      this.toast(
        (this.world.tilled[idx] ?? 0) === 0 ? "Till the soil first." : "Already planted.",
        "#ffd27a",
      );
    }
  }

  faceTowards(tx: number, ty: number) {
    const f = this.feetTile();

    if (tx < f.tx) {
      this.player.setFlipX(true);
    } else if (tx > f.tx) {
      this.player.setFlipX(false);
    }

    this.facing = { x: Math.sign(tx - f.tx), y: tx === f.tx ? Math.sign(ty - f.ty) : 0 };
  }

  /** Swing `action`, landing `onImpact` on its impact frame. False when too
   *  tired to swing. */
  beginAction(action: CharAction, onImpact: (() => void) | null) {
    if (store.energy <= 0 && action !== "doing") {
      this.toast("Too tired… time to sleep.", "#c8b6ff");

      return false;
    }

    this.clickPath = [];
    this.acting = true;
    const [rate, , impactFrame] = ACTION_TIMING[action];
    this.player.play(`p-${action}`, true);

    if (action !== "doing") {
      store.spendEnergy(ENERGY_PER_SWING);
    }

    this.time.delayedCall((impactFrame / rate) * 1000, () => {
      if (this.acting && onImpact) {
        onImpact();
      }
    });
    this.player.once(`animationcomplete-p-${action}`, () => {
      this.acting = false;
      this.player.play("p-idle", true);
    });

    return true;
  }

  private workObject(obj: WorldObject, action: "axe" | "mine") {
    const holder =
      this.otherHolder({ id: obj.id, kind: "hold" }) ??
      this.otherHolder({ id: obj.id, kind: "clear" });

    if (holder !== null) {
      this.toast(`${farmerTag(holder)} is working on that.`, "#ffd27a");

      return;
    }

    let hold = ClaimTicket.won();

    const hit = () => {
      if (action === "axe") {
        this.chop(obj, hold);
      } else {
        this.mineRock(obj, hold);
      }
    };

    if (this.beginAction(action, hit)) {
      hold = this.claim({ id: obj.id, kind: "hold" }, WORK_HOLD_MS);
    }
  }

  awardXP(skill: SkillId, amount: number) {
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

  private till(idx: number) {
    if (idx < 0) {
      return;
    }

    this.world.tilled[idx] = 1;
    store.work.tilled += 1;
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
    this.netTileAction({ action: "till", idx });
  }

  private waterTile(idx: number) {
    if ((this.world.watered[idx] ?? 0) === 0) {
      store.work.watered += 1;
    }

    this.world.watered[idx] = 1;
    this.canCharge = Math.max(0, this.canCharge - 1);
    this.refreshSoilTint(idx);
    const tx = idx % MAP_W;
    const ty = Math.trunc(idx / MAP_W);
    burst(this, tx * TILE + 8, ty * TILE + 8, {
      colors: [0x6f_c6_ff, 0x9f_e0_ff, 0xff_ff_ff],
      count: 8,
      gravity: 200,
      matter: "droplet",
      speed: 40,
      up: true,
    });
    Sound.water();
    this.awardXP("farming", 1);
    this.netTileAction({ action: "water", idx });
  }

  private refillCan() {
    this.canCharge = CAN_MAX;
    burst(this, this.player.x, this.player.y - 8, {
      colors: [0x6f_c6_ff, 0x9f_e0_ff],
      count: 12,
      matter: "droplet",
      speed: 35,
    });
    Sound.water();
    this.toast("Watering can refilled!", "#9fd8ff");
  }

  private plant(idx: number, crop: CropId) {
    const gen = (this.world.gens[idx] ?? 0) + 1;
    const slot = store.inv.slots[store.inv.selected];

    if (
      this.world.crops.has(idx) ||
      !slot ||
      slot.qty < 1 ||
      this.otherHolder({ gen, idx, kind: "plant" }) !== null
    ) {
      return;
    }

    const ticket = this.claim({ gen, idx, kind: "plant" });
    store.inv.consumeSlot(store.inv.selected, 1);
    this.world.crops.set(idx, { crop, daysGrown: 0 });
    this.world.gens[idx] = gen;
    store.work.planted += 1;
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
      matter: "leaf",
      speed: 30,
      up: true,
    });
    Sound.plant();
    this.requestSave();
    this.netTileAction({ action: "plant", crop, gen, idx });
    ticket.land({
      lost: (owner) => {
        this.unplant(idx, crop, gen, owner);
      },
      won: () => {
        this.awardXP("farming", 2);
      },
    });
  }

  private unplant(idx: number, crop: CropId, gen: number, owner: string) {
    if (this.world.crops.get(idx)?.crop === crop && this.world.gens[idx] === gen) {
      this.world.crops.delete(idx);
      this.world.gens[idx] = gen - 1;
      this.redrawTile(idx);
    }

    const { net } = this;

    if (net && !this.amHost) {
      this.farmSync.settleTile(idx, net.sharedState, performance.now());
    }

    store.inv.add({ crop, kind: "seed" }, 1);
    store.work.planted -= 1;
    this.toast(`${farmerTag(owner)} planted there first.`, "#ffd27a");
    this.requestSave();
  }

  private giveBack(owner: string, deed: string, haul: readonly [Item, number][]) {
    for (const [item, qty] of haul) {
      store.inv.remove(item, qty);
    }

    this.toast(`${farmerTag(owner)} ${deed} that first.`, "#ffd27a");
    this.requestSave();
  }

  private harvest(idx: number) {
    const cs = this.world.crops.get(idx);
    const gen = this.world.gens[idx] ?? 0;

    if (!cs || this.otherHolder({ gen, idx, kind: "harvest" }) !== null) {
      return;
    }

    const ticket = this.claim({ gen, idx, kind: "harvest" });
    const def = CROPS[cs.crop];
    const [lo, hi] = def.yield;
    let n = lo + Math.trunc(Math.random() * (hi - lo + 1));

    if (Math.random() < store.skills.yieldBonusChance()) {
      n += 1;
    }

    const item: Item = { crop: cs.crop, kind: "produce" };
    const leftover = store.inv.add(item, n);
    const accepted = n - leftover;
    const season = this.season();
    store.work.harvested += 1;
    this.world.crops.delete(idx);
    const img = this.cropImgs.get(idx);

    if (img) {
      pop(this, img);
      this.time.delayedCall(80, () => {
        img.destroy();
      });
    }

    this.cropImgs.delete(idx);
    this.world.watered[idx] = 0;
    this.refreshSoilTint(idx);
    const tx = idx % MAP_W;
    const ty = Math.trunc(idx / MAP_W);

    if (leftover < n) {
      rewardArc(this, tx * TILE + 8, ty * TILE + 4, this.player, item);
    }

    burst(this, tx * TILE + 8, ty * TILE + 8, {
      colors: [0x7e_c8_50, 0xff_e2_7a, 0xff_9e_d2],
      count: 12,
      matter: "leaf",
      speed: 55,
      up: true,
    });
    floatText(
      this,
      tx * TILE + 8,
      ty * TILE + 4,
      accepted > 0 ? `+${accepted} ${def.name}` : "Bag full",
      "#d8ffb0",
    );

    if (leftover > 0) {
      this.toast(`${leftover} ${def.name} left behind — bag full.`, "#ffd27a");
    }

    Sound.harvest();
    this.requestSave();
    this.shieldTile(idx);
    ticket.land({
      lost: (owner) => {
        store.work.harvested -= 1;
        this.giveBack(owner, "harvested", [[item, accepted]]);
      },
      won: () => {
        this.showDiscovery(store.collections.recordHarvest(cs.crop, season, accepted));
        this.awardXP("farming", 12);
      },
    });
  }

  private swingLands(o: WorldObject, hold: ClaimTicket) {
    const holder = hold.lostTo;

    if (holder !== null) {
      this.toast(`${farmerTag(holder)} is working on that.`, "#ffd27a");

      return false;
    }

    return this.world.objects.includes(o);
  }

  private holdHit(o: WorldObject, hold: ClaimTicket, skill: SkillId, xp: number) {
    hold.land({
      lost: () => {
        o.hp = Math.min(o.maxHp, o.hp + 1);
      },
      won: () => {
        this.awardXP(skill, xp);
      },
    });
  }

  private chop(o: WorldObject, hold: ClaimTicket) {
    if (!this.swingLands(o, hold)) {
      return;
    }

    o.hp -= 1;
    const spr = this.objSprites.get(o.id);

    if (spr) {
      this.tweens.add({ duration: 50, repeat: 2, targets: spr, x: spr.x + 1.5, yoyo: true });
      burst(this, spr.x, spr.y - 16, {
        colors: [0x4a_9d_3f, 0x7e_c8_50, 0x2f_6b_3a],
        count: 7,
        matter: "leaf",
        speed: 50,
      });
    }

    shake(this, 0.004, 110);
    Sound.chop();
    this.holdHit(o, hold, "foraging", 2);

    if (o.hp <= 0 && this.otherHolder({ id: o.id, kind: "clear" }) === null) {
      const felled = this.claim({ id: o.id, kind: "clear" });
      Sound.thud();
      const wood: Item = { kind: "resource", res: "wood" };
      const got = 2 + Math.trunc(Math.random() * 2);
      const kept = got - store.inv.add(wood, got);

      if (spr) {
        this.tweens.add({
          alpha: 0,
          duration: 220,
          onComplete: () => {
            spr.destroy();
          },
          scaleX: 0.7,
          scaleY: 0.6,
          targets: spr,
          y: spr.y + 3,
        });
      }

      this.objSprites.delete(o.id);
      this.world.removeObject(o);
      this.shieldClear(o.id);
      store.work.felled += 1;
      floatText(this, o.tx * TILE + 8, o.ty * TILE - 8, `+${got} Wood`, "#e8c79a");
      felled.land({
        lost: (owner) => {
          store.work.felled -= 1;
          this.giveBack(owner, "felled", [[wood, kept]]);
        },
        won: () => {
          this.awardXP("foraging", 6);
        },
      });
    }

    this.requestSave();
  }

  private mineRock(o: WorldObject, hold: ClaimTicket) {
    if (!this.swingLands(o, hold)) {
      return;
    }

    o.hp -= 1;
    const spr = this.objSprites.get(o.id);

    if (spr) {
      this.tweens.add({ duration: 60, scaleX: 1.12, scaleY: 0.9, targets: spr, yoyo: true });
      burst(this, spr.x, spr.y - 8, {
        colors: [0xbf_ca_d6, 0x8a_98_a8, 0xff_ff_ff],
        count: 8,
        matter: "spark",
        speed: 55,
      });
    }

    shake(this, 0.005, 110);
    Sound.mine();
    this.holdHit(o, hold, "mining", 3);

    if (o.hp <= 0 && this.otherHolder({ id: o.id, kind: "clear" }) === null) {
      const broken = this.claim({ id: o.id, kind: "clear" });
      Sound.thud();
      const stone: Item = { kind: "resource", res: "stone" };
      const got = 1 + Math.trunc(Math.random() * 2);
      const haul: [Item, number][] = [[stone, got - store.inv.add(stone, got)]];

      if (Math.random() < 0.25) {
        const coal: Item = { kind: "resource", res: "coal" };
        haul.push([coal, 1 - store.inv.add(coal, 1)]);
      }

      if (spr) {
        this.tweens.add({
          alpha: 0,
          duration: 200,
          onComplete: () => {
            spr.destroy();
          },
          scaleX: 0.5,
          scaleY: 0.5,
          targets: spr,
        });
      }

      this.objSprites.delete(o.id);
      this.world.removeObject(o);
      this.shieldClear(o.id);
      store.work.quarried += 1;
      floatText(this, o.tx * TILE + 8, o.ty * TILE - 8, `+${got} Stone`, "#cdd6e0");
      broken.land({
        lost: (owner) => {
          store.work.quarried -= 1;
          this.giveBack(owner, "broke", haul);
        },
        won: () => {
          this.awardXP("mining", 5);
        },
      });
    }

    this.requestSave();
  }

  private pickForage(o: WorldObject) {
    if (this.otherHolder({ id: o.id, kind: "clear" }) !== null) {
      return;
    }

    const picked = this.claim({ id: o.id, kind: "clear" });
    const kind: ForageId = o.variant === "mushroom_blue" ? "mushroom_blue" : "mushroom_red";
    let n = 1;

    if (Math.random() < store.skills.forageBonusChance()) {
      n += 1;
    }

    const item: Item = { forage: kind, kind: "forage" };
    const kept = n - store.inv.add(item, n);
    store.work.foraged += 1;
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
        onComplete: () => {
          spr.destroy();
        },
        targets: spr,
        y: spr.y - 6,
      });
    }

    this.objSprites.delete(o.id);
    this.world.removeObject(o);
    this.shieldClear(o.id);
    floatText(
      this,
      o.tx * TILE + 8,
      o.ty * TILE - 4,
      `+${n} ${kind === "mushroom_blue" ? "Blue" : "Red"} Mushroom`,
      "#ffd0e0",
    );
    Sound.plant();
    this.requestSave();
    picked.land({
      lost: (owner) => {
        store.work.foraged -= 1;
        this.giveBack(owner, "picked", [[item, kept]]);
      },
      won: () => {
        this.awardXP("foraging", 8);
      },
    });
  }

  private openShop() {
    this.uiOpen = true;
    this.events.emit("open-shop");
  }

  buySeed(crop: CropId, qty: number) {
    return this.buyItem({ crop, kind: "seed" }, qty, CROPS[crop].seedPrice);
  }

  buyItem(item: Item, qty: number, unitCost: number) {
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

  sellAll() {
    const total = store.inv.sellAll();

    if (total > 0) {
      store.gold += total;
      store.work.goldEarned += total;
      Sound.coins();
      this.requestSave();
    }

    return total;
  }

  private shipProduce() {
    const total = this.sellAll();

    if (total > 0) {
      const previous = this.shipping.day === this.day ? this.shipping : null;
      this.shipping = {
        day: this.day,
        shipments: (previous?.shipments ?? 0) + 1,
        shippedGold: (previous?.shippedGold ?? 0) + total,
      };
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

  closeUi() {
    this.uiOpen = false;
    this.uiClosedFrame = this.game.loop.frame;
  }

  private confirmSleep() {
    this.uiOpen = true;
    this.events.emit("confirm-sleep");
  }

  private enterMine() {
    if (store.inv.count((it) => it.kind === "tool" && it.tool === "pickaxe") === 0) {
      this.toast("You need a pickaxe to mine.", "#ffd27a");

      return;
    }

    this.transitioning = true;
    this.save();
    this.cameras.main.fadeOut(450, 0, 0, 0);
    this.cameras.main.once(Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      const { net } = this;

      if (net && this.isOnline() && net.serverClock.synced) {
        net.updateMyState(this.farmerSender.away(net.serverNow()));
      }

      this.scene.stop("Hud");
      this.scene.start("Mine", { depth: 1 });
    });
  }

  doSleep() {
    this.closeUi();

    if (!this.amHost) {
      this.toast("Only the host can end the day — ask them to sleep!", "#ffd27a");

      return;
    }

    this.endDay();
  }

  private passOut() {
    if (this.transitioning) {
      return;
    }

    this.toast("You passed out from exhaustion…", "#c8b6ff");
    this.endDay(true);
  }

  endDay(exhausted = false) {
    this.transitioning = true;

    const recap =
      this.shipping.day === this.day && this.shipping.shipments > 0 ? this.shipping : undefined;

    const cam = this.cameras.main;
    cam.fadeOut(600, 6, 10, 24);
    cam.once(Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      if (this.amHost) {
        const changed = this.runOvernight();
        const { net } = this;

        if (net && net.connectionStatus !== "offline") {
          this.farmSync.publishTiles(net, changed);
        }

        this.day += 1;
        this.shipping = { day: this.day, shipments: 0, shippedGold: 0 };
        this.timeMin = DAY_START_MIN;
        this.weather = weatherForDay(this.seed, this.day);
      }

      this.wakeUp(exhausted);

      if (this.amHost) {
        this.events.emit("daybanner", this.day, seasonOfDay(this.day), this.weather, recap);
      }

      Sound.wake();
      cam.fadeIn(700, 6, 10, 24);
      cam.once(Cameras.Scene2D.Events.FADE_IN_COMPLETE, () => {
        this.transitioning = false;
      });
    });
  }

  private runOvernight() {
    const nextDay = this.day + 1;

    const changed = this.world.growOvernight(
      seasonOfDay(nextDay),
      isWet(weatherForDay(this.seed, nextDay)),
    );

    for (const idx of changed) {
      this.redrawTile(idx);
    }

    return changed;
  }

  private wakeUp(exhausted: boolean) {
    this.canCharge = CAN_MAX;
    this.animals.runOvernight();
    this.npcs.runOvernight();
    store.rest(exhausted, this.fainted);
    this.fainted = false;
    this.save();
  }

  private updateNightTint() {
    const { color, alpha } = tintFor(this.timeMin, this.weather);
    this.nightOverlay.setFillStyle(color);
    this.nightOverlay.setAlpha(alpha);
  }

  toast(text: string, color = "#fff6d5") {
    this.events.emit("toast", text, color);
  }

  showDiscovery(discovery: CollectionDiscovery | null) {
    if (!discovery) {
      return;
    }

    this.toast(
      discovery.completedSeason
        ? `${discovery.season} journal complete!`
        : `Journal: ${discovery.name} collected.`,
      "#d8ffb0",
    );
  }

  /** Preview exactly the crop eligibility used by runOvernight. */
  overnightPreview() {
    const season = seasonOfDay(this.day + 1);
    let withering = 0;

    for (const crop of this.world.crops.values()) {
      if (!CROPS[crop.crop].seasons.includes(season)) {
        withering += 1;
      }
    }

    return { changingSeason: season !== this.season(), season, withering };
  }

  /** Mark the save dirty; update() flushes at most every SAVE_FLUSH_SEC.
   *  Transitions (enterMine/endDay) and hidden/beforeunload call save() directly. */
  requestSave() {
    this.saveDirty = true;
  }

  get savePending() {
    return this.saveDirty;
  }

  retryPendingSave(dt: number) {
    this.saveAcc += dt;

    if (this.saveDirty && this.saveAcc >= SAVE_FLUSH_SEC) {
      this.save();
    }
  }

  save() {
    if (!this.farmReady) {
      return;
    }

    this.saveAcc = 0;

    if (this.scene.isActive()) {
      this.farmPosition = { x: this.player.x, y: this.player.y };
    }

    const d: SaveData = {
      animalSeq: store.animalSeq,
      animals: store.animalSave(),
      canCharge: this.canCharge,
      collections: store.collections.toJSON(),
      day: this.day,
      energy: store.energy,
      gold: store.gold,
      hp: store.hp,
      inv: store.inv.toJSON(),
      npcFriendship: store.npcFriendship,
      player: this.farmPosition,
      seed: this.seed,
      skills: store.skills.toJSON(),
      timeMin: this.timeMin,
      v: 3,
      world: this.world.toJSON(),
    };

    const outcome = writeSave(d);
    this.saveDirty = outcome.kind === "failure";

    if (!this.scene.isActive()) {
      return;
    }

    if (outcome.kind === "failure" && !this.saveFailed) {
      this.saveFailed = true;
      this.toast("Save unavailable. Progress stays here; retrying…", "#ffd27a");
    } else if (outcome.kind === "success" && this.saveFailed) {
      this.saveFailed = false;
      this.toast("Progress saved.", "#d8ffb0");
    }
  }

  /** Read-only teaching beside the selected tool (ui/action-hints). Memoised on
   *  (target tile, selected item); every busy state drops the memo, so an
   *  action's outcome (tilled, watered, out of energy) re-reads on the next
   *  idle frame instead of every frame. */
  actionHint() {
    if (
      this.controlsPaused ||
      this.uiOpen ||
      this.transitioning ||
      this.acting ||
      this.fishing.active
    ) {
      this.hintKey.idx = -1;

      return null;
    }

    const idx = this.targetIdx();

    if (idx < 0) {
      return null;
    }

    const item = store.inv.selectedItem();

    if (idx !== this.hintKey.idx || item !== this.hintKey.item) {
      this.hintKey.idx = idx;
      this.hintKey.item = item;
      this.hint = hintFor({
        amHost: this.amHost,
        canCharge: this.canCharge,
        energy: store.energy,
        hasPickaxe: store.inv.count((it) => it.kind === "tool" && it.tool === "pickaxe") > 0,
        item,
        season: this.season(),
        tx: idx % MAP_W,
        ty: Math.trunc(idx / MAP_W),
        world: this.world,
      });
    }

    return this.hint;
  }
  season() {
    return seasonOfDay(this.day);
  }
  actionHeld() {
    if (this.controlsPaused) {
      return false;
    }

    return (
      this.keys.SPACE.isDown ||
      this.keys.E.isDown ||
      this.input.activePointer.isDown ||
      this.pad.isButtonDown("a")
    );
  }
  playerAnim(key: string) {
    this.player.play(key, true);
  }
}
