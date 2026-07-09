import Phaser from "phaser";
import { attachVirtualGamepad, safeAreaInset, type Inset } from "@vibedgames/gamepad/phaser";
import { HOTBAR } from "../systems/inventory";
import { store } from "../systems/store";
import { itemIcon, itemName } from "../data/items";
import { CROPS, CROP_ORDER } from "../data/crops";
import { MAX_ENERGY, CAN_MAX } from "../config";
import { seasonName, seasonIcon, type Season } from "../data/calendar";
import { WEATHER_NAME, WEATHER_ICON, type Weather } from "../systems/weather";
import {
  ANIMALS,
  COOP_ANIMALS,
  BARN_ANIMALS,
  type AnimalKind,
  type BuildingKind,
} from "../data/animals";
import { SKILL_NAMES, type SkillId } from "../systems/skills";
import { Sound } from "../render/audio";
import { isTouchDevice } from "../systems/touch";
import { GameScene } from "./game-scene";

const FONT = "ui-monospace, monospace";
const SLOT = 42;
const PAD = 4;

export class HudScene extends Phaser.Scene {
  private g!: GameScene;
  private slotNodes: {
    bg: Phaser.GameObjects.Graphics;
    icon: Phaser.GameObjects.Image;
    qty: Phaser.GameObjects.Text;
    key: Phaser.GameObjects.Text;
    zone: Phaser.GameObjects.Zone;
  }[] = [];
  /** Hotbar slot size — shrinks from SLOT on narrow (portrait phone) screens. */
  private slot = SLOT;
  private inset: Inset = { top: 0, right: 0, bottom: 0, left: 0 };
  private touchUi: Phaser.GameObjects.Container[] = [];
  private muteIcon: Phaser.GameObjects.Text | null = null;
  private topPanel!: Phaser.GameObjects.Graphics;
  private dayText!: Phaser.GameObjects.Text;
  private seasonText!: Phaser.GameObjects.Text;
  private clockText!: Phaser.GameObjects.Text;
  private rightPanel!: Phaser.GameObjects.Graphics;
  private goldText!: Phaser.GameObjects.Text;
  private bars!: Phaser.GameObjects.Graphics;
  private toolTip!: Phaser.GameObjects.Text;
  private modal: Phaser.GameObjects.Container | null = null;
  private dialogueBox: Phaser.GameObjects.Container | null = null;
  private hotbar!: Phaser.GameObjects.Container;
  private onResize?: () => void;
  /** Last-drawn signature of the Graphics HUD (see hudSignature). */
  private hudSig = "";

  constructor() {
    super("Hud");
  }

