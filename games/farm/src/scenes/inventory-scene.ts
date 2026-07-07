import Phaser from "phaser";
import { store } from "../systems/store";
import { HOTBAR, TOTAL } from "../systems/inventory";
import { itemIcon, itemName, sellValue, isSellable } from "../data/items";
import { SKILL_IDS, SKILL_NAMES, SKILL_ICON, xpToNext } from "../systems/skills";
import { Sound } from "../render/audio";
import { GameScene } from "./game-scene";

const FONT = "ui-monospace, monospace";
const SZ = 44;
const GAP = 5;

export class InventoryScene extends Phaser.Scene {
  private picked = -1;
  private cells: { x: number; y: number; idx: number }[] = [];
  private g!: Phaser.GameObjects.Graphics;
  private icons: Phaser.GameObjects.Image[] = [];
  private qtys: Phaser.GameObjects.Text[] = [];
  private info!: Phaser.GameObjects.Text;
  private skillG!: Phaser.GameObjects.Graphics;
  private onResize?: () => void;

  constructor() {
    super("Inventory");
  }

  create(): void {
    this.picked = -1;
    this.cells = [];
    this.icons = [];
    this.qtys = [];
    this.skillLabels = [];
    this.add
      .rectangle(0, 0, this.scale.width * 3, this.scale.height * 3, 0x05070d, 0.55)
      .setOrigin(0)
      .setInteractive();
    this.g = this.add.graphics();
    this.info = this.add
      .text(0, 0, "", { fontFamily: FONT, fontSize: "14px", color: "#fff6d5" })
      .setOrigin(0.5, 0);
    this.skillG = this.add.graphics();

    for (let i = 0; i < TOTAL; i++) {
      this.icons.push(this.add.image(0, 0, "obj-stone").setVisible(false));
      this.qtys.push(
        this.add
          .text(0, 0, "", {
            fontFamily: FONT,
            fontSize: "12px",
            fontStyle: "bold",
            color: "#fff",
            stroke: "#000",
            strokeThickness: 3,
          })
          .setOrigin(1, 1),
      );
    }

    this.layout();
    if (this.onResize) this.scale.off("resize", this.onResize);
    this.onResize = () => this.layout();
    this.scale.on("resize", this.onResize);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (this.onResize) this.scale.off("resize", this.onResize);
    });

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => this.onClick(p));
    this.input.keyboard?.on("keydown-ESC", () => this.close());
    this.input.keyboard?.on("keydown-I", () => this.close());
  }

  private close(): void {
    const game = this.scene.get("Game");
    if (!(game instanceof GameScene)) throw new Error("Inventory requires the Game scene");
    game.closeUi();
    this.scene.stop();
  }

  private layout(): void {
    this.cells = [];
    const cols = HOTBAR;
    const gridW = cols * (SZ + GAP) - GAP;
    const panelW = gridW + 48;
    const panelH = 360;
    const px = (this.scale.width - panelW) / 2 - 110;
    const py = (this.scale.height - panelH) / 2;
    const startX = px + 24 + SZ / 2;
    // hotbar row
    for (let i = 0; i < HOTBAR; i++)
      this.cells.push({ x: startX + i * (SZ + GAP), y: py + 66, idx: i });
    // backpack rows (cols of 12, 2 rows of 12 = 24)
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < HOTBAR; c++) {
        const idx = HOTBAR + r * HOTBAR + c;
        if (idx < TOTAL)
          this.cells.push({ x: startX + c * (SZ + GAP), y: py + 132 + r * (SZ + GAP), idx });
      }
    this.info.setPosition(px + panelW / 2, py + panelH - 34);
    this.panel = { px, py, panelW, panelH };
    this.skillPanel = { x: px + panelW + 12, y: py, w: 210, h: panelH };
    this.draw();
  }

  private panel = { px: 0, py: 0, panelW: 0, panelH: 0 };
  private skillPanel = { x: 0, y: 0, w: 0, h: 0 };

  private onClick(p: Phaser.Input.Pointer): void {
    const hit = this.cells.find(
      (c) => Math.abs(p.x - c.x) <= SZ / 2 && Math.abs(p.y - c.y) <= SZ / 2,
    );
    if (!hit) return;
    Sound.click();
    if (this.picked < 0) {
      if (store.inv.slotAt(hit.idx)) this.picked = hit.idx;
    } else {
      store.inv.swap(this.picked, hit.idx);
      this.picked = -1;
    }
    this.draw();
  }

  override update(): void {
    // live-refresh in case qty changed elsewhere
    this.draw();
  }

  private draw(): void {
    const g = this.g;
    g.clear();
    const { px, py, panelW, panelH } = this.panel;
    // main panel
    g.fillStyle(0x000000, 0.3);
    g.fillRoundedRect(px + 4, py + 6, panelW, panelH, 14);
    g.fillStyle(0xf3e2bf, 1);
    g.fillRoundedRect(px, py, panelW, panelH, 14);
    g.lineStyle(4, 0x9a6a35, 1);
    g.strokeRoundedRect(px, py, panelW, panelH, 14);
    g.fillStyle(0x9a6a35, 1);
    g.fillRoundedRect(px, py, panelW, 40, { tl: 14, tr: 14, bl: 0, br: 0 });

    for (const c of this.cells) {
      const sel = c.idx === this.picked;
      const isHot = c.idx < HOTBAR;
      g.fillStyle(sel ? 0xffe9a8 : isHot ? 0xe8d3a6 : 0xdcc596, 1);
      g.fillRoundedRect(c.x - SZ / 2, c.y - SZ / 2, SZ, SZ, 6);
      g.lineStyle(2, sel ? 0xff9d3a : 0x8a6a35, 1);
      g.strokeRoundedRect(c.x - SZ / 2, c.y - SZ / 2, SZ, SZ, 6);
      const slot = store.inv.slotAt(c.idx);
      const icon = this.icons[c.idx];
      const qtyt = this.qtys[c.idx];
      if (!icon || !qtyt) continue;
      if (slot) {
        const ic = itemIcon(slot.item);
        icon.setVisible(true).setTexture(ic.key, ic.frame).setPosition(c.x, c.y).setScale(2);
        qtyt
          .setText(slot.qty > 1 ? `${slot.qty}` : "")
          .setPosition(c.x + SZ / 2 - 4, c.y + SZ / 2 - 3);
      } else {
        icon.setVisible(false);
        qtyt.setText("");
      }
    }
    // info line: hovered/picked item
    const focus = this.picked >= 0 ? store.inv.slotAt(this.picked) : null;
    this.info.setText(
      focus
        ? `${itemName(focus.item)}${isSellable(focus.item) ? `  ·  ${sellValue(focus.item)}g each` : ""}`
        : "Click an item, then a slot to move it.",
    );

    this.drawSkills();
  }

  private drawSkills(): void {
    const g = this.skillG;
    g.clear();
    const { x, y, w, h } = this.skillPanel;
    g.fillStyle(0x000000, 0.3);
    g.fillRoundedRect(x + 4, y + 6, w, h, 14);
    g.fillStyle(0xf3e2bf, 1);
    g.fillRoundedRect(x, y, w, h, 14);
    g.lineStyle(4, 0x9a6a35, 1);
    g.strokeRoundedRect(x, y, w, h, 14);
    g.fillStyle(0x9a6a35, 1);
    g.fillRoundedRect(x, y, w, 40, { tl: 14, tr: 14, bl: 0, br: 0 });
    let ry = y + 56;
    for (const id of SKILL_IDS) {
      const s = store.skills.get(id);
      const need = xpToNext(s.level);
      const frac = need === Infinity ? 1 : Phaser.Math.Clamp(s.xp / need, 0, 1);
      g.fillStyle(0x2a1e0e, 1);
      g.fillRoundedRect(x + 16, ry + 16, w - 32, 8, 3);
      g.fillStyle(0x5fae3a, 1);
      g.fillRoundedRect(x + 16, ry + 16, (w - 32) * frac, 8, 3);
      ry += 44;
    }
    this.renderSkillLabels(x, y);
  }

  private skillLabels: Phaser.GameObjects.Text[] = [];
  private renderSkillLabels(x: number, y: number): void {
    if (this.skillLabels.length === 0) {
      for (let i = 0; i < SKILL_IDS.length; i++) {
        this.skillLabels.push(
          this.add.text(0, 0, "", { fontFamily: FONT, fontSize: "12px", color: "#3a2a14" }),
        );
      }
      this.add.text(x + 16, y + 12, "Skills", {
        fontFamily: FONT,
        fontSize: "16px",
        fontStyle: "bold",
        color: "#fff6d5",
      });
      this.add.text(x + 16, y + 32, `${store.gold}g`, {
        fontFamily: FONT,
        fontSize: "13px",
        color: "#7a5a1a",
      });
    }
    let ry = y + 56;
    SKILL_IDS.forEach((id, i) => {
      const lbl = this.skillLabels[i];
      if (!lbl) return;
      const s = store.skills.get(id);
      lbl.setText(`${SKILL_ICON[id]} ${SKILL_NAMES[id]}  Lv.${s.level}`).setPosition(x + 16, ry);
      ry += 44;
    });
  }
}
