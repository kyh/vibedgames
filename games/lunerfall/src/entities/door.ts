import Phaser from "phaser";

import { COLORS } from "../config";
import { ROOM_LABEL, type RoomType } from "../data/rooms";
import type { Rect } from "./player-body";

const DANGER: RoomType[] = ["combat", "elite", "boss"];

// A neon torii gate exit. Locked (dim) until the room is cleared, then it lights
// up and its trigger zone sends the player to the next room.
export class Door {
  private root: Phaser.GameObjects.Container;
  private glow: Phaser.GameObjects.Ellipse;
  private parts: Phaser.GameObjects.Rectangle[] = [];
  private label: Phaser.GameObjects.Text;
  active = false;

  constructor(
    private scene: Phaser.Scene,
    readonly x: number,
    readonly y: number,
    readonly type: RoomType,
    readonly index: number,
  ) {
    const color = DANGER.includes(type) ? COLORS.magenta : COLORS.teal;
    this.root = scene.add.container(x, y).setDepth(15);
    this.glow = scene.add.ellipse(0, -13, 30, 34, color, 0.18);
    const beam = (lx: number, ly: number, w: number, h: number) => {
      const r = scene.add.rectangle(lx, ly, w, h, color).setOrigin(0);
      this.parts.push(r);
      return r;
    };
    beam(-10, -26, 3, 26); // left pillar
    beam(7, -26, 3, 26); // right pillar
    beam(-13, -29, 26, 3); // upper beam
    beam(-11, -23, 22, 2); // lower beam
    this.label = scene.add
      .text(0, -34, ROOM_LABEL[type], { fontFamily: "monospace", fontSize: "7px", color: "#f4f7fb" })
      .setOrigin(0.5, 1);
    this.root.add([this.glow, ...this.parts, this.label]);
    this.setActive(false);
  }

  setActive(v: boolean) {
    this.active = v;
    this.glow.setVisible(v);
    this.label.setAlpha(v ? 1 : 0.25);
    this.parts.forEach((p) => p.setAlpha(v ? 1 : 0.28));
    this.scene.tweens.killTweensOf(this.glow);
    if (v) {
      this.glow.setScale(1);
      this.scene.tweens.add({ targets: this.glow, scale: 1.25, alpha: 0.3, duration: 700, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    }
  }

  triggerRect(): Rect {
    return { left: this.x - 11, top: this.y - 28, right: this.x + 11, bottom: this.y };
  }

  destroy() {
    this.scene.tweens.killTweensOf(this.glow);
    this.root.destroy();
  }
}