  create(): void {
    const game = this.scene.get("Game");
    if (!(game instanceof GameScene)) throw new Error("Hud requires the Game scene");
    this.g = game;
    // scene instances are reused across stop/start — reset per-create state and
    // drop stale listeners on the (persistent) game-scene emitter to avoid dupes.
    this.slotNodes = [];
    this.modal = null;
    this.dialogueBox = null;
    this.toastY = 0;
    this.hudSig = "";
    this.slot = SLOT;
    this.touchUi = [];
    this.muteIcon = null;
    for (const e of [
      "toast",
      "daybanner",
      "open-shop",
      "open-animal-shop",
      "confirm-sleep",
      "toggle-help",
      "levelup",
      "dialogue",
    ]) {
      this.g.events.off(e);
    }

    this.topPanel = this.add.graphics();
    this.dayText = this.add.text(0, 0, "", {
      fontFamily: FONT,
      fontSize: "15px",
      fontStyle: "bold",
      color: "#fff6d5",
    });
    this.seasonText = this.add.text(0, 0, "", {
      fontFamily: FONT,
      fontSize: "12px",
      color: "#dfe9ff",
    });
    this.clockText = this.add.text(0, 0, "", {
      fontFamily: FONT,
      fontSize: "13px",
      color: "#dfe9ff",
    });

    this.rightPanel = this.add.graphics();
    this.goldText = this.add
      .text(0, 0, "", { fontFamily: FONT, fontSize: "16px", fontStyle: "bold", color: "#ffe27a" })
      .setOrigin(1, 0.5);
    this.bars = this.add.graphics();

    this.toolTip = this.add
      .text(0, 0, "", {
        fontFamily: FONT,
        fontSize: "12px",
        color: "#fff6d5",
        stroke: "#2a1e0e",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1);

    // Touch controls live HERE (not in GameScene) so the overlay isn't
    // transformed by the game camera's zoom. The Hud's input plugin processes
    // pointers before GameScene's, so pad.isTouching is accurate inside the
    // game's click-to-move handler.
    this.g.gamepad?.destroy();
    this.g.gamepad = attachVirtualGamepad(this, {
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
      render: { depth: 90, blendMode: Phaser.BlendModes.NORMAL },
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.g.gamepad?.destroy());

    this.buildHotbar();
    this.buildTouchButtons();
    this.layout();
    if (this.onResize) this.scale.off("resize", this.onResize);
    this.onResize = () => this.layout();
    this.scale.on("resize", this.onResize);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (this.onResize) this.scale.off("resize", this.onResize);
    });

    this.g.events.on("toast", (text: string, color: string) => this.toast(text, color));
    this.g.events.on("daybanner", (day: number, season: Season, weather: Weather) =>
      this.dayBanner(day, season, weather),
    );
    this.g.events.on("open-shop", () => this.openShop());
    this.g.events.on("open-animal-shop", (b: BuildingKind) => this.openAnimalShop(b));
    this.g.events.on("confirm-sleep", () => this.openSleep());
    this.g.events.on("toggle-help", () => this.toggleHelp());
    this.g.events.on("levelup", (skill: SkillId, level: number) =>
      this.toast(`${SKILL_NAMES[skill]} reached Level ${level}!`, "#ffe27a"),
    );
    this.g.events.on(
      "dialogue",
      (d: { name: string; role: string; text: string; hearts: number }) => this.showDialogue(d),
    );

    this.input.keyboard?.on("keydown-ESC", () => this.closeModal());
  }

  private buildHotbar(): void {
    this.hotbar = this.add.container(0, 0);
    for (let i = 0; i < HOTBAR; i++) {
      const bg = this.add.graphics();
      const icon = this.add.image(0, 0, "obj-wood").setVisible(false);
      const qty = this.add
        .text(0, 0, "", {
          fontFamily: FONT,
          fontSize: "12px",
          fontStyle: "bold",
          color: "#fff",
          stroke: "#000",
          strokeThickness: 3,
        })
        .setOrigin(1, 1);
      const key = this.add
        .text(0, 0, `${(i + 1) % 10}`, {
          fontFamily: FONT,
          fontSize: "10px",
          color: "#fff",
          stroke: "#000",
          strokeThickness: 2,
        })
        .setOrigin(0, 0)
        .setAlpha(0.7);
      const zone = this.makeSlotZone(i, SLOT);
      this.slotNodes.push({ bg, icon, qty, key, zone });
      this.hotbar.add([bg, icon, qty, key, zone]);
    }
  }

  private makeSlotZone(i: number, size: number): Phaser.GameObjects.Zone {
    const zone = this.add.zone(0, 0, size + PAD, size + PAD).setInteractive({
      useHandCursor: true,
    });
    zone.on("pointerdown", () => {
      if (!this.g.uiOpen) store.inv.select(i);
    });
    return zone;
  }

