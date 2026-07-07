import Phaser from "phaser";

import { sfx } from "../audio/sfx";
import { BASE_H, BASE_W, COLORS, TILE } from "../config";
import { type EnemyName, ENEMY_NAMES, HERO_NAMES, type HeroName } from "../data/animations";
import { ENEMIES } from "../data/enemies";
import { type HeroDef, HEROES } from "../data/heroes";
import { bankRun, loadMeta } from "../data/meta";
import { baseMods, pickRelics, type Relic, type RunMods } from "../data/relics";
import { parseRoomType, type RoomDef, ROOM_LABEL, type RoomType } from "../data/rooms";
import { Boss } from "../entities/boss";
import { Door } from "../entities/door";
import { Enemy } from "../entities/enemy";
import { Player } from "../entities/player";
import { rectsOverlap } from "../entities/player-body";
import { NetSession } from "../net/session";
import {
  isRoom,
  isSnapshot,
  type NetBoss,
  type NetDoor,
  type NetEnemy,
  type NetInput,
  type NetPlayer,
  type NetProj,
  type NetRoom,
  type Snapshot,
} from "../net/snapshot";
import { buildParallax } from "../parallax";
import { drawRoom } from "../room";
import { ambientEmbers, dust, explosion, hitSpark, impactRing, popText, wallSmoke } from "../sys/fx";
import { Grid } from "../sys/grid";
import { type Offer, RunManager } from "../sys/run";
import { Input, type InputState } from "../sys/input";

const STEP = 1 / 60;
const MAX_STEPS = 5;
const MAX_HEARTS = 4;
const DEATH_LINGER = 0.55;
const ARROW_GRAV = 150;

type Arrow = {
  spr: Phaser.GameObjects.Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  dmg: number;
};
type Shot = {
  spr: Phaser.GameObjects.Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  dmg: number;
  hit: Set<Enemy>;
  hitBoss: boolean;
};
type Hazard = {
  spr: Phaser.GameObjects.Sprite;
  x: number;
  y: number;
  vx: number;
  life: number;
  dmg: number;
  hitPlayer: boolean;
};
type Feature = { x: number; y: number; used: boolean; g: Phaser.GameObjects.Container };
type MerchantItem = {
  x: number;
  y: number;
  relic: Relic;
  bought: boolean;
  g: Phaser.GameObjects.Container;
};

// Per-player melee/special hit-dedup so one swing hits each enemy once.
type CombatState = {
  hitSwing: Set<Enemy>;
  lastSwing: number;
  hitSpecial: Set<Enemy>;
  lastSpecial: number;
  bossSwing: number;
  bossSpecial: number;
};
const newCombatState = (): CombatState => ({
  hitSwing: new Set(),
  lastSwing: -1,
  hitSpecial: new Set(),
  lastSpecial: -1,
  bossSwing: -1,
  bossSpecial: -1,
});

const NET_HZ = 30; // host snapshot broadcast rate
const NEUTRAL_INPUT: InputState = {
  left: false,
  right: false,
  up: false,
  down: false,
  jumpHeld: false,
  jumpPressed: false,
  dashPressed: false,
  attackPressed: false,
  specialPressed: false,
};

// Boundary parsers — validate untyped wire values into our types without casts.
const num = (v: unknown): v is number => typeof v === "number";
const bool = (v: unknown): v is boolean => typeof v === "boolean";
function readNetInput(v: unknown): NetInput | null {
  if (typeof v !== "object" || v === null) return null;
  const o: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) o[k] = val;
  if (!bool(o.left) || !bool(o.right) || !bool(o.up) || !bool(o.down) || !bool(o.jumpHeld))
    return null;
  if (!num(o.j) || !num(o.d) || !num(o.a) || !num(o.s)) return null;
  return {
    left: o.left,
    right: o.right,
    up: o.up,
    down: o.down,
    jumpHeld: o.jumpHeld,
    j: o.j,
    d: o.d,
    a: o.a,
    s: o.s,
  };
}
const parseHero = (v: unknown): HeroName | null =>
  typeof v === "string" ? (HERO_NAMES.find((h) => h === v) ?? null) : null;
const parseEnemy = (v: string): EnemyName => ENEMY_NAMES.find((e) => e === v) ?? "warrior";
const readRoom = (shared: Record<string, unknown> | null): NetRoom | null => {
  const r = shared?.room;
  return isRoom(r) ? r : null;
};
const readSnapshot = (shared: Record<string, unknown> | null): Snapshot | null => {
  const s = shared?.snap;
  return isSnapshot(s) ? s : null;
};

// Themed animated prop per non-combat room type. ox/oy = frame-fractional origin
// aligning the art's bottom-centre to the floor; scale shrinks the 144px canvases.
const ROOM_PROPS: Partial<
  Record<RoomType, { key: string; ox: number; oy: number; scale: number }>
> = {
  start: { key: "blue-flag", ox: 0.5, oy: 0.66, scale: 0.7 },
  rest: { key: "blue-fountain", ox: 0.49, oy: 0.77, scale: 0.5 },
  merchant: { key: "blue-campfire", ox: 0.52, oy: 0.73, scale: 1.2 },
  treasure: { key: "blue-columnfire", ox: 0.5, oy: 0.66, scale: 0.75 },
};
type SceneState = "active" | "dead" | "transition" | "connecting";

// Phase 5: run-driven scene. RunManager stitches typed rooms; the scene builds
// each room (tiles, enemies, doors, features), resolves combat, and transitions
// through torii doors on the player's chosen path.
export class GameScene extends Phaser.Scene {
  private run = new RunManager();
  private grid!: Grid;
  private player!: Player;
  private controls!: Input;
  private acc = 0;

  private roomLayer?: Phaser.GameObjects.Container;
  private parallax: Phaser.GameObjects.GameObject[] = [];
  private roomProp?: Phaser.GameObjects.Sprite;
  private embers?: Phaser.GameObjects.Particles.ParticleEmitter;
  private doors: Door[] = [];
  private offers: Offer[] = [];
  private feature: Feature | null = null;
  private enemies: Enemy[] = [];
  private arrows: Arrow[] = [];
  private shots: Shot[] = [];
  private hazards: Hazard[] = [];
  private boss: Boss | null = null;
  private bossHp?: Phaser.GameObjects.Rectangle;
  private bossHpBg?: Phaser.GameObjects.Rectangle;
  private bossDeadT = 0;
  private heroName: HeroName = "axion";

  // Co-op: the local player is always `this.player`; `this.remote` is the other
  // player when connected. Combat runs per-player with its own hit-dedup state.
  private remote?: Player;
  private combat = new WeakMap<Player, CombatState>();

  // Networking (undefined = solo). Host runs the authoritative sim + broadcasts;
  // guest renders the broadcast and never simulates.
  private session?: NetSession;
  private role: "solo" | "host" | "guest" = "solo";
  private roomSeq = 0; // host: bumped per room, drives guest room rebuilds
  private netT = 0; // host: snapshot counter
  private netAcc = 0; // host: broadcast throttle
  private guestRoomSeq = -1; // guest: room seq it has built
  private guestSnapT = -1; // guest: last snapshot applied
  private netProj: Phaser.GameObjects.Sprite[] = []; // guest: projectile puppets
  private enemyId = new WeakMap<Enemy, number>(); // host: stable wire id per enemy
  private enemyIdNext = 1;
  private outSeq = { j: 0, d: 0, a: 0, s: 0 }; // my press counters (sent to host)
  private inSeq = { j: 0, d: 0, a: 0, s: 0 }; // host: last-seen remote press counters
  private enemyPuppets = new Map<number, { view: Enemy; net: NetEnemy }>(); // guest
  private bossPuppet?: { view: Boss; net: NetBoss }; // guest
  private netPlayers: NetPlayer[] = []; // guest: latest wire players (re-lerped each frame)
  private roomSpawn = { x: 0, y: 0 };
  private netBiome = 1; // guest: HUD biome/depth (host uses this.run)
  private netDepth = 1;

