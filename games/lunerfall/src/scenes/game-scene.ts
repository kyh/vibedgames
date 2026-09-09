import type Phaser from "phaser";
import { BlendModes, Scene, Scenes } from "phaser";

import { attachVirtualGamepad } from "@vibedgames/gamepad/phaser";
import type { ButtonOptions, PhaserGamepad, Viewport } from "@vibedgames/gamepad/phaser";

import { sfx } from "../audio/sfx";
import { BASE_H, BASE_W, MAX_STEPS, STEP } from "../config";
import { HERO_NAMES } from "../data/animations";
import type { EnemyName, HeroName } from "../data/animations";
import { biomePalette } from "../data/biomes";
import { bossKind } from "../data/bosses";
import { HEROES } from "../data/heroes";
import type { HeroDef } from "../data/heroes";
import { bankRun, loadMeta, recordBestScore, runBonuses } from "../data/meta";
import { baseMods, RELICS } from "../data/relics";
import type { RunMods } from "../data/relics";
import { parseRoomType } from "../data/rooms";
import type { RoomType } from "../data/rooms";
import type { RunRecap } from "../data/run-recap";
import type { Boss } from "../entities/boss";
import type { Door } from "../entities/door";
import type { Enemy } from "../entities/enemy";
import { Player } from "../entities/player";
import { isJsonString } from "../net/json";
import type { JsonValue } from "../net/json";
import type { NetSession } from "../net/session";
import type { CheckpointSeats } from "../net/checkpoint";
import { PixelSky } from "../render/pixel-sky";
import { ExpeditionHud } from "../expedition-hud";
import type { ExpeditionOffer } from "../expedition-hud";
import { dust, wallSmoke } from "../sys/fx";
import { diag } from "../sys/diag";
import type { Grid } from "../sys/grid";
import { reseed, unseed } from "../sys/rng";
import { RunManager } from "../sys/run";
import type { Offer } from "../sys/run";
import { Input, NEUTRAL_INPUT } from "../sys/input";
import type { InputState } from "../sys/input";
import { gameInset, isCoarse, REDUCED_MOTION, touchHudBand } from "../sys/screen";
import type { VersusMatch } from "../sys/versus";
import { mountTouchHud, syncTouchHud } from "../touch-hud";
import { BannerHud } from "./banner-hud";
import { CheckpointSync } from "./checkpoint-sync";
import { Combat } from "./combat";
import { GuestSync } from "./guest-sync";
import { HostNet } from "./host-net";
import { LastStand } from "./last-stand";
import { OnlineFlow } from "./online-flow";
import { RoomBuilder } from "./room-builder";
import { RoomProgress } from "./room-progress";
import { newCombatState } from "./scene-types";
import type {
  Arrow,
  CombatState,
  Feature,
  Hazard,
  MerchantItem,
  SceneState,
  Shot,
} from "./scene-types";
import { TrailerStaging } from "./trailer-staging";
import type { TrailerInputs, TrailerStageOpts, TrailerWorld } from "./trailer-staging";
import { VersusFlow } from "./versus-flow";

const MAX_HEARTS = 4;

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

// Run-driven scene: RunManager stitches typed rooms; the scene owns the world
// state, the frame loop and the chrome, and delegates each concern to a
// collaborator that reaches back through a narrow Pick of this class:
//   rooms       builds/tears down a room (room-builder.ts)
//   combat      damage, offense, projectiles (combat.ts)
//   progress    rewards, clear condition, doors (room-progress.ts)
//   lastStand   co-op down/revive (last-stand.ts)
//   versus      online duel flow (versus-flow.ts)
//   online      connection + authority + expedition begin/restart (online-flow.ts)
//   hostNet     host broadcast, remote presence + input (host-net.ts)
//   guest       guest snapshot apply + prediction reconcile (guest-sync.ts)
//   checkpoint  expedition checkpoint encode/adopt (checkpoint-sync.ts)
//   banners     centre-screen cue line (banner-hud.ts)
//   trailer     ?trailer=1 staging (trailer-staging.ts)
export class GameScene extends Scene {
  run = new RunManager();
  readonly banners = new BannerHud(this);
  readonly rooms = new RoomBuilder(this);
  readonly trailer = new TrailerStaging(this);
  readonly lastStand = new LastStand(this);
  readonly versus = new VersusFlow(this);
  readonly combat = new Combat(this);
  readonly progress = new RoomProgress(this);
  readonly hostNet = new HostNet(this);
  readonly guest = new GuestSync(this);
  readonly checkpoint = new CheckpointSync(this);
  readonly online = new OnlineFlow(this);
  grid!: Grid;
  player!: Player;
  controls!: Input;
  private gamepad!: PhaserGamepad;
  touch = false;
  acc = 0;

