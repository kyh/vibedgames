import { safeAreaInset } from "@vibedgames/gamepad";
import type Phaser from "phaser";
import { Scale, Scene, Scenes } from "phaser";

import type { Team } from "../data/config";
import { HERO_BY_ID, valAt } from "../data/heroes";
import type { AbilityDef, AbilityKey } from "../data/heroes";
import { ITEMS, ITEM_BY_ID } from "../data/items";
import { BRIDGES, GRID, WORLD, isHighCell, isLandCell } from "../data/map";
import { FONT } from "../render/font";
import { abilityIconFrame } from "../render/fx-map";
import { heroSheetTex } from "../render/sprites";
import type { HeroState, Unit, World } from "../sim/types";
import { SLOT_LABEL } from "./game-scene";
import type { GameScene } from "./game-scene";

type SafeAreaInset = ReturnType<typeof safeAreaInset>;

interface Point {
  x: number;
  y: number;
}

/** Anchor points the ability/dash/item widgets are positioned from. */
interface BarLayout {
  dashPos: Point;
  itemPos: Point[];
  slotPos: Point[];
}

/** Top-left origins the info strip hands to the widgets that sit under it. */
interface InfoAnchors {
  iy: number;
  left: number;
  stripX: number;
}

/** Coarse-pointer detection at boot, so copy is input-aware before any touch. */
const touchDevice = (): boolean =>
  window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;

const KEYS: AbilityKey[] = ["Q", "W", "E", "R"];

/** Minimap dot for a creep: neutral gold, else team colour. */
const creepDotColor = (u: Unit): number => {
  if (u.neutral) {
    return 0xe0_a9_3a;
  }
  return u.team === "radiant" ? 0x46_c0_74 : 0xe0_6a_6a;
};

/** Minimap dot for a hero: the local player is highlighted over its team colour. */
const heroDotColor = (u: Unit, isMe: boolean): number => {
  if (isMe) {
    return 0xff_e1_4a;
  }
  return u.team === "radiant" ? 0x7f_dc_ff : 0xff_9a_8a;
};

/** Inventory chip border: green when an active is ready, amber while it cools. */
const itemStrokeColor = (hasActive: boolean, ready: boolean): number => {
  if (!hasActive) {
    return 0x8a_73_50;
  }
  return ready ? 0x3f_9e_4d : 0x9a_7a_30;
};

const shopCostColor = (owned: boolean, afford: boolean): string => {
  if (owned) {
    return "#6be07a";
  }
  return afford ? "#ffd23a" : "#a05050";
};
const MINIMAP_SIZE = 232;
const MINIMAP_H = Math.round(MINIMAP_SIZE * (WORLD.height / WORLD.width));
// Compact (phone) ability cluster: dash anchors the corner, Q/W/E/R fan on a
// quarter-arc around it — every button the same size (mobile-MOBA convention).
// uniform button radius
const ARC_R = 28;
// Q sits almost straight above the anchor
const ARC_START_DEG = 2;
// ...and R lands level with it (quarter arc)
const ARC_SPAN_DEG = 88;
const DEG = Math.PI / 180;

interface Slot {
  key: AbilityKey;
  // carved backdrop; `box` on top carries the state stroke
  panel: Phaser.GameObjects.Image;
  box: Phaser.GameObjects.Rectangle;
  // compact-mode round button (replaces panel+box)
  circle: Phaser.GameObjects.Arc;
  // compact-mode cooldown/mana veil (whole-button)
  cdCircle: Phaser.GameObjects.Arc;
  icon: Phaser.GameObjects.Image;
  // applied spell-sheet frame, so update() re-textures only on change
  iconFrame: number;
  cd: Phaser.GameObjects.Rectangle;
  cdText: Phaser.GameObjects.Text;
  pips: Phaser.GameObjects.Rectangle[];
  keyLabel: Phaser.GameObjects.Text;
  // tappable level-up badge (guests have no Shift+key)
  plus: Phaser.GameObjects.Text;
}

export class HudScene extends Scene {
  private gs!: GameScene;
  private slots: Slot[] = [];
  private hpBar!: Phaser.GameObjects.Rectangle;
  private mpBar!: Phaser.GameObjects.Rectangle;
  private hpText!: Phaser.GameObjects.Text;
  private mpText!: Phaser.GameObjects.Text;
  private portrait!: Phaser.GameObjects.Image;
  private lvlText!: Phaser.GameObjects.Text;
  private goldText!: Phaser.GameObjects.Text;
  private clockText!: Phaser.GameObjects.Text;
  private kdaText!: Phaser.GameObjects.Text;
  private respawnText!: Phaser.GameObjects.Text;
  private apText!: Phaser.GameObjects.Text;
  private barW = 200;
  private infoPanel!: Phaser.GameObjects.NineSlice;
  private barPanel!: Phaser.GameObjects.NineSlice;
  private dashPanel!: Phaser.GameObjects.Image;
  private scoreRibbon!: Phaser.GameObjects.NineSlice;
  private announceRibbon!: Phaser.GameObjects.NineSlice;
  private mapFrame!: Phaser.GameObjects.NineSlice;
  private itemSlots: {
    panel: Phaser.GameObjects.Image;
    box: Phaser.GameObjects.Rectangle;
    // compact-mode round chip (owned items only)
    circle: Phaser.GameObjects.Arc;
    icon: Phaser.GameObjects.Image;
    key: Phaser.GameObjects.Text;
  }[] = [];
  private shop!: Phaser.GameObjects.Container;
  private shopRows: {
    id: string;
    box: Phaser.GameObjects.Rectangle;
    cost: Phaser.GameObjects.Text;
  }[] = [];
  private shopOpen = false;
  private shopSel = 0;
  private shopPanelH = 0;

  // responsive state (set in layout)
  private touchUi = false;
  private compact = false;
  private portraitSize = 74;
  // compact: owned item chips stack in a column above the arc; update() places
  // them (ownership changes mid-match, empties are hidden entirely)
  private itemColX = 0;
  private itemColY = 0;

  // touch/mouse utility buttons (shop / scores / recall). `bg`+word label on
  // desktop, `img` roundel + glyph on compact — layout() flips which is live.
  private uiButtons: {
    bg: Phaser.GameObjects.NineSlice;
    img: Phaser.GameObjects.Image;
    txt: Phaser.GameObjects.Text;
    word: string;
    glyph: string;
  }[] = [];
  // compact stand-in for the ribbon
  private scorePanel!: Phaser.GameObjects.Image;

  // minimap
  // static land/water/bridges, drawn once per layout
  private mapTerrain!: Phaser.GameObjects.Graphics;
  private mapGfx!: Phaser.GameObjects.Graphics;
  private mapHit!: Phaser.GameObjects.Rectangle;
  private mapX = 0;
  private mapY = 0;
  private mapW = MINIMAP_SIZE;
  private mapH = MINIMAP_H;
  private mapScale = MINIMAP_SIZE / WORLD.width;
  // dynamic layer redraws at ~10Hz, not every frame
  private mapNextRedrawAt = 0;

  // kill feed + announce banner
  private feedLines: { text: Phaser.GameObjects.Text; until: number }[] = [];
  private announce!: Phaser.GameObjects.Text;
  private teamScore!: Phaser.GameObjects.Text;

  // scoreboard (Tab)
  private board!: Phaser.GameObjects.Container;
  private boardOpen = false;
  private boardNextRenderAt = 0;

  // low-HP danger pulse
  private danger!: Phaser.GameObjects.Rectangle;
  // subtle radial vignette framing the field (drawn behind every HUD widget)
  private vignette?: Phaser.GameObjects.Image;

  // dash (F) cooldown indicator
  private dashBox!: Phaser.GameObjects.Rectangle;
  private dashCd!: Phaser.GameObjects.Rectangle;
  private dashLabel!: Phaser.GameObjects.Text;
  // compact-mode round button
  private dashCircle!: Phaser.GameObjects.Arc;
  private dashCdCircle!: Phaser.GameObjects.Arc;

