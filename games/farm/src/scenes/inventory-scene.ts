import type Phaser from "phaser";
import { Math as PhaserMath, Scene, Scenes } from "phaser";
import { store } from "../systems/store";
import { HOTBAR, TOTAL } from "../systems/inventory";
import { itemIcon, itemName, sellValue, isSellable } from "../data/items";
import { SKILL_IDS, SKILL_NAMES, SKILL_ICON, xpToNext } from "../systems/skills";
import { Sound } from "../render/audio";
import { GameScene } from "./game-scene";
import { seasonOfDay } from "../data/calendar";
import { JournalView } from "../render/journal-view";
import { skillPerk } from "../render/skill-readout";
import { slotIconScale } from "../render/hotbar-layout";

const FONT = "ui-monospace, monospace";
const SZ = 44;
const GAP = 5;

export class InventoryScene extends Scene {
  private picked = -1;
  private cells: { x: number; y: number; idx: number }[] = [];
  private g!: Phaser.GameObjects.Graphics;
  private icons: Phaser.GameObjects.Image[] = [];
  private qtys: Phaser.GameObjects.Text[] = [];
  private info!: Phaser.GameObjects.Text;
  private skillG!: Phaser.GameObjects.Graphics;
  private titleText!: Phaser.GameObjects.Text;
  private skillTitle!: Phaser.GameObjects.Text;
  private skillGold!: Phaser.GameObjects.Text;
  private sz = SZ;
  private onResize?: () => void;
  private journal: JournalView | null = null;
  private closing = false;
  private nextJournalRefresh = 0;

  constructor() {
    super("Inventory");
  }

