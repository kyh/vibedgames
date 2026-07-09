import Phaser from "phaser";
import { notifyGameStarted } from "@vibedgames/embed";

import { isCoarsePointer, setPoseLocked } from "../input/camera";
import { NetSession } from "../net/session";
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

const HINT_FLAP = TOUCH ? "TAP TO FLAP" : "CLICK · TAP · SPACE — FLAP";
const HINT_RESTART = "TAP ANYWHERE TO RESTART";
const HINT_RACE = "FLAP TO JOIN THE RACE";

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
  private bgLayers: BgLayer[] = [];
  private bird!: Phaser.GameObjects.Sprite;
  private readyImg!: Phaser.GameObjects.Image;
  private overImg!: Phaser.GameObjects.Image;
  private digits: Phaser.GameObjects.Image[] = [];
  private puffEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;

  // Net bookkeeping.
  private stateAcc = 0;
  private worldAcc = 0;
  private boardAcc = 0;
  private hostSeq = 0;
  private lastSeq = -1;
  private boardSig = "";
  private lastNetInfo = "";

  private hintEl: HTMLElement | null = null;
  private bestEl: HTMLElement | null = null;
  private boardEl: HTMLElement | null = null;
  private netInfoEl: HTMLElement | null = null;
  private soundEl: HTMLElement | null = null;
  private startEl: HTMLElement | null = null;
  private started = false;

  constructor() {
    super("Game");
  }

  create(): void {
    this.hintEl = document.getElementById("hint");
    this.bestEl = document.getElementById("best");
    this.boardEl = document.getElementById("board");
    this.netInfoEl = document.getElementById("netinfo");
    this.soundEl = document.getElementById("sound");
    this.startEl = document.getElementById("start");
    this.best = readBest();
    this.skin = rollSkin();

    // Muted by default; returning players who opted into sound stay unmuted.
    this.sound.mute = storageGet(SOUND_KEY) !== "1";
    this.refreshSoundHud();

    this.net = new NetSession({
      room: MP_ROOM,
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

    // One reusable score-puff emitter; puff() just explodes it at a position.
    this.puffEmitter = this.add
      .particles(0, 0, "spark", {
        speed: { min: 30, max: 120 },
        angle: { min: 0, max: 360 },
        lifespan: { min: 240, max: 420 },
        scale: { start: 0.9, end: 0 },
        alpha: { start: 0.9, end: 0 },
        blendMode: Phaser.BlendModes.ADD,
        emitting: false,
      })
      .setDepth(15);

    this.readyImg = this.add.image(0, 0, "msg-ready").setScale(ART_SCALE).setDepth(30);
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
      if (!e.repeat) this.toggleMute();
    });

    // Phones have no M key — the pill itself is the mute toggle (>=44px
    // target). Removed on shutdown so a scene restart never double-binds.
    const soundTap = (): void => this.toggleMute();
    this.soundEl?.addEventListener("click", soundTap);

    this.scale.on(Phaser.Scale.Events.RESIZE, this.layout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.layout, this);
      this.soundEl?.removeEventListener("click", soundTap);
      this.net.destroy();
    });

    this.layout();
    this.setHint(HINT_FLAP);

    if (import.meta.env.DEV) {
      window.__fb = { scene: this, net: this.net };
    }
  }

  private buildStartScreen(): void {
    const controls = document.getElementById("start-controls");
    const go = document.getElementById("start-go");
    if (controls) {
      controls.textContent = TOUCH
        ? "Tap to flap\nTap sound to mute\nPose cam jumps also flap"
        : "Click / tap / Space — flap\nUp arrow also flaps\nM — mute";
    }
    if (go) go.textContent = TOUCH ? "tap to start" : "press any key to start";
    this.input.keyboard?.once("keyup", () => this.beginPlay());
    this.startEl?.addEventListener("pointerup", () => this.beginPlay(), { once: true });
  }

  private beginPlay(strength = 1, refire = false): void {
    if (this.started) return;
    this.started = true;
    this.startEl?.classList.add("hide");
    this.time.delayedCall(320, () => this.startEl?.remove());
    this.handleInput(strength, refire);
  }

  // ---- role helpers --------------------------------------------------------

  private get racing(): boolean {
    return this.net.otherPlayer() !== null;
  }
  /**
   * True only when actually connected to a live party room (not the solo
   * fallback) — used by the wrapper's pause handler so it never freezes a
   * session other players are relying on.
   */
  isOnline(): boolean {
    return this.net.live && !this.net.offline;
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
    this.net.tick();
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
      this.bird.y = this.birdY + DRAGON_SPRITE_OFFSET_Y;
      this.bird.rotation = Phaser.Math.Clamp(this.vy * TILT_FACTOR, -MAX_TILT, MAX_TILT);
      this.checkScore();
      this.checkCoins();
      this.checkDeath();
    } else if (this.phase === "gameover" && this.racing) {
      // Multiplayer: crash is a brief setback, then rejoin the live course.
      if (time - this.diedAt >= RESPAWN_MS) this.respawn();
    }

    this.applyParallax();
    this.syncPipes();
    this.syncGhosts();
    this.broadcast(dt);
    this.updateBoard(dt);
  }

  // ---- seed + world scroll -------------------------------------------------

  private ensureSeed(): void {
    const s = this.net.sharedState;
    const shared = s ? numField(s, "seed") : null;
    if (shared !== null) {
      this.seed = shared;
      return;
    }
    // First host seeds the course. Guests wait for it (bird just hovers).
    if (this.net.isHost) {
      if (this.seed === 0) this.seed = randomSeed();
      this.net.patchShared({ seed: this.seed });
    }
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

  private handleInput(strength = 1, refire = false): void {
    if (!this.started) {
      this.beginPlay(strength, refire);
      return;
    }
    if (this.phase === "ready") {
      this.setPhase("playing");
      this.birdY = this.racing ? this.spawnY() : BIRD_SPAWN_Y;
      this.vy = 0;
      this.bird.setAlpha(1).clearTint().setTintMode(Phaser.TintModes.MULTIPLY);
      this.bird.y = this.birdY + DRAGON_SPRITE_OFFSET_Y;
      this.lastScoredIndex = this.frontIndex();
      this.collectedCoins.clear();
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
    this.sound.play("flap", { rate: 0.95 + Math.random() * 0.1 });
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
  }

  /** Solo: any input on gameover drops straight back into playing. */
  private restart(): void {
    this.score = 0;
    this.birdY = BIRD_SPAWN_Y;
    this.vy = 0;
    this.worldX = 0; // solo: start the course over
    this.lastScoredIndex = -1;
    this.collectedCoins.clear();
    if (!this.racing) {
      this.seed = randomSeed(); // fresh course when truly alone
      // Publish the reroll, or ensureSeed() re-adopts the stale shared seed
      // next frame and every solo run replays the identical course. (Offline
      // this writes the local loopback state; a non-host can't be alone.)
      this.net.patchShared({ seed: this.seed });
    }
    this.clearPipes();

    this.skin = rollSkin();
    this.bird.setPosition(BIRD_X + DRAGON_SPRITE_OFFSET_X, BIRD_SPAWN_Y + DRAGON_SPRITE_OFFSET_Y);
    this.enterPlaying();
  }

  /** Multiplayer: respawn into the still-scrolling shared course. */
  private respawn(): void {
    this.score = 0;
    this.birdY = this.spawnY();
    this.vy = 0;
    this.lastScoredIndex = this.frontIndex();
    this.collectedCoins.clear();
    this.enterPlaying();
  }

  /** Shared tail of restart()/respawn(): reset the bird's look + HUD, go live. */
  private enterPlaying(): void {
    this.tweens.killTweensOf(this.bird);
    this.bird
      .setRotation(0)
      .setScale(ART_SCALE)
      .setAlpha(1)
      .clearTint()
      .setTintMode(Phaser.TintModes.MULTIPLY);
    this.bird.play(`fly-${this.skin}`);
    this.overImg.setVisible(false);
    this.setBest("");
    this.setHint("");
    this.refreshScore();
    this.setPhase("playing");
  }

  private die(): void {
    this.setPhase("gameover");
    this.diedAt = this.time.now;
    this.sound.play("hit");
    this.bird.stop();
    this.bird.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
    this.time.delayedCall(90, () => {
      if (this.phase === "gameover") this.bird.clearTint().setTintMode(Phaser.TintModes.MULTIPLY);
    });
    this.cameras.main.shake(120, 0.008);

    const isNewBest = this.score > this.best;
    if (isNewBest) {
      this.best = this.score;
      writeBest(this.best);
    }
    this.overImg.setVisible(true);
    this.setBest(`${isNewBest ? "NEW BEST" : "BEST"} ${this.best}`);
    this.setHint(this.racing ? "" : HINT_RESTART);
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
    const topBody = this.add
      .tileSprite(0, 0, PIPE_WIDTH, Math.max(1, topHeight - TUBE_CAP_H + 2), "tube-body")
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

    const pipe: Pipe = { index: i, topHeight, topCap, topBody, botCap, botBody, coin };
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
  }

  private clearPipes(): void {
    for (const pipe of this.pipes.values()) destroyPipe(pipe);
    this.pipes.clear();
  }

  private checkScore(): void {
    for (const pipe of this.pipes.values()) {
      if (pipe.index <= this.lastScoredIndex) continue;
      if (this.screenX(pipe.index) + PIPE_WIDTH > BIRD_X) continue;
      this.lastScoredIndex = pipe.index;
      this.score += 1;
      this.sound.play("point");
      this.refreshScore();
      this.scorePop();
      this.puff(this.bird.x, this.bird.y);
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
      this.collectedCoins.add(pipe.index);
      this.collectCoin(coin);
    }
  }

  private collectCoin(coin: Phaser.GameObjects.Sprite): void {
    const burst = this.add
      .sprite(coin.x, coin.y, "burst-1")
      .setScale(ART_SCALE)
      .setDepth(7)
      .play("burst");
    burst.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => burst.destroy());
    coin.destroy();
    this.score += 1;
    this.sound.play("point", { rate: 1.5 });
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
      if (
        (this.birdY < pipe.topHeight && this.birdY + BIRD_H > 0) ||
        this.birdY + BIRD_H > pipe.topHeight + PIPE_GAP
      ) {
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
    const me = this.net.playerId;
    // Stable left-to-right ordering shared by every client (same players map),
    // so each rival keeps a consistent lane instead of jittering frame to frame.
    // `.filter()` already returns a fresh array, so sorting it in place is safe.
    // Sorting keeps the left-to-right order stable across clients and frames.
    const others = Object.keys(this.net.players)
      .filter((id) => id !== me)
      .sort();
    const seen = new Set<string>();

    // Fan rivals out to the right of your own dragon (which stays at BIRD_X).
    // Each keeps a per-id gap + depth so the flock is loose, not a fixed grid;
    // gaps accumulate so rivals never overlap however uneven the spacing.
    let laneX = BIRD_X + DRAGON_SPRITE_OFFSET_X;
    for (const id of others) {
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

  private puff(x: number, y: number): void {
    this.puffEmitter.explode(10, x, y);
  }

  private scorePop(): void {
    for (const digit of this.digits) {
      this.tweens.killTweensOf(digit);
      digit.setY(SCORE_Y - 6);
      this.tweens.add({ targets: digit, y: SCORE_Y, duration: 160, ease: "Back.easeOut" });
    }
  }

  // ---- HUD -----------------------------------------------------------------

  private refreshScore(): void {
    const text = String(this.score);
    while (this.digits.length < text.length) {
      this.digits.push(this.add.image(0, SCORE_Y, "digits", 0).setOrigin(0, 0).setDepth(20));
    }
    while (this.digits.length > text.length) {
      const d = this.digits.pop();
      d?.destroy();
    }

    const startX = (this.viewW() - text.length * DIGIT_W) / 2;
    for (const [i, digit] of this.digits.entries()) {
      digit
        .setFrame(text.charCodeAt(i) - 48)
        .setPosition(startX + i * DIGIT_W, SCORE_Y)
        .setDisplaySize(DIGIT_W, DIGIT_H);
    }
  }

  private setHint(text: string): void {
    if (this.hintEl) this.hintEl.textContent = text;
  }

  private setBest(text: string): void {
    if (this.bestEl) this.bestEl.textContent = text;
  }

  private toggleMute(): void {
    const muted = !this.sound.mute;
    this.sound.mute = muted;
    storageSet(SOUND_KEY, muted ? "0" : "1");
    // Autoplay policy may have left the context suspended (we boot muted, so
    // nothing forced it awake). We're inside a user gesture — resume is safe.
    if (
      !muted &&
      this.sound instanceof Phaser.Sound.WebAudioSoundManager &&
      this.sound.context.state === "suspended"
    ) {
      void this.sound.context.resume();
    }
    this.refreshSoundHud();
  }

  private refreshSoundHud(): void {
    if (!this.soundEl) return;
    this.soundEl.textContent = this.sound.mute ? "🔇" : "🔊";
  }

  /** Live race leaderboard + connection info (multiplayer only). */
  private updateBoard(dt: number): void {
    const netInfo = !this.net.live
      ? "connecting…"
      : this.net.offline
        ? "offline · solo"
        : this.racing
          ? `race · ${Object.keys(this.net.players).length} players`
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

    const me = this.net.playerId;
    const rows: Array<{ id: string; score: number; live: boolean; me: boolean }> = [];
    for (const [id, player] of Object.entries(this.net.players)) {
      if (id === me) {
        rows.push({ id, score: this.score, live: this.alive, me: true });
      } else {
        const ps = readPeer(player.state);
        rows.push({ id, score: ps?.score ?? 0, live: ps?.live ?? false, me: false });
      }
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

  /** Logical view width: screen width divided by the course zoom. */
  private viewW(): number {
    return (this.scale.width * COURSE_H) / this.scale.height;
  }

  private layout(): void {
    // The whole world lives in a fixed COURSE_H-tall logical space; the camera
    // zooms it to fill the real viewport height. Every client therefore plays
    // the exact same course geometry (the 8-player race stays fair), and short
    // phone-landscape viewports just render it smaller instead of breaking.
    const zoom = this.scale.height / COURSE_H;
    const width = this.viewW();
    this.cameras.main.setZoom(zoom).centerOn(width / 2, COURSE_H / 2);
    const tileScale = COURSE_H / BG_NATIVE_H;
    for (const layer of this.bgLayers) {
      layer.sprite.setSize(width, COURSE_H).setTileScale(tileScale);
    }
    this.applyParallax();
    // Narrow logical viewports (phone portrait) can't fit the banners at 2×.
    for (const img of [this.readyImg, this.overImg]) {
      img
        .setScale(Math.min(ART_SCALE, (width - 16) / img.width))
        .setPosition(width / 2, COURSE_H / 2);
    }
    this.refreshScore();
    // The visible pipe window depends on the logical width — rebuild.
    this.clearPipes();
  }

  private applyParallax(): void {
    const tileScale = COURSE_H / BG_NATIVE_H;
    const px = this.worldX + this.readyDrift;
    for (const layer of this.bgLayers) {
      layer.sprite.tilePositionX = (px * layer.factor) / tileScale;
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
}

function randomSeed(): number {
  // 1..2^31 (never 0 — 0 marks "unseeded").
  return 1 + Math.floor(Math.random() * 0x7fffffff);
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

function numField(s: Record<string, unknown>, key: string): number | null {
  const v = s[key];
  return typeof v === "number" ? v : null;
}

function readPeer(state: unknown): PeerState | null {
  if (!state || typeof state !== "object") return null;
  const yf = "yf" in state ? state.yf : null;
  const skin = "skin" in state ? state.skin : null;
  if (typeof yf !== "number" || typeof skin !== "number") return null;
  const live = "live" in state ? state.live : null;
  const score = "score" in state ? state.score : null;
  const rot = "rot" in state ? state.rot : null;
  return {
    yf,
    live: live === true,
    score: typeof score === "number" ? score : 0,
    skin,
    rot: typeof rot === "number" ? rot : 0,
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
