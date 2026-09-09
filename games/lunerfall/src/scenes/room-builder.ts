import type Phaser from "phaser";
import type { Scene } from "phaser";

import { BASE_H, BASE_W, COLORS, TILE } from "../config";
import type { EnemyName } from "../data/animations";
import { rollAffix } from "../data/affixes";
import type { Affix } from "../data/affixes";
import { biomePalette, enemyPool } from "../data/biomes";
import type { BiomePalette } from "../data/biomes";
import { ENEMIES } from "../data/enemies";
import { pickRelics, RARITY_COLOR } from "../data/relics";
import type { Relic } from "../data/relics";
import { parseRoomType, ROOM_LABEL, VERSUS } from "../data/rooms";
import type { RoomDef, RoomType } from "../data/rooms";
import { Boss } from "../entities/boss";
import { Door } from "../entities/door";
import { Enemy } from "../entities/enemy";
import type { NetRoom } from "../net/snapshot";
import { buildParallax } from "../parallax";
import { PixelSky } from "../render/pixel-sky";
import { drawRoom } from "../room";
import type { RoomState } from "../state/room-state";
import type { RunState } from "../state/run-state";
import type { SeatState } from "../state/seat-state";
import { ambientEmbers, clearFx } from "../sys/fx";
import { Grid } from "../sys/grid";
import { rand } from "../sys/rng";
import { gameInset } from "../sys/screen";
import { VS_BIOME } from "../sys/versus";
import type { RunManager } from "../sys/run";
import type { BannerHud } from "./banner-hud";
import type { RoomProgress } from "./room-progress";

const FEATURE_COLORS = new Map<RoomType, number>([
  ["rest", COLORS.teal],
  ["treasure", 0xff_d1_5c],
]);

// Themed animated prop per non-combat room type. ox/oy = frame-fractional origin
// aligning the art's bottom-centre to the floor; scale shrinks the 144px canvases.
export const ROOM_PROPS = new Map<RoomType, { key: string; ox: number; oy: number; scale: number }>(
  [
    ["start", { key: "blue-flag", ox: 0.5, oy: 0.66, scale: 0.7 }],
    ["rest", { key: "blue-fountain", ox: 0.49, oy: 0.77, scale: 0.5 }],
    ["merchant", { key: "blue-campfire", ox: 0.52, oy: 0.73, scale: 1.2 }],
    ["treasure", { key: "blue-columnfire", ox: 0.5, oy: 0.66, scale: 0.75 }],
  ],
);

// Elite room: roll an affix onto an enemy — recolour it and bend its combat
// multipliers (host-authoritative; guests render the puppet without the tint).
// The affix parameter is only supplied by trailer staging; gameplay rolls.
export const applyAffix = (e: Enemy, a: Affix = rollAffix()) => {
  e.body.hp = Math.round(e.body.hp * a.hpMult) + 1;
  e.body.speedMult = a.speedMult;
  e.body.dmgTakenMult = a.dmgTakenMult;
  e.body.dmgOutMult = a.dmgOutMult;
  e.baseTint = a.tint;
  e.sprite.setTint(a.tint);
};

// Builds and tears down one room's world: tiles, parallax, props, enemies,
// boss, doors, features and merchant stock — from a RoomDef (host/solo) or
// the host's wire broadcast (guest).
export class RoomBuilder {
  private readonly scene: Scene;
  private readonly run: RunState;
  private readonly expedition: RunManager;
  private readonly room: RoomState;
  private readonly seat: SeatState;
  private readonly banners: BannerHud;
  private readonly progress: RoomProgress;
  private layer?: Phaser.GameObjects.Container;
  parallax: Phaser.GameObjects.GameObject[] = [];
  private prop?: Phaser.GameObjects.Sprite;
  private embers?: Phaser.GameObjects.Particles.ParticleEmitter;

  constructor(
    scene: Scene,
    run: RunState,
    expedition: RunManager,
    room: RoomState,
    seat: SeatState,
    banners: BannerHud,
    progress: RoomProgress,
  ) {
    this.scene = scene;
    this.run = run;
    this.expedition = expedition;
    this.room = room;
    this.seat = seat;
    this.banners = banners;
    this.progress = progress;
  }