  /** Always-visible tap targets (inventory / help / sound) for touch devices,
   *  where the I/H/M key bindings are unreachable. */
  private buildTouchButtons(): void {
    if (!isTouchDevice()) return;
    const mk = (icon: string, onTap: () => void): Phaser.GameObjects.Text => {
      const c = this.add.container(0, 0).setDepth(60);
      const g = this.add.graphics();
      g.fillStyle(0x000000, 0.35);
      g.fillCircle(0, 0, 24);
      g.lineStyle(2, 0xf3e2bf, 0.5);
      g.strokeCircle(0, 0, 24);
      const t = this.add.text(0, 0, icon, { fontSize: "22px" }).setOrigin(0.5);
      const z = this.add.zone(0, 0, 52, 52).setInteractive({ useHandCursor: true });
      z.on("pointerdown", () => {
        Sound.click();
        onTap();
      });
      c.add([g, t, z]);
      this.touchUi.push(c);
      return t;
    };
    mk("🎒", () => this.g.toggleInventory());
    mk("❔", () => {
      if (this.modal || !this.g.uiOpen) this.toggleHelp();
    });
    this.muteIcon = mk(Sound.muted ? "🔇" : "🔊", () => {
      const muted = Sound.toggleMute();
      this.muteIcon?.setText(muted ? "🔇" : "🔊");
      this.toast(muted ? "Sound off" : "Sound on", "#dfe9ff");
    });
  }

  private layout(): void {
    const W = this.scale.width,
      H = this.scale.height;
    this.inset = safeAreaInset();
    const { top: it, right: ir, bottom: ib, left: il } = this.inset;
    const slot = Math.min(SLOT, Math.floor((W - 12 - il - ir) / HOTBAR) - PAD);
    if (slot !== this.slot) {
      this.slot = slot;
      this.hudSig = ""; // force a graphics rebuild at the new slot size
      this.slotNodes.forEach((n, i) => {
        n.zone.destroy();
        n.zone = this.makeSlotZone(i, slot);
        this.hotbar.add(n.zone);
      });
    }
    const total = HOTBAR * (slot + PAD) - PAD;
    const startX = (W - total) / 2 + slot / 2;
    const y = H - slot / 2 - 14 - ib;
    for (let i = 0; i < HOTBAR; i++) {
      const x = startX + i * (slot + PAD);
      const n = this.slotNodes[i];
      if (!n) continue;
      n.icon.setPosition(x, y);
      n.qty.setPosition(x + slot / 2 - 4, y + slot / 2 - 3);
      n.key.setPosition(x - slot / 2 + 3, y - slot / 2 + 2);
      n.zone.setPosition(x, y);
    }
    this.dayText.setPosition(24 + il, 18 + it);
    this.seasonText.setPosition(24 + il, 38 + it);
    this.clockText.setPosition(24 + il, 56 + it);
    this.goldText.setPosition(W - 22 - ir, 28 + it);
    this.toolTip.setPosition(W / 2, y - slot / 2 - 8);
    this.touchUi.forEach((c, i) => c.setPosition(34 + il, 108 + it + i * 56));
    if (this.modal) this.modal.setPosition(W / 2, H / 2);
    if (this.dialogueBox) this.dialogueBox.setPosition(W / 2, H - 120);
  }

  override update(): void {
    const W = this.scale.width,
      H = this.scale.height;
    // Graphics rebuilds are gated on a change signature; the texts below stay
    // per-frame (setText early-outs on an unchanged string).
    const sig = this.hudSignature(W, H);
    if (sig !== this.hudSig) {
      this.hudSig = sig;
      this.redrawGraphics(W, H);
    }

    this.dayText.setText(`Day ${this.g.day}`);
    const s = this.g.season();
    this.seasonText.setText(
      `${seasonIcon(s)} ${seasonName(s)}   ${WEATHER_ICON[this.g.weather]} ${WEATHER_NAME[this.g.weather]}`,
    );
    this.clockText.setText(this.formatClock(this.g.timeMin));
    this.goldText.setText(`${store.gold}g`);

    // tooltip
    const item = store.inv.selectedItem();
    let tip = item ? itemName(item) : "";
    if (item && item.kind === "tool" && item.tool === "can")
      tip += `  💧${this.g.canCharge}/${CAN_MAX}`;
    this.toolTip.setText(tip);
  }

  /** Everything the Graphics-drawn HUD (hotbar, panels, bars) depends on. */
  private hudSignature(W: number, H: number): string {
    const parts: (string | number)[] = [
      W,
      H,
      store.inv.selected,
      store.gold,
      store.hp,
      store.maxHp(),
      store.energy,
      this.g.canCharge,
    ];
    for (let i = 0; i < HOTBAR; i++) {
      const slot = store.inv.slots[i];
      if (slot) {
        const ic = itemIcon(slot.item);
        parts.push(ic.key, ic.frame ?? -1, slot.qty);
      } else {
        parts.push("·");
      }
    }
    return parts.join("|");
  }