  sky?: PixelSky;
  private expeditionHud?: ExpeditionHud;
  // per-biome atmosphere wash
  fogRect?: Phaser.GameObjects.Rectangle;
  doors: Door[] = [];
  offers: Offer[] = [];
  feature: Feature | null = null;
  enemies: Enemy[] = [];
  arrows: Arrow[] = [];
  shots: Shot[] = [];
  hazards: Hazard[] = [];
  boss: Boss | null = null;
  bossHp?: Phaser.GameObjects.Rectangle;
  bossHpBg?: Phaser.GameObjects.Rectangle;
  bossDeadT = 0;
  heroName: HeroName = "axion";
  requestedHero: HeroName = "axion";

  // Co-op: the local player is always `this.player`; `this.remote` is the other
  // player when connected. Combat runs per-player with its own hit-dedup state.
  remote?: Player;
  combatStates = new WeakMap<Player, CombatState>();
  mode: "coop" | "versus" = "coop";

  // Networking (undefined = solo). Host runs the authoritative sim + broadcasts;
  // guest renders the broadcast, predicting only its OWN body (guest.bodyDrive).
  session?: NetSession;
  role: "solo" | "host" | "guest" = "solo";
  authority:
    | { kind: "waiting" }
    | { kind: "ready"; runId: string; term: number; revision: number } = { kind: "waiting" };
  seats: CheckpointSeats = { guest: null, host: null };
  remoteId: string | null = null;
  controlsPaused = false;
  neutralOnAdmission = false;

  // this frame's local sample (guest)
  guestIn: InputState = NEUTRAL_INPUT;
  roomSpawn = { x: 0, y: 0 };

  mustClear = false;
  cleared = false;
  mods: RunMods = baseMods();
  ownedRelics = new Set<string>();
  merchantItems: MerchantItem[] = [];
  maxHearts = MAX_HEARTS;
  hearts = MAX_HEARTS;
  gold = 0;
  score = 0;
  // consecutive-kill streak within COMBO_WINDOW
  combo = 0;
  // seconds left before the streak lapses
  comboT = 0;
  comboText!: Phaser.GameObjects.Text;
  freeze = 0;
  deadTimers = new WeakMap<Enemy, number>();
  state: SceneState = "active";
  deadT = 0;
  transT = 0;
  transBuilt = false;
  pendingOffer: Offer | null = null;
  fadeRect!: Phaser.GameObjects.Rectangle;

  heartsText!: Phaser.GameObjects.Text;
  infoText!: Phaser.GameObjects.Text;
  runRecap: RunRecap | null = null;

  demo = false;
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

  /** Host match state; tools/two-client.mjs ends rounds through it. */
  get vs(): VersusMatch | null {
    return this.versus.match;
  }

