import { safeAreaInset } from "@vibedgames/gamepad";
import { notifyGameStarted } from "@vibedgames/multiplayer";
import Phaser from "phaser";

import { HEROES } from "../data/heroes";
import { FONT } from "../render/font";
import { heroSheetTex } from "../render/sprites";

/** Coarse-pointer detection at boot, so copy is input-aware before any touch. */
function touchDevice(): boolean {
  return window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
}

export class MenuScene extends Phaser.Scene {
  private selected = "ironvow";
  private cards: { id: string; ring: Phaser.GameObjects.Rectangle }[] = [];
  private detail!: Phaser.GameObjects.Text;
  private detailName!: Phaser.GameObjects.Text;
  private compactH = false; // short viewports (landscape phones) drop the blurb
  private relayout: Phaser.Time.TimerEvent | null = null;

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
      notifyGameStarted();
      this.scene.start("Game", { heroId: this.selected, online: params.get("online") === "1" });
      return;
    }

    const W = this.scale.width;
    const H = this.scale.height;
    const touch = touchDevice();
    const inset = safeAreaInset();
    this.compactH = H < 520;
    this.cameras.main.setBackgroundColor("#47aba9");

    // the menu is static, so a debounced restart is the simplest correct
    // relayout for resizes / phone rotation (`selected` survives on the instance)
    this.scale.on(Phaser.Scale.Events.RESIZE, this.queueRelayout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Phaser.Scale.Events.RESIZE, this.queueRelayout, this);
      this.relayout?.remove();
      this.relayout = null;
    });

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
      const anim = this.anims.get(`wrock${n}-anim`);
      // clamp startFrame to the real frame count — a sheet can load with fewer
      // frames than authored if it exceeds the GPU's max texture size.
      if (anim && anim.frames.length > 0)
        rk.play({ key: `wrock${n}-anim`, startFrame: (i * 3) % anim.frames.length });
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
    const titleY = this.compactH ? 36 : 64;
    this.add
      .nineslice(
        W / 2,
        titleY,
        "ui-ribbon-blue",
        0,
        Math.min(720, W - 24),
        this.compactH ? 66 : 84,
        58,
        58,
        22,
        22,
      )
      .setOrigin(0.5);
    const title = this.add
      .text(W / 2, titleY - 6, "ANCIENTS OF ELDERMOOR", {
        fontFamily: FONT,
        fontSize: this.compactH ? "28px" : "36px",
        color: "#f4eee0",
        stroke: "#1e2a3a",
        strokeThickness: 6,
      })
      .setOrigin(0.5);
    title.setScale(Math.min(1, (Math.min(720, W - 24) - 60) / Math.max(1, title.width)));
    if (!this.compactH)
      this.add
        .text(W / 2, 116, "Choose your champion · destroy the enemy Ancient", {
          fontFamily: FONT,
          fontSize: "16px",
          color: "#eafaf8",
          stroke: "#1e3a38",
          strokeThickness: 4,
        })
        .setOrigin(0.5);

    // hero cards on carved parchment panels; a 3-wide grid on narrow screens
    const n = HEROES.length;
    const cols = W < 720 ? 3 : n;
    const rows = Math.ceil(n / cols);
    const cardW = Math.min(160, (W - 48) / cols - 12);
    const f = cardW / 160;
    const cardH = 204 * f;
    const stepX = cardW + 12;
    const stepY = cardH + 12;
    const gy0 = this.compactH ? 80 : 150;
    const x0 = (W - (cols * stepX - 12)) / 2 + cardW / 2;

    HEROES.forEach((h, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const card = this.add.container(x0 + col * stepX, gy0 + row * stepY + cardH / 2).setScale(f);
      const panel = this.add
        .nineslice(0, 0, "ui-carved9", 0, 160, 204, 20, 20, 20, 20)
        .setInteractive({ useHandCursor: true });
      const ring = this.add
        .rectangle(0, 0, 166, 210, 0x000000, 0)
        .setStrokeStyle(4, 0xffe14a, 1)
        .setVisible(false);
      card.add([panel, ring]);
      const tex = heroSheetTex(h.id);
      if (this.textures.exists(tex)) {
        card.add(this.add.sprite(0, -30, tex, 0).setScale(0.72).setTint(h.tint));
      }
      const nameText = this.add
        .text(0, 30, h.name, { fontFamily: FONT, fontSize: "16px", color: "#4a3320" })
        .setOrigin(0.5);
      if (nameText.width > 144) nameText.setScale(144 / nameText.width);
      card.add(nameText);
      card.add(
        this.add
          .text(0, 52, h.role, {
            fontFamily: FONT,
            fontSize: "11px",
            color: "#7a6240",
            align: "center",
            wordWrap: { width: 142 },
          })
          .setOrigin(0.5, 0),
      );
      panel.on("pointerover", () => this.preview(h.id));
      // restore the SELECTED hero's details when the cursor leaves, so the panel
      // never describes a hero you're only hovering (and won't actually play).
      panel.on("pointerout", () => this.preview(this.selected));
      panel.on("pointerdown", () => this.select(h.id));
      this.cards.push({ id: h.id, ring });
    });
    const gridBottom = gy0 + rows * stepY;

    // detail panel
    this.detailName = this.add
      .text(W / 2, gridBottom + (this.compactH ? 16 : 30), "", {
        fontFamily: FONT,
        fontSize: this.compactH ? "17px" : "21px",
        color: "#fff3c4",
        stroke: "#27343c",
        strokeThickness: 5,
      })
      .setOrigin(0.5);
    this.detail = this.add
      .text(W / 2, gridBottom + (this.compactH ? 36 : 58), "", {
        fontFamily: FONT,
        fontSize: this.compactH ? "12px" : "14px",
        color: "#f0fffd",
        align: "center",
        stroke: "#1e3a38",
        strokeThickness: 3,
        wordWrap: { width: Math.min(820, W - 48) },
        lineSpacing: 6,
      })
      .setOrigin(0.5, 0);

    // start buttons: vs Bots (local) and Online (multiplayer drop-in);
    // stacked on narrow screens so they never overflow
    const stack = W < 640;
    const btnY = H - (this.compactH ? 52 : 72) - inset.bottom;
    const mkBtn = (x: number, y: number, label: string, color: "blue" | "red", online: boolean) => {
      const b = this.add
        .nineslice(x, y, `ui-btn-${color}`, 0, 272, 66, 28, 28, 20, 26)
        .setInteractive({ useHandCursor: true });
      const t = this.add
        .text(x, y - 4, label, { fontFamily: FONT, fontSize: "21px", color: "#1e3a44" })
        .setOrigin(0.5);
      b.on("pointerover", () => this.tweens.add({ targets: [b, t], scale: 1.05, duration: 110 }));
      b.on("pointerout", () => this.tweens.add({ targets: [b, t], scale: 1, duration: 110 }));
      b.on("pointerdown", () => {
        b.setTexture(`ui-btn-${color}-pressed`);
        t.setText("LOADING…").setY(y);
        notifyGameStarted();
        this.time.delayedCall(80, () =>
          this.scene.start("Game", { heroId: this.selected, online }),
        );
      });
    };
    mkBtn(stack ? W / 2 : W / 2 - 150, stack ? btnY - 74 : btnY, "PLAY vs BOTS", "blue", false);
    mkBtn(stack ? W / 2 : W / 2 + 150, btnY, "PLAY ONLINE", "red", true);
    // The only place controls are taught — the match HUD carries no hint bar.
    this.add
      .text(
        W / 2,
        btnY + 46,
        touch
          ? "Drag to move · 2nd finger attacks · tap an ability to cast · SHOP and SCORES buttons"
          : "Arrows move · Q W E R abilities (aim by facing, Shift+key levels) · Space attack · F dash · 1-6 items · B shop · Tab scores · M mute",
        {
          fontFamily: FONT,
          fontSize: stack ? "10px" : "12px",
          color: "#dff5f3",
          stroke: "#1e3a38",
          strokeThickness: 3,
          align: "center",
          wordWrap: { width: W - 40 },
        },
      )
      .setOrigin(0.5);

    this.select(this.selected);
  }

  private queueRelayout(): void {
    this.relayout?.remove();
    this.relayout = this.time.delayedCall(150, () => this.scene.restart());
  }

  private preview(id: string): void {
    const h = HEROES.find((x) => x.id === id);
    if (!h) return;
    this.detailName.setText(`${h.name}, ${h.title}  —  ${h.role}`);
    const abilities = (["Q", "W", "E", "R"] as const)
      .map((k) => `[${k}] ${h.abilities[k].name}`)
      .join("    ");
    // short viewports: the blurb won't fit between the cards and the buttons
    this.detail.setText(this.compactH ? abilities : `${h.blurb}\n\n${abilities}`);
  }

  private select(id: string): void {
    this.selected = id;
    this.preview(id);
    for (const c of this.cards) c.ring.setVisible(c.id === id);
  }
}