  create(): void {
    this.journal?.destroy(false);
    this.journal = null;
    this.closing = false;
    this.nextJournalRefresh = 0;
    this.cameras.main.visible = true;
    this.input.enabled = true;
    this.picked = -1;
    this.cells = [];
    this.icons = [];
    this.qtys = [];
    this.skillLabels = [];
    this.skillPerks = [];
    this.skillProgress = [];
    this.sz = SZ;
    const backdrop = this.add
      .rectangle(0, 0, this.scale.width * 3, this.scale.height * 3, 0x05_07_0d, 0.55)
      .setOrigin(0)
      .setInteractive();
    // tap outside the panels = close (phones have no ESC key)
    backdrop.on("pointerdown", (p: Phaser.Input.Pointer) => {
      if (this.journal?.page !== "journal" && !this.inPanels(p.x, p.y)) {
        this.close();
      }
    });
    this.g = this.add.graphics();
    this.info = this.add
      .text(0, 0, "", { color: "#3a2a14", fontFamily: FONT, fontSize: "14px" })
      .setOrigin(0.5, 0);
    this.skillG = this.add.graphics();
    this.titleText = this.add.text(0, 0, "🎒 Inventory", {
      color: "#fff6d5",
      fontFamily: FONT,
      fontSize: "16px",
      fontStyle: "bold",
    });
    this.skillTitle = this.add.text(0, 0, "Skills", {
      color: "#fff6d5",
      fontFamily: FONT,
      fontSize: "16px",
      fontStyle: "bold",
    });
    this.skillGold = this.add.text(0, 0, "", {
      color: "#ffe27a",
      fontFamily: FONT,
      fontSize: "13px",
    });

    for (let i = 0; i < TOTAL; i += 1) {
      this.icons.push(this.add.image(0, 0, "obj-stone").setVisible(false));
      this.qtys.push(
        this.add
          .text(0, 0, "", {
            color: "#fff",
            fontFamily: FONT,
            fontSize: "12px",
            fontStyle: "bold",
            stroke: "#000",
            strokeThickness: 3,
          })
          .setOrigin(1, 1),
      );
    }

    const game = this.scene.get("Game");
    if (!(game instanceof GameScene)) {
      throw new Error("Inventory requires the Game scene");
    }
    const journal = new JournalView(
      seasonOfDay(game.day),
      (season) => store.collections.page(season),
      {
        close: () => this.close(),
        page: (page) => {
          this.cameras.main.visible = page === "inventory";
          this.input.enabled = page === "inventory";
        },
      },
    );
    this.journal = journal;
    this.layout();
    if (this.onResize) {
      this.scale.off("resize", this.onResize);
    }
    this.onResize = () => this.layout();
    this.scale.on("resize", this.onResize);
    this.events.once(Scenes.Events.SHUTDOWN, () => {
      if (this.onResize) {
        this.scale.off("resize", this.onResize);
      }
      journal.destroy(false);
      if (this.journal === journal) {
        this.journal = null;
      }
    });

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => this.onClick(p));
    this.input.keyboard?.on("keydown-ESC", () => this.close());
    this.input.keyboard?.on("keydown-I", () => this.close());
  }

  private close(): void {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.journal?.destroy();
    this.journal = null;
    const game = this.scene.get("Game");
    if (!(game instanceof GameScene)) {
      throw new Error("Inventory requires the Game scene");
    }
    game.closeUi();
    this.scene.stop();
  }

  private inPanels(x: number, y: number): boolean {
    const { px, py, panelW, panelH } = this.panel;
    const s = this.skillPanel;
    return (
      (x >= px && x <= px + panelW && y >= py && y <= py + panelH) ||
      (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h)
    );
  }

  // Wide screens: grid of 12 with the skill panel on the right. Narrow
  // (portrait phone): grid reflows to 6 per row, skills stack below.
  private layout(): void {
    this.cells = [];
    const W = this.scale.width;
    const H = this.scale.height;
    // The native page navigation sits above both original panels.
    const header = 72;
    const availableH = H - header;
    const wide = W >= 700;
    const perRow = wide ? HOTBAR : 6;
    this.skillRow = wide ? 44 : 36;
    const hotRows = Math.ceil(HOTBAR / perRow);
    const packRows = Math.ceil((TOTAL - HOTBAR) / perRow);
    let sz = Math.min(SZ, Math.floor((W - 56 + GAP) / perRow) - GAP);
    if (wide) {
      // side-by-side: grid + 32 padding + 12 gap + 200 skills + 16 margins
      sz = Math.min(sz, Math.floor((W - 260 + GAP) / perRow) - GAP);
    }
    if (!wide) {
      // stacked layout must also fit the height (grid + skills + margins)
      const stackedSkillH = 56 + SKILL_IDS.length * this.skillRow + 10;
      const gridBudget = availableH - 20 - 52 - 14 - 44 - 12 - stackedSkillH;
      sz = Math.max(24, Math.min(sz, Math.floor(gridBudget / (hotRows + packRows)) - GAP));
    }
    this.sz = sz;
    const gridW = perRow * (sz + GAP) - GAP;
    const panelW = gridW + 32;
    const hotY0 = 52 + sz / 2;
    const packY0 = hotY0 + hotRows * (sz + GAP) + 14;
    const panelH = packY0 - sz / 2 + packRows * (sz + GAP) - GAP + 44;
    if (wide) {
      // skill rows must fit beside the (possibly short) grid panel
      this.skillRow = Math.max(28, Math.min(44, Math.floor((panelH - 66) / SKILL_IDS.length)));
    }
    const skillW = wide ? 200 : panelW;
    const skillH = wide ? panelH : 56 + SKILL_IDS.length * this.skillRow + 10;
    let px: number;
    let py: number;
    if (wide) {
      const groupW = panelW + 12 + skillW;
      px = (W - groupW) / 2;
      py = header + (availableH - panelH) / 2;
      this.skillPanel = { h: skillH, w: skillW, x: px + panelW + 12, y: py };
    } else {
      px = (W - panelW) / 2;
      py = header + Math.max(0, (availableH - (panelH + 12 + skillH)) / 2);
      this.skillPanel = { h: skillH, w: skillW, x: px, y: py + panelH + 12 };
    }
    const startX = px + 16 + sz / 2;
    for (let i = 0; i < TOTAL; i += 1) {
      const local = i < HOTBAR ? i : i - HOTBAR;
      const y0 = i < HOTBAR ? hotY0 : packY0;
      const r = Math.floor(local / perRow);
      const col = local % perRow;
      this.cells.push({ idx: i, x: startX + col * (sz + GAP), y: py + y0 + r * (sz + GAP) });
    }
    this.info.setPosition(px + panelW / 2, py + panelH - 30);
    this.info.setWordWrapWidth(panelW - 24).setFontSize(panelW < 400 ? 11 : 14);
    this.panel = { panelH, panelW, px, py };
    this.titleText.setPosition(px + 14, py + 10);
    this.journal?.setInventoryBounds(px, py - 64, wide ? panelW + 12 + skillW : panelW);
    this.draw();
  }

  private panel = { panelH: 0, panelW: 0, px: 0, py: 0 };
  private skillPanel = { h: 0, w: 0, x: 0, y: 0 };
  private skillRow = 44;

  private onClick(p: Phaser.Input.Pointer): void {
    if (this.journal?.page === "journal") {
      return;
    }
    const hit = this.cells.find(
      (c) => Math.abs(p.x - c.x) <= this.sz / 2 && Math.abs(p.y - c.y) <= this.sz / 2,
    );
    if (!hit) {
      return;
    }
    Sound.click();
    if (this.picked < 0) {
      if (store.inv.slotAt(hit.idx)) {
        this.picked = hit.idx;
      }
    } else {
      store.inv.swap(this.picked, hit.idx);
      this.picked = -1;
    }
    this.draw();
  }

  override update(): void {
    if (this.journal?.page === "journal") {
      if (this.time.now >= this.nextJournalRefresh) {
        this.nextJournalRefresh = this.time.now + 200;
        this.journal.refresh();
      }
      return;
    }
    // live-refresh in case qty changed elsewhere
    this.draw();
  }

  private draw(): void {
    const { g } = this;
    const { sz } = this;
    g.clear();
    const { px, py, panelW, panelH } = this.panel;
    // main panel
    g.fillStyle(0x00_00_00, 0.3);
    g.fillRoundedRect(px + 4, py + 6, panelW, panelH, 14);
    g.fillStyle(0xf3_e2_bf, 1);
    g.fillRoundedRect(px, py, panelW, panelH, 14);
    g.lineStyle(4, 0x9a_6a_35, 1);
    g.strokeRoundedRect(px, py, panelW, panelH, 14);
    g.fillStyle(0x9a_6a_35, 1);
    g.fillRoundedRect(px, py, panelW, 40, { bl: 0, br: 0, tl: 14, tr: 14 });

    for (const c of this.cells) {
      const sel = c.idx === this.picked;
      const isHot = c.idx < HOTBAR;
      let fill = 0xdc_c5_96;
      if (sel) {
        fill = 0xff_e9_a8;
      } else if (isHot) {
        fill = 0xe8_d3_a6;
      }
      g.fillStyle(fill, 1);
      g.fillRoundedRect(c.x - sz / 2, c.y - sz / 2, sz, sz, 6);
      g.lineStyle(2, sel ? 0xff_9d_3a : 0x8a_6a_35, 1);
      g.strokeRoundedRect(c.x - sz / 2, c.y - sz / 2, sz, sz, 6);
      const slot = store.inv.slotAt(c.idx);
      const icon = this.icons[c.idx];
      const qtyt = this.qtys[c.idx];
      if (!icon || !qtyt) {
        continue;
      }
      if (slot) {
        const ic = itemIcon(slot.item);
        icon
          .setVisible(true)
          .setTexture(ic.key, ic.frame)
          .setPosition(c.x, c.y)
          .setScale(slotIconScale(icon, sz >= 40 ? 32 : 24));
        qtyt
          .setText(slot.qty > 1 ? `${slot.qty}` : "")
          .setPosition(c.x + sz / 2 - 4, c.y + sz / 2 - 3);
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
        : "Tap an item, then a slot to move it.",
    );

    this.drawSkills();
  }

  private drawSkills(): void {
    const g = this.skillG;
    g.clear();
    const { x, y, w, h } = this.skillPanel;
    g.fillStyle(0x00_00_00, 0.3);
    g.fillRoundedRect(x + 4, y + 6, w, h, 14);
    g.fillStyle(0xf3_e2_bf, 1);
    g.fillRoundedRect(x, y, w, h, 14);
    g.lineStyle(4, 0x9a_6a_35, 1);
    g.strokeRoundedRect(x, y, w, h, 14);
    g.fillStyle(0x9a_6a_35, 1);
    g.fillRoundedRect(x, y, w, 40, { bl: 0, br: 0, tl: 14, tr: 14 });
    this.skillTitle.setPosition(x + 16, y + 10);
    this.skillGold
      .setPosition(x + w - 16, y + 12)
      .setOrigin(1, 0)
      .setText(`${store.gold}g`);
    let ry = y + 56;
    for (const id of SKILL_IDS) {
      const s = store.skills.get(id);
      const need = xpToNext(s.level);
      const frac = need === Infinity ? 1 : PhaserMath.Clamp(s.xp / need, 0, 1);
      g.fillStyle(0x2a_1e_0e, 1);
      g.fillRoundedRect(x + 16, ry + 30, w - 32, 4, 2);
      g.fillStyle(0x5f_ae_3a, 1);
      g.fillRoundedRect(x + 16, ry + 30, (w - 32) * frac, 4, 2);
      ry += this.skillRow;
    }
    this.renderSkillLabels(x, y);
  }

  private skillLabels: Phaser.GameObjects.Text[] = [];
  private skillPerks: Phaser.GameObjects.Text[] = [];
  private skillProgress: Phaser.GameObjects.Text[] = [];
  private renderSkillLabels(x: number, y: number): void {
    if (this.skillLabels.length === 0) {
      for (const _id of SKILL_IDS) {
        this.skillLabels.push(
          this.add.text(0, 0, "", { color: "#3a2a14", fontFamily: FONT, fontSize: "11px" }),
        );
        this.skillPerks.push(
          this.add.text(0, 0, "", { color: "#5c4222", fontFamily: FONT, fontSize: "11px" }),
        );
        this.skillProgress.push(
          this.add
            .text(0, 0, "", { color: "#5c4222", fontFamily: FONT, fontSize: "9px" })
            .setOrigin(1, 0),
        );
      }
    }
    let ry = y + 56;
    for (const [i, id] of SKILL_IDS.entries()) {
      const lbl = this.skillLabels[i];
      if (!lbl) {
        continue;
      }
      const s = store.skills.get(id);
      const need = xpToNext(s.level);
      lbl.setText(`${SKILL_ICON[id]} ${SKILL_NAMES[id]} L${s.level}`).setPosition(x + 16, ry);
      this.skillPerks[i]?.setText(skillPerk(store.skills, id)).setPosition(x + 16, ry + 15);
      this.skillProgress[i]
        ?.setText(need === Infinity ? "MAX" : `${Math.floor(s.xp)}/${need} XP`)
        .setPosition(x + this.skillPanel.w - 16, ry + 1);
      ry += this.skillRow;
    }
  }
}
