import Phaser from "phaser";

import { HEROES } from "../data/heroes";
import { FONT } from "../render/font";
import { heroSheetTex } from "../render/sprites";

export class MenuScene extends Phaser.Scene {
  private selected = "ironvow";
  private cards: { id: string; ring: Phaser.GameObjects.Rectangle }[] = [];
  private detail!: Phaser.GameObjects.Text;
  private detailName!: Phaser.GameObjects.Text;

  constructor() {
    super("Menu");
  }

  create(): void {
    // scene instance is reused on BACK TO MENU — rebuild card refs from scratch
    this.cards = [];

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
    this.cameras.main.setBackgroundColor("#47aba9");

    // backdrop: open water, slowly drifting, with rocks and clouds
    const water = this.add.tileSprite(0, 0, W, H, "t-water").setOrigin(0).setScrollFactor(0);
    this.tweens.add({
      targets: water,
      tilePositionX: 128,
      tilePositionY: 64,
      duration: 24000,
      repeat: -1,
    });
    for (let i = 0; i < 6; i++) {
      const n = 1 + (i % 4);
      const x = (0.06 + 0.88 * ((i * 0.61) % 1)) * W;
      const y = (0.58 + 0.32 * ((i * 0.37) % 1)) * H; // keep below the card row
      const rk = this.add.sprite(x, y, `wrock${n}`, 0).setScale(0.55).setAlpha(0.9);
      if (this.anims.exists(`wrock${n}-anim`))
        rk.play({ key: `wrock${n}-anim`, startFrame: (i * 3) % 8 });
    }
    for (let i = 0; i < 4; i++) {
      const c = this.add
        .image(((i + 0.4) / 4) * W, (0.12 + 0.74 * ((i * 0.53) % 1)) * H, `cloud${1 + (i % 8)}`)
        .setAlpha(0.4)
        .setScale(0.8);
      this.tweens.add({
        targets: c,
        x: c.x + 320,
        duration: 26000 + i * 5000,
        yoyo: true,
        repeat: -1,
        ease: "Sine.InOut",
      });
    }

    // title ribbon
    this.add
      .nineslice(W / 2, 64, "ui-ribbon-blue", 0, Math.min(720, W - 120), 84, 58, 58, 22, 22)
      .setOrigin(0.5);
    this.add
      .text(W / 2, 58, "ANCIENTS OF ELDERMOOR", {
        fontFamily: FONT,
        fontSize: "36px",
        color: "#f4eee0",
        stroke: "#1e2a3a",
        strokeThickness: 6,
      })
      .setOrigin(0.5);
    this.add
      .text(W / 2, 116, "Choose your champion · destroy the enemy Ancient", {
        fontFamily: FONT,
        fontSize: "16px",
        color: "#eafaf8",
        stroke: "#1e3a38",
        strokeThickness: 4,
      })
      .setOrigin(0.5);

    // hero cards on carved parchment panels
    const n = HEROES.length;
    const cardW = Math.min(160, (W - 80) / n - 16);
    const totalW = n * (cardW + 16) - 16;
    const startX = (W - totalW) / 2;
    const cardY = 170;
    const cardH = 204;

    HEROES.forEach((h, i) => {
      const x = startX + i * (cardW + 16) + cardW / 2;
      const cy = cardY + cardH / 2;
      const panel = this.add
        .nineslice(x, cy, "ui-carved9", 0, cardW, cardH, 20, 20, 20, 20)
        .setInteractive({ useHandCursor: true });
      const ring = this.add
        .rectangle(x, cy, cardW + 6, cardH + 6, 0x000000, 0)
        .setStrokeStyle(4, 0xffe14a, 1)
        .setVisible(false);
      const tex = heroSheetTex(h.id);
      if (this.textures.exists(tex)) {
        this.add
          .sprite(x, cardY + 72, tex, 0)
          .setScale(0.72)
          .setTint(h.tint);
      }
      const nameText = this.add
        .text(x, cardY + 132, h.name, { fontFamily: FONT, fontSize: "16px", color: "#4a3320" })
        .setOrigin(0.5);
      if (nameText.width > cardW - 16) nameText.setScale((cardW - 16) / nameText.width);
      this.add
        .text(x, cardY + 154, h.role, {
          fontFamily: FONT,
          fontSize: "11px",
          color: "#7a6240",
          align: "center",
          wordWrap: { width: cardW - 18 },
        })
        .setOrigin(0.5, 0);
      panel.on("pointerover", () => this.preview(h.id));
      panel.on("pointerdown", () => this.select(h.id));
      this.cards.push({ id: h.id, ring });
    });

    // detail panel
    this.detailName = this.add
      .text(W / 2, cardY + cardH + 38, "", {
        fontFamily: FONT,
        fontSize: "21px",
        color: "#fff3c4",
        stroke: "#27343c",
        strokeThickness: 5,
      })
      .setOrigin(0.5);
    this.detail = this.add
      .text(W / 2, cardY + cardH + 66, "", {
        fontFamily: FONT,
        fontSize: "14px",
        color: "#f0fffd",
        align: "center",
        stroke: "#1e3a38",
        strokeThickness: 3,
        wordWrap: { width: Math.min(820, W - 80) },
        lineSpacing: 6,
      })
      .setOrigin(0.5, 0);

    // start buttons: vs Bots (local) and Online (multiplayer drop-in)
    const mkBtn = (x: number, label: string, color: "blue" | "red", online: boolean) => {
      const b = this.add
        .nineslice(x, H - 72, `ui-btn-${color}`, 0, 272, 66, 28, 28, 20, 26)
        .setInteractive({ useHandCursor: true });
      const t = this.add
        .text(x, H - 76, label, { fontFamily: FONT, fontSize: "21px", color: "#1e3a44" })
        .setOrigin(0.5);
      b.on("pointerover", () => this.tweens.add({ targets: [b, t], scale: 1.05, duration: 110 }));
      b.on("pointerout", () => this.tweens.add({ targets: [b, t], scale: 1, duration: 110 }));
      b.on("pointerdown", () => {
        b.setTexture(`ui-btn-${color}-pressed`);
        t.setText("LOADING…").setY(H - 72);
        this.time.delayedCall(80, () =>
          this.scene.start("Game", { heroId: this.selected, online }),
        );
      });
    };
    mkBtn(W / 2 - 150, "PLAY vs BOTS", "blue", false);
    mkBtn(W / 2 + 150, "PLAY ONLINE", "red", true);
    this.add
      .text(
        W / 2,
        H - 26,
        "Arrows move · Q W E R abilities (aim by facing, Shift+key levels) · Space attack · F dash · 1-6 items · B shop · Tab scores",
        {
          fontFamily: FONT,
          fontSize: "12px",
          color: "#dff5f3",
          stroke: "#1e3a38",
          strokeThickness: 3,
        },
      )
      .setOrigin(0.5);

    this.select(this.selected);
  }

  private preview(id: string): void {
    const h = HEROES.find((x) => x.id === id);
    if (!h) return;
    this.detailName.setText(`${h.name}, ${h.title}  —  ${h.role}`);
    const abilities = (["Q", "W", "E", "R"] as const)
      .map((k) => `[${k}] ${h.abilities[k].name}`)
      .join("    ");
    this.detail.setText(`${h.blurb}\n\n${abilities}`);
  }

  private select(id: string): void {
    this.selected = id;
    this.preview(id);
    for (const c of this.cards) c.ring.setVisible(c.id === id);
  }
}
