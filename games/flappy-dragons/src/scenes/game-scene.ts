import Phaser from "phaser";

import {
  ART_SCALE,
  BEST_KEY,
  BG_FACTORS,
  BG_NATIVE_H,
  BIRD_H,
  BIRD_SPAWN_Y,
  BIRD_W,
  BIRD_X,
  COIN_CHANCE,
  DIGIT_H,
  DIGIT_W,
  DRAGON_SPRITE_OFFSET_X,
  DRAGON_SPRITE_OFFSET_Y,
  flapVelocityFor,
  GRAVITY,
  MAX_TILT,
  PIPE_GAP,
  PIPE_SPAWN_DISTANCE,
  PIPE_SPEED,
  PIPE_WIDTH,
  READY_DRIFT,
  rollCoinY,
  rollSkin,
  rollTopHeight,
  SCORE_Y,
  TILT_FACTOR,
  TUBE_CAP_H,
  type Phase,
} from "../shared/constants";

type Pipe = {
  /** Left edge of the trunk body (collision rect). */
  x: number;
  /** Bottom of the top segment = top edge of the gap. */
  topHeight: number;
  scored: boolean;
  topCap: Phaser.GameObjects.Image;
  topBody: Phaser.GameObjects.TileSprite;
  botCap: Phaser.GameObjects.Image;
  botBody: Phaser.GameObjects.TileSprite;
  /** Bonus coin floating in the gap (some trunks only). */
  coin: Phaser.GameObjects.Sprite | null;
};

type BgLayer = {
  sprite: Phaser.GameObjects.TileSprite;
  /** Parallax factor × world scroll. */
  factor: number;
};

/** Coin pickup AABB half-extents (dragon 76×48 + coin 32, with a little grace). */
const COIN_PICKUP_X = 54;
const COIN_PICKUP_Y = 44;

/** Swallow inputs briefly after death so a flap-mash can't skip the gameover screen. */
const RESTART_LOCKOUT_MS = 280;
/** Cap delta so a backgrounded tab can't tunnel the dragon through a trunk. */
const MAX_DT_MS = 50;

const HINT_FLAP = "CLICK · TAP · SPACE — FLAP";
const HINT_RESTART = "TAP ANYWHERE TO RESTART";

export class GameScene extends Phaser.Scene {
  private phase: Phase = "ready";
  /** Top edge of the dragon's AABB (legacy coordinate; sprite renders offset). */
  private birdY = BIRD_SPAWN_Y;
  private vy = 0;
  private pipes: Pipe[] = [];
  private score = 0;
  private best = 0;
  private diedAt = 0;
  private skin = 1;
  /** Cumulative world scroll driving the parallax layers. */
  private worldX = 0;

  private bgLayers: BgLayer[] = [];
  private bird!: Phaser.GameObjects.Sprite;
  private readyImg!: Phaser.GameObjects.Image;
  private overImg!: Phaser.GameObjects.Image;
  private digits: Phaser.GameObjects.Image[] = [];

  private hintEl: HTMLElement | null = null;
  private bestEl: HTMLElement | null = null;

  constructor() {
    super("Game");
  }

