import Phaser from "phaser";

// Asset showcase pages (reachable via ?gallery=units|terrain|fx) that reimplement
// the Tiny Swords itch sections in isolation — a viewer to verify every sprite,
// animation, and terrain tile renders correctly before composing the live game.

type Subject = { name: string; tex: string; animBase: string; scale: number };

const UNIT_SUBJECTS: Subject[] = [
  { name: "Warrior", tex: "u-warrior-blue", animBase: "u-warrior-blue", scale: 0.5 },
  { name: "Pawn", tex: "u-pawn-blue", animBase: "u-pawn-blue", scale: 0.5 },
  { name: "Archer", tex: "u-archer-blue", animBase: "u-archer-blue", scale: 0.5 },
  { name: "Torch", tex: "u-torch-red", animBase: "u-torch-red", scale: 0.5 },
  { name: "TNT", tex: "u-tnt-red", animBase: "u-tnt-red", scale: 0.5 },
  { name: "Barrel", tex: "u-barrel-blue", animBase: "u-barrel-blue", scale: 0.55 },
  { name: "Skull (neutral)", tex: "e-skull-idle", animBase: "e-skull", scale: 0.46 },
  { name: "Gnoll (neutral)", tex: "e-gnoll-idle", animBase: "e-gnoll", scale: 0.46 },
  { name: "Minotaur (Roshan)", tex: "e-minotaur-idle", animBase: "e-minotaur", scale: 0.28 },
];
const UNIT_ANIMS = ["idle", "walk", "attack", "death"] as const;

// --- map recreation (?gallery=map): a pixel-traced rebuild of the Tiny Swords
// example battlefield, to learn how terrain + cliffs + buildings + units + props
// compose. CELL/autotile maps mirror render/view.ts so the gallery and the live
// game render terrain identically.
const CELL = 64;
const GRASS_FRAME = 11;
const GRASS_AUTOTILE: Record<number, number> = { 0: 11, 1: 10, 2: 21, 3: 20, 4: 12, 5: 13, 6: 22, 7: 23, 8: 1, 9: 0, 10: 31, 11: 30, 12: 2, 13: 3, 14: 32, 15: 33 };

// Island footprint auto-traced from the reference (1 = grass, 0 = water), 25×19 @ 64px.
const MAP_MASK = [
  "0000000000000000000000000",
  "0000000000000011000011100",
  "0000011111111111111111110",
  "0111111111111111111111111",
  "0111111111111111111111111",
  "0111111111111111111100000",
  "0111111111111111111100000",
  "0111111111111111111111000",
  "0111111111111111111111000",
  "0001111111111111111111110",
  "0001111111001111111111110",
  "0011111111001111111111110",
  "0111111110001111111111110",
  "0111111100001111111111110",
  "0111111000001111111111110",
  "0111111000000111111111110",
  "0011100000000000111111110",
  "0011100000000000000111100",
  "0000000000000000000000000",
];
// Raised plateaus (tile rects [x0,y0,x1,y1] inclusive) → cliff walls at their edges.
const HIGH_RECTS: Array<[number, number, number, number]> = [
  [2, 1, 9, 3], // castle rise (top-left)
  [3, 10, 8, 14], // mid-left terrace
  [11, 6, 16, 9], // central plateau
  [16, 2, 22, 6], // village rise (right)
  [10, 11, 15, 14], // lower-center terrace
  [17, 8, 21, 11], // village south rise
];

export class GalleryScene extends Phaser.Scene {
  private section = "units";

  constructor() {
    super("Gallery");
  }

  init(data: { section?: string | null }): void {
    this.section = data?.section || "units";
  }

