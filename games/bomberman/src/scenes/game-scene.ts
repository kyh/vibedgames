import {
  createTouchControls,
  isOfflineRequested,
  notifyGameStarted,
  watchControlContext,
} from "@repo/embed";
import type { TouchControls } from "@repo/embed";
import { PhysicalGamepad, attachVirtualGamepad, stickDirection4 } from "@vibedgames/gamepad/phaser";
import type { PhaserGamepad } from "@vibedgames/gamepad/phaser";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { Player } from "@vibedgames/multiplayer";
import Phaser from "phaser";
import { createArena, readArena, type Arena } from "../shared/arena";
import { BattleFx } from "../fx/battle-fx";
import { CharacterAction, VICTORY_ACTION_MS } from "../render/character-action";
import { blastFrame, fireCells, freshCue } from "../render/blast-frame";
import { RoundHud } from "../render/round-hud";
import {
  audioDiagnostics,
  isMuted,
  resetRoundAudio,
  setMuted,
  sfx,
  unlockAudio,
  updateRoundScore,
} from "../fx/sfx";

import {
  baseStats,
  BASE_MOVE_MS,
  BOT_BOMB_CHANCE,
  BOT_MOVE_MS,
  COLORS,
  EXPLOSION_MS,
  FUSE_MS,
  GRID_COLS,
  GRID_ROWS,
  MAX_BOMBS,
  MAX_BOTS,
  MAX_RANGE,
  MIN_MOVE_MS,
  POWERUP_DROP_CHANCE,
  SPAWN_POINTS,
  SPEED_STEP_MS,
  OFFLINE_FALLBACK_MS,
  TARGET_FIGHTERS,
  TILE,
  tileKey,
  WORLD_H,
  WORLD_W,
  type Bomb,
  type Bot,
  type Cell,
  type Dir,
  type PlayerStats,
  type PowerupKind,
  type SharedState,
} from "../shared/constants";
import { buildControls, ensureStyle as ensureControlsStyle } from "../pause-overlay";
import {
  adoptClock,
  clockStamp,
  now as simNow,
  pauseClock,
  readClock,
  resumeClock,
} from "../util/clock";

declare global {
  interface Window {
    /** Dev-console hook (DEV builds only). */
    __bb?: {
      scene: GameScene;
      client: MultiplayerClient | undefined;
      audio: typeof audioDiagnostics;
    };
  }
}

type PlayerObjs = {
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Sprite;
  ring: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  marker: Phaser.GameObjects.Triangle | null;
  col: number;
  row: number;
  dir: Dir;
  moving: boolean;
  action: CharacterAction;
  actionFrame: string | null;
};

type BombObjs = {
  sprite: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
  fuse: Phaser.GameObjects.Graphics;
};

type BlastObjs = {
  fire: Phaser.GameObjects.Image;
  footprint: Phaser.GameObjects.Image;
  placedAt: number;
};

type RoundPresentation =
  | { kind: "hidden" }
  | { kind: "eliminated"; remaining: number }
  | { kind: "won" | "lost" | "draw"; winner: string };

/** A unified view over humans (connections) and bots for rendering + rules. */
type Fighter = {
  id: string;
  col: number;
  row: number;
  colorIdx: number;
  dir: Dir;
  moving: boolean;
  isBot: boolean;
  isLocal: boolean;
  order: number;
};

const DIR_VECT = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
} satisfies Record<Dir, [number, number]>;
const DIRS: Dir[] = ["up", "down", "left", "right"];
const PAD_START_BUTTONS = ["a", "b", "x", "y", "start"];

const POWERUP_KINDS: PowerupKind[] = ["bomb", "fire", "speed"];
const POWERUP_TEX = {
  bomb: "pow-bomb",
  fire: "pow-fire",
  speed: "pow-speed",
} satisfies Record<PowerupKind, string>;
const POWERUP_GLOW = {
  bomb: 0xffe14a,
  fire: 0xff7a2a,
  speed: 0x5db8ff,
} satisfies Record<PowerupKind, number>;

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://vibedgames-party.kyh.workers.dev";

const ROOM = "bomberman-default";
const BOMB_BUTTON_INSET = 84;
const BOMB_BUTTON_RADIUS = 52;

/** Detected at boot (not on first touch) so the first HUD paint already shows
 *  touch-worded hints on phones. */
export const TOUCH_UI = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;

/** Grass extends this far past the arena so the follow camera never shows void. */
const FLOOR_PAD = TILE * 20;

function emptyShared(arena: Arena = "classic"): SharedState {
  // Every resettable field MUST be present — patches shallow-merge, so an
  // omitted key carries over from the previous round.
  return {
    arena,
    grid: createArena(arena),
    bombs: {},
    blasts: {},
    powerups: {},
    bots: {},
    stats: {},
    deaths: {},
    winner: null,
    startedAt: simNow(),
  };
}

/** JSON value as it comes off the wire — multiplayer payloads are JSON.parse output. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
/** One field of a wire JSON dictionary — unvalidated until narrowed. */
type WireField = NonNullable<Player["state"]>[string] | undefined;

// Wire-JSON narrowing helpers. Runtime `typeof` is banned by the lint, so these
// use typeof-free checks; JSON can only carry finite numbers, so Number.isFinite
// is the exact number test.
const isJsonObject = (v: WireField): v is JsonObject =>
  Object.prototype.toString.call(v) === "[object Object]";
const isJsonNumber = (v: WireField): v is number => Number.isFinite(v);

function isShared(v: MultiplayerClient["sharedState"]): v is SharedState {
  return isJsonObject(v) && Array.isArray(v["grid"]);
}

type PartialPS = { col?: number; row?: number; colorIdx?: number; dir?: Dir; moving?: boolean };

function readPlayerState(player: Player | undefined): PartialPS {
  const s = player?.state;
  if (!s) return {};
  const num = (k: string): number | undefined => {
    const v = s[k];
    return isJsonNumber(v) ? v : undefined;
  };
  const dv = s["dir"];
  const dir: Dir | undefined =
    dv === "up" || dv === "down" || dv === "left" || dv === "right" ? dv : undefined;
  const mv = s["moving"];
  return {
    col: num("col"),
    row: num("row"),
    colorIdx: num("colorIdx"),
    dir,
    moving: mv === true || mv === false ? mv : undefined,
  };
}

export class GameScene extends Phaser.Scene {
  private client!: MultiplayerClient;

  private tileObjs: Array<Array<Phaser.GameObjects.Container | null>> = [];
  private tileKind: Array<Array<Cell["kind"] | null>> = [];
  private bombSprites = new Map<string, BombObjs>();
  private blastSprites = new Map<string, BlastObjs>();
  private blastSeen = new Set<string>();
  private powerupObjs = new Map<string, Phaser.GameObjects.Container>();
  private players = new Map<string, PlayerObjs>();
  private deathSeen = new Set<string>();
  private winnerAction: { id: string; at: number } | null = null;
  private characterTime = 0;
  private followStarted = false;

  private myCol = 0;
  private myRow = 0;
  private myDir: Dir = "down";
  private moving = false;
  private moveCooldown = 0;
  private lastMoveAt = 0;
  private hostTickAcc = 0;
  private localBombSeq = 1;
  private queuedDir: Dir | null = null;
  /** Arrow + WASD key pairs per direction — either key held keeps you moving. */
  private heldKeys!: Record<Dir, [Phaser.Input.Keyboard.Key, Phaser.Input.Keyboard.Key]>;
  /** Touch controls: a floating move-joystick (snapped to 4 directions) plus a
   *  fixed bomb button. Inert until the first finger lands. */
  private gamepad!: PhaserGamepad;
  /** Physical controller: stick/d-pad move, A bombs, START restarts. */
  private readonly pad = new PhysicalGamepad();
  /** False from the pad press that starts/resumes play until every pad input
   *  is released, so that one press cannot also bomb, restart or step. */
  private padArmed = true;
  /** Touch pause/mute cluster. */
  private touchControls: TouchControls | null = null;
  private unwatchControls: (() => void) | null = null;
  /** When we entered a restartable state (dead or round over); null while
   *  fighting. Gates tap-to-restart — see bindInput. */
  private restartableSince: number | null = null;

  private statusEl: HTMLElement | null = null;
  private readonly roundHud = new RoundHud();
  private statsEl: HTMLElement | null = null;
  private bannerEl: HTMLElement | null = null;
  private startEl: HTMLElement | null = null;
  private pickupNoteEl: HTMLElement | null = null;
  private restartButton: HTMLButtonElement | null = null;
  private observedWinner: string | null = null;
  /** False until the player dismisses the start screen. Gates spawning so the
   *  player isn't dropped into a live arena while still reading the controls;
   *  bots and the host seed keep running behind the overlay. */
  private started = false;
  // Last strings written to each HUD element, to skip redundant DOM writes.
  private lastStatus: string | null = null;
  private lastStats: string | null = null;
  private lastBanner: string | null = null;

  /** Net/shared state changed since the last render sync — see update(). */
  private netDirty = true;
  /** True while this client's sim clock is the one the room follows. */
  private clockAuthority = false;
  private simulationFrozen = false;

  /** One reusable spark emitter for every burst() (created in create()). */
  private sparkEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private battleFx: BattleFx | null = null;
  private presentationRound: number | null = null;
  private feedbackEnabled = false;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private pickupUntil = 0;
  private frame = 0;
  /** Living fighters as of the last render sync — drives the score bed. */
  private aliveCount = 0;
  private controlsPaused = false;

  /** The wrapper pause owns local input; a connected host keeps the other
   *  fighters running. The embed key gate swallows keyup while paused, so
   *  held keys would otherwise stick down. */
  setPresentationPaused(paused: boolean): void {
    if (this.controlsPaused === paused) return;
    this.controlsPaused = paused;
    if (paused) this.roundHud.update(simNow(), false);
    this.queuedDir = null;
    this.input.keyboard?.resetKeys();
    this.gamepad.pad.reset();
    this.padArmed = false;
  }

  // Solo fallback: if the party server can't be reached, this client becomes
  // its own host over the same code paths — events loop back, shared state
  // lives locally, and the bots make it a real match (you vs 3 bots).
  private offline = false;
  private everConnected = false;
  /** Stamped on the first update() tick (not create()) — see maybeGoOffline. */
  private bootedAt = 0;
  private offlineShared: SharedState | null = null;
  private offlineMyState: JsonObject = {};

  /** Connected to the room, or running the solo offline fallback. */
  private get live(): boolean {
    return this.offline || this.client.connectionStatus === "connected";
  }

  /**
   * True when freezing the sim is safe: solo-offline, or connected but the only
   * human in the room. False when other humans share the arena — freezing a
   * wall-clock sim would stall them. Mirrors the `soloArena` gate in update();
   * read by the wrapper pause handler in main.ts.
   */
  get freezable(): boolean {
    return Object.keys(this.peers).length <= 1;
  }

  private get amHost(): boolean {
    return this.offline || (this.client.connectionStatus === "connected" && this.client.isHost);
  }

