import { safeAreaInset } from "@vibedgames/gamepad";
import { PhysicalGamepad } from "@vibedgames/gamepad/phaser";
import {
  controlGroups,
  isOfflineRequested,
  notifyGameStarted,
  watchControlContext,
} from "@repo/embed";
import type { ControlMethod } from "@repo/embed";
import type Phaser from "phaser";
import { Scale, Scene, Scenes } from "phaser";

import { CONTROLS } from "../controls";
import { HEROES } from "../data/heroes";
import { chipTexts } from "../pause-overlay";
import { FONT } from "../render/font";
import { heroSheetTex } from "../render/sprites";

// Section headers matching the pause plaque's GROUP_LABEL voice.
const GROUP_LABEL = {
  camera: "CAMERA",
  controller: "GAMEPAD",
  keys: "KEYBOARD",
  mouse: "MOUSE",
  touch: "TOUCH",
} satisfies Record<ControlMethod, string>;

interface MenuAction {
  online: boolean;
  color: "blue" | "red";
  button: Phaser.GameObjects.NineSlice;
  label: Phaser.GameObjects.Text;
  ring: Phaser.GameObjects.Rectangle;
}
type MenuFocus = { kind: "champion" } | { kind: "action"; action: MenuAction };
type FocusDirection = "left" | "right" | "up" | "down";

const ARROW_DIRECTION = new Map<string, FocusDirection>([
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
]);

export class MenuScene extends Scene {
  private selected = "ironvow";
  private cards: { id: string; ring: Phaser.GameObjects.Rectangle }[] = [];
  private detail!: Phaser.GameObjects.Text;
  private detailName!: Phaser.GameObjects.Text;
  // short viewports (landscape phones) drop the blurb
  private compactH = false;
  /** Top of whatever sits below the detail text (controls plaque or the PLAY
   *  row) — the blurb is dropped when it would run into it. */
  private detailLimitY = Number.POSITIVE_INFINITY;
  private relayout: Phaser.Time.TimerEvent | null = null;
  private unwatchControls: (() => void) | null = null;
  private controlsPlaque: Phaser.GameObjects.Container | null = null;
  private actions: MenuAction[] = [];
  private focus: MenuFocus = { kind: "champion" };
  private cardColumns = 6;
  private pad: PhysicalGamepad | null = null;
  private padConfirmArmed = false;
  private keyboardConfirmArmed = true;
  private starting = false;
  private navigationHint: Phaser.GameObjects.Text | null = null;

  constructor() {
    super("Menu");
  }

  create(): void {
    // scene instance is reused on BACK TO MENU — rebuild card refs from scratch
    this.cards = [];
    this.controlsPlaque = null;
    this.actions = [];
    this.focus = { kind: "champion" };
    this.starting = false;
    this.navigationHint = null;
    this.padConfirmArmed = false;
    this.keyboardConfirmArmed = true;

    const veil = document.querySelector("#veil");
    if (veil) {
      veil.classList.add("hidden");
      setTimeout(() => veil.remove(), 600);
    }

    // headless / quick-start: ?hero=duskblade&auto=1 skips straight into a match
    const params = new URLSearchParams(window.location.search);
    const heroParam = params.get("hero");
    if (heroParam && HEROES.some((h) => h.id === heroParam)) {
      this.selected = heroParam;
    }
    if (params.get("auto") === "1") {
      notifyGameStarted();
      this.scene.start("Game", { heroId: this.selected, online: params.get("online") === "1" });
      return;
    }

    const W = this.scale.width;
    const H = this.scale.height;
    this.compactH = H < 520;
    this.cameras.main.setBackgroundColor("#47aba9");

    // the menu is static, so a debounced restart is the simplest correct
    // relayout for resizes / phone rotation (`selected` survives on the instance)
    this.scale.on(Scale.Events.RESIZE, this.queueRelayout, this);
    this.events.once(Scenes.Events.SHUTDOWN, () => {
      this.scale.off(Scale.Events.RESIZE, this.queueRelayout, this);
      this.relayout?.remove();
      this.relayout = null;
      this.unwatchControls?.();
      this.unwatchControls = null;
      this.pad?.destroy();
      this.pad = null;
    });
    this.pad = new PhysicalGamepad();
    this.input.keyboard?.on("keydown", this.onMenuKeyDown, this);
    this.input.keyboard?.on("keyup", this.onMenuKeyUp, this);

    this.buildBackdrop(W, H);
    this.buildTitle(W);
    const gridBottom = this.buildHeroCards(W);
    this.buildDetailPanel(W, gridBottom);
    const btnY = this.buildStartButtons(W, H);
    // The only place controls are taught — the match HUD carries no hint bar.
    // The pause plaque's control language (gold method headers, HUD-echo
    // keycap chips) rendered as a war-plaque strip above the buttons.
    this.buildControlsPlaque(btnY);
    // Plugging in (or pulling) a pad while the menu is up updates the plaque.
    // Scene instance is reused — drop any stale subscription before adding one.
    this.unwatchControls?.();
    this.unwatchControls = watchControlContext(() => {
      this.buildControlsPlaque(btnY);
      this.preview(this.selected);
    });

    this.select(this.selected);
  }

