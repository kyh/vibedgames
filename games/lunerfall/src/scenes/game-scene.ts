import Phaser from "phaser";

import {
  attachVirtualGamepad,
  type ButtonOptions,
  type PhaserGamepad,
  type Viewport,
} from "@vibedgames/gamepad/phaser";

import { sfx } from "../audio/sfx";
import { BASE_H, BASE_W, COLORS, TILE } from "../config";
import { type EnemyName, ENEMY_NAMES, HERO_NAMES, type HeroName } from "../data/animations";
import { type Affix, AFFIXES, rollAffix } from "../data/affixes";
import { type BiomePalette, biomePalette, enemyPool } from "../data/biomes";
import { bossKind } from "../data/bosses";
import { ENEMIES } from "../data/enemies";
import { type HeroDef, HEROES } from "../data/heroes";
import { bankRun, loadMeta, recordBestScore, runBonuses } from "../data/meta";
import {
  baseMods,
  pickRelics,
  RARITY_COLOR,
  RELICS,
  type Relic,
  type RunMods,
} from "../data/relics";
import { parseRoomType, type RoomDef, ROOM_LABEL, type RoomType, VERSUS } from "../data/rooms";
import type { RunRecap } from "../data/run-recap";
import { Boss } from "../entities/boss";
import { Door } from "../entities/door";
import { Enemy } from "../entities/enemy";
import { Player } from "../entities/player";
import { rectsOverlap } from "../entities/player-body";
import { specialReadiness, type SpecialReadiness } from "../data/special-readiness";
import { isJsonObject, isJsonString } from "../net/json";
import type { JsonValue } from "../net/json";
import { Reconciler } from "../net/predict";
import { NetSession } from "../net/session";
import {
  readCheckpoint,
  type CheckpointSeats,
  type CheckpointRead,
  type ExpeditionCheckpoint,
  type CheckpointPlayer,
  type CheckpointPhase,
  type InputSequence,
} from "../net/checkpoint";
import {
  isSnapshot,
  type NetBoss,
  type NetDoor,
  type NetEnemy,
  type NetInput,
  type NetLastStand,
  type NetPlayer,
  type NetProj,
  type NetRoom,
  type NetVersus,
  type Snapshot,
} from "../net/snapshot";
import { buildParallax, FG_TREE_NAME } from "../parallax";
import { PixelSky } from "../render/pixel-sky";
import { ExpeditionHud, type ExpeditionOffer } from "../expedition-hud";
import { drawRoom } from "../room";
import {
  ambientEmbers,
  clearFx,
  dust,
  explosion,
  hitSpark,
  impactRing,
  popText,
  wallSmoke,
} from "../sys/fx";
import { diag } from "../sys/diag";
import { Grid } from "../sys/grid";
import { checkpointRng, restoreRng, rand, reseed, unseed } from "../sys/rng";
import { type Offer, RunManager } from "../sys/run";
import { Input, type InputState } from "../sys/input";
import { gameInset, isCoarse, touchHudBand } from "../sys/screen";
import { mountTouchHud, syncTouchHud } from "../touch-hud";
import {
  VersusMatch,
  VS_BIOME,
  VS_HEARTS,
  VS_WIN_SCORE,
  vsPhaseFrozen,
  type VsSide,
} from "../sys/versus";

const STEP = 1 / 60;
const MAX_STEPS = 5;
const MAX_HEARTS = 4;
const COMBO_WINDOW = 3; // seconds a kill-streak survives without a new kill
const DEATH_LINGER = 0.55;
const ARROW_GRAV = 150;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

type BannerKind = "status" | "objective" | "arrival" | "payoff" | "critical" | "connecting";
const BANNER_PRIORITY = {
  status: 0,
  objective: 1,
  arrival: 2,
  payoff: 3,
  critical: 4,
  connecting: 4,
} satisfies Record<BannerKind, number>;
type BannerEntry = { kind: BannerKind; text: string; hold: number; age: number };
type PendingObjective = { text: string; hold: number; remaining: number };

// Co-op last stand: a fatal hit with both players up downs the victim instead of
// wiping; the partner has BLEED_DUR to hold within REVIVE_RANGE for REVIVE_HOLD.
const BLEED_DUR = 7; // s a downed player survives awaiting a revive
const REVIVE_HOLD = 1.2; // s of sustained rescuer overlap to complete a revive
const REVIVE_RANGE = 22; // px around the downed body that counts as reviving
const REVIVE_HEARTS = 2; // shared hearts restored on revive

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
  owner: Player | null; // caster — a shot never hits its own thrower (versus)
  hit: Set<Enemy>;
  hitP: Set<Player>; // versus: per-duelist hit dedup
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
const CHECKPOINT_HZ = 10; // full private state; takeover rewinds at most one 100 ms interval
type CheckpointMark = {
  phase: CheckpointPhase["kind"] | "transition-built";
  versus: NetVersus["phase"] | null;
};
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