  create(): void {
    this.cameras.main.setBackgroundColor("#3a8f8a"); // Tiny Swords teal backdrop
    const veil = document.getElementById("veil");
    if (veil) {
      veil.classList.add("hidden");
      setTimeout(() => veil.remove(), 400);
    }
    if (this.section === "map") {
      this.buildMapPage();
      return;
    }

    const W = this.scale.width;
    this.add.text(W / 2, 26, `TINY SWORDS — ${this.section.toUpperCase()}`, { fontSize: "26px", color: "#fff8e0", fontStyle: "bold", stroke: "#234", strokeThickness: 5 }).setOrigin(0.5);
    this.add.text(W / 2, 54, "?gallery=units · terrain · fx · map", { fontSize: "13px", color: "#cfeae6" }).setOrigin(0.5);

    if (this.section === "terrain") this.buildTerrainPage();
    else if (this.section === "fx") this.buildFxPage();
    else this.buildUnitsPage();
  }

  /** Loop an animation (even non-looping ones) with a short pause, for inspection. */
  private playLoop(sprite: Phaser.GameObjects.Sprite, key: string): void {
    sprite.play(key);
    sprite.on("animationcomplete", () => this.time.delayedCall(500, () => sprite.active && sprite.play(key)));
  }

  /** Loop the procedural collapse death (topple + sink + fade), then reset. */
  private collapseLoop(sprite: Phaser.GameObjects.Sprite, baseX: number, baseY: number, scale: number): void {
    const run = (): void => {
      if (!sprite.active) return;
      sprite.setAngle(0).setAlpha(1).setScale(scale).setPosition(baseX, baseY);
      this.tweens.add({ targets: sprite, angle: 78, y: baseY + 14, alpha: 0, duration: 520, ease: "Quad.easeIn", onComplete: () => this.time.delayedCall(450, run) });
    };
    run();
  }

  private buildUnitsPage(): void {
    const W = this.scale.width;
    const colX = [340, 600, 860, 1120]; // idle/walk/attack/death columns
    // column headers
    this.add.text(160, 80, "UNIT", { fontSize: "13px", color: "#bfe", fontStyle: "bold" }).setOrigin(0.5);
    UNIT_ANIMS.forEach((a, i) => this.add.text(colX[i]!, 80, a.toUpperCase(), { fontSize: "13px", color: "#bfe", fontStyle: "bold" }).setOrigin(0.5));

    const rowH = Math.min(86, (this.scale.height - 110) / UNIT_SUBJECTS.length);
    UNIT_SUBJECTS.forEach((s, r) => {
      const y = 120 + r * rowH;
      this.add.rectangle(W / 2, y, W - 60, rowH - 6, r % 2 ? 0x347f7a : 0x2e7570, 0.6).setOrigin(0.5);
      this.add.text(160, y, s.name, { fontSize: "14px", color: "#fff", fontStyle: "bold" }).setOrigin(0.5);
      UNIT_ANIMS.forEach((a, i) => {
        const key = `${s.animBase}-${a}`;
        const x = colX[i]!;
        if (this.anims.exists(key)) {
          const spr = this.add.sprite(x, y, s.tex, 0).setScale(s.scale);
          this.playLoop(spr, key);
        } else if (a === "death") {
          // no death sheet — show the procedural collapse used in-game
          const idle = `${s.animBase}-idle`;
          const spr = this.add.sprite(x, y, s.tex, 0).setScale(s.scale);
          if (this.anims.exists(idle)) spr.play(idle);
          this.collapseLoop(spr, x, y, s.scale);
          this.add.text(x, y + 30, "collapse", { fontSize: "10px", color: "#8cc" }).setOrigin(0.5);
        } else {
          this.add.text(x, y, "—", { fontSize: "20px", color: "#6aa" }).setOrigin(0.5);
        }
      });
    });
  }