  create() {
    this.runRecap = null;
    this.banners.active = null;
    this.banners.pending = null;
    this.progress.bossAnnounced = false;
    const params = new URLSearchParams(location.search);
    this.demo = params.get("demo") === "1";
    const { data } = this.scene.settings;
    const dataHero = data instanceof Object && "hero" in data ? data.hero : undefined;
    const wanted = params.get("hero") ?? dataHero ?? this.registry.get("hero");
    this.heroName = HERO_NAMES.find((h) => h === wanted) ?? "axion";
    this.requestedHero = this.heroName;
    this.resetRunState();
    this.resetNetState();
    // A run that adopted a seeded stream (online checkpoint, test seed) would
    // otherwise replay it here.
    const dataSeed = data instanceof Object && "seed" in data ? data.seed : undefined;
    if (Number.isFinite(dataSeed)) {
      reseed(Number(dataSeed));
    } else {
      unseed();
    }
    this.online.restartRequested = this.registry.get("restartExpedition") === true;
    this.registry.set("restartExpedition", false);
    this.acc = 0;

    const hudBand = this.buildChrome();

    const regParty: JsonValue = this.registry.get("party");
    const party = (params.get("party") ?? (isJsonString(regParty) ? regParty : ""))
      .trim()
      .toUpperCase();
    const regMode: JsonValue = this.registry.get("mode");
    const modeStr = params.get("mode") ?? (isJsonString(regMode) ? regMode : "");
    if (party.length > 0 && modeStr === "vs") {
      this.mode = "versus";
    }

    this.attachTouchControls(hudBand);
    // Touch has no Escape and no M: @repo/embed's cluster carries both. The
    // trailer plays itself and owns its own chrome, so it opts out (main.ts
    // keeps the hub's mute-only cluster off there for the same reason).
    if (!params.has("trailer")) {
      mountTouchHud(true);
    }
    this.controls = new Input(this, this.gamepad);
    if (party.length > 0 && !this.demo) {
      this.online.beginConnecting(party);
    } else {
      this.beginSoloRoom(params);
    }

    // ?trailer=1: the shell's black lead-in only exists once the lazily-imported
    // director has landed, so the boot room above — and the room-label banner it
    // fires — would paint for a frame or two first. Hold the scene's own fade
    // plate (depth 100, over the HUD) until the first shot stages; trailer.stage
    // clears it. Nothing else touches fadeRect on this path.
    if (params.has("trailer")) {
      this.fadeRect.setAlpha(1);
    }

    this.wireSceneEvents(params);
  }

  private wireSceneEvents(params: URLSearchParams) {
    sfx.unlock();
    this.input.keyboard?.once("keydown", () => sfx.unlock());
    this.input.once("pointerdown", () => sfx.unlock());
    this.input.keyboard?.on("keydown-M", () => {
      sfx.toggleMute();
      syncTouchHud();
      this.banners.show(sfx.muted ? "SOUND OFF" : "SOUND ON", 700, "status");
    });
    // Versus has no death→hub exit (rounds respawn), so ESC leaves the duel.
    if (this.mode === "versus") {
      this.input.keyboard?.on("keydown-ESC", () => this.scene.start("select"));
    }

    // Death → hub: drop the socket and the hub gets its mute-only touch cluster back.
    this.events.once(Scenes.Events.SHUTDOWN, () => {
      this.controls.destroy();
      this.gamepad.destroy();
      this.session?.destroy();
      if (!params.has("trailer")) {
        mountTouchHud(false);
      }
    });
  }

  // Fresh run economy + world lists. Phaser reuses the scene instance across
  // start(): the old display list is gone but fields still point at destroyed
  // sprites, so every list is dropped here rather than trusted.
  private resetRunState() {
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
    // reset so a new run never flashes its starting biome
    this.rooms.flashedBiome = 0;
    this.state = "active";
    this.doors = [];
    this.enemies = [];
    this.arrows = [];
    this.shots = [];
    this.hazards = [];
    this.boss = null;
    this.feature = null;
    this.lastStand.live = null;
    this.lastStand.g = undefined;
    this.lastStand.label = undefined;
    this.mode = "coop";
    this.versus.match = null;
    this.versus.spawns = [];
    this.versus.hitSeq = new WeakMap();
    this.versus.opponentGone = false;
  }