  private mustClear = false;
  private cleared = false;
  private mods: RunMods = baseMods();
  private ownedRelics = new Set<string>();
  private merchantItems: MerchantItem[] = [];
  private maxHearts = MAX_HEARTS;
  private hearts = MAX_HEARTS;
  private gold = 0;
  private freeze = 0;
  private deadTimers = new WeakMap<Enemy, number>();
  private state: SceneState = "active";
  private deadT = 0;
  private transT = 0;
  private transBuilt = false;
  private pendingOffer: Offer | null = null;
  private fadeRect!: Phaser.GameObjects.Rectangle;

  private heartsText!: Phaser.GameObjects.Text;
  private infoText!: Phaser.GameObjects.Text;
  private banner!: Phaser.GameObjects.Text;

  private demo = false;
  private demoT = 0;
  private prevJump = false;
  private prevDash = false;
  private prevAtk = false;
  private prevSpecial = false;

  constructor() {
    super("game");
  }

  create() {
    const params = new URLSearchParams(location.search);
    this.demo = params.get("demo") === "1";
    const data = this.scene.settings.data as { hero?: HeroName } | undefined;
    const wanted =
      (params.get("hero") as HeroName | null) ?? data?.hero ?? this.registry.get("hero");
    this.heroName = wanted && HEROES[wanted as HeroName] ? (wanted as HeroName) : "axion";
    this.mods = baseMods();
    this.ownedRelics = new Set();
    this.merchantItems = [];
    this.maxHearts = this.mods.maxHearts;
    this.hearts = this.maxHearts;
    this.gold = 0;
    this.state = "active";
    this.doors = [];
    this.enemies = [];
    this.arrows = [];
    this.shots = [];
    this.hazards = [];
    this.boss = null;
    this.feature = null;

    // Screen-pinned sky (scrollFactor 0) — a blue-grey gradient (dark up top,
    // lighter toward the horizon) matching the Luneblade art. The parallax tree
    // layers are added per-room in decorateRoom in front of this.
    this.add.rectangle(0, 0, BASE_W, BASE_H, 0x464f66).setOrigin(0).setScrollFactor(0).setDepth(-42);
    this.add
      .rectangle(0, BASE_H * 0.32, BASE_W, BASE_H * 0.68, 0x59637b)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(-41);
    this.add
      .rectangle(0, BASE_H * 0.58, BASE_W, BASE_H * 0.42, 0x6b768e)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(-40)
      .setAlpha(0.85);

    this.fadeRect = this.add
      .rectangle(0, 0, BASE_W, BASE_H, 0x05070b)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(100)
      .setAlpha(0);

    this.heartsText = this.add
      .text(8, 6, "", { fontFamily: "monospace", fontSize: "12px", color: "#ff4d6d" })
      .setScrollFactor(0)
      .setDepth(80);
    this.infoText = this.add
      .text(BASE_W - 8, 7, "", { fontFamily: "monospace", fontSize: "9px", color: "#8b95a1" })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(80);
    this.banner = this.add
      .text(BASE_W / 2, BASE_H / 2 - 20, "", {
        fontFamily: "monospace",
        fontSize: "15px",
        color: "#34e5c8",
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(80)
      .setAlpha(0);

    this.controls = new Input(this);

    const regParty = this.registry.get("party");
    const party = params.get("party") ?? (typeof regParty === "string" ? regParty : "");
    if (party.length > 0 && !this.demo) {
      // Co-op: connect, then let update() resolve host vs guest. The player spawns
      // on an empty grid so it's always defined; the real room arrives once the
      // host begins the run (host) or the first room snapshot lands (guest).
      this.role = "guest"; // provisional until the connection reports host
      this.state = "connecting";
      this.player = this.spawnPlayer(HEROES[this.heroName], new Grid(), BASE_W / 2, BASE_H / 2);
      this.player.sprite.setVisible(false);
      this.fadeRect.setAlpha(1);
      this.showBanner("CONNECTING…", 100000);
      this.session = new NetSession({
        room: `lunerfall-${party}`,
        maxPlayers: 2,
        fallbackMs: 6000,
      });
      // Drop the socket when the scene tears down (death → hub), else it lingers.
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.session?.destroy());
    } else {
      const roomParam = new URLSearchParams(location.search).get("room") as RoomType | null;
      const def = roomParam ? this.run.debugEnter(roomParam) : this.run.begin();
      this.player = this.spawnPlayer(
        HEROES[this.heroName],
        def.grid,
        def.playerSpawn.x,
        def.playerSpawn.y,
      );
      this.buildRoom(def);
      this.updateHud();
    }

    sfx.unlock();
    this.input.keyboard?.once("keydown", () => sfx.unlock());
    this.input.once("pointerdown", () => sfx.unlock());
    this.input.keyboard?.on("keydown-M", () => sfx.toggleMute());
  }

  // Build a Player whose juice hooks are bound to itself (so local + remote each
  // shake / kick smoke at their own position with their own hero colour).
  private spawnPlayer(hero: HeroDef, grid: Grid, x: number, y: number): Player {
    const cam = this.cameras.main;
    const pl: Player = new Player(this, grid, x, y, hero, {
      onLand: (impact) => {
        cam.shake(80, Math.min(0.003 + impact * 0.00002, 0.008));
        dust(this, pl.x, pl.y);
      },
      onDash: () => {
        cam.shake(60, 0.0025);
        sfx.dash();
      },
      // No painted attack VFX — the sprite-sheet swing carries the strike. Just
      // feel: a small camera shake + the swing sound.
      onSwing: () => {
        cam.shake(50, 0.0015);
        sfx.slash();
      },
      onSpecial: (kind) => this.onSpecialFx(kind, pl),
      onHurt: () => {
        cam.shake(180, 0.012);
        sfx.hurt();
      },
      onJump: () => sfx.jump(),
      onWallJump: (side) => {
        wallSmoke(this, pl.x + side * 7, pl.y - 12, side);
        cam.shake(40, 0.002);
      },
    });
    return pl;
  }

  // ── room building ──────────────────────────────────────────────────────────
  // Tear down every per-room object (host sim entities + guest puppets alike).
  private teardownRoom() {
    this.roomLayer?.destroy();
    this.parallax.forEach((o) => o.destroy());
    this.parallax = [];
    this.roomProp?.destroy();
    this.roomProp = undefined;
    this.embers?.destroy();
    this.embers = undefined;
    this.doors.forEach((d) => d.destroy());
    this.enemies.forEach((e) => e.destroy());
    this.arrows.forEach((a) => a.spr.destroy());
    this.shots.forEach((s) => s.spr.destroy());
    this.hazards.forEach((h) => h.spr.destroy());
    this.merchantItems.forEach((m) => m.g.destroy());
    this.merchantItems = [];
    this.boss?.destroy();
    this.bossHp?.destroy();
    this.bossHpBg?.destroy();
    this.feature?.g.destroy();
    this.doors = [];
    this.enemies = [];
    this.arrows = [];
    this.shots = [];
    this.hazards = [];
    this.boss = null;
    this.bossHp = undefined;
    this.bossHpBg = undefined;
    this.bossDeadT = 0;
    this.feature = null;
    this.deadTimers = new WeakMap();
    this.combat = new WeakMap();
    this.enemyPuppets.forEach((p) => p.view.destroy());
    this.enemyPuppets.clear();
    this.bossPuppet?.view.destroy();
    this.bossPuppet = undefined;
    this.netProj.forEach((s) => s.destroy());
    this.netProj = [];
  }

  // Bind the camera to the current room's pixel extent and follow the local
  // player, so bigger-than-screen rooms scroll. Called after every room (re)build.
  private setupCamera() {
    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.grid.cols * TILE, this.grid.rows * TILE);
    cam.startFollow(this.player.sprite, true, 0.22, 0.24);
    cam.setDeadzone(36, 28);
  }