  private buildFxPage(): void {
    const cx = this.scale.width / 2;
    const items: Array<{ label: string; play: (x: number, y: number) => void }> = [
      { label: "Explosion", play: (x, y) => { const e = this.add.sprite(x, y, "fx-explosion", 0).setScale(1.4).setBlendMode(Phaser.BlendModes.ADD); if (this.anims.exists("fx-explode")) this.playLoop(e, "fx-explode"); } },
      { label: "Fire", play: (x, y) => { const e = this.add.sprite(x, y, "fx-fire", 0).setScale(1.6).setBlendMode(Phaser.BlendModes.ADD); if (this.anims.exists("fx-fire-loop")) e.play("fx-fire-loop"); } },
      { label: "Hit puff", play: (x, y) => { this.time.addEvent({ delay: 700, loop: true, callback: () => { const p = this.add.image(x, y, "spark").setScale(0.6).setBlendMode(Phaser.BlendModes.ADD); this.tweens.add({ targets: p, scale: 1.9, alpha: 0, duration: 220, onComplete: () => p.destroy() }); } }); } },
      { label: "Arrow", play: (x, y) => { this.add.image(x, y, "fx-arrow").setScale(0.8); } },
    ];
    const startX = cx - ((items.length - 1) * 220) / 2;
    items.forEach((it, i) => {
      const x = startX + i * 220;
      const y = 300;
      this.add.rectangle(x, y, 180, 180, 0x2e7570, 0.6);
      it.play(x, y);
      this.add.text(x, y + 110, it.label, { fontSize: "16px", color: "#fff", fontStyle: "bold" }).setOrigin(0.5);
    });
  }

  private buildTerrainPage(): void {
    // a small composed island: water bg, grass autotile patch, elevation, deco, foam line
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2 + 20;
    const items: Array<{ label: string; tex: string; frame?: number; scale: number; sheet?: boolean }> = [
      { label: "grass", tex: "t-ground", frame: 11, scale: 1.2 },
      { label: "water", tex: "t-water", scale: 1.2 },
      { label: "cliff", tex: "t-elev", frame: 5, scale: 1.2 },
      { label: "cliff face", tex: "t-elev", frame: 13, scale: 1.2 },
      { label: "bridge", tex: "t-bridge", frame: 1, scale: 1.2 },
      { label: "tree", tex: "ftree1", frame: 0, scale: 0.5, sheet: true },
      { label: "water rock", tex: "wrock1", frame: 0, scale: 0.7, sheet: true },
      { label: "sheep", tex: "sheep", frame: 0, scale: 0.6, sheet: true },
    ];
    const cols = 4;
    const cellW = 200;
    const cellH = 160;
    const startX = cx - ((cols - 1) * cellW) / 2;
    const startY = cy - cellH;
    items.forEach((it, i) => {
      const x = startX + (i % cols) * cellW;
      const y = startY + Math.floor(i / cols) * cellH;
      this.add.rectangle(x, y, cellW - 16, cellH - 16, 0x2e7570, 0.6);
      if (this.textures.exists(it.tex)) {
        if (it.sheet && this.anims.exists(`${it.tex}-anim`)) { const sp = this.add.sprite(x, y, it.tex, 0).setScale(it.scale); sp.play(`${it.tex}-anim`); }
        else if (it.sheet && this.anims.exists(`${it.tex}-sway`)) { const sp = this.add.sprite(x, y, it.tex, 0).setScale(it.scale); sp.play(`${it.tex}-sway`); }
        else if (it.sheet && this.anims.exists("sheep-idle") && it.tex === "sheep") { const sp = this.add.sprite(x, y, it.tex, 0).setScale(it.scale); sp.play("sheep-idle"); }
        else this.add.image(x, y, it.tex, it.frame ?? 0).setScale(it.scale);
      }
      this.add.text(x, y + 70, it.label, { fontSize: "14px", color: "#fff" }).setOrigin(0.5);
    });
  }

  // ---- map: Tiny Swords example battlefield, rebuilt from the traced footprint ----

  private land(cx: number, cy: number): boolean {
    return cy >= 0 && cy < MAP_MASK.length && cx >= 0 && cx < 25 && MAP_MASK[cy]![cx] === "1";
  }

  private high(cx: number, cy: number): boolean {
    if (!this.land(cx, cy)) return false;
    return HIGH_RECTS.some(([x0, y0, x1, y1]) => cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1);
  }