  // Scene instances persist across start/stop: never leak a previous online
  // run's role/session/puppets into this one (solo must not take the guest path).
  private resetNetState() {
    this.remote = undefined;
    this.remoteId = null;
    this.guest.players = [];
    this.guest.enemyPuppets.clear();
    this.guest.proj = [];
    this.lastStand.net = null;
    this.versus.net = null;
    this.guest.reconciler.reset();
    this.guestIn = NEUTRAL_INPUT;
    this.guest.selfHurting = false;
    this.role = "solo";
    this.session = undefined;
    this.authority = { kind: "waiting" };
    this.checkpoint.adoptedTerminal = null;
    this.seats = { guest: null, host: null };
    this.online.wasConnected = false;
    this.online.seenDisconnect = 0;
    this.neutralOnAdmission = false;
    this.hostNet.remoteInputOwner = null;
    this.checkpoint.ref = undefined;
    this.checkpoint.roomRef = undefined;
    this.checkpoint.cache = { kind: "absent" };
    this.online.restartSentFor = null;
    this.online.outSeq = { a: 0, d: 0, j: 0, s: 0 };
    this.guest.roomSeq = -1;
    this.guest.snapT = -1;
  }

  // Sky, atmosphere wash, fade plate and the text HUD. Returns the touch-HUD
  // band height so the action cluster can clear it.
  private buildChrome(): number {
    this.sky = new PixelSky(this, BASE_W, BASE_H);
    // Thin full-field atmosphere wash, over the world but under the HUD — the
    // cheapest way to make a biome's light read on every tile and silhouette.
    this.fogRect = this.add
      .rectangle(0, 0, BASE_W, BASE_H, 0x00_00_00, 0)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(60);

    this.fadeRect = this.add
      .rectangle(0, 0, BASE_W, BASE_H, 0x05_07_0b)
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
        color: "#ff4d6d",
        fontFamily: "monospace",
        fontSize: "12px",
      })
      .setScrollFactor(0)
      .setDepth(80);
    this.infoText = this.add
      .text(BASE_W - 8 - ins.right, 7 + ins.top + hudBand, "", {
        color: "#8b95a1",
        fontFamily: "monospace",
        fontSize: "9px",
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(80);
    this.expeditionHud = new ExpeditionHud(this, this.heartsText, this.infoText);
    this.banners.mount();
    // Kill-streak multiplier, top-centre; grows and warms as the streak climbs.
    this.comboText = this.add
      .text(BASE_W / 2, 30, "", { color: "#ffd15c", fontFamily: "monospace", fontSize: "14px" })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(81)
      .setAlpha(0);
    return hudBand;
  }

  // Touch controls: floating stick (movement + down-to-drop) on any free
  // touch, fixed action cluster bottom-right, EXIT (versus only) top-right.
  // Mouse is ignored — desktop keeps the keyboard scheme.
  // Positions are game-space px (the adapter's viewport is the FIT game
  // size); insets keep the cluster clear of the home indicator.
  private attachTouchControls(hudBand: number) {
    this.touch = isCoarse();
    const cluster: FixedButton[] = [
      {
        id: "jump",
        label: "JUMP",
        position: (v) => ({ x: v.width - 30 - v.inset.right, y: v.height - 34 - v.inset.bottom }),
        radius: 21,
      },
      {
        id: "atk",
        label: "ATK",
        position: (v) => ({ x: v.width - 76 - v.inset.right, y: v.height - 26 - v.inset.bottom }),
        radius: 18,
      },
      {
        id: "dash",
        label: "DASH",
        position: (v) => ({ x: v.width - 34 - v.inset.right, y: v.height - 82 - v.inset.bottom }),
        radius: 15,
      },
      {
        id: "sp",
        label: "SP",
        position: (v) => ({ x: v.width - 82 - v.inset.right, y: v.height - 70 - v.inset.bottom }),
        radius: 15,
      },
    ];
    const buttons: ButtonOptions[] = [...cluster];
    if (this.mode === "versus") {
      buttons.push({
        id: "exit",
        label: "EXIT",
        position: (v) => ({ x: v.width - 24 - v.inset.right, y: 44 + v.inset.top + hudBand }),
        radius: 15,
      });
    }
    this.gamepad = attachVirtualGamepad(this, {
      buttons,
      onButtonDown: (id) => {
        if (id === "exit") {
          this.scene.start("select");
        }
      },
      render: { blendMode: BlendModes.NORMAL, depth: 90 },
      stick: {
        deadZone: 8,
        knobRadius: 14,
        radius: 40,
        // Over a pit, a thumb that reaches for DASH, lands in the gap between
        // two buttons and slides would otherwise read as a full-speed run.
        region: (p, v) => {
          const bounds = clusterBounds(cluster, v);
          return p.x < bounds.left || p.y < bounds.top;
        },
      },
      visible: "coarse",
    });
  }

  private beginSoloRoom(params: URLSearchParams) {
    const roomParam = parseRoomType(params.get("room") ?? "");
    const def = roomParam ? this.run.debugEnter(roomParam) : this.run.begin();
    // Dev: ?biome=N previews a deeper biome's palette + roster (debug rooms only).
    const biomeParam = Math.floor(Number(params.get("biome")));
    if (roomParam && Number.isFinite(biomeParam) && biomeParam >= 1) {
      this.run.biome = biomeParam;
    }
    this.player = this.spawnPlayer(
      HEROES[this.heroName],
      def.grid,
      def.playerSpawn.x,
      def.playerSpawn.y,
    );
    this.rooms.build(def);
    this.updateHud();
  }

  // Both players leave world-space cues; routine camera motion belongs to me.
  shake(duration: number, intensity: number) {
    if (!REDUCED_MOTION.matches) {
      this.cameras.main.shake(duration, intensity);
    }
  }

  spawnPlayer(hero: HeroDef, grid: Grid, x: number, y: number): Player {
    const pl: Player = new Player(this, grid, x, y, hero, {
      onDash: () => {
        if (pl === this.player) {
          this.shake(60, 0.0025);
        }
        sfx.dash(pl === this.player ? "local" : "routine");
      },
      onHurt: () => {
        if (pl === this.player) {
          this.shake(180, 0.012);
        }
        sfx.hurt(pl === this.player ? "essential" : "routine");
      },
      onJump: () => sfx.jump(pl === this.player ? "local" : "routine"),
      onLand: (impact) => {
        if (pl === this.player) {
          this.shake(80, Math.min(0.003 + impact * 0.00002, 0.008));
        }
        dust(this, pl.x, pl.y);
      },
      onSpecial: (kind) => this.combat.onSpecialFx(kind, pl),
      // No painted attack VFX — the sprite-sheet swing carries the strike. Just
      // feel: a small camera shake + the swing sound.
      onSwing: () => {
        if (pl === this.player) {
          this.shake(50, 0.0015);
        }
        sfx.slash(pl === this.player ? "local" : "routine");
      },
      onWallJump: (side) => {
        wallSmoke(this, pl.x + side * 7, pl.y - 12, side);
        if (pl === this.player) {
          this.shake(40, 0.002);
        }
      },
    });
    return pl;
  }

  // ── input ────────────────────────────────────────────────────────────────
  // This frame's local player input: the guest's sample once online, the demo
  // script on the title loop, else the live controls.
  private localInput(): InputState {
    if (this.controlsPaused) {
      return NEUTRAL_INPUT;
    }
    if (this.session) {
      return this.guestIn;
    }
    if (this.demo) {
      return this.demoInput();
    }
    return this.controls.sample();
  }

  demoInput(): InputState {
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
      attackPressed: ap,
      dashPressed: dp,
      down: false,
      jumpHeld,
      jumpPressed: jp,
      left: false,
      right: true,
      specialPressed: sp,
      up: false,
    };
  }

  // ── frame loop ─────────────────────────────────────────────────────────────
  update(_t: number, delta: number) {
    this.expeditionHud?.setVisible(
      !this.controlsPaused && this.state === "active" && !this.trailer.active,
    );
    const dts = Math.min(delta, 100) / 1000;
    this.banners.update(dts * 1000);
    this.demoT += dts;
    this.publishDiag();
    // Once per frame, before any sample(): reconciles lost touches, publishes
    // the justPressed edges the Input merge reads, and redraws the overlay.
    this.gamepad.update();
    // Same contract for the physical controller poll inside Input.
    this.controls.update();

    if (this.session && !this.online.updateSession()) {
      return;
    }

    if (this.state === "connecting") {
      this.online.prepareSession();
      return;
    }
    if (this.state === "dead") {
      this.updateDead(dts);
      return;
    }
    if (this.state === "transition") {
      this.updateTransition(dts);
      return;
    }

    // Guest: predict my own body locally; render everything else from the
    // host's broadcast.
    if (this.role === "guest") {
      this.guest.step(dts);
      return;
    }

    // Host / solo: authoritative fixed-step sim.
    if (this.role === "host") {
      this.hostNet.syncRemotePresence();
    }
    this.bufferAuthorityInputs();
    this.acc += dts;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_STEPS) {
      if (this.freeze > 0) {
        this.freeze -= STEP;
      } else {
        this.simStep(STEP);
      }
      this.acc -= STEP;
      steps += 1;
    }

    // Interpolate the render between the last two sim steps by the leftover step
    // fraction, so motion stays smooth when the display refreshes faster than 60Hz.
    const alpha = Math.min(this.acc / STEP, 1);
    this.player.render(alpha);
    this.remote?.render(alpha);
    for (const e of this.enemies) {
      e.render(alpha);
    }
    this.boss?.render(alpha);
    this.lastStand.render();
    this.updateHud();

    if (this.role === "host") {
      this.hostNet.broadcast(dts);
    }
  }

  // Bot-playtest telemetry (sys/diag.ts): mutate the shared object in place.
  private publishDiag() {
    diag.frame += 1;
    diag.score = this.score;
    diag.complete = this.state === "dead";
    diag.player.x = this.player.x;
    diag.player.y = this.player.y;
    diag.player.speed = Math.hypot(this.player.body.vx, this.player.body.vy);
    diag.entities = this.enemies.length + this.guest.enemyPuppets.size;
  }

  private updateDead(dts: number) {
    this.deadT += dts;
    if (this.role === "host") {
      this.hostNet.broadcast(dts);
    }
    for (const e of this.enemies) {
      e.render();
    }
    // Trailer scenes stage their own restart — never bounce to the hub.
    if (this.deadT > 2.4 && !this.trailer.active) {
      this.scene.start("select", { recap: this.runRecap });
    }
  }

  private updateTransition(dts: number) {
    this.transT += dts;
    const half = 0.22;
    this.fadeRect.setAlpha(
      this.transT < half ? this.transT / half : Math.max(0, 1 - (this.transT - half) / half),
    );
    if (!this.transBuilt && this.transT >= half && this.pendingOffer) {
      this.rooms.build(this.run.choose(this.pendingOffer));
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
    for (const e of this.enemies) {
      e.render();
    }
    this.boss?.render();
    if (this.role === "host") {
      this.hostNet.broadcast(dts);
    }
  }

  // Host / solo: feed this frame's inputs (scripted by the trailer, else local +
  // the guest's wire input) into the bodies, honouring the versus freeze/rematch.
  private bufferAuthorityInputs() {
    const scripted = this.trailer.input ? this.trailer.input() : null;
    const snap = scripted ? scripted.p1 : this.localInput();
    let remoteIn: InputState | null = null;
    if (scripted) {
      remoteIn = scripted.p2;
    } else if (this.remote) {
      remoteIn = this.hostNet.readRemoteInput();
    }
    if (!this.versus.match) {
      this.player.buffer(snap);
      if (this.remote && remoteIn) {
        this.remote.buffer(remoteIn);
      }
      return;
    }
    // Match over + hold lapsed: either duelist's attack press restarts it.
    if (
      this.versus.match.canRematch &&
      (snap.attackPressed || (remoteIn?.attackPressed ?? false))
    ) {
      this.versus.match.beginMatch();
      this.versus.respawn();
      this.banners.show("REMATCH — ROUND 1", 1100, "critical");
      sfx.door("local");
    }
    // Round intro / match end: bodies hold still (gravity still applies).
    const { frozen } = this.versus.match;
    this.player.buffer(frozen ? NEUTRAL_INPUT : snap);
    if (this.remote && remoteIn) {
      this.remote.buffer(frozen ? NEUTRAL_INPUT : remoteIn);
    }
  }

  /** Wrapper pause gates intent, not the partner's online simulation. */
  setControlsPaused(paused: boolean): void {
    if (this.controlsPaused === paused) {
      return;
    }
    this.controlsPaused = paused;
    this.expeditionHud?.setVisible(!paused && this.state === "active" && !this.trailer.active);
    this.controls?.reset();
    this.player?.body.clearInput();
    this.guestIn = NEUTRAL_INPUT;
    if (this.session?.live) {
      this.online.sendInput(NEUTRAL_INPUT);
    }
  }

  ownerId(pl: Player): string | null {
    return pl === this.player ? (this.session?.playerId ?? null) : this.remoteId;
  }

  seatPlayer(id: string): Player | undefined {
    if (id === this.session?.playerId) {
      return this.player;
    }
    return id === this.remoteId ? this.remote : undefined;
  }

  // ── co-op helpers ────────────────────────────────────────────────────────────
  livePlayers(): Player[] {
    return this.remote ? [this.player, this.remote] : [this.player];
  }

  cs(pl: Player): CombatState {
    let s = this.combatStates.get(pl);
    if (!s) {
      s = newCombatState();
      this.combatStates.set(pl, s);
    }
    return s;
  }

  // ── sim tick (host / solo) ─────────────────────────────────────────────────
  simStep(dt: number) {
    if (this.versus.match) {
      this.versus.simStep(dt);
      return;
    }
    if (this.combo > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) {
        this.combat.breakCombo();
      }
    }
    for (const pl of this.livePlayers()) {
      pl.step(dt);
    }
    for (const e of this.enemies) {
      const t = this.combat.nearestPlayer(e.body.x, e.body.y);
      e.body.step(dt, t.x, t.y);
    }
    this.combat.stepBoss(dt);
    this.combat.stepArrows(dt);
    this.combat.stepShots(dt);
    this.combat.stepHazards(dt);
    for (const pl of this.livePlayers()) {
      this.combat.playerOffense(pl);
    }
    this.combat.enemyOffense();
    this.lastStand.step(dt);
    this.progress.stepFeature();
    this.progress.stepMerchant();
    this.combat.cullEnemies(dt);
    this.progress.checkClear();
    this.progress.checkDoors();
  }

  // The shared run is over (solo, or co-op with no last stand left to give).
  playerDie() {
    if (this.state === "dead") {
      return;
    }
    this.lastStand.live = null;
    this.lastStand.net = null;
    this.lastStand.destroyUi();
    this.hearts = 0;
    this.state = "dead";
    this.deadT = 0;
    this.player.sprite.play(`${this.heroName}:death`);
    sfx.die();
    // Push one final hearts=0 snapshot so the guest sees the shared death.
    if (this.role === "host") {
      this.hostNet.broadcast(0, true);
    }
    if (this.trailer.active) {
      // Trailer deaths never touch the real meta/best-score saves; show the
      // shard yield the death WOULD bank (death-as-progress is the beat).
      const would = Math.floor(this.gold / 4) + this.run.depth * 2 + (this.run.biome - 1) * 6;
      this.banners.show(`YOU FELL   SCORE ${this.score}   +${would} ✦`, 2600, "critical");
      return;
    }
    const earned = bankRun(loadMeta(), this.gold, this.run.depth, this.run.biome);
    const best = recordBestScore(this.score);
    this.runRecap = {
      bestScore: best,
      biome: this.run.biome,
      depth: this.run.depth,
      gold: this.gold,
      hero: this.heroName,
      kind: "banked",
      score: this.score,
      shardsEarned: earned,
    };
    const pb = this.score > 0 && this.score >= best ? "  ★ NEW BEST" : "";
    this.banners.show(`YOU FELL   SCORE ${this.score}${pb}   +${earned} ✦`, 2600, "critical");
  }

  // ── HUD ────────────────────────────────────────────────────────────────────
  private offerKind(item: MerchantItem): ExpeditionOffer["kind"] {
    if (item.bought) {
      return "sold";
    }
    return this.gold >= item.relic.price ? "affordable" : "unaffordable";
  }

  updateHud() {
    const special = this.role === "guest" ? this.guest.special : this.player.body.specialReadiness;
    const visible = !this.controlsPaused && this.state === "active" && !this.trailer.active;
    if (this.mode === "versus") {
      this.versus.updateHud();
      this.expeditionHud?.updateSpecial(this.versus.frozen() ? { kind: "busy" } : special, visible);
      return;
    }
    const guest = this.role === "guest";
    const biome = guest ? this.guest.biome : this.run.biome;
    const depth = guest ? this.guest.depth : this.run.depth;
    const type = guest ? this.guest.roomType : this.run.type;
    const boss = guest ? this.guest.bossPuppet?.net : this.boss?.body;
    const bossName = boss && !boss.dead ? bossKind(biome).name : null;
    if (!this.trailer.active) {
      this.layoutHudText(type, bossName !== null);
    }
    this.expeditionHud?.update({
      biome,
      biomeName: biomePalette(biome).name,
      bossAt: this.run.bossAt,
      bossName,
      depth,
      gold: this.gold,
      hearts: this.hearts,
      maxHearts: this.maxHearts,
      offer: type === "merchant" ? this.nearestOffer() : null,
      relics: RELICS.filter((r) => this.ownedRelics.has(r.id)),
      safeRoom: !this.run.isCombat(type),
      score: this.score,
      special,
      visible,
    });
  }

  // Banner and streak counter give way to the merchant card / boss plate.
  private layoutHudText(type: RoomType, bossShown: boolean) {
    this.banners.text.setY(type === "merchant" ? 170 : BASE_H / 2 - 20);
    this.banners.text.setVisible(
      !this.expeditionHud?.inspecting || this.banners.active?.kind === "critical",
    );
    this.comboText.setY(bossShown ? 67 + gameInset(this).top : 42 + gameInset(this).top);
  }

  // The merchant item closest to me, as the HUD's offer card.
  private nearestOffer(): ExpeditionOffer | null {
    let nearest: MerchantItem | undefined;
    for (const item of this.merchantItems) {
      if (!nearest || Math.abs(item.x - this.player.x) < Math.abs(nearest.x - this.player.x)) {
        nearest = item;
      }
    }
    if (!nearest) {
      return null;
    }
    return {
      desc: nearest.relic.desc,
      kind: this.offerKind(nearest),
      name: nearest.relic.name,
      price: nearest.relic.price,
    };
  }

  // ── trailer entry points (src/trailer/trailer-director.ts) ─────────────────
  // Thin delegators: the director drives the scene through these; the staging
  // itself lives in trailer-staging.ts.
  trailerStage(o: TrailerStageOpts): void {
    this.trailer.stage(o);
  }

  trailerZoom(z: number): void {
    this.trailer.zoom(z);
  }

  trailerSpawnEnemy(name: EnemyName, x: number, y: number, affixId?: string): void {
    this.trailer.spawnEnemy(name, x, y, affixId);
  }

  trailerSetInput(provider: (() => TrailerInputs) | null): void {
    this.trailer.setInput(provider);
  }

  trailerTick(steps: number): void {
    this.trailer.tick(steps);
  }

  trailerFreeze(seconds: number): void {
    this.trailer.freeze(seconds);
  }

  trailerMods(m: Partial<RunMods>): void {
    this.trailer.mods(m);
  }

  trailerBanner(text: string, ms: number): void {
    this.trailer.banner(text, ms);
  }

  trailerWorld(): TrailerWorld {
    return this.trailer.world();
  }
}
