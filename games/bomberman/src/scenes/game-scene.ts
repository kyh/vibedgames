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
import type { TestHooks } from "@vibedgames/playtest";
import type Phaser from "phaser";
import { BlendModes, Input, Math as PhaserMath, Scale, Scene, Scenes } from "phaser";
import { createArena, readArena } from "../shared/arena";
import type { Arena } from "../shared/arena";
import { BattleFx } from "../fx/battle-fx";
import { CharacterAction, VICTORY_ACTION_MS } from "../render/character-action";
import { blastFrame, fireCells, freshCue } from "../render/blast-frame";
import { BotStride } from "../render/bot-stride";
import { RoundHud } from "../render/round-hud";
import { DirInput, stickDirs } from "../input/dir-input";
import { BombPrediction, fuseStart } from "../net/bomb-prediction";
import { TurnTrack } from "../net/bot-track";
import { PICKUP_CLAIMS, PickupClaims, pickupKey } from "../net/pickup-claims";
import { StepTrack, WALK_GRACE_MS } from "../net/step-track";
import { playtestManifest } from "../playtest-manifest";
import type { BombermanDiagnostics } from "../playtest-manifest";
import { bombOn } from "../sim/burn-map";
import { FixedStep } from "../sim/fixed-step";
import { bombId, hostTick as simHostTick, placeBomb } from "../sim/host-sim";
import { PlaytestScore, playtestView } from "../sim/playtest-view";
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
    __GAME_TEST_HOOKS__?: TestHooks;
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

interface Fighter {
  id: string;
  col: number;
  row: number;
  colorIdx: number;
  isBot: boolean;
  isLocal: boolean;
  order: number;
}