  create(): void {
    this.hintEl = document.getElementById("hint");
    this.bestEl = document.getElementById("best");
    this.best = readBest();
    this.skin = rollSkin();

    // Trees World parallax: clouds, far trunks, near trunks behind the action;
    // foreground bushes in front of the trunks but behind the dragon.
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

    this.readyImg = this.add.image(0, 0, "msg-ready").setScale(ART_SCALE).setDepth(30);
    this.overImg = this.add
      .image(0, 0, "msg-gameover")
      .setScale(ART_SCALE)
      .setDepth(30)
      .setVisible(false);

    this.input.on("pointerdown", () => this.handleInput());
    // Guard e.repeat: no Key object is registered for these codes, so the
    // KeyboardPlugin won't suppress OS auto-repeat itself.
    this.input.keyboard?.on("keydown-SPACE", (e: KeyboardEvent) => {
      if (!e.repeat) this.handleInput();
    });
    this.input.keyboard?.on("keydown-UP", (e: KeyboardEvent) => {
      if (!e.repeat) this.handleInput();
    });

    this.scale.on(Phaser.Scale.Events.RESIZE, this.layout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.layout, this);
    });

    this.layout();
    this.setHint(HINT_FLAP);

    if (import.meta.env.DEV) {
      (window as unknown as { __fb?: unknown }).__fb = { scene: this };
    }
  }

  update(time: number, delta: number): void {
    const dt = Math.min(delta, MAX_DT_MS) / 1000;

    if (this.phase === "ready") {
      // Gentle hover + drifting clouds so the title screen breathes.
      this.bird.y = BIRD_SPAWN_Y + DRAGON_SPRITE_OFFSET_Y + Math.sin(time / 300) * 4;
      this.worldX += READY_DRIFT * dt;
      this.applyParallax();
      return;
    }
    if (this.phase !== "playing") return; // gameover: world frozen at death pose

    // Legacy integration order: position first, then gravity into velocity.
    this.birdY += this.vy * dt;
    this.vy += GRAVITY * dt;
    this.bird.y = this.birdY + DRAGON_SPRITE_OFFSET_Y;
    this.bird.rotation = Phaser.Math.Clamp(this.vy * TILT_FACTOR, -MAX_TILT, MAX_TILT);

    this.worldX += PIPE_SPEED * dt;
    this.applyParallax();
    this.movePipes(dt);
    this.spawnAndPrunePipes();
    this.checkScore();
    this.checkCoins();
    this.checkDeath();
  }

  // ---- input -----------------------------------------------------------------

  private handleInput(strength = 1, refire = false): void {
    if (this.phase === "ready") {
      // First input starts the run without flapping (legacy behavior).
      this.phase = "playing";
      this.bird.y = this.birdY + DRAGON_SPRITE_OFFSET_Y;
      this.readyImg.setVisible(false);
      this.setHint("");
      return;
    }
    if (this.phase === "playing") {
      this.flap(strength, refire);
      return;
    }
    if (this.time.now - this.diedAt < RESTART_LOCKOUT_MS) return;
    this.restart();
  }

  /**
   * Webcam pose-jump entry point (variable strength 0..1). Routes through the
   * same path as tap/keyboard: starts the run from ready, restarts from
   * gameover. refire = airborne min-Y update of the same physical jump —
   * refreshes velocity (legacy set it on every callback) without re-juicing.
   */
  poseJump(strength: number, refire: boolean): void {
    this.handleInput(strength, refire);
  }

  private flap(strength: number, refire = false): void {
    // Legacy mapping: -8..-12 px/tick scaled by strength → -480..-720 px/s.
    this.vy = flapVelocityFor(strength);
    if (refire) return; // velocity-only refresh; no sound/squash spam mid-jump
    // The legacy build loaded flap.wav but never played it — wired up here.
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

  // ---- state flow --------------------------------------------------------------

  /** Any input on gameover drops straight back into playing (skips the ready screen). */
  private restart(): void {
    for (const pipe of this.pipes) destroyPipe(pipe);
    this.pipes = [];
    this.score = 0;
    this.birdY = BIRD_SPAWN_Y;
    this.vy = 0;

    // Fresh run, fresh dragon.
    this.skin = rollSkin();
    this.tweens.killTweensOf(this.bird);
    this.bird
      .setPosition(BIRD_X + DRAGON_SPRITE_OFFSET_X, BIRD_SPAWN_Y + DRAGON_SPRITE_OFFSET_Y)
      .setRotation(0)
      .setScale(ART_SCALE)
      .clearTint()
      .setTintMode(Phaser.TintModes.MULTIPLY);
    this.bird.play(`fly-${this.skin}`);

    this.overImg.setVisible(false);
    this.setBest("");
    this.setHint("");
    this.refreshScore();
    this.phase = "playing";
  }

  private die(): void {
    this.phase = "gameover";
    this.diedAt = this.time.now;
    this.sound.play("hit");
    this.bird.stop();

    // Hit flash + brief shake; the world otherwise freezes at the death pose.
    this.bird.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
    this.time.delayedCall(90, () => {
      this.bird.clearTint().setTintMode(Phaser.TintModes.MULTIPLY);
    });
    this.cameras.main.shake(120, 0.008);

    const isNewBest = this.score > this.best;
    if (isNewBest) {
      this.best = this.score;
      writeBest(this.best);
    }
    this.overImg.setVisible(true);
    this.setBest(`${isNewBest ? "NEW BEST" : "BEST"} ${this.best}`);
    this.setHint(HINT_RESTART);
  }

  // ---- simulation ----------------------------------------------------------------

  private movePipes(dt: number): void {
    for (const pipe of this.pipes) {
      pipe.x -= PIPE_SPEED * dt;
      pipe.topBody.x = pipe.x;
      pipe.botBody.x = pipe.x;
      pipe.topCap.x = pipe.x + PIPE_WIDTH / 2;
      pipe.botCap.x = pipe.x + PIPE_WIDTH / 2;
      if (pipe.coin) pipe.coin.x = pipe.x + PIPE_WIDTH / 2;
    }
  }

  private spawnAndPrunePipes(): void {
    const width = this.scale.width;
    const last = this.pipes[this.pipes.length - 1];
    if (!last || last.x < width - PIPE_SPAWN_DISTANCE) this.spawnPipe(width);

    while (this.pipes.length > 0 && this.pipes[0]!.x + PIPE_WIDTH < 0) {
      destroyPipe(this.pipes.shift()!);
    }
  }

  private spawnPipe(x: number): void {
    const viewH = this.scale.height;
    // Integer height — fractional values open a 1px seam between body and cap.
    const topHeight = Math.round(rollTopHeight(viewH));
    const centerX = x + PIPE_WIDTH / 2;

    // Each trunk = rounded log-end cap facing the gap + bark body tiling away
    // from it. The cap (with its side branches) is wider than the body; only
    // the body rect is lethal. Body heights clamp to 1px, never 0 — zero-sized
    // TileSprites take down the WebGL context.
    const topBody = this.add
      .tileSprite(x, 0, PIPE_WIDTH, Math.max(1, topHeight - TUBE_CAP_H + 2), "tube-body")
      .setOrigin(0, 0)
      .setTileScale(ART_SCALE)
      .setDepth(0);
    const topCap = this.add
      .image(centerX, topHeight, "tube-cap")
      .setOrigin(0.5, 1)
      .setFlipY(true)
      .setScale(ART_SCALE)
      .setDepth(1);
    const botCap = this.add
      .image(centerX, topHeight + PIPE_GAP, "tube-cap")
      .setOrigin(0.5, 0)
      .setScale(ART_SCALE)
      .setDepth(1);
    const botBodyY = topHeight + PIPE_GAP + TUBE_CAP_H - 2;
    const botBody = this.add
      .tileSprite(x, botBodyY, PIPE_WIDTH, Math.max(1, viewH - botBodyY), "tube-body")
      .setOrigin(0, 0)
      .setTileScale(ART_SCALE)
      .setDepth(0);

    const coin =
      Math.random() < COIN_CHANCE
        ? this.add.sprite(centerX, rollCoinY(topHeight), "coin-1").setScale(ART_SCALE).setDepth(4)
        : null;
    coin?.play("coin-spin");

    this.pipes.push({ x, topHeight, scored: false, topCap, topBody, botCap, botBody, coin });
  }

  private checkScore(): void {
    for (const pipe of this.pipes) {
      if (pipe.scored || pipe.x + PIPE_WIDTH > BIRD_X) continue;
      // Once per pipe — the legacy 2px window vs 2.5px step could skip points.
      pipe.scored = true;
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
    for (const pipe of this.pipes) {
      const coin = pipe.coin;
      if (!coin) continue;
      if (Math.abs(coin.x - cx) >= COIN_PICKUP_X || Math.abs(coin.y - cy) >= COIN_PICKUP_Y) {
        continue;
      }
      pipe.coin = null;
      this.collectCoin(coin);
    }
  }

  /** Coins are worth a point — a risk/reward detour inside the gap. */
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
    // Floor only — no ceiling kill; flying above the screen is legal (legacy quirk).
    if (this.birdY > this.scale.height) {
      this.die();
      return;
    }
    for (const pipe of this.pipes) {
      if (BIRD_X + BIRD_W <= pipe.x || BIRD_X >= pipe.x + PIPE_WIDTH) continue;
      // Top segment is the rect (pipe.x, 0, w, topHeight) — a dragon fully above
      // the screen overlaps nothing (legacy AABB; off-screen flight stays legal).
      if (
        (this.birdY < pipe.topHeight && this.birdY + BIRD_H > 0) ||
        this.birdY + BIRD_H > pipe.topHeight + PIPE_GAP
      ) {
        this.die();
        return;
      }
    }
  }

  // ---- visual effects --------------------------------------------------------------

  private puff(x: number, y: number): void {
    const emitter = this.add.particles(x, y, "spark", {
      speed: { min: 30, max: 120 },
      angle: { min: 0, max: 360 },
      lifespan: { min: 240, max: 420 },
      scale: { start: 0.9, end: 0 },
      alpha: { start: 0.9, end: 0 },
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    });
    emitter.setDepth(15);
    emitter.explode(10);
    this.time.delayedCall(600, () => emitter.destroy());
  }

  private scorePop(): void {
    for (const digit of this.digits) {
      this.tweens.killTweensOf(digit);
      digit.setY(SCORE_Y - 6);
      this.tweens.add({
        targets: digit,
        y: SCORE_Y,
        duration: 160,
        ease: "Back.easeOut",
      });
    }
  }

  // ---- HUD -------------------------------------------------------------------------

  /** Sprite-digit score, top-center (legacy presentation, kept visible on gameover). */
  private refreshScore(): void {
    const text = String(this.score);
    while (this.digits.length < text.length) {
      this.digits.push(this.add.image(0, SCORE_Y, "digits", 0).setOrigin(0, 0).setDepth(20));
    }
    while (this.digits.length > text.length) this.digits.pop()!.destroy();

    const startX = (this.scale.width - text.length * DIGIT_W) / 2;
    for (let i = 0; i < text.length; i++) {
      this.digits[i]!.setFrame(Number(text[i]!))
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

  // ---- layout ------------------------------------------------------------------------

  private layout(): void {
    const { width, height } = this.scale;
    const tileScale = height / BG_NATIVE_H;
    for (const layer of this.bgLayers) {
      layer.sprite.setSize(width, height).setTileScale(tileScale);
    }
    this.applyParallax();
    this.readyImg.setPosition(width / 2, height / 2);
    this.overImg.setPosition(width / 2, height / 2);
    this.refreshScore();
  }

  private applyParallax(): void {
    const tileScale = this.scale.height / BG_NATIVE_H;
    for (const layer of this.bgLayers) {
      // tilePosition is in texture px; divide by tileScale to get screen px.
      layer.sprite.tilePositionX = (this.worldX * layer.factor) / tileScale;
    }
  }
}

// ---- module helpers (pure) -----------------------------------------------------------

function destroyPipe(pipe: Pipe): void {
  pipe.topCap.destroy();
  pipe.topBody.destroy();
  pipe.botCap.destroy();
  pipe.botBody.destroy();
  pipe.coin?.destroy();
}

function readBest(): number {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0; // storage blocked (private mode) — best just won't persist
  }
}

function writeBest(score: number): void {
  try {
    localStorage.setItem(BEST_KEY, String(score));
  } catch {
    // ignore — see readBest
  }
}