  /** Open water, slowly drifting, with rocks and clouds. */
  private buildBackdrop(W: number, H: number): void {
    const water = this.add.tileSprite(0, 0, W, H, "t-water").setOrigin(0).setScrollFactor(0);
    this.tweens.add({
      duration: 24_000,
      repeat: -1,
      targets: water,
      tilePositionX: 128,
      tilePositionY: 64,
    });
    for (let i = 0; i < 6; i += 1) {
      const n = 1 + (i % 4);
      const x = (0.06 + 0.88 * ((i * 0.61) % 1)) * W;
      // keep below the card row
      const y = (0.58 + 0.32 * ((i * 0.37) % 1)) * H;
      const rk = this.add.sprite(x, y, `wrock${n}`, 0).setScale(0.55).setAlpha(0.9);
      const anim = this.anims.get(`wrock${n}-anim`);
      // clamp startFrame to the real frame count — a sheet can load with fewer
      // frames than authored if it exceeds the GPU's max texture size.
      if (anim && anim.frames.length > 0) {
        rk.play({ key: `wrock${n}-anim`, startFrame: (i * 3) % anim.frames.length });
      }
    }
    for (let i = 0; i < 4; i += 1) {
      const c = this.add
        .image(((i + 0.4) / 4) * W, (0.12 + 0.74 * ((i * 0.53) % 1)) * H, "clouds", i % 8)
        .setAlpha(0.4)
        .setScale(0.8);
      this.tweens.add({
        duration: 26_000 + i * 5000,
        ease: "Sine.InOut",
        repeat: -1,
        targets: c,
        x: c.x + 320,
        yoyo: true,
      });
    }
  }

