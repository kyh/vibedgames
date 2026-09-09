import Phaser from "phaser";
import { ACTION_SHEETS } from "../render/character-action";

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

    // The original grass stays as the garden beyond the courtyard. The v2 stone
    // floor is 384px = six slabs, so each slab lands on one 64px grid cell.
    this.load.image("grass", "assets/floor.webp");
    this.load.image("floor", "assets/floor-v2.webp");
    this.load.image("wall", "assets/wall-v2.webp");
    this.load.image("crate", "assets/crate-v2.webp");
    this.load.image("bomb", "assets/bomb-v2.webp");
    this.load.image("pow-bomb", "assets/pow-bomb-v2.webp");
    this.load.image("pow-fire", "assets/pow-fire-v2.webp");
    this.load.image("pow-speed", "assets/pow-speed-v2.webp");

    // Directional walk sheets — 4 frames each (2x2). Left reuses side, flipped.
    const pframe = { frameHeight: PLAYER_FRAME, frameWidth: PLAYER_FRAME };
    this.load.spritesheet("player-down", "assets/player-down.webp", pframe);
    this.load.spritesheet("player-up", "assets/player-up.webp", pframe);
    this.load.spritesheet("player-side", "assets/player-side.webp", pframe);
    for (const sheet of ACTION_SHEETS) {
      this.load.image(sheet.key, sheet.url);
    }

    // Explosion: 16-frame fire burst derived from a generated video, rendered
    // additively (pure-black background contributes nothing under ADD blend).
    this.load.spritesheet("explosion", "assets/explosion.webp", {
      frameHeight: EXPLO_FRAME,
      frameWidth: EXPLO_FRAME,
    });
  }

  create(): void {
    // Smooth the painted v2 props at the follow camera's fractional zoom; the
    // pixel-art character sheets and fire keep NEAREST.
    for (const key of ["floor", "wall", "crate", "bomb", "pow-bomb", "pow-fire", "pow-speed"]) {
      this.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR);
    }

    const mk = (key: string, sheet: string) => {
      this.anims.create({
        frameRate: 9,
        frames: this.anims.generateFrameNumbers(sheet, { start: 0, end: 3 }),
        key,
        repeat: -1,
      });
    };
    mk("walk-down", "player-down");
    mk("walk-up", "player-up");
    mk("walk-side", "player-side");

    for (const sheet of ACTION_SHEETS) {
      const texture = this.textures.get(sheet.key);
      texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
      sheet.frames.forEach((cut, index) => {
        const frame = texture.add(index, 0, cut.x, cut.y, cut.width, cut.height);
        if (!frame) {
          return;
        }
        frame.customPivot = true;
        frame.pivotX = cut.feetX / cut.width;
        frame.pivotY = cut.feetY / cut.height;
      });
    }

    this.anims.create({
      frameRate: 32,
      frames: this.anims.generateFrameNumbers("explosion", { start: 0, end: EXPLO_FRAMES - 1 }),
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

    // Broad, shallow contact under square props, lit from the upper left.
    for (let inset = 0; inset < 4; inset++) {
      g.fillStyle(0x101b1b, 0.07).fillRoundedRect(
        2 + inset,
        3 + inset,
        68 - inset * 2,
        58 - inset * 2,
        7,
      );
    }
    g.generateTexture("prop-shadow", 72, 64);
    g.clear();

    // Soft round particle for poofs/sparkles (concentric falloff).
    for (let i = 6; i >= 1; i--) {
      g.fillStyle(0xff_ff_ff, 0.18).fillCircle(16, 16, (i / 6) * 14);
    }
    g.generateTexture("spark", 32, 32);
    g.clear();

    g.fillStyle(0xff_ff_ff).fillRect(0, 0, 7, 3);
    g.generateTexture("chip", 7, 3);
    g.clear();

    // A quiet tile footprint connects the original fire bursts without bloom.
    g.fillStyle(0xff_a2_4b, 0.13).fillRoundedRect(3, 3, 58, 58, 5);
    g.lineStyle(1.5, 0xff_c2_7a, 0.46).strokeRoundedRect(3, 3, 58, 58, 5);
    g.generateTexture("blast-cell", 64, 64);
    g.clear();

    // Radial glow disc (additive) for powerup pedestals and bomb tells.
    for (let i = 16; i >= 1; i--) {
      g.fillStyle(0xff_ff_ff, 0.05).fillCircle(64, 64, (i / 16) * 62);
    }
    g.generateTexture("glow", 128, 128);
    g.destroy();
  }
}
