import Phaser from "phaser";

import { XP_CURVE } from "../data/config";
import type { Team } from "../data/config";
import { HERO_BY_ID, valAt } from "../data/heroes";
import type { AbilityKey } from "../data/heroes";
import { ITEMS, ITEM_BY_ID } from "../data/items";
import { BRIDGES, GRID, WORLD, isHighCell, isLandCell } from "../data/map";
import { FONT } from "../render/font";
import { heroSheetTex } from "../render/sprites";
import { SLOT_LABEL } from "./GameScene";
import type { GameScene } from "./GameScene";

const KEYS: AbilityKey[] = ["Q", "W", "E", "R"];
const MINIMAP_SIZE = 232;
const MINIMAP_H = Math.round(MINIMAP_SIZE * (WORLD.height / WORLD.width));

type Slot = {
  key: AbilityKey;
  panel: Phaser.GameObjects.Image; // carved backdrop; `box` on top carries the state stroke
  box: Phaser.GameObjects.Rectangle;
  icon: Phaser.GameObjects.Image;
  cd: Phaser.GameObjects.Rectangle;
  cdText: Phaser.GameObjects.Text;
  pips: Phaser.GameObjects.Rectangle[];
  keyLabel: Phaser.GameObjects.Text;
};

export class HudScene extends Phaser.Scene {
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
  private hintText!: Phaser.GameObjects.Text;
  private barW = 200;
  private infoPanel!: Phaser.GameObjects.NineSlice;
  private barPanel!: Phaser.GameObjects.NineSlice;
  private dashPanel!: Phaser.GameObjects.Image;
  private scoreRibbon!: Phaser.GameObjects.NineSlice;
  private announceRibbon!: Phaser.GameObjects.NineSlice;
  private mapFrame!: Phaser.GameObjects.NineSlice;
  private itemSlots: { panel: Phaser.GameObjects.Image; box: Phaser.GameObjects.Rectangle; icon: Phaser.GameObjects.Image; key: Phaser.GameObjects.Text }[] = [];
  private shop!: Phaser.GameObjects.Container;
  private shopRows: { id: string; box: Phaser.GameObjects.Rectangle; cost: Phaser.GameObjects.Text }[] = [];
  private shopOpen = false;
  private shopSel = 0;

  // minimap
  private mapTerrain!: Phaser.GameObjects.Graphics; // static land/water/bridges, drawn once per layout
  private mapGfx!: Phaser.GameObjects.Graphics;
  private mapHit!: Phaser.GameObjects.Rectangle;
  private mapX = 0;
  private mapY = 0;
  private mapScale = MINIMAP_SIZE / WORLD.width;

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

  // dash (F) cooldown indicator
  private dashBox!: Phaser.GameObjects.Rectangle;
  private dashCd!: Phaser.GameObjects.Rectangle;
  private dashLabel!: Phaser.GameObjects.Text;