  /** Freeze a solo simulation. The paused stamp goes out before the loop
   *  sleeps so a later joiner (or a promoted host) inherits the same sim time. */
  pauseSimulation(): void {
    if (!this.freezable || this.simulationFrozen) return;
    pauseClock();
    this.simulationFrozen = true;
    this.netPatchShared({});
    this.game.loop.sleep();
  }

  resumeSimulation(): void {
    if (!this.simulationFrozen) return;
    this.simulationFrozen = false;
    resumeClock();
    this.netPatchShared({});
    this.game.loop.wake();
  }

  /** Runs on every room change — the socket stays live while Phaser sleeps.
   *  Guests follow the host's stamp; a promoted host inherits it once, then
   *  every patch it sends carries its own. */
  private syncSharedClock(): void {
    if (this.offline) return;
    if (this.client.connectionStatus !== "connected") {
      this.clockAuthority = false;
      return;
    }
    const host = this.client.isHost;
    const state = this.client.sharedState;
    if (isShared(state) && (!host || !this.clockAuthority)) {
      adoptClock(readClock(state.clock));
      if (this.simulationFrozen) pauseClock();
      else if (host) resumeClock();
    }
    this.clockAuthority = host;
    if (this.simulationFrozen && !this.freezable) {
      // Another human arrived mid-pause: our overlay stays up, but their round must run.
      this.simulationFrozen = false;
      resumeClock();
      this.game.loop.wake();
    }
  }

  private get myId(): string | null {
    return this.offline ? "solo" : this.client.playerId;
  }

  private get peers(): typeof this.client.players {
    return this.offline
      ? { solo: { id: "solo", state: this.offlineMyState } }
      : this.client.players;
  }

  /** Events loop straight back into the local host when offline. */
  private netSendEvent(event: string, payload: JsonObject): void {
    if (this.offline) this.handleEvent(event, payload, "solo");
    else this.client.sendEvent(event, payload);
  }

  /** Per-player state shallow-merges, mirroring the package's semantics. */
  private netUpdateMyState(patch: JsonObject): void {
    this.netDirty = true;
    if (this.offline) Object.assign(this.offlineMyState, patch);
    else this.client.updateMyState(patch);
  }

  /** Shared-state patches shallow-merge, mirroring the package's semantics. */
  private netPatchShared(patch: Partial<SharedState>): void {
    this.netDirty = true;
    if (this.offline) {
      if (this.offlineShared) {
        this.offlineShared = { ...this.offlineShared, ...patch, clock: clockStamp() };
      }
    } else {
      if (this.amHost) this.client.updateSharedState({ ...patch, clock: clockStamp() });
    }
  }

  /** Poll once per frame: drives the solo-fallback grace window. */
  private maybeGoOffline(): void {
    // Start the grace window on the FIRST update() tick, not at create():
    // counting load time against the deadline would wrongly drop a slow-booting
    // client to solo before its socket ever got a chance to connect.
    if (this.bootedAt === 0) this.bootedAt = Date.now();
    if (this.client.connectionStatus === "connected") {
      this.everConnected = true;
      return;
    }
    // Once we've been in a room, a drop is transient — let the socket
    // reconnect instead of permanently stranding the player in solo.
    if (this.everConnected) return;
    // Pre-connect errors/closes are NOT instant failures: the socket retries
    // by itself, so the deadline is the only fallback trigger.
    if (Date.now() - this.bootedAt < OFFLINE_FALLBACK_MS) return;
    this.offline = true;
    this.netDirty = true; // no subscribe() offline — kick the first onUpdate
    this.client.destroy(); // stop reconnect attempts; refresh to go online
  }

  constructor() {
    super("Game");
  }

  create(): void {
    this.statusEl = document.getElementById("status");
    this.statsEl = document.getElementById("stats");
    this.bannerEl = document.getElementById("banner");
    this.pickupNoteEl = document.getElementById("pickup-note");
    const restart = document.getElementById("round-restart");
    this.restartButton = restart instanceof HTMLButtonElement ? restart : null;
    this.buildStartScreen();
    this.restartButton?.addEventListener("click", () => this.requestRestart());
    // Taps on the result card must not double as tap-to-restart on the canvas,
    // and Space/Enter activating its button must not also drop a bomb.
    for (const type of ["pointerdown", "pointerup"])
      this.bannerEl?.addEventListener(type, (event) => event.stopPropagation());
    for (const type of ["keydown", "keyup"])
      this.bannerEl?.addEventListener(type, (event) => {
        if (event instanceof KeyboardEvent && (event.key === " " || event.key === "Enter"))
          event.stopPropagation();
      });

    // The garden stays beyond the arena; quiet stone paving makes traversable
    // cells and warm destructible crates read clearly inside its boundary.
    this.add
      .tileSprite(-FLOOR_PAD, -FLOOR_PAD, WORLD_W + FLOOR_PAD * 2, WORLD_H + FLOOR_PAD * 2, "grass")
      .setOrigin(0, 0)
      .setTint(0x778774)
      .setDepth(-13);
    this.add
      .graphics()
      .fillStyle(0x111b1b, 0.35)
      .fillRoundedRect(-8, -4, WORLD_W + 22, WORLD_H + 22, 12)
      .fillStyle(0x3c4840)
      .fillRoundedRect(-6, -6, WORLD_W + 12, WORLD_H + 12, 8)
      .lineStyle(2, 0xa39766, 0.6)
      .strokeRoundedRect(-5, -5, WORLD_W + 10, WORLD_H + 10, 7)
      .setDepth(-12);
    this.add.tileSprite(0, 0, WORLD_W, WORLD_H, "floor").setOrigin(0, 0).setDepth(-10);

    const cam = this.cameras.main;
    cam.setBackgroundColor("#0e1020");
    cam.roundPixels = true;
    this.applyZoom();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.applyZoom, this);

    // One spark emitter shared by every burst() (crates, deaths, pickups):
    // re-tinted and exploded in place instead of allocating one per call.
    this.sparkEmitter = this.add
      .particles(0, 0, "spark", {
        speed: { min: 40, max: 190 },
        angle: { min: 0, max: 360 },
        lifespan: { min: 280, max: 560 },
        scale: { start: 1.1, end: 0 },
        alpha: { start: 1, end: 0 },
        blendMode: Phaser.BlendModes.ADD,
        emitting: false,
        maxAliveParticles: 192,
      })
      .setDepth(40)
      .reserve(192);
    this.battleFx = new BattleFx(this);

    // Explicit offline boot (?offline=1): never dial the party server. A
    // failed WebSocket handshake logs a browser console error the page cannot
    // suppress, so an offline-by-intent run (bot playtest, deliberate solo)
    // must skip the socket entirely rather than lean on the failure fallback
    // (maybeGoOffline), which would also hold the round behind `live` for the
    // whole grace window. Every `this.client` access is guarded by
    // `this.offline`, so the client simply never exists on this path.
    if (isOfflineRequested()) {
      this.offline = true;
      this.netDirty = true; // no subscribe() offline — kick the first onUpdate
      this.ensureSeeded();
    } else {
      // No `initialState`: the package re-applies it whenever a client becomes
      // host, which would wipe a live round on host migration. Instead the first
      // host seeds the world explicitly (see `ensureSeeded`) — a promoted guest
      // already has the shared state and won't reset it.
      this.client = new MultiplayerClient({
        host: MULTIPLAYER_HOST,
        party: "vg-server",
        room: ROOM,
        onEvent: (event, payload, from) => {
          // SAFETY: wire payloads are JSON.parse output (or loop back from
          // netSendEvent's JsonObject), so they are JSON values by construction.
          this.handleEvent(event, payload as JsonValue, from);
        },
      });
      this.client.subscribe(() => {
        this.syncSharedClock();
        this.netDirty = true;
      });
    }

    this.bindInput();