  // The screen-pinned sky and the thin full-field atmosphere wash — over the
  // world but under the HUD, the cheapest way to make a biome's light read on
  // every tile and silhouette. Repainted per biome by applyBiome.
  mount() {
    this.room.sky = new PixelSky(this.scene, BASE_W, BASE_H);
    this.room.fogRect = this.scene.add
      .rectangle(0, 0, BASE_W, BASE_H, 0x00_00_00, 0)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(60);
  }

  // Tear down every per-room object (host sim entities + guest puppets alike).
  teardown() {
    this.banners.clear();
    this.room.bossAnnounced = false;
    clearFx(this.scene);
    this.room.guest.payoff = null;
    this.room.guest.cueBaseline = true;
    this.room.guest.progressTick = -1;
    this.room.guest.special = { kind: "unknown" };
    this.room.guest.players = [];
    this.layer?.destroy();
    for (const o of this.parallax) {
      o.destroy();
    }
    this.parallax = [];
    this.prop?.destroy();
    this.prop = undefined;
    this.embers?.destroy();
    this.embers = undefined;
    for (const d of this.room.doors) {
      d.destroy();
    }
    for (const e of this.room.enemies) {
      e.destroy();
    }
    for (const a of this.room.arrows) {
      a.spr.destroy();
    }
    for (const s of this.room.shots) {
      s.spr.destroy();
    }
    for (const h of this.room.hazards) {
      h.spr.destroy();
    }
    for (const m of this.room.merchantItems) {
      m.g.destroy();
    }
    this.room.merchantItems = [];
    this.room.boss?.destroy();
    this.room.bossHp?.destroy();
    this.room.bossHpBg?.destroy();
    this.room.feature?.g.destroy();
    this.room.doors = [];
    this.room.enemies = [];
    this.room.arrows = [];
    this.room.shots = [];
    this.room.hazards = [];
    this.room.boss = null;
    this.room.bossHp = undefined;
    this.room.bossHpBg = undefined;
    this.run.bossDeadT = 0;
    this.room.feature = null;
    this.room.deadTimers = new WeakMap();
    this.seat.combatStates = new WeakMap();
    for (const p of this.room.guest.enemyPuppets.values()) {
      p.view.destroy();
    }
    this.room.guest.enemyPuppets.clear();
    this.room.guest.bossPuppet?.view.destroy();
    this.room.guest.bossPuppet = undefined;
    for (const s of this.room.guest.proj) {
      s.destroy();
    }
    this.room.guest.proj = [];
  }

  // Bind the camera to the current room's pixel extent and follow the local
  // player, so bigger-than-screen rooms scroll. Called after every room (re)build.
  setupCamera() {
    const cam = this.scene.cameras.main;
    cam.setBounds(0, 0, this.room.grid.cols * TILE, this.room.grid.rows * TILE);
    cam.startFollow(this.seat.player.sprite, true, 0.22, 0.24);
    cam.setDeadzone(36, 28);
  }

  // Repaint the screen-pinned sky + atmosphere wash for a biome and return its
  // palette for the room/parallax build. Called on every room build, so
  // descending into a new biome recolours the whole world.
  applyBiome(biome: number): BiomePalette {
    const pal = biomePalette(biome);
    this.room.sky?.setPalette(pal);
    this.room.fogRect?.setFillStyle(pal.fog, pal.fogA);
    return pal;
  }

