import type { GameObjects, Input } from "phaser";
import { Scene } from "phaser";

// World pixels per second.
const SPEED = 240;
const SIZE = 48;

type Direction = "up" | "down" | "left" | "right";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** A square you drive with the arrow keys or WASD. Replace it with your game. */
export class GameScene extends Scene {
  private player?: GameObjects.Rectangle;
  private keys?: Record<Direction, Input.Keyboard.Key[]>;

  constructor() {
    super("game");
  }

  create(): void {
    const { width, height } = this.scale;
    const font = { color: "#ffffff", fontFamily: "system-ui, sans-serif" };
    this.add.text(width / 2, 48, "__VG_SLUG__", { ...font, fontSize: "32px" }).setOrigin(0.5);
    this.add
      .text(width / 2, height - 40, "Arrows / WASD to move · edit src/scenes/game-scene.ts", {
        ...font,
        color: "#9aa0c0",
        fontSize: "16px",
      })
      .setOrigin(0.5);

    this.player = this.add.rectangle(width / 2, height / 2, SIZE, SIZE, 0x5b_e3_ff);

    const { keyboard } = this.input;
    if (keyboard) {
      this.keys = {
        down: [keyboard.addKey("DOWN"), keyboard.addKey("S")],
        left: [keyboard.addKey("LEFT"), keyboard.addKey("A")],
        right: [keyboard.addKey("RIGHT"), keyboard.addKey("D")],
        up: [keyboard.addKey("UP"), keyboard.addKey("W")],
      };
    }
  }

  override update(_time: number, delta: number): void {
    const { keys, player } = this;
    if (!keys || !player) {
      return;
    }
    const held = (direction: Direction): number =>
      keys[direction].some((key) => key.isDown) ? 1 : 0;
    const dx = held("right") - held("left");
    const dy = held("down") - held("up");
    if (dx === 0 && dy === 0) {
      return;
    }
    // Normalised so a diagonal is no faster than a straight line.
    const step = (SPEED * delta) / 1000 / Math.hypot(dx, dy);
    const half = SIZE / 2;
    player.x = clamp(player.x + dx * step, half, this.scale.width - half);
    player.y = clamp(player.y + dy * step, half, this.scale.height - half);
  }
}