    this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.applyZoom, this);
      this.gamepad.destroy();
      this.touchControls?.destroy();
      if (!this.offline) this.client.destroy(); // offline already destroyed it
    });

    if (import.meta.env.DEV) {
      Object.assign(window, {
        __bb: { scene: this, client: this.client, audio: audioDiagnostics },
      });
    }
    // Small, real seams for plugins/tooling/skills/playtest. Scenario setup
    // uses the DEV scene handle; shared online rounds cannot be frozen here.
    if (import.meta.env.DEV || new URLSearchParams(location.search).get("test") === "1") {
      Object.assign(window, {
        __GAME_TEST_HOOKS__: {
          setState: (name: string) => {
            if (name !== "active-play") throw new Error(`Unknown Bomberman state: ${name}`);
            this.beginPlay();
          },
          setReducedMotion: (enabled: boolean) => {
            this.reducedMotion = enabled;
            this.battleFx?.clear();
          },
          setPausedForScreenshot: (paused: boolean) => {
            if (!this.freezable) throw new Error("Cannot freeze a shared arena");
            if (paused) {
              this.pauseSimulation();
            } else {
              this.resumeSimulation();
            }
          },
        },
      });
    }
  }

  private applyZoom(): void {
    // Keep ~9.5 board rows AND ~7.5 columns on screen — whichever needs the
    // wider FOV wins, so portrait phones aren't blind to bombs whose blast
    // (up to MAX_RANGE tiles) would land from off-screen. Clamped for
    // tiny/huge screens.
    const zoom = Phaser.Math.Clamp(
      Math.min(this.scale.height / (9.5 * TILE), this.scale.width / (7.5 * TILE)),
      0.6,
      2.4,
    );
    this.cameras.main.setZoom(zoom);
  }

  override update(_time: number, delta: number): void {
    this.frame += 1;
    if (!this.offline) this.maybeGoOffline();
    // subscribe() (online) and the net* writers (offline) mark the scene
    // dirty; run the render sync at most once per frame, and only when
    // something actually changed. Runs even while connecting so the HUD
    // shows the connection status.
    if (this.netDirty) {
      this.netDirty = false;
      this.onUpdate();
    }
    this.updateBattleFeel(delta);
    const state = this.shared();
    Object.assign(window, {
      __GAME_DIAGNOSTICS__: {
        frame: this.frame,
        score: Object.keys(state?.deaths ?? {}).filter((id) => id !== this.myId).length,
        complete: state?.winner !== null && state?.winner !== undefined,
        player: { x: this.myCol * TILE, y: this.myRow * TILE },
        entities: this.bombSprites.size + this.blastSprites.size + this.players.size,
        bombs: Object.keys(state?.bombs ?? {}).length,
        blasts: Object.keys(state?.blasts ?? {}).length,
      },
    });
    // The pad polls outside the `live` gate: "press any pad button to start"
    // must work while still connecting, exactly like the keyboard listener.
    this.pad.update();
    if (
      !this.started &&
      !this.controlsPaused &&
      PAD_START_BUTTONS.some((button) => this.pad.justPressed(button))
    )
      this.beginPlay();
    if (
      !this.padArmed &&
      !this.pad.isButtonDown("a") &&
      !this.pad.isButtonDown("start") &&
      stickDirection4(this.pad.getStick()) === null &&
      DIRS.every((dir) => !this.pad.isButtonDown(dir))
    )
      this.padArmed = true;
    if (!this.live) return;
    this.gamepad.update(); // reconcile dropped touches + redraw the overlay
    if (this.started && this.padArmed && !this.controlsPaused) {
      if (this.pad.justPressed("a")) this.requestBomb();
      if (this.pad.justPressed("start")) this.requestRestart();
    }
    this.handleInput(delta);
    this.settleMoving();
    this.updateCamera();
    // Hold the world (bots, bombs, round end) while the start screen is up, or
    // the round can be decided against a player who is still reading. Only safe
    // when no other human is present: freezing a shared arena would stall them.
    // `offline` means "no server", not "solo" — a connected solo host still
    // needs the hold, so gate on the human count instead.
    const soloArena = Object.keys(this.peers).length <= 1;
    if (this.amHost && (this.started || !soloArena)) this.hostTick(delta);
  }

  /** Follow inside the courtyard, with one tile of garden framing its edges.
   * Clamp the zoomed view ourselves: Phaser's built-in bounds use the unzoomed
   * canvas. At low zoom, leave enough screen space for the fixed touch button.
   * Large viewports center the board on axes where it fits completely. */
  private updateCamera(): void {
    const id = this.myId;
    if (!id) return;
    const me = this.players.get(id);
    if (!me) return;
    const cam = this.cameras.main;
    const halfW = cam.width / (2 * cam.zoom);
    const halfH = cam.height / (2 * cam.zoom);
    // The nearest walkable cell is 1.5 tiles from the board edge. Keep its
    // character clear of the bomb button without changing the view's zoom.
    let margin = TILE;
    if (TOUCH_UI || this.gamepad.isTouch) {
      const button = this.gamepad.pad.getButtonLayout().find((item) => item.id === "bomb");
      if (button) {
        const inset = Math.max(cam.width - button.x, cam.height - button.y);
        margin = Math.max(TILE, (inset + button.radius + 16) / cam.zoom - TILE * 1.5);
      }
    }
    const cx =
      halfW * 2 >= WORLD_W + margin * 2
        ? WORLD_W / 2
        : Phaser.Math.Clamp(me.container.x, halfW - margin, WORLD_W + margin - halfW);
    const cy =
      halfH * 2 >= WORLD_H + margin * 2
        ? WORLD_H / 2
        : Phaser.Math.Clamp(me.container.y, halfH - margin, WORLD_H + margin - halfH);
    // Phaser zooms around the midpoint (scroll + half the CANVAS size), so
    // centring subtracts cam.width/2 — halfW/H above (the zoomed visible
    // extent) determine how much of the arena fits.
    const tx = cx - cam.width / 2;
    const ty = cy - cam.height / 2;
    if (!this.followStarted) {
      cam.setScroll(tx, ty);
      this.followStarted = true;
    } else {
      cam.setScroll(
        Phaser.Math.Linear(cam.scrollX, tx, 0.16),
        Phaser.Math.Linear(cam.scrollY, ty, 0.16),
      );
    }
  }

  // ---- input ---------------------------------------------------------------

  private bindInput(): void {
    // Mobile controls: a floating move-joystick anywhere on screen, plus a
    // fixed bomb button bottom-right, above the board. Tap-to-bomb fires on the
    // press edge. Attached before the keyboard guard so touch works even with
    // no keyboard present.
    this.gamepad = attachVirtualGamepad(this, {
      buttons: [
        {
          id: "bomb",
          label: "💣",
          position: ({ width, height, inset }) => ({
            x: width - BOMB_BUTTON_INSET - inset.right,
            y: height - BOMB_BUTTON_INSET - inset.bottom,
          }),
          radius: BOMB_BUTTON_RADIUS,
        },
      ],
      // Pre-show the bomb button on touch devices — an invisible button is
      // undiscoverable before the first touch.
      visible: "coarse",
      render: { depth: 1000, blendMode: Phaser.BlendModes.NORMAL },
      onButtonDown: (id) => {
        if (id === "bomb") this.requestBomb();
      },
    });

    // Touch path to restart (R has no on-screen equivalent): while dead or
    // after the round ends, any fresh tap restarts. The arming delay stops
    // frantic bomb-taps that land just as you die from resetting the round.
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      if (!p.wasTouch) return;
      if (this.restartableSince === null) return;
      if (simNow() - this.restartableSince < 600) return;
      this.requestRestart();
    });

    const k = this.input.keyboard;
    if (!k) return;
    k.on("keydown-SPACE", () => this.requestBomb());
    k.on("keydown-B", () => this.requestBomb());
    k.on("keydown-R", () => this.requestRestart());
    k.on("keydown-M", (event: KeyboardEvent) => {
      if (event.repeat) return;
      setMuted(!isMuted());
      this.touchControls?.sync();
      this.syncSoundButton();
    });

    const KEY_TO_DIR: Array<[string, Dir]> = [
      ["LEFT", "left"],
      ["A", "left"],
      ["RIGHT", "right"],
      ["D", "right"],
      ["UP", "up"],
      ["W", "up"],
      ["DOWN", "down"],
      ["S", "down"],
    ];
    for (const [code, dir] of KEY_TO_DIR) {
      k.on(`keydown-${code}`, () => {
        if (this.controlsPaused) return;
        this.queuedDir = dir;
      });
    }
    this.heldKeys = {
      left: [k.addKey("LEFT"), k.addKey("A")],
      right: [k.addKey("RIGHT"), k.addKey("D")],
      up: [k.addKey("UP"), k.addKey("W")],
      down: [k.addKey("DOWN"), k.addKey("S")],
    };
  }

  private handleInput(delta: number): void {
    if (this.controlsPaused) return;
    const id = this.myId;
    if (!this.started) return;
    if (!this.isAlive(id)) return;
    this.moveCooldown = Math.max(0, this.moveCooldown - delta);
    if (this.moveCooldown > 0) return;
    const dir = this.readDir();
    if (!dir) return;
    const [dc, dr] = DIR_VECT[dir];
    const nc = this.myCol + dc;
    const nr = this.myRow + dr;
    if (!this.passable(nc, nr)) return;
    this.myCol = nc;
    this.myRow = nr;
    this.myDir = dir;
    this.moving = true;
    this.moveCooldown = this.myStats().speed;
    this.lastMoveAt = this.time.now;
    this.netUpdateMyState({ col: nc, row: nr, dir, moving: true, colorIdx: this.myColorIdx() });
    this.tweenPlayer(id, nc, nr, this.moveCooldown);
  }

  /** Drop back to the idle pose shortly after the last successful step. */
  private settleMoving(): void {
    if (!this.moving) return;
    if (this.time.now - this.lastMoveAt < this.myStats().speed + 70) return;
    this.moving = false;
    if (this.myId) this.netUpdateMyState({ moving: false });
  }

  private readDir(): Dir | null {
    if (this.queuedDir) {
      const d = this.queuedDir;
      this.queuedDir = null;
      return d;
    }
    if (this.heldKeys) {
      if (this.heldKeys.left.some((key) => key.isDown)) return "left";
      if (this.heldKeys.right.some((key) => key.isDown)) return "right";
      if (this.heldKeys.up.some((key) => key.isDown)) return "up";
      if (this.heldKeys.down.some((key) => key.isDown)) return "down";
    }
    // Physical pad: d-pad first (exact), then the analog stick.
    if (this.pad.connected && this.padArmed) {
      if (this.pad.isButtonDown("left")) return "left";
      if (this.pad.isButtonDown("right")) return "right";
      if (this.pad.isButtonDown("up")) return "up";
      if (this.pad.isButtonDown("down")) return "down";
      const padDir = stickDirection4(this.pad.getStick());
      if (padDir) return padDir;
    }
    // Held touch stick, snapped to the grid's 4 directions.
    return stickDirection4(this.gamepad.getStick());
  }

  private requestBomb(): void {
    if (this.controlsPaused || !this.live) return;
    const id = this.myId;
    if (!this.started) return;
    if (!this.isAlive(id)) return;
    if (this.bombAt(this.myCol, this.myRow)) return;
    this.netSendEvent("place_bomb", {
      col: this.myCol,
      row: this.myRow,
      localId: this.localBombSeq++,
    });
  }

  private requestRestart(): void {
    if (this.controlsPaused || !this.live) return;
    if (!this.started) return;
    const state = this.shared();
    if (!state) return;
    // The accepted replacement snapshot owns respawn, including reconnects
    // that missed the request. Old requests cannot restart a newer round.
    this.netSendEvent("request_restart", { round: state.startedAt });
  }

  private respawnSelf(): void {
    const id = this.myId;
    if (!id) return;
    const idx = Object.keys(this.peers).indexOf(id);
    if (idx < 0) return;
    const spawn = SPAWN_POINTS[idx] ?? SPAWN_POINTS[0];
    this.myCol = spawn.col;
    this.myRow = spawn.row;
    this.myDir = "down";
    this.moving = false;
    // Snap our own container — the local player is never tweened by syncPlayers,
    // so without this the sprite would linger at its death spot after a restart.
    const objs = this.players.get(id);
    if (objs) {
      this.resetPlayerFeedback(objs);
      objs.dir = "down";
      objs.moving = false;
      this.applyAnim(objs, "down", false);
      this.tweens.killTweensOf(objs.container);
      objs.container.setPosition(colX(spawn.col), rowY(spawn.row));
      objs.col = spawn.col;
      objs.row = spawn.row;
    }
    this.netUpdateMyState({
      col: spawn.col,
      row: spawn.row,
      colorIdx: idx % COLORS.length,
      dir: "down",
      moving: false,
    });
  }

  // ---- connection callbacks ------------------------------------------------

  private handleEvent(event: string, payload: JsonValue, from: string): void {
    if (event === "pickup") {
      const host = this.offline ? "solo" : this.client.hostId;
      if (from !== host || !this.started || !isJsonObject(payload)) return;
      const col = payload["col"];
      const row = payload["row"];
      const kind = payload["kind"];
      if (
        !isJsonNumber(col) ||
        !isJsonNumber(row) ||
        !Number.isInteger(col) ||
        !Number.isInteger(row) ||
        col < 0 ||
        col >= GRID_COLS ||
        row < 0 ||
        row >= GRID_ROWS ||
        (kind !== "bomb" && kind !== "fire" && kind !== "speed") ||
        payload["round"] !== this.shared()?.startedAt
      )
        return;
      this.burst(colX(col), rowY(row), POWERUP_GLOW[kind], 14);
      if (payload["collector"] === this.myId) {
        sfx.pickup();
        this.pulsePlayer(this.myId, "pickup");
        this.statsEl?.setAttribute("data-pickup", kind);
        if (this.pickupNoteEl) {
          this.pickupNoteEl.textContent = `${kind.toUpperCase()} PICKUP`;
          this.pickupNoteEl.classList.add("on");
          this.pickupUntil = simNow() + 800;
        }
      }
      return;
    }
    if (!this.amHost) return;
    if (event === "place_bomb") {
      const p = isJsonObject(payload) ? payload : null;
      const col = p?.["col"];
      const row = p?.["row"];
      if (isJsonNumber(col) && isJsonNumber(row)) {
        this.hostPlaceBomb(from, col, row);
      }
    } else if (event === "request_restart") {
      const state = this.shared();
      if (!state || !isJsonObject(payload) || payload["round"] !== state.startedAt) return;
      const next = emptyShared(readArena(state.arena) === "classic" ? "crossroads" : "classic");
      // startedAt is the existing round identity. Two requests in one clock
      // millisecond must still produce distinct rounds, without new wire state.
      next.startedAt = Math.max(next.startedAt, state.startedAt + 1);
      this.writeShared(next);
    }
  }

  private onUpdate(): void {
    this.ensureSeeded();
    const round = this.shared()?.startedAt ?? null;
    const previousRound = this.presentationRound;
    const newRound = round !== this.presentationRound;
    this.feedbackEnabled = this.started && !newRound;
    if (newRound) {
      this.presentationRound = round;
      this.observedWinner = this.shared()?.winner ?? null;
      this.winnerAction = null;
      this.characterTime = 0;
      resetRoundAudio();
      for (const objs of this.players.values()) this.resetPlayerFeedback(objs);
      this.battleFx?.clear();
      this.blastSeen.clear();
      this.roundHud.reset();
      this.sparkEmitter?.killAll();
      this.clearPickupNote();
      // Initial joins keep their existing spawn policy. A later accepted round
      // replaces cached local coordinates exactly once, even after transport loss.
      if (round !== null && previousRound !== null && this.started) this.respawnSelf();
    }
    this.trackRestartable();
    this.setStatus(this.statusText());
    this.setStats();
    this.setBanner();
    // No body until the start screen is dismissed — bots and the host seed run
    // on behind the overlay, but the player isn't dropped in mid-read.
    if (this.started) this.ensureMySpawn();
    const fighters = this.fighters();
    this.aliveCount = fighters.filter((fighter) => this.isAlive(fighter.id)).length;
    this.syncRoster(fighters);
    this.syncGrid();
    this.syncBombs(fighters);
    this.syncBlasts();
    this.syncPowerups();
    this.syncPlayers(fighters);
  }

  private clearPickupNote(): void {
    this.pickupNoteEl?.classList.remove("on");
    this.pickupUntil = 0;
    this.statsEl?.removeAttribute("data-pickup");
  }

  /** Arm/disarm tap-to-restart as the death/round-over state changes. */
  private trackRestartable(): void {
    const s = this.shared();
    const restartable = this.live && s !== null && (s.winner !== null || !this.isAlive(this.myId));
    if (!restartable) this.restartableSince = null;
    else this.restartableSince ??= simNow();
  }

  // ---- shared-state rendering ----------------------------------------------

  private shared(): SharedState | null {
    if (this.offline) return this.offlineShared; // local state is authoritative solo
    return isShared(this.client.sharedState) ? this.client.sharedState : null;
  }

  /**
   * The first host to connect seeds the world. Guests adopt the host's
   * existing state; a guest promoted to host after a migration keeps the
   * live round instead of resetting it.
   */
  private ensureSeeded(): void {
    if (this.offline) {
      if (!this.offlineShared) this.offlineShared = emptyShared();
      return;
    }
    if (this.amHost && this.client.connectionStatus === "connected" && !this.shared()) {
      this.writeShared(emptyShared());
    }
  }

  /** Humans (connections) + bots (shared state), unified for rendering. */
  private fighters(): Fighter[] {
    const out: Fighter[] = [];
    const myId = this.myId;
    let order = 0;
    for (const [id, player] of Object.entries(this.peers)) {
      const ps = readPlayerState(player);
      const fb = SPAWN_POINTS[order] ?? SPAWN_POINTS[0];
      out.push({
        id,
        col: ps.col ?? fb.col,
        row: ps.row ?? fb.row,
        colorIdx: (ps.colorIdx ?? order) % COLORS.length,
        dir: ps.dir ?? "down",
        moving: ps.moving ?? false,
        isBot: false,
        isLocal: id === myId,
        order,
      });
      order++;
    }
    const s = this.shared();
    if (s) {
      for (const bot of Object.values(s.bots ?? {})) {
        out.push({
          id: bot.id,
          col: bot.col,
          row: bot.row,
          colorIdx: bot.colorIdx % COLORS.length,
          dir: bot.dir,
          moving: bot.moving,
          isBot: true,
          isLocal: false,
          order: -1,
        });
      }
    }
    return out;
  }

  private syncGrid(): void {
    const s = this.shared();
    if (!s) return;
    for (let r = 0; r < GRID_ROWS; r++) {
      const objRow = (this.tileObjs[r] ??= []);
      const kindRow = (this.tileKind[r] ??= []);
      for (let c = 0; c < GRID_COLS; c++) {
        const kind = s.grid[r]?.[c]?.kind ?? "empty";
        if (kindRow[c] === kind) continue;
        const prev = objRow[c];
        if (this.feedbackEnabled && kindRow[c] === "crate" && kind === "empty")
          this.crateBreak(c, r);
        if (prev) {
          prev.destroy();
          objRow[c] = null;
        }
        if (kind === "wall" || kind === "crate") {
          const shadow = this.add.image(2, 5, "prop-shadow").setDisplaySize(TILE, TILE * 0.93);
          const prop = this.add
            .image(0, -2, kind === "wall" ? "wall" : "crate")
            .setDisplaySize(TILE, TILE);
          objRow[c] = this.add.container(colX(c), rowY(r), [shadow, prop]).setDepth(1);
        }
        kindRow[c] = kind;
      }
    }
  }

  private syncBombs(fighters: readonly Fighter[]): void {
    const s = this.shared();
    if (!s) return;
    const seen = new Set<string>();
    for (const bomb of Object.values(s.bombs)) {
      seen.add(bomb.id);
      if (!this.bombSprites.has(bomb.id)) {
        const shadow = this.add
          .image(colX(bomb.col), rowY(bomb.row) + TILE * 0.32, "shadow")
          .setDisplaySize(TILE * 0.7, TILE * 0.27)
          .setDepth(2);
        const sprite = this.add
          .image(colX(bomb.col), rowY(bomb.row), "bomb")
          .setDisplaySize(TILE * 0.92, TILE * 0.92)
          .setDepth(6);
        const fuse = this.add.graphics().setPosition(colX(bomb.col), rowY(bomb.row)).setDepth(5);
        const fresh = this.feedbackEnabled && freshCue(bomb.placedAt, simNow());
        if (fresh) sfx.place(bomb.ownerId === this.myId);
        if (fresh && bomb.ownerId === this.myId) {
          this.pulsePlayer(bomb.ownerId, "place");
          this.roundHud.acceptedPlacement(simNow());
        }
        if (this.feedbackEnabled && this.isAlive(bomb.ownerId)) {
          const owner = fighters.find((fighter) => fighter.id === bomb.ownerId);
          if (owner)
            this.players.get(bomb.ownerId)?.action.place(bomb, simNow(), this.characterTime, owner);
        }
        this.bombSprites.set(bomb.id, { sprite, shadow, fuse });
      }
    }
    for (const [id, { sprite, shadow, fuse }] of this.bombSprites)
      if (!seen.has(id)) {
        this.tweens.killTweensOf(sprite);
        sprite.destroy();
        shadow.destroy();
        fuse.destroy();
        this.bombSprites.delete(id);
      }
  }

  private syncBlasts(): void {
    const s = this.shared();
    if (!s) return;
    const now = simNow();
    const blasts = Object.values(s.blasts);
    const seen = new Set(blasts.map((blast) => blast.id));
    const cells = fireCells(blasts, now);
    for (const [key, cell] of cells) {
      const existing = this.blastSprites.get(key);
      if (existing) {
        existing.placedAt = cell.placedAt;
        continue;
      }
      const footprint = this.add.image(colX(cell.col), rowY(cell.row), "blast-cell").setDepth(7);
      const fire = this.add
        .image(colX(cell.col), rowY(cell.row), "explosion", 0)
        .setDisplaySize(TILE * 1.35, TILE * 1.35)
        .setDepth(30)
        .setAngle(((cell.col * 3 + cell.row) % 4) * 90)
        .setTint(0xffe3ac)
        .setAlpha(0.8)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.blastSprites.set(key, { fire, footprint, placedAt: cell.placedAt });
    }
    for (const [key, visual] of this.blastSprites) {
      if (cells.has(key)) continue;
      visual.fire.destroy();
      visual.footprint.destroy();
      this.blastSprites.delete(key);
    }
    const cam = this.cameras.main;
    const centerX = cam.scrollX + cam.width / 2;
    const centerY = cam.scrollY + cam.height / 2;
    const local = this.myId ? this.players.get(this.myId)?.container : undefined;
    const listenerX = local?.x ?? centerX;
    const listenerY = local?.y ?? centerY;
    let nearest: { distance: number; x: number } | null = null;
    let newBlasts = 0;
    const impactTiles = new Map<string, { col: number; row: number }>();
    for (const blast of blasts) {
      if (this.blastSeen.has(blast.id)) continue;
      this.blastSeen.add(blast.id);
      if (this.feedbackEnabled && freshCue(blast.placedAt, now)) {
        newBlasts++;
        for (const tile of blast.tiles) {
          const x = colX(tile.col);
          const distance = Math.hypot(x - listenerX, rowY(tile.row) - listenerY);
          if (!nearest || distance < nearest.distance) nearest = { distance, x };
        }
        for (const tile of blast.tiles) impactTiles.set(tileKey(tile.col, tile.row), tile);
      }
    }
    if (newBlasts > 0) {
      const tiles = [...impactTiles.values()];
      this.battleFx?.blast(tiles, this.reducedMotion);
      this.shakeIfNear(tiles);
      const distance = nearest?.distance ?? 0;
      const strength = Math.max(0.2, 1 - (Math.max(0, distance / TILE - 2) / 8) * 0.8);
      const pan = Math.max(
        -1,
        Math.min(1, ((nearest?.x ?? centerX) - centerX) / (cam.width / (2 * cam.zoom))),
      );
      sfx.blast({ strength, pan });
    }
    for (const id of this.blastSeen) if (!seen.has(id)) this.blastSeen.delete(id);
    this.updateBlastFrames(now);
  }

  private updateBlastFrames(now: number): void {
    for (const { fire, footprint, placedAt } of this.blastSprites.values()) {
      const frame = blastFrame(placedAt, now);
      fire.setVisible(frame !== null);
      footprint.setVisible(frame !== null);
      if (frame !== null) fire.setFrame(frame);
    }
  }

  private syncPowerups(): void {
    const s = this.shared();
    if (!s) return;
    const seen = new Set<string>();
    for (const [key, pu] of Object.entries(s.powerups)) {
      seen.add(key);
      if (this.powerupObjs.has(key)) continue;
      const glow = this.add
        .image(0, 0, "glow")
        .setDisplaySize(TILE * 1.15, TILE * 1.15)
        .setTint(POWERUP_GLOW[pu.kind])
        .setBlendMode(Phaser.BlendModes.ADD);
      const icon = this.add
        .image(0, 0, POWERUP_TEX[pu.kind])
        .setDisplaySize(TILE * 0.7, TILE * 0.7);
      const shadow = this.add
        .image(0, TILE * 0.25, "shadow")
        .setDisplaySize(TILE * 0.6, TILE * 0.22);
      const container = this.add
        .container(colX(pu.col), rowY(pu.row), [shadow, glow, icon])
        .setDepth(4);
      if (!this.reducedMotion) {
        this.tweens.add({
          targets: icon,
          y: -6,
          duration: 760,
          ease: "Sine.InOut",
          yoyo: true,
          repeat: -1,
        });
        this.tweens.add({
          targets: glow,
          alpha: { from: 0.35, to: 0.65 },
          scaleX: { from: glow.scaleX * 0.92, to: glow.scaleX * 1.08 },
          scaleY: { from: glow.scaleY * 0.92, to: glow.scaleY * 1.08 },
          duration: 900,
          ease: "Sine.InOut",
          yoyo: true,
          repeat: -1,
        });
      }
      this.powerupObjs.set(key, container);
    }
    for (const [key, container] of this.powerupObjs)
      if (!seen.has(key)) {
        this.tweens.killTweensOf(container.list);
        container.destroy();
        this.powerupObjs.delete(key);
      }
  }

  private syncPlayers(fighters: readonly Fighter[]): void {
    const seen = new Set<string>();
    for (const f of fighters) {
      seen.add(f.id);
      const objs =
        this.players.get(f.id) ??
        this.createPlayer(f.id, f.col, f.row, f.colorIdx, f.isLocal, f.isBot);
      const dead = !this.isAlive(f.id);
      objs.dir = f.dir;
      objs.moving = f.moving;
      if (objs.col !== f.col || objs.row !== f.row) objs.action.interrupt();

      if (dead && !this.deathSeen.has(f.id)) {
        this.deathSeen.add(f.id);
        this.playDeath(objs);
        if (this.feedbackEnabled && f.isLocal) sfx.death();
      } else if (!dead && this.deathSeen.has(f.id)) {
        this.deathSeen.delete(f.id);
        this.reviveVisual(objs, f.col, f.row);
      }

      if (!dead) {
        const celebration = this.winnerAction;
        if (celebration?.id === f.id) {
          this.winnerAction = null;
          if (this.characterTime - celebration.at < VICTORY_ACTION_MS)
            objs.action.victory(celebration.at, f);
        }
        this.applyAnim(objs, f.dir, f.moving, f.col, f.row);
        // The local player is moved by input tweens; everyone else follows state.
        if (!f.isLocal && (objs.col !== f.col || objs.row !== f.row)) {
          this.tweenContainer(objs, f.col, f.row, f.isBot ? BOT_MOVE_MS : 150);
        }
      } else if (this.winnerAction?.id === f.id) this.winnerAction = null;
    }
    for (const [id, objs] of this.players)
      if (!seen.has(id)) {
        this.resetPlayerFeedback(objs);
        this.tweens.killTweensOf(objs.container);
        this.tweens.killTweensOf(objs.container.list);
        this.tweens.killTweensOf(objs.sprite);
        objs.container.destroy();
        this.players.delete(id);
        this.deathSeen.delete(id);
      }
  }

  private createPlayer(
    id: string,
    col: number,
    row: number,
    colorIdx: number,
    isMe: boolean,
    isBot: boolean,
  ): PlayerObjs {
    const tint = COLORS[colorIdx] ?? 0xffffff;

    const children: Phaser.GameObjects.GameObject[] = [];
    const shadow = this.add.image(0, TILE * 0.34, "shadow").setDisplaySize(TILE * 0.7, TILE * 0.34);
    const ring = this.add.graphics();
    ring
      .lineStyle(isMe ? 4 : 3, tint, isMe ? 1 : 0.85)
      .strokeEllipse(0, TILE * 0.34, TILE * 0.62, TILE * 0.3);
    const sprite = this.add
      .sprite(0, -TILE * 0.06, "player-down", 0)
      .setDisplaySize(TILE * 0.95, TILE * 0.95);
    const body = this.add.container(0, 0, [sprite]);
    const label = this.add
      .text(0, -TILE * 0.62, this.labelFor(id), {
        fontSize: "13px",
        color: isMe ? "#ffffff" : isBot ? "#ffd0d0" : "#dfe6ff",
        fontFamily: "ui-monospace, monospace",
        fontStyle: isMe ? "bold" : "normal",
        backgroundColor: "rgba(8,10,26,0.55)",
        padding: { left: 4, right: 4, top: 1, bottom: 1 },
      })
      .setOrigin(0.5, 1);
    children.push(shadow, ring, body, label);

    // Bright bobbing marker over the local player so you can pick yourself out
    // among identical bots.
    let marker: Phaser.GameObjects.Triangle | null = null;
    if (isMe) {
      marker = this.add
        .triangle(0, -TILE * 0.82, -9, -6, 9, -6, 0, 7, 0xffe14a)
        .setStrokeStyle(2, 0x1a1430, 1);
      if (!this.reducedMotion)
        this.tweens.add({
          targets: marker,
          y: -TILE * 0.92,
          duration: 520,
          ease: "Sine.InOut",
          yoyo: true,
          repeat: -1,
        });
      children.push(marker);
    }

    const container = this.add.container(colX(col), rowY(row), children).setDepth(10);
    const objs: PlayerObjs = {
      container,
      body,
      sprite,
      ring,
      label,
      marker,
      col,
      row,
      dir: "down",
      moving: false,
      action: new CharacterAction(),
      actionFrame: null,
    };
    this.players.set(id, objs);
    return objs;
  }

  private applyAnim(
    objs: PlayerObjs,
    dir: Dir,
    moving: boolean,
    col = objs.col,
    row = objs.row,
  ): void {
    const sprite = objs.sprite;
    const action = objs.action.sample(this.characterTime, { dir, moving, col, row }, true);
    if (action) {
      const frame = `${action.key}:${action.frame}:${action.flip}`;
      if (objs.actionFrame !== frame) {
        sprite.anims.stop();
        sprite.setTexture(action.key, action.frame).setScale(action.scale);
        sprite.setPosition(0, TILE * 0.34).setFlipX(action.flip);
        objs.actionFrame = frame;
      }
      return;
    }
    if (objs.actionFrame !== null) {
      // setTexture below restores the original 256px walk frame before sizing.
      objs.actionFrame = null;
      sprite.setTexture("player-down", 0).setOrigin(0.5);
      sprite.setPosition(0, -TILE * 0.06).setDisplaySize(TILE * 0.95, TILE * 0.95);
    }
    const tex = dir === "up" ? "player-up" : dir === "down" ? "player-down" : "player-side";
    sprite.setFlipX(dir === "left");
    if (moving) {
      const key = dir === "up" ? "walk-up" : dir === "down" ? "walk-down" : "walk-side";
      if (sprite.anims.currentAnim?.key !== key || !sprite.anims.isPlaying)
        sprite.anims.play(key, true);
    } else {
      sprite.anims.stop();
      sprite.setTexture(tex, 0);
    }
  }

  // ---- host-only logic -----------------------------------------------------

  private hostTick(delta: number): void {
    this.hostTickAcc += delta;
    if (this.hostTickAcc < 70) return;
    this.hostTickAcc = 0;
    const s = this.shared();
    if (!s) return;
    const now = simNow();

    const next: SharedState = {
      grid: s.grid,
      bombs: { ...s.bombs },
      blasts: { ...s.blasts },
      powerups: { ...s.powerups },
      bots: structuredCloneBots(s.bots ?? {}),
      stats: { ...s.stats },
      deaths: { ...s.deaths },
      winner: s.winner,
      startedAt: s.startedAt,
    };
    // Track which top-level fields changed so we only send those (bot moves
    // fire every tick — re-sending the 285-cell grid each time is wasteful).
    const d = {
      grid: false,
      bombs: false,
      blasts: false,
      powerups: false,
      bots: false,
      stats: false,
      deaths: false,
      winner: false,
    };

    this.reconcileBots(next, now, d);

    // Prune stats/deaths for fighters that no longer exist (departed humans or
    // removed bots) so the shared object can't grow unbounded over a session.
    const activeIds = new Set([...Object.keys(this.peers), ...Object.keys(next.bots)]);
    for (const id of Object.keys(next.stats))
      if (!activeIds.has(id)) {
        delete next.stats[id];
        d.stats = true;
      }
    for (const id of Object.keys(next.deaths))
      if (!activeIds.has(id)) {
        delete next.deaths[id];
        d.deaths = true;
      }

    // Detonate expired bombs, cascading through any bombs caught in a blast.
    const expired = Object.values(next.bombs).filter((b) => now - b.placedAt >= FUSE_MS);
    if (expired.length > 0) {
      const detonated = new Set<string>();
      const queue: Bomb[] = [...expired];
      const cratesToClear = new Map<string, { col: number; row: number }>();
      const newBlastTiles = new Set<string>();
      let bomb: Bomb | undefined;
      while ((bomb = queue.shift()) !== undefined) {
        if (detonated.has(bomb.id)) continue;
        detonated.add(bomb.id);
        const { tiles, crates } = computeBlastTiles(s.grid, bomb);
        for (const t of tiles) {
          newBlastTiles.add(tileKey(t.col, t.row));
          for (const other of Object.values(next.bombs)) {
            if (!detonated.has(other.id) && other.col === t.col && other.row === t.row)
              queue.push(other);
          }
        }
        for (const cr of crates) cratesToClear.set(tileKey(cr.col, cr.row), cr);
        next.blasts[`x-${bomb.id}`] = { id: `x-${bomb.id}`, tiles, placedAt: now };
      }
      for (const id of detonated) delete next.bombs[id];

      if (cratesToClear.size > 0) {
        const grid = s.grid.map((row) => row.slice());
        for (const cr of cratesToClear.values()) {
          const row = grid[cr.row];
          if (row) row[cr.col] = { kind: "empty" };
        }
        next.grid = grid;
        d.grid = true;
      }
      for (const key of Object.keys(next.powerups)) {
        if (newBlastTiles.has(key)) {
          delete next.powerups[key];
          d.powerups = true;
        }
      }
      for (const cr of cratesToClear.values()) {
        const key = tileKey(cr.col, cr.row);
        if (!next.powerups[key] && Math.random() < POWERUP_DROP_CHANCE) {
          next.powerups[key] = { col: cr.col, row: cr.row, kind: randomKind() };
          d.powerups = true;
        }
      }
      d.bombs = true;
      d.blasts = true;
    }

    // Expire spent blasts.
    for (const blast of Object.values(next.blasts)) {
      if (now - blast.placedAt >= EXPLOSION_MS) {
        delete next.blasts[blast.id];
        d.blasts = true;
      }
    }

    // Bot AI moves bots and may place bot bombs (into next.bombs).
    if (this.tickBots(next, now)) {
      d.bots = true;
      d.bombs = true;
    }

    // Positions of every living fighter (humans from connections, bots from
    // the freshly-moved bot records), for pickups + death.
    const livePos = this.fighterPositions(next);

    // Powerup pickups.
    for (const [fid, col, row] of livePos) {
      const key = tileKey(col, row);
      const pu = next.powerups[key];
      if (!pu) continue;
      next.stats[fid] = grantPowerup(next.stats[fid] ?? baseStats(), pu.kind);
      delete next.powerups[key];
      // Only the authoritative grant emits this beat. A blast deleting a
      // pickup produces no collection feedback, even at capped stats.
      this.netSendEvent("pickup", {
        col,
        row,
        kind: pu.kind,
        collector: fid,
        round: next.startedAt,
      });
      d.powerups = true;
      d.stats = true;
    }

    // Deaths from live blasts.
    const liveBlasts = Object.values(next.blasts);
    if (liveBlasts.length > 0) {
      for (const [fid, col, row] of livePos) {
        if (next.deaths[fid]) continue;
        if (liveBlasts.some((b) => b.tiles.some((t) => t.col === col && t.row === row))) {
          next.deaths[fid] = now;
          d.deaths = true;
        }
      }
    }

    // Last fighter standing wins (bots count — solo + bots still resolves).
    const fighterIds = [...Object.keys(this.peers), ...Object.keys(next.bots)];
    if (fighterIds.length >= 2 && !next.winner) {
      const alive = fighterIds.filter((id) => !next.deaths[id]);
      const [sole] = alive;
      if (alive.length === 1 && sole) {
        next.winner = sole;
        d.winner = true;
      } else if (alive.length === 0) {
        next.winner = "draw";
        d.winner = true;
      }
    }

    const patch: Partial<SharedState> = {};
    if (d.grid) patch.grid = next.grid;
    if (d.bombs) patch.bombs = next.bombs;
    if (d.blasts) patch.blasts = next.blasts;
    if (d.powerups) patch.powerups = next.powerups;
    if (d.bots) patch.bots = next.bots;
    if (d.stats) patch.stats = next.stats;
    if (d.deaths) patch.deaths = next.deaths;
    if (d.winner) patch.winner = next.winner;
    if (Object.keys(patch).length > 0) this.netPatchShared(patch);
  }

  /**
   * Keep bots filling the spawn corners humans don't occupy, up to
   * TARGET_FIGHTERS total. Humans take corners 0..n-1 (by join order), bots
   * take the rest. Bots are keyed by corner so join/leave stays stable.
   */
  private reconcileBots(
    next: SharedState,
    now: number,
    d: { bots: boolean; stats: boolean },
  ): void {
    const humanCount = Object.keys(this.peers).length;
    const want = new Set<number>();
    for (
      let c = humanCount;
      c <= 3 && c - humanCount < MAX_BOTS && want.size < TARGET_FIGHTERS - humanCount;
      c++
    ) {
      want.add(c);
    }
    for (const id of Object.keys(next.bots)) {
      const corner = Number(id.slice(4));
      if (!want.has(corner)) {
        // Its stats/deaths get swept by the catch-all prune in hostTick.
        delete next.bots[id];
        d.bots = true;
      }
    }
    for (const corner of want) {
      const id = `bot-${corner}`;
      if (!next.bots[id]) {
        const spawn = SPAWN_POINTS[corner] ?? SPAWN_POINTS[0];
        next.bots[id] = {
          id,
          col: spawn.col,
          row: spawn.row,
          dir: "down",
          colorIdx: corner % COLORS.length,
          moving: false,
          nextMoveAt: now + 700,
        };
        next.stats[id] = baseStats();
        d.bots = true;
        d.stats = true;
      }
    }
  }

  /** Returns true if any bot moved or placed a bomb. */
  private tickBots(next: SharedState, now: number): boolean {
    const bots = Object.values(next.bots);
    if (bots.length === 0) return false;
    let changed = false;
    const danger = dangerSet(next);
    const enemies = this.fighterPositions(next); // [id,col,row] of living fighters

    for (const bot of bots) {
      if (next.deaths[bot.id]) {
        if (bot.moving) {
          bot.moving = false;
          changed = true;
        }
        continue;
      }
      if (now < bot.nextMoveAt) continue;
      const stats = next.stats[bot.id] ?? baseStats();
      const bombs = Object.values(next.bombs);
      const opts = botNeighbors(next, bot.col, bot.row);
      const inDanger = danger.has(tileKey(bot.col, bot.row));

      if (inDanger) {
        // Step toward the nearest safe tile (BFS) — a single safe neighbour
        // often doesn't exist next to one's own bomb, but a 2-3 step path does.
        const dir = fleeDir(next.grid, bombs, bot.col, bot.row, danger);
        moveBot(bot, dir ? neighborOf(bot.col, bot.row, dir) : null, now);
        changed = true;
        continue;
      }

      // Offense: bomb a crate or a fighter in line, but only if a flee path out
      // of the resulting blast exists (don't bomb yourself into a dead end).
      const activeBombs = bombs.filter((b) => b.ownerId === bot.id).length;
      if (
        activeBombs < stats.bombs &&
        (adjacentCrate(next.grid, bot.col, bot.row) ||
          enemyInLine(next.grid, bot, stats.range, enemies))
      ) {
        const blastKeys = new Set(
          computeBlastTiles(next.grid, {
            id: "",
            ownerId: bot.id,
            col: bot.col,
            row: bot.row,
            placedAt: now,
            range: stats.range,
          }).tiles.map((t) => tileKey(t.col, t.row)),
        );
        const unsafe = new Set([...danger, ...blastKeys]);
        const escape = fleeDir(
          next.grid,
          [
            ...bombs,
            {
              id: "_",
              ownerId: bot.id,
              col: bot.col,
              row: bot.row,
              placedAt: now,
              range: stats.range,
            },
          ],
          bot.col,
          bot.row,
          unsafe,
        );
        if (escape && Math.random() < BOT_BOMB_CHANCE) {
          // Drop the bomb AND immediately step onto the escape route in the same
          // tick — sitting on the bomb tile even one step is how bots blow
          // themselves up.
          addBomb(next, bot.id, bot.col, bot.row, stats);
          moveBot(bot, neighborOf(bot.col, bot.row, escape), now);
          changed = true;
          continue;
        }
      }

      // Wander toward the nearest enemy (fallback: nearest crate to dig
      // through). Only ever step onto a safe tile — if the sole neighbour is a
      // tile that's about to explode (e.g. waiting out our own bomb), hold.
      // Prefer tiles no other fighter is on so bots don't stack/clip; fall back
      // to any safe tile rather than freezing.
      const safeOpts = opts.filter((o) => !danger.has(o.key));
      const occupied = this.occupiedTiles(next, bot.id);
      const freeOpts = safeOpts.filter((o) => !occupied.has(o.key));
      const wanderOpts = freeOpts.length > 0 ? freeOpts : safeOpts;
      const target = nearestEnemy(bot, enemies) ?? nearestCrate(next.grid, bot.col, bot.row);
      let pick = wanderOpts[Math.floor(Math.random() * wanderOpts.length)] ?? null;
      if (target && wanderOpts.length > 0 && Math.random() > 0.25) {
        pick = wanderOpts.reduce((a, b) =>
          manhattan(b.c, b.r, target.col, target.row) < manhattan(a.c, a.r, target.col, target.row)
            ? b
            : a,
        );
      }
      moveBot(bot, pick, now);
      changed = true;
    }
    return changed;
  }

  /** Tiles currently held by living fighters other than `exceptId` (bot tiles
   *  are read live, so bots already moved this tick are reflected). */
  private occupiedTiles(next: SharedState, exceptId: string): Set<string> {
    const occ = new Set<string>();
    for (const [pid, p] of Object.entries(this.peers)) {
      if (next.deaths[pid]) continue;
      const ps = readPlayerState(p);
      if (ps.col !== undefined && ps.row !== undefined) occ.add(tileKey(ps.col, ps.row));
    }
    for (const other of Object.values(next.bots)) {
      if (other.id === exceptId || next.deaths[other.id]) continue;
      occ.add(tileKey(other.col, other.row));
    }
    return occ;
  }

  /** [id, col, row] for every living fighter (humans + bots). */
  private fighterPositions(next: SharedState): Array<[string, number, number]> {
    const out: Array<[string, number, number]> = [];
    for (const [pid, player] of Object.entries(this.peers)) {
      if (next.deaths[pid]) continue;
      const ps = readPlayerState(player);
      if (ps.col === undefined || ps.row === undefined) continue;
      out.push([pid, ps.col, ps.row]);
    }
    for (const bot of Object.values(next.bots)) {
      if (next.deaths[bot.id]) continue;
      out.push([bot.id, bot.col, bot.row]);
    }
    return out;
  }

  private hostPlaceBomb(ownerId: string, col: number, row: number): void {
    const s = this.shared();
    if (!s) return;
    if (!this.isAlive(ownerId)) return;
    if (bombOn(s.bombs, col, row)) return;
    const stats = s.stats[ownerId] ?? baseStats();
    const active = Object.values(s.bombs).filter((b) => b.ownerId === ownerId).length;
    if (active >= stats.bombs) return;
    const bomb = makeBomb(ownerId, col, row, stats.range);
    this.netPatchShared({ bombs: { ...s.bombs, [bomb.id]: bomb } });
  }

  // ---- visual effects ------------------------------------------------------

  private tweenPlayer(id: string | null, col: number, row: number, duration: number): void {
    if (!id) return;
    const objs = this.players.get(id);
    if (objs) {
      objs.action.interrupt();
      objs.dir = this.myDir;
      objs.moving = this.moving;
      this.applyAnim(objs, objs.dir, objs.moving);
      this.tweenContainer(objs, col, row, duration);
    }
  }

  private tweenContainer(objs: PlayerObjs, col: number, row: number, duration = 150): void {
    objs.col = col;
    objs.row = row;
    this.tweens.add({
      targets: objs.container,
      x: colX(col),
      y: rowY(row),
      duration,
      ease: "Linear",
    });
  }

  private playDeath(objs: PlayerObjs): void {
    this.resetPlayerFeedback(objs);
    objs.ring.setVisible(false);
    objs.marker?.setVisible(false);
    this.burst(objs.container.x, objs.container.y, 0xffffff, 22);
    this.tweens.add({
      targets: objs.sprite,
      angle: 540,
      scale: 0,
      alpha: 0.2,
      duration: 460,
      ease: "Cubic.In",
    });
  }

  private reviveVisual(objs: PlayerObjs, col: number, row: number): void {
    this.resetPlayerFeedback(objs);
    this.tweens.killTweensOf(objs.sprite);
    objs.sprite.setAngle(0).setAlpha(1).setScale(1);
    objs.sprite.setDisplaySize(TILE * 0.95, TILE * 0.95);
    objs.ring.setVisible(true);
    objs.marker?.setVisible(true);
    // Snap to the (likely new) spawn corner so we don't glide across the map.
    this.tweens.killTweensOf(objs.container);
    objs.container.setPosition(colX(col), rowY(row));
    objs.col = col;
    objs.row = row;
  }

  /** One cosmetic child tween; authored sprite frames and movement stay owned
   * by applyAnim/tweenContainer. Cancel before death, removal and round reset. */
  private pulsePlayer(id: string | null, kind: "place" | "pickup"): void {
    const objs = id ? this.players.get(id) : undefined;
    if (!objs || !this.isAlive(id)) return;
    this.clearBodyFeedback(objs);
    objs.sprite.setTint(kind === "pickup" ? 0xffefb4 : 0xffffff);
    this.tweens.add({
      targets: objs.body,
      ...(this.reducedMotion
        ? { alpha: { from: 0.7, to: 1 }, duration: 180 }
        : { scaleX: 1.08, scaleY: 0.92, y: kind === "pickup" ? -5 : 2, duration: 90, yoyo: true }),
      ease: "Sine.InOut",
      onComplete: () => objs.sprite.clearTint(),
    });
  }

  private resetPlayerFeedback(objs: PlayerObjs): void {
    objs.action.reset();
    this.applyAnim(objs, objs.dir, false);
    this.clearBodyFeedback(objs);
  }

  private clearBodyFeedback(objs: PlayerObjs): void {
    this.tweens.killTweensOf(objs.body);
    objs.body.setPosition(0, 0).setScale(1).setAlpha(1);
    objs.sprite.clearTint();
  }

  private crateBreak(col: number, row: number): void {
    this.battleFx?.crate(colX(col), rowY(row), this.reducedMotion);
    this.burst(colX(col), rowY(row), 0xc78a4a, 5);
  }

  private updateCharacterActions(delta: number): void {
    // Phaser's absolute time jumps across loop.sleep(); this owned visual clock
    // only advances rendered frames and never consumes a pause as clip time.
    this.characterTime += Math.max(0, Math.min(delta, 50));
    if (this.winnerAction && this.characterTime - this.winnerAction.at >= VICTORY_ACTION_MS)
      this.winnerAction = null;
    for (const [id, objs] of this.players)
      if (objs.actionFrame !== null && this.isAlive(id))
        this.applyAnim(objs, objs.dir, objs.moving);
  }

  /** Fuse tells tick with the pause-aware simulation clock, independent of
   * snapshot arrivals. Sparks shorten their interval as the fuse runs down. */
  private updateBattleFeel(delta: number): void {
    this.battleFx?.update(delta);
    this.updateCharacterActions(delta);
    const now = simNow();
    this.updateBlastFrames(now);
    const state = this.shared();
    const bombs = state?.bombs ?? {};
    this.roundHud.updateBombs(bombs, this.myId, this.myStats().bombs, now);
    const fighting =
      this.started &&
      this.live &&
      !this.controlsPaused &&
      state?.winner === null &&
      this.isAlive(this.myId);
    this.roundHud.update(now, fighting);
    updateRoundScore(fighting ? (this.aliveCount === 2 ? "duel" : "playing") : "silent", now);
    if (this.pickupUntil > 0 && now >= this.pickupUntil) this.clearPickupNote();
    this.syncRestartButton();
    for (const bomb of Object.values(bombs)) {
      const visual = this.bombSprites.get(bomb.id);
      if (!visual) continue;
      const { sprite, fuse } = visual;
      const left = Math.max(0, FUSE_MS - (now - bomb.placedAt));
      const progress = Math.min(1, left / FUSE_MS);
      const age = Math.max(0, now - bomb.placedAt);
      const urgency = 1 - progress;
      const pulse = this.reducedMotion ? 0 : Math.sin(age * 0.01 + urgency * urgency * 10) * 0.055;
      const arrival = this.reducedMotion ? 1 : Math.min(1, 0.75 + age / 640);
      sprite.setDisplaySize(
        TILE * 0.92 * (1 + pulse) * arrival,
        TILE * 0.92 * (1 - pulse) * arrival,
      );
      fuse.clear().lineStyle(2.5, left < 700 ? 0xff7650 : 0xffd27a, 0.8);
      if (progress > 0)
        fuse
          .beginPath()
          .arc(0, 3, TILE * 0.46, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress)
          .strokePath();
      if (left < 700 && (this.reducedMotion || Math.floor(left / 110) % 2 === 0))
        sprite.setTint(0xff4d4d);
      else sprite.clearTint();
      const interval = this.reducedMotion ? 220 : 65 + 120 * (left / FUSE_MS);
      if (this.started && Math.random() < Math.min(delta, 50) / interval)
        this.battleFx?.fuse(
          sprite.x + sprite.displayWidth * 0.4,
          sprite.y - sprite.displayHeight * 0.4,
        );
    }
  }

  private burst(x: number, y: number, tint: number, count: number): void {
    if (!this.sparkEmitter) return;
    this.sparkEmitter.setParticleTint(tint);
    this.sparkEmitter.explode(count, x, y);
  }

  private shakeIfNear(tiles: Array<{ col: number; row: number }>): void {
    const near = tiles.some(
      (t) => Math.abs(t.col - this.myCol) + Math.abs(t.row - this.myRow) <= 3,
    );
    if (near && !this.reducedMotion) this.cameras.main.shake(110, 0.005);
  }

  // ---- helpers -------------------------------------------------------------

  private myStats(): PlayerStats {
    const id = this.myId;
    const s = this.shared();
    return (id && s?.stats[id]) || baseStats();
  }

  private myColorIdx(): number {
    const id = this.myId;
    if (!id) return 0;
    const ps = readPlayerState(this.peers[id]);
    if (ps.colorIdx !== undefined) return ps.colorIdx % COLORS.length;
    const idx = Object.keys(this.peers).indexOf(id);
    return (idx < 0 ? 0 : idx) % COLORS.length;
  }

  private ensureMySpawn(): void {
    const id = this.myId;
    if (!id) return;
    const ps = readPlayerState(this.peers[id]);
    if (ps.col !== undefined && ps.row !== undefined) {
      if (!this.moving) {
        this.myCol = ps.col;
        this.myRow = ps.row;
      }
      return;
    }
    const idx = Object.keys(this.peers).indexOf(id);
    if (idx < 0) return;
    const spawn = SPAWN_POINTS[idx] ?? SPAWN_POINTS[0];
    this.myCol = spawn.col;
    this.myRow = spawn.row;
    this.netUpdateMyState({
      col: spawn.col,
      row: spawn.row,
      colorIdx: idx % COLORS.length,
      dir: "down",
      moving: false,
    });
  }

  private bombAt(col: number, row: number): boolean {
    const s = this.shared();
    if (!s) return false;
    return bombOn(s.bombs, col, row);
  }

  private passable(col: number, row: number): boolean {
    const s = this.shared();
    if (!s) return false;
    if (s.grid[row]?.[col]?.kind !== "empty") return false;
    return !this.bombAt(col, row);
  }

  private isAlive(id: string | null): boolean {
    if (!id) return false;
    const s = this.shared();
    if (!s) return true;
    return !s.deaths[id];
  }

  private writeShared(next: SharedState): void {
    this.netDirty = true;
    if (this.offline) {
      this.offlineShared = { ...next, clock: clockStamp() };
      return;
    }
    if (this.amHost) this.client.updateSharedState({ ...next, clock: clockStamp() });
  }

  // ---- start screen --------------------------------------------------------

  /** The one place controls are taught. Dismissed on the first key/pointer
   *  RELEASE, not press: the keydown handlers below stay live behind the
   *  overlay, so starting on keydown would let the same SPACE also drop a bomb. */
  private buildStartScreen(): void {
    this.startEl = document.getElementById("start");
    const controls = document.getElementById("start-controls");
    const go = document.getElementById("start-go");
    // Same grouped keycap rows the pause overlay renders — the two teaching
    // surfaces stay visually consistent by construction.
    ensureControlsStyle();
    const renderControls = (): void => {
      if (!controls) return;
      const card = buildControls(TOUCH_UI);
      controls.replaceChildren(...(card ? [card] : []));
    };
    renderControls();
    // Plugging in a pad while the start screen is up adds its rows.
    this.unwatchControls?.();
    this.unwatchControls = watchControlContext(() => {
      if (!this.started) renderControls();
    });
    if (go)
      go.textContent = TOUCH_UI
        ? "Drag to move · tap the bomb button"
        : "Or release any key to play";
    // Reveals the overlay now that the column is complete — see #start in index.html.
    this.startEl?.classList.add("ready");
    this.input.keyboard?.on("keyup", this.onStartKeyUp, this);
    // The overlay covers the canvas, so Phaser's pointer input never sees the
    // tap — listen on the overlay element itself.
    // Backdrop only: taps inside the card belong to its buttons and scroll area.
    this.startEl?.addEventListener("pointerup", (event) => {
      if (event.target === this.startEl) this.beginPlay();
    });
    document.getElementById("start-play")?.addEventListener("click", () => this.beginPlay());
    document.getElementById("start-sound")?.addEventListener("click", () => {
      setMuted(!isMuted());
      this.syncSoundButton();
    });
    this.syncSoundButton();
  }

  private onStartKeyUp(event: KeyboardEvent): void {
    if (event.key === "Tab" || event.key === "Escape") return;
    if (event.target instanceof HTMLElement && event.target.closest("button, #start-reading"))
      return;
    this.beginPlay();
  }

  private syncSoundButton(): void {
    const button = document.getElementById("start-sound");
    if (!button) return;
    const on = !isMuted();
    button.textContent = on ? "Sound on" : "Sound off";
    button.setAttribute("aria-pressed", String(on));
  }

  private beginPlay(): void {
    if (this.started) return;
    this.started = true;
    this.netDirty = true; // spawn immediately, even if the room has no new traffic
    this.padArmed = false;
    this.input.keyboard?.off("keyup", this.onStartKeyUp, this);
    this.unwatchControls?.();
    this.unwatchControls = null;
    // Escape is the only other way to pause, so a phone has none. Mounted here
    // rather than in create() because the button outranks the start screen's
    // z-index: offered before play begins it would pause a game that hasn't
    // started, over the one overlay that teaches the controls.
    unlockAudio();
    this.touchControls = createTouchControls({ mute: { get: isMuted, set: setMuted } });
    notifyGameStarted();
    this.startEl?.classList.add("hide");
    if (this.startEl) this.startEl.inert = true;
    // Drop it only after the fade, so it can't swallow taps on the way out.
    this.time.delayedCall(320, () => this.startEl?.remove());
  }

  // ---- HUD -----------------------------------------------------------------

  private statusText(): string {
    if (!this.offline) {
      const cs = this.client.connectionStatus;
      if (cs !== "connected") return `${cs}…`;
    }
    const s = this.shared();
    const restart = TOUCH_UI ? "tap to restart" : "press R";
    if (s?.winner) return `Round over — ${restart}`;
    if (this.started && !this.isAlive(this.myId)) return `Out · round continues`;
    // Live play: connection state only. Controls belong on the start screen.
    return this.offline ? "solo · offline" : this.amHost ? "host" : "guest";
  }

  private syncRoster(fighters: readonly Fighter[]): void {
    this.roundHud.updateRoster(
      fighters.map((fighter) => ({
        id: fighter.id,
        label: this.labelFor(fighter.id),
        colorIdx: fighter.colorIdx,
        alive: this.isAlive(fighter.id),
        isLocal: fighter.isLocal,
        isBot: fighter.isBot,
      })),
    );
  }

  private setBanner(): void {
    if (!this.bannerEl) return;
    const s = this.shared();
    const winner = s?.winner ?? null;
    if (winner !== this.observedWinner) {
      const freshOutcome = this.observedWinner === null && winner !== null;
      this.observedWinner = winner;
      if (freshOutcome && this.feedbackEnabled && winner !== null && winner !== "draw")
        this.winnerAction = { id: winner, at: this.characterTime };
      if (freshOutcome && this.feedbackEnabled && this.myId)
        sfx.win(winner === "draw" ? "draw" : winner === this.myId ? "won" : "lost");
    }
    const state = this.roundPresentation();
    this.bannerEl.hidden = state.kind === "hidden";
    this.bannerEl.setAttribute("aria-hidden", String(state.kind === "hidden"));
    if (state.kind === "hidden") {
      this.lastBanner = null;
      return;
    }
    const title =
      state.kind === "eliminated"
        ? "You're out"
        : state.kind === "won"
          ? "Courtyard champion"
          : state.kind === "draw"
            ? "Draw"
            : "Round complete";
    const detail =
      state.kind === "eliminated"
        ? `${state.remaining} fighters remain. The round continues.`
        : state.kind === "won"
          ? "You were the last fighter standing."
          : state.kind === "draw"
            ? "No fighter left standing."
            : `${state.winner} wins the round.`;
    const shared = Object.keys(this.peers).length > 1;
    const note = shared
      ? "Restart starts a new round for everyone."
      : "Fresh crates. Fresh chances.";
    const key = `${state.kind}|${title}|${detail}|${note}`;
    if (key !== this.lastBanner) {
      this.lastBanner = key;
      this.bannerEl.dataset.outcome = state.kind;
      this.writeUiText(
        "round-eyebrow",
        state.kind === "eliminated" ? "STILL IN PROGRESS" : "ROUND RESULT",
      );
      this.writeUiText("round-title", title);
      this.writeUiText("round-detail", detail);
      this.writeUiText("round-note", note);
    }
    this.syncRestartButton();
  }

  private roundPresentation(): RoundPresentation {
    const s = this.shared();
    const id = this.myId;
    if (!this.started || !this.live || !s || !id) return { kind: "hidden" };
    if (s.winner)
      return {
        kind: s.winner === "draw" ? "draw" : s.winner === id ? "won" : "lost",
        winner: this.labelFor(s.winner),
      };
    if (this.isAlive(id)) return { kind: "hidden" };
    const ids = [...Object.keys(this.peers), ...Object.keys(s.bots ?? {})];
    return { kind: "eliminated", remaining: ids.filter((fighter) => !s.deaths[fighter]).length };
  }

  private syncRestartButton(): void {
    const button = this.restartButton;
    if (!button) return;
    const disabled = this.restartableSince === null || simNow() - this.restartableSince < 600;
    if (button.disabled !== disabled) button.disabled = disabled;
  }

  private writeUiText(id: string, text: string): void {
    const el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
  }

  private labelFor(id: string): string {
    if (id === this.myId) return "you";
    if (id.startsWith("bot-")) return `CPU ${id.slice(4)}`;
    return id.slice(0, 4);
  }

  private setStatus(text: string): void {
    if (!this.statusEl || text === this.lastStatus) return;
    this.lastStatus = text;
    this.statusEl.textContent = text;
  }

  /** Range + speed only; bomb stock ticks every frame in RoundHud. */
  private setStats(): void {
    if (!this.statsEl) return;
    const alive = this.isAlive(this.myId);
    const stats = this.myStats();
    const speedLvl = Math.round((BASE_MOVE_MS - stats.speed) / SPEED_STEP_MS);
    const key = alive ? `${stats.range}|${speedLvl}` : "";
    if (key === this.lastStats) return;
    this.lastStats = key;
    this.statsEl.hidden = !alive;
    if (!alive) return;
    this.writeUiText("stat-fire", String(stats.range));
    this.writeUiText("stat-speed", String(speedLvl));
  }
}

