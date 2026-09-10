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
import { Input, Math as PhaserMath, Scale, Scene, Scenes } from "phaser";
import type Phaser from "phaser";
import { sfx } from "../audio/sfx";
import { installDevHooks } from "../dev/dev-hooks";
import { AttractBattle } from "../fx/attract-battle";
import { HostCombat } from "../net/host-combat";
import { HostDirector } from "../net/host-director";
import { PlayerNet } from "../net/player-net";
import { emptyShared } from "../net/shared-world";
import { readNetState } from "../net/wire-read";
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
import { diag, installTestHooks } from "../shared/diag";
import { rand } from "../shared/rng";
import { newDirtyFlags } from "../state/dirty-flags";
import type { DirtyFlags } from "../state/dirty-flags";
import { Link } from "../state/link";
import { newPilot } from "../state/pilot";
import type { Pilot } from "../state/pilot";
import { BeaconClient } from "../sys/beacon-client";
import { EnemyAi } from "../sys/enemy-ai";
import { Pickups } from "../sys/pickups";
import { Progression } from "../sys/progression";
import { Shield } from "../sys/shield";
import { ShooterHits } from "../sys/shooter-hits";
import { Weapons } from "../sys/weapons";
import { installTrailerStage } from "../trailer/trailer-stage";
import type { TrailerStageApi } from "../trailer/trailer-staging";

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://vibedgames-party.kyh.workers.dev";

// Fresh room name per shared-state shape change (v6: asteroid verts left off
// the wire — derived per-client from the id — plus quantized coordinates and
// short entity ids, per the dir-002 bandwidth audit): old deployed clients
// can't pollute this build's world.
const ROOM_DEFAULT = "starfall-arena-v6";
/** DEV-only room override (?room=): the multiplayer e2e harness isolates each
 *  run in a fresh arena so a stale room's world can't leak into assertions. */
const ROOM =
  (import.meta.env.DEV && new URLSearchParams(location.search).get("room")) || ROOM_DEFAULT;
/** Per-arena cap. The party server clamps to its own hard ceiling and overflows
 *  player #33+ into a sibling arena (starfall-arena-v4~2, …) automatically. */
const STARFALL_MAX_PLAYERS = 32;

/** Black mask thickness past the world edge (covers any screen half-width). */
// Masks start OUTSIDE the bleed ring so they hide truly-off-world entities but
// not the fading bleed stars; still wide enough to cover any screen half-width.
const MASK_PAD = WORLD_BLEED_PX + 4000;
/** Coarse-pointer boot check: phones/tablets get the touch copy immediately
 *  instead of waiting for the first tap to flip `gamepad.isTouch`. */
const IS_COARSE_POINTER =
  window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
/** Physical-stick deflection (0–1) treated as noise; past it the pad owns the
 *  steer vector for the frame (mirrors the touch-joystick dead zone). */
const PAD_STICK_DEAD_ZONE = 0.15;
/** Narrow-viewport zoom-out (PvP reaction fairness): viewports narrower than
 *  REF render at width/REF zoom, floored at MIN — phones land at the floor and
 *  see more world. The off-world mask (MASK_PAD) covers any zoomed half-view.
 *  qa-011: floor raised 0.75 → 0.9 — at 0.75 a 390px phone rendered the ship
 *  ~12px and drones as 1-3px flecks; the extra world view was worthless when
 *  the threats it showed were invisible. Readability beats reaction range. */
const CAMERA_REF_WIDTH = 1100;
const CAMERA_MIN_ZOOM = 0.9;

/** Initial-spawn clearance from the world edge along one axis: at least the
 *  central region, inset further when the viewport would reach the border. */
const initialSpawnInset = (dim: number, halfView: number): number =>
  Math.min(Math.max(dim * INITIAL_SPAWN_CENTER_FRAC, halfView + RESPAWN_EDGE_MARGIN), dim / 2);

/** Everything the DEV harness (dev/dev-hooks.ts) and the trailer stage
 *  (trailer/trailer-stage.ts) drive. Gameplay code never reads this; it is
 *  the one sanctioned way past the scene's private fields. */
export interface SceneInternals {
  world: SharedState;
  pilot: Pilot;
  link: Link;
  dirty: DirtyFlags;
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
  hostCombat: HostCombat;
  ai: EnemyAi;
  host: HostDirector;
  sync: WorldSync;
  cameras: Phaser.Cameras.Scene2D.CameraManager;
  tweens: Phaser.Tweens.TweenManager;
  forceOfflineSolo: () => void;
}

