import Phaser from "phaser";
import { store } from "../systems/store";
import { HOTBAR } from "../systems/inventory";
import { itemIcon } from "../data/items";
import { MAX_ENERGY } from "../config";
import type { MineScene } from "./MineScene";

const FONT = "ui-monospace, monospace";
const SZ = 38;
const PAD = 3;

// Unzoomed overlay scene for the mine: dark vignette + HP/energy/gold/floor +
// hotbar. Separate scene so it isn't transformed by the mine camera's zoom.
export class MineHudScene extends Phaser.Scene {
  private mine!: MineScene;
  private vignette!: Phaser.GameObjects.Image;
  private g!: Phaser.GameObjects.Graphics;
  private text!: Phaser.GameObjects.Text;
  private icons: Phaser.GameObjects.Image[] = [];
  private onResize?: () => void;

  constructor() {
    super("MineHud");
  }

  create(): void {
    this.mine = this.scene.get("Mine") as MineScene;
    this.icons = [];
    this.buildVignette();
    this.g = this.add.graphics().setDepth(10);
    this.text = this.add
      .text(16, 12, "", { fontFamily: FONT, fontSize: "13px", color: "#dfe9ff" })
      .setDepth(11);
    for (let i = 0; i < HOTBAR; i++)
      this.icons.push(this.add.image(0, 0, "obj-stone").setVisible(false).setDepth(12));
    if (this.onResize) this.scale.off("resize", this.onResize);
    this.onResize = () => this.positionVignette();
    this.scale.on("resize", this.onResize);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (this.onResize) this.scale.off("resize", this.onResize);
    });
  }

  private buildVignette(): void {
    const key = "mine-vignette";
    if (!this.textures.exists(key)) {
      const w = 640,
        h = 480;
      const tex = this.textures.createCanvas(key, w, h);
      if (tex) {
        const ctx = tex.getContext();
        const grd = ctx.createRadialGradient(w / 2, h / 2, 70, w / 2, h / 2, 330);
        grd.addColorStop(0, "rgba(0,0,0,0)");
        grd.addColorStop(0.55, "rgba(0,0,0,0.25)");
        grd.addColorStop(1, "rgba(3,4,8,0.9)");
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, w, h);
        tex.refresh();
      }
    }
    this.vignette = this.add.image(0, 0, key).setDepth(5);
    this.positionVignette();
  }

  private positionVignette(): void {
    const W = this.scale.width,
      H = this.scale.height;
    this.vignette.setPosition(W / 2, H / 2).setDisplaySize(W + 120, H + 120);
  }

  override update(): void {
    const W = this.scale.width,
      H = this.scale.height;
    const g = this.g;
    g.clear();
    // top-left panel
    g.fillStyle(0x000000, 0.45);
    g.fillRoundedRect(10, 8, 250, 58, 8);
    this.text.setText(`⛏ Mine — Floor ${this.mine.depth}    ${store.gold}g`);
    // HP
    const hpFrac = store.hp / store.maxHp();
    g.fillStyle(0x2a1e0e, 1);
    g.fillRoundedRect(16, 34, 150, 12, 4);
    g.fillStyle(hpFrac > 0.5 ? 0xff7b7b : hpFrac > 0.25 ? 0xffcf4d : 0xff5d5d, 1);
    g.fillRoundedRect(16, 34, Math.max(2, 150 * hpFrac), 12, 4);
    g.lineStyle(1, 0xffffff, 0.3);
    g.strokeRoundedRect(16, 34, 150, 12, 4);
    // energy
    const enFrac = store.energy / MAX_ENERGY;
    g.fillStyle(0x2a1e0e, 1);
    g.fillRoundedRect(16, 49, 150, 8, 3);
    g.fillStyle(0x7ec0ff, 1);
    g.fillRoundedRect(16, 49, Math.max(2, 150 * enFrac), 8, 3);
    // hint bottom-left
    g.fillStyle(0x000000, 0.35);
    g.fillRoundedRect(10, H - 26, 300, 18, 6);

    // hotbar bottom-center
    const total = HOTBAR * (SZ + PAD) - PAD;
    const sx = (W - total) / 2 + SZ / 2;
    const y = H - SZ / 2 - 30;
    for (let i = 0; i < HOTBAR; i++) {
      const x = sx + i * (SZ + PAD);
      const sel = i === store.inv.selected;
      g.fillStyle(sel ? 0x6a5a2a : 0x1a1a22, 0.85);
      g.fillRoundedRect(x - SZ / 2, y - SZ / 2, SZ, SZ, 5);
      g.lineStyle(2, sel ? 0xffe27a : 0x444455, 1);
      g.strokeRoundedRect(x - SZ / 2, y - SZ / 2, SZ, SZ, 5);
      const slot = store.inv.slots[i];
      const ic = this.icons[i];
      if (!ic) continue;
      if (slot) {
        const icon = itemIcon(slot.item);
        ic.setVisible(true).setTexture(icon.key, icon.frame).setPosition(x, y).setScale(2);
      } else ic.setVisible(false);
    }
  }
}