  /** Add a game object at world (x,y) with depth = y so it sorts back-to-front. */
  private placed<T extends Phaser.GameObjects.Components.Depth & Phaser.GameObjects.Components.Transform>(obj: T, y: number, dz = 0): T {
    obj.setDepth(y + dz);
    return obj;
  }

  private buildMapPage(): void {
    const COLS = 25;
    const ROWS = MAP_MASK.length;
    const Wpx = COLS * CELL;
    const Hpx = ROWS * CELL;

    // water underlay
    if (this.textures.exists("t-water")) this.add.tileSprite(0, 0, Wpx, Hpx, "t-water").setOrigin(0, 0).setDepth(-1000);
    else this.add.rectangle(0, 0, Wpx, Hpx, 0x3a8f8a).setOrigin(0, 0).setDepth(-1000);

    this.buildMapGrass(COLS, ROWS);
    this.buildMapShoreline(COLS, ROWS);
    this.buildMapCliffs(COLS, ROWS);
    this.buildMapObjects();

    // fit the whole 1600×1216 map into the viewport
    const cam = this.cameras.main;
    cam.setBackgroundColor("#3a8f8a");
    const zoom = Math.min(this.scale.width / Wpx, this.scale.height / Hpx) * 0.98;
    cam.setZoom(zoom);
    cam.centerOn(Wpx / 2, Hpx / 2);
  }