  private buildTitle(W: number): void {
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
        color: "#f4eee0",
        fontFamily: FONT,
        fontSize: this.compactH ? "28px" : "36px",
        stroke: "#1e2a3a",
        strokeThickness: 6,
      })
      .setOrigin(0.5);
    title.setScale(Math.min(1, (Math.min(720, W - 24) - 60) / Math.max(1, title.width)));
    if (!this.compactH) {
      this.navigationHint = this.add
        .text(W / 2, 116, "", {
          color: "#eafaf8",
          fontFamily: FONT,
          fontSize: "16px",
          stroke: "#1e3a38",
          strokeThickness: 4,
        })
        .setOrigin(0.5);
    }
  }

  /** Hero cards on carved parchment panels; a 3-wide grid on narrow screens.
   *  Returns the y just below the grid. */
  private buildHeroCards(W: number): number {
    const n = HEROES.length;
    const cols = W < 720 ? 3 : n;
    this.cardColumns = cols;
    const rows = Math.ceil(n / cols);
    const cardW = Math.min(160, (W - 48) / cols - 12);
    const f = cardW / 160;
    const cardH = 204 * f;
    const stepX = cardW + 12;
    const stepY = cardH + 12;
    const gy0 = this.compactH ? 80 : 150;
    const x0 = (W - (cols * stepX - 12)) / 2 + cardW / 2;

    for (const [i, h] of HEROES.entries()) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const card = this.add.container(x0 + col * stepX, gy0 + row * stepY + cardH / 2).setScale(f);
      const panel = this.add
        .nineslice(0, 0, "ui-carved9", 0, 160, 204, 20, 20, 20, 20)
        .setInteractive({ useHandCursor: true });
      const ring = this.add
        .rectangle(0, 0, 166, 210, 0x00_00_00, 0)
        .setStrokeStyle(4, 0xff_e1_4a, 1)
        .setVisible(false);
      card.add([panel, ring]);
      const tex = heroSheetTex(h.id);
      if (this.textures.exists(tex)) {
        card.add(this.add.sprite(0, -30, tex, 0).setScale(0.72).setTint(h.tint));
      }
      const nameText = this.add
        .text(0, 30, h.name, { color: "#4a3320", fontFamily: FONT, fontSize: "16px" })
        .setOrigin(0.5);
      if (nameText.width > 144) {
        nameText.setScale(144 / nameText.width);
      }
      card.add(nameText);
      card.add(
        this.add
          .text(0, 52, h.role, {
            align: "center",
            color: "#7a6240",
            fontFamily: FONT,
            fontSize: "11px",
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
    }
    return gy0 + rows * stepY;
  }

  private buildDetailPanel(W: number, gridBottom: number): void {
    this.detailName = this.add
      .text(W / 2, gridBottom + (this.compactH ? 16 : 30), "", {
        color: "#fff3c4",
        fontFamily: FONT,
        fontSize: this.compactH ? "17px" : "21px",
        stroke: "#27343c",
        strokeThickness: 5,
      })
      .setOrigin(0.5);
    this.detail = this.add
      .text(W / 2, gridBottom + (this.compactH ? 36 : 58), "", {
        align: "center",
        color: "#f0fffd",
        fontFamily: FONT,
        fontSize: this.compactH ? "12px" : "14px",
        lineSpacing: 6,
        stroke: "#1e3a38",
        strokeThickness: 3,
        wordWrap: { width: Math.min(820, W - 48) },
      })
      .setOrigin(0.5, 0);
  }

  /** Start buttons: vs Bots (local) and Online (multiplayer drop-in). They
   *  share one row at every width, narrowing to fit — a second stacked row
   *  pushed the controls plaque up over the top button on a portrait phone.
   *  Returns the button row's y. */
  private buildStartButtons(W: number, H: number): number {
    const inset = safeAreaInset();
    const btnY = H - (this.compactH ? 52 : 72) - inset.bottom;
    const mkBtn = (x: number, w: number, label: string, color: "blue" | "red", online: boolean) => {
      const b = this.add
        .nineslice(x, btnY, `ui-btn-${color}`, 0, w, 66, 28, 28, 20, 26)
        .setInteractive({ useHandCursor: true });
      const t = this.add
        .text(x, btnY - 4, label, { color: "#1e3a44", fontFamily: FONT, fontSize: "21px" })
        .setOrigin(0.5);
      // shrink the type rather than the object: the hover tween owns `scale`
      if (t.width > w - 34) {
        t.setFontSize(Math.floor((21 * (w - 34)) / t.width));
      }
      b.on("pointerover", () => this.tweens.add({ duration: 110, scale: 1.05, targets: [b, t] }));
      b.on("pointerout", () => this.tweens.add({ duration: 110, scale: 1, targets: [b, t] }));
      const ring = this.add
        .rectangle(x, btnY, w + 6, 64, 0x00_00_00, 0)
        .setStrokeStyle(3, 0xff_e1_4a)
        .setVisible(false);
      const action = { button: b, color, label: t, online, ring };
      this.actions.push(action);
      b.on("pointerdown", () => this.beginMatch(action));
    };
    // ?offline=1 forbids any socket, so the online button is dropped rather
    // than left as a control that silently starts a bot match.
    if (isOfflineRequested()) {
      mkBtn(W / 2, Math.min(272, W - 48), "PLAY vs BOTS", "blue", false);
    } else {
      const btnW = Math.min(272, (W - 40) / 2 - 8);
      mkBtn(W / 2 - btnW / 2 - 8, btnW, "PLAY vs BOTS", "blue", false);
      mkBtn(W / 2 + btnW / 2 + 8, btnW, "PLAY ONLINE", "red", true);
    }
    return btnY;
  }

  private onMenuKeyDown(event: KeyboardEvent): void {
    if (this.starting) {
      return;
    }
    const direction = ARROW_DIRECTION.get(event.key);
    if (direction) {
      event.preventDefault();
      this.moveFocus(direction);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat && this.keyboardConfirmArmed) {
        this.keyboardConfirmArmed = false;
        this.confirmFocus();
      }
    }
  }

  private onMenuKeyUp(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      this.keyboardConfirmArmed = true;
    }
  }

  override update(): void {
    if (this.starting || !this.pad) {
      return;
    }
    this.pad.update();
    if (!this.pad.connected) {
      this.padConfirmArmed = false;
      return;
    }
    if (!this.pad.isButtonDown("a")) {
      this.padConfirmArmed = true;
    }
    for (const direction of ["left", "right", "up", "down"] satisfies (
      | "left"
      | "right"
      | "up"
      | "down"
    )[]) {
      if (this.pad.justPressed(direction)) {
        this.moveFocus(direction);
      }
    }
    if (this.pad.justPressed("b")) {
      this.focus = { kind: "champion" };
      this.paintFocus();
    } else if (this.padConfirmArmed && this.pad.justPressed("a")) {
      this.padConfirmArmed = false;
      this.confirmFocus();
    }
  }

  private moveFocus(direction: FocusDirection): void {
    if (this.starting) {
      return;
    }
    if (this.focus.kind === "action") {
      if (direction === "up") {
        this.focus = { kind: "champion" };
      } else if (direction === "left" || direction === "right") {
        const index = this.actions.indexOf(this.focus.action);
        const action =
          this.actions[
            (index + (direction === "left" ? -1 : 1) + this.actions.length) % this.actions.length
          ];
        if (action) {
          this.focus = { action, kind: "action" };
        }
      }
      this.paintFocus();
      return;
    }
    const index = Math.max(
      0,
      HEROES.findIndex((hero) => hero.id === this.selected),
    );
    if (direction === "down" && index + this.cardColumns >= HEROES.length) {
      this.focusPlay();
      return;
    }
    const hero = HEROES[this.nextCardIndex(index, direction)];
    if (hero) {
      this.select(hero.id);
    }
  }

  private nextCardIndex(index: number, direction: FocusDirection): number {
    switch (direction) {
      case "left": {
        return (index + HEROES.length - 1) % HEROES.length;
      }
      case "right": {
        return (index + 1) % HEROES.length;
      }
      case "up": {
        return index >= this.cardColumns ? index - this.cardColumns : index;
      }
      case "down": {
        return Math.min(HEROES.length - 1, index + this.cardColumns);
      }
      default: {
        return index;
      }
    }
  }

  private focusPlay(): void {
    const action = this.actions.find((entry) => !entry.online);
    if (!action) {
      return;
    }
    this.focus = { action, kind: "action" };
    this.paintFocus();
  }

  private confirmFocus(): void {
    if (this.starting) {
      return;
    }
    if (this.focus.kind === "champion") {
      this.focusPlay();
    } else {
      this.beginMatch(this.focus.action);
    }
  }

  private beginMatch(action: MenuAction): void {
    if (this.starting) {
      return;
    }
    this.starting = true;
    this.focus = { action, kind: "action" };
    this.paintFocus();
    action.button.setTexture(`ui-btn-${action.color}-pressed`);
    action.label.setText("LOADING…").setY(action.button.y);
    const heroId = this.selected;
    notifyGameStarted();
    this.time.delayedCall(80, () => this.scene.start("Game", { heroId, online: action.online }));
  }

  private paintFocus(): void {
    for (const card of this.cards) {
      card.ring
        .setVisible(card.id === this.selected)
        .setStrokeStyle(
          this.focus.kind === "champion" ? 4 : 2,
          0xff_e1_4a,
          this.focus.kind === "champion" ? 1 : 0.65,
        );
    }
    for (const action of this.actions) {
      action.ring.setVisible(this.focus.kind === "action" && this.focus.action === action);
    }
    if (this.navigationHint) {
      // A phone without a pad has no arrows or Enter to point at.
      const tapOnly =
        window.matchMedia("(pointer: coarse)").matches && !(this.pad?.connected ?? false);
      let text: string;
      if (this.focus.kind === "champion") {
        text = tapOnly
          ? "Choose a champion · tap to pick"
          : "Choose a champion · arrows / D-pad · Enter / A";
      } else {
        const play = this.focus.action.online ? "PLAY ONLINE" : "PLAY vs BOTS";
        text = tapOnly ? `${play} · tap to play` : `${play} · Enter / A to play · ↑ to return`;
      }
      this.navigationHint.setText(text).setScale(1);
      this.navigationHint.setScale(
        Math.min(1, (this.scale.width - 32) / Math.max(1, this.navigationHint.width)),
      );
    }
  }

  /** The menu's controls plaque — the pause overlay's grouped keycap language
   *  in Phaser objects: a dark bronze-edged panel, gold section headers between
   *  rules, chips split exactly like the pause plaque (shared chipTexts). Sits
   *  above the PLAY buttons; on short viewports it collapses to a bare
   *  single-line strip below them, scaled to fit. Rebuilt fresh per call. */
  private buildControlsPlaque(btnY: number): void {
    this.controlsPlaque?.destroy();
    this.controlsPlaque = null;
    const W = this.scale.width;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const groups = controlGroups(CONTROLS, { coarse });
    if (groups.length === 0) {
      return;
    }
    const compact = this.compactH;
    const container = this.add.container(0, 0);
    this.controlsPlaque = container;

    // Portrait phones keep the panel but at the strip's type size: the cards
    // already stack into extra rows, so the full-size plaque would sit on the
    // hero's name.
    const dense = compact || W < 480;
    const fontSize = dense ? "9px" : "12px";
    const chipH = dense ? 14 : 18;
    const lineH = chipH + (dense ? 4 : 9);
    const gapX = dense ? 8 : 12;
    const maxW = compact ? Number.POSITIVE_INFINITY : Math.min(900, W - 64);

    type Obj = Phaser.GameObjects.GameObject & Phaser.GameObjects.Components.Transform;
    interface Item {
      objs: Obj[];
      width: number;
    }
    const rows: Item[][] = [];
    let row: Item[] = [];
    let rowW = 0;
    const flushRow = (): void => {
      if (row.length > 0) {
        rows.push(row);
      }
      row = [];
      rowW = 0;
    };
    const addItem = (item: Item): void => {
      const grown = row.length > 0 ? rowW + gapX + item.width : item.width;
      if (row.length > 0 && grown > maxW) {
        flushRow();
      }
      rowW = row.length > 0 ? rowW + gapX + item.width : item.width;
      row.push(item);
    };

    for (const group of groups) {
      // each method heads its own row on the plaque
      if (!compact) {
        flushRow();
      }
      // gold section header between short rules, like the plaque's mp-gh
      const caption = this.add
        .text(20, 0, GROUP_LABEL[group.method], {
          color: "#d5ae5f",
          fontFamily: FONT,
          fontSize: dense ? "9px" : "11px",
        })
        .setOrigin(0, 0.5);
      const ruleL = this.add.rectangle(0, 0, 14, 1, 0x8a_73_50).setOrigin(0, 0.5).setAlpha(0.8);
      const ruleR = this.add
        .rectangle(20 + Math.ceil(caption.width) + 6, 0, 14, 1, 0x8a_73_50)
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
            .text(0, 0, text, { color: "#ffe8b0", fontFamily: FONT, fontSize })
            .setOrigin(0.5);
          const w = Math.max(chipH + 4, Math.ceil(cap.width) + 12);
          chips.fillStyle(0x2f_23_15, 1);
          chips.fillRoundedRect(x, -chipH / 2, w, chipH, 5);
          chips.lineStyle(1.5, 0x8a_73_50, 1);
          chips.strokeRoundedRect(x, -chipH / 2, w, chipH, 5);
          cap.setPosition(x + w / 2, 0);
          objs.push(cap);
          x += w + 3;
        }
        const action = this.add
          .text(x + 3, 0, entry.action, { color: "#d8cbb2", fontFamily: FONT, fontSize })
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
      container.setScale(Math.min(1, (W - 24) / maxRowW)).setPosition(W / 2, btnY + 42);
      this.detailLimitY = btnY - 40;
      return;
    }

    // The plaque panel behind the rows — dark bronze-edged, corner diamonds.
    const padX = 20;
    const padY = 12;
    const panelW = maxRowW + padX * 2;
    const panelH = contentH + padY * 2;
    const panelTop = -chipH / 2 - padY;
    const panel = this.add.graphics();
    panel.fillStyle(0x15_0e_07, 0.82);
    panel.fillRoundedRect(-panelW / 2, panelTop, panelW, panelH, 10);
    panel.lineStyle(2, 0x8a_73_50, 0.9);
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
        .rectangle(dx * (panelW / 2 - 9), panelTop + (dy > 0 ? panelH - 9 : 9), 6, 6, 0xd5_ae_5f)
        .setRotation(Math.PI / 4);
      container.add(corner);
    }
    // bottom edge of the panel clears the PLAY buttons' hover scale
    container.setPosition(W / 2, btnY - 44 - (panelTop + panelH));
    this.detailLimitY = container.y + panelTop - 6;
  }

  private queueRelayout(): void {
    this.relayout?.remove();
    this.relayout = this.time.delayedCall(150, () => this.scene.restart());
  }

  private preview(id: string): void {
    const h = HEROES.find((x) => x.id === id);
    if (!h) {
      return;
    }
    this.detailName.setText(`${h.name}, ${h.title}  —  ${h.role}`);
    const abilities = (["Q", "W", "E", "R"] as const)
      .map((k) => `[${k}] ${h.abilities[k].name}`)
      .join("    ");
    // short viewports: the blurb won't fit between the cards and the buttons.
    // Narrow-tall ones (portrait phones) stack the cards into more rows, so
    // the text can also collide with the plaque from above — shed the blurb,
    // then the abilities, until it clears.
    const fits = (): boolean => this.detail.y + this.detail.height <= this.detailLimitY;
    this.detail.setText(this.compactH ? abilities : `${h.blurb}\n\n${abilities}`);
    if (!fits()) {
      this.detail.setText(abilities);
    }
    if (!fits()) {
      this.detail.setText("");
    }
  }

  private select(id: string): void {
    if (this.starting) {
      return;
    }
    this.selected = id;
    this.focus = { kind: "champion" };
    this.preview(id);
    this.paintFocus();
  }
}