  build(def: RoomDef) {
    this.teardown();
    this.room.grid = def.grid;
    const pal = this.applyBiome(this.expedition.biome);
    const enteredBiome =
      this.run.flashedBiome !== 0 && this.expedition.biome !== this.run.flashedBiome;
    this.run.flashedBiome = this.expedition.biome;
    this.parallax = buildParallax(this.scene, def.grid.cols * TILE, def.grid.rows * TILE, pal);
    this.layer = drawRoom(this.scene, def.grid, pal).setDepth(0);
    this.decorate(def);
    this.embers = ambientEmbers(this.scene, pal.oneway, def.grid.cols * TILE, def.grid.rows * TILE);
    this.seat.player.enterRoom(def.grid, def.playerSpawn.x, def.playerSpawn.y);
    this.seat.remote?.enterRoom(def.grid, def.playerSpawn.x, def.playerSpawn.y);
    this.room.roomSpawn = { x: def.playerSpawn.x, y: def.playerSpawn.y };
    this.setupCamera();

    this.run.mustClear = this.expedition.isCombat();
    this.run.cleared = !this.run.mustClear;

    if (this.expedition.type === "boss") {
      this.spawnBoss(def);
    } else if (this.run.mustClear) {
      this.spawnEnemies(def);
    } else if (this.expedition.type === "merchant") {
      this.buildMerchant();
    } else if (def.featureSpot) {
      this.buildFeature(def.featureSpot.x, def.featureSpot.y);
    }

    this.run.offers = this.expedition.offers();
    for (const [i, slot] of def.doorSlots.entries()) {
      const offer = this.run.offers[i];
      if (!offer) {
        continue;
      }
      const d = new Door(this.scene, slot.x, slot.y, offer.type, i);
      d.setActive(this.run.cleared);
      this.room.doors.push(d);
    }

    this.room.seq += 1;
    if (this.seat.role === "host") {
      this.room.dirty = true;
    }
    // Boss rooms announce the boss by name in spawnBoss; don't overwrite it here.
    // Descending into a new biome announces the biome instead of the room label.
    if (this.expedition.type !== "boss") {
      if (enteredBiome) {
        this.banners.show(`▼  ${pal.name}  ▼`, 1600, "status");
      } else {
        this.banners.show(
          this.run.mustClear
            ? ROOM_LABEL[this.expedition.type]
            : `${ROOM_LABEL[this.expedition.type]} — pick a path`,
          1100,
          "status",
        );
      }
    }
  }

  // Versus (host): build the mirrored duel arena — no doors, enemies, features,
  // or run progression; both spawn points are kept for the per-round resets.
  buildVersus() {
    this.teardown();
    const def = VERSUS();
    this.room.grid = def.grid;
    const pal = this.applyBiome(VS_BIOME);
    this.parallax = buildParallax(this.scene, def.grid.cols * TILE, def.grid.rows * TILE, pal);
    this.layer = drawRoom(this.scene, def.grid, pal).setDepth(0);
    this.embers = ambientEmbers(
      this.scene,
      COLORS.magenta,
      def.grid.cols * TILE,
      def.grid.rows * TILE,
    );
    const mirror = { x: def.grid.cols * TILE - def.playerSpawn.x, y: def.playerSpawn.y };
    this.room.vsSpawns = [def.playerSpawn, mirror];
    this.room.roomSpawn = def.playerSpawn;
    this.seat.player.enterRoom(def.grid, def.playerSpawn.x, def.playerSpawn.y);
    this.seat.remote?.enterRoom(def.grid, mirror.x, mirror.y);
    this.setupCamera();
    this.run.mustClear = false;
    this.run.cleared = true;
    this.room.seq += 1;
    if (this.seat.role === "host") {
      this.room.dirty = true;
    }
    this.banners.show("VERSUS — WAITING FOR A CHALLENGER", 2600, "critical");
  }

  // Weighted-random enemy type, rolled per spawn so encounters vary run to run
  // (was a fixed roster → identical fights). Warriors dominate early; ranged and
  // heavy types get commoner in deeper biomes and elite rooms. Host-authoritative:
  // guests replicate whatever the host rolled via the enemy name on the wire.
  private pickEnemy(): EnemyName {
    const pool = enemyPool(this.expedition.biome, this.expedition.type === "elite");
    const total = pool.reduce((s, p) => s + p[1], 0);
    let r = rand() * total;
    for (const [name, w] of pool) {
      r -= w;
      if (r <= 0) {
        return name;
      }
    }
    return "warrior";
  }

