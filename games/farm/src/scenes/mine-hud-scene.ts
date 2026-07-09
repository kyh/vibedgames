import Phaser from "phaser";
import {
  attachVirtualGamepad,
  safeAreaInset,
  type Inset,
  type PhaserGamepad,
} from "@vibedgames/gamepad/phaser";
import { store } from "../systems/store";
import { HOTBAR } from "../systems/inventory";
import { itemIcon } from "../data/items";
import { MAX_ENERGY } from "../config";
import { isTouchDevice } from "../systems/touch";
import { MineScene } from "./mine-scene";

const FONT = "ui-monospace, monospace";
const SZ = 38;
const PAD = 3;

// Unzoomed overlay scene for the mine: dark vignette + HP/energy/gold/floor +
// hotbar. Separate scene so it isn't transformed by the mine camera's zoom.
// Also hosts the touch gamepad (stick + USE) so it renders above the vignette;
// MineScene reads it via its `gamepad` field.
export class MineHudScene extends Phaser.Scene {
  private mine!: MineScene;
  private vignette!: Phaser.GameObjects.Image;
  private g!: Phaser.GameObjects.Graphics;
  private text!: Phaser.GameObjects.Text;
  private hint!: Phaser.GameObjects.Text;
  private icons: Phaser.GameObjects.Image[] = [];
  private zones: Phaser.GameObjects.Zone[] = [];
  private zoneSlot = 0;
  private inset: Inset = { top: 0, right: 0, bottom: 0, left: 0 };
  private gamepad?: PhaserGamepad;
  private onResize?: () => void;

  constructor() {
    super("MineHud");
  }

  create(): void {
    const mine = this.scene.get("Mine");
    if (!(mine instanceof MineScene)) throw new Error("MineHud requires the Mine scene");
    this.mine = mine;
    this.icons = [];
    this.zones = [];
    this.zoneSlot = 0;
    this.inset = safeAreaInset();
    this.buildVignette();
    this.g = this.add.graphics().setDepth(10);
    this.text = this.add
      .text(0, 0, "", { fontFamily: FONT, fontSize: "13px", color: "#dfe9ff" })
      .setDepth(11);
    this.hint = this.add
      .text(
        0,
        0,
        isTouchDevice()
          ? "Stand on a ladder + hold USE to climb"
          : "Stand on a ladder + Space/E to climb",
        { fontFamily: FONT, fontSize: "11px", color: "#cdd6e0" },
      )
      .setDepth(11);
    for (let i = 0; i < HOTBAR; i++)
      this.icons.push(this.add.image(0, 0, "obj-stone").setVisible(false).setDepth(12));
    this.gamepad = attachVirtualGamepad(this, {
      visible: "coarse",
      buttons: [
        {
          id: "use",
          label: "USE",
          radius: 36,
          position: ({ width, height, inset }) => ({
            x: width - 62 - inset.right,
            y: height - 140 - inset.bottom,
          }),
        },
      ],
      render: { depth: 40, blendMode: Phaser.BlendModes.NORMAL },
    });
    this.mine.gamepad = this.gamepad;
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.gamepad?.destroy());
    if (this.onResize) this.scale.off("resize", this.onResize);
    this.onResize = () => {
      this.inset = safeAreaInset();
      this.positionVignette();
    };
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

  /** Tap-to-select hotbar zones; rebuilt when the slot size changes. */
  private ensureZones(slot: number): void {
    if (this.zoneSlot === slot) return;
    this.zoneSlot = slot;
    for (const z of this.zones) z.destroy();
    this.zones = [];
    for (let i = 0; i < HOTBAR; i++) {
      const z = this.add.zone(0, 0, slot + PAD, slot + PAD).setInteractive();
      z.on("pointerdown", () => store.inv.select(i));
      this.zones.push(z);
    }
  }

  override update(): void {
    this.gamepad?.update();
    const W = this.scale.width,
      H = this.scale.height;
    const { top: it, left: il, bottom: ib } = this.inset;
    const g = this.g;
    g.clear();
    // top-left panel
    g.fillStyle(0x000000, 0.45);
    g.fillRoundedRect(10 + il, 8 + it, 250, 58, 8);
    this.text.setPosition(16 + il, 12 + it);
    this.text.setText(`⛏ Mine — Floor ${this.mine.depth}    ${store.gold}g`);
    // HP
    const hpFrac = store.hp / store.maxHp();
    g.fillStyle(0x2a1e0e, 1);
    g.fillRoundedRect(16 + il, 34 + it, 150, 12, 4);
    g.fillStyle(hpFrac > 0.5 ? 0xff7b7b : hpFrac > 0.25 ? 0xffcf4d : 0xff5d5d, 1);
    g.fillRoundedRect(16 + il, 34 + it, Math.max(2, 150 * hpFrac), 12, 4);
    g.lineStyle(1, 0xffffff, 0.3);
    g.strokeRoundedRect(16 + il, 34 + it, 150, 12, 4);
    // energy
    const enFrac = store.energy / MAX_ENERGY;
    g.fillStyle(0x2a1e0e, 1);
    g.fillRoundedRect(16 + il, 49 + it, 150, 8, 3);
    g.fillStyle(0x7ec0ff, 1);
    g.fillRoundedRect(16 + il, 49 + it, Math.max(2, 150 * enFrac), 8, 3);
    // hint bottom-left
    g.fillStyle(0x000000, 0.35);
    g.fillRoundedRect(10 + il, H - 27 - ib, this.hint.width + 16, 18, 6);
    this.hint.setPosition(18 + il, H - 24 - ib);

    // hotbar bottom-center — slot size shrinks to fit narrow (portrait) screens
    const slot = Math.min(SZ, Math.floor((W - 12) / HOTBAR) - PAD);
    this.ensureZones(slot);
    const total = HOTBAR * (slot + PAD) - PAD;
    const sx = (W - total) / 2 + slot / 2;
    const y = H - slot / 2 - 30 - ib;
    for (let i = 0; i < HOTBAR; i++) {
      const x = sx + i * (slot + PAD);
      const sel = i === store.inv.selected;
      g.fillStyle(sel ? 0x6a5a2a : 0x1a1a22, 0.85);
      g.fillRoundedRect(x - slot / 2, y - slot / 2, slot, slot, 5);
      g.lineStyle(2, sel ? 0xffe27a : 0x444455, 1);
      g.strokeRoundedRect(x - slot / 2, y - slot / 2, slot, slot, 5);
      this.zones[i]?.setPosition(x, y);
      const slotItem = store.inv.slots[i];
      const ic = this.icons[i];
      if (!ic) continue;
      if (slotItem) {
        const icon = itemIcon(slotItem.item);
        ic.setVisible(true)
          .setTexture(icon.key, icon.frame)
          .setPosition(x, y)
          .setScale(slot < 36 ? 1.5 : 2);
      } else ic.setVisible(false);
    }
  }
}
