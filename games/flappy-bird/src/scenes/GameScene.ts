import Phaser from "phaser";

import {
  BEST_KEY,
  BIRD_H,
  BIRD_SPAWN_Y,
  BIRD_W,
  BIRD_X,
  DIGIT_H,
  DIGIT_W,
  flapVelocityFor,
  GRAVITY,
  MAX_TILT,
  PIPE_DRAW_HEIGHT,
  PIPE_GAP,
  PIPE_SPAWN_DISTANCE,
  PIPE_SPEED,
  PIPE_WIDTH,
  rollTopHeight,
  SCORE_Y,
  TILT_FACTOR,
  type Phase,
} from "../shared/constants";

type Pipe = {
  /** Left edge. */
  x: number;
  /** Bottom of the top segment = top edge of the gap. */
  topHeight: number;
  scored: boolean;
  top: Phaser.GameObjects.Image;
  bottom: Phaser.GameObjects.Image;
};

/** Swallow inputs briefly after death so a flap-mash can't skip the gameover screen. */
const RESTART_LOCKOUT_MS = 280;
/** Cap delta so a backgrounded tab can't tunnel the bird through a pipe. */
const MAX_DT_MS = 50;

const HINT_FLAP = "CLICK · TAP · SPACE — FLAP";
const HINT_RESTART = "TAP ANYWHERE TO RESTART";

export class GameScene extends Phaser.Scene {
  private phase: Phase = "ready";
  /** Top edge of the bird's AABB (legacy coordinate; sprite renders centered). */
  private birdY = BIRD_SPAWN_Y;
  private vy = 0;
  private pipes: Pipe[] = [];
  private score = 0;
  private best = 0;
  private diedAt = 0;

  private bg!: Phaser.GameObjects.Image;
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

    this.bg = this.add.image(0, 0, "background").setOrigin(0, 0).setDepth(-10);
    this.bird = this.add
      .sprite(BIRD_X + BIRD_W / 2, BIRD_SPAWN_Y + BIRD_H / 2, "bird-mid")
      .setDepth(10);
    this.bird.play("flap");
    this.readyImg = this.add.image(0, 0, "ready").setDepth(30);
    this.overImg = this.add.image(0, 0, "gameover").setDepth(30).setVisible(false);

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
    if (this.phase === "ready") {
      // Gentle hover so the title screen breathes.
      this.bird.y = BIRD_SPAWN_Y + BIRD_H / 2 + Math.sin(time / 300) * 4;
      return;
    }
    if (this.phase !== "playing") return; // gameover: world frozen at death pose

    const dt = Math.min(delta, MAX_DT_MS) / 1000;

    // Legacy integration order: position first, then gravity into velocity.
    this.birdY += this.vy * dt;
    this.vy += GRAVITY * dt;
    this.bird.y = this.birdY + BIRD_H / 2;
    this.bird.rotation = Phaser.Math.Clamp(this.vy * TILT_FACTOR, -MAX_TILT, MAX_TILT);

    this.movePipes(dt);
    this.spawnAndPrunePipes();
    this.checkScore();
    this.checkDeath();
  }

  // ---- input -----------------------------------------------------------------

  private handleInput(strength = 1, refire = false): void {
    if (this.phase === "ready") {
      // First input starts the run without flapping (legacy behavior).
      this.phase = "playing";
      this.bird.y = this.birdY + BIRD_H / 2;
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
    this.bird.setScale(1.15, 0.8);
    this.tweens.add({
      targets: this.bird,
      scaleX: 1,
      scaleY: 1,
      duration: 140,
      ease: "Quad.easeOut",
    });
  }

  // ---- state flow --------------------------------------------------------------

  /** Any input on gameover drops straight back into playing (skips the ready screen). */
  private restart(): void {
    for (const pipe of this.pipes) {
      pipe.top.destroy();
      pipe.bottom.destroy();
    }
    this.pipes = [];
    this.score = 0;
    this.birdY = BIRD_SPAWN_Y;
    this.vy = 0;

    this.tweens.killTweensOf(this.bird);
    this.bird
      .setPosition(BIRD_X + BIRD_W / 2, BIRD_SPAWN_Y + BIRD_H / 2)
      .setRotation(0)
      .setScale(1)
      .clearTint()
      .setTintMode(Phaser.TintModes.MULTIPLY);
    this.bird.play("flap");

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
      pipe.top.x = pipe.x;
      pipe.bottom.x = pipe.x;
    }
  }

  private spawnAndPrunePipes(): void {
    const width = this.scale.width;
    const last = this.pipes[this.pipes.length - 1];
    if (!last || last.x < width - PIPE_SPAWN_DISTANCE) this.spawnPipe(width);

    while (this.pipes.length > 0 && this.pipes[0]!.x + PIPE_WIDTH < 0) {
      const dead = this.pipes.shift()!;
      dead.top.destroy();
      dead.bottom.destroy();
    }
  }

  private spawnPipe(x: number): void {
    const topHeight = rollTopHeight(this.scale.height);
    // Top segment hangs down to the gap, vertically mirrored so the cap faces it.
    const top = this.add
      .image(x, topHeight, "pipe")
      .setOrigin(0, 1)
      .setFlipY(true)
      .setDisplaySize(PIPE_WIDTH, PIPE_DRAW_HEIGHT);
    const bottom = this.add
      .image(x, topHeight + PIPE_GAP, "pipe")
      .setOrigin(0, 0)
      .setDisplaySize(PIPE_WIDTH, PIPE_DRAW_HEIGHT);
    this.pipes.push({ x, topHeight, scored: false, top, bottom });
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

  private checkDeath(): void {
    // Floor only — no ceiling kill; flying above the screen is legal (legacy quirk).
    if (this.birdY > this.scale.height) {
      this.die();
      return;
    }
    for (const pipe of this.pipes) {
      if (BIRD_X + BIRD_W <= pipe.x || BIRD_X >= pipe.x + PIPE_WIDTH) continue;
      // Top segment is the rect (pipe.x, 0, w, topHeight) — a bird fully above
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
      this.digits.push(this.add.image(0, SCORE_Y, "digit-0").setOrigin(0, 0).setDepth(20));
    }
    while (this.digits.length > text.length) this.digits.pop()!.destroy();

    const startX = (this.scale.width - text.length * DIGIT_W) / 2;
    for (let i = 0; i < text.length; i++) {
      this.digits[i]!.setTexture(`digit-${text[i]!}`)
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
    this.bg.setDisplaySize(width, height);
    this.readyImg.setPosition(width / 2, height / 2);
    this.overImg.setPosition(width / 2, height / 2);
    this.refreshScore();
  }
}

// ---- module helpers (pure) -----------------------------------------------------------

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
