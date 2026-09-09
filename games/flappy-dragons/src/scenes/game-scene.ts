import Phaser from "phaser";
import { createTouchControls, notifyGameStarted, watchControlContext } from "@repo/embed";
import type { TouchControls } from "@repo/embed";
import { PhysicalGamepad, safeAreaInset } from "@vibedgames/gamepad";

import { CONTROLS } from "../controls";
import { buildControls, ensureStyle as ensureControlsStyle } from "../pause-overlay";
import { isCoarsePointer, recalibratePose, setPoseLocked } from "../input/camera";
import { NetSession, isJsonNumber } from "../net/session";
import type { JsonObject } from "../net/session";
import type { Player } from "@vibedgames/multiplayer";
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
  DRAGON_SPRITE_OFFSET_X,
  DRAGON_SPRITE_OFFSET_Y,
  flapVelocityFor,
  GRAVITY,
  MAX_TILT,
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
  TILT_FACTOR,
  topHeightFor,
  TUBE_CAP_H,
  WORLD_TICK_HZ,
  type Phase,
} from "../shared/constants";

/** A trunk built for course index `i`; sprites are positioned each frame. */
type Pipe = {
  index: number;
  topHeight: number;
  topCap: Phaser.GameObjects.Image;
  topBody: Phaser.GameObjects.TileSprite;
  botCap: Phaser.GameObjects.Image;
  botBody: Phaser.GameObjects.TileSprite;
  coin: Phaser.GameObjects.Sprite | null;
  glint: Phaser.GameObjects.Image | null;
};

type BgLayer = {
  sprite: Phaser.GameObjects.TileSprite;
  factor: number;
};

/** Another player's live dragon, drawn as a translucent ghost. */
type Ghost = {
  sprite: Phaser.GameObjects.Sprite;
  skin: number;
  /** Per-id flock variation (seeded from the id), computed once at creation. */
  scale: number;
  gap: number;
};

const COIN_PICKUP_X = 54;
const COIN_PICKUP_Y = 44;
const RESTART_LOCKOUT_MS = 280;
const RESULT_LAYOUT_MS = 250;
const GATE_MILESTONE = 10;
const PHRASE_NOTE_MS = 110;
/** Guest scroll-clock: adopt host drift beyond this gap in one snap… */
const WORLD_SNAP_PX = 60;
/** …and fold smaller drift in gradually per snapshot. */
const WORLD_DRIFT_BLEND = 0.2;
const MAX_DT_MS = 50;
/**
 * Everyone shares the same course position (one global scroll), so all dragons
 * would stack at BIRD_X. Your own dragon stays at BIRD_X — the back of the view
 * — and rivals fan out to the right so the flock reads. Gaps and depth vary per
 * rival (seeded from their id, so they stay put) so it looks like a loose flock
 * rather than a fixed grid.
 */
const GHOST_GAP_MIN = 30;
const GHOST_GAP_MAX = 68;
const GHOST_SCALE_MIN = 0.82;
const GHOST_SCALE_MAX = 1.06;

/** Decided once at boot so hint/HUD copy is input-aware from the first frame. */
const TOUCH = isCoarsePointer();
/** DEV-only room override (?room=): the two-client harness isolates each run
 *  so a stale room's course can't leak into assertions. */
const ROOM = (import.meta.env.DEV && new URLSearchParams(location.search).get("room")) || MP_ROOM;

const HINT_FLAP = TOUCH ? "TAP TO FLAP" : "CLICK · SPACE — FLAP";
const HINT_RESTART = TOUCH ? "TAP ANYWHERE TO RESTART" : "CLICK OR PRESS SPACE TO RESTART";
const HINT_RACE = "FLAP TO JOIN THE RACE";
const SOLO_ROW_ID = "you";

type PeerState = { yf: number; live: boolean; score: number; skin: number; rot: number };

export class GameScene extends Phaser.Scene {
  private net!: NetSession;

  private phase: Phase = "ready";
  private birdY = BIRD_SPAWN_Y;
  private vy = 0;
  private score = 0;
  private best = 0;
  private diedAt = 0;
  private skin = 1;
  /** Pipes passed this life (score also counts coins). */
  private gates = 0;

  /** Global course scroll. The host owns it; guests mirror the host's value. */
  private worldX = 0;
  /** Cosmetic parallax drift used only on the solo ready screen. */
  private readyDrift = 0;
  /** Shared course seed (0 until the host seeds it). */
  private seed = 0;

  /** Highest pipe index already scored in the current life. */
  private lastScoredIndex = -1;
  private collectedCoins = new Set<number>();

  private pipes = new Map<number, Pipe>();
  private ghosts = new Map<string, Ghost>();
  /** Other players present this frame, sorted so every client agrees on lane
   *  order. A seat the server holds for a reconnect is not a rival: its last
   *  state would hang a frozen ghost in your lane for the whole grace window. */
  private rivalIds: string[] = [];
  private bgLayers: BgLayer[] = [];
  private bird!: Phaser.GameObjects.Sprite;
  private readyImg!: Phaser.GameObjects.Image;
  private overImg!: Phaser.GameObjects.Image;
  /** Cosmetic dragon wandering across the title screen (pre-start only). */
  private titleDragon: Phaser.GameObjects.Sprite | null = null;
  private digits: Phaser.GameObjects.Image[] = [];
  private flightFx!: FlightFx;

  // Net bookkeeping.
  private stateAcc = 0;
  private worldAcc = 0;
  private boardAcc = 0;
  private hostSeq = 0;
  private lastSeq = -1;
  private boardSig = "";
  private lastNetInfo = "";