// Boundary parsers — validate wire JSON values into our types without casts.
const num = (v: JsonValue | undefined): v is number => Number.isFinite(v);
const bool = (v: JsonValue | undefined): v is boolean => v === true || v === false;
function readNetInput(v: JsonValue | undefined): NetInput | null {
  if (!isJsonObject(v)) return null;
  const o = v;
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
const parseHero = (v: JsonValue | undefined): HeroName | null =>
  HERO_NAMES.find((h) => h === v) ?? null;
const parseEnemy = (v: string): EnemyName => ENEMY_NAMES.find((e) => e === v) ?? "warrior";
const readSnapshot = (shared: Record<string, JsonValue> | null): Snapshot | null => {
  const s = shared?.snap;
  return isSnapshot(s) ? s : null;
};

// Themed animated prop per non-combat room type. ox/oy = frame-fractional origin
// aligning the art's bottom-centre to the floor; scale shrinks the 144px canvases.
const ROOM_PROPS = new Map<RoomType, { key: string; ox: number; oy: number; scale: number }>([
  ["start", { key: "blue-flag", ox: 0.5, oy: 0.66, scale: 0.7 }],
  ["rest", { key: "blue-fountain", ox: 0.49, oy: 0.77, scale: 0.5 }],
  ["merchant", { key: "blue-campfire", ox: 0.52, oy: 0.73, scale: 1.2 }],
  ["treasure", { key: "blue-columnfire", ox: 0.5, oy: 0.66, scale: 0.75 }],
]);
type SceneState = "active" | "dead" | "transition" | "connecting";

// An on-screen action button — a ButtonOptions that definitely has a place and
// a size, so the cluster it belongs to can be measured.
type FixedButton = ButtonOptions & {
  position: NonNullable<ButtonOptions["position"]>;
  radius: number;
};

/** Top-left corner of the action cluster's bounding box, with thumb padding. */
const clusterBounds = (buttons: FixedButton[], v: Viewport) => {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  for (const b of buttons) {
    const c = b.position(v);
    left = Math.min(left, c.x - b.radius);
    top = Math.min(top, c.y - b.radius);
  }
  return { left: left - 10, top: top - 10 };
};

// Phase 5: run-driven scene. RunManager stitches typed rooms; the scene builds
// each room (tiles, enemies, doors, features), resolves combat, and transitions
// through torii doors on the player's chosen path.
export class GameScene extends Phaser.Scene {
  private run = new RunManager();
  private grid!: Grid;
  private player!: Player;
  private controls!: Input;
  private gamepad!: PhaserGamepad;
  private touch = false;
  private acc = 0;

  private roomLayer?: Phaser.GameObjects.Container;
  private parallax: Phaser.GameObjects.GameObject[] = [];
  private sky?: PixelSky;
  private expeditionHud?: ExpeditionHud;
  private fogRect?: Phaser.GameObjects.Rectangle; // per-biome atmosphere wash
  private flashedBiome = 0; // last biome we announced, so a descent flashes the new name
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
  private requestedHero: HeroName = "axion";

  // Co-op: the local player is always `this.player`; `this.remote` is the other
  // player when connected. Combat runs per-player with its own hit-dedup state.
  private remote?: Player;
  private combat = new WeakMap<Player, CombatState>();

  // Online versus (mode "versus"): host runs the pure match machine; guests
  // mirror its broadcast into netVs. Both null/idle in solo and co-op.
  private mode: "coop" | "versus" = "coop";
  private vs: VersusMatch | null = null; // host-authoritative match state
  private netVs: NetVersus | null = null; // guest: from the snapshot
  private vsSpawns: { x: number; y: number }[] = []; // [host, guest], mirrored
  private vsHitSeq = new WeakMap<Player, { swing: number; special: number }>();
  private vsOpponentGone = false; // guest: opponent-left banner fired

  // Co-op last stand (host-simulated): the downed player + its bleed-out clock
  // and revive-hold progress. Guests mirror the broadcast into netLastStand.
  private lastStand: { pl: Player; bleedT: number; reviveT: number } | null = null;
  private netLastStand: NetLastStand | null = null; // guest: from the snapshot
  private lsG?: Phaser.GameObjects.Graphics; // downed marker (ring + bars)
  private lsLabel?: Phaser.GameObjects.Text;

  // Networking (undefined = solo). Host runs the authoritative sim + broadcasts;
  // guest renders the broadcast, predicting only its OWN body (bodyDrive).
  private session?: NetSession;
  private role: "solo" | "host" | "guest" = "solo";
  private authority:
    | { kind: "waiting" }
    | { kind: "ready"; runId: string; term: number; revision: number } = { kind: "waiting" };
  private seats: CheckpointSeats = { host: null, guest: null };
  private remoteId: string | null = null;
  private roomDirty = false;
  private controlsPaused = false;
  private wasConnected = false;
  private seenDisconnect = 0;
  private neutralOnAdmission = false;
  private remoteInputOwner: { id: string; active: boolean } | null = null;
  private checkpointRef: JsonValue | undefined;
  private checkpointRoomRef: JsonValue | undefined;
  private checkpointCache: CheckpointRead = { kind: "absent" };
  private adoptedTerminal: ExpeditionCheckpoint | null = null;
  private restartRequested = false;
  private restartSentFor: string | null = null;

  private roomSeq = 0; // host: bumped per room, drives guest room rebuilds
  private netT = 0; // host: snapshot counter
  private netAcc = 0; // host: broadcast throttle
  private checkpointAcc = 0;
  private checkpointMark: CheckpointMark | null = null;
  private guestRoomSeq = -1; // guest: room seq it has built
  private guestSnapT = -1; // guest: last snapshot applied
  private netProj: Phaser.GameObjects.Sprite[] = []; // guest: projectile puppets
  private enemyId = new WeakMap<Enemy, number>(); // host: stable wire id per enemy
  private enemyIdNext = 1;
  private outSeq = { j: 0, d: 0, a: 0, s: 0 }; // my press counters (sent to host)
  private inSeq = { j: 0, d: 0, a: 0, s: 0 }; // host: last-seen remote press counters
  private enemyPuppets = new Map<number, { view: Enemy; net: NetEnemy }>(); // guest
  private bossPuppet?: { view: Boss; net: NetBoss }; // guest
  private guestCueBaseline = true;
  private guestProgressTick = -1;
  private guestSpecial: SpecialReadiness = { kind: "unknown" };
  private netPlayers: NetPlayer[] = []; // guest: latest wire players (re-lerped each frame)
  // Guest prediction: my own body runs the real fixed-step sim on local input
  // (instant response); each snapshot's authoritative copy folds back in here.
  private reconciler = new Reconciler();
  private guestIn: InputState = NEUTRAL_INPUT; // this frame's local sample (guest)
  private netSelfHurting = false; // my player's hurting flag last snapshot (edge detect)
  private roomSpawn = { x: 0, y: 0 };
  private netBiome = 1; // guest: HUD biome/depth (host uses this.run)
  private netDepth = 1;
  private netRoomType: RoomType = "combat";
  private guestPayoff: { room: number; t: number; cleared: boolean; bossAlive: boolean } | null =
    null;

  private mustClear = false;
  private cleared = false;
  private mods: RunMods = baseMods();
  private ownedRelics = new Set<string>();
  private merchantItems: MerchantItem[] = [];
  private maxHearts = MAX_HEARTS;
  private hearts = MAX_HEARTS;
  private gold = 0;
  private score = 0;
  private combo = 0; // consecutive-kill streak within COMBO_WINDOW
  private comboT = 0; // seconds left before the streak lapses
  private comboText!: Phaser.GameObjects.Text;
  private lastCrit = false; // set by dmgOut so the hit site can flag a crit
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
  private activeBanner: BannerEntry | null = null;
  private pendingObjective: PendingObjective | null = null;
  private bossAnnounced = false;
  private runRecap: RunRecap | null = null;

  // ── trailer mode (src/trailer/trailer-director.ts) ─────────────────────────
  // Both stay unset in normal play: only the trailer director — lazy-loaded
  // behind the ?trailer=1 check in main.ts — writes them via the trailer*
  // methods at the bottom of this class, so all of it is dead code otherwise.
  private trailerActive = false;
  private trailerIn: (() => TrailerInputs) | null = null;
  // Authored (unzoomed) position of every screen-pinned object, so trailerZoom
  // can re-derive the counter-transform from scratch on each shot.
  private trailerPinBase = new WeakMap<Phaser.GameObjects.GameObject, { x: number; y: number }>();
  // Scale every pinned object currently sits at (1/zoom). Anything that animates
  // a pinned object's scale has to multiply through this, or the tween's
  // absolute target silently undoes the counter-transform. 1 in normal play.
  private trailerPinScale = 1;

  private demo = false;
  private demoT = 0;
  private prevJump = false;
  private prevDash = false;
  private prevAtk = false;
  private prevSpecial = false;

  constructor() {
    super("game");
  }

  /**
   * True only when connected to a real party room (not the solo fallback) —
   * used by the wrapper's pause handler so it never freezes a co-op/versus
   * session another player is relying on.
   */
  isOnline(): boolean {
    return this.session !== undefined && !this.session.offline;
  }

  /** Versus binds Escape to "leave the duel" — the wrapper pause defers to it. */
  isVersus(): boolean {
    return this.mode === "versus";
  }

  create() {
    this.runRecap = null;
    this.activeBanner = null;
    this.pendingObjective = null;
    this.bossAnnounced = false;
    const params = new URLSearchParams(location.search);
    this.demo = params.get("demo") === "1";
    const data = this.scene.settings.data;
    const dataHero = data instanceof Object && "hero" in data ? data.hero : undefined;
    const wanted = params.get("hero") ?? dataHero ?? this.registry.get("hero");
    this.heroName = HERO_NAMES.find((h) => h === wanted) ?? "axion";
    this.requestedHero = this.heroName;
    this.mods = baseMods();
    // Fold in permanent meta upgrades bought in the hub (host/solo; a guest's
    // hearts are then overwritten by the host snapshot).
    const bonus = runBonuses(loadMeta());
    this.mods.dmg += bonus.dmg;
    this.mods.armor += bonus.armor;
    this.mods.maxHearts += bonus.hearts;
    this.ownedRelics = new Set();
    this.merchantItems = [];
    this.maxHearts = this.mods.maxHearts;
    this.hearts = this.maxHearts;
    this.gold = 0;
    this.score = 0;
    this.combo = 0;
    this.comboT = 0;
    this.flashedBiome = 0; // reset so a new run never flashes its starting biome
    this.state = "active";
    // Phaser reuses the scene instance across start(): the old display list is
    // gone but fields still point at destroyed sprites, so every net puppet is
    // dropped here rather than trusted.
    this.remote = undefined;
    this.remoteId = null;
    this.netPlayers = [];
    this.enemyPuppets.clear();
    this.netProj = [];
    this.doors = [];
    this.enemies = [];
    this.arrows = [];
    this.shots = [];
    this.hazards = [];
    this.boss = null;
    this.feature = null;
    this.lastStand = null;
    this.netLastStand = null;
    this.lsG = undefined;
    this.lsLabel = undefined;
    this.mode = "coop";
    this.vs = null;
    this.netVs = null;
    this.vsSpawns = [];
    this.vsHitSeq = new WeakMap();
    this.vsOpponentGone = false;
    this.reconciler.reset();
    this.guestIn = NEUTRAL_INPUT;
    this.netSelfHurting = false;
    // Scene instances persist across start/stop: never leak a previous online
    // run's role/session into this one (solo must not take the guest path).
    this.role = "solo";
    this.session = undefined;
    // A run that adopted a seeded stream (online checkpoint, test seed) would
    // otherwise replay it here.
    const dataSeed = data instanceof Object && "seed" in data ? data.seed : undefined;
    if (Number.isFinite(dataSeed)) reseed(Number(dataSeed));
    else unseed();
    this.authority = { kind: "waiting" };
    this.adoptedTerminal = null;
    this.seats = { host: null, guest: null };
    this.remoteId = null;
    this.wasConnected = false;
    this.seenDisconnect = 0;
    this.neutralOnAdmission = false;
    this.remoteInputOwner = null;
    this.checkpointRef = undefined;
    this.checkpointRoomRef = undefined;
    this.checkpointCache = { kind: "absent" };
    this.restartRequested = this.registry.get("restartExpedition") === true;
    this.registry.set("restartExpedition", false);
    this.restartSentFor = null;
    this.outSeq = { j: 0, d: 0, a: 0, s: 0 };
    this.inSeq = { j: 0, d: 0, a: 0, s: 0 };
    this.guestRoomSeq = -1;
    this.guestSnapT = -1;
    this.netPlayers = [];
    this.acc = 0;

    this.sky = new PixelSky(this, BASE_W, BASE_H);
    // Thin full-field atmosphere wash, over the world but under the HUD — the
    // cheapest way to make a biome's light read on every tile and silhouette.
    this.fogRect = this.add
      .rectangle(0, 0, BASE_W, BASE_H, 0x000000, 0)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(60);

    this.fadeRect = this.add
      .rectangle(0, 0, BASE_W, BASE_H, 0x05070b)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(100)
      .setAlpha(0);

    // Edge-anchored HUD clears the notch/home indicator (safe-area insets) and,
    // top-right, the DOM pause/mute cluster.
    const ins = gameInset(this);
    const hudBand = touchHudBand(this);
    this.heartsText = this.add
      .text(8 + ins.left, 6 + ins.top, "", {
        fontFamily: "monospace",
        fontSize: "12px",
        color: "#ff4d6d",
      })
      .setScrollFactor(0)
      .setDepth(80);
    this.infoText = this.add
      .text(BASE_W - 8 - ins.right, 7 + ins.top + hudBand, "", {
        fontFamily: "monospace",
        fontSize: "9px",
        color: "#8b95a1",
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(80);
    this.expeditionHud = new ExpeditionHud(this, this.heartsText, this.infoText);
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
    // Kill-streak multiplier, top-centre; grows and warms as the streak climbs.
    this.comboText = this.add
      .text(BASE_W / 2, 30, "", { fontFamily: "monospace", fontSize: "14px", color: "#ffd15c" })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(81)
      .setAlpha(0);

    const regParty: JsonValue = this.registry.get("party");
    const party = (params.get("party") ?? (isJsonString(regParty) ? regParty : ""))
      .trim()
      .toUpperCase();
    const regMode: JsonValue = this.registry.get("mode");
    const modeStr = params.get("mode") ?? (isJsonString(regMode) ? regMode : "");
    if (party.length > 0 && modeStr === "vs") this.mode = "versus";

    // Touch controls: floating stick (movement + down-to-drop) on any free
    // touch, fixed action cluster bottom-right, EXIT (versus only) top-right.
    // Mouse is ignored — desktop keeps the keyboard scheme.
    // Positions are game-space px (the adapter's viewport is the FIT game
    // size); insets keep the cluster clear of the home indicator.
    this.touch = isCoarse();
    const cluster: FixedButton[] = [
      {
        id: "jump",
        label: "JUMP",
        radius: 21,
        position: (v) => ({ x: v.width - 30 - v.inset.right, y: v.height - 34 - v.inset.bottom }),
      },
      {
        id: "atk",
        label: "ATK",
        radius: 18,
        position: (v) => ({ x: v.width - 76 - v.inset.right, y: v.height - 26 - v.inset.bottom }),
      },
      {
        id: "dash",
        label: "DASH",
        radius: 15,
        position: (v) => ({ x: v.width - 34 - v.inset.right, y: v.height - 82 - v.inset.bottom }),
      },
      {
        id: "sp",
        label: "SP",
        radius: 15,
        position: (v) => ({ x: v.width - 82 - v.inset.right, y: v.height - 70 - v.inset.bottom }),
      },
    ];
    const buttons: ButtonOptions[] = [...cluster];
    if (this.mode === "versus")
      buttons.push({
        id: "exit",
        label: "EXIT",
        radius: 15,
        position: (v) => ({ x: v.width - 24 - v.inset.right, y: 44 + v.inset.top + hudBand }),
      });
    this.gamepad = attachVirtualGamepad(this, {
      visible: "coarse",
      stick: {
        radius: 40,
        deadZone: 8,
        knobRadius: 14,
        // Over a pit, a thumb that reaches for DASH, lands in the gap between
        // two buttons and slides would otherwise read as a full-speed run.
        region: (p, v) => {
          const bounds = clusterBounds(cluster, v);
          return p.x < bounds.left || p.y < bounds.top;
        },
      },
      render: { depth: 90, blendMode: Phaser.BlendModes.NORMAL },
      buttons,
      onButtonDown: (id) => {
        if (id === "exit") this.scene.start("select");
      },
    });
    // Touch has no Escape and no M: @repo/embed's cluster carries both. The
    // trailer plays itself and owns its own chrome, so it opts out (main.ts
    // keeps the hub's mute-only cluster off there for the same reason).
    if (!params.has("trailer")) {
      mountTouchHud(true);
    }
    this.controls = new Input(this, this.gamepad);
    if (party.length > 0 && !this.demo) {
      // Co-op: connect, then let update() resolve host vs guest. The player spawns
      // on an empty grid so it's always defined; the real room arrives once the
      // host begins the run (host) or the first room snapshot lands (guest).
      this.role = "guest"; // provisional until the connection reports host
      this.state = "connecting";
      this.player = this.spawnPlayer(HEROES[this.heroName], new Grid(), BASE_W / 2, BASE_H / 2);
      this.player.sprite.setVisible(false);
      this.fadeRect.setAlpha(1);
      this.showBanner("CONNECTING…", 100000, "connecting");
      this.session = new NetSession({
        room: `lunerfall-${this.mode === "versus" ? "vs" : "coop"}-${party}`,
        maxPlayers: 2,
        fallbackMs: 6000,
      });
    } else {
      const roomParam = parseRoomType(new URLSearchParams(location.search).get("room") ?? "");
      const def = roomParam ? this.run.debugEnter(roomParam) : this.run.begin();
      // Dev: ?biome=N previews a deeper biome's palette + roster (debug rooms only).
      const biomeParam = Math.floor(Number(new URLSearchParams(location.search).get("biome")));
      if (roomParam && Number.isFinite(biomeParam) && biomeParam >= 1) this.run.biome = biomeParam;
      this.player = this.spawnPlayer(
        HEROES[this.heroName],
        def.grid,
        def.playerSpawn.x,
        def.playerSpawn.y,
      );
      this.buildRoom(def);
      this.updateHud();
    }

    // ?trailer=1: the shell's black lead-in only exists once the lazily-imported
    // director has landed, so the boot room above — and the room-label banner it
    // fires — would paint for a frame or two first. Hold the scene's own fade
    // plate (depth 100, over the HUD) until the first shot stages; trailerStage
    // clears it. Nothing else touches fadeRect on this path.
    if (params.has("trailer")) this.fadeRect.setAlpha(1);

    sfx.unlock();
    this.input.keyboard?.once("keydown", () => sfx.unlock());
    this.input.once("pointerdown", () => sfx.unlock());
    this.input.keyboard?.on("keydown-M", () => {
      sfx.toggleMute();
      syncTouchHud();
      this.showBanner(sfx.muted ? "SOUND OFF" : "SOUND ON", 700, "status");
    });
    // Versus has no death→hub exit (rounds respawn), so ESC leaves the duel.
    if (this.mode === "versus")
      this.input.keyboard?.on("keydown-ESC", () => this.scene.start("select"));

    // Death → hub: drop the socket and the hub gets its mute-only touch cluster back.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.controls.destroy();
      this.gamepad.destroy();
      this.session?.destroy();
      if (!params.has("trailer")) mountTouchHud(false);
    });
  }

  // Both players leave world-space cues; routine camera motion belongs to me.
  private shake(duration: number, intensity: number) {
    if (!REDUCED_MOTION.matches) this.cameras.main.shake(duration, intensity);
  }

  private spawnPlayer(hero: HeroDef, grid: Grid, x: number, y: number): Player {
    const pl: Player = new Player(this, grid, x, y, hero, {
      onLand: (impact) => {
        if (pl === this.player) this.shake(80, Math.min(0.003 + impact * 0.00002, 0.008));
        dust(this, pl.x, pl.y);
      },
      onDash: () => {
        if (pl === this.player) this.shake(60, 0.0025);
        sfx.dash(pl === this.player ? "local" : "routine");
      },
      // No painted attack VFX — the sprite-sheet swing carries the strike. Just
      // feel: a small camera shake + the swing sound.
      onSwing: () => {
        if (pl === this.player) this.shake(50, 0.0015);
        sfx.slash(pl === this.player ? "local" : "routine");
      },
      onSpecial: (kind) => this.onSpecialFx(kind, pl),
      onHurt: () => {
        if (pl === this.player) this.shake(180, 0.012);
        sfx.hurt(pl === this.player ? "essential" : "routine");
      },
      onJump: () => sfx.jump(pl === this.player ? "local" : "routine"),
      onWallJump: (side) => {
        wallSmoke(this, pl.x + side * 7, pl.y - 12, side);
        if (pl === this.player) this.shake(40, 0.002);
      },
    });
    return pl;
  }

  // ── room building ──────────────────────────────────────────────────────────
  // Tear down every per-room object (host sim entities + guest puppets alike).
  private teardownRoom() {
    this.clearBanners();
    this.bossAnnounced = false;
    clearFx(this);
    this.guestPayoff = null;
    this.guestCueBaseline = true;
    this.guestProgressTick = -1;
    this.guestSpecial = { kind: "unknown" };
    this.netPlayers = [];
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

  // Repaint the screen-pinned sky + atmosphere wash for a biome and return its
  // palette for the room/parallax build. Called on every room build, so
  // descending into a new biome recolours the whole world.
  private applyBiome(biome: number): BiomePalette {
    const pal = biomePalette(biome);
    this.sky?.setPalette(pal);
    this.fogRect?.setFillStyle(pal.fog, pal.fogA);
    return pal;
  }

  private buildRoom(def: RoomDef) {
    this.teardownRoom();
    this.grid = def.grid;
    const pal = this.applyBiome(this.run.biome);
    const enteredBiome = this.flashedBiome !== 0 && this.run.biome !== this.flashedBiome;
    this.flashedBiome = this.run.biome;
    this.parallax = buildParallax(this, def.grid.cols * TILE, def.grid.rows * TILE, pal);
    this.roomLayer = drawRoom(this, def.grid, pal).setDepth(0);
    this.decorateRoom(def);
    this.embers = ambientEmbers(this, pal.oneway, def.grid.cols * TILE, def.grid.rows * TILE);
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
    if (this.role === "host") this.roomDirty = true;
    // Boss rooms announce the boss by name in spawnBoss; don't overwrite it here.
    // Descending into a new biome announces the biome instead of the room label.
    if (this.run.type !== "boss") {
      if (enteredBiome) this.showBanner(`▼  ${pal.name}  ▼`, 1600, "status");
      else
        this.showBanner(
          this.mustClear ? ROOM_LABEL[this.run.type] : `${ROOM_LABEL[this.run.type]} — pick a path`,
          1100,
          "status",
        );
    }
  }

  // Versus (host): build the mirrored duel arena — no doors, enemies, features,
  // or run progression; both spawn points are kept for the per-round resets.
  private buildVersusRoom() {
    this.teardownRoom();
    const def = VERSUS();
    this.grid = def.grid;
    const pal = this.applyBiome(VS_BIOME);
    this.parallax = buildParallax(this, def.grid.cols * TILE, def.grid.rows * TILE, pal);
    this.roomLayer = drawRoom(this, def.grid, pal).setDepth(0);
    this.embers = ambientEmbers(this, COLORS.magenta, def.grid.cols * TILE, def.grid.rows * TILE);
    const mirror = { x: def.grid.cols * TILE - def.playerSpawn.x, y: def.playerSpawn.y };
    this.vsSpawns = [def.playerSpawn, mirror];
    this.roomSpawn = def.playerSpawn;
    this.player.enterRoom(def.grid, def.playerSpawn.x, def.playerSpawn.y);
    this.remote?.enterRoom(def.grid, mirror.x, mirror.y);
    this.setupCamera();
    this.mustClear = false;
    this.cleared = true;
    this.roomSeq++;
    if (this.role === "host") this.roomDirty = true;
    this.showBanner("VERSUS — WAITING FOR A CHALLENGER", 2600, "critical");
  }

  // Weighted-random enemy type, rolled per spawn so encounters vary run to run
  // (was a fixed roster → identical fights). Warriors dominate early; ranged and
  // heavy types get commoner in deeper biomes and elite rooms. Host-authoritative:
  // guests replicate whatever the host rolled via the enemy name on the wire.
  private pickEnemy(): EnemyName {
    const pool = enemyPool(this.run.biome, this.run.type === "elite");
    const total = pool.reduce((s, p) => s + p[1], 0);
    let r = rand() * total;
    for (const [name, w] of pool) {
      r -= w;
      if (r <= 0) return name;
    }
    return "warrior";
  }

  private spawnEnemies(def: RoomDef) {
    const elite = this.run.type === "elite";
    def.enemySpawns.forEach((s) => {
      const e = new Enemy(this, this.grid, ENEMIES[this.pickEnemy()], s.x, s.y);
      e.body.hp += Math.floor((this.run.biome - 1) / 2);
      if (elite) this.applyAffix(e);
      this.enemies.push(e);
    });
  }

  // Elite room: roll an affix onto an enemy — recolour it and bend its combat
  // multipliers (host-authoritative; guests render the puppet without the tint).
  // The affix parameter is only supplied by trailer staging; gameplay rolls.
  private applyAffix(e: Enemy, a: Affix = rollAffix()) {
    e.body.hp = Math.round(e.body.hp * a.hpMult) + 1;
    e.body.speedMult = a.speedMult;
    e.body.dmgTakenMult = a.dmgTakenMult;
    e.body.dmgOutMult = a.dmgOutMult;
    e.baseTint = a.tint;
    e.sprite.setTint(a.tint);
  }

  private spawnBoss(def: RoomDef) {
    const bx = def.bossSpawn?.x ?? BASE_W / 2;
    const by = def.bossSpawn?.y ?? (this.grid.rows - 3) * TILE;
    this.boss = new Boss(this, this.grid, bx, by, this.run.biome);
    this.bossDeadT = 0;
    const barCol = biomePalette(this.run.biome).oneway;
    this.bossHpBg = this.add
      .rectangle(BASE_W / 2, 47 + gameInset(this).top, 260, 6, 0x000000, 0.5)
      .setStrokeStyle(1, barCol, 0.6)
      .setScrollFactor(0)
      .setDepth(85);
    this.bossHp = this.add
      .rectangle(BASE_W / 2 - 129, 47 + gameInset(this).top, 258, 4, barCol)
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(86);
    this.announceBoss(this.run.biome);
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
    const cfg = ROOM_PROPS.get(this.run.type);
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
    offers.forEach((relic, i) => this.buildMerchantItem(relic, (0.3 + i * 0.2) * BASE_W, y, false));
  }

  /** Display construction only: replaying a checkpoint never rolls an offer. */
  private buildMerchantItem(relic: Relic, x: number, y: number, bought: boolean) {
    const col = RARITY_COLOR[relic.rarity];
    const hex = `#${col.toString(16).padStart(6, "0")}`;
    const g = this.add.container(x, y).setDepth(8);
    const glow = this.add.ellipse(0, -12, 24, 30, col, 0.2);
    const base = this.add.rectangle(0, 0, 16, 6, COLORS.stoneEdge).setOrigin(0.5, 1);
    const orb = this.add.circle(0, -16, 5, col, 0.95);
    const name = this.add
      .text(0, -40, relic.name, { fontFamily: "monospace", fontSize: "7px", color: hex })
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
    g.setVisible(!bought);
    this.merchantItems.push({ x, y, relic, bought, g });
  }

  private applyRelic(relic: Relic) {
    this.ownedRelics.add(relic.id);
    relic.apply(this.mods);
    const before = this.maxHearts;
    // Floor at 1 heart so glass-cannon relics can't lock a 0-heart run; extra max
    // hearts arrive filled, and a reduced max clamps current hearts down.
    this.maxHearts = Math.max(1, this.mods.maxHearts);
    this.hearts = Math.min(this.hearts + Math.max(0, this.maxHearts - before), this.maxHearts);
    sfx.pickup("local");
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
        // The buy is the whole point of a shrine room: ring it in the relic's
        // own rarity colour so the moment of purchase reads, not just its text.
        impactRing(this, m.x, m.y - 16, RARITY_COLOR[m.relic.rarity], 24);
        popText(this, m.x, m.y - 30, m.relic.name, "#e83fa0");
        popText(this, m.x, m.y - 12, `⬡ -${m.relic.price}`, "#ffd15c");
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

  // Single outgoing-damage choke point: base × (dmg + rage-per-missing-heart),
  // then a crit roll. Called once per landed hit (host-authoritative).
  private dmgOut(base: number): number {
    const rage = this.mods.rage * Math.max(0, this.maxHearts - this.hearts);
    let out = base * (this.mods.dmg + rage);
    this.lastCrit = this.mods.crit > 0 && rand() < this.mods.crit;
    if (this.lastCrit) out *= this.mods.critMult;
    return Math.max(1, Math.round(out));
  }

  // Gold spark + "CRIT" pop when the most recent dmgOut rolled a critical hit —
  // otherwise crit relics land invisibly. Call right after the takeHit.
  private critFeedback(x: number, y: number) {
    if (!this.lastCrit) return;
    popText(this, x, y - 6, "CRIT", "#ffd15c");
    hitSpark(this, x, y, 0xffd15c, 10);
    this.freeze = Math.max(this.freeze, 0.06);
  }

  private heal(n: number, by: Player = this.player) {
    this.hearts = Math.min(this.maxHearts, this.hearts + n);
    sfx.heal(by === this.player ? "local" : "routine");
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
    this.expeditionHud?.setVisible(
      !this.controlsPaused && this.state === "active" && !this.trailerActive,
    );
    const dts = Math.min(delta, 100) / 1000;
    this.updateBanner(dts * 1000);
    this.demoT += dts;
    // Bot-playtest telemetry (sys/diag.ts): mutate the shared object in place.
    diag.frame++;
    diag.score = this.score;
    diag.complete = this.state === "dead";
    diag.player.x = this.player.x;
    diag.player.y = this.player.y;
    diag.player.speed = Math.hypot(this.player.body.vx, this.player.body.vy);
    diag.entities = this.enemies.length + this.enemyPuppets.size;
    // Once per frame, before any sample(): reconciles lost touches, publishes
    // the justPressed edges the Input merge reads, and redraws the overlay.
    this.gamepad.update();
    // Same contract for the physical controller poll inside Input.
    this.controls.update();

    if (this.session) {
      this.session.tick();
      if (this.session.roomFull) {
        this.scene.start("select", { roomFull: true });
        return;
      }
      // Drain input even while disconnected. A single sample serves authority,
      // prediction and uplink; old presses never queue behind reconnection.
      const sample = this.demo ? this.demoInput() : this.controls.sample();
      const priorRun = this.authority.kind === "ready" ? this.authority.runId : null;
      const ready = this.prepareSession();
      const sameRun = this.authority.kind === "ready" && this.authority.runId === priorRun;
      this.guestIn = ready && sameRun && !this.controlsPaused ? sample : NEUTRAL_INPUT;
      if (ready) this.sendInput(this.guestIn);
      if (!ready) return;
      this.handleExpeditionRestart();
      // Headless co-op probe (no casts): read via globalThis.__lf in tests.
      const vsProbe = this.role === "guest" ? this.netVs : (this.vs?.encode() ?? null);
      Reflect.set(globalThis, "__lf", {
        role: this.role,
        state: this.state,
        mode: this.mode,
        players: this.livePlayers().length,
        entities: this.enemies.length + this.enemyPuppets.size,
        hearts: this.hearts,
        px: Math.round(this.player.x),
        rx: this.remote ? Math.round(this.remote.x) : null,
        ax:
          this.role === "guest"
            ? Math.round(this.netPlayers.find((p) => p.id === this.session?.playerId)?.x ?? -1)
            : null,
        conn: this.session.connectionStatus,
        downed: this.livePlayers().filter((p) => p.body.downed).length,
        ls: this.role === "guest" ? this.netLastStand !== null : this.lastStand !== null,
        vs: vsProbe,
        dead: this.livePlayers().filter((p) => p.body.dead).length,
        paused: this.controlsPaused,
        swing: this.player.body.swingId,
        rSwing:
          this.role === "guest"
            ? (this.netPlayers.find((p) => p.id !== this.session?.playerId)?.swingId ?? null)
            : (this.remote?.body.swingId ?? null),
      });
    }

    if (this.state === "connecting") {
      this.prepareSession();
      return;
    }

    if (this.state === "dead") {
      this.deadT += dts;
      if (this.role === "host") this.hostNet(dts);
      this.enemies.forEach((e) => e.render());
      // Trailer scenes stage their own restart — never bounce to the hub.
      if (this.deadT > 2.4 && !this.trailerActive)
        this.scene.start("select", { recap: this.runRecap });
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

    // Guest: predict my own body locally; render everything else from the
    // host's broadcast.
    if (this.role === "guest") {
      this.stepGuest(dts);
      return;
    }

    // Host / solo: authoritative fixed-step sim.
    if (this.role === "host") this.syncRemotePresence();
    const scripted = this.trailerIn ? this.trailerIn() : null;
    const snap = scripted
      ? scripted.p1
      : this.controlsPaused
        ? NEUTRAL_INPUT
        : this.session
          ? this.guestIn
          : this.demo
            ? this.demoInput()
            : this.controls.sample();
    const remoteIn = scripted ? scripted.p2 : this.remote ? this.readRemoteInput() : null;
    if (this.vs) {
      // Match over + hold lapsed: either duelist's attack press restarts it.
      if (this.vs.canRematch && (snap.attackPressed || (remoteIn?.attackPressed ?? false))) {
        this.vs.beginMatch();
        this.vsRespawn();
        this.showBanner("REMATCH — ROUND 1", 1100, "critical");
        sfx.door("local");
      }
      // Round intro / match end: bodies hold still (gravity still applies).
      const frozen = this.vs.frozen;
      this.player.buffer(frozen ? NEUTRAL_INPUT : snap);
      if (this.remote && remoteIn) this.remote.buffer(frozen ? NEUTRAL_INPUT : remoteIn);
    } else {
      this.player.buffer(snap);
      if (this.remote && remoteIn) this.remote.buffer(remoteIn);
    }
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
    this.renderLastStand();
    this.updateHud();

    if (this.role === "host") this.hostNet(dts);
  }

  // ── networking ───────────────────────────────────────────────────────────────
  // Stream my held input + monotonic press counters up to the host. The caller
  // passes the frame's single input sample (also fed to local prediction).
  private sendInput(s: InputState) {
    if (!this.session?.live) return;
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
    this.session.updateMyState({ hero: this.requestedHero, input, paused: this.controlsPaused });
  }

  // Host: turn the guest's latest wire input into an edge-triggered InputState.
  private readRemoteInput(): InputState {
    const other = this.session?.otherPlayer();
    const ni = readNetInput(other?.state?.input);
    const active =
      other !== null &&
      other !== undefined &&
      other.connected !== false &&
      other.state?.paused !== true &&
      ni !== null;
    if (!other || !ni || !active) {
      if (this.remoteInputOwner?.active !== false || this.remoteInputOwner?.id !== other?.id)
        this.remote?.body.clearInput();
      this.remoteInputOwner = other ? { id: other.id, active: false } : null;
      return NEUTRAL_INPUT;
    }
    const first = !this.remoteInputOwner?.active || this.remoteInputOwner.id !== other.id;
    const previous: InputSequence = first ? ni : this.inSeq;
    this.inSeq = { j: ni.j, d: ni.d, a: ni.a, s: ni.s };
    this.remoteInputOwner = { id: other.id, active: true };
    return {
      left: ni.left,
      right: ni.right,
      up: ni.up,
      down: ni.down,
      jumpHeld: ni.jumpHeld,
      jumpPressed: ni.j > previous.j,
      dashPressed: ni.d > previous.d,
      attackPressed: ni.a > previous.a,
      specialPressed: ni.s > previous.s,
    };
  }

  // Host: spawn / despawn the remote player as the other client joins or leaves.
  private syncRemotePresence() {
    const sess = this.session;
    const myId = sess?.playerId;
    if (!sess?.isHost || !myId || this.state === "dead") return;
    // A peer parked in the reconnect grace window is listed but not playing:
    // treated as present it would hold a seat and freeze a duel against a
    // ghost until the server reaps it.
    const live = (id: string | null): boolean => sess.players[id ?? ""]?.connected !== false;
    const other = sess.otherPlayer();
    if (this.seats.host && !live(this.seats.host)) this.seats.host = null;
    if (this.seats.guest && !live(this.seats.guest)) this.seats.guest = null;
    if (this.seats.host !== myId && this.seats.guest !== myId) {
      if (this.seats.host === null) this.seats.host = myId;
      else this.seats.guest = myId;
    }
    if (this.remote && (!other || other.id !== this.remoteId || !live(other.id))) {
      if (this.vs) this.vs.reset();
      else if (this.lastStand) {
        this.lastStand = null;
        this.destroyLastStandUi();
        if (this.player.body.downed) this.player.body.revive();
        this.hearts = Math.max(this.hearts, 1);
      }
      this.remote.destroy();
      this.remote = undefined;
      this.remoteId = null;
      this.remoteInputOwner = null;
      if (this.vs) this.vsRespawn();
      this.showBanner(this.vs ? "CHALLENGER LEFT" : "PLAYER 2 LEFT", 1600, "critical");
      this.updateHud();
    }
    if (other && live(other.id) && !this.remote) {
      // Presence can arrive before the peer publishes its hub selection.
      const hero = parseHero(other.state?.hero);
      if (!hero) return;
      if (this.seats.host !== other.id && this.seats.guest !== other.id) {
        if (this.seats.host === null) this.seats.host = other.id;
        else this.seats.guest = other.id;
      }
      const index = this.seats.host === other.id ? 0 : 1;
      const spawn = (this.vs ? this.vsSpawns[index] : undefined) ?? this.roomSpawn;
      this.remote = this.spawnPlayer(HEROES[hero], this.grid, spawn.x, spawn.y);
      this.remoteId = other.id;
      this.remoteInputOwner = null;
      if (this.vs) {
        this.vs.beginMatch();
        this.vsRespawn();
        this.showBanner("ROUND 1", 1100, "critical");
        sfx.door("local");
      } else this.showBanner("PLAYER 2 JOINED", 1000, "status");
    }
  }

  private finishConnecting() {
    this.player.sprite.setVisible(true);
    this.fadeRect.setAlpha(0);
    this.state = "active";
  }

  // Guest: apply the latest room + snapshot, run my OWN body through the real
  // fixed-step sim on local input (client-side prediction — movement responds
  // this frame, not after a round-trip), then re-lerp the puppet views. The
  // host still resolves ALL combat: damage/knockback/hearts arrive via the
  // snapshot and fold into the predicted body in reconcileSelf.
  private stepGuest(dts: number) {
    const sess = this.session;
    if (!sess) return;
    if (!sess.live) return;
    const read = this.acceptedCheckpoint();
    const auth = this.authority;
    if (read.kind !== "ready" || auth.kind !== "ready") return;
    const c = read.value;
    if (c.runId !== auth.runId || c.term !== auth.term || c.room < this.guestRoomSeq) return;
    const changedRoom = c.room !== this.guestRoomSeq;
    if (changedRoom) {
      this.netBiome = c.run.biome;
      this.netDepth = c.run.depth;
      this.run.type = c.run.type;
      this.buildRoomFromNet(read.room);
      this.guestSnapT = -1;
    }
    const snap = readSnapshot(sess.sharedState);
    if (
      snap &&
      snap.t > this.guestSnapT &&
      snap.t >= c.tick &&
      snap.room === c.room &&
      snap.runId === c.runId &&
      snap.term === c.term
    ) {
      this.guestSnapT = snap.t;
      this.seats = { ...c.seats };
      this.syncGuestProgress(c);
      this.applySnapshot(snap, c.phase.kind === "dead");
      if (c.phase.kind === "dead") this.deadT = c.phase.elapsed;
      this.syncRoomFeatures(c, changedRoom);
    }
    if (this.state !== "active") return; // the snapshot ended the run (co-op death)
    // Versus: the host walked away — nothing will ever update again; say so.
    if (
      this.mode === "versus" &&
      !this.vsOpponentGone &&
      this.guestSnapT > 0 &&
      !sess.otherPlayer()
    ) {
      this.vsOpponentGone = true;
      this.showBanner(
        this.touch ? "OPPONENT LEFT — EXIT FOR HUB" : "OPPONENT LEFT — ESC FOR HUB",
        60000,
        "critical",
      );
    }
    // Prediction: mirror the host's versus freeze (round intro / match end) so
    // the local body doesn't fight the authority while inputs are dropped.
    const frozen = this.mode === "versus" && this.netVs !== null && vsPhaseFrozen(this.netVs.phase);
    this.player.buffer(frozen || this.controlsPaused ? NEUTRAL_INPUT : this.guestIn);
    this.acc += dts;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_STEPS) {
      this.player.step(STEP);
      this.reconciler.record(this.player.body.x, this.player.body.y);
      this.acc -= STEP;
      steps++;
    }
    // Prediction is movement-only: combat intents resolve on the host.
    this.player.body.pendingShot = null;
    this.player.body.pendingHeal = 0;
    this.player.render(Math.min(this.acc / STEP, 1));
    this.renderGuestViews(dts);
    this.renderLastStand();
  }

  private applySnapshot(s: Snapshot, terminal = false) {
    const auth = this.authority;
    if (
      auth.kind !== "ready" ||
      s.room !== this.guestRoomSeq ||
      s.runId !== auth.runId ||
      s.term !== auth.term
    )
      return;
    this.hearts = s.hearts;
    this.maxHearts = s.maxHearts;
    this.gold = s.gold;
    this.netBiome = s.biome;
    this.netDepth = s.depth;
    if (!this.guestCueBaseline) this.applyRemoteCues(s.players);
    this.netPlayers = s.players;
    const mine = s.players.find((p) => p.id === this.session?.playerId);
    if (mine) this.reconcileSelf(mine);
    if (this.mode === "versus") {
      // Versus: per-duelist hearts + round state travel on s.vs; the shared
      // hearts / last-stand / shared-death rules don't apply.
      this.applyNetVersus(s.vs ?? null);
      this.applyNetProj(s.proj);
      this.guestCueBaseline = false;
      this.updateHud();
      return;
    }
    this.applyNetLastStand(terminal ? { ...s, lastStand: null } : s);
    this.reconcileEnemies(s.enemies);
    this.reconcileBoss(s.boss, s.biome, s.room);
    this.applyPayoffEdges(s);
    this.applyNetProj(s.proj);
    this.guestCueBaseline = false;
    this.doors.forEach((d) => d.setActive(s.cleared));
    this.updateHud();
    // Hearts hit 0 while a last stand is live → downed, not dead (yet).
    if (terminal || (this.hearts <= 0 && !this.netLastStand)) this.guestDie();
  }

  /** Accepted presentation only: never apply modifiers or bank a guest's rewards. */
  private syncGuestProgress(c: ExpeditionCheckpoint) {
    const auth = this.authority;
    if (
      this.role !== "guest" ||
      auth.kind !== "ready" ||
      c.runId !== auth.runId ||
      c.term !== auth.term ||
      c.room !== this.guestRoomSeq ||
      c.tick < this.guestProgressTick
    )
      return;
    this.guestProgressTick = c.tick;
    this.score = c.score;
    this.ownedRelics = new Set(c.relics);
    const mine = c.players.find((p) => p.id === this.session?.playerId);
    this.guestSpecial = mine ? specialReadiness(mine.body) : { kind: "unknown" };
  }

  /** Snapshot edges own remote cues; repeated renders and first admissions stay quiet. */
  private applyRemoteCues(players: NetPlayer[]) {
    for (const next of players) {
      if (next.id === this.session?.playerId) continue;
      const prev = this.netPlayers.find((p) => p.id === next.id && p.hero === next.hero);
      if (!prev || next.dead || next.downed) continue;
      if (next.hurting && !prev.hurting) sfx.hurt("routine");
      if (next.dashing && !prev.dashing) sfx.dash();
      if (!next.grounded && prev.grounded && next.vy < 0) sfx.jump();
      if (next.attackStep > 0 && next.swingId > prev.swingId) sfx.slash();
      const hero = parseHero(next.hero);
      if (hero && next.specialActive && next.specialId > prev.specialId)
        this.showSpecial(
          HEROES[hero].kit.special.kind,
          next.x,
          next.y,
          next.facing,
          HEROES[hero].color,
          false,
        );
    }
  }

  /** Fresh same-room snapshots only. Initial cleared/dead states are quiet. */
  private applyPayoffEdges(s: Snapshot) {
    if (s.room !== this.guestRoomSeq) return;
    const prev = this.guestPayoff;
    if (prev && prev.room === s.room && s.t <= prev.t) return;
    if (prev && prev.room === s.room) {
      if (prev.bossAlive && s.boss?.dead) {
        this.bossDefeatFx(s.boss.x, s.boss.y, this.netBiome);
        sfx.boom("essential");
        this.shake(420, 0.02);
        this.showBanner(`${bossKind(this.netBiome).name} SLAIN`, 1800, "payoff");
      }
      if (!prev.cleared && s.cleared) this.roomClearFx(this.netRoomType, this.netBiome);
    }
    this.guestPayoff = {
      room: s.room,
      t: s.t,
      cleared: s.cleared,
      bossAlive: s.boss !== null && !s.boss.dead,
    };
  }

  // Exactly one driver advances each player body every frame:
  //   sim     — this client runs the authoritative sim (solo/host, both bodies)
  //   predict — guest's OWN body: local sim for instant input, reconciled to
  //             the host's authoritative copy on every snapshot
  //   puppet  — guest's view of the OTHER player: driven purely from snapshots
  private bodyDrive(pl: Player): "sim" | "predict" | "puppet" {
    if (this.role !== "guest") return "sim";
    return pl === this.player ? "predict" : "puppet";
  }

  // Guest: fold the host's authoritative copy of MY player into the predicted
  // body. Movement normally agrees (same sim, same input), so most snapshots
  // correct nothing; host-only outcomes land here as edges — a hit's knockback
  // or a round respawn snaps (the jerk IS the feedback), small drift blends out
  // via the reconciler's trajectory match.
  private reconcileSelf(net: NetPlayer) {
    const b = this.player.body;
    // Host-resolved combat state, mirrored on its edges.
    if (net.downed && !b.downed) {
      b.down();
      b.snapTo(net.x, net.y, net.vx, net.vy);
      this.reconciler.reset();
    } else if (!net.downed && b.downed) b.revive();
    if (net.dead && !b.dead) b.dead = true;
    else if (!net.dead && b.dead) {
      // Versus round respawn: full reset at the authoritative spawn point.
      b.dead = false;
      this.player.enterRoom(this.grid, net.x, net.y);
      this.reconciler.reset();
      this.netSelfHurting = net.hurting;
      return;
    }
    if (net.hurting && !this.netSelfHurting) {
      // The host landed a hit on me: reproduce it locally (stun + i-frames +
      // hurt juice via the body hooks) and snap to the authoritative knockback.
      b.applyHurt(Math.sign(net.vx) || net.facing);
      b.snapTo(net.x, net.y, net.vx, net.vy);
      this.reconciler.reset();
    } else if (!b.dead && !b.downed) {
      const c = this.reconciler.reconcile(net.x, net.y);
      if (c.kind === "snap") {
        b.snapTo(net.x, net.y, net.vx, net.vy);
        this.reconciler.reset();
      } else if (c.kind === "blend") b.nudge(c.dx, c.dy);
    }
    this.netSelfHurting = net.hurting;
  }

  // Guest: mirror the versus match state; edge-detect phase changes for the
  // banners + stings (scores/hearts render from the snapshot every frame).
  private applyNetVersus(v: NetVersus | null) {
    const prev = this.netVs;
    this.netVs = v;
    if (!v || v.phase === (prev?.phase ?? "")) return;
    if (v.phase === "countdown")
      this.showBanner(v.round === 1 ? "ROUND 1" : `ROUND ${v.round}`, 1100, "critical");
    else if (v.phase === "fighting") {
      this.showBanner("FIGHT!", 700, "critical");
      sfx.bossRoar();
    } else if (v.phase === "roundEnd") {
      this.showBanner(`${this.vsName(v.winner)} TAKES THE ROUND`, 1500, "critical");
      sfx.die();
    } else if (v.phase === "matchEnd")
      this.showBanner(
        `${this.vsName(v.winner)} WINS THE MATCH  ·  ${this.rematchHint()}`,
        60000,
        "critical",
      );
  }

  // Guest: mirror the host's last-stand state; edge-detect enter/exit for the
  // banner + sting (the marker itself renders from the snapshot every frame).
  private applyNetLastStand(s: Snapshot) {
    const ls = s.lastStand ?? null;
    if (ls && !this.netLastStand) {
      const mine = s.players.find((p) => p.downed)?.id === this.session?.playerId;
      sfx.downed();
      this.showBanner(mine ? "YOU'RE DOWN — HOLD ON" : "ALLY DOWN — REVIVE!", 1800, "critical");
    } else if (!ls && this.netLastStand && s.hearts > 0) {
      sfx.revive();
      this.showBanner("REVIVED", 1200, "critical");
    }
    this.netLastStand = ls;
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
      } else if (!this.guestCueBaseline && !p.net.dead) {
        if (ne.dead) {
          impactRing(this, ne.x, ne.y - p.view.body.kind.h / 2, COLORS.teal, 22);
          sfx.kill();
        } else if (ne.flash && !p.net.flash) sfx.hit();
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

  private reconcileBoss(nb: NetBoss | null, biome: number, room: number) {
    if (nb && !this.bossPuppet) {
      const view = new Boss(this, this.grid, nb.x, nb.y, biome);
      const barCol = biomePalette(biome).oneway;
      this.bossHpBg = this.add
        .rectangle(BASE_W / 2, 47 + gameInset(this).top, 260, 6, 0x000000, 0.5)
        .setStrokeStyle(1, barCol, 0.6)
        .setScrollFactor(0)
        .setDepth(85);
      this.bossHp = this.add
        .rectangle(BASE_W / 2 - 129, 47 + gameInset(this).top, 258, 4, barCol)
        .setOrigin(0, 0.5)
        .setScrollFactor(0)
        .setDepth(86);
      this.bossPuppet = { view, net: nb };
    } else if (!nb && this.bossPuppet) {
      this.bossPuppet.view.destroy();
      this.bossPuppet = undefined;
      this.bossHp?.destroy();
      this.bossHpBg?.destroy();
      this.bossHp = undefined;
      this.bossHpBg = undefined;
    }
    if (nb && this.bossPuppet) {
      if (!this.guestCueBaseline && nb.flash && !this.bossPuppet.net.flash) sfx.hit();
      this.bossPuppet.net = nb;
      if (this.bossHp) this.bossHp.width = 258 * nb.hpFrac;
      // A dead/stale first snapshot stays quiet. A later matching live one can
      // establish the encounter even if that earlier packet built the puppet.
      if (!nb.dead && room === this.guestRoomSeq) this.announceBoss(biome);
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
  // My own body is predicted, not a puppet — it renders from its local sim.
  private renderGuestViews(dt: number) {
    const myId = this.session?.playerId;
    if (this.remote && !this.netPlayers.some((p) => p.id === this.remoteId)) {
      this.remote.destroy();
      this.remote = undefined;
      this.remoteId = null;
    }
    for (const np of this.netPlayers) {
      if (np.id === myId) continue; // bodyDrive(player) === "predict"
      this.ensureGuestRemote(np.hero);
      this.remoteId = np.id;
      const pup = this.remote;
      if (pup && this.bodyDrive(pup) === "puppet") pup.applyNet(np);
    }
    for (const p of this.enemyPuppets.values())
      p.view.applyNet(
        p.net.clip,
        p.net.x,
        p.net.y,
        p.net.flip,
        p.net.flash,
        p.net.action,
        p.net.tint,
        dt,
      );
    if (this.bossPuppet) {
      const n = this.bossPuppet.net;
      this.bossPuppet.view.applyNet(n.clip, n.x, n.y, n.flip, n.flash, n.telegraph, n.action, dt);
    }
  }

  private ensureGuestRemote(heroRaw: string) {
    const hero = parseHero(heroRaw) ?? "axion";
    if (this.remote?.name === hero) return;
    this.remote?.destroy();
    this.remote = this.spawnPlayer(HEROES[hero], this.grid, this.roomSpawn.x, this.roomSpawn.y);
  }

  private guestDie() {
    if (this.state === "dead") return;
    this.lastStand = null;
    this.netLastStand = null;
    this.runRecap = this.trailerActive
      ? null
      : {
          kind: "coop-guest",
          hero: this.heroName,
          biome: this.netBiome,
          depth: this.netDepth,
          gold: this.gold,
        };
    this.state = "dead";
    this.destroyLastStandUi();
    this.deadT = 0;
    this.player.sprite.play(`${this.heroName}:death`);
    sfx.die();
    this.showBanner("YOU FELL — RETURNING TO THE HUB", 2600, "critical");
  }

  /** Wrapper pause gates intent, not the partner's online simulation. */
  setControlsPaused(paused: boolean): void {
    if (this.controlsPaused === paused) return;
    this.controlsPaused = paused;
    this.expeditionHud?.setVisible(!paused && this.state === "active" && !this.trailerActive);
    this.controls?.reset();
    this.player?.body.clearInput();
    this.guestIn = NEUTRAL_INPUT;
    if (this.session?.live) this.sendInput(NEUTRAL_INPUT);
  }

  private prepareSession(): boolean {
    const sess = this.session;
    if (!sess) return true;
    if (this.seenDisconnect !== sess.disconnectRevision) {
      this.seenDisconnect = sess.disconnectRevision;
      this.neutralOnAdmission = true;
    }
    if (!sess.live) {
      if (this.wasConnected) {
        this.controls.reset();
        this.player.body.clearInput();
        this.remote?.body.clearInput();
        this.neutralOnAdmission = true;
      }
      this.wasConnected = false;
      return false;
    }
    this.wasConnected = true;
    if (sess.offline) {
      if (this.state === "connecting") this.beginOnlineExpedition();
      return true;
    }
    const a = this.authority;
    if (
      sess.isHost &&
      a.kind === "ready" &&
      a.revision === sess.authorityRevision &&
      this.role === "host"
    )
      return true;
    const read = this.acceptedCheckpoint();
    if (read.kind === "absent" && sess.isHost) {
      this.beginOnlineExpedition();
      return true;
    }
    if (read.kind !== "ready") return false;
    const c = read.value;
    if (sess.isHost) {
      this.role = "host";
      this.authority = {
        kind: "ready",
        runId: c.runId,
        term: c.term + 1,
        revision: sess.authorityRevision,
      };
      this.adoptCheckpoint(c, read.room);
      this.syncRemotePresence();
      this.roomDirty = true;
      this.hostNet(0, true);
      return true;
    }
    if (
      a.kind === "ready" &&
      a.runId === c.runId &&
      a.term === c.term &&
      a.revision === sess.authorityRevision &&
      this.role === "guest"
    )
      return true;
    this.role = "guest";
    this.authority = {
      kind: "ready",
      runId: c.runId,
      term: c.term,
      revision: sess.authorityRevision,
    };
    this.mode = c.mode;
    this.seats = { ...c.seats };
    this.netBiome = c.run.biome;
    this.netDepth = c.run.depth;
    this.run.type = c.run.type;
    this.buildRoomFromNet(read.room);
    const me = c.players.find((p) => p.id === sess.playerId);
    if (me && me.hero !== this.heroName) {
      this.player.destroy();
      this.heroName = me.hero;
      this.player = this.spawnPlayer(HEROES[me.hero], this.grid, me.body.x, me.body.y);
      this.setupCamera();
    }
    if (me) this.player.body.restore(me.body);
    if (this.controlsPaused || this.neutralOnAdmission) this.player.body.clearInput();
    this.neutralOnAdmission = false;
    this.netSelfHurting = this.player.body.hurting;
    const other = c.players.find((p) => p.id !== sess.playerId);
    if (other) {
      this.ensureGuestRemote(other.hero);
      this.remoteId = other.id;
      this.remote?.body.restore(other.body);
    }
    this.clearBanners();
    this.bossAnnounced = true;
    this.guestSnapT = -1;
    this.guestPayoff = {
      room: c.room,
      t: c.tick,
      cleared: c.cleared,
      bossAlive: c.boss !== null && !c.boss.dead,
    };
    this.netLastStand = c.lastStand
      ? { bleed: c.lastStand.bleed, rev: c.lastStand.revive / REVIVE_HOLD }
      : null;
    if (c.mode === "versus") {
      const match = new VersusMatch();
      match.restore(c.versus);
      this.netVs = match.encode();
    }
    this.syncGuestProgress(c);
    this.syncRoomFeatures(c, true);
    this.finishConnecting();
    this.updateHud();
    if (c.phase.kind === "dead") this.observeTerminal(c);
    this.showAdoptedVersusResult();
    return true;
  }

  /** Empty room or an explicit request for the exact terminal expedition. */
  private beginOnlineExpedition(): void {
    const sess = this.session;
    const myId = sess?.playerId;
    if (!sess?.isHost || !myId) return;
    if (!sess.offline) checkpointRng();
    this.role = "host";
    this.authority = {
      kind: "ready",
      runId: `${myId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      term: 0,
      revision: sess.authorityRevision,
    };
    const other = sess.otherPlayer();
    const otherHero = parseHero(other?.state?.hero);
    // Reuse existing side identities when their seats are still held.
    if (this.seats.host !== myId && this.seats.guest !== myId) this.seats.host = myId;
    if (other && otherHero) {
      if (this.seats.host === myId) this.seats.guest = other.id;
      else this.seats.host = other.id;
    } else if (this.seats.host === myId) this.seats.guest = null;
    else this.seats.host = null;
    this.run = new RunManager();
    this.adoptedTerminal = null;
    this.mods = baseMods();
    const bonus = runBonuses(loadMeta());
    this.mods.dmg += bonus.dmg;
    this.mods.armor += bonus.armor;
    this.mods.maxHearts += bonus.hearts;
    this.ownedRelics = new Set();
    this.maxHearts = this.mods.maxHearts;
    this.hearts = this.maxHearts;
    this.gold = 0;
    this.score = 0;
    this.combo = 0;
    this.comboT = 0;
    this.freeze = 0;
    this.acc = 0;
    this.deadT = 0;
    this.lastStand = null;
    this.netLastStand = null;
    this.runRecap = null;
    this.pendingOffer = null;
    this.transBuilt = false;
    this.transT = 0;
    this.roomSeq = 0;
    this.netT = 0;
    this.netAcc = 0;
    this.checkpointAcc = 0;
    this.checkpointMark = null;
    this.enemyId = new WeakMap();
    this.enemyIdNext = 1;
    this.vsHitSeq = new WeakMap();
    this.remoteInputOwner = null;
    this.clearBanners();
    this.flashedBiome = 0;
    const selfHero = parseHero(sess.players[myId]?.state?.hero) ?? this.heroName;
    this.player.destroy();
    this.heroName = selfHero;
    this.player = this.spawnPlayer(
      HEROES[selfHero],
      this.grid ?? new Grid(),
      this.roomSpawn.x,
      this.roomSpawn.y,
    );
    this.remote?.destroy();
    this.remote = undefined;
    this.remoteId = null;
    if (other && otherHero) {
      this.remote = this.spawnPlayer(
        HEROES[otherHero],
        this.grid ?? new Grid(),
        this.roomSpawn.x,
        this.roomSpawn.y,
      );
      this.remoteId = other.id;
    }
    if (this.mode === "versus") {
      this.vs = new VersusMatch();
      this.buildVersusRoom();
      if (this.remote) this.vs.beginMatch();
      this.vsRespawn();
    } else {
      this.vs = null;
      const param = new URLSearchParams(location.search).get("room");
      const rt = param ? parseRoomType(param) : null;
      this.buildRoom(rt ? this.run.debugEnter(rt) : this.run.begin());
    }
    this.finishConnecting();
    this.controls.reset();
    this.guestIn = NEUTRAL_INPUT;
    this.restartRequested = false;
    this.roomDirty = true;
    this.hostNet(0, true);
    this.updateHud();
  }

  private handleExpeditionRestart(): void {
    const sess = this.session;
    const auth = this.authority;
    if (!sess?.live || auth.kind !== "ready" || this.mode !== "coop") return;
    // The hub's restart targets the terminal run it showed; adopting a live
    // run makes it moot, and a stale request would silently skip the next
    // death's recap and restart the expedition under both players.
    if (this.restartRequested && this.state !== "dead") this.restartRequested = false;
    if (this.restartRequested && this.state === "dead" && this.restartSentFor !== auth.runId) {
      this.restartSentFor = auth.runId;
      this.restartRequested = false;
      sess.updateMyState({ restartFor: auth.runId });
    }
    if (!sess.isHost || this.state !== "dead") return;
    if (
      Object.values(sess.players).some(
        (p) => p.connected !== false && p.state?.restartFor === auth.runId,
      )
    )
      this.beginOnlineExpedition();
  }

  private acceptedCheckpoint(): CheckpointRead {
    const shared = this.session?.sharedState ?? null;
    if (shared?.checkpoint !== this.checkpointRef || shared?.room !== this.checkpointRoomRef) {
      this.checkpointRef = shared?.checkpoint;
      this.checkpointRoomRef = shared?.room;
      this.checkpointCache = readCheckpoint(shared);
    }
    return this.checkpointCache;
  }

  private ownerId(pl: Player): string | null {
    return pl === this.player ? (this.session?.playerId ?? null) : this.remoteId;
  }

  private seatPlayer(id: string): Player | undefined {
    if (id === this.session?.playerId) return this.player;
    return id === this.remoteId ? this.remote : undefined;
  }

  private checkpointPhase(): CheckpointPhase {
    if (this.state === "dead") return { kind: "dead", elapsed: this.deadT };
    if (this.state === "transition" && this.pendingOffer)
      return {
        kind: "transition",
        elapsed: this.transT,
        built: this.transBuilt,
        offer: this.pendingOffer.type,
      };
    return { kind: "active" };
  }

  private encodeCheckpoint(): ExpeditionCheckpoint | null {
    const auth = this.authority;
    const writer = this.session?.playerId;
    if (auth.kind !== "ready" || !writer) return null;
    // An unassigned late successor cannot replace either terminal roster body.
    // Keep the accepted result intact until an explicit same-party restart.
    if (this.state === "dead" && this.adoptedTerminal) {
      return {
        ...structuredClone(this.adoptedTerminal),
        writer,
        term: auth.term,
        tick: this.netT,
        phase: { kind: "dead", elapsed: this.deadT },
      };
    }
    const enemies = this.enemies.map((e) => {
      let id = this.enemyId.get(e);
      if (id === undefined) {
        id = this.enemyIdNext++;
        this.enemyId.set(e, id);
      }
      return {
        id,
        name: e.body.kind.name,
        body: e.body.checkpoint(),
        tint: e.baseTint,
        deathAge: this.deadTimers.get(e) ?? null,
      };
    });
    const liveEnemies = new Set(this.enemies);
    const enemyIds = (set: Set<Enemy>): number[] =>
      [...set].flatMap((e) => {
        const id = liveEnemies.has(e) ? this.enemyId.get(e) : undefined;
        return id === undefined ? [] : [id];
      });
    const players: CheckpointPlayer[] = [];
    for (const pl of this.livePlayers()) {
      const id = this.ownerId(pl);
      if (!id) continue;
      const hero = parseHero(pl.encode(id).hero);
      if (!hero) continue;
      const c = this.cs(pl);
      players.push({
        id,
        hero,
        body: pl.body.checkpoint(),
        combat: {
          hitSwing: enemyIds(c.hitSwing),
          lastSwing: c.lastSwing,
          hitSpecial: enemyIds(c.hitSpecial),
          lastSpecial: c.lastSpecial,
          bossSwing: c.bossSwing,
          bossSpecial: c.bossSpecial,
        },
        versusHits: { ...this.vsSeq(pl) },
      });
    }
    const playerIds = new Set(players.map((p) => p.id));
    const common = {
      version: 1,
      runId: auth.runId,
      writer,
      term: auth.term,
      tick: this.netT,
      room: this.roomSeq,
      rng: checkpointRng(),
      seats: { ...this.seats },
      players,
      enemies,
      boss: this.boss?.body.checkpoint() ?? null,
      bossDeathAge: this.bossDeadT,
      nextEnemyId: this.enemyIdNext,
      arrows: this.arrows.map((a) => ({
        x: a.x,
        y: a.y,
        vx: a.vx,
        vy: a.vy,
        life: a.life,
        dmg: a.dmg,
      })),
      shots: this.shots.map((s) => {
        const owner = s.owner ? this.ownerId(s.owner) : null;
        return {
          x: s.x,
          y: s.y,
          vx: s.vx,
          vy: s.vy,
          life: s.life,
          dmg: s.dmg,
          owner: owner && playerIds.has(owner) ? owner : null,
          hit: enemyIds(s.hit),
          hitP: [...s.hitP].flatMap((p) => {
            const id = this.ownerId(p);
            return id && playerIds.has(id) ? [id] : [];
          }),
          hitBoss: s.hitBoss,
        };
      }),
      hazards: this.hazards.map((h) => ({
        x: h.x,
        y: h.y,
        vx: h.vx,
        life: h.life,
        dmg: h.dmg,
        hitPlayer: h.hitPlayer,
      })),
      run: {
        biome: this.run.biome,
        depth: this.run.depth,
        type: this.run.type,
        offers: this.offers.map((o) => o.type),
      },
      mods: { ...this.mods },
      relics: [...this.ownedRelics],
      merchant: this.merchantItems.map((m) => ({
        x: m.x,
        y: m.y,
        relic: m.relic.id,
        bought: m.bought,
      })),
      feature: this.feature
        ? { x: this.feature.x, y: this.feature.y, used: this.feature.used }
        : null,
      hearts: this.hearts,
      maxHearts: this.maxHearts,
      gold: this.gold,
      score: this.score,
      combo: this.combo,
      comboTime: this.comboT,
      freeze: this.freeze,
      accumulator: this.acc,
      cleared: this.cleared,
      phase: this.checkpointPhase(),
    } satisfies Omit<ExpeditionCheckpoint, "mode" | "versus" | "lastStand">;
    if (this.mode === "versus" && this.vs)
      return { ...common, mode: "versus", versus: this.vs.checkpoint(), lastStand: null };
    const downedId = this.lastStand ? this.ownerId(this.lastStand.pl) : null;
    return {
      ...common,
      mode: "coop",
      versus: null,
      lastStand:
        this.lastStand && downedId
          ? { id: downedId, bleed: this.lastStand.bleedT, revive: this.lastStand.reviveT }
          : null,
    };
  }

  /** Restore accepted simulation data without rerolling or replaying rewards. */
  private adoptCheckpoint(c: ExpeditionCheckpoint, room: NetRoom): void {
    this.adoptedTerminal = c.phase.kind === "dead" ? structuredClone(c) : null;
    this.mode = c.mode;
    this.netBiome = c.run.biome;
    this.netDepth = c.run.depth;
    this.run.biome = c.run.biome;
    this.run.depth = c.run.depth;
    this.run.type = c.run.type;
    this.buildRoomFromNet(room);
    this.clearBanners();
    this.bossAnnounced = true;
    this.roomSeq = c.room;
    this.netT = c.tick;
    this.netAcc = 0;
    this.checkpointAcc = 0;
    this.checkpointMark = null;
    this.enemyId = new WeakMap();
    this.enemyIdNext = c.nextEnemyId;
    this.seats = { ...c.seats };
    this.mods = { ...c.mods };
    this.ownedRelics = new Set(c.relics);
    this.offers = c.run.offers.map((type) => ({ type }));
    this.hearts = c.hearts;
    this.maxHearts = c.maxHearts;
    this.gold = c.gold;
    this.score = c.score;
    this.combo = c.combo;
    this.comboT = c.comboTime;
    this.freeze = c.freeze;
    this.acc = c.accumulator;
    this.cleared = c.cleared;
    this.doors.forEach((door) => door.setActive(c.cleared));
    this.bossDeadT = c.bossDeathAge;
    const me = c.players.find((p) => p.id === this.session?.playerId);
    if (me && me.hero !== this.heroName) {
      this.player.destroy();
      this.heroName = me.hero;
      this.player = this.spawnPlayer(HEROES[me.hero], this.grid, me.body.x, me.body.y);
    }
    if (me) this.player.body.restore(me.body);
    if (this.controlsPaused || this.neutralOnAdmission) this.player.body.clearInput();
    this.neutralOnAdmission = false;
    this.remote?.destroy();
    this.remote = undefined;
    this.remoteId = null;
    const peerId = this.session?.otherPlayer()?.id;
    const other =
      c.players.find((p) => p.id === peerId) ??
      c.players.find((p) => p.id !== this.session?.playerId);
    if (other) {
      this.remote = this.spawnPlayer(HEROES[other.hero], this.grid, other.body.x, other.body.y);
      this.remote.body.restore(other.body);
      this.remoteId = other.id;
    }
    const byEnemyId = new Map<number, Enemy>();
    for (const data of c.enemies) {
      const e = new Enemy(this, this.grid, ENEMIES[data.name], data.body.x, data.body.y);
      e.body.restore(data.body);
      e.baseTint = data.tint;
      e.sprite.setTint(data.tint);
      this.enemies.push(e);
      this.enemyId.set(e, data.id);
      byEnemyId.set(data.id, e);
      if (data.deathAge !== null) this.deadTimers.set(e, data.deathAge);
    }
    for (const p of c.players) {
      const pl = this.seatPlayer(p.id);
      if (!pl) continue;
      this.combat.set(pl, {
        ...p.combat,
        hitSwing: new Set(
          p.combat.hitSwing.flatMap((id) => {
            const e = byEnemyId.get(id);
            return e ? [e] : [];
          }),
        ),
        hitSpecial: new Set(
          p.combat.hitSpecial.flatMap((id) => {
            const e = byEnemyId.get(id);
            return e ? [e] : [];
          }),
        ),
      });
      this.vsHitSeq.set(pl, { ...p.versusHits });
    }
    if (c.boss) {
      this.reconcileBoss(
        {
          clip: "salamander:idle",
          x: c.boss.x,
          y: c.boss.y,
          flip: c.boss.facing < 0,
          hpFrac: 1,
          flash: false,
          telegraph: false,
          dead: c.boss.dead,
        },
        c.run.biome,
        c.room,
      );
      const view = this.bossPuppet?.view;
      if (view) {
        this.boss = view;
        view.body.restore(c.boss);
        this.bossPuppet = undefined;
      }
    }
    for (const a of c.arrows) {
      this.spawnArrow(a.x, a.y, a.vx, a.vy, a.dmg);
      const view = this.arrows.at(-1);
      if (view) view.life = a.life;
    }
    for (const s of c.shots) {
      this.spawnShot(
        s.x,
        s.y,
        s.vx,
        s.vy,
        s.dmg,
        s.owner ? (this.seatPlayer(s.owner) ?? null) : null,
      );
      const view = this.shots.at(-1);
      if (view) {
        view.life = s.life;
        view.hitBoss = s.hitBoss;
        view.hit = new Set(
          s.hit.flatMap((id) => {
            const e = byEnemyId.get(id);
            return e ? [e] : [];
          }),
        );
        view.hitP = new Set(
          s.hitP.flatMap((id) => {
            const p = this.seatPlayer(id);
            return p ? [p] : [];
          }),
        );
      }
    }
    for (const h of c.hazards) {
      this.spawnHazard(h.x, h.y, h.vx, h.dmg);
      const view = this.hazards.at(-1);
      if (view) {
        view.life = h.life;
        view.hitPlayer = h.hitPlayer;
      }
    }
    this.syncRoomFeatures(c, true);
    this.vs = c.mode === "versus" ? new VersusMatch() : null;
    if (c.mode === "versus") this.vs?.restore(c.versus);
    this.vsSpawns = [
      this.roomSpawn,
      { x: this.grid.cols * TILE - this.roomSpawn.x, y: this.roomSpawn.y },
    ];
    const downed = c.lastStand ? this.seatPlayer(c.lastStand.id) : undefined;
    this.lastStand =
      c.lastStand && downed
        ? { pl: downed, bleedT: c.lastStand.bleed, reviveT: c.lastStand.revive }
        : null;
    // A seat the server has already dropped gets the same one-heart relief as a
    // partner leaving mid-last-stand.
    if (c.phase.kind !== "dead" && c.lastStand && !downed && !this.session?.players[c.lastStand.id])
      this.hearts = Math.max(this.hearts, 1);
    this.netLastStand = null;
    this.netVs = null;
    this.remoteInputOwner = null;
    this.guestPayoff = null;
    this.guestSnapT = -1;
    this.reconciler.reset();
    this.state = c.phase.kind;
    if (c.phase.kind !== "dead") this.runRecap = null;
    this.deadT = c.phase.kind === "dead" ? c.phase.elapsed : 0;
    this.transT = c.phase.kind === "transition" ? c.phase.elapsed : 0;
    this.transBuilt = c.phase.kind === "transition" && c.phase.built;
    this.pendingOffer = c.phase.kind === "transition" ? { type: c.phase.offer } : null;
    if (c.phase.kind === "dead") this.observeTerminal(c);
    this.fadeRect.setAlpha(0);
    this.player.sprite.setVisible(true);
    this.setupCamera();
    this.updateHud();
    this.showAdoptedVersusResult();
    restoreRng(c.rng); // construction above has no gameplay draws; restore last
  }

  private showAdoptedVersusResult(): void {
    const match = this.role === "guest" ? this.netVs : this.vs?.encode();
    if (match?.phase === "matchEnd")
      this.showBanner(
        `${this.vsName(match.winner)} WINS THE MATCH  ·  ${this.rematchHint()}`,
        60000,
        "critical",
      );
  }

  private observeTerminal(c: ExpeditionCheckpoint): void {
    // Receipts belong to local storage. An adopted result never banks twice or
    // claims the former host's banked amount as this client's earnings.
    if (!this.runRecap)
      this.runRecap = {
        kind: "coop-guest",
        hero: this.heroName,
        biome: c.run.biome,
        depth: c.run.depth,
        gold: c.gold,
      };
    this.state = "dead";
    this.deadT = c.phase.kind === "dead" ? c.phase.elapsed : 0;
    this.player.sprite.play(`${this.heroName}:death`);
  }

  private syncRoomFeatures(c: ExpeditionCheckpoint, baseline: boolean): void {
    for (let i = 0; i < c.merchant.length; i++) {
      const offer = c.merchant[i];
      if (!offer) continue;
      let item = this.merchantItems[i];
      if (!item) {
        const relic = RELICS.find((r) => r.id === offer.relic);
        if (!relic) continue;
        this.buildMerchantItem(relic, offer.x, offer.y, offer.bought);
        item = this.merchantItems[i];
      }
      if (!item) continue;
      const boughtNow = !item.bought && offer.bought;
      item.bought = offer.bought;
      item.g.setVisible(!offer.bought);
      if (boughtNow && !baseline) {
        impactRing(this, item.x, item.y - 16, RARITY_COLOR[item.relic.rarity], 24);
        popText(this, item.x, item.y - 30, item.relic.name, "#e83fa0");
        popText(this, item.x, item.y - 12, `⬡ -${item.relic.price}`, "#ffd15c");
        sfx.pickup("local");
      }
    }
    if (c.feature) {
      if (!this.feature) this.buildFeature(c.feature.x, c.feature.y);
      const f = this.feature;
      if (f) {
        const usedNow = !f.used && c.feature.used;
        f.used = c.feature.used;
        f.g.setVisible(!f.used);
        if (usedNow && !baseline) {
          impactRing(this, f.x, f.y - 14, COLORS.teal, 24);
          sfx.pickup("local");
        }
      }
    }
  }

  // Host: broadcast a snapshot at the network rate.
  private hostNet(dts: number, force = false) {
    const sess = this.session;
    if (!sess?.isHost || sess.offline || this.role !== "host" || this.authority.kind !== "ready")
      return;
    this.netAcc += dts;
    this.checkpointAcc += dts;
    if (!force && this.netAcc < 1 / NET_HZ) return;
    this.netAcc = 0;
    const phase = this.checkpointPhase();
    const mark: CheckpointMark = {
      phase: phase.kind === "transition" && phase.built ? "transition-built" : phase.kind,
      versus: this.vs?.phase ?? null,
    };
    const changed =
      mark.phase !== this.checkpointMark?.phase || mark.versus !== this.checkpointMark?.versus;
    const complete =
      force || this.roomDirty || changed || this.checkpointAcc + 1e-9 >= 1 / CHECKPOINT_HZ;
    const snap = this.encodeSnapshot();
    if (complete) {
      const checkpoint = this.encodeCheckpoint();
      if (!checkpoint) return;
      if (this.roomDirty) sess.patchShared({ room: this.encodeRoom(), snap, checkpoint });
      else sess.patchShared({ snap, checkpoint });
      this.checkpointAcc = 0;
      this.checkpointMark = mark;
    } else sess.patchShared({ snap });
    this.roomDirty = false;
  }

  private encodeSnapshot(): Snapshot {
    this.netT++;
    const players: NetPlayer[] = [this.player.encode(this.session?.playerId ?? "host")];
    if (this.remote && this.remoteId) players.push(this.remote.encode(this.remoteId));
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
        action: e.action(),
        tint: e.baseTint,
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
          action: this.boss.action(),
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
      runId: this.authority.kind === "ready" ? this.authority.runId : "",
      term: this.authority.kind === "ready" ? this.authority.term : 0,
      room: this.roomSeq,
      players,
      enemies,
      boss,
      proj,
      hearts: this.hearts,
      maxHearts: this.maxHearts,
      gold: this.gold,
      biome: this.vs ? VS_BIOME : this.run.biome,
      depth: this.run.depth,
      cleared: this.cleared,
      lastStand: this.lastStand
        ? {
            bleed: Math.round(this.lastStand.bleedT * 10) / 10,
            rev: Math.round((this.lastStand.reviveT / REVIVE_HOLD) * 100) / 100,
          }
        : null,
      vs: this.vs ? this.vs.encode() : null,
      banner: "",
    };
  }

  private encodeRoom(): NetRoom {
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
      mode: this.mode === "versus" ? "vs" : "coop",
      type: this.mode === "versus" ? "combat" : this.run.type,
      cols: this.grid.cols,
      rows: this.grid.rows,
      cells: Array.from(this.grid.cells),
      spawnX: this.roomSpawn.x,
      spawnY: this.roomSpawn.y,
      doors,
      propKey: this.mode === "versus" ? "" : (ROOM_PROPS.get(this.run.type)?.key ?? ""),
      mustClear: this.mustClear,
    };
    return room;
  }

  // Guest: rebuild the room view from the host's broadcast (no RunManager).
  private buildRoomFromNet(room: NetRoom) {
    this.teardownRoom();
    const g = new Grid(room.cols, room.rows);
    g.cells.set(room.cells);
    this.grid = g;
    const vs = room.mode === "vs";
    if (vs) this.mode = "versus"; // the host's room broadcast is authoritative
    const pal = this.applyBiome(vs ? VS_BIOME : this.netBiome);
    this.parallax = buildParallax(this, g.cols * TILE, g.rows * TILE, pal);
    this.roomLayer = drawRoom(this, g, pal).setDepth(0);
    const type = parseRoomType(room.type) ?? "combat";
    this.netRoomType = type;
    if (room.propKey) {
      const cfg = ROOM_PROPS.get(type);
      this.roomProp = this.add
        .sprite(BASE_W * 0.17, room.spawnY, `prop:${room.propKey}`)
        .setOrigin(cfg?.ox ?? 0.5, cfg?.oy ?? 0.7)
        .setScale(cfg?.scale ?? 0.7)
        .setDepth(2);
      this.roomProp.play(`prop:${room.propKey}`);
    }
    this.embers = ambientEmbers(this, pal.oneway, g.cols * TILE, g.rows * TILE);
    this.roomSpawn = { x: room.spawnX, y: room.spawnY };
    // Versus: the guest duels from the mirrored right-hand spawn.
    const ownRight = vs && this.seats.guest === this.session?.playerId;
    this.player.enterRoom(g, ownRight ? g.cols * TILE - room.spawnX : room.spawnX, room.spawnY);
    this.remote?.enterRoom(
      g,
      vs && !ownRight ? g.cols * TILE - room.spawnX : room.spawnX,
      room.spawnY,
    );
    this.setupCamera();
    for (const nd of room.doors) {
      const d = new Door(this, nd.x, nd.y, parseRoomType(nd.type) ?? "combat", nd.index);
      d.setActive(false);
      this.doors.push(d);
    }
    this.mustClear = room.mustClear;
    this.cleared = !room.mustClear;
    this.guestRoomSeq = room.seq;
    this.reconciler.reset(); // fresh room, fresh trajectory
    this.netSelfHurting = false;
    this.showBanner(vs ? "VERSUS" : ROOM_LABEL[type], 1000, vs ? "critical" : "status");
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
  // Enemies chase whichever live, non-dead (and non-downed) player is closest.
  private nearestPlayer(x: number, y: number): Player {
    let best = this.player;
    let bd = Infinity;
    for (const pl of this.livePlayers()) {
      if (pl.body.dead || pl.body.downed) continue;
      const d = Math.hypot(pl.x - x, pl.y - y);
      if (d < bd) {
        bd = d;
        best = pl;
      }
    }
    return best;
  }

  private simStep(dt: number) {
    if (this.vs) {
      this.simStepVersus(dt);
      return;
    }
    if (this.combo > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) this.breakCombo();
    }
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
    this.stepLastStand(dt);
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
        this.bossDefeatFx(boss.body.x, boss.body.y, this.run.biome);
        sfx.boom("essential");
        this.shake(420, 0.02);
        this.freeze = Math.max(this.freeze, 0.12);
        this.gainGold(25);
        this.score += 120 * this.run.biome;
        popText(this, boss.body.x, boss.body.y - 44, "+25", "#ffd15c");
        this.showBanner(`${boss.body.kind.name} SLAIN`, 1800, "payoff");
      }
      this.bossDeadT += dt;
      return;
    }

    if (boss.body.pendingWaves.length > 0) {
      for (const w of boss.body.pendingWaves) this.spawnHazard(w.x, w.y, w.vx, w.dmg);
      boss.body.pendingWaves.length = 0;
    }
    if (boss.body.pendingBlast) {
      const b = boss.body.pendingBlast;
      explosion(this, b.x, b.y, b.r, boss.body.kind.tint);
      sfx.boom();
      this.shake(200, 0.014);
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
      this.showBanner("REINFORCEMENTS", 900, "status");
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
    if (boss.body.dead) impactRing(this, boss.body.x, boss.body.y - 22, boss.body.kind.tint, 40);
    this.freeze = Math.max(this.freeze, boss.body.dead ? 0.12 : 0.04);
    this.shake(60, 0.003);
  }

  private spawnHazard(x: number, y: number, vx: number, dmg: number) {
    // Tint the wave with the boss that threw it: the untinted sheet is magenta
    // flame, which read as "fire" in every arena — Rimewarden's frost barrage
    // included — and vanished against Emberdeep's own red walls.
    const spr = this.add
      .sprite(x, y, "fx:flame-wave")
      .setScale(0.9)
      .setDepth(41)
      .setTint(bossKind(this.run.biome).tint);
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
    this.showSpecial(kind, pl.x, pl.y, pl.body.facing, pl.color, pl === this.player);
    if (kind === "aoe") this.freeze = Math.max(this.freeze, 0.06);
  }

  private showSpecial(
    kind: string,
    px: number,
    feetY: number,
    facing: number,
    color: number,
    local: boolean,
  ) {
    const py = feetY - 11;
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
      explosion(this, px, feetY - 6, 30, color);
      sfx.boom(local ? "local" : "routine");
      if (local) this.shake(140, 0.01);
    } else if (kind === "projectile") {
      hitSpark(this, px + facing * 10, py, color, 5);
    }
  }

  // ── combat resolution ──────────────────────────────────────────────────────
  // One player's melee / special / stomp against every enemy + the boss.
  private playerOffense(pl: Player) {
    const pb = pl.body;
    if (pb.downed) return; // a downed player has no offense (incl. stomps)
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
          this.critFeedback(e.body.x, e.body.y - e.body.kind.h / 2);
          cs.hitSwing.add(e);
          if (!e.body.dead) sfx.hit();
          hitSpark(this, e.body.x, e.body.y - e.body.kind.h / 2, COLORS.teal, e.body.dead ? 10 : 6);
          this.freeze = Math.max(this.freeze, e.body.dead ? 0.09 : 0.05);
          this.shake(70, e.body.dead ? 0.006 : 0.003);
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
          this.critFeedback(e.body.x, e.body.y - e.body.kind.h / 2);
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
      this.spawnShot(s.x, s.y, s.vx, s.vy, s.dmg, pl);
      pb.pendingShot = null;
    }
    if (pb.pendingHeal > 0) {
      this.heal(pb.pendingHeal, pl);
      popText(this, pb.x, pb.y - 26, "+HP", "#34e5c8");
      pb.pendingHeal = 0;
    }

    if (pb.vy > 20) {
      for (const e of this.enemies) {
        if (e.body.dead) continue;
        const top = e.body.y - e.body.kind.h;
        if (pb.y <= top + 8 && pb.y >= top - 12 && Math.abs(pb.x - e.body.x) < e.body.kind.hw + 6) {
          e.body.takeHit(this.dmgOut(2), 60, Math.sign(pb.vx) || 1);
          this.critFeedback(e.body.x, top);
          pb.bounce();
          sfx.hit();
          hitSpark(this, e.body.x, top, COLORS.white, 8);
          this.freeze = Math.max(this.freeze, 0.08);
          this.shake(80, 0.006);
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
        explosion(this, b.x, b.y, b.r, biomePalette(this.run.biome).oneway);
        sfx.boom();
        this.shake(160, 0.01);
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
    this.registerKill(e.body.x, e.body.y - e.body.kind.h, 5 + this.run.biome * 2);
    impactRing(this, e.body.x, e.body.y - e.body.kind.h / 2, COLORS.teal, 22);
    sfx.kill();
    if (this.mods.lifesteal > 0 && rand() < this.mods.lifesteal) this.heal(1);
    popText(this, e.body.x, e.body.y - e.body.kind.h, "+2", "#ffd15c");
  }

  // Score a kill and extend the combo. Score per kill scales with the streak, so
  // chaining kills within COMBO_WINDOW is worth far more than picking them off.
  private registerKill(x: number, y: number, base: number) {
    this.combo += 1;
    this.comboT = COMBO_WINDOW;
    this.score += base * this.combo;
    if (this.combo >= 2) {
      popText(this, x, y - 8, `x${this.combo}`, "#ffd15c");
      const col = this.combo >= 8 ? "#ff5a5a" : this.combo >= 5 ? "#ff9a3c" : "#ffd15c";
      this.comboText.setText(`COMBO x${this.combo}`).setColor(col).setAlpha(1);
      this.tweens.killTweensOf(this.comboText);
      // Pop RELATIVE to whatever scale the counter is pinned at: under a trailer
      // zoom the HUD is counter-scaled to 1/z, and an absolute "back to 1" here
      // would leave the streak counter rendering at z× everything else.
      const pin = this.trailerPinScale;
      this.comboText.setScale(REDUCED_MOTION.matches ? pin : 1.35 * pin);
      if (!REDUCED_MOTION.matches)
        this.tweens.add({
          targets: this.comboText,
          scale: pin,
          duration: 200,
          ease: "Back.easeOut",
        });
    }
    this.updateHud();
  }

  private breakCombo() {
    this.combo = 0;
    this.tweens.add({ targets: this.comboText, alpha: 0, duration: 320 });
  }

  // Damage lands on a specific player's body; hearts are a shared co-op pool.
  private hurtPlayer(dmg: number, dir: number, pl: Player = this.player) {
    if (this.state === "dead" || !pl.body.applyHurt(dir)) return;
    if (this.mods.armor > 0 && rand() < this.mods.armor) {
      popText(this, pl.x, pl.y - 24, "WARD", "#9b8cff");
      return; // fully blocked (i-frames already granted by applyHurt)
    }
    this.hearts -= dmg;
    this.freeze = Math.max(this.freeze, 0.06);
    hitSpark(this, pl.x, pl.y - 11, COLORS.magenta, 8);
    this.updateHud();
    if (this.hearts <= 0) {
      // Co-op last stand: a fatal hit with both players up downs the victim
      // instead of wiping; the partner gets a bleed-out window to revive them.
      if (this.canLastStand()) this.enterLastStand(pl);
      else this.playerDie();
    }
  }

  // ── co-op last stand ────────────────────────────────────────────────────────
  // Only in co-op, with both players up and no one already down. A hit taken
  // while a last stand is active (hearts ≤ 0 again) therefore wipes.
  private canLastStand(): boolean {
    if (this.lastStand || !this.remote) return false;
    return this.livePlayers().every((p) => !p.body.dead && !p.body.downed);
  }

  private enterLastStand(pl: Player) {
    this.hearts = 0;
    this.lastStand = { pl, bleedT: BLEED_DUR, reviveT: 0 };
    pl.body.down();
    this.freeze = Math.max(this.freeze, 0.1);
    this.shake(220, 0.012);
    impactRing(this, pl.x, pl.y - 11, COLORS.magenta, 30);
    sfx.downed();
    this.showBanner(
      pl === this.player ? "YOU'RE DOWN — HOLD ON" : "ALLY DOWN — REVIVE!",
      1800,
      "critical",
    );
    this.updateHud();
  }

  // Host: tick the bleed-out clock and the rescuer's revive overlap.
  private stepLastStand(dt: number) {
    const ls = this.lastStand;
    if (!ls) return;
    ls.bleedT -= dt;
    if (ls.bleedT <= 0) {
      this.failLastStand();
      return;
    }
    const rescuer = this.livePlayers().find((p) => p !== ls.pl);
    if (!rescuer || rescuer.body.dead) {
      this.failLastStand();
      return;
    }
    const zone = {
      left: ls.pl.x - REVIVE_RANGE,
      top: ls.pl.y - 30,
      right: ls.pl.x + REVIVE_RANGE,
      bottom: ls.pl.y + 6,
    };
    // Overlap fills the revive meter; separating drains it (fast, not a reset).
    if (rectsOverlap(zone, rescuer.body.hurtBox())) ls.reviveT += dt;
    else ls.reviveT = Math.max(0, ls.reviveT - dt * 2);
    if (ls.reviveT >= REVIVE_HOLD) this.completeRevive();
  }

  private completeRevive() {
    const ls = this.lastStand;
    if (!ls) return;
    this.lastStand = null;
    ls.pl.body.revive();
    // On top of anything healed into the pool while down (e.g. mooni's special).
    this.hearts = Math.min(this.maxHearts, Math.max(0, this.hearts) + REVIVE_HEARTS);
    this.destroyLastStandUi();
    impactRing(this, ls.pl.x, ls.pl.y - 11, COLORS.teal, 34);
    popText(this, ls.pl.x, ls.pl.y - 30, "REVIVED", "#34e5c8");
    sfx.revive();
    this.showBanner("REVIVED", 1200, "critical");
    this.updateHud();
  }

  // Bleed-out expired (or the rescuer fell): the shared run is over.
  private failLastStand() {
    this.lastStand = null;
    this.destroyLastStandUi();
    this.playerDie();
  }

  // Downed marker, drawn each frame on BOTH clients: a pulsing revive ring, a
  // shrinking bleed-out bar, a teal revive-progress bar, and the rescuer prompt.
  private renderLastStand() {
    const ls: NetLastStand | null =
      this.role === "guest"
        ? this.netLastStand
        : this.lastStand
          ? { bleed: this.lastStand.bleedT, rev: this.lastStand.reviveT / REVIVE_HOLD }
          : null;
    const downed = this.livePlayers().find((p) => p.body.downed);
    if (!ls || !downed) {
      this.destroyLastStandUi();
      return;
    }
    if (!this.lsG) this.lsG = this.add.graphics().setDepth(66);
    if (!this.lsLabel)
      this.lsLabel = this.add
        .text(0, 0, "", { fontFamily: "monospace", fontSize: "8px", color: "#34e5c8" })
        .setOrigin(0.5, 1)
        .setDepth(66);
    const x = downed.sprite.x;
    const y = downed.sprite.y;
    const g = this.lsG;
    g.clear();
    const pulse = 1 + Math.sin(this.time.now / 160) * 0.12;
    g.lineStyle(1.5, COLORS.teal, 0.75);
    g.strokeCircle(x, y - 10, REVIVE_RANGE * pulse);
    const frac = Phaser.Math.Clamp(ls.bleed / BLEED_DUR, 0, 1);
    const w = 26;
    g.fillStyle(0x000000, 0.55);
    g.fillRect(x - w / 2, y - 36, w, 3);
    g.fillStyle(frac < 0.35 ? 0xff5a5a : COLORS.magenta, 0.95);
    g.fillRect(x - w / 2, y - 36, w * frac, 3);
    if (ls.rev > 0) {
      g.fillStyle(COLORS.teal, 0.95);
      g.fillRect(x - w / 2, y - 32, w * Math.min(1, ls.rev), 2);
    }
    const mine = downed === this.player;
    this.lsLabel
      .setPosition(x, y - 39)
      .setText(mine ? `HOLD ON ${Math.ceil(ls.bleed)}` : `REVIVE ${Math.ceil(ls.bleed)}`)
      .setAlpha(0.7 + Math.sin(this.time.now / 200) * 0.3);
  }

  private destroyLastStandUi() {
    this.lsG?.destroy();
    this.lsG = undefined;
    this.lsLabel?.destroy();
    this.lsLabel = undefined;
  }

  private playerDie() {
    if (this.state === "dead") return;
    this.lastStand = null;
    this.netLastStand = null;
    this.destroyLastStandUi();
    this.hearts = 0;
    this.state = "dead";
    this.deadT = 0;
    this.player.sprite.play(`${this.heroName}:death`);
    sfx.die();
    // Push one final hearts=0 snapshot so the guest sees the shared death.
    if (this.role === "host") this.hostNet(0, true);
    if (this.trailerActive) {
      // Trailer deaths never touch the real meta/best-score saves; show the
      // shard yield the death WOULD bank (death-as-progress is the beat).
      const would = Math.floor(this.gold / 4) + this.run.depth * 2 + (this.run.biome - 1) * 6;
      this.showBanner(`YOU FELL   SCORE ${this.score}   +${would} ✦`, 2600, "critical");
      return;
    }
    const earned = bankRun(loadMeta(), this.gold, this.run.depth, this.run.biome);
    const best = recordBestScore(this.score);
    this.runRecap = {
      kind: "banked",
      hero: this.heroName,
      biome: this.run.biome,
      depth: this.run.depth,
      gold: this.gold,
      score: this.score,
      shardsEarned: earned,
      bestScore: best,
    };
    const pb = this.score > 0 && this.score >= best ? "  ★ NEW BEST" : "";
    this.showBanner(`YOU FELL   SCORE ${this.score}${pb}   +${earned} ✦`, 2600, "critical");
  }

  // ── online versus ───────────────────────────────────────────────────────────
  // Host: the duel sim — two players + their projectiles + PvP resolution. No
  // enemies, doors, features, shared hearts, or last stand in this mode.
  private simStepVersus(dt: number) {
    const vs = this.vs;
    if (!vs) return;
    const trans = vs.step(dt);
    if (trans === "fight") {
      this.showBanner("FIGHT!", 700, "critical");
      sfx.bossRoar();
    } else if (trans === "respawn") {
      this.vsRespawn();
      this.showBanner(`ROUND ${vs.round}`, 1100, "critical");
      sfx.door("local");
    } else if (trans === "matchEnd") {
      this.showBanner(
        `${this.vsName(vs.winner)} WINS THE MATCH  ·  ${this.rematchHint()}`,
        60000,
        "critical",
      );
    }
    for (const pl of this.livePlayers()) pl.step(dt);
    this.stepShots(dt);
    if (vs.phase === "fighting" && this.remote) {
      this.versusOffense(this.player, this.remote);
      this.versusOffense(this.remote, this.player);
    }
    this.updateHud();
  }

  // Reset both duelists onto their mirrored spawn points (round start / lobby).
  private vsRespawn() {
    this.shots.forEach((s) => s.spr.destroy());
    this.shots = [];
    const pls = [this.player, this.remote];
    pls.forEach((pl) => {
      if (!pl) return;
      const s = this.vsSpawns[this.vsSide(pl) === "host" ? 0 : 1] ?? this.roomSpawn;
      pl.body.dead = false;
      pl.enterRoom(this.grid, s.x, s.y);
    });
    this.updateHud();
  }

  // One duelist's melee / special / stomp / projectile intents against the other.
  private versusOffense(att: Player, vic: Player) {
    const seq = this.vsSeq(att);
    const dir = Math.sign(vic.body.x - att.body.x) || att.body.facing;
    const ab = att.body.attackBox();
    // Burn the swing id only when the hit actually LANDS. Marking it on mere
    // overlap spent the swing on a target that was still in hurt i-frames, so
    // when those lapsed a few steps later — while the very same hitbox was
    // still live — the blade passed straight through. A landed hit grants 0.9s
    // of i-frames, far longer than any active window, so this cannot double-hit.
    if (
      ab &&
      att.body.swingId !== seq.swing &&
      !vic.body.dead &&
      rectsOverlap(ab, vic.body.hurtBox()) &&
      this.hurtVersus(vic, ab.dmg, dir)
    ) {
      seq.swing = att.body.swingId;
    }
    const sb = att.body.specialBox();
    if (
      sb &&
      att.body.specialId !== seq.special &&
      !vic.body.dead &&
      rectsOverlap(sb, vic.body.hurtBox()) &&
      this.hurtVersus(vic, sb.dmg, dir)
    ) {
      seq.special = att.body.specialId;
    }
    if (att.body.pendingShot) {
      const s = att.body.pendingShot;
      this.spawnShot(s.x, s.y, s.vx, s.vy, s.dmg, att);
      att.body.pendingShot = null;
    }
    if (att.body.pendingHeal > 0) {
      this.vs?.heal(this.vsSide(att), att.body.pendingHeal);
      popText(this, att.body.x, att.body.y - 26, "+HP", "#34e5c8");
      sfx.heal(att === this.player ? "local" : "routine");
      att.body.pendingHeal = 0;
      this.updateHud();
    }
    // TowerFall classic: landing on the opponent's head costs them a heart.
    if (att.body.vy > 20 && !vic.body.dead) {
      const top = vic.body.hurtBox().top;
      if (
        att.body.y <= top + 8 &&
        att.body.y >= top - 12 &&
        Math.abs(att.body.x - vic.body.x) < 12
      ) {
        att.body.bounce();
        sfx.jump();
        this.hurtVersus(vic, 1, Math.sign(att.body.vx) || 1);
      }
    }
  }

  // Versus damage: lands on the victim's OWN hearts (no shared pool, no last
  // stand); dash/hurt i-frames still gate it. A fatal hit ends the round.
  // Returns whether the hit actually connected (see the swing-id guard above).
  private hurtVersus(vic: Player, dmg: number, dir: number): boolean {
    const vs = this.vs;
    if (!vs || vs.phase !== "fighting") return false;
    if (!vic.body.applyHurt(dir)) return false;
    this.freeze = Math.max(this.freeze, 0.06);
    hitSpark(this, vic.x, vic.y - 11, COLORS.magenta, 8);
    sfx.hit();
    this.shake(80, 0.005);
    const ended = vs.damage(this.vsSide(vic), dmg);
    this.updateHud();
    if (ended) this.vsRoundOver(vic);
    return true;
  }

  // The fatal hit: drop the loser where they stand and bank the round.
  private vsRoundOver(loser: Player) {
    const vs = this.vs;
    if (!vs) return;
    loser.body.dead = true;
    this.freeze = Math.max(this.freeze, 0.12);
    this.shake(260, 0.014);
    impactRing(this, loser.x, loser.y - 11, COLORS.magenta, 36);
    sfx.die();
    this.showBanner(`${this.vsName(vs.winner)} TAKES THE ROUND`, 1500, "critical");
    this.updateHud();
  }

  // Per-attacker swing/special dedup so one strike lands on the victim once.
  private vsSeq(pl: Player): { swing: number; special: number } {
    let s = this.vsHitSeq.get(pl);
    if (!s) {
      s = { swing: 0, special: 0 };
      this.vsHitSeq.set(pl, s);
    }
    return s;
  }

  // Which wire side a Player object is — only meaningful on the host, where
  // this.player IS the host duelist.
  private vsSide(pl: Player): VsSide {
    const id = this.ownerId(pl);
    if (id) return id === this.seats.host ? "host" : "guest";
    return pl === this.player ? "host" : "guest";
  }

  // The Player rendering a wire side on THIS client (host: player/remote;
  // guest: remote is the host's puppet).
  private vsPlayer(side: VsSide): Player | undefined {
    if (this.session) {
      const id = this.seats[side];
      return id ? this.seatPlayer(id) : undefined;
    }
    if (this.role === "guest") return side === "guest" ? this.player : this.remote;
    return side === "host" ? this.player : this.remote;
  }

  // Input-aware match-end hint: touch players rematch with ATK / leave via the
  // on-screen EXIT button; keyboard keeps J / ESC.
  private rematchHint(): string {
    return this.touch ? "ATK REMATCH · EXIT HUB" : "J REMATCH · ESC HUB";
  }

  // Banner-friendly duelist name, flagged when it's the local player. The
  // P1/P2 prefix keeps mirror matches unambiguous (both picked the same hero).
  private vsName(side: VsSide | null): string {
    if (!side) return "";
    const tag = side === "host" ? "P1" : "P2";
    const pl = this.vsPlayer(side);
    if (!pl) return tag;
    return pl === this.player ? `${tag} ${pl.title} (YOU)` : `${tag} ${pl.title}`;
  }

  // Versus HUD, on both clients: host duelist on the left, guest on the right —
  // hero name, this round's hearts, and round-win pips. ▸ marks the local side.
  private updateVersusHud() {
    const v = this.role === "guest" ? this.netVs : (this.vs?.encode() ?? null);
    if (!v) return;
    this.infoText.setFontSize(12);
    const line = (side: VsSide, hp: number, score: number): string => {
      const pl = this.vsPlayer(side);
      if (!pl) return "AWAITING CHALLENGER…";
      const you = pl === this.player ? "▸" : " ";
      const hearts = "♥".repeat(Math.max(0, hp)) + "♡".repeat(Math.max(0, VS_HEARTS - hp));
      const pips = "●".repeat(score) + "○".repeat(Math.max(0, VS_WIN_SCORE - score));
      return `${you}${pl.title}  ${hearts}  ${pips}`;
    };
    const hex = (side: VsSide): string => {
      const pl = this.vsPlayer(side);
      return pl ? `#${pl.color.toString(16).padStart(6, "0")}` : "#8b95a1";
    };
    this.heartsText.setText(line("host", v.hostHp, v.hostScore)).setColor(hex("host"));
    this.infoText.setText(line("guest", v.guestHp, v.guestScore)).setColor(hex("guest"));
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
        const rc = RARITY_COLOR[relic.rarity];
        popText(this, f.x, f.y - 22, relic.name, `#${rc.toString(16).padStart(6, "0")}`);
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
  private spawnShot(
    x: number,
    y: number,
    vx: number,
    vy: number,
    dmg: number,
    owner: Player | null,
  ) {
    const spr = this.add.sprite(x, y, "fx:flame-wave").setScale(0.7).setDepth(42);
    spr.play("fx:flame-wave");
    spr.setFlipX(vx < 0);
    this.shots.push({
      spr,
      x,
      y,
      vx,
      vy,
      life: 1.4,
      dmg,
      owner,
      hit: new Set(),
      hitP: new Set(),
      hitBoss: false,
    });
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
          this.critFeedback(e.body.x, e.body.y - e.body.kind.h / 2);
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
      // Versus: the wave also burns the other duelist (never its own caster).
      if (this.vs?.phase === "fighting") {
        const box = { left: s.x - 12, top: s.y - 8, right: s.x + 12, bottom: s.y + 8 };
        for (const pl of this.livePlayers()) {
          if (pl === s.owner || pl.body.dead || s.hitP.has(pl)) continue;
          if (rectsOverlap(box, pl.body.hurtBox())) {
            s.hitP.add(pl);
            this.hurtVersus(pl, s.dmg, Math.sign(s.vx) || 1);
          }
        }
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
      if (this.mods.regen > 0 && this.hearts < this.maxHearts) this.heal(this.mods.regen);
      this.doors.forEach((d) => d.setActive(true));
      this.roomClearFx(this.run.type, this.run.biome);
    }
  }

  private bossDefeatFx(x: number, y: number, biome: number) {
    const color = bossKind(biome).tint;
    explosion(this, x, y - 20, 60, color);
    impactRing(this, x, y - 12, color, 82);
  }

  private roomClearFx(type: RoomType, biome: number) {
    const color = biomePalette(biome).oneway;
    for (const door of this.doors) {
      impactRing(this, door.x, door.y - 20, color, type === "elite" ? 32 : 22);
      if (type === "elite") hitSpark(this, door.x, door.y - 20, color, 10);
    }
    this.showBanner(
      type === "boss"
        ? "DESCEND"
        : type === "elite"
          ? "ELITE CLEAR — pick a path"
          : "CLEAR — pick a path",
      1400,
      "objective",
    );
  }

  private checkDoors() {
    // Trailer scenes are single-room shots: a door walk-through mid-take would
    // rebuild the world under the camera.
    if (this.trailerActive) return;
    // No leaving a downed teammate behind: doors lock during a last stand.
    if (!this.cleared || this.state !== "active" || this.lastStand) return;
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
    sfx.door("local");
  }

  private announceBoss(biome: number) {
    if (this.bossAnnounced) return;
    this.bossAnnounced = true;
    sfx.bossRoar();
    this.showBanner(bossKind(biome).banner, 1600, "arrival");
  }

  // One active cue and one replaceable objective. Nothing queues combat or
  // input: only the still-useful exit instruction can wait behind a payoff.
  private showBanner(text: string, ms: number, kind: BannerKind) {
    if (kind !== "critical" && (this.state === "dead" || this.lastStand || this.netLastStand))
      return;
    const active = this.activeBanner;
    if (active?.kind === kind && active.text === text) return;
    if (active && BANNER_PRIORITY[kind] < BANNER_PRIORITY[active.kind]) {
      if (kind === "objective" && (active.kind === "arrival" || active.kind === "payoff"))
        this.pendingObjective = { text, hold: ms, remaining: 3600 };
      return;
    }
    if (kind === "critical" || kind === "connecting" || kind === "objective")
      this.pendingObjective = null;
    this.beginBanner({ kind, text, hold: ms, age: 0 });
  }

  private beginBanner(entry: BannerEntry) {
    this.activeBanner = entry;
    this.banner
      .setText(entry.kind === "arrival" ? `BOSS ENCOUNTER\n${entry.text}` : entry.text)
      .setWordWrapWidth(BASE_W - 36, true)
      .setAlign("center")
      .setColor(
        entry.kind === "arrival" || entry.kind === "payoff"
          ? "#ffd15c"
          : entry.kind === "critical"
            ? "#f4f7fb"
            : "#34e5c8",
      )
      .setAlpha(1)
      .setScale(this.trailerPinScale);
  }

  // Scene delta advances during hitstop/death/connecting, but freezes when the
  // solo wrapper sleeps the loop. No wall clock, tween callbacks or backlog.
  private updateBanner(ms: number) {
    if (this.pendingObjective) {
      this.pendingObjective.remaining -= ms;
      if (this.pendingObjective.remaining <= 0) this.pendingObjective = null;
    }
    const active = this.activeBanner;
    if (!active) return;
    active.age += ms;
    if (active.age >= active.hold + 350) {
      this.activeBanner = null;
      this.banner.setAlpha(0).setScale(this.trailerPinScale);
      const pending = this.pendingObjective;
      this.pendingObjective = null;
      if (pending && this.state === "active" && !this.lastStand && !this.netLastStand)
        this.beginBanner({ kind: "objective", text: pending.text, hold: pending.hold, age: 0 });
      return;
    }
    const alpha = active.age <= active.hold ? 1 : 1 - (active.age - active.hold) / 350;
    const settle =
      active.kind === "arrival" && !REDUCED_MOTION.matches
        ? 1 + 0.04 * Math.max(0, 1 - active.age / 180)
        : 1;
    this.banner.setAlpha(alpha).setScale(this.trailerPinScale * settle);
  }

  private clearBanners() {
    this.activeBanner = null;
    this.pendingObjective = null;
    this.banner.setAlpha(0).setScale(this.trailerPinScale);
  }

  private updateHud() {
    const special = this.role === "guest" ? this.guestSpecial : this.player.body.specialReadiness;
    const visible = !this.controlsPaused && this.state === "active" && !this.trailerActive;
    if (this.mode === "versus") {
      this.updateVersusHud();
      const phase = this.role === "guest" ? this.netVs?.phase : this.vs?.phase;
      this.expeditionHud?.updateSpecial(
        phase && vsPhaseFrozen(phase) ? { kind: "busy" } : special,
        visible,
      );
      return;
    }
    const biome = this.role === "guest" ? this.netBiome : this.run.biome;
    const depth = this.role === "guest" ? this.netDepth : this.run.depth;
    const type = this.role === "guest" ? this.netRoomType : this.run.type;
    if (!this.trailerActive) {
      this.banner.setY(type === "merchant" ? 170 : BASE_H / 2 - 20);
      this.banner.setVisible(
        !this.expeditionHud?.inspecting || this.activeBanner?.kind === "critical",
      );
    }
    const boss = this.role === "guest" ? this.bossPuppet?.net : this.boss?.body;
    const bossName = boss && !boss.dead ? bossKind(biome).name : null;
    if (!this.trailerActive)
      this.comboText.setY(bossName ? 67 + gameInset(this).top : 42 + gameInset(this).top);
    let nearest: MerchantItem | undefined;
    if (type === "merchant") {
      for (const item of this.merchantItems)
        if (!nearest || Math.abs(item.x - this.player.x) < Math.abs(nearest.x - this.player.x))
          nearest = item;
    }
    const offer: ExpeditionOffer | null = nearest
      ? {
          name: nearest.relic.name,
          desc: nearest.relic.desc,
          price: nearest.relic.price,
          kind: nearest.bought
            ? "sold"
            : this.gold >= nearest.relic.price
              ? "affordable"
              : "unaffordable",
        }
      : null;
    this.expeditionHud?.update({
      hearts: this.hearts,
      maxHearts: this.maxHearts,
      biomeName: biomePalette(biome).name,
      biome,
      depth,
      bossAt: this.run.bossAt,
      gold: this.gold,
      score: this.score,
      special,
      bossName,
      safeRoom: !this.run.isCombat(type),
      relics: RELICS.filter((r) => this.ownedRelics.has(r.id)),
      offer,
      visible,
    });
  }

  // ── trailer-mode hooks ──────────────────────────────────────────────────────
  // Staging surface for src/trailer/trailer-director.ts (?trailer=1 only). All
  // methods drive the exact same code paths gameplay uses — real rooms, real
  // enemies, real combat resolution — they only skip the menu/network plumbing.
  // Nothing in normal play calls any of this.

  /** Fully restage the world as one trailer shot: fresh solo/duo actors, a
   * seeded room, scene-scoped mods/hearts/gold, HUD policy, and the sim frozen
   * until the shell reveals the scene (trailerFreeze(0) on first run frame). */
  trailerStage(o: TrailerStageOpts): void {
    this.trailerActive = true;
    this.runRecap = null;
    this.clearBanners();
    if (o.seed !== undefined) reseed(o.seed);
    // Cross-scene reset: every shot stages from nothing, independent of what
    // the previous shot did (deaths, versus rounds, last stands, relics).
    this.state = "active";
    this.deadT = 0;
    this.transT = 0;
    this.transBuilt = false;
    this.pendingOffer = null;
    this.freeze = 0;
    this.mods = { ...baseMods(), ...o.mods };
    this.ownedRelics = new Set(o.ownedRelics ?? []);
    this.maxHearts = Math.max(1, this.mods.maxHearts);
    this.hearts = o.hearts ?? this.maxHearts;
    this.gold = o.gold ?? 0;
    this.score = o.score ?? 0;
    this.combo = 0;
    this.comboT = 0;
    this.lastCrit = false;
    this.tweens.killTweensOf(this.comboText);
    this.comboText.setAlpha(0);
    this.lastStand = null;
    this.destroyLastStandUi();
    this.mode = "coop";
    this.vs = null;
    this.vsSpawns = [];
    this.vsHitSeq = new WeakMap();

    // Fresh actors — hero kits bind at construction, so scenes swap heroes by
    // rebuilding the Player wrappers (same spawnPlayer path as create()).
    this.player.destroy();
    this.remote?.destroy();
    this.remote = undefined;
    this.heroName = o.hero;

    if (o.room === "versus") {
      // Offline duel: both fighters are local bodies through the real
      // VersusMatch machine (sys/versus.ts) — no network, same rules.
      this.mode = "versus";
      const vs = new VersusMatch();
      this.vs = vs;
      const g = new Grid();
      this.player = this.spawnPlayer(HEROES[o.hero], g, 0, 0);
      this.remote = this.spawnPlayer(HEROES[o.hero2 ?? "reaper"], g, 0, 0);
      this.buildVersusRoom();
      vs.beginMatch();
      vs.t = 0.03; // collapse the round-intro freeze: FIGHT! lands on reveal
      const st = o.vsState;
      if (st) {
        vs.hp.host = st.hostHp ?? vs.hp.host;
        vs.hp.guest = st.guestHp ?? vs.hp.guest;
        vs.score.host = st.hostScore ?? vs.score.host;
        vs.score.guest = st.guestScore ?? vs.score.guest;
        vs.round = st.round ?? vs.round;
      }
    } else {
      const def = this.run.debugEnter(o.room, o.biome ?? 1, o.depth ?? 2);
      if (o.noEnemies) def.enemySpawns.length = 0;
      this.player = this.spawnPlayer(
        HEROES[o.hero],
        def.grid,
        def.playerSpawn.x,
        def.playerSpawn.y,
      );
      if (o.hero2)
        this.remote = this.spawnPlayer(
          HEROES[o.hero2],
          def.grid,
          def.playerSpawn.x,
          def.playerSpawn.y,
        );
      this.buildRoom(def);
      if (o.hideDoors) {
        // Scenic shots (e.g. the moonrise release beat) stage the hero where an
        // active exit gate would otherwise pulse in frame. Safe to drop them:
        // checkDoors is trailer-gated and checkClear's setActive no-ops on an
        // empty list, so nothing else reads the doors mid-shot.
        this.doors.forEach((d) => d.destroy());
        this.doors = [];
      }
    }
    if (o.fgTrees === false) {
      // The nearest parallax layer draws IN FRONT of the actors (depth 40): in a
      // 240-px-wide framing one trunk can swallow the whole fight. Combat shots
      // drop it; scenic ones keep it for the depth cue.
      this.parallax = this.parallax.filter((t) => {
        if (t.name !== FG_TREE_NAME) return true;
        t.destroy();
        return false;
      });
    }
    if (o.playerAt) this.player.enterRoom(this.grid, o.playerAt.x, o.playerAt.y);
    if (o.player2At) this.remote?.enterRoom(this.grid, o.player2At.x, o.player2At.y);

    // HUD policy: everything hidden unless the shot opts in; visibility (not
    // alpha) so showBanner/updateHud can't resurrect a hidden element.
    const hud = o.hud ?? {};
    this.heartsText.setVisible(hud.hearts ?? false);
    this.infoText.setVisible(hud.info ?? false).setFontSize(9); // versus HUD bumps to 12
    this.banner.setVisible(hud.banner ?? false);
    this.comboText.setVisible(hud.combo ?? false);
    const bossBar = hud.bossBar ?? false;
    this.bossHp?.setVisible(bossBar);
    this.bossHpBg?.setVisible(bossBar);
    // Kill the room-build announcement; scenes trigger their own banners.
    this.clearBanners();
    this.fadeRect.setAlpha(0);
    this.updateHud();
    // Hold the sim until the shell reveals the shot (the cut plate is still black).
    this.freeze = 9999;
  }

  /** Trailer-only lens: an INTEGER world zoom (1 = the play camera, 2 = twice
   * the subject size). Phaser scales screen-pinned (scrollFactor 0) objects
   * about the camera midpoint along with the world, so a raw setZoom would
   * double the HUD and shove the corner-anchored parts off-frame. Counter-
   * transform the pinned set instead — hearts/info/banner/combo/boss bar and
   * the sky/fog/fade plates land pixel-for-pixel where they were authored,
   * while the world gets the lens. Integer steps only: a fractional zoom
   * shimmers pixel art. */
  trailerZoom(z: number): void {
    this.cameras.main.setZoom(z);
    this.trailerPinScale = 1 / z;
    const cx = BASE_W / 2;
    const cy = BASE_H / 2;
    const pinned: (
      | Phaser.GameObjects.Rectangle
      | Phaser.GameObjects.Text
      | Phaser.GameObjects.Image
      | undefined
    )[] = [
      this.sky?.image,
      this.fogRect,
      this.fadeRect,
      this.heartsText,
      this.infoText,
      this.banner,
      this.comboText,
      this.bossHpBg,
      this.bossHp,
    ];
    for (const o of pinned) {
      if (!o) continue;
      let base = this.trailerPinBase.get(o);
      if (!base) {
        base = { x: o.x, y: o.y };
        this.trailerPinBase.set(o, base);
      }
      o.setPosition((base.x - cx) / z + cx, (base.y - cy) / z + cy);
      // The sky texture is half-resolution; retain its logical display size.
      o.setScale(
        (o === this.sky?.image ? BASE_W / o.width : 1) / z,
        (o === this.sky?.image ? BASE_H / o.height : 1) / z,
      );
    }
  }

  /** Spawn one enemy into the live fight (real Enemy + biome HP scaling; the
   * optional affix id recolours/buffs it exactly like an elite-room roll). */
  trailerSpawnEnemy(name: EnemyName, x: number, y: number, affixId?: string): void {
    const e = new Enemy(this, this.grid, ENEMIES[name], x, y);
    e.body.hp += Math.floor((this.run.biome - 1) / 2);
    const affix = AFFIXES.find((a) => a.id === affixId);
    if (affix) this.applyAffix(e, affix);
    this.enemies.push(e);
  }

  /** Scripted input source: sampled once per frame in place of the keyboard
   * (p1 = local hero, p2 = the staged second hero). null restores normal input. */
  trailerSetInput(provider: (() => TrailerInputs) | null): void {
    this.trailerIn = provider;
  }

  /** Advance the sim by n fixed steps while the screen is black — pre-rolls
   * velocity/AI so the first visible frame is already mid-action. Bypasses the
   * freeze on purpose. */
  trailerTick(steps: number): void {
    for (let i = 0; i < steps; i++) {
      const s = this.trailerIn ? this.trailerIn() : null;
      if (s) {
        this.player.buffer(s.p1);
        if (this.remote && s.p2) this.remote.buffer(s.p2);
      }
      this.simStep(STEP);
    }
    // Settle the views so the camera snap targets real positions.
    this.player.render(1);
    this.remote?.render(1);
    this.enemies.forEach((e) => e.render(1));
    this.boss?.render(1);
  }

  /** Freeze (seconds — the existing hitstop clock) or unfreeze (0) the sim. */
  trailerFreeze(seconds: number): void {
    this.freeze = seconds;
  }

  /** Mid-shot mod tweak (e.g. arm 100% ward once a last stand is staged). */
  trailerMods(m: Partial<RunMods>): void {
    Object.assign(this.mods, m);
  }

  /** Fire the game's own centre banner (visible only if the shot's HUD opts in). */
  trailerBanner(text: string, ms: number): void {
    this.showBanner(text, ms, "critical");
  }

  /** Live handles for choreography: steering reads positions, boss direction
   * calls forceState, versus scripts read the encoded match state. */
  trailerWorld(): TrailerWorld {
    return {
      p1: this.player,
      p2: this.remote ?? null,
      boss: this.boss,
      enemies: this.enemies,
      vs: this.vs ? this.vs.encode() : null,
    };
  }
}

// ── trailer-mode types (consumed by src/trailer/trailer-director.ts) ─────────
export type TrailerInputs = { p1: InputState; p2: InputState | null };
export type TrailerHudOpts = {
  hearts?: boolean;
  info?: boolean;
  banner?: boolean;
  combo?: boolean;
  bossBar?: boolean;
};
export type TrailerStageOpts = {
  hero: HeroName;
  /** Stage a second local hero (offline co-op / versus scenes). */
  hero2?: HeroName;
  room: RoomType | "versus";
  biome?: number;
  depth?: number;
  /** Seeds the gameplay RNG (rooms, crits, relic offers) for repeatable shots. */
  seed?: number;
  mods?: Partial<RunMods>;
  hearts?: number;
  gold?: number;
  score?: number;
  /** Pre-owned relic ids — narrows merchant/cache offers deterministically. */
  ownedRelics?: readonly string[];
  /** Strip the room template's enemy spawns (the shot places its own). */
  noEnemies?: boolean;
  /** Destroy the room's exit doors after build — for still/scenic shots where
   * an active gate's pulsing glow + label would sit in frame. */
  hideDoors?: boolean;
  /** Draw the in-front parallax tree layer (default true). false for combat
   * shots, where a foreground trunk otherwise occludes the fight. */
  fgTrees?: boolean;
  playerAt?: { x: number; y: number };
  player2At?: { x: number; y: number };
  hud?: TrailerHudOpts;
  /** Versus only: mid-match state (hearts / round pips) staged before the shot. */
  vsState?: {
    hostHp?: number;
    guestHp?: number;
    hostScore?: number;
    guestScore?: number;
    round?: number;
  };
};
export type TrailerWorld = {
  p1: Player;
  p2: Player | null;
  boss: Boss | null;
  enemies: readonly Enemy[];
  vs: NetVersus | null;
};
