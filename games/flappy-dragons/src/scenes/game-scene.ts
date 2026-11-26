import { Animations, Scale, Scene, Scenes, Sound, TintModes } from "phaser";
import type { GameObjects, Time, Types } from "phaser";
import { createTouchControls, notifyGameStarted, watchControlContext } from "@repo/embed";
import type { TouchControls } from "@repo/embed";
import { PhysicalGamepad, safeAreaInset } from "@vibedgames/gamepad";
import { FixedRate, HOST_LIVENESS_TIMEOUT_MS } from "@vibedgames/multiplayer";
import { isPlaytestRequested } from "@vibedgames/playtest";

import { CONTROLS } from "../controls";
import { buildControls, ensureStyle as ensureControlsStyle } from "../pause-overlay";
import { isCoarsePointer, recalibratePose, setPoseLocked } from "../input/camera";
import { courseStart, courseX, followCourse } from "../net/course";
import { RivalMotion } from "../net/rival-motion";
import { NetSession, isJsonNumber, isJsonObject } from "../net/session";
import { publishPlaytestSurface } from "../playtest";
import type { JsonValue, Player, PlayerMap } from "@vibedgames/multiplayer";
import { FlightFx, prefersReducedMotion } from "./flight-fx";
import {
  ART_SCALE,
  BEST_KEY,
  BG_FACTORS,
  BG_NATIVE_H,
  BIRD_H,
  BIRD_SPAWN_Y,
  BIRD_W,
  BIRD_X,
  coinPresentFor,
  coinYFor,
  COURSE_H,
  DIGIT_H,
  DIGIT_W,
  DRAGON_SKINS,
  DRAGON_SPRITE_OFFSET_X,
  DRAGON_SPRITE_OFFSET_Y,
  flapVelocityFor,
  GRAVITY,
  MIN_VIEW_W,
  MP_MAX_PLAYERS,
  MP_ROOM,
  NET_TICK_HZ,
  OFFLINE_FALLBACK_MS,
  PIPE_GAP,
  pipeCourseX,
  PIPE_SPAWN_DISTANCE,
  PIPE_SPEED,
  PIPE_WIDTH,
  READY_DRIFT,
  RESPAWN_MS,
  rollSkin,
  RUNWAY,
  SCORE_Y,
  SOUND_KEY,
  tiltFor,
  topHeightFor,
  TUBE_CAP_H,
} from "../shared/constants";
import type { Phase } from "../shared/constants";

interface Pipe {
  index: number;
  topHeight: number;
  topCap: GameObjects.Image;
  topBody: GameObjects.TileSprite;
  botCap: GameObjects.Image;
  botBody: GameObjects.TileSprite;
  coin: GameObjects.Sprite | null;
  glint: GameObjects.Image | null;
}

interface BgLayer {
  sprite: GameObjects.TileSprite;
  factor: number;
}

interface Ghost {
  sprite: GameObjects.Sprite;
  skin: number;
  gap: number;
  motion: RivalMotion;
  live: boolean | null;
  away: boolean;
  seen: number;
}

const COIN_PICKUP_X = 54;
const COIN_PICKUP_Y = 44;
const RESTART_LOCKOUT_MS = 280;
const RESULT_LAYOUT_MS = 250;
const GATE_MILESTONE = 10;
const PHRASE_NOTE_MS = 110;
const MAX_DT_MS = 50;
const MAX_RACE_STEP_MS = HOST_LIVENESS_TIMEOUT_MS;
const COURSE_LURCH_PX = PIPE_WIDTH + BIRD_W;
const READY_EASE = 5;
const GHOST_GAP_MIN = 30;
const GHOST_GAP_MAX = 68;
const GHOST_SCALE_MIN = 0.82;
const GHOST_SCALE_MAX = 1.06;

const TOUCH = isCoarsePointer();
const ROOM = (import.meta.env.DEV && new URLSearchParams(location.search).get("room")) || MP_ROOM;

const HINT_FLAP = TOUCH ? "TAP TO FLAP" : "CLICK · SPACE — FLAP";
const HINT_RESTART = TOUCH ? "TAP ANYWHERE TO RESTART" : "CLICK OR PRESS SPACE TO RESTART";
const HINT_RACE = "FLAP TO JOIN THE RACE";
const SOLO_ROW_ID = "you";

interface Course {
  seed: number;
  start: number | null;
}

/* oxlint-disable no-bitwise, unicorn/prefer-code-point -- FNV-1a is defined over
   UTF-16 code units and 32-bit wraparound; every peer must derive the same value. */
const hashId = (id: string, salt: number) => {
  let h = (2_166_136_261 ^ salt) >>> 0;

  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }

  return ((h >>> 0) % 100_000) / 100_000;
};
/* oxlint-enable no-bitwise, unicorn/prefer-code-point */

const destroyPipe = (pipe: Pipe) => {
  pipe.topCap.destroy();
  pipe.topBody.destroy();
  pipe.botCap.destroy();
  pipe.botBody.destroy();
  pipe.coin?.destroy();
  pipe.glint?.destroy();
};

const markAway = (ghost: Ghost, away: boolean) => {
  if (away === ghost.away) {
    return;
  }

  ghost.away = away;
  ghost.live = null;

  if (away) {
    ghost.sprite.setAlpha(0.16).setTint(0x90_99_b0);
  } else {
    ghost.motion.relearn();
  }
};

const randomSeed = () => 1 + Math.floor(Math.random() * 0x7f_ff_ff_ff);

const setText = (id: string, text: string) => {
  const el = document.querySelector(`#${id}`);

  if (el) {
    el.textContent = text;
  }
};

const isSeed = (v: number) => Number.isSafeInteger(v) && v > 0 && v <= 0x80_00_00_00;

const validSkin = (v: number) => (Number.isInteger(v) && v >= 1 && v <= DRAGON_SKINS ? v : 1);

const readPeer = (state: Player["state"]) => {
  if (!state) {
    return null;
  }

  const { life, score, skin, t, vy, y } = state;

  if (!isJsonNumber(t) || !isJsonNumber(y)) {
    return null;
  }

  return {
    life: isJsonNumber(life) ? life : 0,
    live: state["live"] === true,
    score: isJsonNumber(score) ? score : 0,
    skin: validSkin(isJsonNumber(skin) ? skin : 1),
    t,
    vy: isJsonNumber(vy) ? vy : 0,
    y,
  };
};