export class GameScene extends Scene {
  /**
   * Local working copy of the shared world. The host owns it (events mutate
   * it, hostTick broadcasts it); guests dead-reckon it every frame and
   * reconcile toward the host's 20Hz snapshots — that's what keeps asteroid
   * motion smooth at 60fps despite the 20Hz wire rate. One record for the
   * whole session: adoption replaces its fields in place (adoptShared).
   */
  private readonly world = emptyShared();
  /** My ship: pose, life cycle and loadout (state/pilot.ts). */
  private readonly pilot = newPilot();
  /** Session identity + socket (state/link.ts). Inbound events (and offline
   *  loopback) route to PlayerNet. */
  private readonly link = new Link({
    inbox: (event, payload, from) => this.net.handleEvent(event, payload, from),
  });
  /** Host-only share flags (state/dirty-flags.ts). */
  private readonly dirty = newDirtyFlags();
  private readonly trauma = new TraumaCamera();
  // Collaborators are built in create(): the render ones need the Phaser
  // display list, and the rest are wired in dependency order there.
  private hud!: Hud;
  private view!: WorldView;
  private shipView!: ShipView;
  private net!: PlayerNet;
  private beacon!: BeaconClient;
  private pickups!: Pickups;
  private shield!: Shield;
  private hits!: ShooterHits;
  private progress!: Progression;
  private weapons!: Weapons;
  private hostCombat!: HostCombat;
  private ai!: EnemyAi;
  private host!: HostDirector;
  private sync!: WorldSync;
  private starfield!: Starfield;
  private barrier!: EnergyBarrier;
  private fx!: FxPool;
  /** Shared draw surfaces (render/layers.ts), created in create(). */
  private layers!: Layers;
  /** Phaser's activePointer sits at (0,0) until the first real pointer event —
   *  steering before then would yank the ship to the screen corner. */
  private pointerSeen = false;
  /** Held SPACE = held mouse button (qa-005). */
  private fireKey: Phaser.Input.Keyboard.Key | null = null;
  /** qa-013 one-shot: opening rocks placed after the first ship spawn. */
  private openingRocksSeeded = false;
  /** The mobile controller: a floating move-joystick that also fires while
   *  it's held (see isFiring), plus a "rest" button so a second finger fires
   *  too. Desktop keeps the mouse model (aim+thrust at the cursor); the
   *  gamepad only activates on first touch. */
  private gamepad!: PhaserGamepad;
  /** Physical controller: left stick = aim + thrust (same heading+magnitude
   *  model as the touch joystick), RT or A held = fire. */
  private readonly pad = new PhysicalGamepad({ stickDeadZone: PAD_STICK_DEAD_ZONE });
  /** Re-renders the start-screen copy on pad connect/disconnect while the
   *  overlay is up; unsubscribed the moment play begins. */
  private unwatchControls: (() => void) | null = null;
  /** Touch-only pause button (Escape is keyboard-only). */
  private touchControls!: TouchControls;

  /** Current trauma roll in degrees (what setAngle was last given) — Phaser 4
   *  types expose no camera `rotation` getter, so syncScreenUi reads this. */
  private camRollDeg = 0;
  /** Scratch vector for screen→world cursor mapping (zero-alloc steering). */
  private readonly pointerWorld = new PhaserMath.Vector2();

  private startEl: HTMLElement | null = null;
  /** Cosmetic start-screen dogfight backdrop. Non-null only until play begins. */
  private attract: AttractBattle | null = null;

  constructor() {
    super("Game");
  }