  private redrawGraphics(W: number, H: number): void {
    // hotbar
    const slot = this.slot;
    const { top: it, right: ir, bottom: ib, left: il } = this.inset;
    const total = HOTBAR * (slot + PAD) - PAD;
    const startX = (W - total) / 2 + slot / 2;
    const y = H - slot / 2 - 14 - ib;
    for (let i = 0; i < HOTBAR; i++) {
      const n = this.slotNodes[i];
      if (!n) continue;
      const x = startX + i * (slot + PAD);
      const sel = i === store.inv.selected;
      n.bg.clear();
      n.bg.fillStyle(0x000000, 0.35);
      n.bg.fillRoundedRect(x - slot / 2, y - slot / 2, slot, slot, 7);
      n.bg.fillStyle(sel ? 0x6a5a2a : 0x20242f, 0.7);
      n.bg.fillRoundedRect(x - slot / 2 + 2, y - slot / 2 + 2, slot - 4, slot - 4, 6);
      n.bg.lineStyle(2, sel ? 0xffe27a : 0x000000, sel ? 1 : 0.3);
      n.bg.strokeRoundedRect(x - slot / 2, y - slot / 2, slot, slot, 7);
      n.key.setVisible(slot >= 34); // key hints are noise on tiny touch slots
      const invSlot = store.inv.slots[i];
      if (invSlot) {
        const ic = itemIcon(invSlot.item);
        n.icon
          .setVisible(true)
          .setTexture(ic.key, ic.frame)
          .setScale(slot < 38 ? 1.5 : 2);
        n.qty.setText(invSlot.qty > 1 ? `${invSlot.qty}` : "");
      } else {
        n.icon.setVisible(false);
        n.qty.setText("");
      }
    }

    // top-left panel
    this.topPanel.clear();
    panelRect(this.topPanel, 12 + il, 10 + it, 150, 64);

    // right panel: gold + HP + energy
    this.rightPanel.clear();
    panelRect(this.rightPanel, W - 172 - ir, 10 + it, 160, 70);
    this.drawBars(W - 164 - ir, 44 + it);
  }

  private drawBars(x: number, y: number): void {
    const g = this.bars;
    g.clear();
    const w = 144;
    // HP
    const hpFrac = store.hp / store.maxHp();
    g.fillStyle(0x2a1e0e, 1);
    g.fillRoundedRect(x, y, w, 12, 4);
    g.fillStyle(hpFrac > 0.5 ? 0xff7b7b : hpFrac > 0.25 ? 0xffcf4d : 0xff5d5d, 1);
    g.fillRoundedRect(x, y, Math.max(2, w * hpFrac), 12, 4);
    g.lineStyle(1, 0xffffff, 0.25);
    g.strokeRoundedRect(x, y, w, 12, 4);
    // energy
    const enFrac = store.energy / MAX_ENERGY;
    g.fillStyle(0x2a1e0e, 1);
    g.fillRoundedRect(x, y + 15, w, 10, 4);
    g.fillStyle(enFrac > 0.5 ? 0x7ed957 : enFrac > 0.25 ? 0xffcf4d : 0xff5d5d, 1);
    g.fillRoundedRect(x, y + 15, Math.max(2, w * enFrac), 10, 4);
    g.lineStyle(1, 0xffffff, 0.25);
    g.strokeRoundedRect(x, y + 15, w, 10, 4);
  }

  private formatClock(min: number): string {
    const h = Math.floor(min / 60);
    const m = Math.floor(min % 60);
    const ampm = h % 24 < 12 ? "AM" : "PM";
    let hh = h % 12;
    if (hh === 0) hh = 12;
    return `${hh}:${m < 10 ? "0" : ""}${m} ${ampm}`;
  }

  // ---------------------------------------------------------------- toasts / banner / dialogue

