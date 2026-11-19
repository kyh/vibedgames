import { Scene, Textures } from "phaser";
import { ACTION_SHEETS } from "../render/character-action";

const PLAYER_FRAME = 256;
const EXPLO_FRAME = 128;
const EXPLO_FRAMES = 16;

export class BootScene extends Scene {
  constructor() {
    super("Boot");
  }

  preload() {
    this.makeUtilTextures();

    this.load.image("grass", "assets/floor.webp");
    this.load.image("floor", "assets/floor-v2.webp");
    this.load.image("wall", "assets/wall-v2.webp");
    this.load.image("crate", "assets/crate-v2.webp");
    this.load.image("bomb", "assets/bomb-v2.webp");
    this.load.image("pow-bomb", "assets/pow-bomb-v2.webp");
    this.load.image("pow-fire", "assets/pow-fire-v2.webp");
    this.load.image("pow-speed", "assets/pow-speed-v2.webp");

    const pframe = { frameHeight: PLAYER_FRAME, frameWidth: PLAYER_FRAME };
    this.load.spritesheet("player-down", "assets/player-down.webp", pframe);
    this.load.spritesheet("player-up", "assets/player-up.webp", pframe);
    this.load.spritesheet("player-side", "assets/player-side.webp", pframe);

    for (const sheet of ACTION_SHEETS) {
      this.load.image(sheet.key, sheet.url);
    }

    this.load.spritesheet("explosion", "assets/explosion.webp", {
      frameHeight: EXPLO_FRAME,
      frameWidth: EXPLO_FRAME,
    });
  }

  create() {
    for (const key of ["floor", "wall", "crate", "bomb", "pow-bomb", "pow-fire", "pow-speed"]) {
      this.textures.get(key).setFilter(Textures.FilterMode.LINEAR);
    }

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

    for (const sheet of ACTION_SHEETS) {
      const texture = this.textures.get(sheet.key);
      texture.setFilter(Textures.FilterMode.NEAREST);

      for (const [index, cut] of sheet.frames.entries()) {
        const frame = texture.add(index, 0, cut.x, cut.y, cut.width, cut.height);

        if (!frame) {
          continue;
        }

        frame.customPivot = true;
        frame.pivotX = cut.feetX / cut.width;
        frame.pivotY = cut.feetY / cut.height;
      }
    }

    this.anims.create({
      frameRate: 32,
      frames: this.anims.generateFrameNumbers("explosion", { end: EXPLO_FRAMES - 1, start: 0 }),
      key: "explode",
      repeat: 0,
    });

    this.scene.start("Game");
  }

  private makeUtilTextures() {
    const g = this.add.graphics();

    g.fillStyle(0x00_00_00, 0.32).fillEllipse(32, 16, 56, 26);
    g.generateTexture("shadow", 64, 32);
    g.clear();

    for (let inset = 0; inset < 4; inset += 1) {
      g.fillStyle(0x10_1b_1b, 0.07).fillRoundedRect(
        2 + inset,
        3 + inset,
        68 - inset * 2,
        58 - inset * 2,
        7,
      );
    }

    g.generateTexture("prop-shadow", 72, 64);
    g.clear();

    for (let i = 6; i >= 1; i -= 1) {
      g.fillStyle(0xff_ff_ff, 0.18).fillCircle(16, 16, (i / 6) * 14);
    }

    g.generateTexture("spark", 32, 32);
    g.clear();

    g.fillStyle(0xff_ff_ff).fillRect(0, 0, 7, 3);
    g.generateTexture("chip", 7, 3);
    g.clear();

    g.fillStyle(0xff_a2_4b, 0.13).fillRoundedRect(3, 3, 58, 58, 5);
    g.lineStyle(1.5, 0xff_c2_7a, 0.46).strokeRoundedRect(3, 3, 58, 58, 5);
    g.generateTexture("blast-cell", 64, 64);
    g.clear();

    for (let i = 16; i >= 1; i -= 1) {
      g.fillStyle(0xff_ff_ff, 0.05).fillCircle(64, 64, (i / 16) * 62);
    }

    g.generateTexture("glow", 128, 128);
    g.destroy();
  }
}