// ---- module helpers (pure) --------------------------------------------------

function colX(col: number): number {
  return col * TILE + TILE / 2;
}

function rowY(row: number): number {
  return row * TILE + TILE / 2;
}

function manhattan(c1: number, r1: number, c2: number, r2: number): number {
  return Math.abs(c1 - c2) + Math.abs(r1 - r2);
}

function structuredCloneBots(bots: Record<string, Bot>) {
  const out: Record<string, Bot> = {};
  for (const [id, b] of Object.entries(bots)) out[id] = { ...b };
  return out;
}

function randomKind(): PowerupKind {
  return POWERUP_KINDS[Math.floor(Math.random() * POWERUP_KINDS.length)] ?? "bomb";
}

/** Is there a bomb on this tile? */
function bombOn(bombs: Record<string, Bomb>, col: number, row: number): boolean {
  return Object.values(bombs).some((b) => b.col === col && b.row === row);
}

function makeBomb(ownerId: string, col: number, row: number, range: number): Bomb {
  const now = simNow();
  return { id: `b-${ownerId}-${now}-${col}-${row}`, ownerId, col, row, placedAt: now, range };
}

function grantPowerup(stats: PlayerStats, kind: PowerupKind): PlayerStats {
  switch (kind) {
    case "bomb":
      return { ...stats, bombs: Math.min(MAX_BOMBS, stats.bombs + 1) };
    case "fire":
      return { ...stats, range: Math.min(MAX_RANGE, stats.range + 1) };
    case "speed":
      return { ...stats, speed: Math.max(MIN_MOVE_MS, stats.speed - SPEED_STEP_MS) };
  }
}

