import type Phaser from "phaser";
import { BlendModes, Scene, Scenes } from "phaser";
import { attachVirtualGamepad, safeAreaInset } from "@vibedgames/gamepad/phaser";
import type { Inset, PhaserGamepad } from "@vibedgames/gamepad/phaser";
import { store } from "../systems/store";
import { HOTBAR } from "../systems/inventory";
import { itemIcon } from "../data/items";
import { MAX_ENERGY } from "../config";
import { hotbarGrid } from "../render/hotbar-layout";
import { isPick, isTouchDevice } from "../systems/touch";
import { MineScene } from "./mine-scene";

const FONT = "ui-monospace, monospace";
// Same slot geometry as the farm hotbar (scenes/hud-scene): it is the same
// twelve inventory slots, so a tool sits under the same thumb in both places.
const SZ = 42;
const PAD = 4;

// Unzoomed overlay scene for the mine: dark vignette + HP/energy/gold/floor +
// hotbar. Separate scene so it isn't transformed by the mine camera's zoom.
// Also hosts the touch gamepad (stick) so it renders above the vignette;
// MineScene reads it via its `gamepad` field.
export class MineHudScene extends Scene {
  /** Trailer mode: keep the cave vignette, hide every UI element. Set once by
   *  the trailer director (deliberately NOT reset in create); dead otherwise. */
  trailerHideUi = false;
  private mine!: MineScene;
  private vignette!: Phaser.GameObjects.Image;
  private g!: Phaser.GameObjects.Graphics;
  private text!: Phaser.GameObjects.Text;
  private hint!: Phaser.GameObjects.Text;
  private icons: Phaser.GameObjects.Image[] = [];
  private zones: Phaser.GameObjects.Zone[] = [];
  private zoneSlot = 0;
  private inset: Inset = { bottom: 0, left: 0, right: 0, top: 0 };
  private gamepad?: PhaserGamepad;
  private onResize?: () => void;

  constructor() {
    super("MineHud");
  }

  create(): void {
    const mine = this.scene.get("Mine");
    if (!(mine instanceof MineScene)) {
      throw new Error("MineHud requires the Mine scene");
    }
    this.mine = mine;
    this.icons = [];
    this.zones = [];
    this.zoneSlot = 0;
    this.inset = safeAreaInset();
    this.buildVignette();
    this.g = this.add.graphics().setDepth(10);
    this.text = this.add
      .text(0, 0, "", { color: "#dfe9ff", fontFamily: FONT, fontSize: "13px" })
      .setDepth(11);
    this.hint = this.add
      .text(0, 0, isTouchDevice() ? "Tap the ladder to climb" : "Space/E to climb", {
        color: "#cdd6e0",
        fontFamily: FONT,
        fontSize: "11px",
      })
      .setDepth(11);
    for (let i = 0; i < HOTBAR; i += 1) {
      this.icons.push(this.add.image(0, 0, "obj-stone").setVisible(false).setDepth(12));
    }
    this.gamepad = attachVirtualGamepad(this, {
      render: { blendMode: BlendModes.NORMAL, depth: 40 },
      visible: "coarse",
    });
    this.mine.gamepad = this.gamepad;
    this.events.once(Scenes.Events.SHUTDOWN, () => this.gamepad?.destroy());
    if (this.onResize) {
      this.scale.off("resize", this.onResize);
    }
    this.onResize = () => {
      this.inset = safeAreaInset();
      this.positionVignette();
    };
    this.scale.on("resize", this.onResize);
    this.events.once(Scenes.Events.SHUTDOWN, () => {
      if (this.onResize) {
        this.scale.off("resize", this.onResize);
      }
    });
  }

