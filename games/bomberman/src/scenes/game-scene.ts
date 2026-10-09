import {
  createTouchControls,
  isOfflineRequested,
  notifyGameStarted,
  watchControlContext,
} from "@repo/embed";
import type { TouchControls } from "@repo/embed";
import { PhysicalGamepad, attachVirtualGamepad, stickDirection4 } from "@vibedgames/gamepad/phaser";
import type { PhaserGamepad } from "@vibedgames/gamepad/phaser";
import { FixedRate, MultiplayerClient, RemoteClock } from "@vibedgames/multiplayer";
import {
  isPlaytestRequested,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";
import type { JsonRecord, JsonValue, Player } from "@vibedgames/multiplayer";
import type Phaser from "phaser";
import { BlendModes, Input, Math as PhaserMath, Scale, Scene, Scenes } from "phaser";
import { createArena, readArena } from "../shared/arena";
import type { Arena } from "../shared/arena";
import { BattleFx } from "../fx/battle-fx";
import { CharacterAction, VICTORY_ACTION_MS } from "../render/character-action";
import type { CharacterPose } from "../render/character-action";
import { blastFrame, fireCells, freshCue } from "../render/blast-frame";
import { BotStride } from "../render/bot-stride";
import { RoundHud } from "../render/round-hud";
import { DirInput, stickDirs } from "../input/dir-input";
import { BombPrediction, fuseStart } from "../net/bomb-prediction";
import { TurnTrack } from "../net/bot-track";
import { PICKUP_CLAIMS, PickupClaims, pickupKey } from "../net/pickup-claims";
import { StepTrack, WALK_GRACE_MS } from "../net/step-track";
import type { StepPose } from "../net/step-track";
import { playtestManifest } from "../playtest-manifest";
import type { BombermanDiagnostics } from "../playtest-manifest";
import { bombOn } from "../sim/burn-map";
import { FixedStep } from "../sim/fixed-step";
import { bombId, hostTick as simHostTick, placeBomb } from "../sim/host-sim";
import { PlaytestScore, playtestView } from "../sim/playtest-view";
import type { Human } from "../sim/host-sim";
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
  BOT_MOVE_MS,
  COLORS,
  DIR_VECT,
  DIRS,
  FUSE_MS,
  GRID_COLS,
  GRID_ROWS,
  HOST_STEP_MS,
  MAX_PLAYERS,
  PLAYER_BEAT_HZ,
  PLAYER_LIMITS,
  SPAWN_POINTS,
  SPEED_STEP_MS,
  OFFLINE_FALLBACK_MS,
  TILE,
  tileKey,
  WORLD_H,
  WORLD_W,
} from "../shared/constants";
import type {
  Blast,
  Bomb,
  Bot,
  Cell,
  Dir,
  PlayerState,
  PlayerStats,
  Powerup,
  PowerupKind,
  SharedState,
} from "../shared/constants";
import { buildControls, ensureStyle as ensureControlsStyle } from "../pause-overlay";
import {
  adoptClock,
  clockStamp,
  now as simNow,
  pauseClock,
  readClock,
  resumeClock,
  setClockBase,
  simClock,
} from "../util/clock";
import { seededRandom } from "../util/seeded-random";

declare global {
  interface Window {
    /** Dev-console hook (DEV builds only). */
    __bb?: {
      scene: GameScene;
      client: MultiplayerClient;
      audio: typeof audioDiagnostics;
      simNow: () => number;
    };
  }
}

interface PlayerObjs {
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
  /** The walk/idle state last applied to the sprite — movers re-apply every frame. */
  anim: string | null;
}

interface BombObjs {
  sprite: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
  fuse: Phaser.GameObjects.Graphics;
}

interface BlastObjs {
  fire: Phaser.GameObjects.Image;
  footprint: Phaser.GameObjects.Image;
  placedAt: number;
}

type RoundPresentation =
  | { kind: "hidden" }
  | { kind: "eliminated"; remaining: number }
  | { kind: "won" | "lost" | "draw"; winner: string };

/** A unified view over humans (connections) and bots for rendering + rules. */
interface Fighter {
  id: string;
  col: number;
  row: number;
  colorIdx: number;
  isBot: boolean;
  isLocal: boolean;
  order: number;
}

/** Actions snapshot the pose drawn when they start; identity fields stay out. */
const poseOf = ({ col, row, dir, moving }: PlayerObjs): CharacterPose => ({
  col,
  dir,
  moving,
  row,
});

const PAD_START_BUTTONS = ["a", "b", "x", "y", "start"];

const POWERUP_TEX = {
  bomb: "pow-bomb",
  fire: "pow-fire",
  speed: "pow-speed",
} satisfies Record<PowerupKind, string>;
const POWERUP_GLOW = {
  bomb: 0xff_e1_4a,
  fire: 0xff_7a_2a,
  speed: 0x5d_b8_ff,
} satisfies Record<PowerupKind, number>;

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://party.vibedgames.com";

/** `?room=<code>` isolates a match (test harness, private lobby); everyone else shares one
 *  room, versioned with the wire format so a tab on an older bundle never shares a match. */
const ROOM = new URLSearchParams(location.search).get("room") || "bomberman-v4";
/** A playtest reseeds and restarts the round at will, so without a `?room` of
 *  its own it plays solo rather than dial the room everyone else shares. */
const SOLO_PLAYTEST = isPlaytestRequested() && !new URLSearchParams(location.search).has("room");
const BOMB_BUTTON_INSET = 84;
const BOMB_BUTTON_RADIUS = 52;

/** A step that follows straight on from the last starts where that one ended, back at most this far. */
const MAX_CARRY_MS = 50;
/** Longest frame the camera and the host's catch-up take into account. */
const MAX_FRAME_MS = 250;
/** Camera follow time constant — the old 0.16-per-frame ease at 60 Hz, at any refresh rate. */
const CAMERA_FOLLOW_MS = 96;

/** Detected at boot (not on first touch) so the first HUD paint already shows
 *  touch-worded hints on phones. */
export const TOUCH_UI = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;

/** Grass extends this far past the arena so the follow camera never shows void. */
const FLOOR_PAD = TILE * 20;

const colX = (col: number): number => col * TILE + TILE / 2;
const rowY = (row: number): number => row * TILE + TILE / 2;

const nearestTile = (
  tiles: readonly { col: number; row: number }[],
  listenerX: number,
  listenerY: number,
  seed: { distance: number; x: number } | null,
): { distance: number; x: number } | null => {
  let nearest = seed;
  for (const tile of tiles) {
    const x = colX(tile.col);
    const distance = Math.hypot(x - listenerX, rowY(tile.row) - listenerY);
    if (!nearest || distance < nearest.distance) {
      nearest = { distance, x };
    }
  }
  return nearest;
};

const playerTexture = (dir: Dir): string => {
  if (dir === "up") {
    return "player-up";
  }
  return dir === "down" ? "player-down" : "player-side";
};

const walkAnim = (dir: Dir): string => {
  if (dir === "up") {
    return "walk-up";
  }
  return dir === "down" ? "walk-down" : "walk-side";
};

const roundScoreMode = (fighting: boolean, aliveCount: number): "duel" | "playing" | "silent" => {
  if (!fighting) {
    return "silent";
  }
  return aliveCount === 2 ? "duel" : "playing";
};

const writeUiText = (id: string, text: string): void => {
  const el = document.querySelector(`#${id}`);
  if (el && el.textContent !== text) {
    el.textContent = text;
  }
};

/** Outcome from the local player's seat. */
const outcomeFor = (winner: string, myId: string | null): "draw" | "won" | "lost" => {
  if (winner === "draw") {
    return "draw";
  }
  return winner === myId ? "won" : "lost";
};

const BANNER_TITLE = {
  draw: "Draw",
  eliminated: "You're out",
  lost: "Round complete",
  won: "Courtyard champion",
} as const;

const bannerDetail = (state: Exclude<RoundPresentation, { kind: "hidden" }>): string => {
  switch (state.kind) {
    case "eliminated": {
      return `${state.remaining} fighters remain. The round continues.`;
    }
    case "won": {
      return "You were the last fighter standing.";
    }
    case "draw": {
      return "No fighter left standing.";
    }
    default: {
      return `${state.winner} wins the round.`;
    }
  }
};

const labelColor = (isMe: boolean, isBot: boolean): string => {
  if (isMe) {
    return "#ffffff";
  }
  return isBot ? "#ffd0d0" : "#dfe6ff";
};

// Every resettable field MUST be present — patches shallow-merge, so an
// omitted key carries over from the previous round.
const emptyShared = (
  arena: Arena = "classic",
  random: () => number = Math.random,
): SharedState => ({
  arena,
  blasts: {},
  bombs: {},
  bots: {},
  deaths: {},
  grid: createArena(arena, random),
  powerups: {},
  // A whole millisecond: the round names its power-up claims.
  startedAt: Math.round(simNow()),
  stats: {},
  winner: null,
});

/** One field of a wire JSON dictionary — unvalidated until narrowed. */
type WireField = JsonValue | undefined;

// Wire-JSON narrowing helpers. Runtime `typeof` is banned by the lint, so these
// use typeof-free checks; JSON can only carry finite numbers, so Number.isFinite
// is the exact number test.
const isJsonObject = (v: WireField): v is JsonRecord =>
  Object.prototype.toString.call(v) === "[object Object]";
const isJsonNumber = (v: WireField): v is number => Number.isFinite(v);

const isShared = (v: MultiplayerClient["sharedState"]): v is SharedState =>
  isJsonObject(v) && Array.isArray(v["grid"]);

type PartialPS = Partial<PlayerState>;

const readPlayerState = (player: Player | undefined): PartialPS => {
  const s = player?.state;
  if (!s) {
    return {};
  }
  const num = (k: string): number | undefined => {
    const v = s[k];
    return isJsonNumber(v) ? v : undefined;
  };
  return {
    col: num("col"),
    colorIdx: num("colorIdx"),
    h: num("h"),
    row: num("row"),
    s: num("s"),
    t: num("t"),
  };
};

