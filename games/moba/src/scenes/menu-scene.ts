import { safeAreaInset } from "@vibedgames/gamepad";
import { controlGroups, notifyGameStarted, watchControlContext } from "@repo/embed";
import type { ControlMethod } from "@repo/embed";
import Phaser from "phaser";

import { CONTROLS } from "../controls";
import { HEROES } from "../data/heroes";
import { chipTexts } from "../pause-overlay";
import { FONT } from "../render/font";
import { heroSheetTex } from "../render/sprites";

// Section headers matching the pause plaque's GROUP_LABEL voice.
const GROUP_LABEL: Record<ControlMethod, string> = {
  keys: "KEYBOARD",
  mouse: "MOUSE",
  touch: "TOUCH",
  camera: "CAMERA",
  controller: "GAMEPAD",
};

export class MenuScene extends Phaser.Scene {
  private selected = "ironvow";
  private cards: { id: string; ring: Phaser.GameObjects.Rectangle }[] = [];
  private detail!: Phaser.GameObjects.Text;
  private detailName!: Phaser.GameObjects.Text;
  private compactH = false; // short viewports (landscape phones) drop the blurb
  private relayout: Phaser.Time.TimerEvent | null = null;
  private unwatchControls: (() => void) | null = null;
  private controlsPlaque: Phaser.GameObjects.Container | null = null;

  constructor() {
    super("Menu");
  }

  create(): void {
    // scene instance is reused on BACK TO MENU — rebuild card refs from scratch
    this.cards = [];
    this.controlsPlaque = null;

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
      this.unwatchControls?.();
      this.unwatchControls = null;
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
    // The pause plaque's control language (gold method headers, HUD-echo
    // keycap chips) rendered as a war-plaque strip above the buttons.
    this.buildControlsPlaque(btnY, stack);
    // Plugging in (or pulling) a pad while the menu is up updates the plaque.
    // Scene instance is reused — drop any stale subscription before adding one.
    this.unwatchControls?.();
    this.unwatchControls = watchControlContext(() => this.buildControlsPlaque(btnY, stack));

    this.select(this.selected);
  }

