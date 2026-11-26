import {
  createTouchControls,
  isOfflineRequested,
  notifyGameStarted,
  sealPointerEvents,
  setPauseHandlers,
  watchControlContext,
} from "@repo/embed";
import type { TouchControls } from "@repo/embed";
import { PhysicalGamepad, attachVirtualGamepad, safeAreaInset } from "@vibedgames/gamepad/phaser";
import type { PhaserGamepad } from "@vibedgames/gamepad/phaser";
import { isPlaytestRequested } from "@vibedgames/playtest";
import { Input, Math as PhaserMath, Scale, Scene, Scenes } from "phaser";
import type Phaser from "phaser";
import { sfx } from "../audio/sfx";
import { installDevHooks } from "../dev/dev-hooks";
import { AttractBattle } from "../fx/attract-battle";
import { HostCombat } from "../net/host-combat";
import { HostDirector } from "../net/host-director";
import { HostIntents } from "../net/intents";
import { PeerRoster } from "../net/peer-roster";
import { PlayerNet } from "../net/player-net";
import { emptyShared } from "../net/shared-world";
import { WorldSync } from "../net/world-sync";
import {
  buildControls,
  createStarfallPauseOverlay,
  ensureStyle as ensureControlsStyle,
} from "../pause-overlay";
import { REDUCED_MOTION } from "../render/battle-fx";
import { EnergyBarrier } from "../render/energy-barrier";
import { FxPool } from "../render/fx-pool";
import { Hud } from "../render/hud";
import { createLayers } from "../render/layers";
import type { Layers } from "../render/layers";
import { ShipView } from "../render/ship-view";
import { Starfield } from "../render/starfield";
import { TraumaCamera } from "../render/trauma-camera";
import { enemyHullPoints, shipHullPoints } from "../render/vector-shapes";
import { WorldView } from "../render/world-view";
import { now as simNow, pauseClock, resumeClock } from "../shared/clock";
import {
  baseWeaponForLevel,
  INITIAL_SPAWN_CENTER_FRAC,
  INVULNERABLE_MS,
  JOYSTICK_DEAD_ZONE,
  JOYSTICK_KNOB_RADIUS,
  JOYSTICK_RADIUS,
  NITRO_ACCEL_MULT,
  NITRO_MAX_SPEED_MULT,
  randomWorldPoint,
  RESPAWN_ASTEROID_MIN_R,
  RESPAWN_ATTEMPTS,
  RESPAWN_CLEARANCE,
  RESPAWN_EDGE_MARGIN,
  SHIELD_MAX,
  SHIP_ACCEL,
  SHIP_BRAKE_DRAG,
  SHIP_DEAD_ZONE,
  SHIP_DRAG,
  SHIP_MAX_SPEED,
  SHIP_THRUST_RAMP,
  OPENING_ROCK_COUNT,
  spawnOpeningAsteroid,
  WORLD_BLEED_PX,
  WORLD_H,
  WORLD_W,
} from "../shared/constants";
import type { SharedState, Vec } from "../shared/constants";
import { PLAYTEST_SURFACE, diag, installTestHooks } from "../shared/diag";
import { rand, reseed } from "../shared/rng";
import { Link } from "../state/link";
import { newPilot } from "../state/pilot";
import type { Pilot } from "../state/pilot";
import { BeaconClient } from "../sys/beacon-client";
import { BeamSim } from "../sys/beam-sim";
import { EnemyAi } from "../sys/enemy-ai";
import { Pickups } from "../sys/pickups";
import { publishStarfallPlaytest } from "../sys/playtest-manifest";
import { senseSurroundings } from "../sys/playtest-sense";
import { Progression } from "../sys/progression";
import { RemoteFire } from "../sys/remote-fire";
import { Shield } from "../sys/shield";
import { ShooterHits } from "../sys/shooter-hits";
import { Weapons } from "../sys/weapons";
import { installTrailerStage } from "../trailer/trailer-stage";

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://party.vibedgames.com";

const ROOM_DEFAULT = "starfall-arena-v9";

const ROOM =
  (import.meta.env.DEV && new URLSearchParams(location.search).get("room")) || ROOM_DEFAULT;

const STARFALL_MAX_PLAYERS = 32;

const MASK_PAD = WORLD_BLEED_PX + 4000;

const IS_COARSE_POINTER =
  window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;

const PAD_STICK_DEAD_ZONE = 0.15;
const CAMERA_REF_WIDTH = 1100;
const CAMERA_MIN_ZOOM = 0.9;