  create(): void {
    // Bot-playtest diagnostics contract (shared/diag.ts): telemetry + the
    // active-play hook. Single-start scene, so once per page load by design.
    // setPaused rides the same offline-only freeze as the wrapper pause.
    installTestHooks({
      activePlay: () => this.forceOfflineSolo(),
      setPaused: (paused) => (paused ? this.freezeSim() : this.unfreezeSim()),
    });
    this.starfield = new Starfield(this);
    this.fx = new FxPool(this);

    // scene-reuse safety: drop a prior instance's Graphics
    this.barrier?.destroy();
    this.barrier = new EnergyBarrier(this);

    // Black mask past the bleed ring: entities legitimately exist beyond the
    // edge (spawning asteroids, escaping beams) but must not be visible there.
    // Inset by WORLD_BLEED_PX so the fading bleed starfield stays visible.
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
    // Explicit offline boot (?offline=1): never dial the party server. A
    // failed WebSocket handshake logs a browser console error the page cannot
    // suppress, so an offline-by-intent run (bot playtest, deliberate solo)
    // must skip the socket entirely rather than lean on the failure fallback
    // (Link.poll). The client simply never exists on this path.
    // Trailer mode (?trailer=1) is always a fully offline session: the
    // director stages "multiplayer" with local fake peers, never the network.
    if (isOfflineRequested() || new URLSearchParams(location.search).has("trailer")) {
      this.link.goOffline();
      this.sync.ensureSeeded();
    } else {
      this.link.connect({
        host: MULTIPLAYER_HOST,
        maxPlayers: STARFALL_MAX_PLAYERS,
        onUpdate: () => this.sync.onUpdate(),
        room: ROOM,
      });
    }

    // Desktop steers from the cursor (activePointer); the gamepad below owns
    // the touch path. These two listeners only track that a pointer exists and
    // unlock audio on the first gesture. A touch must NOT arm cursor-steer:
    // it has no resting position, so the ship would fly at wherever the finger
    // last was for the rest of the session.
    this.input.on(Input.Events.POINTER_MOVE, (p: Phaser.Input.Pointer) => {
      if (!p.wasTouch) {
        this.pointerSeen = true;
      }
    });
    this.input.on(Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      if (!p.wasTouch) {
        this.pointerSeen = true;
      }
      // WebAudio needs a user gesture
      sfx.unlock();
    });

    // Sound is opt-in: muted by default, M toggles, choice persists (see
    // sfx). The gesture itself unlocks audio. Escape is keyboard-only, so
    // without this button a phone player gets a run they cannot pause.
    this.touchControls = createTouchControls();
    this.input.keyboard?.on("keydown-M", () => sfx.toggleMute());

    // qa-005: held SPACE autofires exactly like a held mouse button (spec
    // Controls: "hold mouse/space to fire"). addKey captures the keystroke so
    // the page never scrolls.
    this.fireKey = this.input.keyboard?.addKey(Input.Keyboard.KeyCodes.SPACE) ?? null;

    // Mobile controller: a floating move-joystick (first finger) plus a "rest"
    // fire button — any finger that isn't the stick fires.
    // (Firing itself is one-thumbed, see isFiring.)
    this.gamepad = attachVirtualGamepad(this, {
      buttons: [{ id: "fire" }],
      onFirstTouch: () => this.enterTouchMode(),
      stick: {
        deadZone: JOYSTICK_DEAD_ZONE,
        knobRadius: JOYSTICK_KNOB_RADIUS,
        radius: JOYSTICK_RADIUS,
      },
    });
    // touch copy from boot, not first tap
    if (IS_COARSE_POINTER) {
      this.enterTouchMode();
    }
    // After the gamepad exists: writeStartCopy() reads its touch flag.
    this.buildStartScreen();

    // Cosmetic hero-vs-swarm backdrop behind the start overlay, mimicking real
    // play. Purely visual — never written to the net session (see module).
    this.attract = new AttractBattle(this, {
      enemyHull: (kind) => enemyHullPoints(kind),
      fx: this.fx,
      hullPoints: (level) => shipHullPoints(level),
      makeEnemy: (kind) => this.view.makeEnemyGfx(kind).setDepth(9),
      makeShip: (tint, level) => this.shipView.makeShipGfx(tint, level),
    });

    // Pause = the wrapper wants its chrome back. Online, freezing the shared
    // world would stall the other players, so we pause AS A SPECTATOR: dock my
    // ship out of the arena, then re-enter through the respawn flow. Offline
    // (solo world, no one else to stall) we truly FREEZE: the pausable sim
    // clock (shared/clock.ts) holds every stored deadline, so a boost with 3s
    // left before the pause still has 3s after resume.
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
    // Start-screen framing: pre-spawn the camera sits at scroll (0,0) — the
    // world's top-left corner. At zoom 1 (desktop) the world border lands
    // exactly on the screen edge and reads as a clean frame, but phone zoom
    // (< 1) widens the worldView AROUND the viewport centre, pushing it past
    // the border into the void. Park on the world centre instead — the map
    // dwarfs every viewport, so no edge can show at any zoom. ensureSpawned
    // re-centres on the ship the moment the run starts.
    this.cameras.main.centerOn(this.world.playW / 2, this.world.playH / 2);

