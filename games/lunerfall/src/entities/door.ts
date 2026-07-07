import Phaser from "phaser";

import { COLORS } from "../config";
import { ROOM_LABEL, type RoomType } from "../data/rooms";
import type { Rect } from "./player-body";

const DANGER: RoomType[] = ["combat", "elite", "boss"];

// Gate sprites cropped from the Luneblade prop sheet (env:props): a teal glowing
// doorway for safe paths, pink for danger. Registered once as named frames.
function registerGates(scene: Phaser.Scene) {
  const tex = scene.textures.get("env:props");
  if (tex.has("gate-teal")) return;
  tex.add("gate-teal", 0, 165, 23, 48, 51);
  tex.add("gate-pink", 0, 163, 101, 48, 51);
}

// An exit gate. Locked (dim) until the room is cleared, then it lights up and its
// trigger zone sends the player to the next room.
export class Door {
  private root: Phaser.GameObjects.Container;
  private glow: Phaser.GameObjects.Ellipse;
  private gate: Phaser.GameObjects.Image;
  private label: Phaser.GameObjects.Text;
  private color: number;
  active = false;

  constructor(
    private scene: Phaser.Scene,
    readonly x: number,
    readonly y: number,
    readonly type: RoomType,
    readonly index: number,
  ) {
    registerGates(scene);
    const danger = DANGER.includes(type);
    this.color = danger ? COLORS.magenta : COLORS.teal;
    this.root = scene.add.container(x, y).setDepth(15);
    this.glow = scene.add
      .ellipse(0, -24, 30, 50, this.color, 0.16)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.gate = scene.add
      .image(0, 1, "env:props", danger ? "gate-pink" : "gate-teal")
      .setOrigin(0.5, 1);
    this.label = scene.add
      .text(0, -58, ROOM_LABEL[type], {
        fontFamily: "monospace",
        fontSize: "7px",
        color: "#f4f7fb",
      })
      .setOrigin(0.5, 1);
    this.root.add([this.glow, this.gate, this.label]);
    this.setActive(false);
  }

  setActive(v: boolean) {
    this.active = v;
    this.glow.setVisible(v);
    this.label.setAlpha(v ? 1 : 0.3);
    // Locked gates dim + desaturate toward the stone; cleared gates glow full.
    this.gate.setAlpha(v ? 1 : 0.42).setTint(v ? 0xffffff : 0x6f7a8c);
    this.scene.tweens.killTweensOf(this.glow);
    if (v) {
      this.glow.setScale(1);
      this.scene.tweens.add({
        targets: this.glow,
        scaleX: 1.35,
        alpha: 0.34,
        duration: 750,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }
  }

  triggerRect(): Rect {
    return { left: this.x - 12, top: this.y - 42, right: this.x + 12, bottom: this.y };
  }

  destroy() {
    this.scene.tweens.killTweensOf(this.glow);
    this.root.destroy();
  }
}