  private buildRoom(def: RoomDef) {
    this.teardownRoom();
    this.grid = def.grid;
    this.parallax = buildParallax(this, def.grid.cols * TILE, def.grid.rows * TILE);
    this.roomLayer = drawRoom(this, def.grid).setDepth(0);
    this.decorateRoom(def);
    this.embers = ambientEmbers(
      this,
      this.run.type === "boss" ? COLORS.magenta : COLORS.teal,
      def.grid.cols * TILE,
      def.grid.rows * TILE,
    );
    this.player.enterRoom(def.grid, def.playerSpawn.x, def.playerSpawn.y);
    this.remote?.enterRoom(def.grid, def.playerSpawn.x, def.playerSpawn.y);
    this.roomSpawn = { x: def.playerSpawn.x, y: def.playerSpawn.y };
    this.setupCamera();

    this.mustClear = this.run.isCombat();
    this.cleared = !this.mustClear;

    if (this.run.type === "boss") this.spawnBoss(def);
    else if (this.mustClear) this.spawnEnemies(def);
    else if (this.run.type === "merchant") this.buildMerchant();
    else if (def.featureSpot) this.buildFeature(def.featureSpot.x, def.featureSpot.y);

    this.offers = this.run.offers();
    def.doorSlots.forEach((slot, i) => {
      const offer = this.offers[i];
      if (!offer) return;
      const d = new Door(this, slot.x, slot.y, offer.type, i);
      d.setActive(this.cleared);
      this.doors.push(d);
    });

    this.roomSeq++;
    if (this.role === "host") this.transmitRoom();
    this.showBanner(
      this.mustClear ? ROOM_LABEL[this.run.type] : `${ROOM_LABEL[this.run.type]} — pick a path`,
      1100,
    );
  }

  // Weighted-random enemy type, rolled per spawn so encounters vary run to run
  // (was a fixed roster → identical fights). Warriors dominate early; ranged and
  // heavy types get commoner in deeper biomes and elite rooms. Host-authoritative:
  // guests replicate whatever the host rolled via the enemy name on the wire.
  private pickEnemy(): EnemyName {
    const elite = this.run.type === "elite";
    const b = this.run.biome;
    const pool: [EnemyName, number][] = [
      ["warrior", elite ? 22 : 42],
      ["spearman", 14 + b * 3 + (elite ? 8 : 0)],
      ["archer", 12 + b * 3 + (elite ? 8 : 0)],
      ["bomber", 5 + b * 2 + (elite ? 6 : 0)],
    ];
    const total = pool.reduce((s, p) => s + p[1], 0);
    let r = Math.random() * total;
    for (const [name, w] of pool) {
      r -= w;
      if (r <= 0) return name;
    }
    return "warrior";
  }

  private spawnEnemies(def: RoomDef) {
    const eliteHp = this.run.type === "elite" ? 1 : 0;
    def.enemySpawns.forEach((s) => {
      const e = new Enemy(this, this.grid, ENEMIES[this.pickEnemy()], s.x, s.y);
      e.body.hp += eliteHp + Math.floor((this.run.biome - 1) / 2);
      this.enemies.push(e);
    });
  }

  private spawnBoss(def: RoomDef) {
    const bx = def.bossSpawn?.x ?? BASE_W / 2;
    const by = def.bossSpawn?.y ?? (this.grid.rows - 3) * TILE;
    this.boss = new Boss(this, this.grid, bx, by, this.run.biome);
    this.bossDeadT = 0;
    this.bossHpBg = this.add
      .rectangle(BASE_W / 2, 22, 260, 6, 0x000000, 0.5)
      .setStrokeStyle(1, COLORS.magenta, 0.6)
      .setScrollFactor(0)
      .setDepth(85);
    this.bossHp = this.add
      .rectangle(BASE_W / 2 - 129, 22, 258, 4, COLORS.magenta)
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(86);
    sfx.bossRoar();
    this.showBanner("SALAMANDER", 1600);
  }