  /** The menu's controls plaque — the pause overlay's grouped keycap language
   *  in Phaser objects: a dark bronze-edged panel, gold section headers between
   *  rules, chips split exactly like the pause plaque (shared chipTexts). Sits
   *  above the PLAY buttons; on short viewports it collapses to a bare
   *  single-line strip below them, scaled to fit. Rebuilt fresh per call. */
  private buildControlsPlaque(btnY: number, stack: boolean): void {
    this.controlsPlaque?.destroy();
    this.controlsPlaque = null;
    const W = this.scale.width;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const groups = controlGroups(CONTROLS, { coarse });
    if (groups.length === 0) return;
    const compact = this.compactH;
    const container = this.add.container(0, 0);
    this.controlsPlaque = container;

    const fontSize = compact ? "9px" : "12px";
    const chipH = compact ? 14 : 18;
    const lineH = chipH + (compact ? 4 : 9);
    const gapX = compact ? 8 : 12;
    const maxW = compact ? Number.POSITIVE_INFINITY : Math.min(900, W - 64);

    type Obj = Phaser.GameObjects.GameObject & Phaser.GameObjects.Components.Transform;
    type Item = { objs: Obj[]; width: number };
    const rows: Item[][] = [];
    let row: Item[] = [];
    let rowW = 0;
    const flushRow = (): void => {
      if (row.length > 0) rows.push(row);
      row = [];
      rowW = 0;
    };
    const addItem = (item: Item): void => {
      const grown = row.length > 0 ? rowW + gapX + item.width : item.width;
      if (row.length > 0 && grown > maxW) flushRow();
      rowW = row.length > 0 ? rowW + gapX + item.width : item.width;
      row.push(item);
    };

    for (const group of groups) {
      if (!compact) flushRow(); // each method heads its own row on the plaque
      // gold section header between short rules, like the plaque's mp-gh
      const caption = this.add
        .text(20, 0, GROUP_LABEL[group.method], {
          fontFamily: FONT,
          fontSize: compact ? "9px" : "11px",
          color: "#d5ae5f",
        })
        .setOrigin(0, 0.5);
      const ruleL = this.add.rectangle(0, 0, 14, 1, 0x8a7350).setOrigin(0, 0.5).setAlpha(0.8);
      const ruleR = this.add
        .rectangle(20 + Math.ceil(caption.width) + 6, 0, 14, 1, 0x8a7350)
        .setOrigin(0, 0.5)
        .setAlpha(0.8);
      addItem({ objs: [ruleL, caption, ruleR], width: 40 + Math.ceil(caption.width) });
      for (const entry of group.entries) {
        const objs: Obj[] = [];
        const chips = this.add.graphics();
        objs.push(chips);
        let x = 0;
        for (const text of chipTexts(entry.input)) {
          const cap = this.add
            .text(0, 0, text, { fontFamily: FONT, fontSize, color: "#ffe8b0" })
            .setOrigin(0.5);
          const w = Math.max(chipH + 4, Math.ceil(cap.width) + 12);
          chips.fillStyle(0x2f2315, 1);
          chips.fillRoundedRect(x, -chipH / 2, w, chipH, 5);
          chips.lineStyle(1.5, 0x8a7350, 1);
          chips.strokeRoundedRect(x, -chipH / 2, w, chipH, 5);
          cap.setPosition(x + w / 2, 0);
          objs.push(cap);
          x += w + 3;
        }
        const action = this.add
          .text(x + 3, 0, entry.action, { fontFamily: FONT, fontSize, color: "#d8cbb2" })
          .setOrigin(0, 0.5);
        objs.push(action);
        addItem({ objs, width: x + 3 + Math.ceil(action.width) });
      }
    }
    flushRow();

    let maxRowW = 0;
    let y = 0;
    for (const line of rows) {
      const width = line.reduce((sum, item) => sum + item.width, 0) + gapX * (line.length - 1);
      maxRowW = Math.max(maxRowW, width);
      let x = -width / 2;
      for (const item of line) {
        for (const obj of item.objs) {
          obj.setPosition(obj.x + x, obj.y + y);
          container.add(obj);
        }
        x += item.width + gapX;
      }
      y += lineH;
    }
    const contentH = (rows.length - 1) * lineH + chipH;

    if (compact) {
      // bare strip under the buttons, where the old controls line lived
      container
        .setScale(Math.min(1, (W - 24) / maxRowW))
        .setPosition(W / 2, btnY + (stack ? 46 : 42));
      return;
    }

    // The plaque panel behind the rows — dark bronze-edged, corner diamonds.
    const padX = 20;
    const padY = 12;
    const panelW = maxRowW + padX * 2;
    const panelH = contentH + padY * 2;
    const panelTop = -chipH / 2 - padY;
    const panel = this.add.graphics();
    panel.fillStyle(0x150e07, 0.82);
    panel.fillRoundedRect(-panelW / 2, panelTop, panelW, panelH, 10);
    panel.lineStyle(2, 0x8a7350, 0.9);
    panel.strokeRoundedRect(-panelW / 2, panelTop, panelW, panelH, 10);
    container.addAt(panel, 0);
    const cornerDirs: readonly (readonly [number, number])[] = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    for (const [dx, dy] of cornerDirs) {
      const corner = this.add
        .rectangle(dx * (panelW / 2 - 9), panelTop + (dy > 0 ? panelH - 9 : 9), 6, 6, 0xd5ae5f)
        .setRotation(Math.PI / 4);
      container.add(corner);
    }
    // bottom edge of the panel clears the PLAY buttons' hover scale
    container.setPosition(W / 2, btnY - 44 - (panelTop + panelH));
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