  private toastY = 0;
  private toast(text: string, color = "#fff6d5"): void {
    const W = this.scale.width;
    const t = this.add
      .text(W / 2, 92 + this.toastY, text, {
        fontFamily: FONT,
        fontSize: "15px",
        fontStyle: "bold",
        color,
        stroke: "#2a1e0e",
        strokeThickness: 4,
        align: "center",
      })
      .setOrigin(0.5, 0)
      .setDepth(100);
    this.toastY += 26;
    this.tweens.add({
      targets: t,
      alpha: { from: 1, to: 0 },
      y: t.y - 10,
      delay: 1200,
      duration: 700,
      onComplete: () => {
        t.destroy();
        this.toastY = Math.max(0, this.toastY - 26);
      },
    });
  }

  private dayBanner(day: number, season: Season, weather: Weather): void {
    const W = this.scale.width,
      H = this.scale.height;
    const c = this.add.container(W / 2, H / 2).setDepth(120);
    const label = this.add
      .text(0, -16, `Day ${day}`, {
        fontFamily: FONT,
        fontSize: "54px",
        fontStyle: "900",
        color: "#fff6d5",
        stroke: "#7a4a18",
        strokeThickness: 8,
      })
      .setOrigin(0.5);
    const sub = this.add
      .text(
        0,
        30,
        `${seasonIcon(season)} ${seasonName(season)}  ·  ${WEATHER_ICON[weather]} ${WEATHER_NAME[weather]}`,
        {
          fontFamily: FONT,
          fontSize: "20px",
          color: "#ffe9b0",
          stroke: "#7a4a18",
          strokeThickness: 4,
        },
      )
      .setOrigin(0.5);
    c.add([label, sub]);
    c.setScale(0.7).setAlpha(0);
    this.tweens.add({ targets: c, alpha: 1, scale: 1, duration: 400, ease: "Back.easeOut" });
    this.tweens.add({
      targets: c,
      alpha: 0,
      delay: 1700,
      duration: 500,
      onComplete: () => c.destroy(),
    });
  }