const readCourse = (course: JsonValue | undefined) => {
  if (!isJsonObject(course)) {
    return null;
  }

  const { seed, start } = course;

  if (!isJsonNumber(seed) || !isSeed(seed)) {
    return null;
  }

  return { seed, start: isJsonNumber(start) ? start : null };
};

const storageGet = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const storageSet = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);

    return true;
  } catch {
    return false;
  }
};

const readBest = () => {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    const parsed = raw === null ? 0 : Math.trunc(Number(raw));

    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
};

const writeBest = (score: number) => {
  try {
    localStorage.setItem(BEST_KEY, String(score));

    return true;
  } catch {
    return false;
  }
};

interface BoardRow {
  id: string;
  score: number;
  live: boolean;
  me: boolean;
  away: boolean;
}

const rowMark = (r: BoardRow) => {
  if (r.away) {
    return "📡";
  }

  return r.live ? "🐉" : "💀";
};

const renderStandings = (rows: readonly BoardRow[]) => {
  const frag = document.createDocumentFragment();

  for (const r of rows.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = `row${r.me ? " me" : ""}${r.live ? "" : " dead"}${r.away ? " away" : ""}`;
    const name = document.createElement("span");
    name.textContent = `${rowMark(r)} ${r.me ? "you" : r.id.slice(0, 4)}${r.away ? " reconnecting…" : ""}`;
    const sc = document.createElement("span");
    sc.className = "sc";
    sc.textContent = String(r.score);
    row.append(name, sc);
    frag.append(row);
  }

  return frag;
};

export class GameScene extends Scene {
  private net!: NetSession;

  phase: Phase = "ready";
  private birdY = BIRD_SPAWN_Y;
  private vy = 0;
  private score = 0;
  private best = 0;
  private diedAt = 0;
  private skin = 1;
  private gates = 0;

  worldX = 0;
  private readyDrift = 0;
  seed = 0;

  private lastScoredIndex = -1;
  private collectedCoins = new Set<number>();

  pipes = new Map<number, Pipe>();
  ghosts = new Map<string, Ghost>();
  rivalIds: string[] = [];
  private rivalSource: PlayerMap | null = null;
  private bgLayers: BgLayer[] = [];
  private bird!: GameObjects.Sprite;
  private readyImg!: GameObjects.Image;
  private overImg!: GameObjects.Image;
  private titleDragon: GameObjects.Sprite | null = null;
  private digits: GameObjects.Image[] = [];
  private flightFx!: FlightFx;

  private lastFrameAt = -1;
  private readonly stateRate = new FixedRate(NET_TICK_HZ);
  private streamingState = false;
  private life = 0;
  private ownCourse = false;
  private courseRef: JsonValue | undefined;
  private course: Course | null = null;
  private boardAcc = 0;
  private boardSig = "";
  private lastNetInfo = "";
  private ownDrop = false;

  private hintEl: HTMLElement | null = null;
  private gatesEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private resultRetryEl: HTMLElement | null = null;
  private resultLayoutKey = "";
  private resultLayoutAt = 0;
  private phraseTimer: Time.TimerEvent | null = null;
  presentationPaused = false;
  private boardEl: HTMLElement | null = null;
  private touchControls: TouchControls | null = null;
  private muted = true;
  private netInfoEl: HTMLElement | null = null;
  private startEl: HTMLElement | null = null;
  started = false;
  private readonly pad = new PhysicalGamepad();
  private unwatchControls: (() => void) | null = null;
  countingDown = false;
  private countdownTimer: Time.TimerEvent | null = null;
  private goWord = "JUMP!";

  constructor() {
    super("Game");
  }

