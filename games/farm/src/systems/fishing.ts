import Phaser from "phaser";
import { TILE, DEPTH } from "../config";
import { store } from "./store";
import { rollFish, type FishDef } from "../data/fish";
import { floatText, burst } from "../render/fx";
import { Sound } from "../render/audio";
import type { GameScene } from "../scenes/game-scene";

type State = "idle" | "casting" | "waiting" | "bite" | "reeling" | "done";

const BAR_H = 150;

// Self-contained fishing minigame. Owns its bobber (world) and reel bar (screen).
export class Fishing {
  private state: State = "idle";
  private scene: GameScene;
  private bobber: Phaser.GameObjects.Arc | null = null;
  private bang: Phaser.GameObjects.Text | null = null;
  private g: Phaser.GameObjects.Graphics | null = null;
  private fishIcon: Phaser.GameObjects.Image | null = null;
  private hint: Phaser.GameObjects.Text | null = null;

  private timer = 0;
  private bobberPos = { x: 0, y: 0 };
  private target: FishDef | null = null;

  // reel state
  private zonePos = 0;
  private zoneVel = 0;
  private zoneH = 36;
  private fishPos = 0;
  private fishTarget = 0;
  private fishTimer = 0;
  private progress = 0;

  constructor(scene: GameScene) {
    this.scene = scene;
  }

  get active(): boolean {
    return this.state !== "idle";
  }

  startCast(tx: number, ty: number): void {
    if (this.state !== "idle") return;
    this.scene.faceTowards(tx, ty);
    this.state = "casting";
    this.scene.acting = true;
    this.scene.playerAnim("p-casting");
    this.bobberPos = { x: tx * TILE + 8, y: ty * TILE + 8 };
    Sound.water();
    this.scene.time.delayedCall(750, () => {
      if (this.state !== "casting") return;
      this.scene.acting = false;
      this.beginWaiting();
    });
  }

  private beginWaiting(): void {
    this.state = "waiting";
    this.scene.playerAnim("p-idle");
    const b = this.scene.add
      .circle(this.bobberPos.x, this.bobberPos.y, 2.2, 0xff5d5d)
      .setDepth(DEPTH.crop + 5);
    b.setStrokeStyle(1, 0xffffff, 0.8);
    this.bobber = b;
    this.timer = Phaser.Math.FloatBetween(1.6, 4.8);
  }

  onActionPress(): void {
    if (this.state === "done" || this.state === "casting") return;
    if (this.state === "waiting") {
      this.cancel("Reeled in early.");
    } else if (this.state === "bite") {
      this.hook();
    }
  }

  private hook(): void {
    this.state = "reeling";
    Sound.click();
    this.bang?.destroy();
    this.bang = null;
    this.target = rollFish(this.scene.season(), store.skills.level("fishing"), Math.random);
    this.zoneH = 34 + store.skills.reelEase() * 70;
    this.zonePos = (BAR_H - this.zoneH) / 2;
    this.zoneVel = 0;
    this.fishPos = BAR_H / 2;
    this.fishTarget = BAR_H / 2;
    this.fishTimer = 0;
    this.progress = 0.35;
    this.scene.playerAnim("p-reeling");
  }

  update(dt: number): void {
    if (this.state === "idle") return;
    if (this.state === "waiting") {
      this.timer -= dt;
      if (this.bobber) this.bobber.y = this.bobberPos.y + Math.sin(this.scene.time.now / 250) * 1.2;
      if (this.timer <= 0) this.startBite();
    } else if (this.state === "bite") {
      this.timer -= dt;
      if (this.bang) this.bang.y = this.bobberPos.y - 14 + Math.sin(this.scene.time.now / 80) * 2;
      if (this.timer <= 0) this.cancel("It got away…");
    } else if (this.state === "reeling") {
      this.tickReel(dt);
    }
  }

  private startBite(): void {
    this.state = "bite";
    this.timer = 1.0;
    Sound.thud();
    if (this.bobber) this.bobber.y += 2;
    this.bang = this.scene.add
      .text(this.bobberPos.x, this.bobberPos.y - 14, "!", {
        fontFamily: "ui-monospace, monospace",
        fontSize: "16px",
        fontStyle: "900",
        color: "#ffe27a",
        stroke: "#2a1e0e",
        strokeThickness: 4,
      })
      .setOrigin(0.5, 1)
      .setDepth(DEPTH.particles + 20);
  }