const poseOf = ({ col, row, dir, moving }: PlayerObjs) => ({
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

const ROOM_PARAM = new URLSearchParams(location.search).get("room");
const ROOM = ROOM_PARAM === null || ROOM_PARAM === "" ? "bomberman-v4" : ROOM_PARAM;
const SOLO_PLAYTEST = isPlaytestRequested() && !new URLSearchParams(location.search).has("room");
const BOMB_BUTTON_INSET = 84;
const BOMB_BUTTON_RADIUS = 52;

const MAX_CARRY_MS = 50;
const MAX_FRAME_MS = 250;
const CAMERA_FOLLOW_MS = 96;

/** Detected at boot (not on first touch) so the first HUD paint already shows
 *  touch-worded hints on phones. */
export const TOUCH_UI = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;

const FLOOR_PAD = TILE * 20;

const colX = (col: number) => col * TILE + TILE / 2;
const rowY = (row: number) => row * TILE + TILE / 2;

const nearestTile = (
  tiles: readonly { col: number; row: number }[],
  listenerX: number,
  listenerY: number,
  seed: { distance: number; x: number } | null,
) => {
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

const playerTexture = (dir: Dir) => {
  if (dir === "up") {
    return "player-up";
  }

  return dir === "down" ? "player-down" : "player-side";
};

const walkAnim = (dir: Dir) => {
  if (dir === "up") {
    return "walk-up";
  }

  return dir === "down" ? "walk-down" : "walk-side";
};

const roundScoreMode: (fighting: boolean, aliveCount: number) => "duel" | "playing" | "silent" = (
  fighting,
  aliveCount,
) => {
  if (!fighting) {
    return "silent";
  }

  return aliveCount === 2 ? "duel" : "playing";
};

const writeUiText = (id: string, text: string) => {
  const el = document.querySelector(`#${id}`);

  if (el && el.textContent !== text) {
    el.textContent = text;
  }
};

const outcomeFor: (winner: string, myId: string | null) => "draw" | "won" | "lost" = (
  winner,
  myId,
) => {
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

const bannerDetail = (state: Exclude<RoundPresentation, { kind: "hidden" }>) => {
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

    case "lost": {
      return `${state.winner} wins the round.`;
    }

    default: {
      const unhandled: never = state;
      throw new Error("unknown round presentation", { cause: unhandled });
    }
  }
};

const labelColor = (isMe: boolean, isBot: boolean) => {
  if (isMe) {
    return "#ffffff";
  }

  return isBot ? "#ffd0d0" : "#dfe6ff";
};

const emptyShared: (arena?: Arena, random?: () => number) => SharedState = (
  arena = "classic",
  random = Math.random,
) => ({
  arena,
  blasts: {},
  bombs: {},
  bots: {},
  deaths: {},
  grid: createArena(arena, random),
  powerups: {},
  startedAt: Math.round(simNow()),
  stats: {},
  winner: null,
});

type WireField = JsonValue | undefined;

const isJsonObject = (v: WireField): v is JsonRecord =>
  Object.prototype.toString.call(v) === "[object Object]";

const isJsonNumber = (v: WireField): v is number => Number.isFinite(v);

const isShared = (v: MultiplayerClient["sharedState"]): v is SharedState =>
  isJsonObject(v) && Array.isArray(v.grid);

type PartialPS = Partial<PlayerState>;

const readPlayerState = (player: Player | undefined) => {
  const s = player?.state;

  if (!s) {
    return {};
  }

  const num = (k: string) => {
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

const isLocalId = (v: WireField): v is number => Number.isSafeInteger(v) && Number(v) > 0;

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
  private readonly bombSprites = new Map<string, BombObjs>();
  private readonly blastSprites = new Map<string, BlastObjs>();
  private readonly blastSeen = new Set<string>();
  private readonly powerupObjs = new Map<
    string,
    { container: Phaser.GameObjects.Container; pickup: Powerup }
  >();
  private readonly players = new Map<string, PlayerObjs>();
  private readonly deathSeen = new Set<string>();
  private winnerAction: { id: string; at: number } | null = null;
  private characterTime = 0;
  private followStarted = false;

  myCol = 0;
  myRow = 0;
  private myDir: Dir = "down";
  private stepFrom = { col: 0, row: 0 };
  private stepStartedAt = 0;
  private stepEndsAt = 0;
  private ownSpawned = false;
  private frameAt = 0;
  private readonly dirInput = new DirInput();
  private localBombSeq = 1;
  private readonly prediction = new BombPrediction();
  readonly pickupClaims = new PickupClaims();
  private readonly hostStep = new FixedStep(HOST_STEP_MS, MAX_FRAME_MS);

  private readonly humanTracks = new Map<string, StepTrack>();
  private readonly botTracks = new Map<string, BotStride | TurnTrack>();
  private readonly botClocks = new Map<string, RemoteClock>();
  private readonly ingested = new Map<string, string>();
  private ingestRound: number | null = null;
  private botSender: string | null = null;
  private ownDrop = false;
  private readonly beat = new FixedRate(PLAYER_BEAT_HZ);

  private heldKeys!: Record<Dir, [Phaser.Input.Keyboard.Key, Phaser.Input.Keyboard.Key]>;
  private gamepad!: PhaserGamepad;
  private readonly pad = new PhysicalGamepad();
  private padArmed = true;
  private touchControls: TouchControls | null = null;
  private unwatchControls: (() => void) | null = null;
  private restartableSince: number | null = null;

  private statusEl: HTMLElement | null = null;
  private readonly roundHud = new RoundHud();
  private statsEl: HTMLElement | null = null;
  private bannerEl: HTMLElement | null = null;
  private startEl: HTMLElement | null = null;
  private pickupNoteEl: HTMLElement | null = null;
  private restartButton: HTMLButtonElement | null = null;
  private observedWinner: string | null = null;
  started = false;
  private lastStatus: string | null = null;
  private lastStats: string | null = null;
  private lastBanner: string | null = null;

  private netDirty = true;
  private clockAuthority = false;
  simulationFrozen = false;

  private sparkEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private battleFx: BattleFx | null = null;
  private presentationRound: number | null = null;
  private feedbackEnabled = false;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private pickupUntil = 0;
  private frame = 0;
  private random: () => number = Math.random;
  private readonly playtestScore = new PlaytestScore();
  private diagnosticsAt = -1;
  private diagnosticsValue: BombermanDiagnostics | null = null;
  private aliveCount = 0;
  controlsPaused = false;

  /** The wrapper pause owns local input; a connected host keeps the other
   *  fighters running. The embed key gate swallows keyup while paused, so
   *  held keys would otherwise stick down. */
  setPresentationPaused(paused: boolean) {
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

  private roomWasReady = false;

  private get offline() {
    return this.client.connectionStatus === "offline";
  }

  private get roomReady() {
    return this.client.connectionStatus === "connected" && this.client.serverClock.synced;
  }

  private get live() {
    return this.offline || this.roomReady;
  }

  /**
   * True when freezing the sim is safe: solo-offline, or connected but the only
   * human in the room. False when other humans share the arena — freezing a
   * wall-clock sim would stall them. Mirrors the `soloArena` gate in update();
   * read by the wrapper pause handler in main.ts.
   */
  get freezable() {
    return Object.keys(this.peers).length <= 1;
  }

  private get amHost() {
    return this.live && this.client.isHost;
  }

  /** Freeze a solo simulation. The paused stamp goes out before the loop
   *  sleeps so a later joiner (or a promoted host) inherits the same sim time. */
  pauseSimulation() {
    if (!this.freezable || this.simulationFrozen) {
      return;
    }

    pauseClock();
    this.simulationFrozen = true;
    this.netPatchShared({});
    this.game.loop.sleep();
  }

  resumeSimulation() {
    if (!this.simulationFrozen) {
      return;
    }

    this.simulationFrozen = false;
    resumeClock();
    this.netPatchShared({});
    this.game.loop.wake();
  }

  private syncSharedClock() {
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
      this.simulationFrozen = false;
      resumeClock();
      this.netPatchShared({});
      this.game.loop.wake();
    }
  }

  get myId() {
    return this.client.playerId;
  }

  private get peers() {
    const present: typeof this.client.players = {};

    for (const [id, player] of Object.entries(this.client.players)) {
      if (player.connected !== false) {
        present[id] = player;
      }
    }

    return present;
  }

  netPatchShared(patch: Partial<SharedState>) {
    this.netDirty = true;

    if (this.amHost) {
      this.client.updateSharedState({ ...patch, clock: clockStamp() });
    }
  }

  private watchRoomClock() {
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

  create() {
    this.statusEl = document.querySelector("#status");
    this.statsEl = document.querySelector("#stats");
    this.bannerEl = document.querySelector("#banner");
    this.pickupNoteEl = document.querySelector("#pickup-note");
    const restart = document.querySelector("#round-restart");
    this.restartButton = restart instanceof HTMLButtonElement ? restart : null;
    this.buildStartScreen();
    this.restartButton?.addEventListener("click", () => {
      this.requestRestart();
    });

    for (const type of ["pointerdown", "pointerup"]) {
      this.bannerEl?.addEventListener(type, (event) => {
        event.stopPropagation();
      });
    }

    for (const type of ["keydown", "keyup"]) {
      this.bannerEl?.addEventListener(type, (event) => {
        if (event instanceof KeyboardEvent && (event.key === " " || event.key === "Enter")) {
          event.stopPropagation();
        }
      });
    }

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

    this.client = new MultiplayerClient({
      fallbackMs: OFFLINE_FALLBACK_MS,
      host: MULTIPLAYER_HOST,
      limits: PLAYER_LIMITS,
      maxPlayers: MAX_PLAYERS,
      offline: isOfflineRequested() || SOLO_PLAYTEST,
      onClaim: (key, owner) => {
        this.onClaimHeard(key, owner);
      },
      onEvent: (event, payload, from) => {
        this.handleEvent(event, payload, from);
      },
      party: "vg-server",
      room: ROOM,
    });
    setClockBase(this.client.serverClock);
    this.client.subscribe(() => {
      this.watchOwnConnection();
      this.syncSharedClock();
      this.ingestNet();
      this.netDirty = true;
    });
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

    publishDiagnostics(() => this.diagnostics());

    if (import.meta.env.DEV || isPlaytestRequested()) {
      publishTestHooks({
        seed: (seed) => {
          this.reseed(seed);
        },
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

  private reseed(seed: number) {
    if (!this.offline) {
      throw new Error("Cannot reseed a shared arena");
    }

    this.random = seededRandom(seed);
    this.playtestScore.reset();
    const next = emptyShared("classic", this.random);
    next.startedAt = Math.max(next.startedAt, (this.shared()?.startedAt ?? 0) + 1);
    this.writeShared(next);
  }

  private readonly applyZoom = () => {
    const zoom = PhaserMath.Clamp(
      Math.min(this.scale.height / (9.5 * TILE), this.scale.width / (7.5 * TILE)),
      0.6,
      2.4,
    );

    this.cameras.main.setZoom(zoom);
  };

  override update(_time: number, delta: number) {
    const now = performance.now();
    const elapsed = this.frameAt === 0 ? 0 : Math.min(MAX_FRAME_MS, now - this.frameAt);
    this.frame += 1;
    this.watchRoomClock();

    if (this.prediction.settle(this.shared()?.bombs ?? {}, now)) {
      this.netDirty = true;
    }

    if (this.netDirty) {
      this.netDirty = false;
      this.onUpdate();
    }

    this.updateBattleFeel(delta);
    this.pollPad();

    if (this.live) {
      this.gamepad.update();
      this.applyPadActions();
      this.handleInput(now);
      this.sendBeat(elapsed, now);
      this.claimUnderfoot();
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

  private observeScore() {
    const state = this.shared();
    const id = this.myId;

    if (state && id !== null && id !== "") {
      this.playtestScore.observe(state, id);
    }
  }

  private playtestPhase() {
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

  private diagnostics() {
    if (this.diagnosticsValue && this.diagnosticsAt === this.frame) {
      return this.diagnosticsValue satisfies BombermanDiagnostics;
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
      rivalsAlive: Object.values(state?.bots ?? {}).filter(
        (bot) => (state?.deaths[bot.id] ?? 0) === 0,
      ).length,
      score: this.playtestScore.points,
    };

    const value =
      phase === "playing" && state && id !== null && id !== ""
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

    return value satisfies BombermanDiagnostics;
  }

  private pollPad() {
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

  private applyPadActions() {
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

  private updateCamera(elapsed: number) {
    const id = this.myId;

    if (id === null || id === "") {
      return;
    }

    const me = this.players.get(id);

    if (!me) {
      return;
    }

    const cam = this.cameras.main;
    const halfW = cam.width / (2 * cam.zoom);
    const halfH = cam.height / (2 * cam.zoom);
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

  private bindInput() {
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
      visible: "coarse",
    });
    this.gamepad.setVisible(false);

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

    k.on("keydown-SPACE", () => {
      this.requestBomb();
    });
    k.on("keydown-B", () => {
      this.requestBomb();
    });
    k.on("keydown-R", () => {
      this.requestRestart();
    });
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

  private handleInput(now: number) {
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
    const t = Math.round(this.client.serverNow(now) - (now - start));
    this.client.updateMyState({ col: this.myCol, row: this.myRow, s: stride, t });
  }

  private sendBeat(elapsed: number, now: number) {
    if (
      this.beat.due(elapsed) &&
      this.ownSpawned &&
      this.roomReady &&
      Object.keys(this.peers).length > 1
    ) {
      this.client.updateMyState({ h: Math.round(this.client.serverNow(now)) });
    }
  }

  private dirHeld(dir: Dir) {
    if (this.heldKeys?.[dir].some((key) => key.isDown)) {
      return true;
    }

    return this.pad.connected && this.padArmed && this.pad.isButtonDown(dir);
  }

  private stickDirs() {
    const pad = this.pad.connected && this.padArmed ? stickDirs(this.pad.getStick()) : [];

    return [...pad, ...stickDirs(this.gamepad.getStick())] satisfies Dir[];
  }

  private ownPose(now: number) {
    if (!this.ownSpawned) {
      return null;
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

  requestBomb() {
    const id = this.myId;
    const state = this.shared();
    const pose = this.ownPose(performance.now());

    if (
      this.controlsPaused ||
      !this.live ||
      !this.started ||
      id === null ||
      id === "" ||
      !state ||
      !pose
    ) {
      return;
    }

    if (!this.isAlive(id)) {
      return;
    }

    const { col, row } = pose;
    const localId = this.localBombSeq;
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

  requestRestart() {
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

    this.client.sendToHost("request_restart", { round: state.startedAt });
  }

  private respawnSelf() {
    const id = this.myId;

    if (id === null || id === "") {
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

  private placeSelf(col: number, row: number) {
    this.myCol = col;
    this.myRow = row;
    this.myDir = "down";
    this.stepFrom = { col, row };
    this.stepStartedAt = 0;
    this.stepEndsAt = 0;
    this.ownSpawned = true;
  }

  private publishSpawn(col: number, row: number, idx: number) {
    this.client.updateMyState({
      col,
      colorIdx: idx % COLORS.length,
      row,
      s: 0,
      t: Math.round(this.client.serverNow()),
    });
  }

  private handleEvent(event: string, payload: JsonValue, from: string) {
    if (!this.amHost) {
      return;
    }

    if (event === "place_bomb") {
      const p = isJsonObject(payload) ? payload : null;
      const col = p?.col;
      const row = p?.row;
      const localId = p?.localId;
      const at = p?.at;
      const current = p?.round === this.shared()?.startedAt;

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

  private claimUnderfoot() {
    const id = this.myId;
    const state = this.shared();

    if (
      id === null ||
      id === "" ||
      !state ||
      !this.started ||
      !this.ownSpawned ||
      !this.isAlive(id)
    ) {
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
      this.statsEl.dataset.pickup = kind;
    }

    if (this.pickupNoteEl) {
      this.pickupNoteEl.textContent = `${kind.toUpperCase()} PICKUP`;
      this.pickupNoteEl.classList.add("on");
      this.pickupUntil = simNow() + 800;
    }
  }

  private onClaimHeard(key: string, owner: string | null) {
    const id = this.myId;
    const lost = id !== null && id !== "" ? this.pickupClaims.heard(key, owner, id) : null;

    if (lost?.fighter === id && this.statsEl?.dataset.pickup === lost.pickup.kind) {
      this.clearPickupNote();
    }

    if (owner !== null && owner !== id && this.amHost) {
      this.settlePickups();
    }

    this.netDirty = true;
  }

  private settlePickups() {
    const id = this.myId;
    const state = this.shared();

    const granted =
      id !== null && id !== "" && state ? this.pickupClaims.settle(this.client, state, id) : null;

    if (granted) {
      this.netPatchShared(granted);
    }
  }

  private hostRestart(payload: JsonValue) {
    const state = this.shared();

    if (!state || !isJsonObject(payload) || payload.round !== state.startedAt) {
      return;
    }

    const next = emptyShared(
      readArena(state.arena) === "classic" ? "crossroads" : "classic",
      this.random,
    );

    next.startedAt = Math.max(next.startedAt, state.startedAt + 1);
    this.writeShared(next);
  }

  private onUpdate() {
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

  private clearPickupNote() {
    this.pickupNoteEl?.classList.remove("on");
    this.pickupUntil = 0;
    delete this.statsEl?.dataset.pickup;
  }

  private trackRestartable() {
    const s = this.shared();
    const restartable = this.live && s !== null && (s.winner !== null || !this.isAlive(this.myId));

    if (restartable) {
      this.restartableSince ??= simNow();
    } else {
      this.restartableSince = null;
    }
  }

  /** The room's state, once it has the shape; tools/two-client.mts reads it too. */
  shared() {
    const state = this.client.sharedState;

    return isShared(state) ? state : null;
  }

  private watchOwnConnection() {
    const status = this.client.connectionStatus;

    if (status === "reconnecting") {
      this.ownDrop = true;
    } else if (status === "connected" && this.ownDrop) {
      this.ownDrop = false;

      for (const track of this.humanTracks.values()) {
        track.relearn();
      }

      for (const clock of this.botClocks.values()) {
        clock.relearn();
      }
    }
  }

  private ingestNet() {
    const state = this.shared();
    const botSender = this.amHost ? "self" : this.client.hostId;

    if (botSender !== this.botSender) {
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

  private ingestHuman(id: string, ps: PartialPS) {
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

  private ingestBot(bot: Bot) {
    const own = this.botSender === "self";
    const key = own ? `${bot.col},${bot.row}` : `${bot.col},${bot.row},${bot.nextMoveAt}`;

    if (this.ingested.get(bot.id) === key) {
      return;
    }

    this.ingested.set(bot.id, key);
    this.botTrack(bot.id, own).turn(bot, bot.nextMoveAt - BOT_MOVE_MS, bot.dir);
  }

  private botTrack(id: string, own: boolean) {
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

  private clearTracks(tracks: Map<string, BotStride | StepTrack | TurnTrack>) {
    for (const [id, track] of tracks) {
      track.clear();
      this.ingested.delete(id);
    }
  }

  private dropTracks(tracks: Map<string, BotStride | StepTrack | TurnTrack>) {
    for (const id of tracks.keys()) {
      this.ingested.delete(id);
    }

    tracks.clear();
  }

  private ensureSeeded() {
    if (this.amHost && !this.shared()) {
      this.writeShared(emptyShared("classic", this.random));
    }
  }

  private fighters() {
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

  private syncGrid() {
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

  private syncBombs() {
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

  private cueRemoteBomb(bomb: Bomb) {
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

  private syncBlasts() {
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

  private syncBlastSprites(cells: ReturnType<typeof fireCells>) {
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

  private cueFreshBlasts(blasts: readonly Blast[], now: number) {
    const cam = this.cameras.main;
    const centerX = cam.scrollX + cam.width / 2;
    const centerY = cam.scrollY + cam.height / 2;

    const local =
      this.myId === null || this.myId === "" ? undefined : this.players.get(this.myId)?.container;

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

  private updateBlastFrames(now: number) {
    for (const { fire, footprint, placedAt } of this.blastSprites.values()) {
      const frame = blastFrame(placedAt, now);
      fire.setVisible(frame !== null);
      footprint.setVisible(frame !== null);

      if (frame !== null) {
        fire.setFrame(frame);
      }
    }
  }

  private syncPowerups() {
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

  private cueTaken(s: SharedState, pickup: Powerup) {
    const key = pickupKey(s.startedAt, pickup);
    const taker = this.pickupClaims.fighterOf(key) ?? this.client.ownerOf(key);

    if (this.feedbackEnabled && taker !== null && taker !== this.myId) {
      this.burst(colX(pickup.col), rowY(pickup.row), POWERUP_GLOW[pickup.kind], 14);
    }
  }

  private syncPlayers(fighters: readonly Fighter[]) {
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

  private updateMovers(now: number) {
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

  private syncDeath(objs: PlayerObjs, f: Fighter, dead: boolean) {
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

  private syncCelebration(objs: PlayerObjs, f: Fighter) {
    const celebration = this.winnerAction;

    if (celebration?.id !== f.id) {
      return;
    }

    this.winnerAction = null;

    if (this.characterTime - celebration.at < VICTORY_ACTION_MS) {
      objs.action.victory(celebration.at, poseOf(objs));
    }
  }

  private dropDepartedPlayers(seen: ReadonlySet<string>) {
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
  ) {
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

  private applyAnim(objs: PlayerObjs, dir: Dir, moving: boolean, col = objs.col, row = objs.row) {
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
      objs.actionFrame = null;
      objs.anim = null;
      sprite.setTexture("player-down", 0).setOrigin(0.5);
      sprite.setPosition(0, -TILE * 0.06).setDisplaySize(TILE * 0.95, TILE * 0.95);
    }

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

  private hostSteps() {
    const shared = this.shared();
    const id = this.myId;

    if (!shared || id === null || id === "") {
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

    const granted = this.pickupClaims.settle(this.client, world, id);

    if (granted) {
      Object.assign(world, granted);
      this.netPatchShared(granted);
    }

    for (const bot of Object.values(world.bots)) {
      if (
        (world.deaths[bot.id] ?? 0) === 0 &&
        this.pickupClaims.reach(this.client, world, bot.id, bot)
      ) {
        this.netDirty = true;
      }
    }
  }

  private humans() {
    return Object.entries(this.peers).map(([id, player]) => {
      const ps = readPlayerState(player);

      const pos =
        ps.col !== undefined && ps.row !== undefined ? { col: ps.col, row: ps.row } : null;

      return { id, pos };
    });
  }

  private hostPlaceBomb(ownerId: string, press: GuestPress) {
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

  private playDeath(objs: PlayerObjs) {
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

  private reviveVisual(objs: PlayerObjs, col: number, row: number) {
    this.resetPlayerFeedback(objs);
    this.tweens.killTweensOf(objs.sprite);
    objs.sprite.setAngle(0).setAlpha(1).setScale(1);
    objs.sprite.setDisplaySize(TILE * 0.95, TILE * 0.95);
    objs.ring.setVisible(true);
    objs.marker?.setVisible(true);
    objs.container.setPosition(colX(col), rowY(row));
    objs.col = col;
    objs.row = row;
  }

  private pulsePlayer(id: string | null, kind: "place" | "pickup") {
    const objs = id !== null && id !== "" ? this.players.get(id) : undefined;

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
      onComplete: () => {
        objs.sprite.clearTint();
      },
    });
  }

  private resetPlayerFeedback(objs: PlayerObjs) {
    objs.action.reset();
    this.applyAnim(objs, objs.dir, false);
    this.clearBodyFeedback(objs);
  }

  private clearBodyFeedback(objs: PlayerObjs) {
    this.tweens.killTweensOf(objs.body);
    objs.body.setPosition(0, 0).setScale(1).setAlpha(1);
    objs.sprite.clearTint();
  }

  private crateBreak(col: number, row: number) {
    this.battleFx?.crate(colX(col), rowY(row), this.reducedMotion);
    this.burst(colX(col), rowY(row), 0xc7_8a_4a, 5);
  }

  private updateCharacterActions(delta: number) {
    this.characterTime += Math.max(0, Math.min(delta, 50));

    if (this.winnerAction && this.characterTime - this.winnerAction.at >= VICTORY_ACTION_MS) {
      this.winnerAction = null;
    }
  }

  private updateBattleFeel(delta: number) {
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

  private animateFuse(visual: BombObjs, placedAt: number, now: number, delta: number) {
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

  private burst(x: number, y: number, tint: number, count: number) {
    if (!this.sparkEmitter) {
      return;
    }

    this.sparkEmitter.setParticleTint(tint);
    this.sparkEmitter.explode(count, x, y);
  }

  private shakeIfNear(tiles: { col: number; row: number }[]) {
    const near = tiles.some(
      (t) => Math.abs(t.col - this.myCol) + Math.abs(t.row - this.myRow) <= 3,
    );

    if (near && !this.reducedMotion) {
      this.cameras.main.shake(110, 0.005);
    }
  }

  myStats() {
    const id = this.myId;
    const s = this.shared();

    return id !== null && id !== "" && s ? this.pickupClaims.stats(s, id) : baseStats();
  }

  private playerView(state: SharedState, id: string) {
    return {
      ...state,
      powerups: this.pickupClaims.visible(this.client, state),
      stats: { ...state.stats, [id]: this.pickupClaims.stats(state, id) },
    };
  }

  private ensureMySpawn() {
    const id = this.myId;

    if (id === null || id === "" || this.ownSpawned) {
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

  private visibleBombs() {
    return this.prediction.visible(this.shared()?.bombs ?? {});
  }

  private passable(col: number, row: number) {
    const s = this.shared();

    if (!s) {
      return false;
    }

    if (s.grid[row]?.[col]?.kind !== "empty") {
      return false;
    }

    return !bombOn(this.visibleBombs(), col, row);
  }

  private isAlive(id: string | null) {
    if (id === null || id === "") {
      return false;
    }

    const s = this.shared();

    if (!s) {
      return true;
    }

    return (s.deaths[id] ?? 0) === 0;
  }

  private writeShared(next: SharedState) {
    this.netPatchShared(next);

    if (this.amHost) {
      this.client.clearClaims(PICKUP_CLAIMS);
    }
  }

  private buildStartScreen() {
    this.startEl = document.querySelector("#start");
    const controls = document.querySelector("#start-controls");
    const go = document.querySelector("#start-go");
    ensureControlsStyle();

    const renderControls = () => {
      if (!controls) {
        return;
      }

      const card = buildControls(TOUCH_UI);
      controls.replaceChildren(...(card ? [card] : []));
    };

    renderControls();
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

    this.startEl?.classList.add("ready");
    this.input.keyboard?.on("keyup", this.onStartKeyUp, this);
    this.startEl?.addEventListener("pointerup", (event) => {
      if (event.target === this.startEl) {
        this.beginPlay();
      }
    });
    document.querySelector("#start-play")?.addEventListener("click", () => {
      this.beginPlay();
    });
  }

  private readonly onStartKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Tab" || event.key === "Escape") {
      return;
    }

    if (event.target instanceof HTMLElement && event.target.closest("button, #start-reading")) {
      return;
    }

    this.beginPlay();
  };

  private beginPlay() {
    if (this.started) {
      return;
    }

    this.started = true;
    this.netDirty = true;
    this.padArmed = false;
    this.input.keyboard?.off("keyup", this.onStartKeyUp, this);
    this.unwatchControls?.();
    this.unwatchControls = null;
    unlockAudio();
    this.touchControls = createTouchControls();
    this.gamepad.setVisible(true);
    notifyGameStarted();
    this.startEl?.classList.add("hide");

    if (this.startEl) {
      this.startEl.inert = true;
    }

    this.time.delayedCall(320, () => this.startEl?.remove());
  }

  private statusText() {
    if (!this.live) {
      return this.client.connectionStatus === "reconnecting" ? "reconnecting…" : "connecting…";
    }

    const s = this.shared();
    const restart = TOUCH_UI ? "tap to restart" : "press R";

    if (s !== null && s.winner !== undefined && s.winner !== null && s.winner !== "") {
      return `Round over — ${restart}`;
    }

    if (this.started && !this.isAlive(this.myId)) {
      return `Out · round continues`;
    }

    if (this.offline) {
      return "solo · offline";
    }

    return this.amHost ? "host" : "guest";
  }

  private syncRoster(fighters: readonly Fighter[]) {
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

  private setBanner() {
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

  private observeWinner(winner: string | null) {
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

    if (this.myId !== null && this.myId !== "") {
      sfx.win(outcomeFor(winner, this.myId));
    }
  }

  private roundPresentation() {
    const s = this.shared();
    const id = this.myId;

    if (!this.started || !this.live || !s || id === null || id === "") {
      return { kind: "hidden" } satisfies RoundPresentation;
    }

    if (s.winner !== null && s.winner !== "") {
      return {
        kind: outcomeFor(s.winner, id),
        winner: this.labelFor(s.winner),
      } satisfies RoundPresentation;
    }

    if (this.isAlive(id)) {
      return { kind: "hidden" } satisfies RoundPresentation;
    }

    const ids = [...Object.keys(this.peers), ...Object.keys(s.bots ?? {})];

    return {
      kind: "eliminated",
      remaining: ids.filter((fighter) => (s.deaths[fighter] ?? 0) === 0).length,
    } satisfies RoundPresentation;
  }

  private syncRestartButton() {
    const button = this.restartButton;

    if (!button) {
      return;
    }

    const disabled = this.restartableSince === null || simNow() - this.restartableSince < 600;

    if (button.disabled !== disabled) {
      button.disabled = disabled;
    }
  }

  private labelFor(id: string) {
    if (id === this.myId) {
      return "you";
    }

    if (id.startsWith("bot-")) {
      return `CPU ${id.slice(4)}`;
    }

    return id.slice(0, 4);
  }

  private setStatus(text: string) {
    if (!this.statusEl || text === this.lastStatus) {
      return;
    }

    this.lastStatus = text;
    this.statusEl.textContent = text;
  }

  private setStats() {
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