function computeBlastTiles(grid: Cell[][], bomb: Bomb) {
  const tiles: Array<{ col: number; row: number }> = [{ col: bomb.col, row: bomb.row }];
  const crates: Array<{ col: number; row: number }> = [];
  for (const [dc, dr] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    for (let step = 1; step <= bomb.range; step++) {
      const c = bomb.col + dc * step;
      const r = bomb.row + dr * step;
      const cell = grid[r]?.[c];
      if (!cell || cell.kind === "wall") break;
      tiles.push({ col: c, row: r });
      if (cell.kind === "crate") {
        crates.push({ col: c, row: r });
        break;
      }
    }
  }
  return { tiles, crates };
}

// ---- bot AI helpers ---------------------------------------------------------

/** Tiles that are unsafe right now: every bomb's eventual blast + live blasts. */
function dangerSet(s: SharedState): Set<string> {
  const danger = new Set<string>();
  for (const bomb of Object.values(s.bombs)) {
    for (const t of computeBlastTiles(s.grid, bomb).tiles) danger.add(tileKey(t.col, t.row));
  }
  for (const blast of Object.values(s.blasts)) {
    for (const t of blast.tiles) danger.add(tileKey(t.col, t.row));
  }
  return danger;
}

type Neighbor = { dir: Dir; c: number; r: number; key: string };

