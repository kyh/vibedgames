import { PhysicalGamepad, attachVirtualGamepad, safeAreaInset } from "@vibedgames/gamepad/phaser";
import type { Inset, PhaserGamepad } from "@vibedgames/gamepad/phaser";
import {
  createTouchControls,
  isOfflineRequested,
  notifyGameStarted,
  sealPointerEvents,
  setPauseHandlers,
  watchControlContext,
} from "@repo/embed";
import type { TouchControls } from "@repo/embed";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { PlayerMap } from "@vibedgames/multiplayer";
import type Phaser from "phaser";
import { BlendModes, Input, Math as PhaserMath, Scale, Scene, Scenes } from "phaser";
import { sfx } from "../audio/sfx";
import { WeaponMastery } from "../shared/weapon-mastery";
import {
  buildControls,
  createStarfallPauseOverlay,
  ensureStyle as ensureControlsStyle,
} from "../pause-overlay";
import { AttractBattle } from "../fx/attract-battle";
import { FxPool } from "../render/fx-pool";
import { BattleBackdrop } from "../render/battle-backdrop";
import { REDUCED_MOTION } from "../render/battle-fx";
import { EdgePips } from "../render/edge-pips";
import { EnergyBarrier } from "../render/energy-barrier";
import { Starfield } from "../render/starfield";
import { TraumaCamera } from "../render/trauma-camera";
import {
  OFFLINE_FALLBACK_MS,
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
import type { BoosterKind, PlayerNetState, SharedState, Vec, Weapon } from "../shared/constants";
import { now as simNow, pauseClock, resumeClock } from "../shared/clock";
import { diag, installTestHooks } from "../shared/diag";
import { rand } from "../shared/rng";
import type { TrailerStageApi, TrailerStaging } from "../trailer/trailer-staging";
import { readNetState } from "../net/wire-read";
import type { WireRecord } from "../net/wire-read";
import { emptyShared } from "../net/shared-world";
import { enemyHullPoints, shipHullPoints } from "../render/vector-shapes";
import { installDevHooks } from "../dev/dev-hooks";
import { installTrailerStage } from "../trailer/trailer-stage";
import { WorldSync } from "../net/world-sync";
import { HostDirector } from "../net/host-director";
import { EnemyAi } from "../sys/enemy-ai";
import { HostCombat } from "../net/host-combat";
import { Weapons } from "../sys/weapons";
import { Progression } from "../sys/progression";
import { ShooterHits } from "../sys/shooter-hits";
import { Shield } from "../sys/shield";
import { Pickups } from "../sys/pickups";
import { BeaconClient } from "../sys/beacon-client";
import { PlayerNet } from "../net/player-net";
import { ShipView } from "../render/ship-view";
import { WorldView } from "../render/world-view";
import { Hud } from "../render/hud";

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

/** Offline stand-in for `client.players`: the synthesized self entry (see the
 *  `peers` getter). Read-only in practice, so one shared object is safe. */
const SOLO_PEERS: PlayerMap = { solo: { id: "solo" } };

export class GameScene extends Scene {
  readonly hud = new Hud(this);
  readonly view = new WorldView(this);
  readonly shipView = new ShipView(this);
  readonly net = new PlayerNet(this);
  readonly beacon = new BeaconClient(this);
  readonly pickups = new Pickups(this);
  readonly shield = new Shield(this);
  readonly hits = new ShooterHits(this);
  readonly progress = new Progression(this);
  readonly weapons = new Weapons(this);
  readonly hostCombat = new HostCombat(this);
  readonly ai = new EnemyAi(this);
  readonly host = new HostDirector(this);
  readonly sync = new WorldSync(this);
  client!: MultiplayerClient;
  private starfield!: Starfield;
  private barrier!: EnergyBarrier;
  fx!: FxPool;
  trauma = new TraumaCamera();

  /**
   * Local working copy of the shared world. The host owns it (events mutate
   * it, hostTick broadcasts it); guests dead-reckon it every frame and
   * reconcile toward the host's 20Hz snapshots — that's what keeps asteroid
   * motion smooth at 60fps despite the 20Hz wire rate.
   */
  world: SharedState = emptyShared();
  /** True only after this connected host has adopted the accepted room world. */
  hostSnapshotReady = false;

  // my ship + weapon
  spawned = false;
  readonly mastery = new WeaponMastery();
  shipX = 0;
  shipY = 0;
  shipVX = 0;
  shipVY = 0;
  shipAngle = 0;
  thrust = 0;
  alive = true;
  respawnAt = 0;
  invulnUntil = 0;
  // Boot at the real L1 base loadout so the HUD never shows a name the level
  // system would immediately rewrite (qa-004: WEAPON_DEFAULT is the template,
  // baseWeaponForLevel is the loadout).
  weapon: Weapon = baseWeaponForLevel(1);
  weaponUntil = 0;
  /** Unscaled base of the held special (null on base weapon) — re-scaled per
   *  level so specials grow with you without compounding. */
  specialBase: Weapon | null = null;
  /** Shield-regen speed multiplier from the current level (baseRegenMult). */
  regenMult = 1;
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
  /** Touch-only mute/pause cluster (M and Escape are keyboard-only). */
  private touchControls!: TouchControls;

  // Solo fallback: if the party server can't be reached, this client becomes
  // its own host over the same code paths (events loop back, the local world
  // is authoritative, network writes no-op).
  offline = false;
  /** Stamped on the FIRST update() tick (not create()): heavy boots must not
   *  eat into the grace window before the socket gets a chance to connect. */
  private bootedAt = 0;
  /** True once we've ever reached a room — after that, drops reconnect. */
  private everConnected = false;
  /** Last tick's connection state, for the readmission edge. */
  private linkUp = false;
  /** Each peer's net state, parsed ONCE per frame (see update()) — identity
   *  only changes on a ~20Hz patch, and the hot paths read it many times. */
  peerStates = new Map<string, PlayerNetState | null>();

  /** In the arena — connected, or reconnecting after a drop — or running the
   *  solo offline fallback. A drop keeps the local world ticking on prediction
   *  (nobody stares at a frozen arena); readmission reconciles it. */
  get live(): boolean {
    return this.offline || this.connected || this.everConnected;
  }

  /** The SDK keeps hostId across a drop, so a host rides through its own blip
   *  as host: the world it authored stays authoritative and resumes streaming
   *  on readmission instead of rewinding to the server's last snapshot. If the
   *  server migrated host meanwhile, `sync` flips isHost and prepareHost
   *  demotes us — a former host never re-adopts its own stale snapshot. */
  get amHost(): boolean {
    return this.offline || (this.live && this.client.isHost);
  }

  /** Two-client harness probe: `__starfall.scene.wasHost`. */
  get wasHost(): boolean {
    return this.host.wasHost;
  }

  get connected(): boolean {
    return this.client.connectionStatus === "connected";
  }

  get myId(): string | null {
    return this.offline ? "solo" : this.client.playerId;
  }

  get peers(): typeof this.client.players {
    // Offline: synthesize the self entry so every `id === myId` render path
    // (ship gfx, shield ring, impact arcs, twin drone, windup glow, nitro
    // trail, minimap own-dot) still runs solo. cssToInt(undefined) → white.
    // Trailer scenes may swap in a fake peer map (staged local "remotes").
    return this.offline ? (this.trailer?.peers ?? SOLO_PEERS) : this.client.players;
  }

  /** Events loop straight back into the local host when offline. Nothing is
   *  sent while dropped: the socket would queue every message unbounded and
   *  replay the backlog on reconnect. */
  netSendEvent(event: string, payload: WireRecord): void {
    if (this.offline) {
      this.net.handleEvent(event, payload, "solo");
    } else if (this.connected) {
      this.client.sendEvent(event, payload);
    }
  }

  /** Give up on the party server after the grace window and go solo. Called
   *  every update() tick until the fallback triggers (or forever, online). */
  private maybeGoOffline(): void {
    // Start the grace window on the first tick, not at create(): counting
    // asset-load time would wrongly drop a slow-booting client to solo.
    // Real wall clock, NOT the pausable sim clock — connection deadlines must
    // keep counting through a pause (same contract as the clock module doc).
    if (this.bootedAt === 0) {
      this.bootedAt = Date.now();
    }
    if (this.connected) {
      // Readmitted as the continuing host: patches sent into the drop were
      // discarded, so the next share carries the whole world.
      if (this.everConnected && !this.linkUp && this.hostSnapshotReady) {
        this.host.markWorldDirty();
      }
      this.linkUp = true;
      this.everConnected = true;
      return;
    }
    this.linkUp = false;
    // Once we've been in the arena, a drop is transient — let the socket
    // reconnect instead of stranding a real player in a solo world.
    if (this.everConnected) {
      return;
    }
    // Pre-connect errors/closes are NOT instant failures: the socket retries
    // by itself, and a single refused handshake (cold server, wifi blip) must
    // not force a whole solo session. The deadline is the only trigger.
    if (Date.now() - this.bootedAt < OFFLINE_FALLBACK_MS) {
      return;
    }
    this.offline = true;
    // stop reconnect attempts; refresh to go online
    this.client.destroy();
    this.sync.ensureSeeded();
  }

  // boosters (timed, stack across kinds; mirrored into net state)
  boosts = new Map<BoosterKind, number>();

  // camera recoil (directional kick; omni shake comes from TraumaCamera)
  kickX = 0;
  kickY = 0;

  battleBackdrop!: BattleBackdrop;
  beamGfx!: Phaser.GameObjects.Graphics;
  shardGfx!: Phaser.GameObjects.Graphics;
  enemyShotGfx!: Phaser.GameObjects.Graphics;
  telegraphGfx!: Phaser.GameObjects.Graphics;
  beaconGfx!: Phaser.GameObjects.Graphics;
  edgePips!: EdgePips;
  haloGfx!: Phaser.GameObjects.Graphics;
  muzzleGfx!: Phaser.GameObjects.Graphics;
  splinterGfx!: Phaser.GameObjects.Graphics;
  minimapGfx!: Phaser.GameObjects.Graphics;
  flashRect!: Phaser.GameObjects.Rectangle;
  /** Device safe-area insets (home indicator/notch), re-read on resize; keeps
   *  the canvas-drawn minimap off the home indicator. */
  safeInset: Inset = { bottom: 0, left: 0, right: 0, top: 0 };
  /** Current trauma roll in degrees (what setAngle was last given) — Phaser 4
   *  types expose no camera `rotation` getter, so syncScreenUi reads this. */
  private camRollDeg = 0;
  /** Scratch vector for screen→world cursor mapping (zero-alloc steering). */
  private readonly pointerWorld = new PhaserMath.Vector2();

  private startEl: HTMLElement | null = null;
  /** False until the player dismisses the start screen. Gates spawning so the
   *  ship isn't dropped into a live arena while the controls are still up. */
  started = false;
  /** Paused-as-spectator: the wrapper asked for its chrome back, so my ship is
   *  cleanly docked out of the arena (no death penalty). Gates spawn/respawn so
   *  the ship isn't re-dropped, and my net state advertises absence (present:
   *  false) so remotes silently drop me with no death FX. */
  paused = false;
  /** Cosmetic start-screen dogfight backdrop. Non-null only until play begins. */
  private attract: AttractBattle | null = null;
  /** Trailer-mode staging overrides (src/trailer/). Null outside ?trailer=1,
   *  so every trailer guard below is dead code in normal play. */
  trailer: TrailerStaging | null = null;

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
    this.hud.bind();

    this.battleBackdrop = new BattleBackdrop(this);
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

    this.beamGfx = this.add.graphics().setDepth(12);
    // Shards: one pooled Graphics redrawn per frame (zero per-shard objects).
    this.shardGfx = this.add.graphics().setDepth(4).setBlendMode(BlendModes.ADD);
    this.enemyShotGfx = this.add.graphics().setDepth(12);
    this.telegraphGfx = this.add.graphics().setDepth(13).setBlendMode(BlendModes.ADD);
    // Beacon ring under ships (a zone on the floor), pips above everything
    // world-space (they're viewport furniture, still below the DOM HUD).
    this.beaconGfx = this.add.graphics().setDepth(5).setBlendMode(BlendModes.ADD);
    this.edgePips = new EdgePips(this, 40);
    this.haloGfx = this.add.graphics().setDepth(11).setBlendMode(BlendModes.ADD);
    this.muzzleGfx = this.add.graphics().setDepth(19).setBlendMode(BlendModes.ADD);
    this.splinterGfx = this.add.graphics().setDepth(15);
    this.minimapGfx = this.add.graphics().setScrollFactor(0).setDepth(100);
    this.flashRect = this.add
      .rectangle(0, 0, 4, 4, 0xff_ff_ff)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(90)
      .setAlpha(0);
    // Explicit offline boot (?offline=1): never dial the party server. A
    // failed WebSocket handshake logs a browser console error the page cannot
    // suppress, so an offline-by-intent run (bot playtest, deliberate solo)
    // must skip the socket entirely rather than lean on the failure fallback
    // (maybeGoOffline). Every `this.client` access is guarded by
    // `this.offline`, so the client simply never exists on this path.
    // Trailer mode (?trailer=1) is always a fully offline session: the
    // director stages "multiplayer" with local fake peers, never the network.
    if (isOfflineRequested() || new URLSearchParams(location.search).has("trailer")) {
      this.offline = true;
      this.sync.ensureSeeded();
    } else {
      // No `initialState`: the package re-applies it whenever a client becomes
      // host, which would wipe the live world on host migration. The first host
      // seeds explicitly (see `ensureSeeded`).
      this.client = new MultiplayerClient({
        host: MULTIPLAYER_HOST,
        maxPlayers: STARFALL_MAX_PLAYERS,
        onEvent: (event, payload, from) => this.net.handleEvent(event, payload, from),
        party: "vg-server",
        room: ROOM,
      });
      this.client.subscribe(() => this.sync.onUpdate());
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
    // sfx). The gesture itself unlocks audio.
    // M and Escape are keyboard-only, so without this cluster a phone player
    // gets a permanently silent run they cannot pause.
    this.touchControls = createTouchControls({
      mute: { get: () => sfx.muted, set: (next) => sfx.setMuted(next) },
    });
    this.input.keyboard?.on("keydown-M", () => {
      sfx.toggleMute();
      // a device can have both a keyboard and a screen
      this.touchControls.sync();
    });

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
    const pauseOverlay = createStarfallPauseOverlay();
    setPauseHandlers({
      onPause: () => {
        pauseOverlay.show();
        if (this.offline) {
          this.freezeSim();
        } else {
          this.pauseToSpectator();
        }
      },
      onResume: () => {
        pauseOverlay.hide();
        if (this.frozen) {
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
      // offline already destroyed it
      if (!this.offline) {
        this.client.destroy();
      }
    });

    installDevHooks(this);
  }

  /** Trailer director entry (?trailer=1): see trailer/trailer-stage.ts. */
  trailerStage(): TrailerStageApi {
    return installTrailerStage(this);
  }

  override update(time: number, delta: number): void {
    // clamp tab-switch spikes
    const dt = Math.min(delta, 100) / 1000;
    // poll the physical controller once per frame
    this.pad.update();
    // Any pad face button doubles as "press any key" on the start screen.
    if (!this.started && ["a", "b", "x", "y", "start"].some((b) => this.pad.justPressed(b))) {
      this.beginPlay();
    }
    this.starfield.update(dt, time);
    this.barrier.update(time, this.world.playW, this.world.playH);
    if (!this.offline) {
      this.maybeGoOffline();
    }
    // Start screen up: run the cosmetic dogfight backdrop behind the overlay.
    // It's purely additive — the live path below still runs (so the host keeps
    // the shared world ticking and real remote players still render/mix in).
    if (!this.started) {
      this.attract?.update(dt, this.time.now);
    }
    if (!this.live) {
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
    this.peerStates.clear();
    // A peer mid-drop (seat held in the reconnect grace) is absent, not a
    // frozen ghost for enemies and beams to target.
    for (const [id, player] of Object.entries(this.peers)) {
      this.peerStates.set(id, player.connected === false ? null : readNetState(player));
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
    if (this.amHost) {
      this.host.hostTick(now, dt, delta);
      // Never baseline the constructor's empty pre-connection world. Guests
      // instead observe accepted shared snapshots, not predicted removals.
      if (this.sync.shared() && (!this.offline || this.sync.offlineSeeded)) {
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
    if (this.weaponUntil !== 0 && now >= this.weaponUntil) {
      this.specialBase = null;
      this.weapon = baseWeaponForLevel(this.progress.level);
      this.weaponUntil = 0;
    }
    this.mastery.advance(now, this.alive, this.weapon.name);
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
    this.trailer?.frame?.();
    this.updateCamera(dt, time);
    this.syncScreenUi();
    this.hud.updateBattlePresentation(now);
    this.hud.updateHud(now);
    // after this frame's work, so bots never read stale state
    this.publishDiag();
  }

  /** Resize/rotation: re-read the safe-area insets and re-derive camera zoom. */
  private onViewportChange(): void {
    this.safeInset = safeAreaInset();
    // trailer scenes own zoom (per-shot framing)
    if (this.trailer) {
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
      if (!this.started) {
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
    if (this.started) {
      return;
    }
    this.started = true;
    // The sealed start overlay keeps its tap off the canvas, so this gesture is
    // the one that has to unlock WebAudio.
    sfx.unlock();
    // qa-020, offline solo ONLY: the sector clock (and the intensity curve)
    // starts at first input, not at boot — overlay-idle time was pure sector
    // loss, and a long idle met the rel-405 forced dreadnought at Lv1. Online
    // rooms keep the shared epoch untouched: the room clock predates you.
    if (this.offline) {
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
  forceOfflineSolo(): void {
    if (!this.offline) {
      this.offline = true;
      this.client.destroy();
      this.sync.ensureSeeded();
    }
    this.beginPlay();
  }

  /** Per-frame diagnostics for bot playtests (shared/diag.ts). One object
   *  mutated in place; primitives only. */
  private publishDiag(): void {
    diag.frame += 1;
    diag.score = this.progress.runXp;
    diag.player.x = this.shipX;
    diag.player.y = this.shipY;
    diag.player.speed = Math.hypot(this.shipVX, this.shipVY);
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
  frozen = false;

  private freezeSim(): void {
    if (this.frozen || !this.offline) {
      return;
    }
    this.frozen = true;
    pauseClock();
    sfx.setSuspended(true);
    // stops update() until wake()
    this.game.loop.sleep();
  }

  private unfreezeSim(): void {
    if (!this.frozen) {
      return;
    }
    this.frozen = false;
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
    if (this.paused) {
      return;
    }
    this.paused = true;
    // Clean despawn. Leaving alive=false + respawnAt=0 means tickRespawn can't
    // fire, and spawned=false hides my ship + gates every my-ship code path.
    this.spawned = false;
    this.alive = false;
    this.respawnAt = 0;
    this.weapons.beams = [];
    this.weapons.sentry = null;
    this.shield.impactArcs = [];
    this.progress.streak = 0;
    this.progress.comboTier = 1;
    // Immediate, so remotes drop my ship without a snapshot of lag.
    if (this.started && this.myId) {
      this.net.pushMyState(simNow());
    }
    sfx.setSuspended(true);
  }

  /** Wrapper resume → re-enter through the normal respawn flow (invuln + full
   *  shield + the level's base loadout via pickRespawnPoint), online or solo. */
  private resumeFromSpectator(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    sfx.setSuspended(false);
    // paused before play began: nothing to re-enter
    if (!this.started) {
      return;
    }
    // Route re-entry through tickRespawn: mark spawned (so ensureSpawned won't
    // also fire) but dead with an elapsed respawn timer. Next update() re-spawns
    // me once, with invuln — never a double ship.
    this.spawned = true;
    this.alive = false;
    this.respawnAt = simNow();
  }

  private ensureSpawned(): void {
    if (!this.started || this.paused || this.spawned || !this.myId) {
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
    this.shipX = pos.x;
    this.shipY = pos.y;
    this.spawned = true;
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
    if (this.openingRocksSeeded || !this.spawned) {
      return;
    }
    if (!this.offline && !this.amHost) {
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
      const x = PhaserMath.Clamp(this.shipX + Math.cos(ang) * dist, 40, this.world.playW - 40);
      const y = PhaserMath.Clamp(this.shipY + Math.sin(ang) * dist, 40, this.world.playH - 40);
      this.world.asteroids.push(spawnOpeningAsteroid(x, y));
    }
    this.openingRocksSeeded = true;
    this.host.dirty.asteroids = true;
  }

  private tickRespawn(now: number): void {
    if (this.alive || this.respawnAt === 0 || now < this.respawnAt) {
      return;
    }
    const pos = this.pickRespawnPoint();
    this.shipX = pos.x;
    this.shipY = pos.y;
    this.shipVX = 0;
    this.shipVY = 0;
    this.alive = true;
    this.respawnAt = 0;
    this.invulnUntil = now + INVULNERABLE_MS;
    // respawn at full (§A.1)
    this.shield.shieldHp = SHIELD_MAX;
    this.shield.overHp = 0;
    this.shield.lastDamageAt = 0;
    this.shield.regenActive = false;
    this.weaponUntil = 0;
    // revive at the level's base weapon + regen
    this.progress.applyBaseLoadout(now);
    this.kickX = 0;
    this.kickY = 0;
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
    if (!this.alive || !this.spawned) {
      return;
    }
    // NITRO deliberately breaks the "every projectile outruns the ship" floor.
    const nitro = this.boosts.has("nitro");
    const accel = SHIP_ACCEL * (nitro ? NITRO_ACCEL_MULT : 1);
    const maxSpeed = SHIP_MAX_SPEED * (nitro ? NITRO_MAX_SPEED_MULT : 1);
    let drag = SHIP_BRAKE_DRAG;
    this.thrust = 0;
    const steer = this.steerVector();
    if (steer) {
      if (steer.aim) {
        this.shipAngle = steer.angle;
      }
      this.thrust = steer.thrust;
      if (this.thrust > 0) {
        this.shipVX += Math.cos(steer.angle) * accel * this.thrust * dt;
        this.shipVY += Math.sin(steer.angle) * accel * this.thrust * dt;
      }
      drag = steer.dist > steer.deadZone ? SHIP_DRAG : SHIP_BRAKE_DRAG;
    }
    const decay = Math.exp(-drag * dt);
    this.shipVX *= decay;
    this.shipVY *= decay;
    const speed = Math.hypot(this.shipVX, this.shipVY);
    if (speed > maxSpeed) {
      const k = maxSpeed / speed;
      this.shipVX *= k;
      this.shipVY *= k;
    }
    this.shipX += this.shipVX * dt;
    this.shipY += this.shipVY * dt;
    // Wall clamp kills the perpendicular component: slide along edges.
    if (this.shipX < 0 || this.shipX > this.world.playW) {
      this.shipX = PhaserMath.Clamp(this.shipX, 0, this.world.playW);
      this.shipVX = 0;
    }
    if (this.shipY < 0 || this.shipY > this.world.playH) {
      this.shipY = PhaserMath.Clamp(this.shipY, 0, this.world.playH);
      this.shipVY = 0;
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
    const { trailer } = this;
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
    const dx = cursor.x - this.shipX;
    const dy = cursor.y - this.shipY;
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
  isFiring(): boolean {
    // trailer: scripted trigger only
    if (this.trailer) {
      return this.trailer.fire;
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

  myTint(): number {
    const { myId } = this;
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
    const lock = this.trailer?.camPos ?? null;
    if (!this.spawned && !lock) {
      return;
    }
    if (REDUCED_MOTION.matches) {
      this.kickX = 0;
      this.kickY = 0;
      this.trauma.reset();
      this.tweens.killTweensOf(this.flashRect);
      this.flashRect.setAlpha(0);
      this.cameras.main.centerOn(lock ? lock.x : this.shipX, lock ? lock.y : this.shipY);
      this.cameras.main.setAngle(0);
      this.camRollDeg = 0;
      return;
    }
    const decay = Math.exp(-8 * dt);
    this.kickX *= decay;
    this.kickY *= decay;
    const s = this.trauma.update(dt, timeMs / 1000);
    const cx = lock ? lock.x : this.shipX + this.kickX;
    const cy = lock ? lock.y : this.shipY + this.kickY;
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
    for (const obj of [this.minimapGfx, this.flashRect, this.barrier.vignette]) {
      obj
        .setPosition(x, y)
        .setRotation(-rot)
        .setScale(1 / zoom);
    }
  }
}
