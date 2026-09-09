import type Phaser from "phaser";
import type { Scene } from "phaser";

import { BASE_W, COLORS, TILE } from "../config";
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
import { drawRoom } from "../room";
import { ambientEmbers, clearFx } from "../sys/fx";
import { Grid } from "../sys/grid";
import { rand } from "../sys/rng";
import { gameInset } from "../sys/screen";
import { VS_BIOME } from "../sys/versus";
import type { GameScene } from "./game-scene";

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

type RoomCtx = Scene &
  Pick<
    GameScene,
    | "arrows"
    | "banners"
    | "boss"
    | "bossDeadT"
    | "bossHp"
    | "bossHpBg"
    | "cleared"
    | "combatStates"
    | "deadTimers"
    | "doors"
    | "enemies"
    | "feature"
    | "fogRect"
    | "grid"
    | "guest"
    | "hazards"
    | "hostNet"
    | "merchantItems"
    | "mode"
    | "mustClear"
    | "offers"
    | "ownedRelics"
    | "player"
    | "progress"
    | "remote"
    | "role"
    | "roomSpawn"
    | "run"
    | "seats"
    | "session"
    | "shots"
    | "sky"
    | "versus"
  >;

// Builds and tears down one room's world: tiles, parallax, props, enemies,
// boss, doors, features and merchant stock — from a RoomDef (host/solo) or
// the host's wire broadcast (guest).
export class RoomBuilder {
  private readonly scene: RoomCtx;
  private layer?: Phaser.GameObjects.Container;
  parallax: Phaser.GameObjects.GameObject[] = [];
  private prop?: Phaser.GameObjects.Sprite;
  private embers?: Phaser.GameObjects.Particles.ParticleEmitter;
  // last biome we announced, so a descent flashes the new name
  flashedBiome = 0;

  constructor(scene: RoomCtx) {
    this.scene = scene;
  }

  // Tear down every per-room object (host sim entities + guest puppets alike).
  teardown() {
    this.scene.banners.clear();
    this.scene.progress.bossAnnounced = false;
    clearFx(this.scene);
    this.scene.guest.payoff = null;
    this.scene.guest.cueBaseline = true;
    this.scene.guest.progressTick = -1;
    this.scene.guest.special = { kind: "unknown" };
    this.scene.guest.players = [];
    this.layer?.destroy();
    for (const o of this.parallax) {
      o.destroy();
    }
    this.parallax = [];
    this.prop?.destroy();
    this.prop = undefined;
    this.embers?.destroy();
    this.embers = undefined;
    for (const d of this.scene.doors) {
      d.destroy();
    }
    for (const e of this.scene.enemies) {
      e.destroy();
    }
    for (const a of this.scene.arrows) {
      a.spr.destroy();
    }
    for (const s of this.scene.shots) {
      s.spr.destroy();
    }
    for (const h of this.scene.hazards) {
      h.spr.destroy();
    }
    for (const m of this.scene.merchantItems) {
      m.g.destroy();
    }
    this.scene.merchantItems = [];
    this.scene.boss?.destroy();
    this.scene.bossHp?.destroy();
    this.scene.bossHpBg?.destroy();
    this.scene.feature?.g.destroy();
    this.scene.doors = [];
    this.scene.enemies = [];
    this.scene.arrows = [];
    this.scene.shots = [];
    this.scene.hazards = [];
    this.scene.boss = null;
    this.scene.bossHp = undefined;
    this.scene.bossHpBg = undefined;
    this.scene.bossDeadT = 0;
    this.scene.feature = null;
    this.scene.deadTimers = new WeakMap();
    this.scene.combatStates = new WeakMap();
    for (const p of this.scene.guest.enemyPuppets.values()) {
      p.view.destroy();
    }
    this.scene.guest.enemyPuppets.clear();
    this.scene.guest.bossPuppet?.view.destroy();
    this.scene.guest.bossPuppet = undefined;
    for (const s of this.scene.guest.proj) {
      s.destroy();
    }
    this.scene.guest.proj = [];
  }

  // Bind the camera to the current room's pixel extent and follow the local
  // player, so bigger-than-screen rooms scroll. Called after every room (re)build.
  setupCamera() {
    const cam = this.scene.cameras.main;
    cam.setBounds(0, 0, this.scene.grid.cols * TILE, this.scene.grid.rows * TILE);
    cam.startFollow(this.scene.player.sprite, true, 0.22, 0.24);
    cam.setDeadzone(36, 28);
  }