  create() {
    this.hintEl = document.querySelector("#hint");
    this.gatesEl = document.querySelector("#flight-gates");
    this.resultsEl = document.querySelector("#flight-result");
    this.resultRetryEl = document.querySelector("#result-retry");
    this.boardEl = document.querySelector("#board");
    this.netInfoEl = document.querySelector("#netinfo");
    this.startEl = document.querySelector("#start");
    this.best = readBest();
    this.skin = rollSkin();

    this.setMuted(storageGet(SOUND_KEY) !== "1");

    this.touchControls = createTouchControls();

    this.net = new NetSession({
      fallbackMs: OFFLINE_FALLBACK_MS,
      maxPlayers: MP_MAX_PLAYERS,
      offline: isPlaytestRequested(),
      room: ROOM,
    });
    this.net.subscribe(() => this.watchOwnConnection());

    this.bgLayers = BG_FACTORS.map((factor, i) => ({
      factor,
      sprite: this.add
        .tileSprite(0, 0, 1, 1, `bg-${i + 1}`)
        .setOrigin(0, 0)
        .setDepth(i === 3 ? 6 : -14 + i),
    }));

    this.bird = this.add
      .sprite(
        BIRD_X + DRAGON_SPRITE_OFFSET_X,
        BIRD_SPAWN_Y + DRAGON_SPRITE_OFFSET_Y,
        `dragon-${this.skin}-1`,
      )
      .setScale(ART_SCALE)
      .setDepth(10);
    this.bird.play(`fly-${this.skin}`);

    this.flightFx = new FlightFx(this);

    this.readyImg = this.add
      .image(0, 0, "msg-ready")
      .setScale(ART_SCALE)
      .setDepth(30)
      .setVisible(false);
    this.overImg = this.add
      .image(0, 0, "msg-gameover")
      .setScale(ART_SCALE)
      .setDepth(30)
      .setVisible(false);

    this.buildStartScreen();
    this.input.on("pointerdown", () => this.handleInput());
    this.input.keyboard?.on("keydown-SPACE", (e: KeyboardEvent) => {
      if (!e.repeat) {
        this.handleInput();
      }
    });
    this.input.keyboard?.on("keydown-UP", (e: KeyboardEvent) => {
      if (!e.repeat) {
        this.handleInput();
      }
    });
    this.input.keyboard?.on("keydown-M", (e: KeyboardEvent) => {
      if (!e.repeat) {
        this.setMuted(!this.muted);
      }
    });

    this.scale.on(Scale.Events.RESIZE, this.layout, this);
    this.events.once(Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Scale.Events.RESIZE, this.layout, this);
      this.unwatchControls?.();
      this.unwatchControls = null;
      this.net.destroy();
      this.touchControls?.destroy();
      this.touchControls = null;
    });

    this.layout();
    this.setHint(HINT_FLAP);
    this.spawnTitleDragon();

    if (import.meta.env.DEV) {
      window.__fb = { net: this.net, scene: this };
    }

    if (import.meta.env.DEV || isPlaytestRequested()) {
      publishPlaytestSurface(this);
    }
  }

  /**
   * Everything is relative to the dragon's body box, in course px with y
   * pointing DOWN: a negative dy is above the dragon. `player.x` is the
   * distance flown, so it climbs while the run is alive.
   */
  diagnostics() {
    const gap = this.gapAhead(0);
    const after = this.gapAhead(1);
    const centreY = this.birdY + BIRD_H / 2;

    return {
      canFlap: this.started && !this.countingDown && this.phase !== "gameover",
      complete: this.phase === "gameover",
      entities: this.pipes.size + this.ghosts.size + 1,
      floorDy: Math.round(COURSE_H - (this.birdY + BIRD_H)),
      frame: this.game.loop.frame,
      gapAfter: after && {
        centreDy: Math.round(after.centreY - centreY),
        dx: Math.round(after.x - (BIRD_X + BIRD_W)),
      },
      gates: this.gates,
      nextCoin:
        gap?.coinY === undefined || gap.coinY === null
          ? null
          : {
              dx: Math.round(gap.x + PIPE_WIDTH / 2 - (BIRD_X + BIRD_W / 2)),
              dy: Math.round(gap.coinY - centreY),
            },
      nextGap: gap && {
        centreDy: Math.round(gap.centreY - centreY),
        dx: Math.round(gap.x - (BIRD_X + BIRD_W)),
        inside: gap.x < BIRD_X + BIRD_W,
        roomAbove: Math.round(this.birdY - gap.top),
        roomBelow: Math.round(gap.top + PIPE_GAP - (this.birdY + BIRD_H)),
      },
      phase: this.phase,
      player: { alive: this.alive, x: Math.round(this.worldX) + BIRD_X, y: this.birdY },
      score: this.score,
      vy: Math.round(this.vy),
    };
  }

  private gapAhead(n: number) {
    if (this.seed === 0) {
      return null;
    }

    const i = Math.max(0, this.frontIndex() + 1) + n;
    const top = topHeightFor(this.seed, i);

    return {
      centreY: top + PIPE_GAP / 2,
      coinY:
        coinPresentFor(this.seed, i) && !this.collectedCoins.has(i)
          ? coinYFor(this.seed, i, top)
          : null,
      top,
      x: this.screenX(i),
    };
  }

  /** Reseed the course and restart the run on it, skipping the get-ready count. */
  testSeed(seed: number) {
    this.net.goOffline();
    this.cancelCountdown();
    this.resetRun(1 + (Math.abs(Math.trunc(seed)) % 0x7f_ff_ff_ff));
  }

  /**
   * `active-play` is past the start screen and the 3-2-1, in the ready hover
   * where the first flap launches the run — where a player is when the count
   * ends. Returns the state actually applied.
   */
  testState(name: string) {
    if (name !== "active-play") {
      return this.phase;
    }

    this.net.goOffline();
    this.dismissStartScreen();
    this.cancelCountdown();

    if (this.phase !== "ready") {
      this.resetRun(this.seed === 0 ? randomSeed() : this.seed);
    }

    return name;
  }

  private buildStartScreen() {
    const controls = document.querySelector("#start-controls");
    const go = document.querySelector("#start-go");
    ensureControlsStyle();

    const renderControls = () => {
      if (!controls) {
        return;
      }

      const card = buildControls(CONTROLS, TOUCH);
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
      go.textContent = TOUCH ? "tap to start" : "press any key to start";
    }

    this.startEl?.classList.add("ready");
    this.input.keyboard?.once("keyup", () => this.beginPlay());
    this.startEl?.addEventListener("pointerup", () => this.beginPlay(), { once: true });
  }

  private spawnTitleDragon() {
    if (prefersReducedMotion()) {
      return;
    }

    this.titleDragon = this.add.sprite(-80, COURSE_H / 2, `dragon-${rollSkin()}-1`).setDepth(9);
    this.flyTitleDragon();
  }

  private flyTitleDragon() {
    const d = this.titleDragon;

    if (!d || this.started) {
      return;
    }

    this.tweens.killTweensOf(d);
    const skin = rollSkin();
    d.play(`fly-${skin}`);
    const y = 120 + Math.random() * Math.max(120, COURSE_H - 340);
    d.setPosition(-80, y)
      .setScale(ART_SCALE * 1.3)
      .setAlpha(0.9)
      .setRotation(0);
    this.tweens.add({
      duration: 5200 + Math.random() * 2000,
      ease: "Sine.easeInOut",
      onComplete: () => this.flyTitleDragon(),
      targets: d,
      x: this.viewW() + 80,
    });
    this.tweens.add({
      duration: 1050,
      ease: "Sine.easeInOut",
      repeat: -1,
      targets: d,
      y: y - 34,
      yoyo: true,
    });
    this.tweens.add({
      duration: 1050,
      ease: "Sine.easeInOut",
      repeat: -1,
      rotation: -0.14,
      targets: d,
      yoyo: true,
    });
  }

  private removeTitleDragon() {
    const d = this.titleDragon;

    if (!d) {
      return;
    }

    this.tweens.killTweensOf(d);
    d.destroy();
    this.titleDragon = null;
  }

  private beginPlay() {
    if (this.started) {
      return;
    }

    this.dismissStartScreen();
    this.runCountdown();
  }

  private dismissStartScreen() {
    if (this.started) {
      return;
    }

    this.started = true;
    this.unwatchControls?.();
    this.unwatchControls = null;
    this.removeTitleDragon();
    this.refreshScore();
    this.startEl?.classList.add("hide");
    this.time.delayedCall(320, () => this.startEl?.remove());
    notifyGameStarted();
  }

  private cancelCountdown() {
    this.countdownTimer?.remove();
    this.countdownTimer = null;
    this.countingDown = false;
    const el = document.querySelector("#countdown");

    if (el) {
      el.classList.remove("show", "pop");
      el.textContent = "";
    }
  }

  private runCountdown() {
    const el = document.querySelector("#countdown");

    if (!(el instanceof HTMLElement)) {
      return;
    }

    this.countingDown = true;
    recalibratePose();
    let n = 3;

    const tick = () => {
      if (n > 0) {
        el.textContent = String(n);
        el.classList.remove("pop");
        void el.offsetWidth;
        el.classList.add("pop");
        this.playSound("point", { rate: 1.25 - n * 0.15, volume: 0.28 });
        n -= 1;
        this.countdownTimer = this.time.delayedCall(1000, tick);
      } else {
        this.goWord = this.goWord === "FLAP!" ? "JUMP!" : "FLAP!";
        el.textContent = this.goWord;
        el.classList.remove("pop");
        void el.offsetWidth;
        el.classList.add("pop");
        this.countingDown = false;
        this.playSound("point", { rate: 1.5, volume: 0.5 });
        this.setHint(HINT_FLAP);
        this.countdownTimer = this.time.delayedCall(800, () => {
          this.countdownTimer = null;
          el.classList.remove("show", "pop");
          el.textContent = "";
        });
      }
    };

    el.classList.add("show");
    tick();
  }

  private get racing() {
    return this.rivalIds.length > 0;
  }
  /**
   * True while this player has a seat in a live party room: connected, or
   * reconnecting while the room holds the seat and the others race its
   * faded dragon (not solo, nor still connecting). The wrapper's pause
   * handler reads it so it never freezes a session other players are
   * relying on: frozen through a reconnect, the dragon would come back to
   * them standing still for the rest of the pause.
   */
  isOnline() {
    const status = this.net.connectionStatus;

    return status === "connected" || status === "reconnecting";
  }
  /**
   * Everything local-only — the get-ready 3-2-1 (an input gate plus pose
   * re-baseline), sound and fanfares — freezes under the wrapper pause even
   * when the online sim has to keep running for the other players.
   */
  setPresentationPaused(paused: boolean) {
    if (paused === this.presentationPaused) {
      return;
    }

    this.presentationPaused = paused;
    this.pad.update();

    if (this.countdownTimer) {
      this.countdownTimer.paused = paused;
    }

    this.sound.mute = this.muted || paused;

    if (paused) {
      this.cancelPhrase();
      this.sound.stopAll();
    }
  }
  private get alive() {
    return this.phase === "playing";
  }
  private get raceActive() {
    return this.racing || this.worldX > 0;
  }
  private get sharedCourse() {
    return this.racing || !this.net.isHost;
  }

  update(time: number) {
    const elapsedMs = this.lastFrameAt < 0 ? 0 : Math.max(0, time - this.lastFrameAt);
    this.lastFrameAt = time;
    const dt = Math.min(elapsedMs, MAX_DT_MS) / 1000;
    this.pad.update();

    if (this.padFlapPressed()) {
      this.handleInput();
    }

    this.rivalIds = this.presentRivals();
    const stepMs = Math.min(elapsedMs, this.sharedCourse ? MAX_RACE_STEP_MS : MAX_DT_MS);
    const now = this.net.serverNow(time);
    this.ensureSeed();
    this.advanceWorld(now, stepMs);

    if (this.phase === "ready") {
      this.hover(time, dt);
    } else if (this.phase === "playing") {
      this.fly(stepMs / 1000);
    } else if (this.phase === "gameover" && this.sharedCourse && time - this.diedAt >= RESPAWN_MS) {
      this.respawn();
    }

    if (this.phase === "gameover") {
      this.updateResults(time);
    }

    this.applyParallax();
    this.syncPipes();
    this.syncGhosts(time);
    this.flightFx.update(
      dt,
      this.viewW(),
      this.viewTop(),
      this.noticeY(),
      this.bird.x,
      this.bird.y,
      this.phase === "playing" && this.vy < -120,
    );
    this.broadcast(elapsedMs, now);
    this.updateBoard(dt);
  }

  private hover(time: number, dt: number) {
    this.birdY += (this.readyY() - this.birdY) * (1 - Math.exp(-READY_EASE * dt));
    this.bird.y = this.birdY + DRAGON_SPRITE_OFFSET_Y + Math.sin(time / 300) * 4;

    if (!this.racing) {
      this.readyDrift += READY_DRIFT * dt;
    }
  }

  private fly(h: number) {
    this.birdY += this.vy * h + 0.5 * GRAVITY * h * h;
    this.vy += GRAVITY * h;
    const ceiling = this.viewTop();

    if (this.birdY < ceiling) {
      this.birdY = ceiling;
      this.vy = 0;
    }

    this.bird.y = this.birdY + DRAGON_SPRITE_OFFSET_Y;
    this.bird.rotation = tiltFor(this.vy);
    this.checkScore();
    this.checkCoins();
    this.checkDeath();
  }

  private presentRivals() {
    const { players } = this.net;

    if (players === this.rivalSource) {
      return this.rivalIds;
    }

    this.rivalSource = players;
    const me = this.net.playerId;

    return Object.keys(players)
      .filter((id) => id !== me)
      .toSorted();
  }

  private roomCourse() {
    const ref = this.net.sharedState["course"];

    if (ref !== this.courseRef) {
      this.courseRef = ref;
      this.course = readCourse(ref);
    }

    return this.course;
  }

  private publishCourse(start: number | null) {
    const course = { seed: this.seed, start };
    this.net.patchShared({ course });
    this.courseRef = course;
    this.course = course;
  }

  private ensureSeed() {
    const course = this.roomCourse();

    if (course) {
      this.adoptSeed(course.seed);

      return;
    }

    if (this.net.isHost) {
      if (this.seed === 0) {
        this.seed = randomSeed();
      }

      this.publishCourse(null);
    }
  }

  private adoptSeed(seed: number) {
    if (seed === this.seed) {
      return;
    }

    this.seed = seed;
    this.worldX = 0;
    this.lastScoredIndex = this.frontIndex();
    this.collectedCoins.clear();
    this.clearPipes();
  }

  private advanceWorld(now: number | null, stepMs: number) {
    const host = this.net.isHost;

    if (host && (!this.racing || now === null)) {
      this.ownCourse = true;

      if (this.alive || this.racing) {
        this.worldX += (PIPE_SPEED * stepMs) / 1000;
      }

      return;
    }

    const wasOwn = this.ownCourse;
    this.ownCourse = false;

    if (now === null) {
      return;
    }

    if (host && (wasOwn || (this.course?.start ?? null) === null)) {
      this.publishCourse(courseStart(this.worldX, now));
    }

    const start = this.course?.start ?? null;

    if (start === null) {
      return;
    }

    const x = followCourse(this.worldX, courseX(start, now), this.alive);
    const lurched = x - this.worldX > (PIPE_SPEED * stepMs) / 1000 + COURSE_LURCH_PX;
    this.worldX = x;

    if (lurched) {
      this.lastScoredIndex = this.frontIndex();
    }
  }

  private padFlapPressed() {
    return (
      this.pad.justPressed("a") ||
      this.pad.justPressed("b") ||
      this.pad.justPressed("x") ||
      this.pad.justPressed("y")
    );
  }

  private handleInput(strength = 1, refire = false) {
    if (this.presentationPaused) {
      return;
    }

    if (!this.started) {
      this.beginPlay();

      return;
    }

    if (this.countingDown) {
      return;
    }

    if (this.phase === "ready") {
      this.startLife();
      this.setPhase("playing");
      this.bird.setAlpha(1).clearTint().setTintMode(TintModes.MULTIPLY);
      this.bird.y = this.birdY + DRAGON_SPRITE_OFFSET_Y;
      this.readyImg.setVisible(false);
      this.setHint("");
      this.flap(strength, refire);

      return;
    }

    if (this.phase === "playing") {
      this.flap(strength, refire);

      return;
    }

    if (this.sharedCourse) {
      return;
    }

    if (this.time.now - this.diedAt < RESTART_LOCKOUT_MS) {
      return;
    }

    this.restart();
  }

  poseJump(strength: number, refire: boolean) {
    this.handleInput(strength, refire);
  }

  private flap(strength: number, refire = false) {
    this.vy = flapVelocityFor(strength);

    if (refire) {
      return;
    }

    this.flightFx.wingbeat(this.bird.x, this.bird.y);
    this.playSound("flap", { rate: 0.95 + Math.random() * 0.1 });

    if (prefersReducedMotion()) {
      return;
    }

    this.tweens.killTweensOf(this.bird);
    this.bird.setScale(ART_SCALE * 1.15, ART_SCALE * 0.8);
    this.tweens.add({
      duration: 140,
      ease: "Quad.easeOut",
      scaleX: ART_SCALE,
      scaleY: ART_SCALE,
      targets: this.bird,
    });
  }

  private setPhase(phase: Phase) {
    this.phase = phase;

    if (phase === "playing") {
      notifyGameStarted();
    }

    setPoseLocked(phase === "playing");
    this.refreshGateHud();
  }

  private startLife() {
    this.vy = 0;
    this.lastScoredIndex = this.frontIndex();
    this.gates = 0;
    this.collectedCoins.clear();
  }

  private restart() {
    this.resetRun(randomSeed());
    this.runCountdown();
  }

  private resetRun(seed: number) {
    this.score = 0;
    this.worldX = 0;
    this.seed = seed;

    if (this.net.isHost) {
      this.publishCourse(null);
    }

    this.clearPipes();

    this.skin = rollSkin();
    this.life += 1;
    this.bird.setPosition(BIRD_X + DRAGON_SPRITE_OFFSET_X, BIRD_SPAWN_Y + DRAGON_SPRITE_OFFSET_Y);
    this.reviveBird();
    this.birdY = BIRD_SPAWN_Y;
    this.vy = 0;
    this.setPhase("ready");
  }

  private respawn() {
    this.score = 0;
    this.vy = 0;
    this.birdY = this.readyY();
    this.life += 1;
    this.reviveBird();
    this.setPhase("ready");
  }

  private reviveBird() {
    this.cancelPhrase();
    this.resultsEl?.classList.remove("show");
    this.flightFx.reset();
    this.tweens.killTweensOf(this.bird);
    this.bird
      .setRotation(0)
      .setScale(ART_SCALE)
      .setAlpha(1)
      .clearTint()
      .setTintMode(TintModes.MULTIPLY);
    this.bird.play(`fly-${this.skin}`);
    this.overImg.setVisible(false);
    this.setHint("");
    this.refreshScore();
  }

  private die() {
    this.setPhase("gameover");
    this.diedAt = this.time.now;
    this.cancelPhrase();
    this.playSound("hit");
    this.bird.stop();
    this.bird.setTint(0xff_ff_ff).setTintMode(TintModes.FILL);
    this.time.delayedCall(90, () => {
      if (this.phase === "gameover") {
        this.bird.clearTint().setTintMode(TintModes.MULTIPLY);
      }
    });

    if (!prefersReducedMotion()) {
      this.cameras.main.shake(120, 0.008);
    }

    this.flightFx.crash(this.bird.x, this.bird.y);

    const isNewBest = this.score > this.best;

    if (isNewBest) {
      this.best = this.score;
      writeBest(this.best);
      this.flightFx.celebrate("NEW BEST!", this.viewW() / 2, this.noticeY());
      this.playPhrase([1.15, 1.45, 1.8], 140);
    }

    this.overImg.setVisible(true);
    this.setHint("");
    this.resultsEl?.classList.remove("show");
    this.resultsEl?.classList.toggle("record", isNewBest);
    setText("result-title", isNewBest ? "A NEW PERSONAL BEST" : "YOUR FLIGHT");
    setText("result-score", String(this.score));
    setText("result-gates", String(this.gates));
    setText("result-coins", String(this.collectedCoins.size));
    setText("result-best", String(this.best));
    this.resultLayoutAt = 0;
    this.updateResults(this.time.now);
  }

  private screenX(i: number) {
    return pipeCourseX(i) - this.worldX;
  }

  private frontIndex() {
    return Math.floor((this.worldX + BIRD_X - PIPE_WIDTH - RUNWAY) / PIPE_SPAWN_DISTANCE);
  }

  private readyY() {
    return this.raceActive ? this.spawnY() : BIRD_SPAWN_Y;
  }

  private spawnY() {
    if (this.seed === 0) {
      return BIRD_SPAWN_Y;
    }

    const i = this.frontIndex() + 1;

    if (i < 0) {
      return BIRD_SPAWN_Y;
    }

    const top = topHeightFor(this.seed, i);

    return top + PIPE_GAP / 2;
  }

  private syncPipes() {
    if (!this.raceActive || this.seed === 0) {
      if (this.pipes.size > 0) {
        this.clearPipes();
      }

      return;
    }

    const width = this.viewW();
    const iLow = Math.max(0, Math.floor((this.worldX - PIPE_WIDTH - RUNWAY) / PIPE_SPAWN_DISTANCE));
    const iHigh = Math.floor((this.worldX + width - RUNWAY) / PIPE_SPAWN_DISTANCE);

    for (let i = iLow; i <= iHigh; i += 1) {
      let pipe = this.pipes.get(i);

      if (!pipe) {
        pipe = this.spawnPipe(i);
      }

      this.positionPipe(pipe);
    }

    for (const [i, pipe] of this.pipes) {
      if (i < iLow || i > iHigh) {
        destroyPipe(pipe);
        this.pipes.delete(i);
      }
    }
  }

  private spawnPipe(i: number) {
    const topHeight = topHeightFor(this.seed, i);
    const trunkTop = this.viewTop();

    const topBody = this.add
      .tileSprite(
        0,
        trunkTop,
        PIPE_WIDTH,
        Math.max(1, topHeight - trunkTop - TUBE_CAP_H + 2),
        "tube-body",
      )
      .setOrigin(0, 0)
      .setTileScale(ART_SCALE)
      .setDepth(0);

    const topCap = this.add
      .image(0, topHeight, "tube-cap")
      .setOrigin(0.5, 1)
      .setFlipY(true)
      .setScale(ART_SCALE)
      .setDepth(1);

    const botCap = this.add
      .image(0, topHeight + PIPE_GAP, "tube-cap")
      .setOrigin(0.5, 0)
      .setScale(ART_SCALE)
      .setDepth(1);

    const botBodyY = topHeight + PIPE_GAP + TUBE_CAP_H - 2;

    const botBody = this.add
      .tileSprite(0, botBodyY, PIPE_WIDTH, Math.max(1, COURSE_H - botBodyY), "tube-body")
      .setOrigin(0, 0)
      .setTileScale(ART_SCALE)
      .setDepth(0);

    const coin =
      coinPresentFor(this.seed, i) && !this.collectedCoins.has(i)
        ? this.add
            .sprite(0, coinYFor(this.seed, i, topHeight), "coin-1")
            .setScale(ART_SCALE)
            .setDepth(4)
        : null;

    coin?.play("coin-spin");

    const glint = coin
      ? this.add
          .image(0, coin.y - 12, "flight-glint")
          .setTint(0xff_f4_b8)
          .setDepth(5)
      : null;

    const pipe: Pipe = { botBody, botCap, coin, glint, index: i, topBody, topCap, topHeight };
    this.pipes.set(i, pipe);

    return pipe;
  }

  private positionPipe(pipe: Pipe) {
    const x = this.screenX(pipe.index);
    const centerX = x + PIPE_WIDTH / 2;
    pipe.topBody.x = x;
    pipe.botBody.x = x;
    pipe.topCap.x = centerX;
    pipe.botCap.x = centerX;

    if (pipe.coin) {
      pipe.coin.x = centerX;
    }

    if (pipe.glint) {
      pipe.glint.x = centerX + 12;

      const pulse = prefersReducedMotion()
        ? 0.45
        : Math.max(0, Math.sin(this.time.now / 230 + pipe.index * 2.4));

      pipe.glint.setAlpha(0.2 + pulse * 0.8).setScale(0.7 + pulse * 0.4);
    }
  }

  private clearPipes() {
    for (const pipe of this.pipes.values()) {
      destroyPipe(pipe);
    }

    this.pipes.clear();
  }

  private checkScore() {
    if (this.phase !== "playing") {
      return;
    }

    for (const pipe of this.pipes.values()) {
      if (pipe.index <= this.lastScoredIndex) {
        continue;
      }

      if (this.screenX(pipe.index) + PIPE_WIDTH > BIRD_X) {
        continue;
      }

      this.lastScoredIndex = pipe.index;
      this.score += 1;
      this.gates += 1;
      this.refreshGateHud();
      this.refreshScore();
      this.scorePop();
      this.flightFx.pass(this.bird.x, this.bird.y);

      if (this.gates % GATE_MILESTONE === 0) {
        this.flightFx.celebrate(`${this.gates} GATES · KEEP FLYING!`, this.bird.x, this.bird.y);
        this.playPhrase([1.25, 1.6]);
      } else {
        this.playSound("point");
      }
    }
  }

  private checkCoins() {
    const cx = BIRD_X + BIRD_W / 2;
    const cy = this.birdY + BIRD_H / 2;

    for (const pipe of this.pipes.values()) {
      const { coin } = pipe;

      if (!coin) {
        continue;
      }

      if (Math.abs(coin.x - cx) >= COIN_PICKUP_X || Math.abs(coin.y - cy) >= COIN_PICKUP_Y) {
        continue;
      }

      pipe.coin = null;
      pipe.glint?.destroy();
      pipe.glint = null;
      this.collectedCoins.add(pipe.index);
      this.collectCoin(coin);
    }
  }

  private collectCoin(coin: GameObjects.Sprite) {
    this.flightFx.pickup(coin.x, coin.y);

    const burst = this.add
      .sprite(coin.x, coin.y, "burst-1")
      .setScale(ART_SCALE)
      .setDepth(7)
      .play("burst");

    burst.once(Animations.Events.ANIMATION_COMPLETE, () => burst.destroy());
    coin.destroy();
    this.score += 1;
    this.playSound("point", { rate: 1.5 });
    this.refreshScore();
    this.scorePop();
  }

  private checkDeath() {
    if (this.birdY > COURSE_H) {
      this.die();

      return;
    }

    for (const pipe of this.pipes.values()) {
      const x = this.screenX(pipe.index);

      if (BIRD_X + BIRD_W <= x || BIRD_X >= x + PIPE_WIDTH) {
        continue;
      }

      if (this.birdY < pipe.topHeight || this.birdY + BIRD_H > pipe.topHeight + PIPE_GAP) {
        this.die();

        return;
      }
    }
  }

  private watchOwnConnection() {
    const status = this.net.connectionStatus;

    if (status === "reconnecting") {
      this.ownDrop = true;
    } else if (status === "connected" && this.ownDrop) {
      this.ownDrop = false;

      for (const ghost of this.ghosts.values()) {
        ghost.motion.relearn();
      }
    }
  }

  private syncGhosts(time: number) {
    if (!this.racing) {
      for (const g of this.ghosts.values()) {
        g.sprite.destroy();
      }

      this.ghosts.clear();

      return;
    }

    const { frame } = this.game.loop;

    let laneX = BIRD_X + DRAGON_SPRITE_OFFSET_X;

    for (const id of this.rivalIds) {
      const ghost = this.feedGhost(id, time);

      if (!ghost) {
        continue;
      }

      ghost.seen = frame;
      laneX += ghost.gap;

      if (ghost.away) {
        ghost.sprite.x = laneX;
        continue;
      }

      const pose = ghost.motion.sample(time);

      if (!pose) {
        continue;
      }

      ghost.sprite.setPosition(laneX, pose.y + DRAGON_SPRITE_OFFSET_Y);
      ghost.sprite.setRotation(tiltFor(pose.vy));

      if (pose.live !== ghost.live) {
        ghost.live = pose.live;

        if (pose.live) {
          ghost.sprite.setAlpha(0.55).clearTint();
        } else {
          ghost.sprite.setAlpha(0.28).setTint(0x90_99_b0);
        }
      }
    }

    for (const [id, ghost] of this.ghosts) {
      if (ghost.seen !== frame) {
        ghost.sprite.destroy();
        this.ghosts.delete(id);
      }
    }
  }

  private feedGhost(id: string, time: number) {
    const player = this.net.players[id];
    const away = player?.connected === false;
    const known = this.ghosts.get(id);

    if (known) {
      markAway(known, away);
    }

    const state = player?.state;

    if (known && state?.["t"] === known.motion.stamp) {
      return known;
    }

    const peer = readPeer(state);

    if (!peer) {
      return known ?? null;
    }

    let ghost = known;

    if (!ghost) {
      const sprite = this.add
        .sprite(0, peer.y + DRAGON_SPRITE_OFFSET_Y, `dragon-${peer.skin}-1`)
        .setDepth(8)
        .setScale(
          ART_SCALE * (GHOST_SCALE_MIN + hashId(id, 3) * (GHOST_SCALE_MAX - GHOST_SCALE_MIN)),
        );

      sprite.play(`fly-${peer.skin}`);
      ghost = {
        away: false,
        gap: GHOST_GAP_MIN + hashId(id, 1) * (GHOST_GAP_MAX - GHOST_GAP_MIN),
        live: null,
        motion: new RivalMotion(),
        seen: 0,
        skin: peer.skin,
        sprite,
      };
      this.ghosts.set(id, ghost);
      markAway(ghost, away);
    } else if (ghost.skin !== peer.skin) {
      ghost.skin = peer.skin;
      ghost.sprite.play(`fly-${peer.skin}`);
    }

    ghost.motion.push(peer.t, peer.life, { live: peer.live, vy: peer.vy, y: peer.y }, time);

    return ghost;
  }

  private broadcast(elapsedMs: number, now: number | null) {
    if (!this.racing) {
      this.streamingState = false;

      return;
    }

    const due = this.stateRate.due(elapsedMs);

    if (now === null || (this.streamingState && !due)) {
      return;
    }

    if (!this.streamingState) {
      this.stateRate.reset();
    }

    this.streamingState = true;
    this.net.updateMyState({
      life: this.life,
      live: this.alive,
      score: this.score,
      skin: this.skin,
      t: Math.round(now),
      vy: Math.round(this.vy),
      y: Math.round(this.birdY),
    });
  }

  private scorePop() {
    if (prefersReducedMotion()) {
      return;
    }

    const y = this.scoreY();

    for (const digit of this.digits) {
      this.tweens.killTweensOf(digit);
      digit.setY(y - 6);
      this.tweens.add({ duration: 160, ease: "Back.easeOut", targets: digit, y });
    }
  }

  private refreshGateHud() {
    if (!this.gatesEl) {
      return;
    }

    this.gatesEl.hidden = this.phase !== "playing";
    const text = `${this.gates} ${this.gates === 1 ? "GATE" : "GATES"}`;

    if (this.gatesEl.textContent !== text) {
      this.gatesEl.textContent = text;
    }
  }

  private refreshScore() {
    const text = String(this.score);
    const y = this.scoreY();

    while (this.digits.length < text.length) {
      this.digits.push(this.add.image(0, y, "digits", 0).setOrigin(0, 0).setDepth(20));
    }

    while (this.digits.length > text.length) {
      const d = this.digits.pop();
      d?.destroy();
    }

    const startX = (this.viewW() - text.length * DIGIT_W) / 2;

    for (const [i, digit] of this.digits.entries()) {
      digit
        .setFrame((text.codePointAt(i) ?? 48) - 48)
        .setPosition(startX + i * DIGIT_W, y)
        .setDisplaySize(DIGIT_W, DIGIT_H)
        .setVisible(this.started);
    }
  }

  private setHint(text: string) {
    if (this.hintEl) {
      this.hintEl.textContent = this.started ? text : "";
    }
  }

  private updateResults(time: number) {
    if (time - this.resultLayoutAt >= RESULT_LAYOUT_MS) {
      this.resultLayoutAt = time;
      this.layoutResults();
    }

    const elapsed = Math.max(0, time - this.diedAt);
    this.resultsEl?.classList.toggle("show", elapsed >= 120);
    const remaining = Math.max(0, RESPAWN_MS - elapsed);
    const retry = this.retryLine(remaining, elapsed);

    if (this.resultRetryEl && this.resultRetryEl.textContent !== retry) {
      this.resultRetryEl.textContent = retry;
    }

    this.resultsEl?.style.setProperty(
      "--return-progress",
      String(Math.min(1, elapsed / (this.sharedCourse ? RESPAWN_MS : RESTART_LOCKOUT_MS))),
    );
  }

  private layoutResults() {
    const card = this.resultsEl;

    if (!card) {
      return;
    }

    const camera = document.querySelector(".fd-cam")?.getBoundingClientRect();
    const width = Math.min(340, this.scale.width - 32);
    const height = card.offsetHeight;
    const key = `${this.scale.width}:${this.scale.height}:${height}:${camera?.left}:${camera?.top}`;

    if (key === this.resultLayoutKey) {
      return;
    }

    this.resultLayoutKey = key;
    let x = this.scale.width / 2;

    let y = Math.min(
      this.scale.height - height - 16,
      this.scale.height / 2 + (this.scale.height <= 520 ? 30 : 48),
    );

    if (camera && x + width / 2 > camera.left && y + height > camera.top - 12) {
      if (camera.left - 32 >= width) {
        x = camera.left / 2;
      } else {
        y = Math.max(90, Math.min(y, camera.top - height - 16));
      }
    }

    card.style.width = `${width}px`;
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    const zoom = this.viewZoom();
    this.overImg
      .setScale(Math.min(ART_SCALE, (width - 16) / zoom / this.overImg.width))
      .setPosition(x / zoom, this.viewTop() + (y - 48) / zoom);
  }

  private playSound(key: string, config?: Types.Sound.SoundConfig) {
    if (this.muted || this.presentationPaused) {
      return;
    }

    this.sound.play(key, config);
  }

  private playPhrase(rates: readonly number[], delay = 0) {
    this.cancelPhrase();

    const note = (index: number) => {
      this.phraseTimer = null;
      const rate = rates[index];

      if (rate === undefined) {
        return;
      }

      this.playSound("point", { rate, volume: 0.45 });

      if (index + 1 < rates.length) {
        this.phraseTimer = this.time.delayedCall(PHRASE_NOTE_MS, () => note(index + 1));
      }
    };

    if (delay > 0) {
      this.phraseTimer = this.time.delayedCall(delay, () => note(0));
    } else {
      note(0);
    }
  }

  private cancelPhrase() {
    this.phraseTimer?.remove();
    this.phraseTimer = null;
  }

  isMuted() {
    return this.muted;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.sound.mute = muted || this.presentationPaused;

    if (muted) {
      this.cancelPhrase();
      this.sound.stopAll();
    }

    storageSet(SOUND_KEY, muted ? "0" : "1");

    if (
      !muted &&
      !this.presentationPaused &&
      this.sound instanceof Sound.WebAudioSoundManager &&
      this.sound.context.state === "suspended"
    ) {
      void this.sound.context.resume();
    }
  }

  private retryLine(remaining: number, elapsed: number) {
    if (this.sharedCourse) {
      return `BACK IN ${(remaining / 1000).toFixed(1)}s · RACE CONTINUES`;
    }

    return elapsed < RESTART_LOCKOUT_MS ? "TAKE A BREATH…" : HINT_RESTART;
  }

  private netInfoLine() {
    const status = this.net.connectionStatus;

    if (status === "connecting") {
      return "connecting…";
    }

    if (status === "reconnecting") {
      return "reconnecting…";
    }

    if (status === "offline") {
      return "offline · solo";
    }

    if (this.racing) {
      return `race · ${this.rivalIds.length + 1} players`;
    }

    return "online · waiting";
  }

  private updateBoard(dt: number) {
    const netInfo = this.netInfoLine();

    if (this.netInfoEl && netInfo !== this.lastNetInfo) {
      this.lastNetInfo = netInfo;
      this.netInfoEl.textContent = netInfo;
    }

    this.boardAcc += dt;

    if (this.boardAcc < 1 / NET_TICK_HZ) {
      return;
    }

    this.boardAcc = 0;

    if (!this.boardEl) {
      return;
    }

    if (!this.racing) {
      if (this.boardEl.childElementCount > 0) {
        this.boardEl.replaceChildren();
      }

      this.boardSig = "";

      if (this.phase === "ready" && this.isOnline()) {
        this.setHint(HINT_FLAP);
      }

      return;
    }

    if (this.phase === "ready") {
      this.setHint(HINT_RACE);
    }

    const rows = this.standings();

    const sig = rows.map((r) => `${r.id}:${r.score}:${r.live ? 1 : 0}:${r.away ? 1 : 0}`).join("|");

    if (sig === this.boardSig) {
      return;
    }

    this.boardSig = sig;
    this.boardEl.replaceChildren(renderStandings(rows));
  }

  private standings() {
    const me = this.net.playerId ?? SOLO_ROW_ID;

    const rows: BoardRow[] = [
      { away: false, id: me, live: this.alive, me: true, score: this.score },
    ];

    for (const id of this.rivalIds) {
      const player = this.net.players[id];
      const ps = readPeer(player?.state);
      rows.push({
        away: player?.connected === false,
        id,
        live: ps?.live ?? false,
        me: false,
        score: ps?.score ?? 0,
      });
    }

    rows.sort((a, b) => b.score - a.score);

    return rows;
  }

  private viewZoom() {
    return Math.min(this.scale.height / COURSE_H, this.scale.width / MIN_VIEW_W);
  }

  private viewW() {
    return this.scale.width / this.viewZoom();
  }

  private viewTop() {
    return COURSE_H - this.scale.height / this.viewZoom();
  }

  private scoreY() {
    return this.viewTop() + SCORE_Y + safeAreaInset().top / this.viewZoom();
  }

  private noticeY() {
    return this.scoreY() + 44;
  }

  private layout() {
    const zoom = this.viewZoom();
    const width = this.viewW();
    const top = this.viewTop();
    const viewH = COURSE_H - top;
    this.cameras.main.setZoom(zoom).centerOn(width / 2, top + viewH / 2);
    const tileScale = viewH / BG_NATIVE_H;

    for (const layer of this.bgLayers) {
      layer.sprite.setPosition(0, top).setSize(width, viewH).setTileScale(tileScale);
    }

    this.applyParallax();

    for (const img of [this.readyImg, this.overImg]) {
      img
        .setScale(Math.min(ART_SCALE, (width - 16) / img.width))
        .setPosition(width / 2, top + viewH / 2);
    }

    this.refreshScore();

    if (this.phase === "gameover") {
      this.layoutResults();
    }

    this.clearPipes();
  }

  private applyParallax() {
    const px = this.worldX + this.readyDrift;

    for (const layer of this.bgLayers) {
      layer.sprite.tilePositionX = (px * layer.factor) / layer.sprite.tileScaleX;
    }
  }
}