  constructor() {
    super("Hud");
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
    this.shopOpen = false;
    this.boardOpen = false;
    this.boardNextRenderAt = 0;

    this.scale.on(Phaser.Scale.Events.RESIZE, this.layout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.scale.off(Phaser.Scale.Events.RESIZE, this.layout, this));
    this.danger = this.add.rectangle(0, 0, this.scale.width, this.scale.height, 0xff2a2a, 0).setOrigin(0, 0).setScrollFactor(0).setDepth(43000);
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
      if (this.boardOpen) this.toggleBoard();
    });
    this.input.keyboard?.on("keydown-ESC", () => {
      if (this.shopOpen) this.toggleShop();
      if (this.boardOpen) this.toggleBoard();
    });
  }

  private moveShopSel(d: number): void {
    const n = this.shopRows.length;
    if (n === 0) return;
    this.shopSel = (this.shopSel + d + n) % n;
    this.updateShopSelection();
  }

  private updateShopSelection(): void {
    this.shopRows.forEach((r, i) => r.box.setStrokeStyle(i === this.shopSel ? 3 : 1, i === this.shopSel ? 0xc9941e : 0xb89868));
  }

  private buySelected(): void {
    const r = this.shopRows[this.shopSel];
    if (!r) return;
    this.flashRow(r.box, this.gs.buyItemForPlayer(r.id) ? 0x2a6f3a : 0x6f2a2a);
  }

  private build(): void {
    // top-left info on a carved parchment panel
    this.infoPanel = this.add.nineslice(8, 8, "ui-carved9", 0, 226, 112, 20, 20, 20, 20).setOrigin(0, 0).setDepth(-1);
    this.goldText = this.add.text(24, 20, "", { fontFamily: FONT, fontSize: "18px", color: "#8a6510" });
    this.clockText = this.add.text(24, 46, "", { fontFamily: FONT, fontSize: "14px", color: "#5a4630" });
    this.kdaText = this.add.text(24, 68, "", { fontFamily: FONT, fontSize: "14px", color: "#5a4630" });
    this.apText = this.add.text(24, 90, "", { fontFamily: FONT, fontSize: "14px", color: "#9c2f2f" });

    // center bottom: portrait + bars + abilities (positioned in layout)
    this.barPanel = this.add.nineslice(0, 0, "ui-carved3", 0, this.barW + 120, 64, 24, 24, 18, 18).setDepth(-1);
    this.portrait = this.add.image(0, 0, "ui-panel").setDisplaySize(74, 74);
    this.lvlText = this.add.text(0, 0, "1", { fontFamily: FONT, fontSize: "20px", color: "#ffe14a", stroke: "#1c1410", strokeThickness: 4 }).setOrigin(0.5);

    this.add.existing(this.portrait);
    this.hpBar = this.add.rectangle(0, 0, this.barW, 16, 0x44d07a).setOrigin(0, 0.5);
    this.mpBar = this.add.rectangle(0, 0, this.barW, 10, 0x4a8fff).setOrigin(0, 0.5);
    this.hpText = this.add.text(0, 0, "", { fontFamily: FONT, fontSize: "12px", color: "#ffffff", stroke: "#1c2a20", strokeThickness: 3 }).setOrigin(0.5);
    this.mpText = this.add.text(0, 0, "", { fontFamily: FONT, fontSize: "11px", color: "#ffffff", stroke: "#1c2030", strokeThickness: 3 }).setOrigin(0.5);

    for (const key of KEYS) {
      const panel = this.add.image(0, 0, "ui-panel").setDisplaySize(62, 62);
      const box = this.add.rectangle(0, 0, 58, 58, 0x1c1410, 0.12).setStrokeStyle(2, 0x8a7350).setInteractive({ useHandCursor: true });
      // abilities read as big carved keycaps — the letter IS the icon
      const icon = this.add.image(0, 0, "ui-icon-01").setDisplaySize(46, 46).setVisible(false);
      const keyLabel = this.add.text(0, 0, SLOT_LABEL[key], { fontFamily: FONT, fontSize: "28px", color: "#4a3320", stroke: "#e8d8b0", strokeThickness: 3 }).setOrigin(0.5);
      const cd = this.add.rectangle(0, 0, 58, 58, 0x000000, 0.6).setOrigin(0.5, 1);
      const cdText = this.add.text(0, 0, "", { fontFamily: FONT, fontSize: "20px", color: "#fff", stroke: "#1c1410", strokeThickness: 4 }).setOrigin(0.5);
      const pips = [0, 1, 2, 3].map(() => this.add.rectangle(0, 0, 10, 4, 0x8a7350));
      box.on("pointerdown", () => this.gs.castSlot(key));
      this.slots.push({ key, panel, box, icon, cd, cdText, pips, keyLabel });
    }

    // dash (F) cooldown indicator, sits just left of the ability bar
    this.dashPanel = this.add.image(0, 0, "ui-panel").setDisplaySize(54, 62);
    this.dashBox = this.add.rectangle(0, 0, 50, 58, 0x1c1410, 0.12).setStrokeStyle(2, 0x6ab0ff);
    this.dashLabel = this.add.text(0, 0, "F\ndash", { fontFamily: FONT, fontSize: "11px", color: "#3a5a78", align: "center", lineSpacing: 2 }).setOrigin(0.5);
    this.dashCd = this.add.rectangle(0, 0, 50, 58, 0x000000, 0.62).setOrigin(0.5, 1);

    // inventory slots (1..6)
    for (let i = 0; i < 6; i++) {
      const panel = this.add.image(0, 0, "ui-panel").setDisplaySize(42, 42);
      const box = this.add.rectangle(0, 0, 38, 38, 0x1c1410, 0.12).setStrokeStyle(2, 0x8a7350).setInteractive({ useHandCursor: true });
      const icon = this.add.image(0, 0, "ui-icon-01").setDisplaySize(30, 30).setVisible(false);
      const key = this.add.text(0, 0, `${i + 1}`, { fontFamily: FONT, fontSize: "10px", color: "#6b5530" }).setOrigin(0.5);
      box.on("pointerdown", () => this.gs.useItemForPlayer(i));
      this.itemSlots.push({ panel, box, icon, key });
    }

    this.respawnText = this.add.text(0, 0, "", { fontFamily: FONT, fontSize: "42px", color: "#ff6a5a", stroke: "#1c1410", strokeThickness: 7 }).setOrigin(0.5).setVisible(false);
    this.hintText = this.add.text(0, 0, "Arrows move · Space attack · Q W E R abilities · F dash · 1-6 items · B shop · Tab scores", { fontFamily: FONT, fontSize: "13px", color: "#f4eee0", stroke: "#27343c", strokeThickness: 3 }).setOrigin(0.5);
  }

  private buildShop(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const panelW = 430;
    const panelH = 92 + ITEMS.length * 46;
    const bg = this.add.nineslice(0, 0, "ui-carved9", 0, panelW, panelH, 20, 20, 20, 20);
    const title = this.add.text(0, -panelH / 2 + 26, "SHOP", { fontFamily: FONT, fontSize: "24px", color: "#4a3320" }).setOrigin(0.5);
    const sub = this.add.text(0, -panelH / 2 + 52, "↑↓ select · Enter buy · B close (must be at base)", { fontFamily: FONT, fontSize: "12px", color: "#7a6240" }).setOrigin(0.5);
    const children: Phaser.GameObjects.GameObject[] = [bg, title, sub];
    ITEMS.forEach((it, i) => {
      const y = -panelH / 2 + 84 + i * 46;
      const row = this.add.rectangle(0, y, panelW - 36, 40, 0x4a3320, 0.08).setStrokeStyle(1, 0xb89868).setInteractive({ useHandCursor: true });
      const icon = this.add.image(-panelW / 2 + 36, y, it.icon).setDisplaySize(30, 30);
      const name = this.add.text(-panelW / 2 + 60, y - 8, it.name, { fontFamily: FONT, fontSize: "13px", color: "#4a3320" }).setOrigin(0, 0.5);
      const desc = this.add.text(-panelW / 2 + 60, y + 9, it.desc, { fontFamily: FONT, fontSize: "9px", color: "#7a6240", wordWrap: { width: panelW - 160 } }).setOrigin(0, 0.5);
      const cost = this.add.text(panelW / 2 - 26, y, `🪙${it.cost}`, { fontFamily: FONT, fontSize: "13px", color: "#8a6510" }).setOrigin(1, 0.5);
      row.on("pointerdown", () => {
        if (this.gs.buyItemForPlayer(it.id)) this.flashRow(row, 0x2a6f3a);
        else this.flashRow(row, 0x6f2a2a);
      });
      this.shopRows.push({ id: it.id, box: row, cost });
      children.push(row, icon, name, desc, cost);
    });
    this.shop = this.add.container(W / 2, H / 2, children).setDepth(50000).setVisible(false);
  }

  private flashRow(row: Phaser.GameObjects.Rectangle, color: number): void {
    row.setFillStyle(color, 0.5);
    this.time.delayedCall(140, () => row.setFillStyle(0x4a3320, 0.08));
  }

  private toggleShop(): void {
    this.shopOpen = !this.shopOpen;
    this.shop.setVisible(this.shopOpen);
    this.gs.uiBlocking = this.shopOpen; // pause hero input so arrows drive the shop
    if (this.shopOpen) {
      this.shopSel = 0;
      this.updateShopSelection();
    } else {
      this.shopRows.forEach((r) => r.box.setStrokeStyle(1, 0xb89868));
    }
  }

  // ---- minimap -------------------------------------------------------------
  private buildMinimap(): void {
    this.mapFrame = this.add.nineslice(0, 0, "ui-carved9", 0, MINIMAP_SIZE + 28, MINIMAP_H + 28, 20, 20, 20, 20).setOrigin(0, 0).setDepth(39998);
    this.mapTerrain = this.add.graphics().setDepth(39999);
    this.mapGfx = this.add.graphics().setDepth(40000);
    this.mapHit = this.add
      .rectangle(0, 0, MINIMAP_SIZE, MINIMAP_H, 0x000000, 0.001)
      .setOrigin(0, 0)
      .setDepth(40002)
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
    if (!this.mapTerrain) return;
    const g = this.mapTerrain;
    const ox = this.mapX;
    const oy = this.mapY;
    const cell = (WORLD.width / GRID.cols) * this.mapScale;
    g.clear();
    g.fillStyle(0x2e8f8a, 1).fillRect(ox, oy, MINIMAP_SIZE, MINIMAP_H);
    g.lineStyle(2, 0x3a2c20, 0.8).strokeRect(ox, oy, MINIMAP_SIZE, MINIMAP_H);
    for (let cy = 0; cy < GRID.rows; cy++) {
      for (let cx = 0; cx < GRID.cols; cx++) {
        if (!isLandCell(cx, cy)) continue;
        g.fillStyle(isHighCell(cx, cy) ? 0x4a7c34 : 0x5d9141, 1);
        g.fillRect(ox + cx * cell, oy + cy * cell, cell + 0.5, cell + 0.5);
      }
    }
    g.fillStyle(0x9a6a3a, 1);
    for (const b of BRIDGES) {
      g.fillRect(ox + b.x0 * cell, oy + b.y0 * cell, (b.x1 - b.x0 + 1) * cell, (b.y1 - b.y0 + 1) * cell);
    }
  }

  private updateMinimap(): void {
    const w = this.gs?.worldRef;
    if (!w) return;
    const g = this.mapGfx;
    const ox = this.mapX;
    const oy = this.mapY;
    const sc = this.mapScale;
    const tx = (x: number) => ox + x * sc;
    const ty = (y: number) => oy + y * sc;
    g.clear();
    for (const u of w.units.values()) {
      if (!u.alive) continue;
      if (u.kind === "structure") {
        const col = u.team === "radiant" ? 0x4fa3ff : 0xff5a4a;
        const sz = u.structure?.tier === "ancient" ? 6 : 3.5;
        g.fillStyle(col, 1).fillRect(tx(u.x) - sz / 2, ty(u.y) - sz / 2, sz, sz);
      } else if (u.kind === "creep") {
        const col = u.neutral ? 0xe0a93a : u.team === "radiant" ? 0x46c074 : 0xe06a6a;
        g.fillStyle(col, 0.9).fillRect(tx(u.x) - 1, ty(u.y) - 1, 2, 2);
      }
    }
    // heroes on top
    const meId = this.gs.player?.id;
    for (const u of w.units.values()) {
      if (!u.alive || u.kind !== "hero") continue;
      const isMe = u.id === meId;
      const col = isMe ? 0xffe14a : u.team === "radiant" ? 0x7fdcff : 0xff9a8a;
      g.fillStyle(col, 1).fillCircle(tx(u.x), ty(u.y), isMe ? 4 : 3);
      g.lineStyle(1, 0x05080e, 1).strokeCircle(tx(u.x), ty(u.y), isMe ? 4 : 3);
    }
    // camera viewport box
    const v = this.gs.cameraView;
    g.lineStyle(1.5, 0xffffff, 0.7).strokeRect(tx(v.x), ty(v.y), v.width * sc, v.height * sc);
  }

  // ---- kill feed + announcements -------------------------------------------
  private buildFeed(): void {
    this.scoreRibbon = this.add.nineslice(0, 0, "ui-ribbon-yellow", 0, 252, 60, 58, 58, 22, 22).setOrigin(0.5, 0).setDepth(39990);
    this.teamScore = this.add.text(0, 0, "", { fontFamily: FONT, fontSize: "20px", color: "#5a3a10" }).setOrigin(0.5, 0).setDepth(40000);
    this.announceRibbon = this.add.nineslice(0, 0, "ui-ribbon-blue", 0, 560, 76, 58, 58, 22, 22).setOrigin(0.5).setDepth(45990).setAlpha(0);
    this.announce = this.add.text(0, 0, "", { fontFamily: FONT, fontSize: "26px", color: "#ffe6a3", stroke: "#1e2a3a", strokeThickness: 5, align: "center" }).setOrigin(0.5).setDepth(46000).setAlpha(0);
  }

  private showAnnounce(text: string, tone: "good" | "bad" | "neutral"): void {
    const color = tone === "good" ? "#9bf0b4" : tone === "bad" ? "#ffb0a4" : "#fff3c4";
    const cx = this.scale.width / 2;
    const cy = this.scale.height * 0.26;
    this.announce.setText(text).setColor(color).setAlpha(1).setScale(0.6);
    this.announce.setPosition(cx, cy - 4);
    this.announceRibbon.setPosition(cx, cy).setAlpha(1).setScale(0.6);
    this.announceRibbon.setSize(Math.max(380, this.announce.width + 150), 76);
    this.tweens.killTweensOf([this.announce, this.announceRibbon]);
    this.tweens.add({ targets: [this.announce, this.announceRibbon], scale: 1, duration: 320, ease: "Back.Out" });
    this.tweens.add({ targets: [this.announce, this.announceRibbon], alpha: 0, delay: 3200, duration: 700 });
  }

  private updateFeed(): void {
    const now = this.time.now;
    for (const e of this.gs.drainFeed()) {
      if (e.kind === "notify") {
        this.showAnnounce(e.text, e.tone);
        continue;
      }
      const col = e.team === "radiant" ? "#7fdcff" : "#ff9a8a";
      const txt = e.killer ? `${e.killer}  ⚔  ${e.victim}` : `${e.victim} has fallen`;
      const line = this.add.text(0, 0, txt, { fontFamily: FONT, fontSize: "14px", color: col, stroke: "#1c1410", strokeThickness: 3 }).setOrigin(1, 0).setDepth(44000);
      this.feedLines.push({ text: line, until: now + 6500 });
    }
    this.feedLines = this.feedLines.filter((f) => {
      if (now > f.until) {
        f.text.destroy();
        return false;
      }
      return true;
    });
    if (this.feedLines.length > 6) this.feedLines.splice(0, this.feedLines.length - 6).forEach((f) => f.text.destroy());
    const rightX = this.scale.width - 16;
    const topY = this.mapY > 200 ? 88 : this.mapY + MINIMAP_H + 14; // below minimap if it's up top
    this.feedLines.forEach((f, i) => {
      f.text.setPosition(rightX, topY + i * 20);
      f.text.setAlpha(Math.min(1, (f.until - now) / 1500));
    });
  }

  // ---- scoreboard (Tab) ----------------------------------------------------
  private buildBoard(): void {
    this.board = this.add.container(0, 0, []).setDepth(48000).setVisible(false);
  }

  private toggleBoard(): void {
    this.boardOpen = !this.boardOpen;
    this.board.setVisible(this.boardOpen);
    if (this.boardOpen) this.renderBoard();
  }

  private renderBoard(): void {
    const w = this.gs?.worldRef;
    if (!w) return;
    this.board.removeAll(true);
    const W = this.scale.width;
    const H = this.scale.height;
    const panelW = Math.min(880, W - 80);
    const panelH = 420;
    const cx = W / 2;
    const cy = H / 2;
    const bg = this.add.nineslice(cx, cy, "ui-carved9", 0, panelW, panelH, 20, 20, 20, 20);
    this.board.add(bg);

    const heroes = [...w.units.values()].filter((u) => u.kind === "hero" && u.hero);
    const teams: Team[] = ["radiant", "dire"];
    const teamKills: Record<Team, number> = { radiant: 0, dire: 0 };
    for (const u of heroes) if (u.hero) teamKills[u.team] += u.hero.kills;

    this.board.add(
      this.add.text(cx, cy - panelH / 2 + 26, `SCOREBOARD     ☀ ${teamKills.radiant}  –  ${teamKills.dire} 🌙`, { fontFamily: FONT, fontSize: "22px", color: "#4a3320" }).setOrigin(0.5),
    );

    teams.forEach((team, ti) => {
      const colX = cx - panelW / 2 + 34 + ti * (panelW / 2);
      const headColor = team === "radiant" ? "#2a6f9e" : "#9e2f2a";
      let y = cy - panelH / 2 + 62;
      this.board.add(this.add.text(colX, y, team === "radiant" ? "RADIANT" : "DIRE", { fontFamily: FONT, fontSize: "16px", color: headColor }).setOrigin(0, 0));
      this.board.add(this.add.text(colX + panelW / 2 - 64, y, "K / D / A    Net", { fontFamily: FONT, fontSize: "11px", color: "#7a6240" }).setOrigin(1, 0));
      y += 26;
      // sort() is safe here — filter() already produced a fresh array
      const list = heroes.filter((u) => u.team === team).sort((a, b) => (b.hero?.gold ?? 0) - (a.hero?.gold ?? 0));
      for (const u of list) {
        const h = u.hero!;
        const def = HERO_BY_ID[h.defId];
        const dead = !u.alive;
        const name = `${def?.name ?? h.defId}  Lv${h.level}${h.isBot ? " (bot)" : ""}`;
        const status = dead && h.respawnAt > w.now ? `  ☠ ${Math.ceil((h.respawnAt - w.now) / 1000)}s` : "";
        this.board.add(this.add.text(colX, y, name + status, { fontFamily: FONT, fontSize: "13px", color: dead ? "#9a8a70" : "#4a3320" }).setOrigin(0, 0));
        const net = Math.floor(h.gold);
        this.board.add(this.add.text(colX + panelW / 2 - 64, y, `${h.kills}/${h.deaths}/${h.assists}    🪙${net}`, { fontFamily: FONT, fontSize: "12px", color: "#6b5530" }).setOrigin(1, 0));
        y += 24;
      }
    });
    this.board.add(this.add.text(cx, cy + panelH / 2 - 22, "hold TAB to view", { fontFamily: FONT, fontSize: "11px", color: "#9a8a70" }).setOrigin(0.5));
  }

  private layout(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    const baseY = H - 50;

    if (this.barPanel) this.barPanel.setPosition(cx - 104, baseY).setSize(this.barW + 130, 86);
    this.portrait.setPosition(cx - 220, baseY);
    this.lvlText.setPosition(cx - 220, baseY + 22);

    const barX = cx - 175;
    this.hpBar.setPosition(barX, baseY - 14);
    this.mpBar.setPosition(barX, baseY + 6);
    this.hpText.setPosition(barX + this.barW / 2, baseY - 14);
    this.mpText.setPosition(barX + this.barW / 2, baseY + 6);

    const startX = cx + 60;
    if (this.dashBox) {
      const dashX = startX - 64;
      this.dashPanel.setPosition(dashX, baseY);
      this.dashBox.setPosition(dashX, baseY);
      this.dashLabel.setPosition(dashX, baseY);
      this.dashCd.setPosition(dashX, baseY + 29);
    }
    this.slots.forEach((s, i) => {
      const x = startX + i * 66;
      s.panel.setPosition(x, baseY);
      s.box.setPosition(x, baseY);
      s.icon.setPosition(x, baseY);
      s.cd.setPosition(x, baseY + 29);
      s.cdText.setPosition(x, baseY);
      s.keyLabel.setPosition(x, baseY - 2);
      s.pips.forEach((p, j) => p.setPosition(x - 16 + j * 11, baseY + 22));
    });

    // inventory slots: a 3x2 grid to the right of the ability bar
    const itemX0 = startX + KEYS.length * 66 + 24;
    this.itemSlots.forEach((s, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = itemX0 + col * 42;
      const y = baseY - 20 + row * 42;
      s.panel.setPosition(x, y);
      s.box.setPosition(x, y);
      s.icon.setPosition(x, y);
      s.key.setPosition(x - 13, y - 13);
    });

    if (this.shop) this.shop.setPosition(cx, H / 2);
    this.respawnText.setPosition(cx, H / 2 - 120);
    this.hintText.setPosition(cx, baseY - 46);

    if (this.danger) this.danger.setSize(W, H).setPosition(0, 0);

    // minimap bottom-right; team score top-center
    this.mapX = W - MINIMAP_SIZE - 22;
    this.mapY = H - MINIMAP_H - 22;
    if (this.mapHit) this.mapHit.setPosition(this.mapX, this.mapY);
    if (this.mapFrame) this.mapFrame.setPosition(this.mapX - 14, this.mapY - 14);
    this.drawMapTerrain();
    if (this.scoreRibbon) this.scoreRibbon.setPosition(cx, 4);
    if (this.teamScore) this.teamScore.setPosition(cx, 18);
  }

  override update(): void {
    // auto-close the shop if the player dies while it's open, so uiBlocking can't
    // strand a freshly-respawned hero frozen.
    if (this.shopOpen && !this.gs?.player?.alive) this.toggleShop();
    // minimap / feed / scoreboard run even while the player is dead or unspawned
    this.updateMinimap();
    this.updateFeed();
    // scoreboard refreshes at 4Hz, not per frame — renderBoard rebuilds every
    // Text object, which is far too much churn to run at 60fps while Tab is held
    if (this.boardOpen && this.time.now >= this.boardNextRenderAt) {
      this.boardNextRenderAt = this.time.now + 250;
      this.renderBoard();
    }
    const wRef = this.gs?.worldRef;
    if (wRef && this.teamScore) {
      let rk = 0;
      let dk = 0;
      for (const u of wRef.units.values()) {
        if (u.kind !== "hero" || !u.hero) continue;
        if (u.team === "radiant") rk += u.hero.kills;
        else dk += u.hero.kills;
      }
      this.teamScore.setText(`☀ ${rk}   –   ${dk} 🌙`);
    }

    // low-HP danger pulse
    if (this.danger) {
      const p = this.gs?.player;
      const pct = p && p.alive && p.maxHp > 0 ? p.hp / p.maxHp : 1;
      this.danger.setAlpha(pct < 0.3 ? 0.18 * (1 - pct / 0.3) * (0.55 + 0.45 * Math.sin(this.time.now / 170)) : 0);
    }

    const me = this.gs?.player;
    const world = this.gs?.worldRef;
    if (!me || !world || !me.hero) return;
    const h = me.hero;

    // top-left
    this.goldText.setText(`🪙 ${Math.floor(h.gold)}`);
    const mins = Math.floor(world.gameTime / 60);
    const secs = Math.floor(world.gameTime % 60);
    this.clockText.setText(`⏱ ${mins}:${secs.toString().padStart(2, "0")}`);
    this.kdaText.setText(`K ${h.kills}  D ${h.deaths}  A ${h.assists}  ·  LH ${h.lastHits}`);
    this.apText.setText(h.abilityPoints > 0 ? `▲ ${h.abilityPoints} ability point${h.abilityPoints > 1 ? "s" : ""} (Shift+Q/W/E/R)` : "");

    // dash (F) cooldown (5s)
    if (this.dashCd) {
      const left = Math.max(0, (h.dashReadyAt - world.now) / 1000);
      this.dashCd.setVisible(left > 0.05);
      this.dashCd.height = 58 * Math.min(1, left / 5);
      this.dashBox.setStrokeStyle(2, left > 0.05 ? 0x8a7350 : 0x4a90d9);
    }

    // portrait/level
    const tex = heroSheetTex(h.defId, me.team);
    if (this.portrait.texture.key !== tex && this.textures.exists(tex)) this.portrait.setTexture(tex, 0).setDisplaySize(74, 74);
    this.lvlText.setText(`${h.level}`);

    // bars
    const hpPct = Math.max(0, me.hp / me.maxHp);
    const mpPct = Math.max(0, me.mp / Math.max(1, me.maxMp));
    this.hpBar.width = this.barW * hpPct;
    this.mpBar.width = this.barW * mpPct;
    this.hpText.setText(`${Math.ceil(Math.max(0, me.hp))} / ${Math.round(me.maxHp)}`);
    this.mpText.setText(`${Math.ceil(Math.max(0, me.mp))} / ${Math.round(me.maxMp)}`);

    // abilities
    const def = HERO_BY_ID[h.defId];
    for (const s of this.slots) {
      const ad = def?.abilities[s.key];
      const slot = h.abilities[s.key];
      if (!ad) continue;
      const rank = slot.rank;
      s.pips.forEach((p, j) => p.setFillStyle(j < rank ? 0xffe14a : 0x39456a));
      const cdLeft = Math.max(0, (slot.readyAt - world.now) / 1000);
      const cdTotal = rank > 0 ? valAt(ad.cooldown, rank) : 1;
      if (rank <= 0) {
        s.cd.setVisible(true);
        s.cd.height = 58;
        s.cdText.setText("");
        s.box.setStrokeStyle(2, 0x6b5530);
      } else if (cdLeft > 0.05) {
        s.cd.setVisible(true);
        s.cd.height = 58 * Math.min(1, cdLeft / cdTotal);
        s.cdText.setText(cdLeft >= 1 ? `${Math.ceil(cdLeft)}` : "");
        s.keyLabel.setAlpha(cdLeft >= 1 ? 0.25 : 1); // the countdown replaces the keycap
        s.box.setStrokeStyle(2, 0x8a7350);
      } else {
        const manaOk = me.mp >= valAt(ad.manaCost, rank);
        s.cd.setVisible(!manaOk);
        s.cd.height = manaOk ? 0 : 58;
        s.cd.setFillStyle(0x1a3a6a, manaOk ? 0 : 0.5);
        s.cdText.setText("");
        s.keyLabel.setAlpha(1);
        s.box.setStrokeStyle(manaOk ? 3 : 2, manaOk ? 0x3f9e4d : 0x8a7350);
      }
    }

    // inventory slots
    this.itemSlots.forEach((s, i) => {
      const id = h.items[i];
      if (id) {
        const it = ITEM_BY_ID[id];
        s.icon.setVisible(true).setTexture(it?.icon ?? "ui-icon-01");
        const ready = (h.itemActiveReadyAt[id] ?? 0) <= world.now;
        s.box.setStrokeStyle(2, it?.active ? (ready ? 0x3f9e4d : 0x9a7a30) : 0x8a7350);
        s.key.setVisible(!!it?.active);
      } else {
        s.icon.setVisible(false);
        s.box.setStrokeStyle(2, 0x8a7350);
        s.key.setVisible(false);
      }
    });

    // shop affordability
    if (this.shopOpen) {
      for (const r of this.shopRows) {
        const it = ITEM_BY_ID[r.id];
        const owned = h.items.includes(r.id);
        const afford = h.gold >= (it?.cost ?? 0);
        r.cost.setColor(owned ? "#6be07a" : afford ? "#ffd23a" : "#a05050");
        r.cost.setText(owned ? "OWNED" : `${it?.cost}`);
      }
    }

    // respawn overlay
    if (!me.alive && h.respawnAt > 0) {
      const left = Math.ceil((h.respawnAt - world.now) / 1000);
      this.respawnText.setVisible(true).setText(`Respawning in ${left}s`);
    } else {
      this.respawnText.setVisible(false);
    }

    void XP_CURVE;
  }
}