  // Repaint the screen-pinned sky + atmosphere wash for a biome and return its
  // palette for the room/parallax build. Called on every room build, so
  // descending into a new biome recolours the whole world.
  applyBiome(biome: number): BiomePalette {
    const pal = biomePalette(biome);
    this.scene.sky?.setPalette(pal);
    this.scene.fogRect?.setFillStyle(pal.fog, pal.fogA);
    return pal;
  }

  build(def: RoomDef) {
    this.teardown();
    this.scene.grid = def.grid;
    const pal = this.applyBiome(this.scene.run.biome);
    const enteredBiome = this.flashedBiome !== 0 && this.scene.run.biome !== this.flashedBiome;
    this.flashedBiome = this.scene.run.biome;
    this.parallax = buildParallax(this.scene, def.grid.cols * TILE, def.grid.rows * TILE, pal);
    this.layer = drawRoom(this.scene, def.grid, pal).setDepth(0);
    this.decorate(def);
    this.embers = ambientEmbers(this.scene, pal.oneway, def.grid.cols * TILE, def.grid.rows * TILE);
    this.scene.player.enterRoom(def.grid, def.playerSpawn.x, def.playerSpawn.y);
    this.scene.remote?.enterRoom(def.grid, def.playerSpawn.x, def.playerSpawn.y);
    this.scene.roomSpawn = { x: def.playerSpawn.x, y: def.playerSpawn.y };
    this.setupCamera();

    this.scene.mustClear = this.scene.run.isCombat();
    this.scene.cleared = !this.scene.mustClear;

    if (this.scene.run.type === "boss") {
      this.spawnBoss(def);
    } else if (this.scene.mustClear) {
      this.spawnEnemies(def);
    } else if (this.scene.run.type === "merchant") {
      this.buildMerchant();
    } else if (def.featureSpot) {
      this.buildFeature(def.featureSpot.x, def.featureSpot.y);
    }

    this.scene.offers = this.scene.run.offers();
    for (const [i, slot] of def.doorSlots.entries()) {
      const offer = this.scene.offers[i];
      if (!offer) {
        continue;
      }
      const d = new Door(this.scene, slot.x, slot.y, offer.type, i);
      d.setActive(this.scene.cleared);
      this.scene.doors.push(d);
    }

    this.scene.hostNet.roomSeq += 1;
    if (this.scene.role === "host") {
      this.scene.hostNet.roomDirty = true;
    }
    // Boss rooms announce the boss by name in spawnBoss; don't overwrite it here.
    // Descending into a new biome announces the biome instead of the room label.
    if (this.scene.run.type !== "boss") {
      if (enteredBiome) {
        this.scene.banners.show(`▼  ${pal.name}  ▼`, 1600, "status");
      } else {
        this.scene.banners.show(
          this.scene.mustClear
            ? ROOM_LABEL[this.scene.run.type]
            : `${ROOM_LABEL[this.scene.run.type]} — pick a path`,
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
    this.scene.grid = def.grid;
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
    this.scene.versus.spawns = [def.playerSpawn, mirror];
    this.scene.roomSpawn = def.playerSpawn;
    this.scene.player.enterRoom(def.grid, def.playerSpawn.x, def.playerSpawn.y);
    this.scene.remote?.enterRoom(def.grid, mirror.x, mirror.y);
    this.setupCamera();
    this.scene.mustClear = false;
    this.scene.cleared = true;
    this.scene.hostNet.roomSeq += 1;
    if (this.scene.role === "host") {
      this.scene.hostNet.roomDirty = true;
    }
    this.scene.banners.show("VERSUS — WAITING FOR A CHALLENGER", 2600, "critical");
  }

  // Weighted-random enemy type, rolled per spawn so encounters vary run to run
  // (was a fixed roster → identical fights). Warriors dominate early; ranged and
  // heavy types get commoner in deeper biomes and elite rooms. Host-authoritative:
  // guests replicate whatever the host rolled via the enemy name on the wire.
  private pickEnemy(): EnemyName {
    const pool = enemyPool(this.scene.run.biome, this.scene.run.type === "elite");
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
    const elite = this.scene.run.type === "elite";
    for (const s of def.enemySpawns) {
      const e = new Enemy(this.scene, this.scene.grid, ENEMIES[this.pickEnemy()], s.x, s.y);
      e.body.hp += Math.floor((this.scene.run.biome - 1) / 2);
      if (elite) {
        applyAffix(e);
      }
      this.scene.enemies.push(e);
    }
  }

  private spawnBoss(def: RoomDef) {
    const bx = def.bossSpawn?.x ?? BASE_W / 2;
    const by = def.bossSpawn?.y ?? (this.scene.grid.rows - 3) * TILE;
    this.scene.boss = new Boss(this.scene, this.scene.grid, bx, by, this.scene.run.biome);
    this.scene.bossDeadT = 0;
    const barCol = biomePalette(this.scene.run.biome).oneway;
    this.scene.bossHpBg = this.scene.add
      .rectangle(BASE_W / 2, 47 + gameInset(this.scene).top, 260, 6, 0x00_00_00, 0.5)
      .setStrokeStyle(1, barCol, 0.6)
      .setScrollFactor(0)
      .setDepth(85);
    this.scene.bossHp = this.scene.add
      .rectangle(BASE_W / 2 - 129, 47 + gameInset(this.scene).top, 258, 4, barCol)
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(86);
    this.scene.progress.announceBoss(this.scene.run.biome);
  }

  buildFeature(x: number, y: number) {
    const { type } = this.scene.run;
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
    this.scene.feature = { g, used: false, x, y };
  }

  // A themed animated prop dresses each non-combat room (fountain / campfire /
  // column fire / flag), placed to the side on the floor, behind the entities.
  private decorate(def: RoomDef) {
    const cfg = ROOM_PROPS.get(this.scene.run.type);
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
    const offers = pickRelics(3, this.scene.ownedRelics);
    const y = (this.scene.grid.rows - 3 + 1) * TILE;
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
    this.scene.merchantItems.push({ bought, g, relic, x, y });
  }

  // Guest: rebuild the room view from the host's broadcast (no RunManager).
  buildFromNet(room: NetRoom) {
    this.teardown();
    const g = new Grid(room.cols, room.rows);
    g.cells.set(room.cells);
    this.scene.grid = g;
    const vs = room.mode === "vs";
    // the host's room broadcast is authoritative
    if (vs) {
      this.scene.mode = "versus";
    }
    const pal = this.applyBiome(vs ? VS_BIOME : this.scene.guest.biome);
    this.parallax = buildParallax(this.scene, g.cols * TILE, g.rows * TILE, pal);
    this.layer = drawRoom(this.scene, g, pal).setDepth(0);
    const type = parseRoomType(room.type) ?? "combat";
    this.scene.guest.roomType = type;
    if (room.propKey) {
      this.placeProp(type, room.propKey, room.spawnY);
    }
    this.embers = ambientEmbers(this.scene, pal.oneway, g.cols * TILE, g.rows * TILE);
    this.scene.roomSpawn = { x: room.spawnX, y: room.spawnY };
    // Versus: the guest duels from the mirrored right-hand spawn.
    const ownRight = vs && this.scene.seats.guest === this.scene.session?.playerId;
    this.scene.player.enterRoom(
      g,
      ownRight ? g.cols * TILE - room.spawnX : room.spawnX,
      room.spawnY,
    );
    this.scene.remote?.enterRoom(
      g,
      vs && !ownRight ? g.cols * TILE - room.spawnX : room.spawnX,
      room.spawnY,
    );
    this.setupCamera();
    for (const nd of room.doors) {
      const d = new Door(this.scene, nd.x, nd.y, parseRoomType(nd.type) ?? "combat", nd.index);
      d.setActive(false);
      this.scene.doors.push(d);
    }
    this.scene.mustClear = room.mustClear;
    this.scene.cleared = !room.mustClear;
    this.scene.guest.roomSeq = room.seq;
    // fresh room, fresh trajectory
    this.scene.guest.reconciler.reset();
    this.scene.guest.selfHurting = false;
    this.scene.banners.show(vs ? "VERSUS" : ROOM_LABEL[type], 1000, vs ? "critical" : "status");
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