const initialSpawnInset = (dim: number, halfView: number) =>
  Math.min(Math.max(dim * INITIAL_SPAWN_CENTER_FRAC, halfView + RESPAWN_EDGE_MARGIN), dim / 2);

/** Everything the DEV harness (dev/dev-hooks.ts) and the trailer stage
 *  (trailer/trailer-stage.ts) drive. Gameplay code never reads this; it is
 *  the one sanctioned way past the scene's private fields. */
export interface SceneInternals {
  world: SharedState;
  pilot: Pilot;
  link: Link;
  intents: HostIntents;
  fx: FxPool;
  hud: Hud;
  view: WorldView;
  shipView: ShipView;
  net: PlayerNet;
  beacon: BeaconClient;
  pickups: Pickups;
  shield: Shield;
  hits: ShooterHits;
  progress: Progression;
  weapons: Weapons;
  remoteFire: RemoteFire;
  hostCombat: HostCombat;
  ai: EnemyAi;
  host: HostDirector;
  sync: WorldSync;
  cameras: Phaser.Cameras.Scene2D.CameraManager;
  tweens: Phaser.Tweens.TweenManager;
  forceOfflineSolo: () => void;
}

export class GameScene extends Scene {
  private readonly world = emptyShared();
  private readonly pilot = newPilot();
  private readonly link = new Link({
    inbox: (event, payload, from) => {
      this.net.handleEvent(event, payload, from);
    },
    onClaim: (key, owner) => {
      this.pickups.onClaim(key, owner);
    },
  });
  private readonly roster = new PeerRoster(this.link);
  private readonly intents = new HostIntents();
  private readonly trauma = new TraumaCamera();
  private hud!: Hud;
  private view!: WorldView;
  private shipView!: ShipView;
  private net!: PlayerNet;
  private beacon!: BeaconClient;
  private pickups!: Pickups;
  private shield!: Shield;
  private hits!: ShooterHits;
  private progress!: Progression;
  private sim!: BeamSim;
  private weapons!: Weapons;
  private remoteFire!: RemoteFire;
  private hostCombat!: HostCombat;
  private ai!: EnemyAi;
  private host!: HostDirector;
  private sync!: WorldSync;
  private starfield!: Starfield;
  private barrier!: EnergyBarrier;
  private fx!: FxPool;
  private layers!: Layers;
  private pointerSeen = false;
  private fireKey: Phaser.Input.Keyboard.Key | null = null;
  private openingRocksSeeded = false;
  private gamepad!: PhaserGamepad;
  private readonly pad = new PhysicalGamepad({ stickDeadZone: PAD_STICK_DEAD_ZONE });
  private unwatchControls: (() => void) | null = null;
  private touchControls!: TouchControls;

  private camRollDeg = 0;
  private readonly camBase = { x: 0, y: 0 };

  private startEl: HTMLElement | null = null;
  private attract: AttractBattle | null = null;

  constructor() {
    super("Game");
  }

  create() {
    installTestHooks({
      activePlay: () => {
        this.forceOfflineSolo();
      },
      restart: (seed) => {
        this.restartSolo(seed);
      },
      setPaused: (paused) => {
        paused ? this.freezeSim() : this.unfreezeSim();
      },
    });
    this.starfield = new Starfield(this);
    this.fx = new FxPool(this);

    this.barrier?.destroy();
    this.barrier = new EnergyBarrier(this);

    const edges: readonly (readonly [number, number, number, number])[] = [
      [-MASK_PAD, -MASK_PAD, WORLD_W + MASK_PAD * 2, MASK_PAD - WORLD_BLEED_PX],
      [-MASK_PAD, WORLD_H + WORLD_BLEED_PX, WORLD_W + MASK_PAD * 2, MASK_PAD - WORLD_BLEED_PX],
      [-MASK_PAD, -WORLD_BLEED_PX, MASK_PAD - WORLD_BLEED_PX, WORLD_H + WORLD_BLEED_PX * 2],
      [
        WORLD_W + WORLD_BLEED_PX,
        -WORLD_BLEED_PX,
        MASK_PAD - WORLD_BLEED_PX,
        WORLD_H + WORLD_BLEED_PX * 2,
      ],
    ];

    for (const [x, y, w, h] of edges) {
      this.add.rectangle(x, y, w, h, 0x02_06_17).setOrigin(0).setDepth(50);
    }

    this.layers = createLayers(this);
    this.wireCollaborators();
    this.hud.bind();
    this.link.connect({
      host: MULTIPLAYER_HOST,
      maxPlayers: STARFALL_MAX_PLAYERS,
      offline:
        isOfflineRequested() ||
        isPlaytestRequested() ||
        new URLSearchParams(location.search).has("trailer"),
      onReadmitted: () => {
        this.roster.relearn();
      },
      onUpdate: () => {
        this.roster.ingest(performance.now());
      },
      room: ROOM,
    });
    this.sync.ensureSeeded();

    this.input.on(Input.Events.POINTER_MOVE, (p: Phaser.Input.Pointer) => {
      if (!p.wasTouch) {
        this.pointerSeen = true;
      }
    });
    this.input.on(Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      if (!p.wasTouch) {
        this.pointerSeen = true;
      }

      sfx.unlock();
    });