  private buildMapGrass(cols: number, rows: number): void {
    if (!this.textures.exists("t-ground-img")) return;
    const data: number[][] = [];
    for (let cy = 0; cy < rows; cy++) {
      const row: number[] = [];
      for (let cx = 0; cx < cols; cx++) {
        if (!this.land(cx, cy)) { row.push(-1); continue; }
        const k = (this.land(cx, cy - 1) ? 0 : 8) | (this.land(cx + 1, cy) ? 0 : 4) | (this.land(cx, cy + 1) ? 0 : 2) | (this.land(cx - 1, cy) ? 0 : 1);
        row.push(GRASS_AUTOTILE[k] ?? GRASS_FRAME);
      }
      data.push(row);
    }
    const map = this.make.tilemap({ data, tileWidth: CELL, tileHeight: CELL });
    const tiles = map.addTilesetImage("ground", "t-ground-img");
    if (tiles) map.createLayer(0, tiles, 0, 0)?.setDepth(-900);
    // warm light wash over the grass to match the reference's brighter tone
    const warm = this.add.graphics().setDepth(-899).setBlendMode(Phaser.BlendModes.ADD);
    warm.fillStyle(0x6a5a10, 0.16);
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) if (this.land(cx, cy)) warm.fillRect(cx * CELL, cy * CELL, CELL, CELL);
  }

  private buildMapShoreline(cols: number, rows: number): void {
    const band = (depth: number, width: number, color: number, alpha: number, off: number): void => {
      const g = this.add.graphics().setDepth(depth).setBlendMode(Phaser.BlendModes.ADD);
      g.lineStyle(width, color, alpha);
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          if (!this.land(cx, cy)) continue;
          const x = cx * CELL, y = cy * CELL;
          if (!this.land(cx, cy - 1)) g.lineBetween(x, y - off, x + CELL, y - off);
          if (!this.land(cx, cy + 1)) g.lineBetween(x, y + CELL + off, x + CELL, y + CELL + off);
          if (!this.land(cx + 1, cy)) g.lineBetween(x + CELL + off, y, x + CELL + off, y + CELL);
          if (!this.land(cx - 1, cy)) g.lineBetween(x - off, y, x - off, y + CELL);
        }
      }
    };
    band(-880, 10, 0xbfe9ff, 0.5, 2);
    band(-882, 18, 0x8fd0e0, 0.28, 9);
  }

  // The plateau TOP stays grass (the grass layer already covers high cells). We
  // only draw the tileset's CLIFF FACE (frames 12-15) at the south drops, plus a
  // grass lip + cast shadow — the Tiny Swords look: green platforms, stone walls.
  private buildMapCliffs(cols: number, rows: number): void {
    const hasElev = this.textures.exists("t-elev");
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        if (!this.high(cx, cy)) continue;
        const x = cx * CELL, y = cy * CELL, cxp = x + CELL / 2;
        const sLow = !this.high(cx, cy + 1);
        const eLow = !this.high(cx + 1, cy);
        const wLow = !this.high(cx - 1, cy);
        // side drops: a slim dark stone strip down the platform edge
        if (eLow) this.add.rectangle(x + CELL - 4, y + CELL / 2, 12, CELL, 0x394640, 0.7).setDepth(y + CELL - 2);
        if (wLow) this.add.rectangle(x + 4, y + CELL / 2, 12, CELL, 0x394640, 0.7).setDepth(y + CELL - 2);
        if (!sLow) continue;
        // south drop: cast shadow on the lower ground, a chunkier stone face, grass lip
        this.add.ellipse(cxp, y + CELL + 40, CELL + 6, 20, 0x000000, 0.28).setDepth(y + CELL - 3);
        const frame = wLow ? 12 : eLow ? 14 : 13; // corner faces where the side also drops
        if (hasElev) this.add.image(cxp, y + CELL + 12, "t-elev", frame).setScale(1, 1.18).setDepth(y + CELL);
        this.add.rectangle(cxp, y + CELL - 1, CELL, 7, 0x2c5a2b, 0.6).setDepth(y + CELL + 1);
      }
    }
  }

  private buildMapObjects(): void {
    // tile-coord helper → world center px
    const P = (tx: number, ty: number): [number, number] => [tx * CELL, ty * CELL];

    // buildings (blue): castle, two towers, village houses
    const blue = (tex: string): string => (this.textures.exists(`${tex}-blue`) ? `${tex}-blue` : tex);
    const building = (tex: string, tx: number, ty: number, scale: number): void => {
      const [x, y] = P(tx, ty);
      if (this.textures.exists(blue(tex))) this.placed(this.add.image(x, y, blue(tex)).setScale(scale).setOrigin(0.5, 0.85), y);
    };
    building("b-castle", 4.2, 2.2, 1.0);
    building("b-tower", 2.6, 8.4, 0.95);
    building("b-tower", 9.2, 15.0, 0.95);
    // village cluster on the right, below the sign
    for (const [tx, ty] of [[17.6, 4.6], [19.4, 4.4], [20.6, 5.6], [18.4, 6.0], [15.4, 9.0]] as Array<[number, number]>) building("b-house", tx, ty, 0.82);

    // units (blue knights): a spearman column near the castle + scattered warriors
    const unit = (tex: string, tx: number, ty: number, scale = 0.52): void => {
      const t = this.textures.exists(`u-${tex}-blue`) ? `u-${tex}-blue` : "";
      if (!t) return;
      const [x, y] = P(tx, ty);
      this.placed(this.add.image(x, y + 8, "shadow").setScale(0.55).setAlpha(0.45), y, -1);
      const spr = this.placed(this.add.sprite(x, y, t, 0).setScale(scale).setOrigin(0.5, 0.8), y);
      if (this.anims.exists(`u-${tex}-blue-idle`)) spr.play(`u-${tex}-blue-idle`);
    };
    // a marching column of knights near the castle + scattered patrols
    for (const [tx, ty] of [[6.6, 1.6], [7.4, 1.2], [8.2, 1.7], [7.0, 2.6], [8.0, 2.9], [6.2, 3.4]] as Array<[number, number]>) unit("warrior", tx, ty);
    unit("warrior", 9.0, 5.4);
    unit("warrior", 8.4, 4.6);
    unit("pawn", 5.2, 12.8);
    unit("warrior", 13.0, 13.2);
    unit("pawn", 16.4, 11.6);
    unit("archer", 11.4, 7.4);

    // trees: green pines along the top, leafy trees on the flanks. A warm static
    // tint turns the green leaf sheets into the reference's autumn trees (safe —
    // it's set once on decor, never per-frame like the old unit-flash bug).
    const tree = (tex: string, tx: number, ty: number, scale: number, tint?: number): void => {
      if (!this.textures.exists(tex)) return;
      const [x, y] = P(tx, ty);
      const spr = this.placed(this.add.sprite(x, y, tex, 0).setScale(scale).setOrigin(0.5, 0.9), y);
      if (tint !== undefined) spr.setTint(tint);
      if (this.anims.exists(`${tex}-sway`)) spr.play(`${tex}-sway`);
    };
    // dark-green pine cluster across the top + along the upper coast & by the sign
    for (const [tx, ty] of [[10.4, 0.7], [11.3, 0.4], [12.2, 0.7], [13.1, 0.4], [14.0, 0.7], [14.9, 0.4], [9.6, 1.0], [15.7, 1.0], [23.2, 1.2], [23.9, 2.6], [24.2, 4.2], [8.7, 0.6]] as Array<[number, number]>) tree("t-tree", tx, ty, 1.12);
    // autumn (warm-tinted) leafy trees down the flanks & corners
    const AUTUMN = [0xf4d24a, 0xe9a23a, 0xf2c14e, 0xe6b34a];
    for (const [tx, ty, n] of [
      [1.4, 1.8, 1], [1.7, 3.2, 2], [1.3, 4.6, 3], [1.9, 6.0, 4], [1.5, 7.4, 1], [2.2, 8.8, 2],
      [22.4, 9.4, 1], [23.0, 11.0, 2], [22.1, 12.6, 3], [23.2, 14.0, 4], [21.4, 7.6, 1],
      [13.2, 16.4, 4], [11.0, 16.6, 2], [4.6, 16.4, 3], [18.6, 15.6, 1],
    ] as Array<[number, number, number]>) tree(`ftree${n}`, tx, ty, 0.6, AUTUMN[(n - 1) % AUTUMN.length]);

    // sheep grazing near the village
    for (const [tx, ty] of [[18.4, 7.4], [20.4, 6.6], [16.8, 9.8], [21.6, 8.2], [15.0, 11.0]] as Array<[number, number]>) {
      if (!this.textures.exists("sheep")) break;
      const [x, y] = P(tx, ty);
      const spr = this.placed(this.add.sprite(x, y, "sheep", 0).setScale(0.5).setOrigin(0.5, 0.8), y);
      if (this.anims.exists("sheep-idle")) spr.play("sheep-idle");
    }

    // shoreline rocks
    for (const [tx, ty, n] of [[3.5, 5.5, 1], [13.5, 17.0, 2], [2.5, 16.0, 3], [23.0, 9.0, 4], [10.5, 9.5, 1]] as Array<[number, number, number]>) {
      const tex = `deco-rock${n}`;
      if (!this.textures.exists(tex)) continue;
      const [x, y] = P(tx, ty);
      this.placed(this.add.image(x, y, tex).setScale(0.7), y);
    }

    this.buildMapSign();
  }

  /** Approximate the "Tiny Swords" stone-framed sign in the top-right corner. */
  private buildMapSign(): void {
    const x = 21.4 * CELL, y = 1.35 * CELL;
    const g = this.add.graphics().setDepth(100000);
    g.fillStyle(0x4a5562, 1).fillRoundedRect(x - 165, y - 64, 330, 128, 18); // stone frame
    g.fillStyle(0x2f3742, 1).fillRoundedRect(x - 153, y - 52, 306, 104, 13);
    g.fillStyle(0xe9dcb8, 1).fillRoundedRect(x - 141, y - 40, 282, 80, 10); // parchment
    g.lineStyle(3, 0x9b8a5e, 1).strokeRoundedRect(x - 141, y - 40, 282, 80, 10);
    this.add.text(x, y, "Tiny Swords", { fontSize: "42px", color: "#b23a3a", fontStyle: "bold italic", stroke: "#6a1f1f", strokeThickness: 3 }).setOrigin(0.5).setDepth(100001);
  }
}