function neighborOf(col: number, row: number, dir: Dir): Neighbor {
  const [dc, dr] = DIR_VECT[dir];
  return { dir, c: col + dc, r: row + dr, key: tileKey(col + dc, row + dr) };
}

/**
 * Breadth-first search for the nearest tile not in `unsafe`, returning the
 * direction of the first step toward it (or null if no safe tile is reachable).
 * Walks only empty, bomb-free tiles. Used both to flee live danger and to
 * vet a prospective bomb's escape route.
 */
function fleeDir(
  grid: Cell[][],
  bombs: Bomb[],
  col: number,
  row: number,
  unsafe: Set<string>,
): Dir | null {
  const blocked = (c: number, r: number): boolean =>
    grid[r]?.[c]?.kind !== "empty" || bombs.some((b) => b.col === c && b.row === r);
  const visited = new Set<string>([tileKey(col, row)]);
  let frontier: Array<{ c: number; r: number; firstDir: Dir }> = [];
  for (const dir of DIRS) {
    const [dc, dr] = DIR_VECT[dir];
    const c = col + dc;
    const r = row + dr;
    const k = tileKey(c, r);
    if (blocked(c, r)) continue;
    visited.add(k);
    if (!unsafe.has(k)) return dir;
    frontier.push({ c, r, firstDir: dir });
  }
  for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
    const nextF: Array<{ c: number; r: number; firstDir: Dir }> = [];
    for (const node of frontier) {
      for (const dir of DIRS) {
        const [dc, dr] = DIR_VECT[dir];
        const c = node.c + dc;
        const r = node.r + dr;
        const k = tileKey(c, r);
        if (visited.has(k) || blocked(c, r)) continue;
        visited.add(k);
        if (!unsafe.has(k)) return node.firstDir;
        nextF.push({ c, r, firstDir: node.firstDir });
      }
    }
    frontier = nextF;
  }
  return null;
}