  constructor() {
    super("Hud");
  }

  /** Whether shop/scoreboard own the Escape key right now (wrapper pause defers). */
  get escConsumed(): boolean {
    return this.shopOpen || this.boardOpen;
  }

  init(data: { game: GameScene }): void {
    this.gs = data.game;
  }

  create(): void {
    // scene instance is reused across restarts — clear arrays/flags so build()
    // doesn't accumulate duplicate slots (the old GameObjects are already destroyed).
    this.slots = [];
    this.itemSlots = [];
    this.shopRows = [];
    this.feedLines = [];
    this.uiButtons = [];
    this.shopOpen = false;
    this.boardOpen = false;
    this.boardNextRenderAt = 0;
    this.mapNextRedrawAt = 0;
    this.touchUi = touchDevice();

    this.scale.on(Scale.Events.RESIZE, this.layout, this);
    this.events.once(Scenes.Events.SHUTDOWN, () =>
      this.scale.off(Scale.Events.RESIZE, this.layout, this),
    );
    // radial vignette to frame the field — sits behind every HUD widget, above the
    // game. In the HUD scene (camera zoom = 1) so it's true screen-space.
    if (this.textures.exists("vignette")) {
      this.vignette = this.add
        .image(0, 0, "vignette")
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(100);
    }
    this.danger = this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0xff_2a_2a, 0)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(43_000);
    this.build();
    this.buildShop();
    this.buildMinimap();
    this.buildFeed();
    this.buildBoard();
    this.layout();
    this.input.keyboard?.on("keydown-B", () => this.toggleShop());
    // keyboard shop navigation (active only while the shop is open)
    this.input.keyboard?.on("keydown-UP", () => this.shopOpen && this.moveShopSel(-1));
    this.input.keyboard?.on("keydown-DOWN", () => this.shopOpen && this.moveShopSel(1));
    this.input.keyboard?.on("keydown-ENTER", () => this.shopOpen && this.buySelected());
    this.input.keyboard?.on("keydown-SPACE", () => this.shopOpen && this.buySelected());
    this.input.keyboard?.on("keydown-TAB", (e: KeyboardEvent) => {
      e.preventDefault?.();
      this.toggleBoard();
    });
    this.input.keyboard?.on("keyup-TAB", () => {
      if (this.boardOpen) {
        this.toggleBoard();
      }
    });
    this.input.keyboard?.on("keydown-ESC", () => {
      if (this.shopOpen) {
        this.toggleShop();
      }
      if (this.boardOpen) {
        this.toggleBoard();
      }
    });
  }

  /** Controller twins for the HUD keys: SELECT = shop (B), START held = scores
   *  (Tab, hold-to-view), dpad + A drive the open shop. GameScene polls the pad
   *  each frame before this update runs (it sits earlier in the scene list), so
   *  the press edges here are fresh. */
  private pollPad(): void {
    const pad = this.gs?.physPad;
    if (!pad?.connected) {
      return;
    }
    if (pad.justPressed("select")) {
      this.toggleShop();
    }
    if (pad.justPressed("start") && !this.boardOpen) {
      this.toggleBoard();
    }
    if (pad.justReleased("start") && this.boardOpen) {
      this.toggleBoard();
    }
    if (this.shopOpen) {
      if (pad.justPressed("up")) {
        this.moveShopSel(-1);
      }
      if (pad.justPressed("down")) {
        this.moveShopSel(1);
      }
      if (pad.justPressed("a")) {
        this.buySelected();
      }
    }
  }

  private moveShopSel(d: number): void {
    const n = this.shopRows.length;
    if (n === 0) {
      return;
    }
    this.shopSel = (this.shopSel + d + n) % n;
    this.updateShopSelection();
  }

  private updateShopSelection(): void {
    for (const [i, r] of this.shopRows.entries()) {
      r.box.setStrokeStyle(
        i === this.shopSel ? 3 : 1,
        i === this.shopSel ? 0xc9_94_1e : 0xb8_98_68,
      );
    }
  }

  private buySelected(): void {
    const r = this.shopRows[this.shopSel];
    if (!r) {
      return;
    }
    this.flashRow(r.box, this.gs.buyItemForPlayer(r.id) ? 0x2a_6f_3a : 0x6f_2a_2a);
  }

  private build(): void {
    // top-left info on a carved parchment panel
    this.infoPanel = this.add
      .nineslice(8, 8, "ui-carved9", 0, 226, 112, 20, 20, 20, 20)
      .setOrigin(0, 0)
      .setDepth(-1);
    this.goldText = this.add.text(24, 20, "", {
      color: "#8a6510",
      fontFamily: FONT,
      fontSize: "18px",
    });
    this.clockText = this.add.text(24, 46, "", {
      color: "#5a4630",
      fontFamily: FONT,
      fontSize: "14px",
    });
    this.kdaText = this.add.text(24, 68, "", {
      color: "#5a4630",
      fontFamily: FONT,
      fontSize: "14px",
    });
    this.apText = this.add.text(24, 90, "", {
      color: "#9c2f2f",
      fontFamily: FONT,
      fontSize: "14px",
    });

    // center bottom: portrait + bars + abilities (positioned in layout)
    this.barPanel = this.add
      .nineslice(0, 0, "ui-carved3", 0, this.barW + 120, 64, 24, 24, 18, 18)
      .setDepth(-1);
    this.portrait = this.add.image(0, 0, "ui-panel").setDisplaySize(74, 74);
    this.lvlText = this.add
      .text(0, 0, "1", {
        color: "#ffe14a",
        fontFamily: FONT,
        fontSize: "20px",
        stroke: "#1c1410",
        strokeThickness: 4,
      })
      .setOrigin(0.5);

    this.add.existing(this.portrait);
    this.hpBar = this.add.rectangle(0, 0, this.barW, 16, 0x44_d0_7a).setOrigin(0, 0.5);
    this.mpBar = this.add.rectangle(0, 0, this.barW, 10, 0x4a_8f_ff).setOrigin(0, 0.5);
    this.hpText = this.add
      .text(0, 0, "", {
        color: "#ffffff",
        fontFamily: FONT,
        fontSize: "12px",
        stroke: "#1c2a20",
        strokeThickness: 3,
      })
      .setOrigin(0.5);
    this.mpText = this.add
      .text(0, 0, "", {
        color: "#ffffff",
        fontFamily: FONT,
        fontSize: "11px",
        stroke: "#1c2030",
        strokeThickness: 3,
      })
      .setOrigin(0.5);

    for (const key of KEYS) {
      // compact round button lives UNDER the icon (created first); its square
      // twins (panel+box) are the desktop look — layout() flips visibility
      const circle = this.add
        .circle(0, 0, ARC_R, 0x1c_14_10, 0.8)
        .setStrokeStyle(2, 0x8a_73_50)
        .setVisible(false)
        .setInteractive({ useHandCursor: true });
      circle.on("pointerdown", () => this.gs.castSlot(key, true));
      const panel = this.add.image(0, 0, "ui-panel").setDisplaySize(62, 62);
      const box = this.add
        .rectangle(0, 0, 58, 58, 0x1c_14_10, 0.12)
        .setStrokeStyle(2, 0x8a_73_50)
        .setInteractive({ useHandCursor: true });
      // abilities show their spell icon, with the key as a small corner badge
      const icon = this.add.image(0, 0, "spell-icons", 0).setDisplaySize(50, 50).setVisible(false);
      const keyLabel = this.add
        .text(0, 0, SLOT_LABEL[key], {
          color: "#ffe8b0",
          fontFamily: FONT,
          fontSize: "14px",
          stroke: "#1c1410",
          strokeThickness: 3,
        })
        .setOrigin(0, 0)
        .setDepth(5);
      const cd = this.add.rectangle(0, 0, 58, 58, 0x00_00_00, 0.6).setOrigin(0.5, 1);
      // compact veil: the whole circle dims (no drain animation on phones)
      const cdCircle = this.add.circle(0, 0, ARC_R - 1, 0x00_00_00, 0.6).setVisible(false);
      const cdText = this.add
        .text(0, 0, "", {
          color: "#fff",
          fontFamily: FONT,
          fontSize: "20px",
          stroke: "#1c1410",
          strokeThickness: 4,
        })
        .setOrigin(0.5);
      const pips = [0, 1, 2, 3].map(() => this.add.rectangle(0, 0, 10, 4, 0x8a_73_50));
      box.on("pointerdown", () => this.gs.castSlot(key, true));
      // tappable '+' badge: the only leveling path for touch players and online
      // guests (no Shift+key). Shown while ability points are banked.
      const plus = this.add
        .text(0, 0, "+", {
          backgroundColor: "#2f7d3a",
          color: "#eaffea",
          fontFamily: FONT,
          fontSize: "17px",
          padding: { x: 9, y: 3 },
        })
        .setOrigin(0.5)
        .setDepth(6)
        .setVisible(false)
        .setInteractive({ useHandCursor: true });
      plus.on("pointerdown", () => this.gs.levelSlot(key));
      this.slots.push({
        box,
        cd,
        cdCircle,
        cdText,
        circle,
        icon,
        iconFrame: -1,
        key,
        keyLabel,
        panel,
        pips,
        plus,
      });
    }

    // dash (F) cooldown indicator, sits just left of the ability bar; tappable.
    // On compact it becomes the big round corner anchor the ability arc bends
    // around, so it gets the same circle treatment as the ability slots.
    this.dashCircle = this.add
      .circle(0, 0, ARC_R, 0x1c_14_10, 0.8)
      .setStrokeStyle(2, 0x6a_b0_ff)
      .setVisible(false)
      .setInteractive({ useHandCursor: true });
    this.dashCircle.on("pointerdown", () => this.gs.dash());
    this.dashPanel = this.add.image(0, 0, "ui-panel").setDisplaySize(54, 62);
    this.dashBox = this.add
      .rectangle(0, 0, 50, 58, 0x1c_14_10, 0.12)
      .setStrokeStyle(2, 0x6a_b0_ff)
      .setInteractive({ useHandCursor: true });
    this.dashBox.on("pointerdown", () => this.gs.dash());
    this.dashLabel = this.add
      .text(0, 0, this.touchUi ? "⚡\ndash" : "F\ndash", {
        align: "center",
        color: "#3a5a78",
        fontFamily: FONT,
        fontSize: "11px",
        lineSpacing: 2,
      })
      .setOrigin(0.5);
    this.dashCd = this.add.rectangle(0, 0, 50, 58, 0x00_00_00, 0.62).setOrigin(0.5, 1);
    this.dashCdCircle = this.add.circle(0, 0, ARC_R - 1, 0x00_00_00, 0.62).setVisible(false);

    // inventory slots (1..6). Compact shows OWNED items only, as round chips —
    // an empty grid is dead pixels on a phone, so empties vanish entirely.
    for (let i = 0; i < 6; i += 1) {
      const circle = this.add
        .circle(0, 0, 19, 0x1c_14_10, 0.75)
        .setStrokeStyle(2, 0x8a_73_50)
        .setVisible(false)
        .setInteractive({ useHandCursor: true });
      circle.on("pointerdown", () => this.gs.useItemForPlayer(i));
      const panel = this.add.image(0, 0, "ui-panel").setDisplaySize(42, 42);
      const box = this.add
        .rectangle(0, 0, 38, 38, 0x1c_14_10, 0.12)
        .setStrokeStyle(2, 0x8a_73_50)
        .setInteractive({ useHandCursor: true });
      const icon = this.add.image(0, 0, "ui-icons", 0).setDisplaySize(30, 30).setVisible(false);
      const key = this.add
        .text(0, 0, `${i + 1}`, { color: "#6b5530", fontFamily: FONT, fontSize: "10px" })
        .setOrigin(0.5);
      box.on("pointerdown", () => this.gs.useItemForPlayer(i));
      this.itemSlots.push({ box, circle, icon, key, panel });
    }

    // utility buttons — the touch-reachable path to shop/scores/recall
    // (each has a keyboard twin: B / Tab / H). Desktop keeps the word pills;
    // compact swaps to small glyph roundels (layout() flips visibility, and
    // invisible objects receive no input, so only the live form is tappable).
    const mkBtn = (word: string, glyph: string, onTap: () => void): void => {
      const bg = this.add
        .nineslice(0, 0, "ui-btn-blue", 0, 92, 46, 28, 28, 20, 26)
        .setDepth(40_010)
        .setInteractive({ useHandCursor: true });
      const img = this.add
        .image(0, 0, "ui-panel")
        .setDisplaySize(40, 40)
        .setDepth(40_010)
        .setVisible(false)
        .setInteractive({ useHandCursor: true });
      const txt = this.add
        .text(0, 0, word, { color: "#1e3a44", fontFamily: FONT, fontSize: "13px" })
        .setOrigin(0.5)
        .setDepth(40_011);
      const up = (): void => {
        bg.setTexture("ui-btn-blue");
        img.clearTint();
      };
      bg.on("pointerdown", () => {
        bg.setTexture("ui-btn-blue-pressed");
        onTap();
      });
      bg.on("pointerup", up);
      bg.on("pointerout", up);
      img.on("pointerdown", () => {
        img.setTint(0xff_d2_4a);
        onTap();
      });
      img.on("pointerup", up);
      img.on("pointerout", up);
      this.uiButtons.push({ bg, glyph, img, txt, word });
    };
    mkBtn("SHOP", "🛒", () => this.toggleShop());
    mkBtn("SCORES", "🏆", () => this.toggleBoard());
    mkBtn("RECALL", "⌂", () => this.gs.recall());

    this.respawnText = this.add
      .text(0, 0, "", {
        color: "#ff6a5a",
        fontFamily: FONT,
        fontSize: "42px",
        stroke: "#1c1410",
        strokeThickness: 7,
      })
      .setOrigin(0.5)
      .setVisible(false);
  }

  private buildShop(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const panelW = 430;
    const panelH = 92 + ITEMS.length * 46;
    this.shopPanelH = panelH;
    const bg = this.add.nineslice(0, 0, "ui-carved9", 0, panelW, panelH, 20, 20, 20, 20);
    const title = this.add
      .text(0, -panelH / 2 + 26, "SHOP", { color: "#4a3320", fontFamily: FONT, fontSize: "24px" })
      .setOrigin(0.5);
    const sub = this.add
      .text(
        0,
        -panelH / 2 + 52,
        this.touchUi
          ? "tap an item to buy · ✕ closes (must be at base)"
          : "↑↓ select · Enter buy · B close (must be at base)",
        {
          color: "#7a6240",
          fontFamily: FONT,
          fontSize: "12px",
        },
      )
      .setOrigin(0.5);
    const close = this.add
      .text(panelW / 2 - 26, -panelH / 2 + 26, "✕", {
        color: "#8a3a2a",
        fontFamily: FONT,
        fontSize: "22px",
        padding: { x: 10, y: 8 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    close.on("pointerdown", () => this.toggleShop());
    const children: Phaser.GameObjects.GameObject[] = [bg, title, sub, close];
    for (const [i, it] of ITEMS.entries()) {
      const y = -panelH / 2 + 84 + i * 46;
      const row = this.add
        .rectangle(0, y, panelW - 36, 40, 0x4a_33_20, 0.08)
        .setStrokeStyle(1, 0xb8_98_68)
        .setInteractive({ useHandCursor: true });
      const icon = this.add.image(-panelW / 2 + 36, y, "ui-icons", it.icon).setDisplaySize(30, 30);
      const name = this.add
        .text(-panelW / 2 + 60, y - 8, it.name, {
          color: "#4a3320",
          fontFamily: FONT,
          fontSize: "13px",
        })
        .setOrigin(0, 0.5);
      const desc = this.add
        .text(-panelW / 2 + 60, y + 9, it.desc, {
          color: "#7a6240",
          fontFamily: FONT,
          fontSize: "9px",
          wordWrap: { width: panelW - 160 },
        })
        .setOrigin(0, 0.5);
      const cost = this.add
        .text(panelW / 2 - 26, y, `🪙${it.cost}`, {
          color: "#8a6510",
          fontFamily: FONT,
          fontSize: "13px",
        })
        .setOrigin(1, 0.5);
      row.on("pointerdown", () => {
        if (this.gs.buyItemForPlayer(it.id)) {
          this.flashRow(row, 0x2a_6f_3a);
        } else {
          this.flashRow(row, 0x6f_2a_2a);
        }
      });
      this.shopRows.push({ box: row, cost, id: it.id });
      children.push(row, icon, name, desc, cost);
    }
    this.shop = this.add
      .container(W / 2, H / 2, children)
      .setDepth(50_000)
      .setVisible(false);
  }

  private flashRow(row: Phaser.GameObjects.Rectangle, color: number): void {
    row.setFillStyle(color, 0.5);
    this.time.delayedCall(140, () => row.setFillStyle(0x4a_33_20, 0.08));
  }

  private toggleShop(): void {
    this.shopOpen = !this.shopOpen;
    this.shop.setVisible(this.shopOpen);
    // pause hero input so arrows drive the shop
    this.gs.uiBlocking = this.shopOpen;
    if (this.shopOpen) {
      this.shopSel = 0;
      this.updateShopSelection();
    } else {
      for (const r of this.shopRows) {
        r.box.setStrokeStyle(1, 0xb8_98_68);
      }
    }
  }

  // ---- minimap -------------------------------------------------------------
  private buildMinimap(): void {
    this.mapFrame = this.add
      .nineslice(0, 0, "ui-carved9", 0, MINIMAP_SIZE + 28, MINIMAP_H + 28, 20, 20, 20, 20)
      .setOrigin(0, 0)
      .setDepth(39_998);
    this.mapTerrain = this.add.graphics().setDepth(39_999);
    this.mapGfx = this.add.graphics().setDepth(40_000);
    this.mapHit = this.add
      .rectangle(0, 0, MINIMAP_SIZE, MINIMAP_H, 0x00_00_00, 0.001)
      .setOrigin(0, 0)
      .setDepth(40_002)
      .setInteractive({ useHandCursor: true });
    const order = (p: Phaser.Input.Pointer) => {
      const wx = (p.x - this.mapX) / this.mapScale;
      const wy = (p.y - this.mapY) / this.mapScale;
      this.gs.moveToWorldPoint(wx, wy);
    };
    this.mapHit.on("pointerdown", order);
  }

  /** Static minimap terrain: teal water, the two islands + centre isle, plateaus,
   *  and the wooden bridges — redrawn only when the layout moves the panel. */
  private drawMapTerrain(): void {
    if (!this.mapTerrain) {
      return;
    }
    const g = this.mapTerrain;
    const ox = this.mapX;
    const oy = this.mapY;
    const cell = (WORLD.width / GRID.cols) * this.mapScale;
    g.clear();
    g.fillStyle(0x2e_8f_8a, 1).fillRect(ox, oy, this.mapW, this.mapH);
    g.lineStyle(2, 0x3a_2c_20, 0.8).strokeRect(ox, oy, this.mapW, this.mapH);
    for (let cy = 0; cy < GRID.rows; cy += 1) {
      for (let cx = 0; cx < GRID.cols; cx += 1) {
        if (!isLandCell(cx, cy)) {
          continue;
        }
        g.fillStyle(isHighCell(cx, cy) ? 0x4a_7c_34 : 0x5d_91_41, 1);
        g.fillRect(ox + cx * cell, oy + cy * cell, cell + 0.5, cell + 0.5);
      }
    }
    g.fillStyle(0x9a_6a_3a, 1);
    for (const b of BRIDGES) {
      g.fillRect(
        ox + b.x0 * cell,
        oy + b.y0 * cell,
        (b.x1 - b.x0 + 1) * cell,
        (b.y1 - b.y0 + 1) * cell,
      );
    }
  }

  private updateMinimap(): void {
    const w = this.gs?.worldRef;
    if (!w) {
      return;
    }
    // ~10Hz: a full Graphics rebuild every frame is wasted work for a minimap
    if (this.time.now < this.mapNextRedrawAt) {
      return;
    }
    this.mapNextRedrawAt = this.time.now + 100;
    const g = this.mapGfx;
    const ox = this.mapX;
    const oy = this.mapY;
    const sc = this.mapScale;
    const tx = (x: number) => ox + x * sc;
    const ty = (y: number) => oy + y * sc;
    g.clear();
    for (const u of w.units.values()) {
      if (!u.alive) {
        continue;
      }
      if (u.kind === "structure") {
        const col = u.team === "radiant" ? 0x4f_a3_ff : 0xff_5a_4a;
        const sz = u.structure?.tier === "ancient" ? 6 : 3.5;
        g.fillStyle(col, 1).fillRect(tx(u.x) - sz / 2, ty(u.y) - sz / 2, sz, sz);
      } else if (u.kind === "creep") {
        const col = creepDotColor(u);
        g.fillStyle(col, 0.9).fillRect(tx(u.x) - 1, ty(u.y) - 1, 2, 2);
      }
    }
    // heroes on top
    const meId = this.gs.player?.id;
    for (const u of w.units.values()) {
      if (!u.alive || u.kind !== "hero") {
        continue;
      }
      const isMe = u.id === meId;
      const col = heroDotColor(u, isMe);
      g.fillStyle(col, 1).fillCircle(tx(u.x), ty(u.y), isMe ? 4 : 3);
      g.lineStyle(1, 0x05_08_0e, 1).strokeCircle(tx(u.x), ty(u.y), isMe ? 4 : 3);
    }
    // camera viewport box
    const v = this.gs.cameraView;
    g.lineStyle(1.5, 0xff_ff_ff, 0.7).strokeRect(tx(v.x), ty(v.y), v.width * sc, v.height * sc);
  }

  // ---- kill feed + announcements -------------------------------------------
  private buildFeed(): void {
    this.scoreRibbon = this.add
      .nineslice(0, 0, "ui-ribbon-yellow", 0, 252, 60, 58, 58, 22, 22)
      .setOrigin(0.5, 0)
      .setDepth(39_990);
    // compact stand-in: the ribbon texture can't shrink below its 58px corners,
    // so phones get a small parchment capsule instead
    this.scorePanel = this.add
      .image(0, 0, "ui-panel")
      .setDisplaySize(84, 28)
      .setOrigin(0.5, 0)
      .setDepth(39_990)
      .setVisible(false);
    this.teamScore = this.add
      .text(0, 0, "", { color: "#5a3a10", fontFamily: FONT, fontSize: "20px" })
      .setOrigin(0.5, 0)
      .setDepth(40_000);
    this.announceRibbon = this.add
      .nineslice(0, 0, "ui-ribbon-blue", 0, 560, 76, 58, 58, 22, 22)
      .setOrigin(0.5)
      .setDepth(45_990)
      .setAlpha(0);
    this.announce = this.add
      .text(0, 0, "", {
        align: "center",
        color: "#ffe6a3",
        fontFamily: FONT,
        fontSize: "26px",
        stroke: "#1e2a3a",
        strokeThickness: 5,
      })
      .setOrigin(0.5)
      .setDepth(46_000)
      .setAlpha(0);
  }

  private showAnnounce(text: string, tone: "good" | "bad" | "neutral"): void {
    let color = "#fff3c4";
    if (tone === "good") {
      color = "#9bf0b4";
    } else if (tone === "bad") {
      color = "#ffb0a4";
    }
    const W = this.scale.width;
    const cx = W / 2;
    const cy = this.scale.height * 0.26;
    // clamp to the viewport on phones (the text scales down, the ribbon caps)
    const fit = Math.min(1, (W - 56) / Math.max(1, this.announce.setText(text).width));
    this.announce
      .setColor(color)
      .setAlpha(1)
      .setScale(0.6 * fit);
    this.announce.setPosition(cx, cy - 4);
    this.announceRibbon.setPosition(cx, cy).setAlpha(1).setScale(0.6);
    this.announceRibbon.setSize(
      Math.min(W - 8, Math.max(380, this.announce.width * fit + 150)),
      76,
    );
    this.tweens.killTweensOf([this.announce, this.announceRibbon]);
    this.tweens.add({ duration: 320, ease: "Back.Out", scale: fit, targets: this.announce });
    this.tweens.add({ duration: 320, ease: "Back.Out", scale: 1, targets: this.announceRibbon });
    this.tweens.add({
      alpha: 0,
      delay: 3200,
      duration: 700,
      targets: [this.announce, this.announceRibbon],
    });
  }

  private updateFeed(): void {
    const { now } = this.time;
    for (const e of this.gs.drainFeed()) {
      if (e.kind === "notify") {
        this.showAnnounce(e.text, e.tone);
        continue;
      }
      // no running kill feed on phones — announces (the banner) still show
      if (this.compact) {
        continue;
      }
      const col = e.team === "radiant" ? "#7fdcff" : "#ff9a8a";
      const txt = e.killer ? `${e.killer}  ⚔  ${e.victim}` : `${e.victim} has fallen`;
      const line = this.add
        .text(0, 0, txt, {
          color: col,
          fontFamily: FONT,
          fontSize: "14px",
          stroke: "#1c1410",
          strokeThickness: 3,
        })
        .setOrigin(1, 0)
        .setDepth(44_000);
      this.feedLines.push({ text: line, until: now + 6500 });
    }
    this.feedLines = this.feedLines.filter((f) => {
      if (now > f.until) {
        f.text.destroy();
        return false;
      }
      return true;
    });
    const maxLines = this.compact ? 3 : 6;
    if (this.feedLines.length > maxLines) {
      for (const f of this.feedLines.splice(0, this.feedLines.length - maxLines)) {
        f.text.destroy();
      }
    }
    const rightX = this.scale.width - 16;
    // below the minimap when it's up top (and below the hint line on portrait phones)
    const hintPad = this.compact && this.scale.height > this.scale.width ? 52 : 18;
    const topY = this.mapY > 200 ? 88 : this.mapY + this.mapH + hintPad;
    for (const [i, f] of this.feedLines.entries()) {
      f.text.setPosition(rightX, topY + i * 20);
      f.text.setAlpha(Math.min(1, (f.until - now) / 1500));
    }
  }

  // ---- scoreboard (Tab) ----------------------------------------------------
  private buildBoard(): void {
    this.board = this.add.container(0, 0, []).setDepth(48_000).setVisible(false);
  }

  private toggleBoard(): void {
    this.boardOpen = !this.boardOpen;
    this.board.setVisible(this.boardOpen);
    if (this.boardOpen) {
      this.renderBoard();
    }
  }

  /** One scoreboard line; false when the unit carries no hero state to show. */
  private renderBoardRow(u: Unit, now: number, colX: number, colW: number, y: number): boolean {
    const h = u.hero;
    if (!h) {
      return false;
    }
    const def = HERO_BY_ID[h.defId];
    const dead = !u.alive;
    const name = `${def?.name ?? h.defId}  Lv${h.level}${h.isBot ? " (bot)" : ""}`;
    const status = dead && h.respawnAt > now ? `  ☠ ${Math.ceil((h.respawnAt - now) / 1000)}s` : "";
    this.board.add(
      this.add
        .text(colX, y, name + status, {
          color: dead ? "#9a8a70" : "#4a3320",
          fontFamily: FONT,
          fontSize: "13px",
        })
        .setOrigin(0, 0),
    );
    const net = Math.floor(h.gold);
    this.board.add(
      this.add
        .text(colX + colW, y, `${h.kills}/${h.deaths}/${h.assists}    🪙${net}`, {
          color: "#6b5530",
          fontFamily: FONT,
          fontSize: "12px",
        })
        .setOrigin(1, 0),
    );
    return true;
  }

  private renderBoard(): void {
    const w = this.gs?.worldRef;
    if (!w) {
      return;
    }
    this.board.removeAll(true);
    const W = this.scale.width;
    const H = this.scale.height;
    const panelW = Math.min(880, Math.max(340, W - 80));
    // A team column has to hold a hero name AND a right-aligned K/D/A + gold
    // block; below ~560px the two overprint, so the teams stack instead.
    const stacked = panelW < 560;
    const colW = stacked ? panelW - 48 : panelW / 2 - 54;
    const rowH = 24;

    const heroes = [...w.units.values()].filter((u) => u.kind === "hero" && u.hero);
    const teams: Team[] = ["radiant", "dire"];
    // sort() is safe here — filter() already produced a fresh array
    const rosters = teams.map((team) => ({
      list: heroes
        .filter((u) => u.team === team)
        .toSorted((a, b) => (b.hero?.gold ?? 0) - (a.hero?.gold ?? 0)),
      team,
    }));
    const blockH = rosters.map((r) => 26 + r.list.length * rowH);
    const bodyH = stacked ? blockH.reduce((sum, h) => sum + h, 0) + 14 : Math.max(...blockH, rowH);
    const panelH = 62 + bodyH + 42;

    // children are container-relative so the whole board can scale to fit phones
    this.board.setPosition(W / 2, H / 2);
    this.board.setScale(Math.min(1, (H - 24) / panelH, (W - 24) / panelW));
    this.board.add(this.add.nineslice(0, 0, "ui-carved9", 0, panelW, panelH, 20, 20, 20, 20));

    const teamKills = { dire: 0, radiant: 0 } satisfies Record<Team, number>;
    for (const u of heroes) {
      if (u.hero) {
        teamKills[u.team] += u.hero.kills;
      }
    }

    this.board.add(
      this.add
        .text(
          0,
          -panelH / 2 + 26,
          `SCOREBOARD     ☀ ${teamKills.radiant}  –  ${teamKills.dire} 🌙`,
          {
            color: "#4a3320",
            fontFamily: FONT,
            fontSize: "22px",
          },
        )
        .setOrigin(0.5),
    );

    const { now } = w;
    let stackY = -panelH / 2 + 62;
    for (const [ti, roster] of rosters.entries()) {
      const colX = stacked ? -panelW / 2 + 24 : -panelW / 2 + 34 + ti * (panelW / 2);
      const headColor = roster.team === "radiant" ? "#2a6f9e" : "#9e2f2a";
      let y = stacked ? stackY : -panelH / 2 + 62;
      this.board.add(
        this.add
          .text(colX, y, roster.team === "radiant" ? "RADIANT" : "DIRE", {
            color: headColor,
            fontFamily: FONT,
            fontSize: "16px",
          })
          .setOrigin(0, 0),
      );
      this.board.add(
        this.add
          .text(colX + colW, y, "K / D / A    Net", {
            color: "#7a6240",
            fontFamily: FONT,
            fontSize: "11px",
          })
          .setOrigin(1, 0),
      );
      y += 26;
      for (const u of roster.list) {
        if (this.renderBoardRow(u, now, colX, colW, y)) {
          y += rowH;
        }
      }
      stackY = y + 14;
    }
    this.board.add(
      this.add
        .text(0, panelH / 2 - 22, this.touchUi ? "tap SCORES to close" : "hold TAB to view", {
          color: "#9a8a70",
          fontFamily: FONT,
          fontSize: "11px",
        })
        .setOrigin(0.5),
    );
  }

  /** Responsive relayout. Desktop keeps the classic bottom bar; phones
   *  (`compact`) use the mobile-MOBA arc layout: minimap + one-line info strip
   *  across the top-left, HP/MP docked bottom-left, and a uniform-size ability
   *  arc bending around the dash button in the bottom-right corner. No space is
   *  reserved for the move stick — it floats and spawns wherever the touch is. */
  private layout(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const inset = safeAreaInset();
    const cx = W / 2;
    const compact = W < 760 || H < 520;
    const portraitOrient = H > W;
    this.compact = compact;

    this.layoutWidgetForms(compact);
    this.layoutMinimap(compact, W, H, inset);
    const { iy, left, stripX } = this.layoutInfo(compact, portraitOrient, inset);
    this.layoutUtilityButtons(compact, portraitOrient, left, stripX, iy);
    this.layoutScore(compact, portraitOrient, W, cx, inset);
    this.applyWidgetPositions(compact, this.layoutBars(compact, portraitOrient, W, H, cx, inset));

    if (this.shop) {
      this.shop.setPosition(cx, H / 2);
      this.shop.setScale(Math.min(1, (W - 20) / 430, (H - 20) / Math.max(1, this.shopPanelH)));
    }
    this.respawnText.setPosition(cx, H / 2 - 120);

    if (this.danger) {
      this.danger.setSize(W, H).setPosition(0, 0);
    }
    if (this.vignette) {
      this.vignette.setDisplaySize(W, H).setPosition(0, 0);
    }
  }

  /** Flip every dual-form widget to the mode's look (invisible = untappable,
   *  so only the live form receives input). */
  private layoutWidgetForms(compact: boolean): void {
    for (const s of this.slots) {
      s.panel.setVisible(!compact);
      s.box.setVisible(!compact);
      s.circle.setVisible(compact);
      if (compact) {
        s.cd.setVisible(false);
      } else {
        s.cdCircle.setVisible(false);
      }
      for (const pp of s.pips) {
        pp.setVisible(!compact);
      }
      s.keyLabel.setFontSize(compact ? 11 : 14);
      // 32px fits fully inside the r28 circle (half-diagonal 22.6) so the ring
      // stays visible around the square icon art
      s.icon.setDisplaySize(compact ? 32 : 50, compact ? 32 : 50);
    }
    this.dashPanel.setVisible(!compact);
    this.dashBox.setVisible(!compact);
    this.dashCircle.setVisible(compact);
    if (compact) {
      this.dashCd.setVisible(false);
    } else {
      this.dashCdCircle.setVisible(false);
    }
    let dashText = "F\ndash";
    if (compact) {
      dashText = "⚡";
    } else if (this.touchUi) {
      dashText = "⚡\ndash";
    }
    this.dashLabel.setText(dashText).setFontSize(compact ? 20 : 11);
    for (const s of this.itemSlots) {
      s.panel.setVisible(!compact);
      s.box.setVisible(!compact);
      // update() shows owned ones on compact
      s.circle.setVisible(false);
      if (compact) {
        s.icon.setVisible(false);
        s.key.setVisible(false);
      }
      s.icon.setDisplaySize(compact ? 26 : 30, compact ? 26 : 30);
    }
    if (this.barPanel) {
      this.barPanel.setVisible(!compact);
    }
  }

  /** Minimap: bottom-right on desktop, half-size top-LEFT on phones (the right
   *  edge belongs to the thumb arc). */
  private layoutMinimap(compact: boolean, W: number, H: number, inset: SafeAreaInset): void {
    const mapK = compact ? 0.5 : 1;
    this.mapW = Math.round(MINIMAP_SIZE * mapK);
    this.mapH = Math.round(MINIMAP_H * mapK);
    this.mapScale = this.mapW / WORLD.width;
    if (compact) {
      this.mapX = 14 + inset.left;
      this.mapY = 14 + inset.top;
    } else {
      this.mapX = W - this.mapW - 22;
      this.mapY = H - this.mapH - 22 - inset.bottom;
    }
    if (this.mapHit) {
      this.mapHit.setPosition(this.mapX, this.mapY).setScale(mapK);
    }
    if (this.mapFrame) {
      this.mapFrame
        .setPosition(this.mapX - 12, this.mapY - 12)
        .setSize(this.mapW + 24, this.mapH + 24);
    }
    this.drawMapTerrain();
    this.mapNextRedrawAt = 0;
  }

  /** Info: desktop = the classic top-left parchment panel; compact = a slim
   *  strip beside the minimap (one line landscape, two lines portrait). */
  private layoutInfo(compact: boolean, portraitOrient: boolean, inset: SafeAreaInset): InfoAnchors {
    const left = 8 + inset.left;
    const iy = 8 + inset.top;
    const stripX = this.mapX + this.mapW + 22;
    let goldSize = 18;
    if (compact) {
      goldSize = portraitOrient ? 12 : 13;
    }
    this.goldText.setFontSize(goldSize);
    this.clockText.setFontSize(compact ? 11 : 14);
    this.kdaText.setFontSize(compact ? 11 : 14);
    if (compact) {
      if (portraitOrient) {
        this.infoPanel.setPosition(stripX, iy).setSize(150, 40);
        this.goldText.setPosition(stripX + 10, iy + 5);
        this.clockText.setPosition(stripX + 84, iy + 7);
        this.kdaText.setPosition(stripX + 10, iy + 23);
      } else {
        this.infoPanel.setPosition(stripX, iy).setSize(220, 30);
        this.goldText.setPosition(stripX + 12, iy + 6);
        this.clockText.setPosition(stripX + 80, iy + 8);
        this.kdaText.setPosition(stripX + 134, iy + 8);
      }
    } else {
      this.infoPanel.setPosition(left, iy).setSize(226, 112);
      this.goldText.setPosition(left + 16, iy + 12);
      this.clockText.setPosition(left + 16, iy + 38);
      this.kdaText.setPosition(left + 16, iy + 60);
    }
    this.apText.setPosition(left + 16, iy + 82).setVisible(!compact);
    return { iy, left, stripX };
  }

  /** Utility buttons: glyph roundels under the info strip on compact, the
   *  classic word-pill column under the info panel on desktop. */
  private layoutUtilityButtons(
    compact: boolean,
    portraitOrient: boolean,
    left: number,
    stripX: number,
    iy: number,
  ): void {
    for (const [i, b] of this.uiButtons.entries()) {
      b.bg.setVisible(!compact);
      b.img.setVisible(compact);
      b.txt.setText(compact ? b.glyph : b.word).setFontSize(compact ? 17 : 13);
      if (compact) {
        const bx = stripX + 20 + i * 46;
        const by = iy + (portraitOrient ? 62 : 52);
        b.img.setPosition(bx, by);
        b.txt.setPosition(bx, by - 1);
      } else {
        const bx = left + 46;
        const by = iy + 136 + i * 54;
        b.bg.setPosition(bx, by);
        b.txt.setPosition(bx, by - 3);
      }
    }
  }

  /** Score: top-center ribbon on desktop; a small capsule on compact
   *  (top-center landscape, tucked top-right on portrait where the strip ends). */
  private layoutScore(
    compact: boolean,
    portraitOrient: boolean,
    W: number,
    cx: number,
    inset: SafeAreaInset,
  ): void {
    this.scoreRibbon.setVisible(!compact);
    this.scorePanel.setVisible(compact);
    let scoreSize = 20;
    if (compact) {
      scoreSize = portraitOrient ? 11 : 13;
    }
    this.teamScore.setFontSize(scoreSize);
    if (compact) {
      const sx = portraitOrient ? W - 54 - inset.right : cx;
      this.scorePanel
        .setPosition(sx, 6 + inset.top)
        .setDisplaySize(portraitOrient ? 64 : 84, portraitOrient ? 24 : 28);
      this.teamScore.setPosition(sx, (portraitOrient ? 11 : 12) + inset.top);
    } else {
      this.scoreRibbon.setPosition(cx, 4).setSize(252, 60);
      this.teamScore.setPosition(cx, 18);
    }
  }

  /** HP/MP bars and portrait, plus the ability/dash/item anchor points. */
  private layoutBars(
    compact: boolean,
    portraitOrient: boolean,
    W: number,
    H: number,
    cx: number,
    inset: SafeAreaInset,
  ): BarLayout {
    const slotPos: Point[] = [];
    const itemPos: Point[] = [];
    let dashPos: Point = { x: 0, y: 0 };
    if (compact) {
      // bars: docked bottom-LEFT (the floating stick is invisible and spawns
      // at the touch point, so nothing is displaced by it)
      const bLeft = 14 + inset.left;
      const bBot = H - 14 - inset.bottom;
      this.barW = portraitOrient ? 150 : 170;
      this.portraitSize = 34;
      this.portrait.setPosition(bLeft + 17, bBot - 22).setDisplaySize(34, 34);
      this.lvlText.setPosition(bLeft + 17, bBot - 10).setFontSize(12);
      const barX = bLeft + 42;
      this.hpBar.setPosition(barX, bBot - 28);
      this.hpBar.height = 11;
      this.mpBar.setPosition(barX, bBot - 12);
      this.mpBar.height = 7;
      this.hpText.setPosition(barX + this.barW / 2, bBot - 28).setFontSize(11);
      this.mpText.setPosition(barX + this.barW / 2, bBot - 12).setFontSize(10);

      // ability arc: dash anchors the corner, Q/W/E/R fan on a quarter-arc
      const ax = W - 40 - inset.right;
      const ay = H - 40 - inset.bottom;
      const arcRadius = portraitOrient ? 100 : 112;
      dashPos = { x: ax, y: ay };
      for (let i = 0; i < this.slots.length; i += 1) {
        const phi = (ARC_START_DEG + (i * ARC_SPAN_DEG) / (this.slots.length - 1)) * DEG;
        slotPos.push({ x: ax - arcRadius * Math.sin(phi), y: ay - arcRadius * Math.cos(phi) });
      }
      // owned item chips: a column rising from just above the arc (update()
      // assigns positions because ownership changes mid-match)
      this.itemColX = ax - 6;
      this.itemColY = ay - arcRadius - 54;
    } else {
      const baseY = H - 50;
      this.barW = 200;
      this.portraitSize = 74;
      if (this.barPanel) {
        this.barPanel.setPosition(cx - 104, baseY).setSize(this.barW + 130, 86);
      }
      this.portrait.setPosition(cx - 220, baseY).setDisplaySize(74, 74);
      this.lvlText.setPosition(cx - 220, baseY + 22).setFontSize(20);

      const barX = cx - 175;
      this.hpBar.setPosition(barX, baseY - 14);
      this.hpBar.height = 16;
      this.mpBar.setPosition(barX, baseY + 6);
      this.mpBar.height = 10;
      this.hpText.setPosition(barX + this.barW / 2, baseY - 14).setFontSize(12);
      this.mpText.setPosition(barX + this.barW / 2, baseY + 6).setFontSize(11);

      const startX = cx + 60;
      dashPos = { x: startX - 64, y: baseY };
      for (let i = 0; i < this.slots.length; i += 1) {
        slotPos.push({ x: startX + i * 66, y: baseY });
      }
      // inventory slots: a 3x2 grid to the right of the ability bar
      const itemX0 = startX + KEYS.length * 66 + 24;
      for (let i = 0; i < this.itemSlots.length; i += 1) {
        itemPos.push({ x: itemX0 + (i % 3) * 42, y: baseY - 20 + Math.floor(i / 3) * 42 });
      }
    }
    return { dashPos, itemPos, slotPos };
  }

  private applyWidgetPositions(compact: boolean, bars: BarLayout): void {
    const { dashPos, itemPos, slotPos } = bars;
    if (this.dashBox) {
      this.dashPanel.setPosition(dashPos.x, dashPos.y);
      this.dashBox.setPosition(dashPos.x, dashPos.y);
      this.dashCircle.setPosition(dashPos.x, dashPos.y);
      this.dashCdCircle.setPosition(dashPos.x, dashPos.y);
      this.dashLabel.setPosition(dashPos.x, dashPos.y);
      this.dashCd.setPosition(dashPos.x, dashPos.y + 29);
    }
    for (const [i, s] of this.slots.entries()) {
      const p = slotPos[i];
      if (!p) {
        continue;
      }
      s.panel.setPosition(p.x, p.y);
      s.box.setPosition(p.x, p.y);
      s.circle.setPosition(p.x, p.y);
      s.cdCircle.setPosition(p.x, p.y);
      s.icon.setPosition(p.x, p.y);
      s.cd.setPosition(p.x, p.y + 29);
      s.cdText.setPosition(p.x, p.y);
      s.keyLabel.setPosition(p.x - (compact ? 17 : 26), p.y - (compact ? 26 : 27));
      s.plus.setPosition(p.x + (compact ? 17 : 22), p.y - (compact ? 24 : 28));
      for (const [j, pp] of s.pips.entries()) {
        pp.setPosition(p.x - 16 + j * 11, p.y + 22);
      }
    }
    // compact item chips are positioned by update() (owned-only column)
    for (const [i, s] of this.itemSlots.entries()) {
      const p = itemPos[i];
      if (!p) {
        continue;
      }
      s.panel.setPosition(p.x, p.y);
      s.box.setPosition(p.x, p.y);
      s.icon.setPosition(p.x, p.y);
      s.key.setPosition(p.x - 13, p.y - 13);
    }
  }

  override update(): void {
    // auto-close the shop if the player dies while it's open, so uiBlocking can't
    // strand a freshly-respawned hero frozen.
    if (this.shopOpen && !this.gs?.player?.alive) {
      this.toggleShop();
    }
    this.pollPad();
    // minimap / feed / scoreboard run even while the player is dead or unspawned
    this.updateMinimap();
    this.updateFeed();
    // scoreboard refreshes at 4Hz, not per frame — renderBoard rebuilds every
    // Text object, which is far too much churn to run at 60fps while Tab is held
    if (this.boardOpen && this.time.now >= this.boardNextRenderAt) {
      this.boardNextRenderAt = this.time.now + 250;
      this.renderBoard();
    }
    this.updateTeamScore();
    this.updateDangerPulse();

    const me = this.gs?.player;
    const world = this.gs?.worldRef;
    if (!me || !world || !me.hero) {
      return;
    }
    const h = me.hero;
    this.updateInfoText(h, world);
    this.updateDashCooldown(h, world);
    this.updatePortraitAndBars(me, h);
    this.updateAbilitySlots(me, h, world);
    this.updateItemSlots(h, world);
    this.updateShopAffordability(h);
    this.updateRespawnOverlay(me, h, world);
  }

  private updateTeamScore(): void {
    const wRef = this.gs?.worldRef;
    if (!wRef || !this.teamScore) {
      return;
    }
    let rk = 0;
    let dk = 0;
    for (const u of wRef.units.values()) {
      if (u.kind !== "hero" || !u.hero) {
        continue;
      }
      if (u.team === "radiant") {
        rk += u.hero.kills;
      } else {
        dk += u.hero.kills;
      }
    }
    this.teamScore.setText(`☀ ${rk}   –   ${dk} 🌙`);
  }

  /** Low-HP danger pulse. */
  private updateDangerPulse(): void {
    if (!this.danger) {
      return;
    }
    const p = this.gs?.player;
    const pct = p && p.alive && p.maxHp > 0 ? p.hp / p.maxHp : 1;
    this.danger.setAlpha(
      pct < 0.3 ? 0.18 * (1 - pct / 0.3) * (0.55 + 0.45 * Math.sin(this.time.now / 170)) : 0,
    );
  }

  private updateInfoText(h: HeroState, world: World): void {
    this.goldText.setText(`🪙 ${Math.floor(h.gold)}`);
    const mins = Math.floor(world.gameTime / 60);
    const secs = Math.floor(world.gameTime % 60);
    this.clockText.setText(`⏱ ${mins}:${secs.toString().padStart(2, "0")}`);
    // One label + a slashed triple: at 11px the display font collapses spaces
    // and its zero is an O, so per-stat letters read as the word "KODOAO".
    this.kdaText.setText(
      this.compact
        ? `KDA ${h.kills}/${h.deaths}/${h.assists}`
        : `K ${h.kills}  D ${h.deaths}  A ${h.assists}  ·  LH ${h.lastHits}`,
    );
    this.apText.setText(
      h.abilityPoints > 0
        ? `▲ ${h.abilityPoints} ability point${h.abilityPoints > 1 ? "s" : ""} ${
            this.touchUi ? "(tap +)" : "(Shift+Q/W/E/R)"
          }`
        : "",
    );
  }

  /** Dash (F) cooldown (5s). */
  private updateDashCooldown(h: HeroState, world: World): void {
    if (!this.dashCd) {
      return;
    }
    const left = Math.max(0, (h.dashReadyAt - world.now) / 1000);
    const cooling = left > 0.05;
    if (this.compact) {
      this.dashCd.setVisible(false);
      this.dashCdCircle.setVisible(cooling);
      this.dashCircle.setStrokeStyle(2, cooling ? 0x8a_73_50 : 0x4a_90_d9);
    } else {
      this.dashCdCircle.setVisible(false);
      this.dashCd.setVisible(cooling);
      this.dashCd.height = 58 * Math.min(1, left / 5);
      this.dashBox.setStrokeStyle(2, cooling ? 0x8a_73_50 : 0x4a_90_d9);
    }
  }

  private updatePortraitAndBars(me: Unit, h: HeroState): void {
    const tex = heroSheetTex(h.defId, me.team);
    if (this.portrait.texture.key !== tex && this.textures.exists(tex)) {
      this.portrait.setTexture(tex, 0).setDisplaySize(this.portraitSize, this.portraitSize);
    }
    this.lvlText.setText(`${h.level}`);

    const hpPct = Math.max(0, me.hp / me.maxHp);
    const mpPct = Math.max(0, me.mp / Math.max(1, me.maxMp));
    this.hpBar.width = this.barW * hpPct;
    this.mpBar.width = this.barW * mpPct;
    this.hpText.setText(`${Math.ceil(Math.max(0, me.hp))} / ${Math.round(me.maxHp)}`);
    this.mpText.setText(`${Math.ceil(Math.max(0, me.mp))} / ${Math.round(me.maxMp)}`);
  }

  private updateAbilitySlots(me: Unit, h: HeroState, world: World): void {
    const def = HERO_BY_ID[h.defId];
    for (const s of this.slots) {
      const ad = def?.abilities[s.key];
      const slot = h.abilities[s.key];
      if (!ad) {
        continue;
      }
      const { rank } = slot;
      // tappable level-up badge while points are banked (touch/guest path)
      s.plus.setVisible(me.alive && h.abilityPoints > 0 && rank < ad.maxRank);
      this.syncAbilityIcon(s, ad);
      for (const [j, p] of s.pips.entries()) {
        p.setFillStyle(j < rank ? 0xff_e1_4a : 0x39_45_6a);
      }
      const cdLeft = Math.max(0, (slot.readyAt - world.now) / 1000);
      const cdTotal = rank > 0 ? valAt(ad.cooldown, rank) : 1;
      this.applyAbilitySlotState(s, ad, me, rank, cdLeft, cdTotal);
    }
  }

  /** Ability spell icon (set once per hero). */
  private syncAbilityIcon(s: Slot, ad: AbilityDef): void {
    const iconFrame = abilityIconFrame(ad.effect);
    if (iconFrame === null || !this.textures.exists("spell-icons")) {
      return;
    }
    if (s.iconFrame !== iconFrame) {
      s.iconFrame = iconFrame;
      const sz = this.compact ? 32 : 50;
      s.icon.setTexture("spell-icons", iconFrame).setDisplaySize(sz, sz);
    }
    s.icon.setVisible(true);
  }

  /** Cooldown/mana veil and border for one ability slot. */
  private applyAbilitySlotState(
    s: Slot,
    ad: AbilityDef,
    me: Unit,
    rank: number,
    cdLeft: number,
    cdTotal: number,
  ): void {
    // one veil per form: the desktop rect drains bottom-up, the compact
    // circle just dims the whole button (no drain on phones)
    const veil = (on: boolean, frac: number, color: number, alpha: number): void => {
      if (this.compact) {
        s.cd.setVisible(false);
        s.cdCircle.setVisible(on).setFillStyle(color, alpha);
      } else {
        s.cdCircle.setVisible(false);
        s.cd.setVisible(on).setFillStyle(color, on ? alpha : 0);
        s.cd.height = 58 * frac;
      }
    };
    const stroke = (w: number, color: number): void => {
      s.box.setStrokeStyle(w, color);
      s.circle.setStrokeStyle(w, color);
    };
    if (rank <= 0) {
      veil(true, 1, 0x00_00_00, 0.6);
      s.cdText.setText("");
      // unlearned
      s.icon.setAlpha(0.32);
      stroke(2, 0x6b_55_30);
    } else if (cdLeft > 0.05) {
      veil(true, Math.min(1, cdLeft / cdTotal), 0x00_00_00, 0.6);
      s.cdText.setText(cdLeft >= 1 ? `${Math.ceil(cdLeft)}` : "");
      // on cooldown
      s.icon.setAlpha(0.4);
      stroke(2, 0x8a_73_50);
    } else {
      const manaOk = me.mp >= valAt(ad.manaCost, rank);
      veil(!manaOk, manaOk ? 0 : 1, 0x1a_3a_6a, 0.5);
      s.cdText.setText("");
      // ready / no mana
      s.icon.setAlpha(manaOk ? 1 : 0.6);
      stroke(manaOk ? 3 : 2, manaOk ? 0x3f_9e_4d : 0x8a_73_50);
    }
  }

  /** Inventory slots. Compact shows owned items only, packed into a column
   *  above the ability arc — position here because ownership changes mid-match. */
  private updateItemSlots(h: HeroState, world: World): void {
    let ownedRank = 0;
    for (const [i, s] of this.itemSlots.entries()) {
      const id = h.items[i];
      if (id) {
        const it = ITEM_BY_ID[id];
        s.icon.setVisible(true).setTexture("ui-icons", it?.icon ?? 0);
        const ready = (h.itemActiveReadyAt[id] ?? 0) <= world.now;
        const strokeColor = itemStrokeColor(it?.active !== undefined, ready);
        s.box.setStrokeStyle(2, strokeColor);
        s.circle.setStrokeStyle(2, strokeColor);
        s.key.setVisible(!this.compact && it?.active !== undefined);
        if (this.compact) {
          const iy = this.itemColY - ownedRank * 44;
          s.circle.setVisible(true).setPosition(this.itemColX, iy);
          s.icon.setPosition(this.itemColX, iy).setDisplaySize(26, 26);
          ownedRank += 1;
        }
      } else {
        s.icon.setVisible(false);
        s.box.setStrokeStyle(2, 0x8a_73_50);
        s.key.setVisible(false);
        if (this.compact) {
          s.circle.setVisible(false);
        }
      }
    }
  }

  private updateShopAffordability(h: HeroState): void {
    if (!this.shopOpen) {
      return;
    }
    for (const r of this.shopRows) {
      const it = ITEM_BY_ID[r.id];
      const owned = h.items.includes(r.id);
      const afford = h.gold >= (it?.cost ?? 0);
      r.cost.setColor(shopCostColor(owned, afford));
      r.cost.setText(owned ? "OWNED" : `${it?.cost}`);
    }
  }

  private updateRespawnOverlay(me: Unit, h: HeroState, world: World): void {
    if (!me.alive && h.respawnAt > 0) {
      const left = Math.ceil((h.respawnAt - world.now) / 1000);
      this.respawnText.setVisible(true).setText(`Respawning in ${left}s`);
    } else {
      this.respawnText.setVisible(false);
    }
  }
}