  private spawnEnemies(def: RoomDef) {
    const elite = this.expedition.type === "elite";
    for (const s of def.enemySpawns) {
      const e = new Enemy(this.scene, this.room.grid, ENEMIES[this.pickEnemy()], s.x, s.y);
      e.body.hp += Math.floor((this.expedition.biome - 1) / 2);
      if (elite) {
        applyAffix(e);
      }
      this.room.enemies.push(e);
    }
  }

  private spawnBoss(def: RoomDef) {
    const bx = def.bossSpawn?.x ?? BASE_W / 2;
    const by = def.bossSpawn?.y ?? (this.room.grid.rows - 3) * TILE;
    this.room.boss = this.bossView(bx, by, this.expedition.biome);
    this.run.bossDeadT = 0;
    this.progress.announceBoss(this.expedition.biome);
  }

  // The boss actor plus its screen-pinned HP bar — for a fresh spawn, a guest
  // puppet, or a checkpoint restore alike.
  bossView(x: number, y: number, biome: number): Boss {
    const boss = new Boss(this.scene, this.room.grid, x, y, biome);
    const barCol = biomePalette(biome).oneway;
    this.room.bossHpBg = this.scene.add
      .rectangle(BASE_W / 2, 47 + gameInset(this.scene).top, 260, 6, 0x00_00_00, 0.5)
      .setStrokeStyle(1, barCol, 0.6)
      .setScrollFactor(0)
      .setDepth(85);
    this.room.bossHp = this.scene.add
      .rectangle(BASE_W / 2 - 129, 47 + gameInset(this.scene).top, 258, 4, barCol)
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(86);
    return boss;
  }

  buildFeature(x: number, y: number) {
    const { type } = this.expedition;
    const color = FEATURE_COLORS.get(type) ?? COLORS.magenta;
    const g = this.scene.add.container(x, y).setDepth(8);
    const glow = this.scene.add.ellipse(0, -10, 26, 30, color, 0.2);
    const base = this.scene.add.rectangle(0, 0, 16, 6, COLORS.stoneEdge).setOrigin(0.5, 1);
    const orb = this.scene.add.circle(0, -14, 5, color, 0.95);
    const tag = this.scene.add
      .text(0, -26, ROOM_LABEL[type], {
        color: "#f4f7fb",
        fontFamily: "monospace",
        fontSize: "7px",
      })
      .setOrigin(0.5, 1);
    g.add([glow, base, orb, tag]);
    this.scene.tweens.add({
      duration: 900,
      ease: "Sine.easeInOut",
      repeat: -1,
      targets: orb,
      y: -17,
      yoyo: true,
    });
    this.scene.tweens.add({
      alpha: 0.32,
      duration: 900,
      ease: "Sine.easeInOut",
      repeat: -1,
      scale: 1.2,
      targets: glow,
      yoyo: true,
    });
    this.room.feature = { g, used: false, x, y };
  }

  // A themed animated prop dresses each non-combat room (fountain / campfire /
  // column fire / flag), placed to the side on the floor, behind the entities.
  private decorate(def: RoomDef) {
    const cfg = ROOM_PROPS.get(this.expedition.type);
    if (!cfg) {
      return;
    }
    this.prop = this.scene.add
      .sprite(BASE_W * 0.17, def.playerSpawn.y, `prop:${cfg.key}`)
      .setOrigin(cfg.ox, cfg.oy)
      .setScale(cfg.scale)
      .setDepth(2);
    this.prop.play(`prop:${cfg.key}`);
  }

  private buildMerchant() {
    const offers = pickRelics(3, this.run.ownedRelics);
    const y = (this.room.grid.rows - 3 + 1) * TILE;
    for (const [i, relic] of offers.entries()) {
      this.buildMerchantItem(relic, (0.3 + i * 0.2) * BASE_W, y, false);
    }
  }