    this.touchControls = createTouchControls();
    this.input.keyboard?.on("keydown-M", () => sfx.toggleMute());

    this.fireKey = this.input.keyboard?.addKey(Input.Keyboard.KeyCodes.SPACE) ?? null;

    this.gamepad = attachVirtualGamepad(this, {
      buttons: [{ id: "fire" }],
      onFirstTouch: () => {
        this.enterTouchMode();
      },
      stick: {
        deadZone: JOYSTICK_DEAD_ZONE,
        knobRadius: JOYSTICK_KNOB_RADIUS,
        radius: JOYSTICK_RADIUS,
      },
    });

    if (IS_COARSE_POINTER) {
      this.enterTouchMode();
    }

    this.buildStartScreen();

    this.attract = new AttractBattle(this, {
      enemyHull: (kind) => enemyHullPoints(kind),
      fx: this.fx,
      hullPoints: (level) => shipHullPoints(level),
      makeEnemy: (kind) => this.view.makeEnemyGfx(kind).setDepth(9),
      makeShip: (tint, level) => this.shipView.makeShipGfx(tint, level),
    });

    const pauseOverlay = createStarfallPauseOverlay({
      get: () => sfx.muted,
      set: (next) => sfx.setMuted(next),
    });

    setPauseHandlers({
      onPause: () => {
        pauseOverlay.show();

        if (this.link.offline) {
          this.freezeSim();
        } else {
          this.pauseToSpectator();
        }
      },
      onResume: () => {
        pauseOverlay.hide();

        if (this.link.frozen) {
          this.unfreezeSim();
        } else {
          this.resumeFromSpectator();
        }
      },
    });

    this.scale.on(Scale.Events.RESIZE, this.onViewportChange, this);
    this.onViewportChange();
    this.centerCamera(this.world.playW / 2, this.world.playH / 2);