  private hintEl: HTMLElement | null = null;
  private gatesEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private resultRetryEl: HTMLElement | null = null;
  /** Card geometry inputs at the last placement; skips DOM writes while nothing moved. */
  private resultLayoutKey = "";
  private resultLayoutAt = 0;
  /** Pending note of a multi-note fanfare (new best, gate milestone). */
  private phraseTimer: Phaser.Time.TimerEvent | null = null;
  private presentationPaused = false;
  private boardEl: HTMLElement | null = null;
  private touchControls: TouchControls | null = null;
  private muted = true;
  private netInfoEl: HTMLElement | null = null;
  private startEl: HTMLElement | null = null;
  private started = false;
  /** Physical controller: any face button flaps (and starts/restarts). */
  private readonly pad = new PhysicalGamepad();
  private unwatchControls: (() => void) | null = null;
  /** Input is held while the get-ready countdown runs. */
  private countingDown = false;
  /** Pending countdown step, so the wrapper pause can freeze the 3-2-1. */
  private countdownTimer: Phaser.Time.TimerEvent | null = null;
  /** Countdown go-word, alternating FLAP!/JUMP! (starts as FLAP! after flip). */
  private goWord = "JUMP!";

  constructor() {
    super("Game");
  }

  create(): void {
    this.hintEl = document.getElementById("hint");
    this.gatesEl = document.getElementById("flight-gates");
    this.resultsEl = document.getElementById("flight-result");
    this.resultRetryEl = document.getElementById("result-retry");
    this.boardEl = document.getElementById("board");
    this.netInfoEl = document.getElementById("netinfo");
    this.startEl = document.getElementById("start");
    this.best = readBest();
    this.skin = rollSkin();

    // Muted by default; returning players who opted into sound stay unmuted.
    this.setMuted(storageGet(SOUND_KEY) !== "1");

    // M and Escape are keyboard-only, so a phone otherwise has no way to hear
    // the game or leave a run.
    this.touchControls = createTouchControls({
      mute: {
        get: () => this.muted,
        set: (next) => this.setMuted(next),
      },
    });

    this.net = new NetSession({
      room: ROOM,
      maxPlayers: MP_MAX_PLAYERS,
      fallbackMs: OFFLINE_FALLBACK_MS,
    });

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

    // Hidden from boot: the HTML start overlay owns the pre-flap moment now,
    // and this banner would show through its translucent wash.
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
      if (!e.repeat) this.handleInput();
    });
    this.input.keyboard?.on("keydown-UP", (e: KeyboardEvent) => {
      if (!e.repeat) this.handleInput();
    });
    // M is a user gesture, so unmuting here can safely resume a suspended
    // audio context.
    this.input.keyboard?.on("keydown-M", (e: KeyboardEvent) => {
      if (!e.repeat) {
        this.setMuted(!this.muted);
        this.touchControls?.sync();
      }
    });

    this.scale.on(Phaser.Scale.Events.RESIZE, this.layout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.layout, this);
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
      window.__fb = { scene: this, net: this.net };
      Object.defineProperty(window, "__GAME_DIAGNOSTICS__", {
        configurable: true,
        get: () => this.diagnostics(),
      });
    }
  }

  diagnostics() {
    return {
      frame: this.game.loop.frame,
      score: this.score,
      complete: this.phase === "gameover",
      player: { x: BIRD_X, y: this.birdY, alive: this.alive },
      entities: this.pipes.size + this.ghosts.size + 1,
      phase: this.phase,
      gates: this.gates,
    };
  }

  private buildStartScreen(): void {
    const controls = document.getElementById("start-controls");
    const go = document.getElementById("start-go");
    // Same grouped keycap card the pause overlay renders — the two teaching
    // surfaces stay visually consistent by construction.
    ensureControlsStyle();
    const renderControls = (): void => {
      if (!controls) return;
      const card = buildControls(CONTROLS, TOUCH);
      controls.replaceChildren(...(card ? [card] : []));
    };
    renderControls();
    // Plugging in a pad while the start screen is up adds its rows.
    this.unwatchControls?.();
    this.unwatchControls = watchControlContext(() => {
      if (!this.started) renderControls();
    });
    if (go) go.textContent = TOUCH ? "tap to start" : "press any key to start";
    // Reveals the overlay now that the card is complete — see #start in index.html.
    this.startEl?.classList.add("ready");
    this.input.keyboard?.once("keyup", () => this.beginPlay());
    this.startEl?.addEventListener("pointerup", () => this.beginPlay(), { once: true });
  }

  /**
   * A second dragon that wanders across the title screen behind the overlay,
   * so the pre-start world feels alive (the parallax sky already drifts). One
   * sprite + a few tweens, torn down the instant play starts. Skipped under
   * reduced-motion.
   */
  private spawnTitleDragon(): void {
    if (prefersReducedMotion()) return;
    this.titleDragon = this.add.sprite(-80, COURSE_H / 2, `dragon-${rollSkin()}-1`).setDepth(9);
    this.flyTitleDragon();
  }

  /** Send the title dragon on one left-to-right pass, then loop with fresh
   *  height + skin. Bob + tilt run for the pass; all are killed on relaunch. */
  private flyTitleDragon(): void {
    const d = this.titleDragon;
    if (!d || this.started) return;
    this.tweens.killTweensOf(d);
    const skin = rollSkin();
    d.play(`fly-${skin}`);
    const y = 120 + Math.random() * Math.max(120, COURSE_H - 340);
    d.setPosition(-80, y)
      .setScale(ART_SCALE * 1.3)
      .setAlpha(0.9)
      .setRotation(0);
    this.tweens.add({
      targets: d,
      x: this.viewW() + 80,
      duration: 5200 + Math.random() * 2000,
      ease: "Sine.easeInOut",
      onComplete: () => this.flyTitleDragon(),
    });
    this.tweens.add({
      targets: d,
      y: y - 34,
      duration: 1050,
      ease: "Sine.easeInOut",
      yoyo: true,
      repeat: -1,
    });
    this.tweens.add({
      targets: d,
      rotation: -0.14,
      duration: 1050,
      ease: "Sine.easeInOut",
      yoyo: true,
      repeat: -1,
    });
  }

  private removeTitleDragon(): void {
    const d = this.titleDragon;
    if (!d) return;
    this.tweens.killTweensOf(d);
    d.destroy();
    this.titleDragon = null;
  }

  private beginPlay(): void {
    if (this.started) return;
    this.started = true;
    this.unwatchControls?.();
    this.unwatchControls = null;
    this.removeTitleDragon();
    this.startEl?.classList.add("hide");
    this.time.delayedCall(320, () => this.startEl?.remove());
    // Play begins HERE, not at the first flap — arming the wrapper pause now
    // means Escape works during the 3-2-1 and the ready hover too.
    notifyGameStarted();
    this.runCountdown();
  }

  /**
   * 3-2-1 between the start screen and the first flap: time to step back and
   * get framed for the pose camera, whose baseline re-captures during the
   * count. Input is gated until it ends; the bird then hovers in the ready
   * phase and the first flap (tap/Space/jump/arm-flap) launches the run.
   */
  private runCountdown(): void {
    const el = document.getElementById("countdown");
    if (!el) return;
    this.countingDown = true;
    recalibratePose();
    let n = 3;
    const tick = (): void => {
      if (n > 0) {
        el.textContent = String(n);
        el.classList.remove("pop");
        void el.offsetWidth; // restart the pop animation
        el.classList.add("pop");
        this.playSound("point", { rate: 1.25 - n * 0.15, volume: 0.28 });
        n--;
        this.countdownTimer = this.time.delayedCall(1000, tick);
      } else {
        // Alternate the go-word so both webcam verbs get equal billing.
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

  // ---- role helpers --------------------------------------------------------

  private get racing(): boolean {
    return this.rivalIds.length > 0;
  }
  /**
   * True only when actually connected to a live party room (not the solo
   * fallback) — used by the wrapper's pause handler so it never freezes a
   * session other players are relying on.
   */
  isOnline(): boolean {
    return this.net.live && !this.net.offline;
  }
  /**
   * Everything local-only — the get-ready 3-2-1 (an input gate plus pose
   * re-baseline), sound and fanfares — freezes under the wrapper pause even
   * when the online sim has to keep running for the other players.
   */
  setPresentationPaused(paused: boolean): void {
    if (paused === this.presentationPaused) return;
    this.presentationPaused = paused;
    // The pad button that dismissed the wrapper's overlay is consumed by it:
    // sample it now so the next gameplay poll doesn't see a fresh press.
    this.pad.update();
    if (this.countdownTimer) this.countdownTimer.paused = paused;
    this.sound.mute = this.muted || paused;
    if (paused) {
      this.cancelPhrase();
      this.sound.stopAll();
    }
  }
  private get alive(): boolean {
    return this.phase === "playing";
  }
  /** The shared course is scrolling (someone started, or we're in a race). */
  private get raceActive(): boolean {
    return this.racing || this.worldX > 0;
  }

  update(time: number, delta: number): void {
    const dt = Math.min(delta, MAX_DT_MS) / 1000;
    this.pad.update();
    if (this.padFlapPressed()) this.handleInput();
    this.net.tick();
    this.rivalIds = this.presentRivals();
    this.ensureSeed();
    this.advanceWorld(dt);

    if (this.phase === "ready") {
      // Idle hover; in a live race the bird is a translucent, invulnerable
      // spectator until the first flap.
      this.bird.y = BIRD_SPAWN_Y + DRAGON_SPRITE_OFFSET_Y + Math.sin(time / 300) * 4;
      if (!this.racing) this.readyDrift += READY_DRIFT * dt;
    } else if (this.phase === "playing") {
      // Legacy integration order: position first, then gravity into velocity.
      this.birdY += this.vy * dt;
      this.vy += GRAVITY * dt;
      // Solid ceiling. Without it, steady tapping — the natural panic input on
      // a phone — parks the dragon above the view, where it is invisible and
      // (before the trunks were extended up there) passed through every pipe.
      const ceiling = this.viewTop();
      if (this.birdY < ceiling) {
        this.birdY = ceiling;
        this.vy = 0;
      }
      this.bird.y = this.birdY + DRAGON_SPRITE_OFFSET_Y;
      this.bird.rotation = Phaser.Math.Clamp(this.vy * TILT_FACTOR, -MAX_TILT, MAX_TILT);
      this.checkScore();
      this.checkCoins();
      this.checkDeath();
    } else if (this.phase === "gameover" && this.racing) {
      // Multiplayer: crash is a brief setback, then rejoin the live course.
      if (time - this.diedAt >= RESPAWN_MS) this.respawn();
    }

    if (this.phase === "gameover") this.updateResults(time);
    this.applyParallax();
    this.syncPipes();
    this.syncGhosts();
    this.flightFx.update(
      dt,
      this.viewW(),
      this.viewTop(),
      this.noticeY(),
      this.bird.x,
      this.bird.y,
      this.phase === "playing" && this.vy < -120,
    );
    this.broadcast(dt);
    this.updateBoard(dt);
  }

  private presentRivals(): string[] {
    const me = this.net.playerId;
    return Object.entries(this.net.players)
      .filter(([id, p]) => id !== me && p.connected !== false)
      .map(([id]) => id)
      .sort();
  }

  // ---- seed + world scroll -------------------------------------------------

  private ensureSeed(): void {
    const s = this.net.sharedState;
    const shared = s ? numField(s, "seed") : null;
    if (shared !== null && Number.isSafeInteger(shared) && shared > 0 && shared <= 0x80000000) {
      this.adoptSeed(shared);
      return;
    }
    // First host seeds the course. Guests wait for it (bird just hovers).
    if (this.net.isHost) {
      if (this.seed === 0) this.seed = randomSeed();
      this.net.patchShared({ seed: this.seed });
    }
  }

  /** Pipes were built from the old seed; syncPipes rebuilds them this frame. */
  private adoptSeed(seed: number): void {
    if (seed === this.seed) return;
    this.seed = seed;
    this.clearPipes();
  }

  private advanceWorld(dt: number): void {
    if (this.net.isHost) {
      // Host owns the global scroll: run it while we're flying, or whenever a
      // guest is in the room so the shared course keeps moving for everyone.
      if (this.alive || this.racing) this.worldX += PIPE_SPEED * dt;
      return;
    }
    // Guest: mirror the host's scroll, dead-reckoned between snapshots.
    const s = this.net.sharedState;
    if (!s) return;
    const seq = numField(s, "wseq");
    const wx = numField(s, "wx");
    this.worldX += PIPE_SPEED * dt;
    if (seq !== null && seq !== this.lastSeq && wx !== null) {
      this.lastSeq = seq;
      const drift = wx - this.worldX;
      // Snapshots arrive ~half-RTT stale, so hard-adopting each one snaps the
      // whole pipe field backward every tick. Fold small drift in smoothly;
      // snap only on real discontinuities (join, host migration).
      if (Math.abs(drift) > WORLD_SNAP_PX) this.worldX = wx;
      else this.worldX += drift * WORLD_DRIFT_BLEND;
    }
  }

  // ---- input ---------------------------------------------------------------

  private padFlapPressed(): boolean {
    return (
      this.pad.justPressed("a") ||
      this.pad.justPressed("b") ||
      this.pad.justPressed("x") ||
      this.pad.justPressed("y")
    );
  }

  private handleInput(strength = 1, refire = false): void {
    if (this.presentationPaused) return;
    if (!this.started) {
      this.beginPlay();
      return;
    }
    if (this.countingDown) return; // holding for the get-ready count
    if (this.phase === "ready") {
      this.startLife();
      this.setPhase("playing");
      this.bird.setAlpha(1).clearTint().setTintMode(Phaser.TintModes.MULTIPLY);
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
    // In a race the respawn timer owns the comeback — a tap on the gameover
    // screen must not restart() (which rewinds the SHARED course to zero for
    // everyone when the host does it).
    if (this.racing) return;
    if (this.time.now - this.diedAt < RESTART_LOCKOUT_MS) return;
    this.restart();
  }

  poseJump(strength: number, refire: boolean): void {
    this.handleInput(strength, refire);
  }

  private flap(strength: number, refire = false): void {
    this.vy = flapVelocityFor(strength);
    if (refire) return;
    this.flightFx.wingbeat(this.bird.x, this.bird.y);
    this.playSound("flap", { rate: 0.95 + Math.random() * 0.1 });
    if (prefersReducedMotion()) return;
    this.tweens.killTweensOf(this.bird);
    this.bird.setScale(ART_SCALE * 1.15, ART_SCALE * 0.8);
    this.tweens.add({
      targets: this.bird,
      scaleX: ART_SCALE,
      scaleY: ART_SCALE,
      duration: 140,
      ease: "Quad.easeOut",
    });
  }

  // ---- state flow ----------------------------------------------------------

  /**
   * Single funnel for phase changes. Locks the webcam pose baseline for the
   * duration of a run (it "locks in place" the instant you start) and lets it
   * re-track while idle on the ready / game-over screens. No-op without a cam.
   */
  private setPhase(phase: Phase): void {
    this.phase = phase;
    if (phase === "playing") notifyGameStarted();
    setPoseLocked(phase === "playing");
    this.refreshGateHud();
  }

  /**
   * Per-life reset, shared by the first flap and every racing respawn. The
   * shared course may be mid-way, so the bird drops into the next gap rather
   * than the fixed spawn height.
   */
  private startLife(): void {
    this.birdY = this.raceActive ? this.spawnY() : BIRD_SPAWN_Y;
    this.vy = 0;
    this.lastScoredIndex = this.frontIndex();
    this.gates = 0;
    this.collectedCoins.clear();
  }

  /** Solo: the existing retry input starts another get-ready countdown. */
  private restart(): void {
    this.score = 0;
    this.worldX = 0; // solo: start the course over
    this.seed = randomSeed();
    // Publish the reroll, or ensureSeed() re-adopts the stale shared seed
    // next frame and every solo run replays the identical course. (Offline
    // this writes the local loopback state; a non-host can't be alone.)
    this.net.patchShared({ seed: this.seed });
    this.clearPipes();

    this.skin = rollSkin();
    this.bird.setPosition(BIRD_X + DRAGON_SPRITE_OFFSET_X, BIRD_SPAWN_Y + DRAGON_SPRITE_OFFSET_Y);
    // Solo restart gets the same get-ready count as a fresh boot: time to get
    // back in frame, pose recalibrates, then the first flap launches.
    this.reviveBird();
    this.birdY = BIRD_SPAWN_Y;
    this.setPhase("ready");
    this.runCountdown();
  }

  /** Multiplayer: respawn into the still-scrolling shared course. */
  private respawn(): void {
    this.score = 0;
    this.startLife();
    this.enterPlaying();
  }

  /** Reset the bird's look + game-over HUD after a death. */
  private reviveBird(): void {
    this.cancelPhrase();
    this.resultsEl?.classList.remove("show");
    this.flightFx.reset();
    this.tweens.killTweensOf(this.bird);
    this.bird
      .setRotation(0)
      .setScale(ART_SCALE)
      .setAlpha(1)
      .clearTint()
      .setTintMode(Phaser.TintModes.MULTIPLY);
    this.bird.play(`fly-${this.skin}`);
    this.overImg.setVisible(false);
    this.setHint("");
    this.refreshScore();
  }

  /** Shared tail of racing respawns: reset the bird's look + HUD, go live. */
  private enterPlaying(): void {
    this.reviveBird();
    this.setPhase("playing");
  }

  private die(): void {
    this.setPhase("gameover");
    this.diedAt = this.time.now;
    this.cancelPhrase();
    this.playSound("hit");
    this.bird.stop();
    this.bird.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
    this.time.delayedCall(90, () => {
      if (this.phase === "gameover") this.bird.clearTint().setTintMode(Phaser.TintModes.MULTIPLY);
    });
    if (!prefersReducedMotion()) this.cameras.main.shake(120, 0.008);
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

  // ---- deterministic course ------------------------------------------------

  /** Screen x of pipe `i` given the current global scroll. */
  private screenX(i: number): number {
    return pipeCourseX(i) - this.worldX;
  }

  /** The pipe index whose trailing edge is at the bird right now. */
  private frontIndex(): number {
    return Math.floor((this.worldX + BIRD_X - PIPE_WIDTH - RUNWAY) / PIPE_SPAWN_DISTANCE);
  }

  /** Where a comeback drops the bird. The shared course kept scrolling while
   *  we were dead, so a fixed height regularly lands inside a pipe trunk —
   *  aim for the gap of the pipe the bird will meet first instead. */
  private spawnY(): number {
    if (this.seed === 0) return BIRD_SPAWN_Y;
    const i = this.frontIndex() + 1;
    if (i < 0) return BIRD_SPAWN_Y; // still on the runway, nothing ahead
    const top = topHeightFor(this.seed, i);
    return top + PIPE_GAP / 2;
  }

  private syncPipes(): void {
    if (!this.raceActive || this.seed === 0) {
      if (this.pipes.size > 0) this.clearPipes();
      return;
    }
    const width = this.viewW();
    const iLow = Math.max(0, Math.floor((this.worldX - PIPE_WIDTH - RUNWAY) / PIPE_SPAWN_DISTANCE));
    const iHigh = Math.floor((this.worldX + width - RUNWAY) / PIPE_SPAWN_DISTANCE);

    for (let i = iLow; i <= iHigh; i++) {
      let pipe = this.pipes.get(i);
      if (!pipe) pipe = this.spawnPipe(i);
      this.positionPipe(pipe);
    }
    for (const [i, pipe] of this.pipes) {
      if (i < iLow || i > iHigh) {
        destroyPipe(pipe);
        this.pipes.delete(i);
      }
    }
  }

  private spawnPipe(i: number): Pipe {
    const topHeight = topHeightFor(this.seed, i);
    // The trunk starts at the top of the VIEW, not of the course: a viewport
    // that shows sky above the course would otherwise show trunks ending in
    // mid-air, and the dragon could fly over them.
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
          .setTint(0xfff4b8)
          .setDepth(5)
      : null;

    const pipe: Pipe = { index: i, topHeight, topCap, topBody, botCap, botBody, coin, glint };
    this.pipes.set(i, pipe);
    return pipe;
  }

  private positionPipe(pipe: Pipe): void {
    const x = this.screenX(pipe.index);
    const centerX = x + PIPE_WIDTH / 2;
    pipe.topBody.x = x;
    pipe.botBody.x = x;
    pipe.topCap.x = centerX;
    pipe.botCap.x = centerX;
    if (pipe.coin) pipe.coin.x = centerX;
    if (pipe.glint) {
      pipe.glint.x = centerX + 12;
      // A small steady gleam still marks an edge-on coin under reduced motion.
      const pulse = prefersReducedMotion()
        ? 0.45
        : Math.max(0, Math.sin(this.time.now / 230 + pipe.index * 2.4));
      pipe.glint.setAlpha(0.2 + pulse * 0.8).setScale(0.7 + pulse * 0.4);
    }
  }

  private clearPipes(): void {
    for (const pipe of this.pipes.values()) destroyPipe(pipe);
    this.pipes.clear();
  }

  private checkScore(): void {
    if (this.phase !== "playing") return;
    for (const pipe of this.pipes.values()) {
      if (pipe.index <= this.lastScoredIndex) continue;
      if (this.screenX(pipe.index) + PIPE_WIDTH > BIRD_X) continue;
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

  private checkCoins(): void {
    const cx = BIRD_X + BIRD_W / 2;
    const cy = this.birdY + BIRD_H / 2;
    for (const pipe of this.pipes.values()) {
      const coin = pipe.coin;
      if (!coin) continue;
      if (Math.abs(coin.x - cx) >= COIN_PICKUP_X || Math.abs(coin.y - cy) >= COIN_PICKUP_Y)
        continue;
      pipe.coin = null;
      pipe.glint?.destroy();
      pipe.glint = null;
      this.collectedCoins.add(pipe.index);
      this.collectCoin(coin);
    }
  }

  private collectCoin(coin: Phaser.GameObjects.Sprite): void {
    this.flightFx.pickup(coin.x, coin.y);
    const burst = this.add
      .sprite(coin.x, coin.y, "burst-1")
      .setScale(ART_SCALE)
      .setDepth(7)
      .play("burst");
    burst.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => burst.destroy());
    coin.destroy();
    this.score += 1;
    this.playSound("point", { rate: 1.5 });
    this.refreshScore();
    this.scorePop();
  }

  private checkDeath(): void {
    if (this.birdY > COURSE_H) {
      this.die();
      return;
    }
    for (const pipe of this.pipes.values()) {
      const x = this.screenX(pipe.index);
      if (BIRD_X + BIRD_W <= x || BIRD_X >= x + PIPE_WIDTH) continue;
      // Overlapping the trunk column: anything outside the gap is a crash. The
      // ceiling clamp keeps the dragon below the trunk tops, so there is no
      // "above the pipe" case to exempt.
      if (this.birdY < pipe.topHeight || this.birdY + BIRD_H > pipe.topHeight + PIPE_GAP) {
        this.die();
        return;
      }
    }
  }

  // ---- ghosts (other players) ----------------------------------------------

  private syncGhosts(): void {
    if (!this.racing) {
      for (const g of this.ghosts.values()) g.sprite.destroy();
      this.ghosts.clear();
      return;
    }
    const seen = new Set<string>();

    // Fan rivals out to the right of your own dragon (which stays at BIRD_X).
    // Each keeps a per-id gap + depth so the flock is loose, not a fixed grid;
    // gaps accumulate so rivals never overlap however uneven the spacing.
    let laneX = BIRD_X + DRAGON_SPRITE_OFFSET_X;
    for (const id of this.rivalIds) {
      const ps = readPeer(this.net.players[id]?.state);
      if (!ps) continue;
      seen.add(id);
      let ghost = this.ghosts.get(id);
      if (!ghost || ghost.skin !== ps.skin) {
        ghost?.sprite.destroy();
        const sprite = this.add.sprite(0, 0, `dragon-${ps.skin}-1`).setDepth(8).setAlpha(0.55);
        sprite.play(`fly-${ps.skin}`);
        ghost = {
          sprite,
          skin: ps.skin,
          scale:
            ART_SCALE * (GHOST_SCALE_MIN + hashId(id, 3) * (GHOST_SCALE_MAX - GHOST_SCALE_MIN)),
          gap: GHOST_GAP_MIN + hashId(id, 1) * (GHOST_GAP_MAX - GHOST_GAP_MIN),
        };
        this.ghosts.set(id, ghost);
      }
      laneX += ghost.gap;
      ghost.sprite.setScale(ghost.scale);
      ghost.sprite.setPosition(laneX, ps.yf * COURSE_H + DRAGON_SPRITE_OFFSET_Y);
      ghost.sprite.setRotation(Phaser.Math.Clamp(ps.rot, -MAX_TILT, MAX_TILT));
      if (ps.live) {
        ghost.sprite.setAlpha(0.55).clearTint();
      } else {
        // Crashed players fade to a grey silhouette until they respawn.
        ghost.sprite.setAlpha(0.28).setTint(0x9099b0);
      }
    }

    for (const [id, ghost] of this.ghosts) {
      if (!seen.has(id)) {
        ghost.sprite.destroy();
        this.ghosts.delete(id);
      }
    }
  }

  // ---- networking ----------------------------------------------------------

  private broadcast(dt: number): void {
    if (this.net.offline) return;
    // A lone player parked on the title screen has nothing to say — don't
    // stream state at the Durable Object for nobody.
    if (!this.racing && !this.alive) return;
    this.stateAcc += dt;
    if (this.stateAcc >= 1 / NET_TICK_HZ) {
      this.stateAcc = 0;
      this.net.updateMyState({
        yf: this.birdY / COURSE_H,
        live: this.alive,
        score: this.score,
        skin: this.skin,
        rot: this.bird.rotation,
      });
    }
    if (this.net.isHost) {
      this.worldAcc += dt;
      if (this.worldAcc >= 1 / WORLD_TICK_HZ) {
        this.worldAcc = 0;
        this.hostSeq++;
        // Re-assert the seed with the clock: if the room's Durable Object was
        // evicted mid-session (in-memory state wiped, sockets reconnect), the
        // course would otherwise stay unseeded for every future joiner.
        this.net.patchShared({ wx: this.worldX, wseq: this.hostSeq, seed: this.seed });
      }
    }
  }

  // ---- visual effects ------------------------------------------------------

  private scorePop(): void {
    if (prefersReducedMotion()) return;
    const y = this.scoreY();
    for (const digit of this.digits) {
      this.tweens.killTweensOf(digit);
      digit.setY(y - 6);
      this.tweens.add({ targets: digit, y, duration: 160, ease: "Back.easeOut" });
    }
  }

  // ---- HUD -----------------------------------------------------------------

  private refreshGateHud(): void {
    if (!this.gatesEl) return;
    this.gatesEl.hidden = this.phase !== "playing";
    const text = `${this.gates} ${this.gates === 1 ? "GATE" : "GATES"}`;
    if (this.gatesEl.textContent !== text) this.gatesEl.textContent = text;
  }

  private refreshScore(): void {
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
        .setFrame(text.charCodeAt(i) - 48)
        .setPosition(startX + i * DIGIT_W, y)
        .setDisplaySize(DIGIT_W, DIGIT_H);
    }
  }

  private setHint(text: string): void {
    // The HTML start overlay owns all pre-start copy — a hint pill under it
    // would just duplicate (and fight) the overlay's controls block.
    if (this.hintEl) this.hintEl.textContent = this.started ? text : "";
  }

  /** Game-over card: mirrors the respawn/restart deadlines, never gates them. */
  private updateResults(time: number): void {
    // The card's own height and the camera panel's rect are layout reads;
    // 4 Hz is plenty for a panel the player may collapse mid-screen.
    if (time - this.resultLayoutAt >= RESULT_LAYOUT_MS) {
      this.resultLayoutAt = time;
      this.layoutResults();
    }
    const elapsed = Math.max(0, time - this.diedAt);
    this.resultsEl?.classList.toggle("show", elapsed >= 120);
    const remaining = Math.max(0, RESPAWN_MS - elapsed);
    const retry = this.racing
      ? `BACK IN ${(remaining / 1000).toFixed(1)}s · RACE CONTINUES`
      : elapsed < RESTART_LOCKOUT_MS
        ? "TAKE A BREATH…"
        : HINT_RESTART;
    if (this.resultRetryEl && this.resultRetryEl.textContent !== retry) {
      this.resultRetryEl.textContent = retry;
    }
    this.resultsEl?.style.setProperty(
      "--return-progress",
      String(Math.min(1, elapsed / (this.racing ? RESPAWN_MS : RESTART_LOCKOUT_MS))),
    );
  }

  /** Keep the banner/card together and outside the optional live camera. */
  private layoutResults(): void {
    const card = this.resultsEl;
    if (!card) return;
    const camera = document.querySelector(".fd-cam")?.getBoundingClientRect();
    const width = Math.min(340, this.scale.width - 32);
    const height = card.offsetHeight;
    const key = `${this.scale.width}:${this.scale.height}:${height}:${camera?.left}:${camera?.top}`;
    if (key === this.resultLayoutKey) return;
    this.resultLayoutKey = key;
    let cardWidth = width;
    let x = this.scale.width / 2;
    let y = Math.min(
      this.scale.height - height - 16,
      this.scale.height / 2 + (this.scale.height <= 520 ? 30 : 48),
    );
    // Overlapping the camera: sit beside it when there's room, else above it.
    if (camera && x + width / 2 > camera.left && y + height > camera.top - 12) {
      if (camera.left >= 272) {
        cardWidth = Math.min(width, camera.left - 32);
        x = camera.left / 2;
      } else y = Math.max(90, Math.min(y, camera.top - height - 16));
    }
    card.style.width = `${cardWidth}px`;
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    const zoom = this.viewZoom();
    this.overImg
      .setScale(Math.min(ART_SCALE, (cardWidth - 16) / zoom / this.overImg.width))
      .setPosition(x / zoom, this.viewTop() + (y - 48) / zoom);
  }

  private playSound(key: string, config?: Phaser.Types.Sound.SoundConfig): void {
    if (this.muted || this.presentationPaused) return;
    this.sound.play(key, config);
  }

  /** "point" pitched up a few steps; a newer fanfare replaces a pending one. */
  private playPhrase(rates: readonly number[], delay = 0): void {
    this.cancelPhrase();
    const note = (index: number): void => {
      this.phraseTimer = null;
      const rate = rates[index];
      if (rate === undefined) return;
      this.playSound("point", { rate, volume: 0.45 });
      if (index + 1 < rates.length) {
        this.phraseTimer = this.time.delayedCall(PHRASE_NOTE_MS, () => note(index + 1));
      }
    };
    if (delay > 0) this.phraseTimer = this.time.delayedCall(delay, () => note(0));
    else note(0);
  }

  private cancelPhrase(): void {
    this.phraseTimer?.remove();
    this.phraseTimer = null;
  }

  private setMuted(muted: boolean): void {
    // The scene owns the flag rather than reading it back off the sound
    // manager: Phaser swaps in a no-audio manager when the device has no
    // output, and that one silently drops writes to `mute` and always reads
    // false — which left the toggle stuck after a single press.
    this.muted = muted;
    this.sound.mute = muted || this.presentationPaused;
    if (muted) {
      this.cancelPhrase();
      this.sound.stopAll();
    }
    storageSet(SOUND_KEY, muted ? "0" : "1");
    // Autoplay policy may have left the context suspended (we boot muted, so
    // nothing forced it awake). We're inside a user gesture — resume is safe.
    if (
      !muted &&
      !this.presentationPaused &&
      this.sound instanceof Phaser.Sound.WebAudioSoundManager &&
      this.sound.context.state === "suspended"
    ) {
      void this.sound.context.resume();
    }
  }

  /** Live race leaderboard + connection info (multiplayer only). */
  private updateBoard(dt: number): void {
    const netInfo = !this.net.live
      ? "connecting…"
      : this.net.offline
        ? "offline · solo"
        : this.racing
          ? `race · ${this.rivalIds.length + 1} players`
          : "online · waiting";
    if (this.netInfoEl && netInfo !== this.lastNetInfo) {
      this.lastNetInfo = netInfo;
      this.netInfoEl.textContent = netInfo;
    }

    // Standings only move at snapshot rate — no need to recompute them at 60Hz.
    this.boardAcc += dt;
    if (this.boardAcc < 1 / NET_TICK_HZ) return;
    this.boardAcc = 0;

    if (!this.boardEl) return;
    if (!this.racing) {
      if (this.boardEl.childElementCount > 0) this.boardEl.replaceChildren();
      this.boardSig = "";
      if (this.phase === "ready" && this.net.live && !this.net.offline) this.setHint(HINT_FLAP);
      return;
    }
    if (this.phase === "ready") this.setHint(HINT_RACE);

    const me = this.net.playerId ?? SOLO_ROW_ID;
    const rows = [{ id: me, score: this.score, live: this.alive, me: true }];
    for (const id of this.rivalIds) {
      const ps = readPeer(this.net.players[id]?.state);
      rows.push({ id, score: ps?.score ?? 0, live: ps?.live ?? false, me: false });
    }
    rows.sort((a, b) => b.score - a.score);

    // Standings change a few times a second at most — skip the 60 Hz DOM
    // rebuild while nothing moved.
    const sig = rows.map((r) => `${r.id}:${r.score}:${r.live ? 1 : 0}`).join("|");
    if (sig === this.boardSig) return;
    this.boardSig = sig;

    const frag = document.createDocumentFragment();
    for (const r of rows.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = `row${r.me ? " me" : ""}${r.live ? "" : " dead"}`;
      const name = document.createElement("span");
      name.textContent = `${r.live ? "🐉" : "💀"} ${r.me ? "you" : r.id.slice(0, 4)}`;
      const sc = document.createElement("span");
      sc.className = "sc";
      sc.textContent = String(r.score);
      row.append(name, sc);
      frag.append(row);
    }
    this.boardEl.replaceChildren(frag);
  }

  // ---- layout --------------------------------------------------------------

  /**
   * Camera zoom. Filling the viewport height is the goal; MIN_VIEW_W is the
   * floor that stops a narrow viewport from cropping the course down to a
   * couple of trunk widths (see the constant).
   */
  private viewZoom(): number {
    return Math.min(this.scale.height / COURSE_H, this.scale.width / MIN_VIEW_W);
  }

  /** Logical width of the visible window. */
  private viewW(): number {
    return this.scale.width / this.viewZoom();
  }

  /**
   * Logical y of the top of the visible window — 0 when the zoom fills the
   * height, negative when MIN_VIEW_W pushed it out. The course FLOOR is pinned
   * to the bottom of the screen, so the extra room is always sky above.
   */
  private viewTop(): number {
    return COURSE_H - this.scale.height / this.viewZoom();
  }

  /** Top of the score digits: below the view top and below any notch. */
  private scoreY(): number {
    return this.viewTop() + SCORE_Y + safeAreaInset().top / this.viewZoom();
  }

  /** Milestone / new-best banner sits just under the score digits. */
  private noticeY(): number {
    return this.scoreY() + 44;
  }

  private layout(): void {
    // The whole world lives in a fixed COURSE_H-tall logical space and the
    // camera zooms it onto the real viewport. Every client therefore plays the
    // exact same course geometry (the 8-player race stays fair) whatever its
    // screen; only how much of it is on screen at once differs.
    const zoom = this.viewZoom();
    const width = this.viewW();
    const top = this.viewTop();
    const viewH = COURSE_H - top;
    this.cameras.main.setZoom(zoom).centerOn(width / 2, top + viewH / 2);
    // Sized to the VIEW, not the course: tileScale × zoom is `height/native`
    // either way, so the backdrop lands on the same screen pixels as before
    // and never leaves a band of bare sky above the course.
    const tileScale = viewH / BG_NATIVE_H;
    for (const layer of this.bgLayers) {
      layer.sprite.setPosition(0, top).setSize(width, viewH).setTileScale(tileScale);
    }
    this.applyParallax();
    // Narrow logical viewports (phone portrait) can't fit the banners at 2×.
    for (const img of [this.readyImg, this.overImg]) {
      img
        .setScale(Math.min(ART_SCALE, (width - 16) / img.width))
        .setPosition(width / 2, top + viewH / 2);
    }
    this.refreshScore();
    if (this.phase === "gameover") this.layoutResults();
    // Both the visible pipe window and the trunk tops depend on the view.
    this.clearPipes();
  }

  private applyParallax(): void {
    const px = this.worldX + this.readyDrift;
    for (const layer of this.bgLayers) {
      layer.sprite.tilePositionX = (px * layer.factor) / layer.sprite.tileScaleX;
    }
  }
}

// ---- module helpers (pure) --------------------------------------------------

function destroyPipe(pipe: Pipe): void {
  pipe.topCap.destroy();
  pipe.topBody.destroy();
  pipe.botCap.destroy();
  pipe.botBody.destroy();
  pipe.coin?.destroy();
  pipe.glint?.destroy();
}

function randomSeed(): number {
  // 1..2^31 (never 0 — 0 marks "unseeded").
  return 1 + Math.floor(Math.random() * 0x7fffffff);
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/** Stable 0..1 hash of a player id (+salt) for per-rival flock variation. */
function hashId(id: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function numField(s: JsonObject, key: string): number | null {
  const v = s[key];
  return isJsonNumber(v) ? v : null;
}

function readPeer(state: Player["state"]): PeerState | null {
  if (!state) return null;
  const yf = state["yf"];
  const skin = state["skin"];
  if (!isJsonNumber(yf) || !isJsonNumber(skin)) return null;
  const score = state["score"];
  const rot = state["rot"];
  return {
    yf,
    live: state["live"] === true,
    score: isJsonNumber(score) ? score : 0,
    skin,
    rot: isJsonNumber(rot) ? rot : 0,
  };
}

// localStorage throws in some embeds (sandboxed iframes, blocked cookies,
// private modes). The game must boot and run without persistence.
function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked store just loses persistence — never the run.
  }
}

function readBest(): number {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeBest(score: number): void {
  try {
    localStorage.setItem(BEST_KEY, String(score));
  } catch {
    // ignore — see readBest
  }
}
