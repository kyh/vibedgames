import Phaser from "phaser";

/** Source frame size of the generated player walk sheets (2x2 grid in a 512² image). */
const PLAYER_FRAME = 256;
/** Source frame size of the explosion strip (16 frames in a 2048×128 image). */
const EXPLO_FRAME = 128;
const EXPLO_FRAMES = 16;

export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    this.makeUtilTextures();

    // Tiles + props (all generated via `vg generate`, transparent where needed).
    this.load.image("floor", "assets/floor.png");
    this.load.image("wall", "assets/wall.png");
    this.load.image("crate", "assets/crate.png");
    this.load.image("bomb", "assets/bomb.png");
    this.load.image("pow-bomb", "assets/pow-bomb.png");
    this.load.image("pow-fire", "assets/pow-fire.png");
    this.load.image("pow-speed", "assets/pow-speed.png");

    // Directional walk sheets — 4 frames each (2x2). Left reuses side, flipped.
    const pframe = { frameWidth: PLAYER_FRAME, frameHeight: PLAYER_FRAME };
    this.load.spritesheet("player-down", "assets/player-down.png", pframe);
    this.load.spritesheet("player-up", "assets/player-up.png", pframe);
    this.load.spritesheet("player-side", "assets/player-side.png", pframe);

    // Explosion: 16-frame fire burst derived from a generated video, rendered
    // additively (pure-black background contributes nothing under ADD blend).
    this.load.spritesheet("explosion", "assets/explosion.png", {
      frameWidth: EXPLO_FRAME,
      frameHeight: EXPLO_FRAME,
    });
  }

  create(): void {
    const mk = (key: string, sheet: string) => {
      this.anims.create({
        key,
        frames: this.anims.generateFrameNumbers(sheet, { start: 0, end: 3 }),
        frameRate: 9,
        repeat: -1,
      });
    };
    mk("walk-down", "player-down");
    mk("walk-up", "player-up");
    mk("walk-side", "player-side");

    this.anims.create({
      key: "explode",
      frames: this.anims.generateFrameNumbers("explosion", { start: 0, end: EXPLO_FRAMES - 1 }),
      frameRate: 32,
      repeat: 0,
    });

    this.scene.start("Game");
  }

  /** Soft procedural textures for shadows, particles, and glows. */
  private makeUtilTextures(): void {
    const g = this.add.graphics();

    // Soft contact shadow (squashed ellipse, faded).
    g.fillStyle(0x000000, 0.32).fillEllipse(32, 16, 56, 26);
    g.generateTexture("shadow", 64, 32);
    g.clear();

    // Soft round particle for poofs/sparkles (concentric falloff).
    for (let i = 6; i >= 1; i--) {
      g.fillStyle(0xffffff, 0.18).fillCircle(16, 16, (i / 6) * 14);
    }
    g.generateTexture("spark", 32, 32);
    g.clear();

    // Radial glow disc (additive) for powerup pedestals and bomb tells.
    for (let i = 16; i >= 1; i--) {
      g.fillStyle(0xffffff, 0.05).fillCircle(64, 64, (i / 16) * 62);
    }
    g.generateTexture("glow", 128, 128);
    g.destroy();
  }
}