    this.events.once(Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Scale.Events.RESIZE, this.onViewportChange, this);
      this.gamepad.destroy();
      this.touchControls.destroy();
      this.link.destroy();
    });

    installDevHooks(this.internals());

    if (PLAYTEST_SURFACE) {
      publishStarfallPlaytest();
    }
  }

  private wireCollaborators() {
    const { world, pilot, link, roster, intents, fx, layers, trauma } = this;
    this.progress = new Progression({
      clock: this.time,
      fx,
      hooks: {
        myTint: () => this.myTint(),
        popCombo: () => {
          this.hud.popCombo();
        },
        shield: () => this.shield,
      },
      pilot,
      trauma,
    });
    this.ai = new EnemyAi({ world });
    this.hostCombat = new HostCombat({
      ai: this.ai,
      hooks: {
        onBossKilled: (now) => {
          this.host.noteBossKilled(now);
        },
      },
      world,
    });
    this.host = new HostDirector({
      ai: this.ai,
      hooks: {
        phasedUntil: () => this.shield.phasedUntil,
        prepareHost: () => this.sync.prepareHost(),
      },
      hostCombat: this.hostCombat,
      link,
      pilot,
      progress: this.progress,
      roster,
      world,
    });
    this.view = new WorldView({
      fx,
      hooks: { remoteFire: () => this.remoteFire, weapons: () => this.weapons },
      host: this.host,
      layers,
      link,
      pilot,
      scene: this,
      trauma,
      world,
    });
    this.sim = new BeamSim({
      fx,
      hooks: { phasedUntil: () => this.shield.phasedUntil },
      intents,
      link,
      pilot,
      trauma,
      view: this.view,
      world,
    });
    this.weapons = new Weapons({
      clock: this.time,
      fx,
      hooks: {
        hits: () => this.hits,
        isFiring: () => this.isFiring(),
        shield: () => this.shield,
      },
      intents,
      link,
      pilot,
      progress: this.progress,
      sim: this.sim,
      trauma,
      view: this.view,
      world,
    });
    this.hits = new ShooterHits({
      fx,
      intents,
      pilot,
      progress: this.progress,
      sim: this.sim,
      weapons: this.weapons,
      world,
    });
    this.remoteFire = new RemoteFire({ hits: this.hits, link, roster, sim: this.sim });
    this.shield = new Shield({
      fx,
      hits: this.hits,
      hooks: {
        myTint: () => this.myTint(),
        pushMyState: (now) => {
          this.net.pushMyState(now);
        },
      },
      intents,
      layers,
      link,
      pilot,
      progress: this.progress,
      remoteFire: this.remoteFire,
      scale: this.scale,
      trauma,
      tweens: this.tweens,
      view: this.view,
      weapons: this.weapons,
      world,
    });
    this.shipView = new ShipView({
      fx,
      layers,
      link,
      pilot,
      progress: this.progress,
      remoteFire: this.remoteFire,
      scene: this,
      shield: this.shield,
      trauma,
      view: this.view,
      weapons: this.weapons,
    });
    this.pickups = new Pickups({
      fx,
      link,
      pilot,
      progress: this.progress,
      shield: this.shield,
      weapons: this.weapons,
      world,
    });
    this.beacon = new BeaconClient({
      fx,
      link,
      pilot,
      progress: this.progress,
      trauma,
      world,
    });
    this.hud = new Hud({
      layers,
      link,
      pilot,
      progress: this.progress,
      scale: this.scale,
      shield: this.shield,
      shipView: this.shipView,
      world,
    });
    this.sync = new WorldSync({
      ai: this.ai,
      host: this.host,
      hud: this.hud,
      link,
      pickups: this.pickups,
      shield: this.shield,
      world,
    });
    this.net = new PlayerNet({
      hostCombat: this.hostCombat,
      link,
      pilot,
      progress: this.progress,
      remoteFire: this.remoteFire,
      shield: this.shield,
      sync: this.sync,
      weapons: this.weapons,
      world,
    });
  }

  private internals() {
    return {
      ai: this.ai,
      beacon: this.beacon,
      cameras: this.cameras,
      forceOfflineSolo: () => {
        this.forceOfflineSolo();
      },
      fx: this.fx,
      hits: this.hits,
      host: this.host,
      hostCombat: this.hostCombat,
      hud: this.hud,
      intents: this.intents,
      link: this.link,
      net: this.net,
      pickups: this.pickups,
      pilot: this.pilot,
      progress: this.progress,
      remoteFire: this.remoteFire,
      shield: this.shield,
      shipView: this.shipView,
      sync: this.sync,
      tweens: this.tweens,
      view: this.view,
      weapons: this.weapons,
      world: this.world,
    } satisfies SceneInternals;
  }

  /** Trailer director entry (?trailer=1): see trailer/trailer-stage.ts. */
  trailerStage() {
    return installTrailerStage(this.internals());
  }

  override update(time: number, delta: number) {
    const dt = Math.min(delta, 100) / 1000;
    this.pad.update();

    if (!this.link.started && ["a", "b", "x", "y", "start"].some((b) => this.pad.justPressed(b))) {
      this.beginPlay();
    }

    this.starfield.update(dt, time);
    this.barrier.update(time, this.world.playW, this.world.playH);
    this.sync.ensureSeeded();

    if (!this.link.started) {
      this.attract?.update(dt, this.time.now);
    }

    if (!this.link.live) {
      this.hud.updateBattlePresentation(simNow());
      this.fx.update(dt, this.time.now);
      this.syncScreenUi();
      this.publishDiag();

      return;
    }

    const now = simNow();
    const perfNow = performance.now();
    this.roster.refresh(perfNow);

    this.ensureSpawned();
    this.seedOpeningRocks();
    this.tickRespawn(now);
    this.gamepad.setTint(this.myTint());
    this.gamepad.update();
    this.steerShip(dt);
    this.weapons.handleShooting(delta, now);
    this.weapons.updateBeams(dt, now);
    this.weapons.tickMines(now);
    this.weapons.tickSentry(now);
    this.sync.advanceWorld(dt, now);
    this.sync.reconcile(now);
    this.remoteFire.update(perfNow);

    if (this.link.amHost) {
      this.host.hostTick(now, dt, delta);

      if (this.sync.roomHasWorld()) {
        this.hud.observeBossEncounters(this.world);
      }
    }

    this.hits.detectMyHits(now);
    this.shield.detectIncomingDamage(now, dt);
    this.pickups.pickupItems(now);
    this.pickups.collectShards(now);
    this.beacon.tickBeaconClient(now);
    this.shield.tickShield(now, dt);

    if (this.pilot.weaponUntil !== 0 && now >= this.pilot.weaponUntil) {
      this.pilot.specialBase = null;
      this.pilot.weapon = baseWeaponForLevel(this.progress.level);
      this.pilot.weaponUntil = 0;
    }

    this.pilot.mastery.advance(now, this.pilot.alive, this.pilot.weapon.name);

    if (this.progress.streak > 0 && now >= this.progress.comboExpiresAt) {
      this.progress.streak = 0;
      this.progress.comboTier = 1;
    }

    this.hud.tickSector(now);
    this.intents.flush(this.link);
    this.net.netSend(delta, now);

    this.shipView.syncShips(now);
    this.view.syncAsteroids(now);
    this.view.syncUfo(now);
    this.view.syncItems();
    this.view.drawShards(now);
    this.view.syncEnemies(now);
    this.view.drawEnemyTelegraphs(now);
    this.view.drawPulls(now);
    this.view.drawBeacon(now);
    this.view.drawEdgePips(now);
    this.fx.battle.beginWeapons();
    this.view.drawEnemyShots();
    this.view.drawBeams(now);
    this.view.updateSplinters(dt, now);
    this.fx.update(dt, this.time.now);
    this.hud.drawMinimap(now);
    this.link.trailer?.frame?.();
    this.updateCamera(dt, time);
    this.syncScreenUi();
    this.hud.updateBattlePresentation(now);
    this.hud.updateHud(now);
    this.publishDiag();
  }

  private onViewportChange() {
    this.layers.safeInset = safeAreaInset();

    if (this.link.trailer) {
      return;
    }

    const zoom = PhaserMath.Clamp(this.scale.width / CAMERA_REF_WIDTH, CAMERA_MIN_ZOOM, 1);
    this.cameras.main.setZoom(zoom);
  }

  private buildStartScreen() {
    this.startEl = document.querySelector("#start");
    this.writeStartCopy();
    this.unwatchControls?.();
    this.unwatchControls = watchControlContext(() => {
      if (!this.link.started) {
        this.writeStartCopy();
      }
    });
    this.input.keyboard?.once("keyup", () => {
      this.beginPlay();
    });

    if (this.startEl) {
      sealPointerEvents(this.startEl);
      this.startEl.addEventListener(
        "pointerup",
        () => {
          this.beginPlay();
        },
        { once: true },
      );
    }
  }

  private writeStartCopy() {
    const touch = IS_COARSE_POINTER || this.gamepad.isTouch;
    const controls = document.querySelector("#start-controls");
    const go = document.querySelector("#start-go");

    if (controls) {
      ensureControlsStyle();
      const card = buildControls(touch);
      controls.replaceChildren(...(card ? [card] : []));
    }

    if (go) {
      go.textContent = touch ? "tap to start" : "press any key to start";
    }

    this.startEl?.classList.add("ready");
  }

  private beginPlay() {
    if (this.link.started) {
      return;
    }

    this.link.started = true;
    sfx.unlock();

    if (this.link.offline) {
      this.world.arenaEpoch = simNow();
    }

    this.unwatchControls?.();
    this.unwatchControls = null;
    notifyGameStarted();
    this.attract?.destroy();
    this.attract = null;
    this.startEl?.classList.add("hide");
    this.time.delayedCall(320, () => this.startEl?.remove());
  }

  private forceOfflineSolo() {
    this.link.goOffline();
    this.sync.ensureSeeded();
    this.beginPlay();
  }

  private restartSolo(seed: number) {
    reseed(seed);
    this.link.goOffline();
    this.sync.offlineSeeded = false;
    this.sync.ensureSeeded();
    this.host.restart();
    this.progress.restart();
    this.shield.restart();
    this.weapons.beams = [];
    this.weapons.sentry = null;
    this.weapons.windupAcc = 0;
    Object.assign(this.pilot, newPilot());
    this.openingRocksSeeded = false;
  }

  private publishDiag() {
    diag.frame += 1;
    diag.score = this.progress.runXp;
    diag.player.x = this.pilot.shipX;
    diag.player.y = this.pilot.shipY;
    diag.player.speed = Math.hypot(this.pilot.shipVX, this.pilot.shipVY);
    diag.entities = this.world.enemies.length + this.world.asteroids.length;
    diag.beams = this.weapons.beams.length;

    if (PLAYTEST_SURFACE) {
      this.publishSenses();
    }

    const b = this.world.beacon;
    const bnow = simNow();
    diag.beacon =
      b && bnow < b.diesAt
        ? {
            contested: b.contested,
            controllerId: b.controllerId,
            phase: bnow < b.activeAt ? "charge" : "active",
            x: b.x,
            y: b.y,
          }
        : null;
  }

  private publishSenses() {
    const now = simNow();
    const { pilot } = this;
    const live = pilot.spawned && pilot.alive;
    diag.alive = live;
    diag.respawnInMs = pilot.respawnAt === 0 ? 0 : Math.max(0, Math.round(pilot.respawnAt - now));
    diag.invulnerable = now < pilot.invulnUntil;
    diag.shield = Math.round(this.shield.shieldHp + this.shield.overHp);
    diag.shieldMax = SHIELD_MAX;
    diag.level = this.progress.level;
    diag.weapon = pilot.weapon.name;
    diag.firing = this.isFiring();
    const cam = this.cameras.main;
    diag.view.w = cam.width;
    diag.view.h = cam.height;
    diag.view.zoom = cam.zoom;
    senseSurroundings(diag, { now, pilot, world: this.world });
  }

  private freezeSim() {
    if (this.link.frozen || !this.link.offline) {
      return;
    }

    this.link.frozen = true;
    pauseClock();
    sfx.setSuspended(true);
    this.game.loop.sleep();
  }

  private unfreezeSim() {
    if (!this.link.frozen) {
      return;
    }

    this.link.frozen = false;
    resumeClock();
    sfx.setSuspended(false);
    this.game.loop.wake();
  }

  private pauseToSpectator() {
    if (this.link.paused) {
      return;
    }

    this.link.paused = true;
    this.pilot.spawned = false;
    this.pilot.alive = false;
    this.pilot.respawnAt = 0;
    this.weapons.beams = [];
    this.weapons.sentry = null;
    this.shield.impactArcs = [];
    this.progress.streak = 0;
    this.progress.comboTier = 1;

    if (this.link.started && this.link.myId !== null && this.link.myId !== "") {
      this.net.pushMyState(simNow());
    }

    sfx.setSuspended(true);
  }

  private resumeFromSpectator() {
    if (!this.link.paused) {
      return;
    }

    this.link.paused = false;
    sfx.setSuspended(false);

    if (!this.link.started) {
      return;
    }

    this.pilot.spawned = true;
    this.pilot.alive = false;
    this.pilot.respawnAt = simNow();
  }

  private ensureSpawned() {
    if (
      !this.link.started ||
      this.link.paused ||
      this.pilot.spawned ||
      this.link.myId === null ||
      this.link.myId === ""
    ) {
      return;
    }

    const cam = this.cameras.main;
    const { playW, playH } = this.world;

    const pos = this.pickRespawnPoint(
      initialSpawnInset(playW, cam.width / 2 / cam.zoom),
      initialSpawnInset(playH, cam.height / 2 / cam.zoom),
    );

    this.pilot.shipX = pos.x;
    this.pilot.shipY = pos.y;
    this.pilot.spawned = true;
    this.centerCamera(pos.x, pos.y);
    this.spawnInFx(pos.x, pos.y);
    this.net.pushMyState(simNow());
  }

  private seedOpeningRocks() {
    if (this.openingRocksSeeded || !this.pilot.spawned) {
      return;
    }

    if (!this.link.offline && !this.link.amHost) {
      this.openingRocksSeeded = true;

      return;
    }

    if (this.world.asteroids.length === 0) {
      return;
    }

    const cam = this.cameras.main;
    const maxDist = PhaserMath.Clamp(Math.min(cam.width, cam.height) / 2 / cam.zoom - 60, 160, 320);
    const base = rand() * Math.PI * 2;

    for (let i = 0; i < OPENING_ROCK_COUNT; i += 1) {
      const ang = base + (i * Math.PI * 2) / OPENING_ROCK_COUNT + (rand() - 0.5) * 0.6;
      const dist = 140 + rand() * Math.max(20, maxDist - 140);

      const x = PhaserMath.Clamp(
        this.pilot.shipX + Math.cos(ang) * dist,
        40,
        this.world.playW - 40,
      );

      const y = PhaserMath.Clamp(
        this.pilot.shipY + Math.sin(ang) * dist,
        40,
        this.world.playH - 40,
      );

      this.world.asteroids.push(spawnOpeningAsteroid(x, y));
    }

    this.openingRocksSeeded = true;
  }

  private tickRespawn(now: number) {
    if (this.pilot.alive || this.pilot.respawnAt === 0 || now < this.pilot.respawnAt) {
      return;
    }

    const pos = this.pickRespawnPoint();
    this.pilot.shipX = pos.x;
    this.pilot.shipY = pos.y;
    this.pilot.shipVX = 0;
    this.pilot.shipVY = 0;
    this.pilot.alive = true;
    this.pilot.respawnAt = 0;
    this.pilot.invulnUntil = now + INVULNERABLE_MS;
    this.shield.shieldHp = SHIELD_MAX;
    this.shield.overHp = 0;
    this.shield.lastDamageAt = 0;
    this.shield.regenActive = false;
    this.pilot.weaponUntil = 0;
    this.progress.applyBaseLoadout(now);
    this.pilot.kickX = 0;
    this.pilot.kickY = 0;
    this.centerCamera(pos.x, pos.y);
    this.spawnInFx(pos.x, pos.y);
    sfx.play("respawn");
    this.net.pushMyState(now);
  }

  private pickRespawnPoint(marginX = RESPAWN_EDGE_MARGIN, marginY = marginX) {
    const { playW, playH } = this.world;
    let best = randomWorldPoint(marginX, marginY, playW, playH);
    let bestClearance = -1;

    for (let i = 0; i < RESPAWN_ATTEMPTS; i += 1) {
      const p = randomWorldPoint(marginX, marginY, playW, playH);
      let minD = Infinity;

      for (const e of this.world.enemies) {
        minD = Math.min(minD, Math.hypot(e.x - p.x, e.y - p.y));
      }

      for (const a of this.world.asteroids) {
        if (a.radius >= RESPAWN_ASTEROID_MIN_R) {
          minD = Math.min(minD, Math.hypot(a.x - p.x, a.y - p.y));
        }
      }

      if (minD >= RESPAWN_CLEARANCE) {
        return p satisfies Vec;
      }

      if (minD > bestClearance) {
        bestClearance = minD;
        best = p;
      }
    }

    return best satisfies Vec;
  }

  private spawnInFx(x: number, y: number) {
    const tint = this.myTint();
    this.fx.converge(x, y, 12, 60, 300, tint, "important");
    this.time.delayedCall(300, () => {
      this.fx.ring(x, y, 6, 30, 200, tint, 0.7, "important");
    });
  }

  private steerShip(dt: number) {
    if (!this.pilot.alive || !this.pilot.spawned) {
      return;
    }

    const nitro = this.pilot.boosts.has("nitro");
    const accel = SHIP_ACCEL * (nitro ? NITRO_ACCEL_MULT : 1);
    const maxSpeed = SHIP_MAX_SPEED * (nitro ? NITRO_MAX_SPEED_MULT : 1);
    let drag = SHIP_BRAKE_DRAG;
    this.pilot.thrust = 0;
    const steer = this.steerVector();

    if (steer) {
      if (steer.aim) {
        this.pilot.shipAngle = steer.angle;
      }

      this.pilot.thrust = steer.thrust;

      if (this.pilot.thrust > 0) {
        this.pilot.shipVX += Math.cos(steer.angle) * accel * this.pilot.thrust * dt;
        this.pilot.shipVY += Math.sin(steer.angle) * accel * this.pilot.thrust * dt;
      }

      drag = steer.dist > steer.deadZone ? SHIP_DRAG : SHIP_BRAKE_DRAG;
    }

    const decay = Math.exp(-drag * dt);
    this.pilot.shipVX *= decay;
    this.pilot.shipVY *= decay;
    const speed = Math.hypot(this.pilot.shipVX, this.pilot.shipVY);

    if (speed > maxSpeed) {
      const k = maxSpeed / speed;
      this.pilot.shipVX *= k;
      this.pilot.shipVY *= k;
    }

    this.pilot.shipX += this.pilot.shipVX * dt;
    this.pilot.shipY += this.pilot.shipVY * dt;

    if (this.pilot.shipX < 0 || this.pilot.shipX > this.world.playW) {
      this.pilot.shipX = PhaserMath.Clamp(this.pilot.shipX, 0, this.world.playW);
      this.pilot.shipVX = 0;
    }

    if (this.pilot.shipY < 0 || this.pilot.shipY > this.world.playH) {
      this.pilot.shipY = PhaserMath.Clamp(this.pilot.shipY, 0, this.world.playH);
      this.pilot.shipVY = 0;
    }
  }

  private steerVector() {
    const { trailer } = this.link;

    if (trailer) {
      const s = trailer.steer;

      if (!s) {
        return null;
      }

      return {
        aim: true,
        angle: s.angle,
        deadZone: SHIP_DEAD_ZONE,
        dist: s.thrust > 0 ? SHIP_DEAD_ZONE + SHIP_THRUST_RAMP * s.thrust : 0,
        thrust: s.thrust,
      };
    }

    if (this.pad.connected) {
      const stick = this.pad.getStick();

      if (!stick.inDeadZone) {
        return {
          aim: true,
          angle: stick.angle,
          deadZone: PAD_STICK_DEAD_ZONE,
          dist: stick.distance,
          thrust: stick.magnitude,
        };
      }
    }

    if (this.gamepad.isTouch) {
      const stick = this.gamepad.getStick();

      if (!stick.active) {
        return null;
      }

      return {
        aim: !stick.inDeadZone,
        angle: stick.angle,
        deadZone: JOYSTICK_DEAD_ZONE,
        dist: stick.distance,
        thrust: stick.magnitude,
      };
    }

    if (!this.pointerSeen) {
      return null;
    }

    const p = this.input.activePointer;
    const cam = this.cameras.main;
    const dx = this.camBase.x + (p.x - cam.x - cam.width / 2) / cam.zoom - this.pilot.shipX;
    const dy = this.camBase.y + (p.y - cam.y - cam.height / 2) / cam.zoom - this.pilot.shipY;
    const dist = Math.hypot(dx, dy);
    const thrust = Math.min(1, Math.max(0, (dist - SHIP_DEAD_ZONE) / SHIP_THRUST_RAMP));

    return { aim: dist > 0.001, angle: Math.atan2(dy, dx), deadZone: SHIP_DEAD_ZONE, dist, thrust };
  }

  private enterTouchMode() {
    this.writeStartCopy();
  }

  private isFiring() {
    if (this.link.trailer) {
      return this.link.trailer.fire;
    }

    if (this.pad.connected && (this.pad.isButtonDown("rt") || this.pad.isButtonDown("a"))) {
      return true;
    }

    if (this.fireKey?.isDown === true) {
      return true;
    }

    return this.gamepad.isTouch
      ? this.gamepad.getStick().active || this.gamepad.isButtonDown("fire")
      : this.input.activePointer.isDown;
  }

  private myTint() {
    const { myId } = this.link;

    return (
      (myId !== null && myId !== "" ? this.shipView.ships.get(myId)?.tint : undefined) ?? 0xff_ff_ff
    );
  }

  private updateCamera(dt: number, timeMs: number) {
    const lock = this.link.trailer?.camPos ?? null;

    if (!this.pilot.spawned && !lock) {
      return;
    }

    if (REDUCED_MOTION.matches) {
      this.pilot.kickX = 0;
      this.pilot.kickY = 0;
      this.trauma.reset();
      this.tweens.killTweensOf(this.layers.flashRect);
      this.layers.flashRect.setAlpha(0);
      this.centerCamera(lock ? lock.x : this.pilot.shipX, lock ? lock.y : this.pilot.shipY);
      this.cameras.main.setAngle(0);
      this.camRollDeg = 0;

      return;
    }

    const decay = Math.exp(-8 * dt);
    this.pilot.kickX *= decay;
    this.pilot.kickY *= decay;
    const s = this.trauma.update(dt, timeMs / 1000);
    const cx = lock ? lock.x : this.pilot.shipX + this.pilot.kickX;
    const cy = lock ? lock.y : this.pilot.shipY + this.pilot.kickY;
    this.camBase.x = cx;
    this.camBase.y = cy;
    this.cameras.main.centerOn(cx + s.ox, cy + s.oy);
    this.cameras.main.setAngle(s.rot);
    this.camRollDeg = s.rot;
  }

  private centerCamera(x: number, y: number) {
    this.camBase.x = x;
    this.camBase.y = y;
    this.cameras.main.centerOn(x, y);
  }

  private syncScreenUi() {
    const { zoom } = this.cameras.main;
    const rot = PhaserMath.DegToRad(this.camRollDeg);
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const x = cx - (cx * cos + cy * sin) / zoom;
    const y = cy + (cx * sin - cy * cos) / zoom;

    for (const obj of [this.layers.minimapGfx, this.layers.flashRect, this.barrier.vignette]) {
      obj
        .setPosition(x, y)
        .setRotation(-rot)
        .setScale(1 / zoom);
    }
  }
}
