import { Scene } from "phaser";

/** Source frame size of the generated player walk sheets (2x2 grid in a 512² image). */
const PLAYER_FRAME = 256;
/** Source frame size of the explosion strip (16 frames in a 2048×128 image). */
const EXPLO_FRAME = 128;
const EXPLO_FRAMES = 16;

export class BootScene extends Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    this.makeUtilTextures();

    // Tiles + props (all generated via `vg generate`, transparent where needed).
    this.load.image("floor", "assets/floor.webp");
    this.load.image("wall", "assets/wall.webp");
    this.load.image("crate", "assets/crate.webp");
    this.load.image("bomb", "assets/bomb.webp");
    this.load.image("pow-bomb", "assets/pow-bomb.webp");
    this.load.image("pow-fire", "assets/pow-fire.webp");
    this.load.image("pow-speed", "assets/pow-speed.webp");

    // Directional walk sheets — 4 frames each (2x2). Left reuses side, flipped.
    const pframe = { frameHeight: PLAYER_FRAME, frameWidth: PLAYER_FRAME };
    this.load.spritesheet("player-down", "assets/player-down.webp", pframe);
    this.load.spritesheet("player-up", "assets/player-up.webp", pframe);
    this.load.spritesheet("player-side", "assets/player-side.webp", pframe);

    // Explosion: 16-frame fire burst derived from a generated video, rendered
    // additively (pure-black background contributes nothing under ADD blend).
    this.load.spritesheet("explosion", "assets/explosion.webp", {
      frameHeight: EXPLO_FRAME,
      frameWidth: EXPLO_FRAME,
    });
  }

  create(): void {
    const mk = (key: string, sheet: string) => {
      this.anims.create({
        frameRate: 9,
        frames: this.anims.generateFrameNumbers(sheet, { end: 3, start: 0 }),
        key,
        repeat: -1,
      });
    };
    mk("walk-down", "player-down");
    mk("walk-up", "player-up");
    mk("walk-side", "player-side");

    this.anims.create({
      frameRate: 32,
      frames: this.anims.generateFrameNumbers("explosion", { end: EXPLO_FRAMES - 1, start: 0 }),
      key: "explode",
      repeat: 0,
    });

    this.scene.start("Game");
  }

  /** Soft procedural textures for shadows, particles, and glows. */
  private makeUtilTextures(): void {
    const g = this.add.graphics();

    // Soft contact shadow (squashed ellipse, faded).
    g.fillStyle(0x00_00_00, 0.32).fillEllipse(32, 16, 56, 26);
    g.generateTexture("shadow", 64, 32);
    g.clear();

    // Soft round particle for poofs/sparkles (concentric falloff).
    for (let i = 6; i >= 1; i -= 1) {
      g.fillStyle(0xff_ff_ff, 0.18).fillCircle(16, 16, (i / 6) * 14);
    }
    g.generateTexture("spark", 32, 32);
    g.clear();

    // Radial glow disc (additive) for powerup pedestals and bomb tells.
    for (let i = 16; i >= 1; i -= 1) {
      g.fillStyle(0xff_ff_ff, 0.05).fillCircle(64, 64, (i / 16) * 62);
    }
    g.generateTexture("glow", 128, 128);
    g.destroy();
  }
}