  private tickReel(dt: number): void {
    const held = this.scene.actionHeld();
    // zone physics: gravity down, thrust up while held
    this.zoneVel += (held ? -560 : 320) * dt;
    this.zoneVel = Phaser.Math.Clamp(this.zoneVel, -180, 180);
    this.zonePos += this.zoneVel * dt;
    if (this.zonePos < 0) {
      this.zonePos = 0;
      this.zoneVel = 0;
    }
    if (this.zonePos > BAR_H - this.zoneH) {
      this.zonePos = BAR_H - this.zoneH;
      this.zoneVel = 0;
    }
    // fish wanders, more erratic with difficulty
    const diff = this.target?.difficulty ?? 1;
    this.fishTimer -= dt;
    if (this.fishTimer <= 0) {
      this.fishTimer = Phaser.Math.FloatBetween(0.4, 1.2) / (0.6 + diff * 0.2);
      this.fishTarget = Phaser.Math.Between(6, BAR_H - 6);
    }
    this.fishPos = Phaser.Math.Linear(
      this.fishPos,
      this.fishTarget,
      Math.min(1, dt * (1.5 + diff * 0.6)),
    );

    const inZone = this.fishPos >= this.zonePos && this.fishPos <= this.zonePos + this.zoneH;
    this.progress += inZone ? 0.42 * dt : -(0.18 + diff * 0.05) * dt;
    this.progress = Phaser.Math.Clamp(this.progress, 0, 1);
    this.drawReel(inZone);
    if (this.progress >= 1) this.land();
    else if (this.progress <= 0) this.cancel("It slipped away…");
  }

  private drawReel(inZone: boolean): void {
    const W = this.scene.scale.width,
      H = this.scene.scale.height;
    const bx = W / 2 + 200,
      by = H / 2 - BAR_H / 2;
    if (!this.g)
      this.g = this.scene.add
        .graphics()
        .setScrollFactor(0)
        .setDepth(DEPTH.night + 10);
    const g = this.g;
    g.clear();
    // frame
    g.fillStyle(0x1a1410, 0.85);
    g.fillRoundedRect(bx - 16, by - 12, 56, BAR_H + 24, 8);
    // track
    g.fillStyle(0x0e1830, 1);
    g.fillRoundedRect(bx - 2, by, 24, BAR_H, 6);
    // catch zone
    g.fillStyle(inZone ? 0x8ef07a : 0x4f9d3f, 0.9);
    g.fillRoundedRect(bx - 1, by + this.zonePos, 22, this.zoneH, 5);
    // progress bar (left)
    g.fillStyle(0x2a1e0e, 1);
    g.fillRoundedRect(bx - 14, by, 8, BAR_H, 3);
    g.fillStyle(0xffd34d, 1);
    g.fillRoundedRect(bx - 14, by + BAR_H * (1 - this.progress), 8, BAR_H * this.progress, 3);
    // fish marker
    if (!this.fishIcon)
      this.fishIcon = this.scene.add
        .image(0, 0, "obj-fish")
        .setScrollFactor(0)
        .setDepth(DEPTH.night + 11)
        .setScale(1.6);
    this.fishIcon.setPosition(bx + 10, by + this.fishPos);
    if (!this.hint)
      this.hint = this.scene.add
        .text(bx + 12, by + BAR_H + 16, "HOLD", {
          fontFamily: "ui-monospace, monospace",
          fontSize: "10px",
          color: "#ffe27a",
        })
        .setScrollFactor(0)
        .setDepth(DEPTH.night + 11)
        .setOrigin(0.5, 0);
  }

  private land(): void {
    const fish = this.target;
    this.cleanup();
    this.state = "done";
    this.scene.acting = false;
    this.scene.playerAnim("p-caught");
    if (fish) {
      store.inv.add({ kind: "fish", fish: fish.id }, 1);
      const xp = 10 + fish.difficulty * 4;
      this.scene.awardXP("fishing", xp);
      floatText(
        this.scene,
        this.scene.player.x,
        this.scene.player.y - 26,
        `${fish.name}!`,
        "#9fe0ff",
      );
      burst(this.scene, this.scene.player.x, this.scene.player.y - 16, {
        colors: [0x9fe0ff, 0xffffff, 0xffe27a],
        count: 14,
        up: true,
        speed: 60,
      });
      Sound.harvest();
    }
    this.scene.requestSave();
    this.scene.time.delayedCall(650, () => {
      this.state = "idle";
      this.scene.playerAnim("p-idle");
    });
  }

  private cancel(msg: string): void {
    this.cleanup();
    this.state = "idle";
    this.scene.acting = false;
    this.scene.playerAnim("p-idle");
    this.scene.toast(msg, "#9fd8ff");
  }

  private cleanup(): void {
    this.bobber?.destroy();
    this.bobber = null;
    this.bang?.destroy();
    this.bang = null;
    this.g?.destroy();
    this.g = null;
    this.fishIcon?.destroy();
    this.fishIcon = null;
    this.hint?.destroy();
    this.hint = null;
  }
}