/** The owner's press counter, as an untrusted guest sends it. */
const isLocalId = (v: WireField): v is number => Number.isSafeInteger(v) && Number(v) > 0;

/** A guest's bomb press as the host reads it off `place_bomb`; `pressedAt` is sim time. */
interface GuestPress {
  col: number;
  row: number;
  localId: number;
  pressedAt: number;
}

export class GameScene extends Scene {
  private client!: MultiplayerClient;

  private tileObjs: (Phaser.GameObjects.Container | null)[][] = [];
  private tileKind: (Cell["kind"] | null)[][] = [];
  private bombSprites = new Map<string, BombObjs>();
  private blastSprites = new Map<string, BlastObjs>();
  private blastSeen = new Set<string>();
  private powerupObjs = new Map<
    string,
    { container: Phaser.GameObjects.Container; pickup: Powerup }
  >();
  private players = new Map<string, PlayerObjs>();
  private deathSeen = new Set<string>();
  private winnerAction: { id: string; at: number } | null = null;
  private characterTime = 0;
  private followStarted = false;

  // The local body is never driven by the network: it walks its own step
  // timeline (local `performance.now()`), and `myCol/myRow` is the tile the
  // current step enters — the position published to the room.
  private myCol = 0;
  private myRow = 0;
  private myDir: Dir = "down";
  private stepFrom = { col: 0, row: 0 };
  private stepStartedAt = 0;
  private stepEndsAt = 0;
  /** Placed on the board this session (spawned or restored); before that nothing drives the body. */
  private ownSpawned = false;
  /** `performance.now()` of the previous frame. */
  private frameAt = 0;
  private readonly dirInput = new DirInput();
  /** Counts this client's bomb presses; the host names each bomb after it (see bombId). */
  private localBombSeq = 1;
  /** Own bombs shown before the host has confirmed them (guests only). */
  private readonly prediction = new BombPrediction();
  /** Power-ups this client claimed: for its own body, or as host for its bots. */
  private readonly pickupClaims = new PickupClaims();
  private readonly hostStep = new FixedStep(HOST_STEP_MS, MAX_FRAME_MS);

  /** Remote humans, each drawn on its own sender's clock. */
  private readonly humanTracks = new Map<string, StepTrack>();
  /** Bots, turning on the sim clock: drawn on time by the host, from its turns by everyone else. */
  private readonly botTracks = new Map<string, BotStride | TurnTrack>();
  /** Each bot's turns as a guest receives them, learned per bot and kept across rounds. */
  private readonly botClocks = new Map<string, RemoteClock>();
  /** Last state taken in per mover, so a repeated notify is a no-op. */
  private readonly ingested = new Map<string, string>();
  private ingestRound: number | null = null;
  /** Who sends the bots' turns: this client ("self") or the host it follows. */
  private botSender: string | null = null;
  /** The heartbeat's send clock: see PlayerState's `h`. */
  private readonly beat = new FixedRate(PLAYER_BEAT_HZ);

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
  /** Touch pause button. */
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
  /** Crate layouts, powerup drops and bot dice; the playtest seed hook swaps it. */
  private random: () => number = Math.random;
  private readonly playtestScore = new PlaytestScore();
  private diagnosticsAt = -1;
  private diagnosticsValue: BombermanDiagnostics | null = null;
  /** Living fighters as of the last render sync — drives the score bed. */
  private aliveCount = 0;
  private controlsPaused = false;

  /** The wrapper pause owns local input; a connected host keeps the other
   *  fighters running. The embed key gate swallows keyup while paused, so
   *  held keys would otherwise stick down. */
  setPresentationPaused(paused: boolean): void {
    if (this.controlsPaused === paused) {
      return;
    }
    this.controlsPaused = paused;
    if (paused) {
      this.roundHud.update(simNow(), false);
    }
    this.dirInput.reset();
    this.input.keyboard?.resetKeys();
    this.gamepad.pad.reset();
    this.padArmed = false;
  }

  /** `roomReady` as of the last frame — see watchRoomClock. */
  private roomWasReady = false;

  /** A room of one with no server (see create()): asked for, or no room answered in time. */
  private get offline(): boolean {
    return this.client.connectionStatus === "offline";
  }

  /** In the room with its clock measured: until the first probe returns, server time reads the local clock. */
  private get roomReady(): boolean {
    return this.client.connectionStatus === "connected" && this.client.serverClock.synced;
  }

  /** In the room, or offline. */
  private get live(): boolean {
    return this.offline || this.roomReady;
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

  /** Offline, this client hosts its room of one. */
  private get amHost(): boolean {
    return this.live && this.client.isHost;
  }

  /** Freeze a solo simulation. The paused stamp goes out before the loop
   *  sleeps so a later joiner (or a promoted host) inherits the same sim time. */
  pauseSimulation(): void {
    if (!this.freezable || this.simulationFrozen) {
      return;
    }
    pauseClock();
    this.simulationFrozen = true;
    this.netPatchShared({});
    this.game.loop.sleep();
  }

  resumeSimulation(): void {
    if (!this.simulationFrozen) {
      return;
    }
    this.simulationFrozen = false;
    resumeClock();
    this.netPatchShared({});
    this.game.loop.wake();
  }

  /** Runs on every room change — the socket stays live while Phaser sleeps —
   *  and once the room's clock comes in. Guests follow the host's stamp; a
   *  promoted host inherits it once, then sends its own whenever it changes. */
  private syncSharedClock(): void {
    if (this.offline) {
      return;
    }
    if (!this.roomReady) {
      this.clockAuthority = false;
      return;
    }
    const host = this.client.isHost;
    const state = this.client.sharedState;
    if (isShared(state) && (!host || !this.clockAuthority)) {
      adoptClock(readClock(state.clock));
      if (this.simulationFrozen) {
        pauseClock();
      } else if (host) {
        resumeClock();
      }
    }
    this.clockAuthority = host;
    if (this.simulationFrozen && !this.freezable) {
      // Another human arrived mid-pause: our overlay stays up, but their round must run.
      this.simulationFrozen = false;
      resumeClock();
      this.netPatchShared({});
      this.game.loop.wake();
    }
  }

  private get myId(): string | null {
    return this.client.playerId;
  }

  /** Humans in the arena. A dropped peer's seat is held for the reconnect
   *  grace window, but until it returns it must not keep a corner from a bot,
   *  stand as an unkillable ghost or hold the round open. */
  private get peers(): typeof this.client.players {
    const present: typeof this.client.players = {};
    for (const [id, player] of Object.entries(this.client.players)) {
      if (player.connected !== false) {
        present[id] = player;
      }
    }
    return present;
  }

  /**
   * The host's write to the world, with the sim clock. Only the leaves that
   * changed go out: an opened crate is one cell of the board, and a clock
   * that held still since the last write is nothing at all.
   */
  private netPatchShared(patch: Partial<SharedState>): void {
    this.netDirty = true;
    if (this.amHost) {
      this.client.updateSharedState({ ...patch, clock: clockStamp() });
    }
  }

  /** The room goes live once its clock is measured, and no room message says when. */
  private watchRoomClock(): void {
    const ready = this.roomReady;
    if (ready === this.roomWasReady) {
      return;
    }
    this.roomWasReady = ready;
    this.syncSharedClock();
    this.netDirty = true;
  }

  constructor() {
    super("Game");
  }

  create(): void {
    this.statusEl = document.querySelector("#status");
    this.statsEl = document.querySelector("#stats");
    this.bannerEl = document.querySelector("#banner");
    this.pickupNoteEl = document.querySelector("#pickup-note");
    const restart = document.querySelector("#round-restart");
    this.restartButton = restart instanceof HTMLButtonElement ? restart : null;
    this.buildStartScreen();
    this.restartButton?.addEventListener("click", () => this.requestRestart());
    // Taps on the result card must not double as tap-to-restart on the canvas,
    // and Space/Enter activating its button must not also drop a bomb.
    for (const type of ["pointerdown", "pointerup"]) {
      this.bannerEl?.addEventListener(type, (event) => event.stopPropagation());
    }
    for (const type of ["keydown", "keyup"]) {
      this.bannerEl?.addEventListener(type, (event) => {
        if (event instanceof KeyboardEvent && (event.key === " " || event.key === "Enter")) {
          event.stopPropagation();
        }
      });
    }

    // The garden stays beyond the arena; quiet stone paving makes traversable
    // cells and warm destructible crates read clearly inside its boundary.
    this.add
      .tileSprite(-FLOOR_PAD, -FLOOR_PAD, WORLD_W + FLOOR_PAD * 2, WORLD_H + FLOOR_PAD * 2, "grass")
      .setOrigin(0, 0)
      .setTint(0x77_87_74)
      .setDepth(-13);
    this.add
      .graphics()
      .fillStyle(0x11_1b_1b, 0.35)
      .fillRoundedRect(-8, -4, WORLD_W + 22, WORLD_H + 22, 12)
      .fillStyle(0x3c_48_40)
      .fillRoundedRect(-6, -6, WORLD_W + 12, WORLD_H + 12, 8)
      .lineStyle(2, 0xa3_97_66, 0.6)
      .strokeRoundedRect(-5, -5, WORLD_W + 10, WORLD_H + 10, 7)
      .setDepth(-12);
    this.add.tileSprite(0, 0, WORLD_W, WORLD_H, "floor").setOrigin(0, 0).setDepth(-10);

    const cam = this.cameras.main;
    cam.setBackgroundColor("#0e1020");
    cam.roundPixels = true;
    this.applyZoom();
    this.scale.on(Scale.Events.RESIZE, this.applyZoom, this);

    // One spark emitter shared by every burst() (crates, deaths, pickups):
    // re-tinted and exploded in place instead of allocating one per call.
    this.sparkEmitter = this.add
      .particles(0, 0, "spark", {
        alpha: { end: 0, start: 1 },
        angle: { max: 360, min: 0 },
        blendMode: BlendModes.ADD,
        emitting: false,
        lifespan: { max: 560, min: 280 },
        maxAliveParticles: 192,
        scale: { end: 0, start: 1.1 },
        speed: { max: 190, min: 40 },
      })
      .setDepth(40)
      .reserve(192);
    this.battleFx = new BattleFx(this);

    // Offline by intent (?offline=1, a solo playtest) the client never dials:
    // a failed WebSocket handshake logs a console error the page cannot
    // suppress, and waiting out the fallback would hold the round behind
    // `live` for the whole deadline. Otherwise it goes offline by itself when
    // no room admits it within OFFLINE_FALLBACK_MS of play. Offline it is a
    // room of one that this client hosts over the same code paths: intents
    // loop back, the world applies locally, claims are granted at once, and
    // the bots make it a real match (you vs 3 bots).
    // No `initialState`: the round is stamped on the room's clock, so the
    // first host seeds it once that clock is in (ensureSeeded), and a promoted
    // guest keeps the live round.
    this.client = new MultiplayerClient({
      fallbackMs: OFFLINE_FALLBACK_MS,
      host: MULTIPLAYER_HOST,
      limits: PLAYER_LIMITS,
      maxPlayers: MAX_PLAYERS,
      offline: isOfflineRequested() || SOLO_PLAYTEST,
      onClaim: (key, owner) => this.onClaimHeard(key, owner),
      onEvent: (event, payload, from) => this.handleEvent(event, payload, from),
      party: "vg-server",
      room: ROOM,
    });
    // Sim time is server time: every client reads fuses and bot steps alike.
    // Offline the server clock is this machine's.
    setClockBase(this.client.serverClock);
    // The SDK notifies once per room message (offline, once per write), so
    // every step a mover reports reaches its track even when several land in
    // one frame.
    this.client.subscribe(() => {
      this.syncSharedClock();
      this.ingestNet();
      this.netDirty = true;
    });
    // A client offline from the start already hosts: its world is seeded now.
    this.ensureSeeded();

    this.bindInput();

    this.events.on(Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Scale.Events.RESIZE, this.applyZoom, this);
      this.gamepad.destroy();
      this.touchControls?.destroy();
      this.client.destroy();
    });