    // Single-start assumption: this scene is started once per page load and
    // never restarted, so create()-initialized fields are never stale. `once`
    // keeps the shutdown hook from stacking if that ever changes.
    this.events.once(Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Scale.Events.RESIZE, this.onViewportChange, this);
      this.gamepad.destroy();
      this.touchControls.destroy();
      this.link.destroy();
    });

    installDevHooks(this.internals());
  }

  /** Constructor injection in dependency order. The cycles (progress ↔
   *  shield, view ↔ weapons, weapons ↔ hits, shield → net, director ↔ sync)
   *  are closed by hooks that resolve the later collaborator at call time. */
  private wireCollaborators(): void {
    const { world, pilot, link, dirty, fx, layers, trauma } = this;
    this.progress = new Progression({
      clock: this.time,
      fx,
      hooks: {
        myTint: () => this.myTint(),
        popCombo: () => this.hud.popCombo(),
        shield: () => this.shield,
      },
      pilot,
      trauma,
    });
    this.ai = new EnemyAi({ dirty, world });
    this.hostCombat = new HostCombat({
      ai: this.ai,
      dirty,
      hooks: {
        maxPresentLevel: () => this.host.maxPresentLevel(),
        onBossKilled: (now) => this.host.noteBossKilled(now),
      },
      world,
    });
    this.host = new HostDirector({
      ai: this.ai,
      dirty,
      hooks: {
        phasedUntil: () => this.shield.phasedUntil,
        prepareHost: () => this.sync.prepareHost(),
      },
      hostCombat: this.hostCombat,
      link,
      pilot,
      progress: this.progress,
      world,
    });
    this.view = new WorldView({
      fx,
      hooks: { weapons: () => this.weapons },
      host: this.host,
      layers,
      link,
      pilot,
      scene: this,
      trauma,
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
      hostCombat: this.hostCombat,
      link,
      pilot,
      progress: this.progress,
      trauma,
      view: this.view,
      world,
    });
    this.hits = new ShooterHits({
      fx,
      hostCombat: this.hostCombat,
      link,
      pilot,
      progress: this.progress,
      weapons: this.weapons,
      world,
    });
    this.shield = new Shield({
      dirty,
      fx,
      hits: this.hits,
      hooks: {
        myTint: () => this.myTint(),
        pushMyState: (now) => this.net.pushMyState(now),
      },
      hostCombat: this.hostCombat,
      layers,
      link,
      pilot,
      progress: this.progress,
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
      scene: this,
      shield: this.shield,
      trauma,
      view: this.view,
      weapons: this.weapons,
    });
    this.pickups = new Pickups({
      dirty,
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
      dirty,
      hostCombat: this.hostCombat,
      link,
      pilot,
      progress: this.progress,
      shield: this.shield,
      sync: this.sync,
      weapons: this.weapons,
      world,
    });
  }

  private internals(): SceneInternals {
    return {
      ai: this.ai,
      beacon: this.beacon,
      cameras: this.cameras,
      dirty: this.dirty,
      forceOfflineSolo: () => this.forceOfflineSolo(),
      fx: this.fx,
      hits: this.hits,
      host: this.host,
      hostCombat: this.hostCombat,
      hud: this.hud,
      link: this.link,
      net: this.net,
      pickups: this.pickups,
      pilot: this.pilot,
      progress: this.progress,
      shield: this.shield,
      shipView: this.shipView,
      sync: this.sync,
      tweens: this.tweens,
      view: this.view,
      weapons: this.weapons,
      world: this.world,
    };
  }

  /** Trailer director entry (?trailer=1): see trailer/trailer-stage.ts. */
  trailerStage(): TrailerStageApi {
    return installTrailerStage(this.internals());
  }

  override update(time: number, delta: number): void {
    // clamp tab-switch spikes
    const dt = Math.min(delta, 100) / 1000;
    // poll the physical controller once per frame
    this.pad.update();
    // Any pad face button doubles as "press any key" on the start screen.
    if (!this.link.started && ["a", "b", "x", "y", "start"].some((b) => this.pad.justPressed(b))) {
      this.beginPlay();
    }
    this.starfield.update(dt, time);
    this.barrier.update(time, this.world.playW, this.world.playH);
    if (!this.link.offline) {
      this.pollLink();
    }
    // Start screen up: run the cosmetic dogfight backdrop behind the overlay.
    // It's purely additive — the live path below still runs (so the host keeps
    // the shared world ticking and real remote players still render/mix in).
    if (!this.link.started) {
      this.attract?.update(dt, this.time.now);
    }
    if (!this.link.live) {
      this.hud.updateBattlePresentation(simNow());
      // Connecting (pre-live): no world to tick, but still flush attract's fx.
      this.fx.update(dt, this.time.now);
      // camera is static here; keep the vignette pinned
      this.syncScreenUi();
      // after this frame's work, so bots never read stale state
      this.publishDiag();
      return;
    }
    const now = simNow();
    // Parse every peer's net state once for this frame; readers below (aim,
    // mines, PvP, host sim, render, minimap) all pull from the map.
    this.link.peerStates.clear();
    // A peer mid-drop (seat held in the reconnect grace) is absent, not a
    // frozen ghost for enemies and beams to target.
    for (const [id, player] of Object.entries(this.link.peers)) {
      this.link.peerStates.set(id, player.connected === false ? null : readNetState(player));
    }

    this.ensureSpawned();
    this.seedOpeningRocks();
    this.tickRespawn(now);
    // The knob wears the local player's colour, which is only known once the
    // ship exists — so it is pushed per frame rather than fixed at attach.
    this.gamepad.setTint(this.myTint());
    this.gamepad.update();
    this.steerShip(dt);
    this.weapons.handleShooting(delta, now);
    this.weapons.updateBeams(dt, now);
    this.weapons.tickMines(now);
    this.weapons.tickSentry(now);
    this.sync.advanceWorld(dt);
    if (this.link.amHost) {
      this.host.hostTick(now, dt, delta);
      // Never baseline the constructor's empty pre-connection world. Guests
      // instead observe accepted shared snapshots, not predicted removals.
      if (this.sync.shared() && (!this.link.offline || this.sync.offlineSeeded)) {
        this.hud.observeBossEncounters(this.world);
      }
    }
    this.hits.detectMyHits(now);
    this.shield.detectIncomingDamage(now, dt);
    this.pickups.pickupItems(now);
    this.pickups.collectShards(now);
    this.beacon.tickBeaconClient(now);
    this.shield.tickShield(now, dt);
    // Special expired → revert to the CURRENT level's base weapon, not L1.
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
    // Before netSend, so a boundary's score reset reaches the wire same tick.
    this.hud.tickSector(now);
    this.net.netSend(delta, now);

    this.shipView.syncShips(now, dt);
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
    // Scene choreography in phase with the pose about to be drawn, so a
    // camPos override centres on where the ship IS (see TrailerStaging.frame).
    this.link.trailer?.frame?.();
    this.updateCamera(dt, time);
    this.syncScreenUi();
    this.hud.updateBattlePresentation(now);
    this.hud.updateHud(now);
    // after this frame's work, so bots never read stale state
    this.publishDiag();
  }

  /** Give up on the party server after the grace window and go solo. Called
   *  every update() tick until the fallback triggers (or forever, online). */
  private pollLink(): void {
    const step = this.link.poll();
    if (step === "readmitted-host") {
      // Readmitted as the continuing host: patches sent into the drop were
      // discarded, so the next share carries the whole world.
      this.host.markWorldDirty();
    } else if (step === "fallback") {
      this.sync.ensureSeeded();
    }
  }

  /** Resize/rotation: re-read the safe-area insets and re-derive camera zoom. */
  private onViewportChange(): void {
    this.layers.safeInset = safeAreaInset();
    // trailer scenes own zoom (per-shot framing)
    if (this.link.trailer) {
      return;
    }
    const zoom = PhaserMath.Clamp(this.scale.width / CAMERA_REF_WIDTH, CAMERA_MIN_ZOOM, 1);
    this.cameras.main.setZoom(zoom);
  }

  // ---- input + my ship -------------------------------------------------------

  /** First connect: drop the ship at a clear spot and snap the camera. */
  /** The one place controls are taught. Dismissed on the first key/pointer
   *  RELEASE, not press: the fire handlers stay live behind the overlay, so
   *  starting on a press would let the same click also shoot. */
  private buildStartScreen(): void {
    this.startEl = document.querySelector("#start");
    this.writeStartCopy();
    // Plugging in a pad while the start screen is up adds its rows.
    this.unwatchControls?.();
    this.unwatchControls = watchControlContext(() => {
      if (!this.link.started) {
        this.writeStartCopy();
      }
    });
    this.input.keyboard?.once("keyup", () => this.beginPlay());
    // The overlay covers the canvas, so listen on the element itself — and seal
    // it, because covering the canvas is NOT enough on touch: the tap's own
    // events bubble to Phaser's window listeners, and its compatibility mouse
    // burst re-targets to the canvas the instant the overlay stops hit-testing.
    if (this.startEl) {
      sealPointerEvents(this.startEl);
      this.startEl.addEventListener("pointerup", () => this.beginPlay(), { once: true });
    }
  }

  /** Start-screen copy, re-run when the touch scheme is detected or a pad
   *  connects. Renders the same grouped keycap card the pause overlay shows
   *  (../pause-overlay buildControls); `coarse` is forced from live touch
   *  detection so a finger on a fine-pointer device still flips the copy
   *  (enterTouchMode), and pad rows appear from live detection. */
  private writeStartCopy(): void {
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
    // Reveals the overlay on the first write — see #start in index.html.
    this.startEl?.classList.add("ready");
  }

  private beginPlay(): void {
    if (this.link.started) {
      return;
    }
    this.link.started = true;
    // The sealed start overlay keeps its tap off the canvas, so this gesture is
    // the one that has to unlock WebAudio.
    sfx.unlock();
    // qa-020, offline solo ONLY: the sector clock (and the intensity curve)
    // starts at first input, not at boot — overlay-idle time was pure sector
    // loss, and a long idle met the rel-405 forced dreadnought at Lv1. Online
    // rooms keep the shared epoch untouched: the room clock predates you.
    if (this.link.offline) {
      this.world.arenaEpoch = simNow();
    }
    this.unwatchControls?.();
    this.unwatchControls = null;
    notifyGameStarted();
    // Tear the cosmetic battle down the instant real play begins.
    this.attract?.destroy();
    this.attract = null;
    this.startEl?.classList.add("hide");
    // Drop it only after the fade, so it can't swallow taps on the way out.
    this.time.delayedCall(320, () => this.startEl?.remove());
  }

  /** Test hook (shared/diag.ts): jump straight into an offline solo run —
   *  force the fallback that maybeGoOffline would reach after the 4s grace,
   *  then dismiss the start overlay. Never called during real play. */
  private forceOfflineSolo(): void {
    if (!this.link.offline) {
      this.link.goOffline();
      this.sync.ensureSeeded();
    }
    this.beginPlay();
  }

  /** Per-frame diagnostics for bot playtests (shared/diag.ts). One object
   *  mutated in place; primitives only. */
  private publishDiag(): void {
    diag.frame += 1;
    diag.score = this.progress.runXp;
    diag.player.x = this.pilot.shipX;
    diag.player.y = this.pilot.shipY;
    diag.player.speed = Math.hypot(this.pilot.shipVX, this.pilot.shipVY);
    diag.entities = this.world.enemies.length + this.world.asteroids.length;
    diag.beams = this.weapons.beams.length;
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

  /** Offline-only REAL freeze: stop the sim clock (every stored deadline
   *  holds), sleep the render loop, suspend audio. Never online — the shared
   *  world would stall for the other players (they get the spectator path). */
  private freezeSim(): void {
    if (this.link.frozen || !this.link.offline) {
      return;
    }
    this.link.frozen = true;
    pauseClock();
    sfx.setSuspended(true);
    // stops update() until wake()
    this.game.loop.sleep();
  }

  private unfreezeSim(): void {
    if (!this.link.frozen) {
      return;
    }
    this.link.frozen = false;
    resumeClock();
    sfx.setSuspended(false);
    this.game.loop.wake();
  }

  /** Wrapper pause (online) → dock my ship out of the arena as a spectator. No
   *  death penalty, no XP loss, no death explosion: my net state simply
   *  advertises absence (present: false) so remotes drop me the way a
   *  disconnect would. Freezing the shared online world is forbidden, so the
   *  arena keeps running behind the wrapper overlay. */
  private pauseToSpectator(): void {
    if (this.link.paused) {
      return;
    }
    this.link.paused = true;
    // Clean despawn. Leaving alive=false + respawnAt=0 means tickRespawn can't
    // fire, and spawned=false hides my ship + gates every my-ship code path.
    this.pilot.spawned = false;
    this.pilot.alive = false;
    this.pilot.respawnAt = 0;
    this.weapons.beams = [];
    this.weapons.sentry = null;
    this.shield.impactArcs = [];
    this.progress.streak = 0;
    this.progress.comboTier = 1;
    // Immediate, so remotes drop my ship without a snapshot of lag.
    if (this.link.started && this.link.myId) {
      this.net.pushMyState(simNow());
    }
    sfx.setSuspended(true);
  }

  /** Wrapper resume → re-enter through the normal respawn flow (invuln + full
   *  shield + the level's base loadout via pickRespawnPoint), online or solo. */
  private resumeFromSpectator(): void {
    if (!this.link.paused) {
      return;
    }
    this.link.paused = false;
    sfx.setSuspended(false);
    // paused before play began: nothing to re-enter
    if (!this.link.started) {
      return;
    }
    // Route re-entry through tickRespawn: mark spawned (so ensureSpawned won't
    // also fire) but dead with an elapsed respawn timer. Next update() re-spawns
    // me once, with invuln — never a double ship.
    this.pilot.spawned = true;
    this.pilot.alive = false;
    this.pilot.respawnAt = simNow();
  }

  private ensureSpawned(): void {
    if (!this.link.started || this.link.paused || this.pilot.spawned || !this.link.myId) {
      return;
    }
    // Same clearance as respawn, but confined to the map's central region —
    // an edge start opens with the void past the world border on screen. At
    // least the central third per axis, inset further when a big/zoomed-out
    // viewport would still reach the border from there.
    const cam = this.cameras.main;
    const { playW, playH } = this.world;
    const pos = this.pickRespawnPoint(
      initialSpawnInset(playW, cam.width / 2 / cam.zoom),
      initialSpawnInset(playH, cam.height / 2 / cam.zoom),
    );
    this.pilot.shipX = pos.x;
    this.pilot.shipY = pos.y;
    this.pilot.spawned = true;
    this.cameras.main.centerOn(pos.x, pos.y);
    this.spawnInFx(pos.x, pos.y);
    this.net.pushMyState(simNow());
  }

  /** qa-013: the 6s safe opening spawns no enemies and the seed field
   *  scatters arena-wide, so the literal first playable second was ship +
   *  dots. Park a few one-shot rocks inside the opening viewport. Host/solo
   *  only (a guest joins an already-populated arena), once per session, and
   *  never before ensureSeeded ran — a fresh world object would drop them. */
  private seedOpeningRocks(): void {
    if (this.openingRocksSeeded || !this.pilot.spawned) {
      return;
    }
    if (!this.link.offline && !this.link.amHost) {
      this.openingRocksSeeded = true;
      return;
    }
    // world not seeded yet
    if (this.world.asteroids.length === 0) {
      return;
    }
    const cam = this.cameras.main;
    const maxDist = PhaserMath.Clamp(Math.min(cam.width, cam.height) / 2 / cam.zoom - 60, 160, 320);
    const base = rand() * Math.PI * 2;
    for (let i = 0; i < OPENING_ROCK_COUNT; i += 1) {
      // Evenly fanned with jitter — always spread around the ship, never a clump.
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
    this.dirty.asteroids = true;
  }

  private tickRespawn(now: number): void {
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
    // respawn at full (§A.1)
    this.shield.shieldHp = SHIELD_MAX;
    this.shield.overHp = 0;
    this.shield.lastDamageAt = 0;
    this.shield.regenActive = false;
    this.pilot.weaponUntil = 0;
    // revive at the level's base weapon + regen
    this.progress.applyBaseLoadout(now);
    this.pilot.kickX = 0;
    this.pilot.kickY = 0;
    this.cameras.main.centerOn(pos.x, pos.y);
    this.spawnInFx(pos.x, pos.y);
    sfx.play("respawn");
    this.net.pushMyState(now);
  }

  /** Re-roll until clear of enemies + big asteroids; ≤8 attempts, take best. */
  private pickRespawnPoint(marginX = RESPAWN_EDGE_MARGIN, marginY = marginX): Vec {
    // respawn within the LIVE (scaled) play area
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
        return p;
      }
      if (minD > bestClearance) {
        bestClearance = minD;
        best = p;
      }
    }
    return best;
  }

  /** Anticipation → ring → the hull pops in (alpha handled by invuln blink). */
  private spawnInFx(x: number, y: number): void {
    const tint = this.myTint();
    this.fx.converge(x, y, 12, 60, 300, tint, "important");
    this.time.delayedCall(300, () => this.fx.ring(x, y, 6, 30, 200, tint, 0.7, "important"));
  }

  /**
   * The control identity, now with drift: the nose points along the steer
   * direction (instant), thrust accelerates that way scaled by how far it's
   * pushed, and exponential drag makes you glide. Stopping (dead zone) brakes
   * harder than flying — responsive stop, drifty start.
   *
   * Desktop reads the steer vector from ship→cursor. Touch reads it from the
   * floating move-joystick (drag from the anchor): same model, different
   * source — `steerVector` unifies them.
   */
  private steerShip(dt: number): void {
    if (!this.pilot.alive || !this.pilot.spawned) {
      return;
    }
    // NITRO deliberately breaks the "every projectile outruns the ship" floor.
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
    // Wall clamp kills the perpendicular component: slide along edges.
    if (this.pilot.shipX < 0 || this.pilot.shipX > this.world.playW) {
      this.pilot.shipX = PhaserMath.Clamp(this.pilot.shipX, 0, this.world.playW);
      this.pilot.shipVX = 0;
    }
    if (this.pilot.shipY < 0 || this.pilot.shipY > this.world.playH) {
      this.pilot.shipY = PhaserMath.Clamp(this.pilot.shipY, 0, this.world.playH);
      this.pilot.shipVY = 0;
    }
  }

  /** The unified steering input: heading, 0–1 thrust, the dead-zone test (so
   *  steerShip can pick drift vs brake drag), and `aim` (whether to re-point
   *  the nose this frame). Null = no live input.
   *
   *  `aim` differs by source on purpose: the desktop nose tracks the cursor
   *  even inside the dead zone (the cursor-aim identity — you keep aiming while
   *  braking), but the touch nose holds steady when the finger sits near the
   *  joystick anchor (no jitter from a parked thumb). */
  private steerVector(): {
    angle: number;
    thrust: number;
    dist: number;
    deadZone: number;
    aim: boolean;
  } | null {
    // Trailer mode: the director owns steering outright — real input sources
    // are never read, so a stray cursor can't steal the ship mid-take.
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
    // Physical stick past its dead zone owns the frame (same heading+magnitude
    // model as the touch joystick, and the same override rule touch applies to
    // the mouse); inside the dead zone it yields, so an idle pad never fights
    // the cursor and the nose holds when nothing else is steering.
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
    // Screen→world through the camera: scrollX alone mis-aims under zoom < 1.
    const cursor = this.cameras.main.getWorldPoint(p.x, p.y, this.pointerWorld);
    const dx = cursor.x - this.pilot.shipX;
    const dy = cursor.y - this.pilot.shipY;
    const dist = Math.hypot(dx, dy);
    const thrust = Math.min(1, Math.max(0, (dist - SHIP_DEAD_ZONE) / SHIP_THRUST_RAMP));
    return { aim: dist > 0.001, angle: Math.atan2(dy, dx), deadZone: SHIP_DEAD_ZONE, dist, thrust };
  }

  /** Rewrite the start-screen copy for the touch control scheme. Fired at boot
   *  on coarse-pointer devices, else the first time a finger lands. */
  private enterTouchMode(): void {
    this.writeStartCopy();
  }

  /** Holding fire: any finger on touch, the mouse button or held SPACE on
   *  desktop, or RT / A held on a physical controller (merged, never
   *  exclusive).
   *
   *  Touch mirrors the desktop model — there the pointer that steers is the
   *  same one that fires, so the joystick finger fires too. A second finger
   *  (the "rest" fire button) also fires, but it is a bonus: the phone is
   *  playable one-thumbed, exactly as the start screen's HOLD → SHOOT
   *  promises. */
  private isFiring(): boolean {
    // trailer: scripted trigger only
    if (this.link.trailer) {
      return this.link.trailer.fire;
    }
    if (this.pad.connected && (this.pad.isButtonDown("rt") || this.pad.isButtonDown("a"))) {
      return true;
    }
    if (this.fireKey?.isDown) {
      return true;
    }
    return this.gamepad.isTouch
      ? this.gamepad.getStick().active || this.gamepad.isButtonDown("fire")
      : this.input.activePointer.isDown;
  }

  private myTint(): number {
    const { myId } = this.link;
    return (myId ? this.shipView.ships.get(myId)?.tint : undefined) ?? 0xff_ff_ff;
  }

  // ---- camera ----------------------------------------------------------------------------

  /**
   * Hard-centered on the ship plus directional recoil kick plus trauma shake
   * (offset AND a touch of roll — trauma², layered sin noise). Unzoomed, so
   * no bounds clamping.
   */
  private updateCamera(dt: number, timeMs: number): void {
    // Trailer camera override: fixed/panned shots still ride the trauma shake
    // (real recoil/impacts keep selling), only the follow target changes.
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
      this.cameras.main.centerOn(
        lock ? lock.x : this.pilot.shipX,
        lock ? lock.y : this.pilot.shipY,
      );
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
    this.cameras.main.centerOn(cx + s.ox, cy + s.oy);
    this.cameras.main.setAngle(s.rot);
    // syncScreenUi counters this roll on the HUD layer
    this.camRollDeg = s.rot;
  }

  /**
   * Screen-fixed objects (scrollFactor 0) still inherit the main camera's zoom
   * and trauma roll — Phaser transforms them about the viewport centre. Counter
   * both every frame so their local coordinates read as plain CSS pixels
   * anchored at the screen's top-left (minimap corner-pinned, flash
   * full-screen). The gamepad overlay counters the same transform itself.
   */
  private syncScreenUi(): void {
    const { zoom } = this.cameras.main;
    const rot = PhaserMath.DegToRad(this.camRollDeg);
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    // Anchor = centre + R(−rot)·(0 − centre)/zoom → local (0,0) lands on
    // screen (0,0). Uniform zoom commutes with the rotation, so one matrix
    // order covers Phaser's camera transform.
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