  private buildVignette(): void {
    const key = "mine-vignette";
    if (!this.textures.exists(key)) {
      const h = 480;
      const w = 640;
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
    const W = this.scale.width;
    const H = this.scale.height;
    this.vignette.setPosition(W / 2, H / 2).setDisplaySize(W + 120, H + 120);
  }

  /** Tap-to-select hotbar zones; rebuilt when the slot size changes. */
  private ensureZones(slot: number): void {
    if (this.zoneSlot === slot) {
      return;
    }
    this.zoneSlot = slot;
    for (const z of this.zones) {
      z.destroy();
    }
    this.zones = [];
    for (let i = 0; i < HOTBAR; i += 1) {
      const z = this.add.zone(0, 0, slot + PAD, slot + PAD).setInteractive();
      // Commit on release: the hotbar band is where a thumb starts a movement
      // drag, and the floating stick claims that touch on the way down.
      z.on("pointerup", (p: Phaser.Input.Pointer) => {
        if (isPick(p)) {
          store.inv.select(i);
        }
      });
      this.zones.push(z);
    }
  }

  override update(): void {
    if (this.trailerHideUi) {
      this.g.clear();
      this.text.setVisible(false);
      this.hint.setVisible(false);
      for (const ic of this.icons) {
        ic.setVisible(false);
      }
      return;
    }
    this.gamepad?.update();
    const W = this.scale.width;
    const H = this.scale.height;
    const { top: it, left: il, bottom: ib } = this.inset;
    const { g } = this;
    g.clear();
    // top-left panel
    g.fillStyle(0x00_00_00, 0.45);
    g.fillRoundedRect(10 + il, 8 + it, 250, 58, 8);
    this.text.setPosition(16 + il, 12 + it);
    this.text.setText(`⛏ Mine — Floor ${this.mine.depth}    ${store.gold}g`);
    // HP
    const hpFrac = store.hp / store.maxHp();
    g.fillStyle(0x2a_1e_0e, 1);
    g.fillRoundedRect(16 + il, 34 + it, 150, 12, 4);
    let hpColor = 0xff_5d_5d;
    if (hpFrac > 0.5) {
      hpColor = 0xff_7b_7b;
    } else if (hpFrac > 0.25) {
      hpColor = 0xff_cf_4d;
    }
    g.fillStyle(hpColor, 1);
    g.fillRoundedRect(16 + il, 34 + it, Math.max(2, 150 * hpFrac), 12, 4);
    g.lineStyle(1, 0xff_ff_ff, 0.3);
    g.strokeRoundedRect(16 + il, 34 + it, 150, 12, 4);
    // energy
    const enFrac = store.energy / MAX_ENERGY;
    g.fillStyle(0x2a_1e_0e, 1);
    g.fillRoundedRect(16 + il, 49 + it, 150, 8, 3);
    g.fillStyle(0x7e_c0_ff, 1);
    g.fillRoundedRect(16 + il, 49 + it, Math.max(2, 150 * enFrac), 8, 3);
    // hint bottom-left — contextual: only while the player is on a ladder tile
    const onLadder = this.mine.onLadder();
    this.hint.setVisible(onLadder);
    if (onLadder) {
      g.fillStyle(0x00_00_00, 0.35);
      g.fillRoundedRect(10 + il, H - 27 - ib, this.hint.width + 16, 18, 6);
      this.hint.setPosition(18 + il, H - 24 - ib);
    }

    // hotbar bottom-center — wraps into rows on narrow (portrait) screens
    const { slot, perRow, rows } = hotbarGrid(W - 12, SZ, PAD);
    this.ensureZones(slot);
    const pitch = slot + PAD;
    const total = perRow * pitch - PAD;
    const sx = (W - total) / 2 + slot / 2;
    const bottomY = H - slot / 2 - 30 - ib;
    for (let i = 0; i < HOTBAR; i += 1) {
      const x = sx + (i % perRow) * pitch;
      const y = bottomY - (rows - 1 - Math.floor(i / perRow)) * pitch;
      const sel = i === store.inv.selected;
      g.fillStyle(sel ? 0x6a_5a_2a : 0x1a_1a_22, 0.85);
      g.fillRoundedRect(x - slot / 2, y - slot / 2, slot, slot, 5);
      g.lineStyle(2, sel ? 0xff_e2_7a : 0x44_44_55, 1);
      g.strokeRoundedRect(x - slot / 2, y - slot / 2, slot, slot, 5);
      this.zones[i]?.setPosition(x, y);
      const slotItem = store.inv.slots[i];
      const ic = this.icons[i];
      if (!ic) {
        continue;
      }
      if (slotItem) {
        const icon = itemIcon(slotItem.item);
        ic.setVisible(true)
          .setTexture(icon.key, icon.frame)
          .setPosition(x, y)
          .setScale(slot < 36 ? 1.5 : 2);
      } else {
        ic.setVisible(false);
      }
    }
  }
}