  /** Display construction only: replaying a checkpoint never rolls an offer. */
  buildMerchantItem(relic: Relic, x: number, y: number, bought: boolean) {
    const col = RARITY_COLOR[relic.rarity];
    const hex = `#${col.toString(16).padStart(6, "0")}`;
    const g = this.scene.add.container(x, y).setDepth(8);
    const glow = this.scene.add.ellipse(0, -12, 24, 30, col, 0.2);
    const base = this.scene.add.rectangle(0, 0, 16, 6, COLORS.stoneEdge).setOrigin(0.5, 1);
    const orb = this.scene.add.circle(0, -16, 5, col, 0.95);
    const name = this.scene.add
      .text(0, -40, relic.name, { color: hex, fontFamily: "monospace", fontSize: "7px" })
      .setOrigin(0.5);
    const desc = this.scene.add
      .text(0, -32, relic.desc, { color: "#8b95a1", fontFamily: "monospace", fontSize: "6px" })
      .setOrigin(0.5);
    const price = this.scene.add
      .text(0, -25, `⬡ ${relic.price}`, {
        color: "#ffd15c",
        fontFamily: "monospace",
        fontSize: "7px",
      })
      .setOrigin(0.5);
    g.add([glow, base, orb, name, desc, price]);
    this.scene.tweens.add({
      duration: 900,
      ease: "Sine.easeInOut",
      repeat: -1,
      targets: orb,
      y: -19,
      yoyo: true,
    });
    g.setVisible(!bought);
    this.room.merchantItems.push({ bought, g, relic, x, y });
  }

  // Guest: rebuild the room view from the host's broadcast (no RunManager).
  buildFromNet(room: NetRoom, biome: number) {
    this.teardown();
    const g = new Grid(room.cols, room.rows);
    g.cells.set(room.cells);
    this.room.grid = g;
    const vs = room.mode === "vs";
    // the host's room broadcast is authoritative
    if (vs) {
      this.seat.mode = "versus";
    }
    const pal = this.applyBiome(vs ? VS_BIOME : biome);
    this.parallax = buildParallax(this.scene, g.cols * TILE, g.rows * TILE, pal);
    this.layer = drawRoom(this.scene, g, pal).setDepth(0);
    const type = parseRoomType(room.type) ?? "combat";
    if (room.propKey) {
      this.placeProp(type, room.propKey, room.spawnY);
    }
    this.embers = ambientEmbers(this.scene, pal.oneway, g.cols * TILE, g.rows * TILE);
    this.room.roomSpawn = { x: room.spawnX, y: room.spawnY };
    // Versus: the guest duels from the mirrored right-hand spawn.
    const ownRight = vs && this.seat.seats.guest === this.seat.session?.playerId;
    this.seat.player.enterRoom(
      g,
      ownRight ? g.cols * TILE - room.spawnX : room.spawnX,
      room.spawnY,
    );
    this.seat.remote?.enterRoom(
      g,
      vs && !ownRight ? g.cols * TILE - room.spawnX : room.spawnX,
      room.spawnY,
    );
    this.setupCamera();
    for (const nd of room.doors) {
      const d = new Door(this.scene, nd.x, nd.y, parseRoomType(nd.type) ?? "combat", nd.index);
      d.setActive(false);
      this.room.doors.push(d);
    }
    this.run.mustClear = room.mustClear;
    this.run.cleared = !room.mustClear;
    this.room.seq = room.seq;
    // fresh room, fresh trajectory
    this.room.guest.reconciler.reset();
    this.room.guest.selfHurting = false;
    this.banners.show(vs ? "VERSUS" : ROOM_LABEL[type], 1000, vs ? "critical" : "status");
  }

  private placeProp(type: RoomType, propKey: string, floorY: number) {
    const cfg = ROOM_PROPS.get(type);
    this.prop = this.scene.add
      .sprite(BASE_W * 0.17, floorY, `prop:${propKey}`)
      .setOrigin(cfg?.ox ?? 0.5, cfg?.oy ?? 0.7)
      .setScale(cfg?.scale ?? 0.7)
      .setDepth(2);
    this.prop.play(`prop:${propKey}`);
  }
}