    if (import.meta.env.DEV) {
      Object.assign(window, {
        __bb: { audio: audioDiagnostics, client: this.client, scene: this, simNow },
      });
    }
    // Small, real seams for plugins/tooling/skills/playtest. Scenario setup
    // uses the DEV scene handle; shared online rounds cannot be frozen here.
    publishDiagnostics(() => this.diagnostics());
    if (import.meta.env.DEV || isPlaytestRequested()) {
      publishTestHooks({
        seed: (seed) => this.reseed(seed),
        setPausedForScreenshot: (paused) => {
          if (!this.freezable) {
            throw new Error("Cannot freeze a shared arena");
          }
          if (paused) {
            this.pauseSimulation();
          } else {
            this.resumeSimulation();
          }
        },
        setReducedMotion: (enabled) => {
          this.reducedMotion = enabled;
          this.battleFx?.clear();
        },
        setState: (name) => {
          if (name !== "active-play") {
            throw new Error(`Unknown Bomberman state: ${name}`);
          }
          this.beginPlay();
          return { state: name };
        },
      });
      publishPlaytest(playtestManifest);
    }
  }

  /** Same seed, same crates and the same bot dice — in a fresh round, so
   *  nothing measured afterwards was rolled before the seed landed. */
  private reseed(seed: number): void {
    if (!this.offline) {
      throw new Error("Cannot reseed a shared arena");
    }
    this.random = seededRandom(seed);
    this.playtestScore.reset();
    const next = emptyShared("classic", this.random);
    next.startedAt = Math.max(next.startedAt, (this.shared()?.startedAt ?? 0) + 1);
    this.writeShared(next);
  }

  private applyZoom(): void {
    // Keep ~9.5 board rows AND ~7.5 columns on screen — whichever needs the
    // wider FOV wins, so portrait phones aren't blind to bombs whose blast
    // (up to MAX_RANGE tiles) would land from off-screen. Clamped for
    // tiny/huge screens.
    const zoom = PhaserMath.Clamp(
      Math.min(this.scale.height / (9.5 * TILE), this.scale.width / (7.5 * TILE)),
      0.6,
      2.4,
    );
    this.cameras.main.setZoom(zoom);
  }

  override update(_time: number, delta: number): void {
    // Movement, the camera and the host step all run on real elapsed time,
    // never Phaser's smoothed delta.
    const now = performance.now();
    const elapsed = this.frameAt === 0 ? 0 : Math.min(MAX_FRAME_MS, now - this.frameAt);
    this.frame += 1;
    this.watchRoomClock();
    if (this.prediction.settle(this.shared()?.bombs ?? {}, now)) {
      this.netDirty = true;
    }
    // subscribe() marks the scene dirty; run the render sync at most once per
    // frame, and only when something actually changed. Runs even while
    // connecting so the HUD shows the connection status.
    if (this.netDirty) {
      this.netDirty = false;
      this.onUpdate();
    }
    this.updateBattleFeel(delta);
    this.pollPad();
    if (this.live) {
      // reconcile dropped touches + redraw the overlay
      this.gamepad.update();
      this.applyPadActions();
      this.handleInput(now);
      this.sendBeat(elapsed, now);
      this.claimUnderfoot();
      // Hold the world (bots, bombs, round end) while the start screen is up, or
      // the round can be decided against a player who is still reading. Only safe
      // when no other human is present: freezing a shared arena would stall them.
      // `offline` means "no server", not "solo" — a connected solo host still
      // needs the hold, so gate on the human count instead.
      const soloArena = Object.keys(this.peers).length <= 1;
      if (this.amHost && (this.started || !soloArena)) {
        this.hostSteps();
      } else {
        this.hostStep.reset();
      }
      this.updateMovers(now);
      this.updateCamera(elapsed);
    }
    this.frameAt = now;
  }

  private observeScore(): void {
    const state = this.shared();
    const id = this.myId;
    if (state && id) {
      this.playtestScore.observe(state, id);
    }
  }

  private playtestPhase(): BombermanDiagnostics["phase"] {
    if (!this.live) {
      return "connecting";
    }
    if (!this.started) {
      return "start-screen";
    }
    if ((this.shared()?.winner ?? null) !== null) {
      return "round-over";
    }
    return this.isAlive(this.myId) ? "playing" : "dead";
  }

  /** Built when read, at most once a frame: the planner walks the board, and
   *  outside a playtest nothing reads it. */
  private diagnostics(): BombermanDiagnostics {
    if (this.diagnosticsValue && this.diagnosticsAt === this.frame) {
      return this.diagnosticsValue;
    }
    const state = this.shared();
    const id = this.myId;
    const phase = this.playtestPhase();
    const cooldownMs = Math.max(0, this.stepEndsAt - performance.now());
    const base: BombermanDiagnostics = {
      blasts: Object.keys(state?.blasts ?? {}).length,
      bombs: Object.keys(state?.bombs ?? {}).length,
      canStep: cooldownMs === 0,
      complete: phase === "round-over" || phase === "dead",
      cratesOpened: this.playtestScore.crates,
      entities: this.bombSprites.size + this.blastSprites.size + this.players.size,
      frame: this.frame,
      kills: this.playtestScore.kills,
      phase,
      player: { x: this.myCol * TILE, y: this.myRow * TILE },
      rivalsAlive: Object.values(state?.bots ?? {}).filter((bot) => !state?.deaths[bot.id]).length,
      score: this.playtestScore.points,
    };
    const value =
      phase === "playing" && state && id
        ? {
            ...base,
            ...playtestView({
              col: this.myCol,
              cooldownMs,
              myId: id,
              now: simNow(),
              row: this.myRow,
              state: this.playerView(state, id),
              stepMs: this.myStats().speed,
            }),
          }
        : base;
    this.diagnosticsAt = this.frame;
    this.diagnosticsValue = value;
    return value;
  }

  /** The pad polls outside the `live` gate: "press any pad button to start"
   *  must work while still connecting, exactly like the keyboard listener. */
  private pollPad(): void {
    this.pad.update();
    if (
      !this.started &&
      !this.controlsPaused &&
      PAD_START_BUTTONS.some((button) => this.pad.justPressed(button))
    ) {
      this.beginPlay();
    }
    if (
      !this.padArmed &&
      !this.pad.isButtonDown("a") &&
      !this.pad.isButtonDown("start") &&
      stickDirection4(this.pad.getStick()) === null &&
      DIRS.every((dir) => !this.pad.isButtonDown(dir))
    ) {
      this.padArmed = true;
    }
  }

  private applyPadActions(): void {
    if (!this.started || !this.padArmed || this.controlsPaused) {
      return;
    }
    for (const dir of DIRS) {
      if (this.pad.justPressed(dir)) {
        this.dirInput.press(dir);
      }
    }
    if (this.pad.justPressed("a")) {
      this.requestBomb();
    }
    if (this.pad.justPressed("start")) {
      this.requestRestart();
    }
  }

  /** Follow inside the courtyard, with one tile of garden framing its edges.
   * Clamp the zoomed view ourselves: Phaser's built-in bounds use the unzoomed
   * canvas. At low zoom, leave enough screen space for the fixed touch button.
   * Large viewports center the board on axes where it fits completely. */
  private updateCamera(elapsed: number): void {
    const id = this.myId;
    if (!id) {
      return;
    }
    const me = this.players.get(id);
    if (!me) {
      return;
    }
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
        : PhaserMath.Clamp(me.container.x, halfW - margin, WORLD_W + margin - halfW);
    const cy =
      halfH * 2 >= WORLD_H + margin * 2
        ? WORLD_H / 2
        : PhaserMath.Clamp(me.container.y, halfH - margin, WORLD_H + margin - halfH);
    // Phaser zooms around the midpoint (scroll + half the CANVAS size), so
    // centring subtracts cam.width/2 — halfW/H above (the zoomed visible
    // extent) determine how much of the arena fits.
    const tx = cx - cam.width / 2;
    const ty = cy - cam.height / 2;
    if (this.followStarted) {
      const k = 1 - Math.exp(-elapsed / CAMERA_FOLLOW_MS);
      cam.setScroll(PhaserMath.Linear(cam.scrollX, tx, k), PhaserMath.Linear(cam.scrollY, ty, k));
    } else {
      cam.setScroll(tx, ty);
      this.followStarted = true;
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
      onButtonDown: (id) => {
        if (id === "bomb") {
          this.requestBomb();
        }
      },
      render: { blendMode: BlendModes.NORMAL, depth: 1000 },
      // Pre-show the bomb button on touch devices — an invisible button is
      // undiscoverable before the first touch.
      visible: "coarse",
    });
    // Gameplay chrome: nothing but the start card until play begins.
    this.gamepad.setVisible(false);

    // Touch path to restart (R has no on-screen equivalent): while dead or
    // after the round ends, any fresh tap restarts. The arming delay stops
    // frantic bomb-taps that land just as you die from resetting the round.
    this.input.on(Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      if (!p.wasTouch) {
        return;
      }
      if (this.restartableSince === null) {
        return;
      }
      if (simNow() - this.restartableSince < 600) {
        return;
      }
      this.requestRestart();
    });

    const k = this.input.keyboard;
    if (!k) {
      return;
    }
    k.on("keydown-SPACE", () => this.requestBomb());
    k.on("keydown-B", () => this.requestBomb());
    k.on("keydown-R", () => this.requestRestart());
    k.on("keydown-M", (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }
      setMuted(!isMuted());
    });

    const KEY_TO_DIR: [string, Dir][] = [
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
      k.on(`keydown-${code}`, (event: KeyboardEvent) => {
        // Before the start screen is dismissed a press is only "any key".
        if (this.controlsPaused || !this.started || event.repeat) {
          return;
        }
        this.dirInput.press(dir);
      });
    }
    this.heldKeys = {
      down: [k.addKey("DOWN"), k.addKey("S")],
      left: [k.addKey("LEFT"), k.addKey("A")],
      right: [k.addKey("RIGHT"), k.addKey("D")],
      up: [k.addKey("UP"), k.addKey("W")],
    };
  }

  /** One grid step at a time, off the local clock — the network never waits on this. */
  private handleInput(now: number): void {
    if (this.controlsPaused || !this.started || !this.ownSpawned || !this.isAlive(this.myId)) {
      return;
    }
    this.dirInput.sync((dir) => this.dirHeld(dir));
    if (now < this.stepEndsAt) {
      return;
    }
    const dir = this.dirInput.choose((d) => {
      const [dc, dr] = DIR_VECT[d];
      return this.passable(this.myCol + dc, this.myRow + dr);
    }, this.stickDirs());
    if (!dir) {
      return;
    }
    // A step that follows straight on from the last starts where that one
    // ended, not on this frame, so the cadence and the drawn motion hold at
    // any frame rate. From a standstill, it starts now.
    const start =
      this.stepEndsAt > this.frameAt ? Math.max(this.stepEndsAt, now - MAX_CARRY_MS) : now;
    const stride = this.myStats().speed;
    const [dc, dr] = DIR_VECT[dir];
    this.stepFrom = { col: this.myCol, row: this.myRow };
    this.myCol += dc;
    this.myRow += dr;
    this.myDir = dir;
    this.stepStartedAt = start;
    this.stepEndsAt = start + stride;
    // Published on the room's clock, the one every receiver draws against.
    const t = Math.round(this.client.serverNow(now) - (now - start));
    this.client.updateMyState({ col: this.myCol, row: this.myRow, s: stride, t });
  }

  /**
   * While the body is on the board and another player is in the room to draw
   * it, the room's clock on a steady beat: a message carrying one key. Each
   * other player draws this body on its own clock of this sender, which
   * learns from the beats how long they take and how late they run, and the
   * newest beat tells it a body at rest is still there. A step in the same
   * frame leaves with it. Alone against bots there is nobody to tell.
   */
  private sendBeat(elapsed: number, now: number): void {
    if (
      this.beat.due(elapsed) &&
      this.ownSpawned &&
      this.roomReady &&
      Object.keys(this.peers).length > 1
    ) {
      this.client.updateMyState({ h: Math.round(this.client.serverNow(now)) });
    }
  }

  /** Held by a key of either set, or the pad's d-pad. */
  private dirHeld(dir: Dir): boolean {
    if (this.heldKeys?.[dir].some((key) => key.isDown)) {
      return true;
    }
    return this.pad.connected && this.padArmed && this.pad.isButtonDown(dir);
  }

  /** Analog sticks, physical then touch, each snapped to the grid. */
  private stickDirs(): Dir[] {
    const pad = this.pad.connected && this.padArmed ? stickDirs(this.pad.getStick()) : [];
    return [...pad, ...stickDirs(this.gamepad.getStick())];
  }

  /** The local body, read straight off its step timeline. */
  private ownPose(now: number): StepPose | undefined {
    if (!this.ownSpawned) {
      return undefined;
    }
    const from = this.stepFrom;
    const span = this.stepEndsAt - this.stepStartedAt;
    const k = span > 0 ? PhaserMath.Clamp((now - this.stepStartedAt) / span, 0, 1) : 1;
    const covered = k < 0.5 ? from : { col: this.myCol, row: this.myRow };
    return {
      col: covered.col,
      dir: this.myDir,
      moving: now < this.stepEndsAt + WALK_GRACE_MS,
      row: covered.row,
      x: from.col + (this.myCol - from.col) * k,
      y: from.row + (this.myRow - from.row) * k,
    };
  }

  /**
   * A bomb under the body as drawn — not on the tile a step is still
   * entering — shown, heard and solid on the press. The host places it at
   * once; a guest shows a prediction the host's copy takes over (see
   * net/bomb-prediction).
   */
  private requestBomb(): void {
    const id = this.myId;
    const state = this.shared();
    const pose = this.ownPose(performance.now());
    if (this.controlsPaused || !this.live || !this.started || !id || !state || !pose) {
      return;
    }
    if (!this.isAlive(id)) {
      return;
    }
    const { col, row } = pose;
    const localId = this.localBombSeq;
    // The host's own rule, against everything this client can see — its
    // unconfirmed bombs and claimed power-ups included — so a press the host
    // would refuse shows nothing.
    const view = { ...this.playerView(state, id), bombs: this.visibleBombs() };
    const at = Math.round(simNow());
    const bomb = placeBomb(view, id, col, row, at, localId)?.[bombId(id, localId)];
    if (!bomb) {
      return;
    }
    this.localBombSeq += 1;
    if (this.amHost) {
      this.netPatchShared({ bombs: { ...state.bombs, [bomb.id]: bomb } });
    } else {
      this.prediction.add(bomb, performance.now());
      this.netDirty = true;
      this.client.sendToHost("place_bomb", { at, col, localId, round: state.startedAt, row });
    }
    sfx.place(true);
    this.pulsePlayer(id, "place");
    this.roundHud.acceptedPlacement(simNow());
    this.players.get(id)?.action.place(bomb, simNow(), this.characterTime, pose);
  }

  private requestRestart(): void {
    if (this.controlsPaused || !this.live) {
      return;
    }
    if (!this.started) {
      return;
    }
    const state = this.shared();
    if (!state) {
      return;
    }
    // The accepted replacement snapshot owns respawn, including reconnects
    // that missed the request. Old requests cannot restart a newer round.
    // The host (and an offline client) handles its own request at once.
    this.client.sendToHost("request_restart", { round: state.startedAt });
  }

  private respawnSelf(): void {
    const id = this.myId;
    if (!id) {
      return;
    }
    const idx = Object.keys(this.peers).indexOf(id);
    if (idx === -1) {
      return;
    }
    const spawn = SPAWN_POINTS[idx] ?? SPAWN_POINTS[0];
    this.placeSelf(spawn.col, spawn.row);
    const objs = this.players.get(id);
    if (objs) {
      this.resetPlayerFeedback(objs);
      objs.container.setPosition(colX(spawn.col), rowY(spawn.row));
    }
    this.publishSpawn(spawn.col, spawn.row, idx);
  }

  /** Stand the local body on a tile, mid-nothing: spawn, respawn, a restored seat. */
  private placeSelf(col: number, row: number): void {
    this.myCol = col;
    this.myRow = row;
    this.myDir = "down";
    this.stepFrom = { col, row };
    this.stepStartedAt = 0;
    this.stepEndsAt = 0;
    this.ownSpawned = true;
  }

  /** A zero-length step: everyone else places the body there instead of walking it over. */
  private publishSpawn(col: number, row: number, idx: number): void {
    this.client.updateMyState({
      col,
      colorIdx: idx % COLORS.length,
      row,
      s: 0,
      t: Math.round(this.client.serverNow()),
    });
  }

  // ---- connection callbacks ------------------------------------------------

  private handleEvent(event: string, payload: JsonValue, from: string): void {
    if (!this.amHost) {
      return;
    }
    if (event === "place_bomb") {
      const p = isJsonObject(payload) ? payload : null;
      const col = p?.["col"];
      const row = p?.["row"];
      const localId = p?.["localId"];
      const at = p?.["at"];
      // A press made before a restart reached the guest must not land in the new round.
      const current = p?.["round"] === this.shared()?.startedAt;
      if (
        isJsonNumber(col) &&
        isJsonNumber(row) &&
        isLocalId(localId) &&
        isJsonNumber(at) &&
        current
      ) {
        this.hostPlaceBomb(from, { col, localId, pressedAt: at, row });
      }
    } else if (event === "request_restart") {
      this.hostRestart(payload);
    }
  }

  /** Take the power-up underfoot: claimed from the room, and cued at once (see net/pickup-claims). */
  private claimUnderfoot(): void {
    const id = this.myId;
    const state = this.shared();
    if (!id || !state || !this.started || !this.ownSpawned || !this.isAlive(id)) {
      return;
    }
    const tile = { col: this.myCol, row: this.myRow };
    const pickup = this.pickupClaims.reach(this.client, state, id, tile);
    if (!pickup) {
      return;
    }
    this.netDirty = true;
    const { kind } = pickup;
    this.burst(colX(pickup.col), rowY(pickup.row), POWERUP_GLOW[kind], 14);
    sfx.pickup();
    this.pulsePlayer(id, "pickup");
    if (this.statsEl) {
      this.statsEl.dataset["pickup"] = kind;
    }
    if (this.pickupNoteEl) {
      this.pickupNoteEl.textContent = `${kind.toUpperCase()} PICKUP`;
      this.pickupNoteEl.classList.add("on");
      this.pickupUntil = simNow() + 800;
    }
  }

  /**
   * The room named an owner for a claim. A power-up this client took that
   * went to someone else comes back off its stats. The host hands a grant to
   * another player at once, before that guest's next press can need it. Its
   * own grants (its body's, its bots', every one offline) settle in the host
   * step: offline a bot's grant arrives inside claim(), mid-step, where
   * settling would race the step's own write of the world and grant twice.
   */
  private onClaimHeard(key: string, owner: string | null): void {
    const id = this.myId;
    const lost = id ? this.pickupClaims.heard(key, owner, id) : null;
    if (lost?.fighter === id && this.statsEl?.dataset["pickup"] === lost.pickup.kind) {
      this.clearPickupNote();
    }
    if (owner !== null && owner !== id && this.amHost) {
      this.settlePickups();
    }
    this.netDirty = true;
  }

  /** Host: every power-up the room says was claimed goes to its claimant. */
  private settlePickups(): void {
    const id = this.myId;
    const state = this.shared();
    const granted = id && state ? this.pickupClaims.settle(this.client, state, id) : null;
    if (granted) {
      this.netPatchShared(granted);
    }
  }

  private hostRestart(payload: JsonValue): void {
    const state = this.shared();
    if (!state || !isJsonObject(payload) || payload["round"] !== state.startedAt) {
      return;
    }
    const next = emptyShared(
      readArena(state.arena) === "classic" ? "crossroads" : "classic",
      this.random,
    );
    // startedAt is the existing round identity. Two requests in one clock
    // millisecond must still produce distinct rounds, without new wire state.
    next.startedAt = Math.max(next.startedAt, state.startedAt + 1);
    this.writeShared(next);
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
      for (const objs of this.players.values()) {
        this.resetPlayerFeedback(objs);
      }
      this.battleFx?.clear();
      this.blastSeen.clear();
      this.prediction.clear();
      this.pickupClaims.clear();
      this.roundHud.reset();
      this.sparkEmitter?.killAll();
      this.clearPickupNote();
      // Initial joins keep their existing spawn policy. A later accepted round
      // replaces cached local coordinates exactly once, even after transport loss.
      if (round !== null && previousRound !== null && this.started) {
        this.respawnSelf();
      }
    }
    this.pickupClaims.prune(this.shared());
    this.trackRestartable();
    this.observeScore();
    this.setStatus(this.statusText());
    this.setStats();
    this.setBanner();
    // No body until the start screen is dismissed — bots and the host seed run
    // on behind the overlay, but the player isn't dropped in mid-read — nor
    // before the room's clock is in, which its spawn is stamped on.
    if (this.started && this.live) {
      this.ensureMySpawn();
    }
    const fighters = this.fighters();
    this.aliveCount = fighters.filter((fighter) => this.isAlive(fighter.id)).length;
    this.syncRoster(fighters);
    this.syncGrid();
    this.syncBombs();
    this.syncBlasts();
    this.syncPowerups();
    this.syncPlayers(fighters);
  }

  private clearPickupNote(): void {
    this.pickupNoteEl?.classList.remove("on");
    this.pickupUntil = 0;
    delete this.statsEl?.dataset.pickup;
  }

  /** Arm/disarm tap-to-restart as the death/round-over state changes. */
  private trackRestartable(): void {
    const s = this.shared();
    const restartable = this.live && s !== null && (s.winner !== null || !this.isAlive(this.myId));
    if (restartable) {
      this.restartableSince ??= simNow();
    } else {
      this.restartableSince = null;
    }
  }

  // ---- shared-state rendering ----------------------------------------------

  /** The world, once the first host has seeded it. */
  private shared(): SharedState | null {
    const state = this.client.sharedState;
    return isShared(state) ? state : null;
  }

  /**
   * Take every remote mover's newest step, beat or turn into its track.
   * Runs per room message, so two steps that land in one frame are both
   * walked — the once-a-frame render sync would see only the second and slide
   * straight through the pillar between them.
   */
  private ingestNet(): void {
    const state = this.shared();
    const botSender = this.amHost ? "self" : this.client.hostId;
    if (botSender !== this.botSender) {
      // A new host's turns come another way: each bot's clock learns the
      // route afresh, easing over to it. Simulating the bots here, or no
      // longer, draws them another way altogether.
      if ((botSender === "self") !== (this.botSender === "self")) {
        this.dropTracks(this.botTracks);
      }
      this.botSender = botSender;
      for (const clock of this.botClocks.values()) {
        clock.relearn();
      }
    }
    const round = state?.startedAt ?? null;
    if (round !== this.ingestRound) {
      // A new round respawns everyone: place them, never walk them there.
      this.ingestRound = round;
      this.clearTracks(this.humanTracks);
      this.clearTracks(this.botTracks);
    }
    for (const [id, player] of Object.entries(this.peers)) {
      if (id !== this.myId) {
        this.ingestHuman(id, readPlayerState(player));
      }
    }
    for (const bot of Object.values(state?.bots ?? {})) {
      this.ingestBot(bot);
    }
  }

  private ingestHuman(id: string, ps: PartialPS): void {
    let track = this.humanTracks.get(id);
    if (!track) {
      track = new StepTrack();
      this.humanTracks.set(id, track);
    }
    const { col, row, t, s, h } = ps;
    const key = `${col},${row},${t},${s}`;
    if (
      col !== undefined &&
      row !== undefined &&
      t !== undefined &&
      s !== undefined &&
      this.ingested.get(id) !== key
    ) {
      this.ingested.set(id, key);
      track.step({ col, row }, t, s);
    }
    if (h !== undefined) {
      track.beat(h);
    }
  }

  private ingestBot(bot: Bot): void {
    const own = this.botSender === "self";
    // A guest draws every turn, moved or not; the host only the strides.
    const key = own ? `${bot.col},${bot.row}` : `${bot.col},${bot.row},${bot.nextMoveAt}`;
    if (this.ingested.get(bot.id) === key) {
      return;
    }
    this.ingested.set(bot.id, key);
    // The turn sets the next one a stride after.
    this.botTrack(bot.id, own).turn(bot, bot.nextMoveAt - BOT_MOVE_MS, bot.dir);
  }

  /** The host draws its own bots on time; everyone else, from their turns on each bot's clock. */
  private botTrack(id: string, own: boolean): BotStride | TurnTrack {
    let track = this.botTracks.get(id);
    if (!track) {
      if (own) {
        track = new BotStride(simClock);
      } else {
        const clock = this.botClocks.get(id) ?? new RemoteClock();
        this.botClocks.set(id, clock);
        track = new TurnTrack(clock);
      }
      this.botTracks.set(id, track);
    }
    return track;
  }

  /** Forget every body's place, to be taken in afresh: the next state places each. */
  private clearTracks(tracks: Map<string, BotStride | StepTrack | TurnTrack>): void {
    for (const [id, track] of tracks) {
      track.clear();
      this.ingested.delete(id);
    }
  }

  private dropTracks(tracks: Map<string, BotStride | StepTrack | TurnTrack>): void {
    for (const id of tracks.keys()) {
      this.ingested.delete(id);
    }
    tracks.clear();
  }

  /**
   * The first host to connect seeds the world — an offline client too, as it
   * hosts its room of one. Guests adopt the host's existing state; a guest
   * promoted to host after a migration keeps the live round instead of
   * resetting it.
   */
  private ensureSeeded(): void {
    if (this.amHost && !this.shared()) {
      this.writeShared(emptyShared("classic", this.random));
    }
  }

  /** Humans (connections) + bots (shared state), unified for rendering. */
  private fighters(): Fighter[] {
    const out: Fighter[] = [];
    const { myId } = this;
    let order = 0;
    for (const [id, player] of Object.entries(this.peers)) {
      const ps = readPlayerState(player);
      const fb = SPAWN_POINTS[order] ?? SPAWN_POINTS[0];
      out.push({
        col: ps.col ?? fb.col,
        colorIdx: (ps.colorIdx ?? order) % COLORS.length,
        id,
        isBot: false,
        isLocal: id === myId,
        order,
        row: ps.row ?? fb.row,
      });
      order += 1;
    }
    const s = this.shared();
    if (s) {
      for (const bot of Object.values(s.bots ?? {})) {
        out.push({
          col: bot.col,
          colorIdx: bot.colorIdx % COLORS.length,
          id: bot.id,
          isBot: true,
          isLocal: false,
          order: -1,
          row: bot.row,
        });
      }
    }
    return out;
  }

  private syncGrid(): void {
    const s = this.shared();
    if (!s) {
      return;
    }
    for (let r = 0; r < GRID_ROWS; r += 1) {
      const objRow: (Phaser.GameObjects.Container | null)[] = this.tileObjs[r] ?? [];
      const kindRow: (Cell["kind"] | null)[] = this.tileKind[r] ?? [];
      this.tileObjs[r] = objRow;
      this.tileKind[r] = kindRow;
      for (let c = 0; c < GRID_COLS; c += 1) {
        const kind = s.grid[r]?.[c]?.kind ?? "empty";
        if (kindRow[c] === kind) {
          continue;
        }
        const prev = objRow[c];
        if (this.feedbackEnabled && kindRow[c] === "crate" && kind === "empty") {
          this.crateBreak(c, r);
        }
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

  private syncBombs(): void {
    if (!this.shared()) {
      return;
    }
    const seen = new Set<string>();
    for (const bomb of Object.values(this.visibleBombs())) {
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
        // This client's own bombs were cued on the press (requestBomb); the
        // host's copy taking over a prediction must not cue them twice.
        if (bomb.ownerId !== this.myId) {
          this.cueRemoteBomb(bomb);
        }
        this.bombSprites.set(bomb.id, { fuse, shadow, sprite });
      }
    }
    for (const [id, { sprite, shadow, fuse }] of this.bombSprites) {
      if (!seen.has(id)) {
        this.tweens.killTweensOf(sprite);
        sprite.destroy();
        shadow.destroy();
        fuse.destroy();
        this.bombSprites.delete(id);
      }
    }
  }

  private cueRemoteBomb(bomb: Bomb): void {
    if (!this.feedbackEnabled) {
      return;
    }
    if (freshCue(bomb.placedAt, simNow())) {
      sfx.place(false);
    }
    const owner = this.players.get(bomb.ownerId);
    if (owner && this.isAlive(bomb.ownerId)) {
      owner.action.place(bomb, simNow(), this.characterTime, poseOf(owner));
    }
  }

  private syncBlasts(): void {
    const s = this.shared();
    if (!s) {
      return;
    }
    const now = simNow();
    const blasts = Object.values(s.blasts);
    this.syncBlastSprites(fireCells(blasts, now));
    this.cueFreshBlasts(blasts, now);
    const seen = new Set(blasts.map((blast) => blast.id));
    for (const id of this.blastSeen) {
      if (!seen.has(id)) {
        this.blastSeen.delete(id);
      }
    }
    this.updateBlastFrames(now);
  }

  private syncBlastSprites(cells: ReturnType<typeof fireCells>): void {
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
        .setTint(0xff_e3_ac)
        .setAlpha(0.8)
        .setBlendMode(BlendModes.ADD);
      this.blastSprites.set(key, { fire, footprint, placedAt: cell.placedAt });
    }
    for (const [key, visual] of this.blastSprites) {
      if (cells.has(key)) {
        continue;
      }
      visual.fire.destroy();
      visual.footprint.destroy();
      this.blastSprites.delete(key);
    }
  }

  /** One-shot feedback (fx, shake, sound) for blasts first seen this frame. */
  private cueFreshBlasts(blasts: readonly Blast[], now: number): void {
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
      if (this.blastSeen.has(blast.id)) {
        continue;
      }
      this.blastSeen.add(blast.id);
      if (!this.feedbackEnabled || !freshCue(blast.placedAt, now)) {
        continue;
      }
      newBlasts += 1;
      nearest = nearestTile(blast.tiles, listenerX, listenerY, nearest);
      for (const tile of blast.tiles) {
        impactTiles.set(tileKey(tile.col, tile.row), tile);
      }
    }
    if (newBlasts === 0) {
      return;
    }
    const tiles = [...impactTiles.values()];
    this.battleFx?.blast(tiles, this.reducedMotion);
    this.shakeIfNear(tiles);
    const distance = nearest?.distance ?? 0;
    const strength = Math.max(0.2, 1 - (Math.max(0, distance / TILE - 2) / 8) * 0.8);
    const pan = Math.max(
      -1,
      Math.min(1, ((nearest?.x ?? centerX) - centerX) / (cam.width / (2 * cam.zoom))),
    );
    sfx.blast({ pan, strength });
  }

  private updateBlastFrames(now: number): void {
    for (const { fire, footprint, placedAt } of this.blastSprites.values()) {
      const frame = blastFrame(placedAt, now);
      fire.setVisible(frame !== null);
      footprint.setVisible(frame !== null);
      if (frame !== null) {
        fire.setFrame(frame);
      }
    }
  }

  private syncPowerups(): void {
    const s = this.shared();
    if (!s) {
      return;
    }
    const seen = new Set<string>();
    for (const [key, pu] of Object.entries(this.pickupClaims.visible(this.client, s))) {
      seen.add(key);
      if (this.powerupObjs.has(key)) {
        continue;
      }
      const glow = this.add
        .image(0, 0, "glow")
        .setDisplaySize(TILE * 1.15, TILE * 1.15)
        .setTint(POWERUP_GLOW[pu.kind])
        .setBlendMode(BlendModes.ADD);
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
          duration: 760,
          ease: "Sine.InOut",
          repeat: -1,
          targets: icon,
          y: -6,
          yoyo: true,
        });
        this.tweens.add({
          alpha: { from: 0.35, to: 0.65 },
          duration: 900,
          ease: "Sine.InOut",
          repeat: -1,
          scaleX: { from: glow.scaleX * 0.92, to: glow.scaleX * 1.08 },
          scaleY: { from: glow.scaleY * 0.92, to: glow.scaleY * 1.08 },
          targets: glow,
          yoyo: true,
        });
      }
      this.powerupObjs.set(key, { container, pickup: pu });
    }
    for (const [key, { container, pickup }] of this.powerupObjs) {
      if (!seen.has(key)) {
        this.cueTaken(s, pickup);
        this.tweens.killTweensOf(container.list);
        container.destroy();
        this.powerupObjs.delete(key);
      }
    }
  }

  /** A power-up gone from the board bursts if a bot or another player took it; this
   *  client's own pickups cued on the step, and burnt ones just go. */
  private cueTaken(s: SharedState, pickup: Powerup): void {
    const key = pickupKey(s.startedAt, pickup);
    const taker = this.pickupClaims.fighterOf(key) ?? this.client.ownerOf(key);
    if (this.feedbackEnabled && taker !== null && taker !== this.myId) {
      this.burst(colX(pickup.col), rowY(pickup.row), POWERUP_GLOW[pickup.kind], 14);
    }
  }

  /** Who is on the board, and who died or revived. Where each body is drawn
   *  is updateMovers' job, every frame. */
  private syncPlayers(fighters: readonly Fighter[]): void {
    const seen = new Set<string>();
    for (const f of fighters) {
      seen.add(f.id);
      const objs =
        this.players.get(f.id) ??
        this.createPlayer(f.id, f.col, f.row, f.colorIdx, f.isLocal, f.isBot);
      const dead = !this.isAlive(f.id);
      this.syncDeath(objs, f, dead);
      if (dead) {
        if (this.winnerAction?.id === f.id) {
          this.winnerAction = null;
        }
        continue;
      }
      this.syncCelebration(objs, f);
    }
    this.dropDepartedPlayers(seen);
  }

  /**
   * Place every living body for this frame: the local one off its own step
   * timeline, the rest off their step tracks — never a tween per packet.
   */
  private updateMovers(now: number): void {
    const { myId } = this;
    for (const [id, objs] of this.players) {
      if (!this.isAlive(id)) {
        continue;
      }
      const track = this.humanTracks.get(id) ?? this.botTracks.get(id);
      const pose = id === myId ? this.ownPose(now) : track?.sample(now);
      if (!pose) {
        continue;
      }
      objs.container.setPosition(colX(pose.x), rowY(pose.y));
      objs.col = pose.col;
      objs.row = pose.row;
      objs.dir = pose.dir;
      objs.moving = pose.moving;
      this.applyAnim(objs, pose.dir, pose.moving);
    }
  }

  private syncDeath(objs: PlayerObjs, f: Fighter, dead: boolean): void {
    if (dead && !this.deathSeen.has(f.id)) {
      this.deathSeen.add(f.id);
      this.playDeath(objs);
      if (this.feedbackEnabled && f.isLocal) {
        sfx.death();
      }
    } else if (!dead && this.deathSeen.has(f.id)) {
      this.deathSeen.delete(f.id);
      this.reviveVisual(objs, f.col, f.row);
    }
  }

  private syncCelebration(objs: PlayerObjs, f: Fighter): void {
    const celebration = this.winnerAction;
    if (celebration?.id !== f.id) {
      return;
    }
    this.winnerAction = null;
    if (this.characterTime - celebration.at < VICTORY_ACTION_MS) {
      objs.action.victory(celebration.at, poseOf(objs));
    }
  }

  private dropDepartedPlayers(seen: ReadonlySet<string>): void {
    for (const [id, objs] of this.players) {
      if (!seen.has(id)) {
        this.resetPlayerFeedback(objs);
        this.tweens.killTweensOf(objs.container);
        this.tweens.killTweensOf(objs.container.list);
        this.tweens.killTweensOf(objs.sprite);
        objs.container.destroy();
        this.players.delete(id);
        this.deathSeen.delete(id);
        this.humanTracks.delete(id);
        this.botTracks.delete(id);
        this.botClocks.delete(id);
        this.ingested.delete(id);
      }
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
    const tint = COLORS[colorIdx] ?? 0xff_ff_ff;

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
        backgroundColor: "rgba(8,10,26,0.55)",
        color: labelColor(isMe, isBot),
        fontFamily: "ui-monospace, monospace",
        fontSize: "13px",
        fontStyle: isMe ? "bold" : "normal",
        padding: { bottom: 1, left: 4, right: 4, top: 1 },
      })
      .setOrigin(0.5, 1);
    children.push(shadow, ring, body, label);

    // Bright bobbing marker over the local player so you can pick yourself out
    // among identical bots.
    let marker: Phaser.GameObjects.Triangle | null = null;
    if (isMe) {
      marker = this.add
        .triangle(0, -TILE * 0.82, -9, -6, 9, -6, 0, 7, 0xff_e1_4a)
        .setStrokeStyle(2, 0x1a_14_30, 1);
      if (!this.reducedMotion) {
        this.tweens.add({
          duration: 520,
          ease: "Sine.InOut",
          repeat: -1,
          targets: marker,
          y: -TILE * 0.92,
          yoyo: true,
        });
      }
      children.push(marker);
    }

    const container = this.add.container(colX(col), rowY(row), children).setDepth(10);
    const objs: PlayerObjs = {
      action: new CharacterAction(),
      actionFrame: null,
      anim: null,
      body,
      col,
      container,
      dir: "down",
      label,
      marker,
      moving: false,
      ring,
      row,
      sprite,
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
    const { sprite } = objs;
    const action = objs.action.sample(this.characterTime, { col, dir, moving, row }, true);
    if (action) {
      const frame = `${action.key}:${action.frame}:${action.flip}`;
      if (objs.actionFrame !== frame) {
        sprite.anims.stop();
        sprite.setTexture(action.key, action.frame).setScale(action.scale);
        sprite.setPosition(0, TILE * 0.34).setFlipX(action.flip);
        objs.actionFrame = frame;
      }
      objs.anim = null;
      return;
    }
    if (objs.actionFrame !== null) {
      // setTexture below restores the original 256px walk frame before sizing.
      objs.actionFrame = null;
      objs.anim = null;
      sprite.setTexture("player-down", 0).setOrigin(0.5);
      sprite.setPosition(0, -TILE * 0.06).setDisplaySize(TILE * 0.95, TILE * 0.95);
    }
    // Movers call this every frame: touch the sprite only when the walk changes.
    const anim = `${dir}:${moving}`;
    if (objs.anim === anim) {
      return;
    }
    objs.anim = anim;
    sprite.setFlipX(dir === "left");
    if (moving) {
      const key = walkAnim(dir);
      if (sprite.anims.currentAnim?.key !== key || !sprite.anims.isPlaying) {
        sprite.anims.play(key, true);
      }
    } else {
      sprite.anims.stop();
      sprite.setTexture(playerTexture(dir), 0);
    }
  }

  // ---- host-only logic -----------------------------------------------------

  /**
   * The sim on a fixed step of sim time — exact strides and fuses at any
   * frame rate. Every write in a frame leaves as one message, so a frame
   * stops at a step that turned the bots and leaves the rest for the next:
   * two turns in one message would reach guests as one two-tile jump.
   */
  private hostSteps(): void {
    const shared = this.shared();
    const id = this.myId;
    if (!shared || !id) {
      return;
    }
    const world = { ...shared };
    const humans = this.humans();
    const now = simNow();
    let stepped = false;
    for (let at = this.hostStep.next(now); at !== null; at = this.hostStep.next(now)) {
      stepped = true;
      const { patch } = simHostTick(world, humans, at, this.random);
      if (patch) {
        Object.assign(world, patch);
        this.netPatchShared(patch);
      }
      if (patch?.bots) {
        break;
      }
    }
    if (!stepped) {
      return;
    }
    // Claims granted since the last step: this client's own (see onClaimHeard),
    // and a new host's inherited ones.
    const granted = this.pickupClaims.settle(this.client, world, id);
    if (granted) {
      Object.assign(world, granted);
      this.netPatchShared(granted);
    }
    // Bots take power-ups the way players do, through the room. The sprite goes
    // on the next sync, while the claim still names the bot that took it.
    for (const bot of Object.values(world.bots)) {
      if (!world.deaths[bot.id] && this.pickupClaims.reach(this.client, world, bot.id, bot)) {
        this.netDirty = true;
      }
    }
  }

  /** Connected humans with their authoritative grid positions, for the sim. */
  private humans(): Human[] {
    return Object.entries(this.peers).map(([id, player]) => {
      const ps = readPlayerState(player);
      const pos =
        ps.col !== undefined && ps.row !== undefined ? { col: ps.col, row: ps.row } : null;
      return { id, pos };
    });
  }

  /** A guest's press. Written at once, outside the step, so the guest's
   *  prediction is confirmed a bare round trip after the key went down. */
  private hostPlaceBomb(ownerId: string, press: GuestPress): void {
    const s = this.shared();
    if (!s) {
      return;
    }
    const { col, row, localId } = press;
    const bombs = placeBomb(s, ownerId, col, row, fuseStart(press.pressedAt, simNow()), localId);
    if (bombs) {
      this.netPatchShared({ bombs });
    }
  }

  // ---- visual effects ------------------------------------------------------

  private playDeath(objs: PlayerObjs): void {
    this.resetPlayerFeedback(objs);
    objs.ring.setVisible(false);
    objs.marker?.setVisible(false);
    this.burst(objs.container.x, objs.container.y, 0xff_ff_ff, 22);
    this.tweens.add({
      alpha: 0.2,
      angle: 540,
      duration: 460,
      ease: "Cubic.In",
      scale: 0,
      targets: objs.sprite,
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
    objs.container.setPosition(colX(col), rowY(row));
    objs.col = col;
    objs.row = row;
  }

  /** One cosmetic child tween; authored sprite frames and movement stay owned
   * by applyAnim/updateMovers. Cancel before death, removal and round reset. */
  private pulsePlayer(id: string | null, kind: "place" | "pickup"): void {
    const objs = id ? this.players.get(id) : undefined;
    if (!objs || !this.isAlive(id)) {
      return;
    }
    this.clearBodyFeedback(objs);
    objs.sprite.setTint(kind === "pickup" ? 0xff_ef_b4 : 0xff_ff_ff);
    this.tweens.add({
      targets: objs.body,
      ...(this.reducedMotion
        ? { alpha: { from: 0.7, to: 1 }, duration: 180 }
        : { duration: 90, scaleX: 1.08, scaleY: 0.92, y: kind === "pickup" ? -5 : 2, yoyo: true }),
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
    this.burst(colX(col), rowY(row), 0xc7_8a_4a, 5);
  }

  private updateCharacterActions(delta: number): void {
    // Phaser's absolute time jumps across loop.sleep(); this owned visual clock
    // only advances rendered frames and never consumes a pause as clip time.
    this.characterTime += Math.max(0, Math.min(delta, 50));
    if (this.winnerAction && this.characterTime - this.winnerAction.at >= VICTORY_ACTION_MS) {
      this.winnerAction = null;
    }
  }

  /** Fuse tells tick with the pause-aware simulation clock, independent of
   * snapshot arrivals. Sparks shorten their interval as the fuse runs down. */
  private updateBattleFeel(delta: number): void {
    this.battleFx?.update(delta);
    this.updateCharacterActions(delta);
    const now = simNow();
    this.updateBlastFrames(now);
    const state = this.shared();
    const bombs = this.visibleBombs();
    this.roundHud.updateBombs(bombs, this.myId, this.myStats().bombs, now);
    const fighting =
      this.started &&
      this.live &&
      !this.controlsPaused &&
      state?.winner === null &&
      this.isAlive(this.myId);
    this.roundHud.update(now, fighting);
    updateRoundScore(roundScoreMode(fighting, this.aliveCount), now);
    if (this.pickupUntil > 0 && now >= this.pickupUntil) {
      this.clearPickupNote();
    }
    this.syncRestartButton();
    for (const bomb of Object.values(bombs)) {
      const visual = this.bombSprites.get(bomb.id);
      if (visual) {
        this.animateFuse(visual, bomb.placedAt, now, delta);
      }
    }
  }

  private animateFuse(visual: BombObjs, placedAt: number, now: number, delta: number): void {
    const { sprite, fuse } = visual;
    const left = Math.max(0, FUSE_MS - (now - placedAt));
    const progress = Math.min(1, left / FUSE_MS);
    const age = Math.max(0, now - placedAt);
    const urgency = 1 - progress;
    const pulse = this.reducedMotion ? 0 : Math.sin(age * 0.01 + urgency * urgency * 10) * 0.055;
    const arrival = this.reducedMotion ? 1 : Math.min(1, 0.75 + age / 640);
    sprite.setDisplaySize(TILE * 0.92 * (1 + pulse) * arrival, TILE * 0.92 * (1 - pulse) * arrival);
    fuse.clear().lineStyle(2.5, left < 700 ? 0xff_76_50 : 0xff_d2_7a, 0.8);
    if (progress > 0) {
      fuse
        .beginPath()
        .arc(0, 3, TILE * 0.46, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress)
        .strokePath();
    }
    if (left < 700 && (this.reducedMotion || Math.floor(left / 110) % 2 === 0)) {
      sprite.setTint(0xff_4d_4d);
    } else {
      sprite.clearTint();
    }
    const interval = this.reducedMotion ? 220 : 65 + 120 * (left / FUSE_MS);
    if (this.started && Math.random() < Math.min(delta, 50) / interval) {
      this.battleFx?.fuse(
        sprite.x + sprite.displayWidth * 0.4,
        sprite.y - sprite.displayHeight * 0.4,
      );
    }
  }

  private burst(x: number, y: number, tint: number, count: number): void {
    if (!this.sparkEmitter) {
      return;
    }
    this.sparkEmitter.setParticleTint(tint);
    this.sparkEmitter.explode(count, x, y);
  }

  private shakeIfNear(tiles: { col: number; row: number }[]): void {
    const near = tiles.some(
      (t) => Math.abs(t.col - this.myCol) + Math.abs(t.row - this.myRow) <= 3,
    );
    if (near && !this.reducedMotion) {
      this.cameras.main.shake(110, 0.005);
    }
  }

  // ---- helpers -------------------------------------------------------------

  /** This client's stats, counting the power-ups it claimed before the host settles them. */
  private myStats(): PlayerStats {
    const id = this.myId;
    const s = this.shared();
    return id && s ? this.pickupClaims.stats(s, id) : baseStats();
  }

  /** The board as this player reads it: power-ups still up for grabs, its own stats as claimed. */
  private playerView(state: SharedState, id: string): SharedState {
    return {
      ...state,
      powerups: this.pickupClaims.visible(this.client, state),
      stats: { ...state.stats, [id]: this.pickupClaims.stats(state, id) },
    };
  }

  /** The first placement after the start screen. Once placed, the body is
   *  this client's own: nothing read back from the room moves it. */
  private ensureMySpawn(): void {
    const id = this.myId;
    if (!id || this.ownSpawned) {
      return;
    }
    const ps = readPlayerState(this.peers[id]);
    if (ps.col !== undefined && ps.row !== undefined) {
      this.placeSelf(ps.col, ps.row);
      return;
    }
    const idx = Object.keys(this.peers).indexOf(id);
    if (idx === -1) {
      return;
    }
    const spawn = SPAWN_POINTS[idx] ?? SPAWN_POINTS[0];
    this.placeSelf(spawn.col, spawn.row);
    this.publishSpawn(spawn.col, spawn.row, idx);
  }

  /** The host's bombs plus this guest's presses it has not confirmed yet. */
  private visibleBombs(): Record<string, Bomb> {
    return this.prediction.visible(this.shared()?.bombs ?? {});
  }

  /** Open floor with no bomb on it — this client's unconfirmed bombs block too. */
  private passable(col: number, row: number): boolean {
    const s = this.shared();
    if (!s) {
      return false;
    }
    if (s.grid[row]?.[col]?.kind !== "empty") {
      return false;
    }
    return !bombOn(this.visibleBombs(), col, row);
  }

  private isAlive(id: string | null): boolean {
    if (!id) {
      return false;
    }
    const s = this.shared();
    if (!s) {
      return true;
    }
    return !s.deaths[id];
  }

  /** A whole round, every field written. Last round's power-up claims go:
   *  their keys name the round, but a room holds only so many. */
  private writeShared(next: SharedState): void {
    this.netPatchShared(next);
    if (this.amHost) {
      this.client.clearClaims(PICKUP_CLAIMS);
    }
  }

  // ---- start screen --------------------------------------------------------

  /** The one place controls are taught. Dismissed on the first key/pointer
   *  RELEASE, not press: the keydown handlers below stay live behind the
   *  overlay, so starting on keydown would let the same SPACE also drop a bomb. */
  private buildStartScreen(): void {
    this.startEl = document.querySelector("#start");
    const controls = document.querySelector("#start-controls");
    const go = document.querySelector("#start-go");
    // Same grouped keycap rows the pause overlay renders — the two teaching
    // surfaces stay visually consistent by construction.
    ensureControlsStyle();
    const renderControls = (): void => {
      if (!controls) {
        return;
      }
      const card = buildControls(TOUCH_UI);
      controls.replaceChildren(...(card ? [card] : []));
    };
    renderControls();
    // Plugging in a pad while the start screen is up adds its rows.
    this.unwatchControls?.();
    this.unwatchControls = watchControlContext(() => {
      if (!this.started) {
        renderControls();
      }
    });
    if (go) {
      go.textContent = TOUCH_UI
        ? "Drag to move · tap the bomb button"
        : "Or release any key to play";
    }
    // Reveals the overlay now that the column is complete — see #start in index.html.
    this.startEl?.classList.add("ready");
    this.input.keyboard?.on("keyup", this.onStartKeyUp, this);
    // The overlay covers the canvas, so Phaser's pointer input never sees the
    // tap — listen on the overlay element itself.
    // Backdrop only: taps inside the card belong to its buttons and scroll area.
    this.startEl?.addEventListener("pointerup", (event) => {
      if (event.target === this.startEl) {
        this.beginPlay();
      }
    });
    document.querySelector("#start-play")?.addEventListener("click", () => this.beginPlay());
  }

  private onStartKeyUp(event: KeyboardEvent): void {
    if (event.key === "Tab" || event.key === "Escape") {
      return;
    }
    if (event.target instanceof HTMLElement && event.target.closest("button, #start-reading")) {
      return;
    }
    this.beginPlay();
  }

  private beginPlay(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    // spawn immediately, even if the room has no new traffic
    this.netDirty = true;
    this.padArmed = false;
    this.input.keyboard?.off("keyup", this.onStartKeyUp, this);
    this.unwatchControls?.();
    this.unwatchControls = null;
    // Escape is the only other way to pause, so a phone has none. Mounted here
    // rather than in create() because the button outranks the start screen's
    // z-index: offered before play begins it would pause a game that hasn't
    // started, over the one overlay that teaches the controls.
    unlockAudio();
    this.touchControls = createTouchControls();
    this.gamepad.setVisible(true);
    notifyGameStarted();
    this.startEl?.classList.add("hide");
    if (this.startEl) {
      this.startEl.inert = true;
    }
    // Drop it only after the fade, so it can't swallow taps on the way out.
    this.time.delayedCall(320, () => this.startEl?.remove());
  }

  // ---- HUD -----------------------------------------------------------------

  private statusText(): string {
    if (!this.live) {
      // Not admitted yet (or admitted, with the room's clock still coming in),
      // or admitted before and redialling while the room holds the seat.
      return this.client.connectionStatus === "reconnecting" ? "reconnecting…" : "connecting…";
    }
    const s = this.shared();
    const restart = TOUCH_UI ? "tap to restart" : "press R";
    if (s?.winner) {
      return `Round over — ${restart}`;
    }
    if (this.started && !this.isAlive(this.myId)) {
      return `Out · round continues`;
    }
    // Live play: connection state only. Controls belong on the start screen.
    if (this.offline) {
      return "solo · offline";
    }
    return this.amHost ? "host" : "guest";
  }

  private syncRoster(fighters: readonly Fighter[]): void {
    this.roundHud.updateRoster(
      fighters.map((fighter) => ({
        alive: this.isAlive(fighter.id),
        colorIdx: fighter.colorIdx,
        id: fighter.id,
        isBot: fighter.isBot,
        isLocal: fighter.isLocal,
        label: this.labelFor(fighter.id),
      })),
    );
  }

  private setBanner(): void {
    if (!this.bannerEl) {
      return;
    }
    this.observeWinner(this.shared()?.winner ?? null);
    const state = this.roundPresentation();
    this.bannerEl.hidden = state.kind === "hidden";
    this.bannerEl.setAttribute("aria-hidden", String(state.kind === "hidden"));
    if (state.kind === "hidden") {
      this.lastBanner = null;
      return;
    }
    const title = BANNER_TITLE[state.kind];
    const detail = bannerDetail(state);
    const shared = Object.keys(this.peers).length > 1;
    const note = shared
      ? "Restart starts a new round for everyone."
      : "Fresh crates. Fresh chances.";
    const key = `${state.kind}|${title}|${detail}|${note}`;
    if (key !== this.lastBanner) {
      this.lastBanner = key;
      this.bannerEl.dataset.outcome = state.kind;
      writeUiText(
        "round-eyebrow",
        state.kind === "eliminated" ? "STILL IN PROGRESS" : "ROUND RESULT",
      );
      writeUiText("round-title", title);
      writeUiText("round-detail", detail);
      writeUiText("round-note", note);
    }
    this.syncRestartButton();
  }

  /** Fire the one-shot outcome cues (victory action, jingle) on the edge. */
  private observeWinner(winner: string | null): void {
    if (winner === this.observedWinner) {
      return;
    }
    const freshOutcome = this.observedWinner === null && winner !== null;
    this.observedWinner = winner;
    if (!freshOutcome || !this.feedbackEnabled || winner === null) {
      return;
    }
    if (winner !== "draw") {
      this.winnerAction = { at: this.characterTime, id: winner };
    }
    if (this.myId) {
      sfx.win(outcomeFor(winner, this.myId));
    }
  }

  private roundPresentation(): RoundPresentation {
    const s = this.shared();
    const id = this.myId;
    if (!this.started || !this.live || !s || !id) {
      return { kind: "hidden" };
    }
    if (s.winner) {
      return {
        kind: outcomeFor(s.winner, id),
        winner: this.labelFor(s.winner),
      };
    }
    if (this.isAlive(id)) {
      return { kind: "hidden" };
    }
    const ids = [...Object.keys(this.peers), ...Object.keys(s.bots ?? {})];
    return { kind: "eliminated", remaining: ids.filter((fighter) => !s.deaths[fighter]).length };
  }

  private syncRestartButton(): void {
    const button = this.restartButton;
    if (!button) {
      return;
    }
    const disabled = this.restartableSince === null || simNow() - this.restartableSince < 600;
    if (button.disabled !== disabled) {
      button.disabled = disabled;
    }
  }

  private labelFor(id: string): string {
    if (id === this.myId) {
      return "you";
    }
    if (id.startsWith("bot-")) {
      return `CPU ${id.slice(4)}`;
    }
    return id.slice(0, 4);
  }

  private setStatus(text: string): void {
    if (!this.statusEl || text === this.lastStatus) {
      return;
    }
    this.lastStatus = text;
    this.statusEl.textContent = text;
  }

  /** Range + speed only; bomb stock ticks every frame in RoundHud. */
  private setStats(): void {
    if (!this.statsEl) {
      return;
    }
    const alive = this.isAlive(this.myId);
    const stats = this.myStats();
    const speedLvl = Math.round((BASE_MOVE_MS - stats.speed) / SPEED_STEP_MS);
    const key = alive ? `${stats.range}|${speedLvl}` : "";
    if (key === this.lastStats) {
      return;
    }
    this.lastStats = key;
    this.statsEl.hidden = !alive;
    if (!alive) {
      return;
    }
    writeUiText("stat-fire", String(stats.range));
    writeUiText("stat-speed", String(speedLvl));
  }
}