  private buildFeature(x: number, y: number) {
    const type = this.run.type;
    const color = type === "rest" ? COLORS.teal : type === "treasure" ? 0xffd15c : COLORS.magenta;
    const g = this.add.container(x, y).setDepth(8);
    const glow = this.add.ellipse(0, -10, 26, 30, color, 0.2);
    const base = this.add.rectangle(0, 0, 16, 6, COLORS.stoneEdge).setOrigin(0.5, 1);
    const orb = this.add.circle(0, -14, 5, color, 0.95);
    const tag = this.add
      .text(0, -26, ROOM_LABEL[type], {
        fontFamily: "monospace",
        fontSize: "7px",
        color: "#f4f7fb",
      })
      .setOrigin(0.5, 1);
    g.add([glow, base, orb, tag]);
    this.tweens.add({
      targets: orb,
      y: -17,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    this.tweens.add({
      targets: glow,
      scale: 1.2,
      alpha: 0.32,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    this.feature = { x, y, used: false, g };
  }

  // A themed animated prop dresses each non-combat room (fountain / campfire /
  // column fire / flag), placed to the side on the floor, behind the entities.
  private decorateRoom(def: RoomDef) {
    const cfg = ROOM_PROPS[this.run.type];
    if (!cfg) return;
    this.roomProp = this.add
      .sprite(BASE_W * 0.17, def.playerSpawn.y, `prop:${cfg.key}`)
      .setOrigin(cfg.ox, cfg.oy)
      .setScale(cfg.scale)
      .setDepth(2);
    this.roomProp.play(`prop:${cfg.key}`);
  }

  private buildMerchant() {
    const offers = pickRelics(3, this.ownedRelics);
    const y = (this.grid.rows - 3 + 1) * TILE;
    offers.forEach((relic, i) => {
      const x = (0.3 + i * 0.2) * BASE_W;
      const g = this.add.container(x, y).setDepth(8);
      const glow = this.add.ellipse(0, -12, 24, 30, COLORS.magenta, 0.18);
      const base = this.add.rectangle(0, 0, 16, 6, COLORS.stoneEdge).setOrigin(0.5, 1);
      const orb = this.add.circle(0, -16, 5, COLORS.magenta, 0.95);
      const name = this.add
        .text(0, -40, relic.name, { fontFamily: "monospace", fontSize: "7px", color: "#f4f7fb" })
        .setOrigin(0.5);
      const desc = this.add
        .text(0, -32, relic.desc, { fontFamily: "monospace", fontSize: "6px", color: "#8b95a1" })
        .setOrigin(0.5);
      const price = this.add
        .text(0, -25, `⬡ ${relic.price}`, {
          fontFamily: "monospace",
          fontSize: "7px",
          color: "#ffd15c",
        })
        .setOrigin(0.5);
      g.add([glow, base, orb, name, desc, price]);
      this.tweens.add({
        targets: orb,
        y: -19,
        duration: 900,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
      this.merchantItems.push({ x, y, relic, bought: false, g });
    });
  }

  private applyRelic(relic: Relic) {
    this.ownedRelics.add(relic.id);
    relic.apply(this.mods);
    const before = this.maxHearts;
    this.maxHearts = this.mods.maxHearts;
    this.hearts += Math.max(0, this.maxHearts - before); // new max hearts come filled
    sfx.pickup();
    this.updateHud();
  }

  private stepMerchant() {
    for (const m of this.merchantItems) {
      if (m.bought || this.gold < m.relic.price) continue;
      const box = { left: m.x - 10, top: m.y - 22, right: m.x + 10, bottom: m.y };
      if (this.livePlayers().some((pl) => rectsOverlap(box, pl.body.hurtBox()))) {
        m.bought = true;
        this.gold -= m.relic.price;
        this.applyRelic(m.relic);
        popText(this, m.x, m.y - 30, m.relic.name, "#e83fa0");
        this.tweens.add({
          targets: m.g,
          alpha: 0,
          y: m.y - 6,
          duration: 350,
          onComplete: () => m.g.destroy(),
        });
      }
    }
  }

  private dmgOut(base: number): number {
    return Math.max(1, Math.round(base * this.mods.dmg));
  }

  private heal(n: number) {
    this.hearts = Math.min(this.maxHearts, this.hearts + n);
    sfx.heal();
    this.updateHud();
  }

  private gainGold(n: number) {
    this.gold += Math.round(n * this.mods.goldMult);
  }

  // ── input ────────────────────────────────────────────────────────────────
  private demoInput(): InputState {
    const cyc = this.demoT % 1.9;
    const jumpHeld = cyc < 0.24;
    const dashWin = cyc > 1.4 && cyc < 1.44;
    const atkWin = (cyc > 0.5 && cyc < 0.54) || (cyc > 0.8 && cyc < 0.84);
    const specWin = cyc > 1.7 && cyc < 1.74;
    const jp = jumpHeld && !this.prevJump;
    const dp = dashWin && !this.prevDash;
    const ap = atkWin && !this.prevAtk;
    const sp = specWin && !this.prevSpecial;
    this.prevJump = jumpHeld;
    this.prevDash = dashWin;
    this.prevAtk = atkWin;
    this.prevSpecial = specWin;
    return {
      left: false,
      right: true,
      up: false,
      down: false,
      jumpHeld,
      jumpPressed: jp,
      dashPressed: dp,
      attackPressed: ap,
      specialPressed: sp,
    };
  }

  update(_t: number, delta: number) {
    const dts = Math.min(delta, 100) / 1000;
    this.demoT += dts;

    if (this.session) {
      this.session.tick();
      // Everyone but the authoritative host streams their input up each frame.
      if (this.role !== "host") this.sendInput();
      // Headless co-op probe (no casts): read via globalThis.__lf in tests.
      Reflect.set(globalThis, "__lf", {
        role: this.role,
        state: this.state,
        players: this.livePlayers().length,
        entities: this.enemies.length + this.enemyPuppets.size,
        hearts: this.hearts,
        px: Math.round(this.player.x),
        conn: this.session.connectionStatus,
      });
    }

    if (this.state === "connecting") {
      this.stepConnecting();
      return;
    }

    if (this.state === "dead") {
      this.deadT += dts;
      this.enemies.forEach((e) => e.render());
      if (this.deadT > 2.4) this.scene.start("select");
      return;
    }
    if (this.state === "transition") {
      this.transT += dts;
      const half = 0.22;
      this.fadeRect.setAlpha(
        this.transT < half ? this.transT / half : Math.max(0, 1 - (this.transT - half) / half),
      );
      if (!this.transBuilt && this.transT >= half && this.pendingOffer) {
        this.buildRoom(this.run.choose(this.pendingOffer));
        this.updateHud();
        this.transBuilt = true;
      }
      if (this.transT >= half * 2) {
        this.fadeRect.setAlpha(0);
        this.pendingOffer = null;
        this.state = "active";
      }
      this.player.render();
      this.remote?.render();
      this.enemies.forEach((e) => e.render());
      this.boss?.render();
      if (this.role === "host") this.hostNet(dts);
      return;
    }

    // Guest: no simulation — render the host's broadcast.
    if (this.role === "guest") {
      this.stepGuest();
      return;
    }

    // Host / solo: authoritative fixed-step sim.
    if (this.role === "host") this.syncRemotePresence();
    const snap = this.demo ? this.demoInput() : this.controls.sample();
    this.player.buffer(snap);
    if (this.remote) this.remote.buffer(this.readRemoteInput());
    this.acc += dts;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_STEPS) {
      if (this.freeze > 0) this.freeze -= STEP;
      else this.simStep(STEP);
      this.acc -= STEP;
      steps++;
    }

    // Interpolate the render between the last two sim steps by the leftover step
    // fraction, so motion stays smooth when the display refreshes faster than 60Hz.
    const alpha = Math.min(this.acc / STEP, 1);
    this.player.render(alpha);
    this.remote?.render(alpha);
    this.enemies.forEach((e) => e.render(alpha));
    this.boss?.render(alpha);
    this.updateHud();

    if (this.role === "host") this.hostNet(dts);
  }

  // ── networking ───────────────────────────────────────────────────────────────
  // Stream my held input + monotonic press counters up to the host.
  private sendInput() {
    if (!this.session) return;
    const s = this.demo ? this.demoInput() : this.controls.sample();
    if (s.jumpPressed) this.outSeq.j++;
    if (s.dashPressed) this.outSeq.d++;
    if (s.attackPressed) this.outSeq.a++;
    if (s.specialPressed) this.outSeq.s++;
    const input: NetInput = {
      left: s.left,
      right: s.right,
      up: s.up,
      down: s.down,
      jumpHeld: s.jumpHeld,
      j: this.outSeq.j,
      d: this.outSeq.d,
      a: this.outSeq.a,
      s: this.outSeq.s,
    };
    this.session.updateMyState({ hero: this.heroName, input });
  }

  // Host: turn the guest's latest wire input into an edge-triggered InputState.
  private readRemoteInput(): InputState {
    const ni = readNetInput(this.session?.otherPlayer()?.state?.input);
    if (!ni) return NEUTRAL_INPUT;
    const jp = ni.j !== this.inSeq.j;
    const dp = ni.d !== this.inSeq.d;
    const ap = ni.a !== this.inSeq.a;
    const sp = ni.s !== this.inSeq.s;
    this.inSeq = { j: ni.j, d: ni.d, a: ni.a, s: ni.s };
    return {
      left: ni.left,
      right: ni.right,
      up: ni.up,
      down: ni.down,
      jumpHeld: ni.jumpHeld,
      jumpPressed: jp,
      dashPressed: dp,
      attackPressed: ap,
      specialPressed: sp,
    };
  }

  // Host: spawn / despawn the remote player as the other client joins or leaves.
  private syncRemotePresence() {
    const other = this.session?.otherPlayer();
    if (other && !this.remote) {
      const hero = parseHero(other.state?.hero) ?? "axion";
      this.remote = this.spawnPlayer(HEROES[hero], this.grid, this.roomSpawn.x, this.roomSpawn.y);
      this.inSeq = { j: 0, d: 0, a: 0, s: 0 };
      this.showBanner("PLAYER 2 JOINED", 1000);
    } else if (!other && this.remote) {
      this.remote.destroy();
      this.remote = undefined;
      this.showBanner("PLAYER 2 LEFT", 1000);
    }
  }

  // Connecting: hold the black overlay until the connection reports host vs guest.
  private stepConnecting() {
    const sess = this.session;
    if (!sess || !sess.live) return;
    if (sess.isHost) {
      this.role = "host";
      const roomParam = new URLSearchParams(location.search).get("room");
      const rt = roomParam ? parseRoomType(roomParam) : null;
      const def = rt ? this.run.debugEnter(rt) : this.run.begin();
      this.buildRoom(def);
      this.updateHud();
      this.finishConnecting();
    } else {
      const room = readRoom(sess.sharedState);
      if (!room) return; // wait for the host's first room broadcast
      this.role = "guest";
      this.buildRoomFromNet(room);
      this.finishConnecting();
    }
  }

  private finishConnecting() {
    this.player.sprite.setVisible(true);
    this.fadeRect.setAlpha(0);
    this.banner.setAlpha(0);
    this.state = "active";
  }

  // Guest: apply the latest room + snapshot, then re-lerp the views every frame.
  private stepGuest() {
    const sess = this.session;
    if (!sess) return;
    const shared = sess.sharedState;
    const room = readRoom(shared);
    if (room && room.seq !== this.guestRoomSeq) this.buildRoomFromNet(room);
    const snap = readSnapshot(shared);
    if (snap && snap.t !== this.guestSnapT) {
      this.guestSnapT = snap.t;
      this.applySnapshot(snap);
    }
    this.renderGuestViews();
  }

  private applySnapshot(s: Snapshot) {
    this.hearts = s.hearts;
    this.maxHearts = s.maxHearts;
    this.gold = s.gold;
    this.netBiome = s.biome;
    this.netDepth = s.depth;
    this.netPlayers = s.players;
    this.reconcileEnemies(s.enemies);
    this.reconcileBoss(s.boss, s.biome);
    this.applyNetProj(s.proj);
    this.doors.forEach((d) => d.setActive(s.cleared));
    this.updateHud();
    if (this.hearts <= 0) this.guestDie();
  }

  private reconcileEnemies(list: NetEnemy[]) {
    const seen = new Set<number>();
    for (const ne of list) {
      seen.add(ne.id);
      let p = this.enemyPuppets.get(ne.id);
      if (!p) {
        const view = new Enemy(this, this.grid, ENEMIES[parseEnemy(ne.name)], ne.x, ne.y);
        p = { view, net: ne };
        this.enemyPuppets.set(ne.id, p);
      }
      p.net = ne;
    }
    for (const [id, p] of this.enemyPuppets) {
      if (!seen.has(id)) {
        p.view.destroy();
        this.enemyPuppets.delete(id);
      }
    }
  }

  private reconcileBoss(nb: NetBoss | null, biome: number) {
    if (nb && !this.bossPuppet) {
      const view = new Boss(this, this.grid, nb.x, nb.y, biome);
      this.bossHpBg = this.add
        .rectangle(BASE_W / 2, 22, 260, 6, 0x000000, 0.5)
        .setStrokeStyle(1, COLORS.magenta, 0.6)
        .setDepth(85);
      this.bossHp = this.add
        .rectangle(BASE_W / 2 - 129, 22, 258, 4, COLORS.magenta)
        .setOrigin(0, 0.5)
        .setDepth(86);
      this.bossPuppet = { view, net: nb };
      sfx.bossRoar();
    } else if (!nb && this.bossPuppet) {
      this.bossPuppet.view.destroy();
      this.bossPuppet = undefined;
      this.bossHp?.destroy();
      this.bossHpBg?.destroy();
      this.bossHp = undefined;
      this.bossHpBg = undefined;
    }
    if (nb && this.bossPuppet) {
      this.bossPuppet.net = nb;
      if (this.bossHp) this.bossHp.width = 258 * nb.hpFrac;
    }
  }

  private applyNetProj(proj: NetProj[]) {
    for (let i = 0; i < proj.length; i++) {
      const pj = proj[i];
      if (!pj) continue;
      let spr = this.netProj[i];
      if (!spr) {
        spr = this.add.sprite(pj.x, pj.y, "fx:arrow").setDepth(40);
        this.netProj[i] = spr;
      }
      spr.setVisible(true).setPosition(pj.x, pj.y);
      if (pj.k === "arrow")
        spr
          .setTexture("fx:arrow")
          .setScale(0.3)
          .setRotation(pj.vx < 0 ? Math.PI : 0);
      else {
        if (spr.anims.currentAnim?.key !== "fx:flame-wave") spr.play("fx:flame-wave");
        spr
          .setScale(0.6)
          .setFlipX(pj.vx < 0)
          .setRotation(0);
      }
    }
    for (let i = proj.length; i < this.netProj.length; i++) this.netProj[i]?.setVisible(false);
  }

  // Guest: re-drive the puppets every frame off the latest snapshot (they lerp
  // toward the authoritative point, so 30Hz reads render smoothly at 60fps).
  private renderGuestViews() {
    const myId = this.session?.playerId;
    for (const np of this.netPlayers) {
      if (np.id === myId) this.player.applyNet(np);
      else {
        this.ensureGuestRemote(np.hero);
        this.remote?.applyNet(np);
      }
    }
    for (const p of this.enemyPuppets.values())
      p.view.applyNet(p.net.clip, p.net.x, p.net.y, p.net.flip, p.net.flash);
    if (this.bossPuppet) {
      const n = this.bossPuppet.net;
      this.bossPuppet.view.applyNet(n.clip, n.x, n.y, n.flip, n.flash, n.telegraph);
    }
  }

  private ensureGuestRemote(heroRaw: string) {
    if (this.remote) return;
    const hero = parseHero(heroRaw) ?? "axion";
    this.remote = this.spawnPlayer(HEROES[hero], this.grid, this.roomSpawn.x, this.roomSpawn.y);
  }

  private guestDie() {
    this.state = "dead";
    this.deadT = 0;
    this.player.sprite.play(`${this.heroName}:death`);
    sfx.die();
  }

  // Host: broadcast a snapshot at the network rate.
  private hostNet(dts: number) {
    if (!this.session) return;
    this.netAcc += dts;
    if (this.netAcc < 1 / NET_HZ) return;
    this.netAcc = 0;
    this.session.patchShared({ snap: this.encodeSnapshot() });
  }

  private encodeSnapshot(): Snapshot {
    this.netT++;
    const players: NetPlayer[] = [this.player.encode(this.session?.playerId ?? "host")];
    const other = this.session?.otherPlayer();
    if (this.remote && other) players.push(this.remote.encode(other.id));
    const enemies: NetEnemy[] = this.enemies.map((e) => {
      let id = this.enemyId.get(e);
      if (!id) {
        id = this.enemyIdNext++;
        this.enemyId.set(e, id);
      }
      const name = e.body.kind.name;
      return {
        id,
        name,
        clip: e.sprite.anims.currentAnim?.key ?? `${name}:idle`,
        x: Math.round(e.body.x),
        y: Math.round(e.body.y),
        flip: e.sprite.flipX,
        dead: e.body.dead,
        flash: e.body.hitFlash > 0,
      };
    });
    const boss: NetBoss | null = this.boss
      ? {
          clip: this.boss.sprite.anims.currentAnim?.key ?? "salamander:idle",
          x: Math.round(this.boss.body.x),
          y: Math.round(this.boss.body.y),
          flip: this.boss.sprite.flipX,
          hpFrac: this.boss.body.hpFrac,
          flash: this.boss.body.hitFlash > 0,
          telegraph: this.boss.body.telegraphing,
          dead: this.boss.body.dead,
        }
      : null;
    const proj: NetProj[] = [];
    for (const a of this.arrows)
      proj.push({ k: "arrow", x: Math.round(a.x), y: Math.round(a.y), vx: a.vx });
    for (const s of this.shots)
      proj.push({ k: "shot", x: Math.round(s.x), y: Math.round(s.y), vx: s.vx });
    for (const h of this.hazards)
      proj.push({ k: "hazard", x: Math.round(h.x), y: Math.round(h.y), vx: h.vx });
    return {
      t: this.netT,
      room: this.roomSeq,
      players,
      enemies,
      boss,
      proj,
      hearts: this.hearts,
      maxHearts: this.maxHearts,
      gold: this.gold,
      biome: this.run.biome,
      depth: this.run.depth,
      cleared: this.cleared,
      banner: "",
    };
  }

  // Host: send the current room's static layout (once per room).
  private transmitRoom() {
    if (!this.session) return;
    const doors: NetDoor[] = this.doors.map((d) => ({
      index: d.index,
      x: d.x,
      y: d.y,
      type: d.type,
      label: ROOM_LABEL[d.type],
      danger: false,
    }));
    const room: NetRoom = {
      seq: this.roomSeq,
      type: this.run.type,
      cols: this.grid.cols,
      rows: this.grid.rows,
      cells: Array.from(this.grid.cells),
      spawnX: this.roomSpawn.x,
      spawnY: this.roomSpawn.y,
      doors,
      propKey: ROOM_PROPS[this.run.type]?.key ?? "",
      mustClear: this.mustClear,
    };
    this.session.patchShared({ room });
  }

  // Guest: rebuild the room view from the host's broadcast (no RunManager).
  private buildRoomFromNet(room: NetRoom) {
    this.teardownRoom();
    const g = new Grid(room.cols, room.rows);
    g.cells.set(room.cells);
    this.grid = g;
    this.parallax = buildParallax(this, g.cols * TILE, g.rows * TILE);
    this.roomLayer = drawRoom(this, g).setDepth(0);
    const type = parseRoomType(room.type) ?? "combat";
    if (room.propKey) {
      const cfg = ROOM_PROPS[type];
      this.roomProp = this.add
        .sprite(BASE_W * 0.17, room.spawnY, `prop:${room.propKey}`)
        .setOrigin(cfg?.ox ?? 0.5, cfg?.oy ?? 0.7)
        .setScale(cfg?.scale ?? 0.7)
        .setDepth(2);
      this.roomProp.play(`prop:${room.propKey}`);
    }
    this.embers = ambientEmbers(
      this,
      type === "boss" ? COLORS.magenta : COLORS.teal,
      g.cols * TILE,
      g.rows * TILE,
    );
    this.roomSpawn = { x: room.spawnX, y: room.spawnY };
    this.player.enterRoom(g, room.spawnX, room.spawnY);
    this.remote?.enterRoom(g, room.spawnX, room.spawnY);
    this.setupCamera();
    for (const nd of room.doors) {
      const d = new Door(this, nd.x, nd.y, parseRoomType(nd.type) ?? "combat", nd.index);
      d.setActive(false);
      this.doors.push(d);
    }
    this.mustClear = room.mustClear;
    this.cleared = !room.mustClear;
    this.guestRoomSeq = room.seq;
    this.showBanner(ROOM_LABEL[type], 1000);
  }

  // ── co-op helpers ────────────────────────────────────────────────────────────
  private livePlayers(): Player[] {
    return this.remote ? [this.player, this.remote] : [this.player];
  }
  private cs(pl: Player): CombatState {
    let s = this.combat.get(pl);
    if (!s) {
      s = newCombatState();
      this.combat.set(pl, s);
    }
    return s;
  }
  // Enemies chase whichever live, non-dead player is closest.
  private nearestPlayer(x: number, y: number): Player {
    let best = this.player;
    let bd = Infinity;
    for (const pl of this.livePlayers()) {
      if (pl.body.dead) continue;
      const d = Math.hypot(pl.x - x, pl.y - y);
      if (d < bd) {
        bd = d;
        best = pl;
      }
    }
    return best;
  }

  private simStep(dt: number) {
    for (const pl of this.livePlayers()) pl.step(dt);
    for (const e of this.enemies) {
      const t = this.nearestPlayer(e.body.x, e.body.y);
      e.body.step(dt, t.x, t.y);
    }
    this.stepBoss(dt);
    this.stepArrows(dt);
    this.stepShots(dt);
    this.stepHazards(dt);
    for (const pl of this.livePlayers()) this.playerOffense(pl);
    this.enemyOffense();
    this.stepFeature();
    this.stepMerchant();
    this.cullEnemies(dt);
    this.checkClear();
    this.checkDoors();
  }

  // ── boss ────────────────────────────────────────────────────────────────────
  private stepBoss(dt: number) {
    const boss = this.boss;
    if (!boss) return;
    const target = this.nearestPlayer(boss.body.x, boss.body.y);
    boss.body.step(dt, target.x, target.y);
    if (this.bossHp) this.bossHp.width = 258 * boss.body.hpFrac;

    if (boss.body.dead) {
      if (this.bossDeadT === 0) {
        explosion(this, boss.body.x, boss.body.y - 20, 60);
        sfx.boom();
        this.cameras.main.shake(420, 0.02);
        this.freeze = Math.max(this.freeze, 0.12);
        this.gainGold(25);
        popText(this, boss.body.x, boss.body.y - 44, "+25", "#ffd15c");
        this.showBanner("SALAMANDER SLAIN", 1800);
      }
      this.bossDeadT += dt;
      return;
    }

    if (boss.body.pendingWave) {
      const w = boss.body.pendingWave;
      this.spawnHazard(w.x, w.y, w.vx, w.dmg);
      boss.body.pendingWave = null;
    }
    if (boss.body.pendingBlast) {
      const b = boss.body.pendingBlast;
      explosion(this, b.x, b.y, b.r);
      sfx.boom();
      this.cameras.main.shake(200, 0.014);
      this.freeze = Math.max(this.freeze, 0.07);
      for (const pl of this.livePlayers()) {
        if (!pl.body.dead && Math.hypot(pl.x - b.x, pl.y - 11 - b.y) < b.r + 8)
          this.hurtPlayer(b.dmg, Math.sign(pl.x - b.x) || 1, pl);
      }
      boss.body.pendingBlast = null;
    }
    if (boss.body.pendingAdds) {
      for (const a of boss.body.pendingAdds) {
        this.enemies.push(
          new Enemy(this, this.grid, ENEMIES[a.name], Phaser.Math.Clamp(a.x, 24, BASE_W - 24), a.y),
        );
      }
      boss.body.pendingAdds = null;
      this.showBanner("REINFORCEMENTS", 900);
    }
    const atk = boss.body.attackBox();
    for (const pl of this.livePlayers()) {
      const pb = pl.body;
      if (pb.dead) continue;
      if (atk && rectsOverlap(atk, pb.hurtBox()))
        this.hurtPlayer(atk.dmg, Math.sign(pb.x - boss.body.x) || 1, pl);
      else if (rectsOverlap(boss.body.hurtBox(), pb.hurtBox()))
        this.hurtPlayer(1, Math.sign(pb.x - boss.body.x) || 1, pl);
    }
  }

  private hitBoss(dmg: number, dir: number, color: number) {
    const boss = this.boss;
    if (!boss || boss.body.dead) return;
    if (!boss.body.takeHit(dmg, 0, dir)) return;
    sfx.hit();
    hitSpark(this, boss.body.x, boss.body.y - 22, color, boss.body.dead ? 12 : 6);
    if (boss.body.dead) impactRing(this, boss.body.x, boss.body.y - 22, COLORS.magenta, 40);
    this.freeze = Math.max(this.freeze, boss.body.dead ? 0.12 : 0.04);
    this.cameras.main.shake(60, 0.003);
  }

  private spawnHazard(x: number, y: number, vx: number, dmg: number) {
    const spr = this.add.sprite(x, y, "fx:flame-wave").setScale(0.9).setDepth(41);
    spr.play("fx:flame-wave");
    spr.setFlipX(vx < 0);
    this.hazards.push({ spr, x, y, vx, life: 2.6, dmg, hitPlayer: false });
  }

  private stepHazards(dt: number) {
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      if (!h) continue;
      h.x += h.vx * dt;
      h.life -= dt;
      h.spr.setPosition(Math.round(h.x), Math.round(h.y));
      const box = { left: h.x - 14, top: h.y - 9, right: h.x + 14, bottom: h.y + 9 };
      for (const pl of this.livePlayers()) {
        if (!h.hitPlayer && !pl.body.dead && rectsOverlap(box, pl.body.hurtBox())) {
          this.hurtPlayer(h.dmg, Math.sign(h.vx) || 1, pl);
          h.hitPlayer = true;
        }
      }
      if (h.life <= 0 || this.grid.solidInRect(h.x - 4, h.y - 4, h.x + 4, h.y + 4)) {
        h.spr.destroy();
        this.hazards.splice(i, 1);
      }
    }
  }

  private onSpecialFx(kind: string, pl: Player = this.player) {
    const px = pl.x;
    const py = pl.y - 11;
    const color = pl.color;
    if (kind === "blink") hitSpark(this, px, py, color, 12);
    else if (kind === "heal") {
      for (let i = 0; i < 8; i++) {
        const p = this.add
          .circle(px + (Math.random() - 0.5) * 16, py + 6, 1.5, COLORS.teal, 0.9)
          .setDepth(60);
        this.tweens.add({
          targets: p,
          y: py - 14,
          alpha: 0,
          duration: 500 + Math.random() * 200,
          onComplete: () => p.destroy(),
        });
      }
    } else if (kind === "aoe") {
      explosion(this, px, pl.y - 6, 30);
      sfx.boom();
      this.cameras.main.shake(140, 0.01);
      this.freeze = Math.max(this.freeze, 0.06);
    } else if (kind === "projectile") {
      hitSpark(this, px + pl.body.facing * 10, py, color, 5);
    }
  }

  // ── combat resolution ──────────────────────────────────────────────────────
  // One player's melee / special / stomp against every enemy + the boss.
  private playerOffense(pl: Player) {
    const pb = pl.body;
    const cs = this.cs(pl);
    const ab = pb.attackBox();
    if (ab) {
      if (pb.swingId !== cs.lastSwing) {
        cs.hitSwing.clear();
        cs.lastSwing = pb.swingId;
      }
      for (const e of this.enemies) {
        if (e.body.dead || cs.hitSwing.has(e)) continue;
        if (rectsOverlap(ab, e.body.hurtBox())) {
          const dir = Math.sign(e.body.x - pb.x) || pb.facing;
          e.body.takeHit(this.dmgOut(ab.dmg), ab.kb, dir);
          cs.hitSwing.add(e);
          if (!e.body.dead) sfx.hit();
          hitSpark(this, e.body.x, e.body.y - e.body.kind.h / 2, COLORS.teal, e.body.dead ? 10 : 6);
          this.freeze = Math.max(this.freeze, e.body.dead ? 0.09 : 0.05);
          this.cameras.main.shake(70, e.body.dead ? 0.006 : 0.003);
          if (e.body.dead) this.onKill(e);
        }
      }
      if (
        this.boss &&
        !this.boss.body.dead &&
        pb.swingId !== cs.bossSwing &&
        rectsOverlap(ab, this.boss.body.hurtBox())
      ) {
        cs.bossSwing = pb.swingId;
        this.hitBoss(
          this.dmgOut(ab.dmg),
          Math.sign(this.boss.body.x - pb.x) || pb.facing,
          COLORS.teal,
        );
      }
    }

    // player special: AoE box, launched shot, self-heal
    const sb = pb.specialBox();
    if (sb) {
      if (pb.specialId !== cs.lastSpecial) {
        cs.hitSpecial.clear();
        cs.lastSpecial = pb.specialId;
      }
      for (const e of this.enemies) {
        if (e.body.dead || cs.hitSpecial.has(e)) continue;
        if (rectsOverlap(sb, e.body.hurtBox())) {
          e.body.takeHit(this.dmgOut(sb.dmg), sb.kb, Math.sign(e.body.x - pb.x) || pb.facing);
          cs.hitSpecial.add(e);
          if (!e.body.dead) sfx.hit();
          hitSpark(this, e.body.x, e.body.y - e.body.kind.h / 2, pl.color, 8);
          this.freeze = Math.max(this.freeze, 0.06);
          if (e.body.dead) this.onKill(e);
        }
      }
      if (
        this.boss &&
        !this.boss.body.dead &&
        pb.specialId !== cs.bossSpecial &&
        rectsOverlap(sb, this.boss.body.hurtBox())
      ) {
        cs.bossSpecial = pb.specialId;
        this.hitBoss(
          this.dmgOut(sb.dmg),
          Math.sign(this.boss.body.x - pb.x) || pb.facing,
          pl.color,
        );
      }
    }
    if (pb.pendingShot) {
      const s = pb.pendingShot;
      this.spawnShot(s.x, s.y, s.vx, s.vy, s.dmg);
      pb.pendingShot = null;
    }
    if (pb.pendingHeal > 0) {
      this.heal(pb.pendingHeal);
      popText(this, pb.x, pb.y - 26, "+HP", "#34e5c8");
      pb.pendingHeal = 0;
    }

    if (pb.vy > 20) {
      for (const e of this.enemies) {
        if (e.body.dead) continue;
        const top = e.body.y - e.body.kind.h;
        if (pb.y <= top + 8 && pb.y >= top - 12 && Math.abs(pb.x - e.body.x) < e.body.kind.hw + 6) {
          e.body.takeHit(this.dmgOut(2), 60, Math.sign(pb.vx) || 1);
          pb.bounce();
          sfx.hit();
          hitSpark(this, e.body.x, top, COLORS.white, 8);
          this.freeze = Math.max(this.freeze, 0.08);
          this.cameras.main.shake(80, 0.006);
          if (e.body.dead) this.onKill(e);
        }
      }
      if (this.boss && !this.boss.body.dead) {
        const top = this.boss.body.hurtBox().top;
        if (pb.y <= top + 10 && pb.y >= top - 16 && Math.abs(pb.x - this.boss.body.x) < 22) {
          this.hitBoss(1, Math.sign(pb.vx) || 1, COLORS.white);
          pb.bounce();
          this.freeze = Math.max(this.freeze, 0.06);
        }
      }
    }
  }

  // Enemy attacks / contact / blasts against every live player. Enemy intents
  // (projectile spawn, blast) fire once regardless of player count.
  private enemyOffense() {
    for (const e of this.enemies) {
      const eb = e.body;
      if (!eb.dead) {
        const atk = eb.attackBox();
        for (const pl of this.livePlayers()) {
          const pb = pl.body;
          if (pb.dead) continue;
          if (atk && rectsOverlap(atk, pb.hurtBox()))
            this.hurtPlayer(atk.dmg, Math.sign(pb.x - eb.x) || 1, pl);
          else if (eb.contactDamage() > 0 && rectsOverlap(eb.hurtBox(), pb.hurtBox()))
            this.hurtPlayer(eb.contactDamage(), Math.sign(pb.x - eb.x) || 1, pl);
        }
      }
      if (eb.pendingProjectile) {
        this.spawnArrow(
          eb.pendingProjectile.x,
          eb.pendingProjectile.y,
          eb.pendingProjectile.vx,
          eb.pendingProjectile.vy,
          eb.kind.attackDmg ?? 1,
        );
        eb.pendingProjectile = null;
      }
      if (eb.pendingBlast) {
        const b = eb.pendingBlast;
        explosion(this, b.x, b.y, b.r);
        sfx.boom();
        this.cameras.main.shake(160, 0.01);
        this.freeze = Math.max(this.freeze, 0.06);
        for (const pl of this.livePlayers()) {
          if (!pl.body.dead && Math.hypot(pl.x - b.x, pl.y - eb.kind.h / 2 - b.y) < b.r + 8)
            this.hurtPlayer(b.dmg, Math.sign(pl.x - b.x) || 1, pl);
        }
        eb.pendingBlast = null;
      }
    }
  }

  private onKill(e: Enemy) {
    this.gainGold(2);
    impactRing(this, e.body.x, e.body.y - e.body.kind.h / 2, COLORS.teal, 22);
    sfx.kill();
    if (this.mods.lifesteal > 0 && Math.random() < this.mods.lifesteal) this.heal(1);
    popText(this, e.body.x, e.body.y - e.body.kind.h, "+2", "#ffd15c");
  }

  // Damage lands on a specific player's body; hearts are a shared co-op pool.
  private hurtPlayer(dmg: number, dir: number, pl: Player = this.player) {
    if (!pl.body.applyHurt(dir)) return;
    if (this.mods.armor > 0 && Math.random() < this.mods.armor) {
      popText(this, pl.x, pl.y - 24, "WARD", "#9b8cff");
      return; // fully blocked (i-frames already granted by applyHurt)
    }
    this.hearts -= dmg;
    this.freeze = Math.max(this.freeze, 0.06);
    hitSpark(this, pl.x, pl.y - 11, COLORS.magenta, 8);
    this.updateHud();
    if (this.hearts <= 0) this.playerDie();
  }

  private playerDie() {
    this.hearts = 0;
    this.state = "dead";
    this.deadT = 0;
    this.player.sprite.play(`${this.heroName}:death`);
    sfx.die();
    // Push one final hearts=0 snapshot so the guest sees the shared death.
    if (this.role === "host" && this.session)
      this.session.patchShared({ snap: this.encodeSnapshot() });
    const earned = bankRun(loadMeta(), this.gold, this.run.depth, this.run.biome);
    this.showBanner(`YOU FELL   +${earned} ✦`, 2200);
  }

  // ── features (rest fountain / treasure cache) ───────────────────────────────
  private stepFeature() {
    const f = this.feature;
    if (!f || f.used) return;
    const box = { left: f.x - 10, top: f.y - 20, right: f.x + 10, bottom: f.y };
    if (!this.livePlayers().some((pl) => rectsOverlap(box, pl.body.hurtBox()))) return;
    f.used = true;
    this.tweens.add({
      targets: f.g,
      alpha: 0,
      y: f.y - 6,
      duration: 400,
      onComplete: () => f.g.destroy(),
    });
    if (this.run.type === "rest") {
      this.heal(2);
      popText(this, f.x, f.y - 22, "+HP", "#34e5c8");
    } else {
      // treasure cache: a free relic (or gold if the player owns them all).
      const [relic] = pickRelics(1, this.ownedRelics);
      if (relic) {
        this.applyRelic(relic);
        popText(this, f.x, f.y - 22, relic.name, "#ffd15c");
      } else {
        this.gainGold(20);
        popText(this, f.x, f.y - 22, "+20", "#ffd15c");
      }
    }
    this.updateHud();
  }

  // ── arrows ─────────────────────────────────────────────────────────────────
  private spawnArrow(x: number, y: number, vx: number, vy: number, dmg: number) {
    const spr = this.add.sprite(x, y, "fx:arrow").setScale(0.3).setDepth(40);
    spr.setFlipX(vx < 0);
    this.arrows.push({ spr, x, y, vx, vy, life: 3, dmg });
  }

  private stepArrows(dt: number) {
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      if (!a) continue;
      a.vy += ARROW_GRAV * dt;
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.life -= dt;
      a.spr.setPosition(Math.round(a.x), Math.round(a.y));
      a.spr.setRotation(Math.atan2(a.vy, a.vx) + (a.vx < 0 ? Math.PI : 0));
      const hitWall = this.grid.solidInRect(a.x - 2, a.y - 2, a.x + 2, a.y + 2);
      const box = { left: a.x - 3, top: a.y - 3, right: a.x + 3, bottom: a.y + 3 };
      let hitPlayer = false;
      for (const pl of this.livePlayers()) {
        if (!pl.body.dead && rectsOverlap(box, pl.body.hurtBox())) {
          this.hurtPlayer(a.dmg, Math.sign(a.vx) || 1, pl);
          hitPlayer = true;
        }
      }
      if (a.life <= 0 || hitWall || hitPlayer) {
        if (hitWall) hitSpark(this, a.x, a.y, COLORS.magenta, 3);
        a.spr.destroy();
        this.arrows.splice(i, 1);
      }
    }
  }

  // ── player shots (Salamander flame-wave) ────────────────────────────────────
  private spawnShot(x: number, y: number, vx: number, vy: number, dmg: number) {
    const spr = this.add.sprite(x, y, "fx:flame-wave").setScale(0.7).setDepth(42);
    spr.play("fx:flame-wave");
    spr.setFlipX(vx < 0);
    this.shots.push({ spr, x, y, vx, vy, life: 1.4, dmg, hit: new Set(), hitBoss: false });
  }

  private stepShots(dt: number) {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      if (!s) continue;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt;
      s.spr.setPosition(Math.round(s.x), Math.round(s.y));
      for (const e of this.enemies) {
        if (e.body.dead || s.hit.has(e)) continue;
        if (
          rectsOverlap(
            { left: s.x - 12, top: s.y - 8, right: s.x + 12, bottom: s.y + 8 },
            e.body.hurtBox(),
          )
        ) {
          e.body.takeHit(this.dmgOut(s.dmg), 120, Math.sign(s.vx) || 1);
          s.hit.add(e);
          if (!e.body.dead) sfx.hit();
          hitSpark(this, e.body.x, e.body.y - e.body.kind.h / 2, COLORS.magenta, 6);
          if (e.body.dead) this.onKill(e);
        }
      }
      if (
        this.boss &&
        !this.boss.body.dead &&
        !s.hitBoss &&
        rectsOverlap(
          { left: s.x - 12, top: s.y - 8, right: s.x + 12, bottom: s.y + 8 },
          this.boss.body.hurtBox(),
        )
      ) {
        this.hitBoss(this.dmgOut(s.dmg), Math.sign(s.vx) || 1, COLORS.magenta);
        s.hitBoss = true;
      }
      const hitWall = this.grid.solidInRect(s.x - 4, s.y - 4, s.x + 4, s.y + 4);
      if (s.life <= 0 || hitWall) {
        s.spr.destroy();
        this.shots.splice(i, 1);
      }
    }
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  private cullEnemies(dt: number) {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e || !e.body.dead) continue;
      const t = (this.deadTimers.get(e) ?? 0) + dt;
      this.deadTimers.set(e, t);
      if (t > DEATH_LINGER) {
        e.sprite.setAlpha(Math.max(0, 1 - (t - DEATH_LINGER) * 4));
        if (t > DEATH_LINGER + 0.25) {
          e.destroy();
          this.enemies.splice(i, 1);
        }
      }
    }
  }

  private checkClear() {
    if (!this.mustClear || this.cleared) return;
    const enemiesDone = this.enemies.every((e) => e.body.dead);
    const bossDone = this.boss ? this.boss.body.dead && this.bossDeadT > 0.9 : true;
    if (enemiesDone && bossDone) {
      this.cleared = true;
      this.doors.forEach((d) => d.setActive(true));
      this.showBanner(this.boss ? "DESCEND" : "CLEAR — pick a path", 1400);
    }
  }

  private checkDoors() {
    if (!this.cleared || this.state !== "active") return;
    for (const d of this.doors) {
      if (
        d.active &&
        this.livePlayers().some((pl) => rectsOverlap(d.triggerRect(), pl.body.hurtBox()))
      ) {
        this.enterDoor(d.index);
        return;
      }
    }
  }

  private enterDoor(index: number) {
    const offer = this.offers[index];
    if (!offer || this.state !== "active") return;
    this.state = "transition";
    this.transT = 0;
    this.transBuilt = false;
    this.pendingOffer = offer;
    sfx.door();
  }

  private showBanner(text: string, ms: number) {
    this.banner.setText(text).setAlpha(1);
    this.tweens.killTweensOf(this.banner);
    this.tweens.add({ targets: this.banner, alpha: 0, delay: ms, duration: 350 });
  }

  private updateHud() {
    const h = Math.max(0, this.hearts);
    this.heartsText.setText("♥ ".repeat(h) + "♡ ".repeat(Math.max(0, this.maxHearts - h)));
    const relics = this.ownedRelics.size > 0 ? `   ✦ ${this.ownedRelics.size}` : "";
    const biome = this.role === "guest" ? this.netBiome : this.run.biome;
    const depth = this.role === "guest" ? this.netDepth : this.run.depth;
    this.infoText.setText(`BIOME ${biome}   DEPTH ${depth}   ⬡ ${this.gold}${relics}`);
  }
}