function botNeighbors(s: SharedState, col: number, row: number): Neighbor[] {
  const out: Neighbor[] = [];
  for (const dir of DIRS) {
    const [dc, dr] = DIR_VECT[dir];
    const c = col + dc;
    const r = row + dr;
    if (s.grid[r]?.[c]?.kind !== "empty") continue;
    if (Object.values(s.bombs).some((b) => b.col === c && b.row === r)) continue;
    out.push({ dir, c, r, key: tileKey(c, r) });
  }
  return out;
}

function adjacentCrate(grid: Cell[][], col: number, row: number): boolean {
  return DIRS.some((dir) => {
    const [dc, dr] = DIR_VECT[dir];
    return grid[row + dr]?.[col + dc]?.kind === "crate";
  });
}

function enemyInLine(
  grid: Cell[][],
  bot: Bot,
  range: number,
  fighters: Array<[string, number, number]>,
): boolean {
  const enemyTiles = new Set(
    fighters.filter(([id]) => id !== bot.id).map(([, c, r]) => tileKey(c, r)),
  );
  for (const dir of DIRS) {
    const [dc, dr] = DIR_VECT[dir];
    for (let step = 1; step <= range; step++) {
      const c = bot.col + dc * step;
      const r = bot.row + dr * step;
      const cell = grid[r]?.[c];
      if (!cell || cell.kind === "wall" || cell.kind === "crate") break;
      if (enemyTiles.has(tileKey(c, r))) return true;
    }
  }
  return false;
}

