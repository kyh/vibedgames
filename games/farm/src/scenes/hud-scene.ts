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
import { onSceneExit } from "../render/scene-lifetime";
import { hotbarGrid } from "../render/hotbar-layout";
import { isPick, isTouchDevice } from "../systems/touch";
import { GameScene, type DayRecap } from "./game-scene";

const FONT = "ui-monospace, monospace";
const SLOT = 42;
const PAD = 4;

type ToastNotice = {
  message: string;
  color: string;
  node: Phaser.GameObjects.Text;
};
type DayCard = {
  container: Phaser.GameObjects.Container;
  panel: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  season: Phaser.GameObjects.Text;
  recap: Phaser.GameObjects.Text;
};

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
  /** Slots per hotbar row — drops below HOTBAR when a single row cannot hold
   *  MIN_SLOT-wide slots (portrait phone). */
  private perRow = HOTBAR;
  private inset: Inset = { top: 0, right: 0, bottom: 0, left: 0 };
  private touchUi: Phaser.GameObjects.Container[] = [];
  private topPanel!: Phaser.GameObjects.Graphics;
  private dayText!: Phaser.GameObjects.Text;
  private seasonText!: Phaser.GameObjects.Text;
  private clockText!: Phaser.GameObjects.Text;
  private rightPanel!: Phaser.GameObjects.Graphics;
  private goldText!: Phaser.GameObjects.Text;
  private bars!: Phaser.GameObjects.Graphics;
  private toolTip!: Phaser.GameObjects.Text;
  private actionTip: Phaser.GameObjects.Text | null = null;
  private notices: ToastNotice[] = [];
  private dayCard: DayCard | null = null;
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
    this.notices = [];
    this.dayCard = null;
    this.hudSig = "";
    this.slot = SLOT;
    this.perRow = HOTBAR;
    this.touchUi = [];
    for (const e of [
      "toast",
      "daybanner",
      "open-shop",
      "open-animal-shop",
      "confirm-sleep",
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

    this.actionTip = this.add
      .text(0, 0, "", {
        fontFamily: FONT,
        fontSize: "12px",
        color: "#ffe27a",
        stroke: "#2a1e0e",
        strokeThickness: 3,
        align: "center",
      })
      .setOrigin(0.5, 1);

    // Touch controls live HERE (not in GameScene) so the overlay isn't
    // transformed by the game camera's zoom. The Hud's input plugin processes
    // pointers before GameScene's, so hotbar taps never reach the game. No
    // action buttons: tapping a tile IS the use action (see GameScene input).
    this.g.gamepad?.destroy();
    this.g.gamepad = attachVirtualGamepad(this, {
      visible: "coarse",
      render: { depth: 90, blendMode: Phaser.BlendModes.NORMAL },
    });
    const gamepad = this.g.gamepad;
    onSceneExit(this, () => {
      gamepad.destroy();
      if (this.g.gamepad === gamepad) this.g.gamepad = undefined;
    });

    this.buildHotbar();
    this.buildTouchButtons();
    this.layout();
    if (this.onResize) this.scale.off("resize", this.onResize);
    this.onResize = () => this.layout();
    this.scale.on("resize", this.onResize);
    const scale = this.scale;
    const onResize = this.onResize;
    onSceneExit(this, () => scale.off("resize", onResize));

    const onToast = (text: string, color: string) => this.toast(text, color);
    const onLevelUp = (skill: SkillId, level: number) =>
      this.toast(`${SKILL_NAMES[skill]} reached Level ${level}!`, "#ffe27a");
    const onDayBanner = (day: number, season: Season, weather: Weather, recap?: DayRecap) =>
      this.dayBanner(day, season, weather, recap);
    this.g.events.on("toast", onToast);
    this.g.events.on("daybanner", onDayBanner);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.g.events.off("toast", onToast);
      this.g.events.off("daybanner", onDayBanner);
      this.g.events.off("levelup", onLevelUp);
      for (const notice of this.notices) this.removeNotice(notice);
      this.notices = [];
      this.clearDayBanner();
      this.actionTip = null;
    });
    this.g.events.on("open-shop", () => this.openShop());
    this.g.events.on("open-animal-shop", (b: BuildingKind) => this.openAnimalShop(b));
    this.g.events.on("confirm-sleep", () => this.openSleep());
    this.g.events.on("levelup", onLevelUp);
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
    // Commit on release, not on press: the hotbar band is exactly where a thumb
    // starts a movement drag, and the floating stick claims that touch on the
    // way down — so a drag has to stay a move and not also swap tools.
    zone.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (!this.g.controlsPaused && !this.g.uiOpen && isPick(p)) store.inv.select(i);
    });
    return zone;
  }

  /** Always-visible tap target (inventory) for touch devices, where the I key
   *  binding is unreachable. */
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
  }

  /** Center of hotbar slot `i`. Slots wrap into rows on narrow screens, first
   *  row on top so the 1–9 order still reads left to right, top to bottom. */
  private slotPos(i: number, W: number, H: number) {
    const pitch = this.slot + PAD;
    const total = this.perRow * pitch - PAD;
    const rows = Math.ceil(HOTBAR / this.perRow);
    return {
      x: (W - total) / 2 + this.slot / 2 + (i % this.perRow) * pitch,
      y:
        H -
        this.slot / 2 -
        14 -
        this.inset.bottom -
        (rows - 1 - Math.floor(i / this.perRow)) * pitch,
    };
  }

  /** Top edge of the whole hotbar block — what everything above it clears. */
  private hotbarTop(H: number): number {
    const rows = Math.ceil(HOTBAR / this.perRow);
    return H - 14 - this.inset.bottom - rows * (this.slot + PAD) + PAD;
  }

  private layout(): void {
    const W = this.scale.width,
      H = this.scale.height;
    this.inset = safeAreaInset();
    const { top: it, right: ir, left: il } = this.inset;
    const { slot, perRow } = hotbarGrid(W - 12 - il - ir, SLOT, PAD);
    if (slot !== this.slot || perRow !== this.perRow) {
      this.slot = slot;
      this.perRow = perRow;
      this.hudSig = ""; // force a graphics rebuild at the new slot size
      this.slotNodes.forEach((n, i) => {
        n.zone.destroy();
        n.zone = this.makeSlotZone(i, slot);
        this.hotbar.add(n.zone);
      });
    }
    for (let i = 0; i < HOTBAR; i++) {
      const n = this.slotNodes[i];
      if (!n) continue;
      const { x, y } = this.slotPos(i, W, H);
      n.icon.setPosition(x, y);
      n.qty.setPosition(x + slot / 2 - 4, y + slot / 2 - 3);
      n.key.setPosition(x - slot / 2 + 3, y - slot / 2 + 2);
      n.zone.setPosition(x, y);
    }
    this.dayText.setPosition(24 + il, 18 + it);
    this.seasonText.setPosition(24 + il, 38 + it);
    this.clockText.setPosition(24 + il, 56 + it);
    this.goldText.setPosition(W - 22 - ir, 28 + it);
    this.toolTip.setPosition(W / 2, this.hotbarTop(H) - 8);
    this.actionTip
      ?.setPosition(W / 2, this.hotbarTop(H) - 29)
      .setWordWrapWidth(Math.max(80, W - 40 - il - ir));
    this.layoutNotices();
    this.layoutDayBanner();
    this.touchUi.forEach((c, i) => c.setPosition(34 + il, 108 + it + i * 56));
    if (this.modal) this.modal.setPosition(W / 2, H / 2);
    if (this.dialogueBox) this.dialogueBox.setPosition(W / 2, this.dialogueY(H));
  }

  /** Dialogue sits just above the hotbar, whatever height the hotbar grew to. */
  private dialogueY(H: number): number {
    return this.hotbarTop(H) - 60;
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
    const hint = this.g.uiOpen || this.dialogueBox ? null : this.g.actionHint();
    this.actionTip?.setText(hint ?? "").setVisible(hint !== null);
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
    const { top: it, right: ir, left: il } = this.inset;
    for (let i = 0; i < HOTBAR; i++) {
      const n = this.slotNodes[i];
      if (!n) continue;
      const { x, y } = this.slotPos(i, W, H);
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

  /** At most three owned notices; repeated warnings refresh their own slot. */
  private toast(text: string, color = "#fff6d5"): void {
    let notice = this.notices.find((entry) => entry.message === text && entry.color === color);
    if (!notice) {
      if (this.notices.length === 3) {
        const oldest = this.notices.shift();
        if (oldest) this.removeNotice(oldest);
      }
      const node = this.add
        .text(0, 0, text, {
          fontFamily: FONT,
          fontSize: "14px",
          fontStyle: "bold",
          color,
          stroke: "#2a1e0e",
          strokeThickness: 4,
          align: "center",
        })
        .setOrigin(0.5, 0)
        .setDepth(100);
      notice = { message: text, color, node };
      this.notices.push(notice);
    }
    const current = notice;
    this.tweens.killTweensOf(current.node);
    current.node.setAlpha(1);
    this.layoutNotices();
    this.tweens.add({
      targets: current.node,
      alpha: 0,
      delay: 1200,
      duration: 700,
      onComplete: () => {
        this.notices = this.notices.filter((entry) => entry !== current);
        // This tween already owns completion; do not destroy it from its callback.
        current.node.destroy();
        this.layoutNotices();
      },
    });
  }

  private removeNotice(notice: ToastNotice): void {
    this.tweens.killTweensOf(notice.node);
    notice.node.destroy();
  }

  private layoutNotices(): void {
    const W = this.scale.width;
    let y = 92 + this.inset.top;
    for (const notice of this.notices) {
      notice.node.setWordWrapWidth(Math.max(80, W - 48 - this.inset.left - this.inset.right));
      notice.node.setPosition(W / 2, y);
      y += notice.node.height + 8;
    }
  }

  private clearDayBanner(): void {
    if (!this.dayCard) return;
    this.tweens.killTweensOf(this.dayCard.container);
    this.dayCard.container.destroy();
    this.dayCard = null;
  }

  private layoutDayBanner(): void {
    const card = this.dayCard;
    if (!card) return;
    const W = this.scale.width;
    const w = Math.min(420, W - 32 - this.inset.left - this.inset.right);
    const h = card.recap.visible ? 152 : 110;
    card.container.setPosition(W / 2, this.scale.height / 2);
    card.panel.clear();
    card.panel.fillStyle(0x000000, 0.2);
    card.panel.fillRoundedRect(-w / 2 + 4, -h / 2 + 5, w, h, 12);
    card.panel.fillStyle(0xf3e2bf, 0.96);
    card.panel.fillRoundedRect(-w / 2, -h / 2, w, h, 12);
    card.panel.lineStyle(3, 0x9a6a35, 1);
    card.panel.strokeRoundedRect(-w / 2, -h / 2, w, h, 12);
    card.label.setPosition(0, -h / 2 + 31).setFontSize(W < 400 ? 36 : 42);
    card.season
      .setPosition(0, -h / 2 + 66)
      .setFontSize(W < 400 ? 15 : 18)
      .setWordWrapWidth(w - 28);
    card.recap.setPosition(0, -h / 2 + 94).setWordWrapWidth(w - 28);
  }

  private dayBanner(day: number, season: Season, weather: Weather, recap?: DayRecap): void {
    this.clearDayBanner();
    const container = this.add.container(0, 0).setDepth(120);
    const panel = this.add.graphics();
    const label = this.add
      .text(0, 0, `Day ${day}`, {
        fontFamily: FONT,
        fontSize: "42px",
        fontStyle: "900",
        color: "#7a4a18",
      })
      .setOrigin(0.5);
    const seasonText = this.add
      .text(
        0,
        0,
        `${seasonIcon(season)} ${seasonName(season)}  ·  ${WEATHER_ICON[weather]} ${WEATHER_NAME[weather]}`,
        { fontFamily: FONT, fontSize: "18px", color: "#7a4a18", align: "center" },
      )
      .setOrigin(0.5);
    const recapText = this.add
      .text(
        0,
        0,
        recap
          ? `SHIPPING THIS VISIT
${recap.shipments} ${recap.shipments === 1 ? "delivery" : "deliveries"} · +${recap.shippedGold}g`
          : "",
        { fontFamily: FONT, fontSize: "12px", color: "#5a471f", align: "center" },
      )
      .setOrigin(0.5, 0)
      .setLineSpacing(3)
      .setVisible(recap !== undefined);
    container.add([panel, label, seasonText, recapText]);
    this.dayCard = { container, panel, label, season: seasonText, recap: recapText };
    this.layoutDayBanner();
    container.setScale(0.7).setAlpha(0);
    this.tweens.add({
      targets: container,
      alpha: 1,
      scale: 1,
      duration: 400,
      ease: "Back.easeOut",
    });
    this.tweens.add({
      targets: container,
      alpha: 0,
      delay: 1700,
      duration: 500,
      onComplete: () => {
        if (this.dayCard?.container === container) this.dayCard = null;
        container.destroy();
      },
    });
  }

  private showDialogue(d: { name: string; role: string; text: string; hearts: number }): void {
    this.dialogueBox?.destroy();
    const W = this.scale.width,
      H = this.scale.height;
    const w = Math.min(460, W - 24),
      h = 96;
    const c = this.add.container(W / 2, this.dialogueY(H)).setDepth(130);
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

  /** Whether a modal owns the Escape key right now (wrapper pause defers). */
  get modalOpen(): boolean {
    return this.modal !== null;
  }

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
      .setOrigin(0.5);
    const closeTarget = this.add
      .zone(w / 2 - 22, -h / 2 + 20, 44, 44)
      .setInteractive({ useHandCursor: true });
    closeTarget.on("pointerdown", () => this.closeModal());
    c.add([dim, panel, titleT, close, closeTarget]);
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
    const width = Math.min(390, this.scale.width - 24);
    const preview = this.g.overnightPreview();
    const detail =
      preview.withering > 0
        ? `\n${preview.withering} out-of-season crop${preview.withering === 1 ? "" : "s"} will wither.`
        : preview.changingSeason
          ? `\n${seasonName(preview.season)} begins tomorrow.`
          : "";
    const c = this.modalShell(width, 220, "Rest for the night?");
    const body = this.add
      .text(0, -5, `Sleep until morning.\nWatered crops grow, animals produce.${detail}`, {
        fontFamily: FONT,
        fontSize: "14px",
        color: "#3a2a14",
        align: "center",
        wordWrap: { width: width - 40 },
        lineSpacing: 5,
      })
      .setOrigin(0.5);
    const yes = this.bigBtn(-80, 74, "Sleep", 0x3a86c8, () => {
      this.modal?.destroy();
      this.modal = null;
      this.g.doSleep();
    });
    const no = this.bigBtn(80, 74, "Not yet", 0xb05a3a, () => this.closeModal());
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
      h = 44;
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