  private showDialogue(d: { name: string; role: string; text: string; hearts: number }): void {
    this.dialogueBox?.destroy();
    const W = this.scale.width,
      H = this.scale.height;
    const w = Math.min(460, W - 24),
      h = 96;
    const c = this.add.container(W / 2, H - 120).setDepth(130);
    const g = this.add.graphics();
    g.fillStyle(0x000000, 0.3);
    g.fillRoundedRect(-w / 2 + 4, -h / 2 + 5, w, h, 12);
    g.fillStyle(0xf3e2bf, 1);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, 12);
    g.lineStyle(3, 0x9a6a35, 1);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, 12);
    const name = this.add
      .text(-w / 2 + 16, -h / 2 + 12, `${d.name}`, {
        fontFamily: FONT,
        fontSize: "16px",
        fontStyle: "bold",
        color: "#7a4a18",
      })
      .setOrigin(0, 0);
    const role = this.add
      .text(-w / 2 + 16 + d.name.length * 11 + 8, -h / 2 + 15, d.role, {
        fontFamily: FONT,
        fontSize: "12px",
        color: "#a07b4c",
      })
      .setOrigin(0, 0);
    const heartStr = "♥".repeat(d.hearts) + "♡".repeat(Math.max(0, 10 - d.hearts));
    const hearts = this.add
      .text(w / 2 - 16, -h / 2 + 14, heartStr, {
        fontFamily: FONT,
        fontSize: "11px",
        color: "#ff5d7a",
      })
      .setOrigin(1, 0);
    const text = this.add
      .text(-w / 2 + 16, -6, d.text, {
        fontFamily: FONT,
        fontSize: "15px",
        color: "#3a2a14",
        wordWrap: { width: w - 32 },
      })
      .setOrigin(0, 0);
    c.add([g, name, role, hearts, text]);
    this.dialogueBox = c;
    c.setAlpha(0);
    this.tweens.add({ targets: c, alpha: 1, duration: 150 });
    this.tweens.add({
      targets: c,
      alpha: 0,
      delay: 3600,
      duration: 400,
      onComplete: () => {
        if (this.dialogueBox === c) this.dialogueBox = null;
        c.destroy();
      },
    });
  }

  // ---------------------------------------------------------------- modals

  private closeModal(): void {
    if (!this.modal) return;
    this.modal.destroy();
    this.modal = null;
    this.g.closeUi();
  }

  private modalShell(w: number, h: number, title: string): Phaser.GameObjects.Container {
    const c = this.add.container(this.scale.width / 2, this.scale.height / 2).setDepth(200);
    const dim = this.add
      .rectangle(0, 0, this.scale.width * 3, this.scale.height * 3, 0x000000, 0.45)
      .setInteractive();
    // universal escape: tapping the dim backdrop closes the modal (vital on
    // phones, where ESC doesn't exist)
    dim.on("pointerdown", () => this.closeModal());
    const panel = this.add.graphics();
    panel.fillStyle(0x000000, 0.25);
    panel.fillRoundedRect(-w / 2 + 4, -h / 2 + 6, w, h, 16);
    panel.fillStyle(0xf3e2bf, 1);
    panel.fillRoundedRect(-w / 2, -h / 2, w, h, 16);
    panel.lineStyle(4, 0x9a6a35, 1);
    panel.strokeRoundedRect(-w / 2, -h / 2, w, h, 16);
    panel.fillStyle(0x9a6a35, 1);
    panel.fillRoundedRect(-w / 2, -h / 2, w, 40, { tl: 16, tr: 16, bl: 0, br: 0 });
    const titleT = this.add
      .text(0, -h / 2 + 20, title, {
        fontFamily: FONT,
        fontSize: "20px",
        fontStyle: "bold",
        color: "#fff6d5",
      })
      .setOrigin(0.5);
    const close = this.add
      .text(w / 2 - 22, -h / 2 + 20, "✕", { fontFamily: FONT, fontSize: "20px", color: "#fff6d5" })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    close.on("pointerdown", () => this.closeModal());
    c.add([dim, panel, titleT, close]);
    this.modal = c;
    return c;
  }

  private openShop(): void {
    // Clamp to the viewport; landscape phones (too short for one column of
    // 11 crops) reflow into two columns instead of overflowing the screen.
    const W = this.scale.width,
      H = this.scale.height;
    const rowH = 33;
    const cols = 54 + CROP_ORDER.length * rowH + 78 <= H - 24 ? 1 : 2;
    const perCol = Math.ceil(CROP_ORDER.length / cols);
    const colW = Math.min(400, cols === 1 ? W - 64 : (W - 88) / 2);
    const w = Math.min(W - 24, cols * colW + 40 + (cols - 1) * 8);
    const h = Math.min(H - 24, 54 + perCol * rowH + 78);
    const c = this.modalShell(w, h, "🏪  General Store");
    const season = this.g.season();
    const startY = -h / 2 + 54;
    CROP_ORDER.forEach((id, i) => {
      const def = CROPS[id];
      const inSeason = def.seasons.includes(season);
      const col = Math.floor(i / perCol);
      const cx = cols === 1 ? 0 : col === 0 ? -(colW / 2 + 8) : colW / 2 + 8;
      const ry = startY + (i % perCol) * rowH;
      const row = this.add.container(cx, ry);
      const icon = this.add
        .image(-colW / 2 + 20, 0, `crop-${id}-icon`)
        .setScale(2)
        .setAlpha(inSeason ? 1 : 0.4);
      const name = this.add
        .text(-colW / 2 + 40, 0, def.name, {
          fontFamily: FONT,
          fontSize: "14px",
          color: inSeason ? "#3a2a14" : "#9a8a6a",
        })
        .setOrigin(0, 0.5);
      const seasonTag = this.add
        .text(-colW / 2 + 40, 11, def.seasons.map(seasonName).join("/"), {
          fontFamily: FONT,
          fontSize: "9px",
          color: "#a07b4c",
        })
        .setOrigin(0, 0.5);
      const price = this.add
        .text(colW / 2 - 132, 0, `${def.seedPrice}g`, {
          fontFamily: FONT,
          fontSize: "13px",
          color: "#7a5a1a",
        })
        .setOrigin(1, 0.5);
      const buy1 = this.shopBtn(colW / 2 - 90, "Buy", () => {
        if (this.g.buySeed(id, 1)) this.flash(price);
      });
      const buy5 = this.shopBtn(colW / 2 - 30, "x5", () => {
        if (this.g.buySeed(id, 5)) this.flash(price);
      });
      row.add([icon, name, seasonTag, price, buy1, buy5]);
      c.add(row);
    });
    const sellRow = this.add.container(0, h / 2 - 32);
    const sellBtn = this.shopBtn(0, "Sell all crops, fish & goods", () => {
      const total = this.g.sellAll();
      this.toast(
        total > 0 ? `Sold everything for ${total}g!` : "Nothing to sell.",
        total > 0 ? "#ffe27a" : "#ffd27a",
      );
    });
    sellRow.add(sellBtn);
    c.add(sellRow);
  }

  private openAnimalShop(building: BuildingKind): void {
    const list: AnimalKind[] = building === "coop" ? COOP_ANIMALS : BARN_ANIMALS;
    const w = Math.min(380, this.scale.width - 24),
      h = Math.min(110 + list.length * 56, this.scale.height - 24);
    const c = this.modalShell(w, h, building === "coop" ? "🐔  Coop" : "🐄  Barn");
    list.forEach((kind, i) => {
      const def = ANIMALS[kind];
      const ry = -h / 2 + 60 + i * 56;
      const row = this.add.container(0, ry);
      const spr = this.add.sprite(-w / 2 + 34, 0, def.texture, 0).setScale(1.4);
      const name = this.add
        .text(-w / 2 + 64, -8, def.name, {
          fontFamily: FONT,
          fontSize: "16px",
          fontStyle: "bold",
          color: "#3a2a14",
        })
        .setOrigin(0, 0);
      const desc = this.add
        .text(-w / 2 + 64, 10, `gives ${def.product} daily`, {
          fontFamily: FONT,
          fontSize: "11px",
          color: "#7a5a1a",
        })
        .setOrigin(0, 0);
      const price = this.add
        .text(w / 2 - 90, 0, `${def.price}g`, {
          fontFamily: FONT,
          fontSize: "14px",
          color: "#7a5a1a",
        })
        .setOrigin(1, 0.5);
      const buy = this.shopBtn(w / 2 - 48, "Buy", () => this.g.animals.buy(kind));
      row.add([spr, name, desc, price, buy]);
      c.add(row);
    });
    const tip = this.add
      .text(0, h / 2 - 22, "Pet animals daily to raise friendship ♥", {
        fontFamily: FONT,
        fontSize: "11px",
        color: "#7a5a1a",
      })
      .setOrigin(0.5);
    c.add(tip);
  }

  private shopBtn(x: number, label: string, onClick: () => void): Phaser.GameObjects.Container {
    const c = this.add.container(x, 0);
    const tw = label.length * 7.2 + 20;
    const g = this.add.graphics();
    g.fillStyle(0x5fae3a, 1);
    g.fillRoundedRect(-tw / 2, -12, tw, 24, 8);
    g.lineStyle(2, 0xffffff, 0.4);
    g.strokeRoundedRect(-tw / 2, -12, tw, 24, 8);
    const t = this.add
      .text(0, 0, label, { fontFamily: FONT, fontSize: "13px", fontStyle: "bold", color: "#fff" })
      .setOrigin(0.5);
    const z = this.add.zone(0, 0, tw, 24).setInteractive({ useHandCursor: true });
    z.on("pointerdown", () => {
      Sound.click();
      onClick();
    });
    z.on("pointerover", () => c.setScale(1.06));
    z.on("pointerout", () => c.setScale(1));
    c.add([g, t, z]);
    return c;
  }

  private flash(t: Phaser.GameObjects.Text): void {
    this.tweens.add({ targets: t, scale: 1.4, duration: 90, yoyo: true });
  }

  private openSleep(): void {
    const c = this.modalShell(Math.min(360, this.scale.width - 24), 180, "🛏  Rest for the night?");
    const body = this.add
      .text(0, -10, "Sleep until morning.\nWatered crops grow, animals produce.", {
        fontFamily: FONT,
        fontSize: "14px",
        color: "#3a2a14",
        align: "center",
      })
      .setOrigin(0.5);
    const yes = this.bigBtn(-80, 56, "Sleep", 0x3a86c8, () => {
      this.modal?.destroy();
      this.modal = null;
      this.g.doSleep();
    });
    const no = this.bigBtn(80, 56, "Not yet", 0xb05a3a, () => this.closeModal());
    c.add([body, yes, no]);
  }

  private bigBtn(
    x: number,
    y: number,
    label: string,
    color: number,
    onClick: () => void,
  ): Phaser.GameObjects.Container {
    const c = this.add.container(x, y);
    const w = 130,
      h = 40;
    const g = this.add.graphics();
    g.fillStyle(color, 1);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, 10);
    g.lineStyle(2, 0xffffff, 0.4);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, 10);
    const t = this.add
      .text(0, 0, label, { fontFamily: FONT, fontSize: "16px", fontStyle: "bold", color: "#fff" })
      .setOrigin(0.5);
    const z = this.add.zone(0, 0, w, h).setInteractive({ useHandCursor: true });
    z.on("pointerdown", () => {
      Sound.click();
      onClick();
    });
    c.add([g, t, z]);
    return c;
  }

  private toggleHelp(): void {
    if (this.modal) {
      this.closeModal();
      return;
    }
    this.g.uiOpen = true;
    const w = Math.min(460, this.scale.width - 24);
    const h = Math.min(410, this.scale.height - 24);
    const c = this.modalShell(w, h, "ℹ  How to Play");
    const lines = isTouchDevice()
      ? [
          "Move: drag the on-screen stick (full tilt runs)",
          "Use / interact: the USE button",
          "Items: tap the hotbar · 🎒 inventory · 🔇 sound",
          "",
          "🪏 Hoe → till soil    🌱 Seeds → plant (in season!)",
          "💧 Can → water (refill at pond) · rain waters for you",
          "🪓 Axe → trees    ⛏ Pickaxe → rocks & the mine",
          "🎣 Rod → face water; USE to cast, hold to reel",
          "⚔ Sword → fight skeletons in the cave",
          "🍄 Walk over mushrooms to forage",
          "🐔 Pet animals; buy them at the coop & barn",
          "🧺 Sell at the crate or store; sleep at your house",
          "💬 Talk to villagers; gift what they like for ♥",
        ]
      : [
          "Move: WASD / Arrows   (Shift to run)",
          "Use / interact: Space, E, or Click",
          "Select item: 1–0 or scroll · I: inventory · H: help",
          "",
          "🪏 Hoe → till soil    🌱 Seeds → plant (in season!)",
          "💧 Can → water (refill at pond) · rain waters for you",
          "🪓 Axe → trees    ⛏ Pickaxe → rocks & the mine",
          "🎣 Rod → face water to fish (hold to reel in the zone)",
          "⚔ Sword → fight skeletons in the cave",
          "🍄 Walk over mushrooms to forage",
          "🐔 Pet animals; buy them at the coop & barn",
          "🧺 Sell at the crate or store; sleep at your house",
          "💬 Talk to villagers; gift what they like for ♥",
        ];
    const compact = h < 400 || w < 420;
    const txt = this.add
      .text(0, -h / 2 + 48, lines.join("\n"), {
        fontFamily: FONT,
        fontSize: compact ? "11px" : "13px",
        color: "#3a2a14",
        lineSpacing: compact ? 3 : 4,
        wordWrap: { width: w - 36 },
      })
      .setOrigin(0.5, 0);
    c.add(txt);
  }
}

function panelRect(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  g.fillStyle(0x000000, 0.4);
  g.fillRoundedRect(x, y, w, h, 8);
  g.lineStyle(2, 0xf3e2bf, 0.5);
  g.strokeRoundedRect(x, y, w, h, 8);
}