function nearestEnemy(
  bot: Bot,
  fighters: Array<[string, number, number]>,
): { col: number; row: number } | null {
  let best: { col: number; row: number } | null = null;
  let bestD = Infinity;
  for (const [id, c, r] of fighters) {
    if (id === bot.id) continue;
    const dd = manhattan(bot.col, bot.row, c, r);
    if (dd < bestD) {
      bestD = dd;
      best = { col: c, row: r };
    }
  }
  return best;
}

function nearestCrate(
  grid: Cell[][],
  col: number,
  row: number,
): { col: number; row: number } | null {
  let best: { col: number; row: number } | null = null;
  let bestD = Infinity;
  for (const [r, gr] of grid.entries()) {
    for (const [c, cell] of gr.entries()) {
      if (cell.kind !== "crate") continue;
      const dd = manhattan(col, row, c, r);
      if (dd < bestD) {
        bestD = dd;
        best = { col: c, row: r };
      }
    }
  }
  return best;
}

function moveBot(bot: Bot, to: Neighbor | null, now: number): void {
  if (!to) {
    bot.moving = false;
    bot.nextMoveAt = now + BOT_MOVE_MS;
    return;
  }
  bot.col = to.c;
  bot.row = to.r;
  bot.dir = to.dir;
  bot.moving = true;
  bot.nextMoveAt = now + BOT_MOVE_MS;
}

function addBomb(
  next: SharedState,
  ownerId: string,
  col: number,
  row: number,
  stats: PlayerStats,
): void {
  if (bombOn(next.bombs, col, row)) return;
  const bomb = makeBomb(ownerId, col, row, stats.range);
  next.bombs[bomb.id] = bomb;
}
