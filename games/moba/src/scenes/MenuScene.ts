import Phaser from "phaser";

import { HEROES } from "../data/heroes";
import { heroSheetTex } from "../render/sprites";

export class MenuScene extends Phaser.Scene {
  private selected = "ironvow";
  private cards: { id: string; box: Phaser.GameObjects.Rectangle }[] = [];
  private detail!: Phaser.GameObjects.Text;
  private detailName!: Phaser.GameObjects.Text;

  constructor() {
    super("Menu");
  }

  create(): void {
    const veil = document.getElementById("veil");
    if (veil) {
      veil.classList.add("hidden");
      setTimeout(() => veil.remove(), 600);
    }

    // headless / quick-start: ?hero=duskblade&auto=1 skips straight into a match
    const params = new URLSearchParams(window.location.search);
    const heroParam = params.get("hero");
    if (heroParam && HEROES.some((h) => h.id === heroParam)) this.selected = heroParam;
    if (params.get("auto") === "1") {
      this.scene.start("Game", { heroId: this.selected, online: params.get("online") === "1" });
      return;
    }

    const W = this.scale.width;
    const H = this.scale.height;
    this.cameras.main.setBackgroundColor("#0a0e16");

    // backdrop
    this.add.rectangle(0, 0, W, H, 0x0a0e16).setOrigin(0).setScrollFactor(0);
    this.add
      .text(W / 2, 60, "ANCIENTS OF ELDERMOOR", { fontSize: "44px", color: "#ffe6a3", fontStyle: "bold", stroke: "#3a2a10", strokeThickness: 6 })
      .setOrigin(0.5);
    this.add
      .text(W / 2, 104, "Choose your champion · destroy the enemy Ancient", { fontSize: "16px", color: "#8ea0c8" })
      .setOrigin(0.5);

    // hero cards row
    const n = HEROES.length;
    const cardW = Math.min(160, (W - 80) / n - 16);
    const totalW = n * (cardW + 16) - 16;
    const startX = (W - totalW) / 2;
    const cardY = 180;
    const cardH = 200;

    HEROES.forEach((h, i) => {
      const x = startX + i * (cardW + 16) + cardW / 2;
      const box = this.add
        .rectangle(x, cardY + cardH / 2, cardW, cardH, 0x161d2e)
        .setStrokeStyle(2, 0x2a3550)
        .setInteractive({ useHandCursor: true });
      const tex = heroSheetTex(h.id);
      if (this.textures.exists(tex)) {
        this.add.sprite(x, cardY + 70, tex, 0).setScale(0.7).setTint(h.tint);
      }
      this.add.text(x, cardY + 130, h.name, { fontSize: "15px", color: "#eaf0ff", fontStyle: "bold" }).setOrigin(0.5);
      this.add.text(x, cardY + 152, h.role, { fontSize: "11px", color: "#8ea0c8", align: "center", wordWrap: { width: cardW - 12 } }).setOrigin(0.5, 0);
      box.on("pointerover", () => this.preview(h.id));
      box.on("pointerdown", () => {
        this.select(h.id);
      });
      this.cards.push({ id: h.id, box });
    });

    // detail panel
    this.detailName = this.add.text(W / 2, cardY + cardH + 36, "", { fontSize: "20px", color: "#ffe6a3", fontStyle: "bold" }).setOrigin(0.5);
    this.detail = this.add
      .text(W / 2, cardY + cardH + 64, "", { fontSize: "14px", color: "#c7d2ee", align: "center", wordWrap: { width: Math.min(820, W - 80) }, lineSpacing: 6 })
      .setOrigin(0.5, 0);

    // start buttons: vs Bots (local) and Online (multiplayer drop-in)
    const mkBtn = (x: number, label: string, color: number, hover: number, online: boolean) => {
      const b = this.add.rectangle(x, H - 72, 250, 56, color).setStrokeStyle(2, hover).setInteractive({ useHandCursor: true });
      const t = this.add.text(x, H - 72, label, { fontSize: "20px", color: "#eafff0", fontStyle: "bold" }).setOrigin(0.5);
      b.on("pointerover", () => b.setFillStyle(hover));
      b.on("pointerout", () => b.setFillStyle(color));
      b.on("pointerdown", () => {
        t.setText("LOADING…");
        this.time.delayedCall(60, () => this.scene.start("Game", { heroId: this.selected, online }));
      });
    };
    mkBtn(W / 2 - 140, "⚔  PLAY vs BOTS", 0x2a6f3a, 0x35864a, false);
    mkBtn(W / 2 + 140, "🌐  PLAY ONLINE", 0x2a5a8f, 0x356fb0, true);
    this.add
      .text(W / 2, H - 30, "Arrows move · Q W E R abilities (aim by facing, Shift+key levels) · Space attack · F dash · 1-6 items · B shop · Tab scores", { fontSize: "12px", color: "#6b7a9c" })
      .setOrigin(0.5);

    this.select("ironvow");
  }

  private preview(id: string): void {
    const h = HEROES.find((x) => x.id === id);
    if (!h) return;
    this.detailName.setText(`${h.name}, ${h.title}  —  ${h.role}`);
    const abilities = (["Q", "W", "E", "R"] as const).map((k) => `[${k}] ${h.abilities[k].name}`).join("    ");
    this.detail.setText(`${h.blurb}\n\n${abilities}`);
  }

  private select(id: string): void {
    this.selected = id;
    this.preview(id);
    for (const c of this.cards) {
      c.box.setStrokeStyle(c.id === id ? 3 : 2, c.id === id ? 0xffe14a : 0x2a3550);
      c.box.setFillStyle(c.id === id ? 0x202942 : 0x161d2e);
    }
  }
}
