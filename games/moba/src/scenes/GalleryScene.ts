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

// Free Pack tileset (9-wide, 54 tiles). The promo + the official tilemap guide use
// THIS, not the Update-010 sheet. Mapping derived from the guide's numbered tilemap
// (1-indexed there → 0-indexed frame here). Flat grass = cols 0-3 rows 0-3; the 3×3
// core (guide 1-9) handles corners/edges/centre, col 3 (13-15) = vertical strip,
// row 3 (10-12) = horizontal strip, 16 = isolated. Keyed by which orthogonal
// neighbours are OUTSIDE (water for flat, lower for elevated): N=8,E=4,S=2,W=1.
const FP_FLAT: Record<number, number> = {
  0: 10, // centre (guide 5)
  8: 1, // N edge (2)
  4: 11, // E edge (6)
  2: 19, // S edge (8)
  1: 9, // W edge (4)
  9: 0, // N+W corner (1)
  12: 2, // N+E corner (3)
  3: 18, // S+W corner (7)
  6: 20, // S+E corner (9)
  5: 12, // E+W → vertical mid (14)
  10: 28, // N+S → horizontal mid (11)
  13: 3, // N+E+W → vertical top end (13)
  7: 21, // S+E+W → vertical bottom end (15)
  11: 27, // N+S+W → horizontal left end (10)
  14: 29, // N+S+E → horizontal right end (12)
  15: 30, // all → isolated (16)
};
// Elevated grass is the identical autotile shifted to cols 5-8 (frame + 5).
const FP_ELEV: Record<number, number> = Object.fromEntries(Object.entries(FP_FLAT).map(([k, v]) => [Number(k), v + 5]));
// Cliff (elevated rows 4-5): guide 17-19/21-23 = wide top/bottom, 20/24 = narrow (1-wide).
const FP_CLIFF = { topL: 41, topM: 42, topR: 43, topNarrow: 44, botL: 50, botM: 51, botR: 52, botNarrow: 53 };
// Stairs: left ramp = 36(top)/45(bottom), right ramp = 39(top)/48(bottom).
const FP_STAIR = { topL: 36, botL: 45, topR: 39, botR: 48 };

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
// Raised plateaus (tile rects [x0,y0,x1,y1] inclusive) → cliff walls at their south
// edges. Traced against the &ref=1 overlay grid to match the reference's terraces.
const HIGH_RECTS: Array<[number, number, number, number]> = [
  [1, 0, 9, 4], // castle + spearmen platform (top-left), drops ~row 5
  [10, 5, 15, 8], // central platform
  [16, 2, 22, 6], // village rise (right)
  [2, 8, 9, 10], // mid-left terrace
  [2, 12, 7, 14], // lower-left terrace
  [11, 10, 16, 13], // lower-right terrace
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
    // load the Free Pack tileset + buildings + units (the promo's actual art), then
    // render. Loaded dynamically so the game build isn't affected.
    const L = this.load;
    L.image("fp-tiles-img", "assets/fp/tiles3.png");
    L.spritesheet("fp-tiles", "assets/fp/tiles3.png", { frameWidth: CELL, frameHeight: CELL });
    L.image("fp-castle", "assets/fp/b-castle.png");
    L.image("fp-tower", "assets/fp/b-tower.png");
    for (let i = 1; i <= 3; i++) L.image(`fp-house${i}`, `assets/fp/b-house${i}.png`);
    L.spritesheet("fp-warrior", "assets/fp/u-warrior.png", { frameWidth: 192, frameHeight: 192 });
    L.spritesheet("fp-lancer", "assets/fp/u-lancer.png", { frameWidth: 320, frameHeight: 320 });
    L.spritesheet("fp-pawn", "assets/fp/u-pawn.png", { frameWidth: 192, frameHeight: 192 });
    const showRef = !!new URLSearchParams(window.location.search).get("ref");
    if (showRef) L.image("refmap", "/ref_map.png");
    L.once(Phaser.Loader.Events.COMPLETE, () => this.renderMap(showRef));
    L.start();
  }

  /** Compose the battlefield in the guide's layer order: BG → foam → flat ground
   *  → (shadow → elevated ground) → cliffs/stairs → objects. */
  private renderMap(showRef: boolean): void {
    const COLS = 25;
    const ROWS = MAP_MASK.length;
    const Wpx = COLS * CELL;
    const Hpx = ROWS * CELL;

    // L0 BG water
    if (this.textures.exists("t-water")) this.add.tileSprite(0, 0, Wpx, Hpx, "t-water").setOrigin(0, 0).setDepth(-1000);
    else this.add.rectangle(0, 0, Wpx, Hpx, 0x3a8f8a).setOrigin(0, 0).setDepth(-1000);

    this.buildMapTerrain(COLS, ROWS); // L2 flat + L4 elevated (one tilemap)
    this.buildMapShadows(COLS, ROWS); // L3 drop shadow (elevated footprint, 1 tile down)
    this.buildMapShoreline(COLS, ROWS); // L1 foam (procedural band)
    this.buildMapCliffs(COLS, ROWS); // cliff faces + stairs
    this.buildMapObjects();

    const cam = this.cameras.main;
    cam.setBackgroundColor("#3a8f8a");
    cam.setZoom(Math.min(1, this.scale.width / Wpx, this.scale.height / Hpx));
    cam.centerOn(Wpx / 2, Hpx / 2);
    if (showRef && this.textures.exists("refmap")) this.add.image(0, 0, "refmap").setOrigin(0, 0).setAlpha(0.45).setDepth(1_000_000);
  }

  /** One tilemap: low land = flat-grass autotile, raised = elevated-grass autotile. */
  private buildMapTerrain(cols: number, rows: number): void {
    if (!this.textures.exists("fp-tiles-img")) return;
    const data: number[][] = [];
    for (let cy = 0; cy < rows; cy++) {
      const row: number[] = [];
      for (let cx = 0; cx < cols; cx++) {
        if (this.high(cx, cy)) {
          const k = (this.high(cx, cy - 1) ? 0 : 8) | (this.high(cx + 1, cy) ? 0 : 4) | (this.high(cx, cy + 1) ? 0 : 2) | (this.high(cx - 1, cy) ? 0 : 1);
          row.push(FP_ELEV[k] ?? 15);
        } else if (this.land(cx, cy)) {
          const k = (this.land(cx, cy - 1) ? 0 : 8) | (this.land(cx + 1, cy) ? 0 : 4) | (this.land(cx, cy + 1) ? 0 : 2) | (this.land(cx - 1, cy) ? 0 : 1);
          row.push(FP_FLAT[k] ?? 10);
        } else row.push(-1);
      }
      data.push(row);
    }
    const map = this.make.tilemap({ data, tileWidth: CELL, tileHeight: CELL });
    const tiles = map.addTilesetImage("fp", "fp-tiles-img");
    if (tiles) map.createLayer(0, tiles, 0, 0)?.setDepth(-900);
    // nudge the Free Pack green toward the promo's warmer olive (multiply wash on land only)
    const wash = this.add.graphics().setDepth(-899).setBlendMode(Phaser.BlendModes.MULTIPLY);
    wash.fillStyle(0xffe2b8, 0.5);
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) if (this.land(cx, cy)) wash.fillRect(cx * CELL, cy * CELL, CELL, CELL);
  }

  /** Drop shadow: the elevated footprint shifted one full tile down (per the guide),
   *  so it peeks out below a platform's bottom edge to sell the height. */
  private buildMapShadows(cols: number, rows: number): void {
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        if (!this.high(cx, cy)) continue;
        this.add.rectangle(cx * CELL + CELL / 2, (cy + 1) * CELL + CELL / 2, CELL, CELL, 0x15323b, 0.45).setDepth(-895);
      }
    }
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

  /** Cliff face below a platform's south edge: the Free Pack 2-row cliff (top row
   *  17-19 / bottom row 21-23, narrow 20/24), placed in the two cells below the
   *  walkable elevated grass — exactly as the guide's Elevated Ground example. */
  private buildMapCliffs(cols: number, rows: number): void {
    if (!this.textures.exists("fp-tiles")) return;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        if (!this.high(cx, cy) || this.high(cx, cy + 1)) continue; // south edge only
        const cxp = cx * CELL + CELL / 2;
        // a wall run ends where the neighbour isn't itself a south-edge cell
        const leftEnd = !this.high(cx - 1, cy) || this.high(cx - 1, cy + 1);
        const rightEnd = !this.high(cx + 1, cy) || this.high(cx + 1, cy + 1);
        const narrow = leftEnd && rightEnd;
        const top = narrow ? FP_CLIFF.topNarrow : leftEnd ? FP_CLIFF.topL : rightEnd ? FP_CLIFF.topR : FP_CLIFF.topM;
        const bot = narrow ? FP_CLIFF.botNarrow : leftEnd ? FP_CLIFF.botL : rightEnd ? FP_CLIFF.botR : FP_CLIFF.botM;
        this.add.image(cxp, (cy + 1) * CELL + CELL / 2, "fp-tiles", top).setDepth(-880);
        this.add.image(cxp, (cy + 2) * CELL + CELL / 2, "fp-tiles", bot).setDepth(-880);
      }
    }
  }

  private buildMapObjects(): void {
    // tile-coord helper → world center px
    const P = (tx: number, ty: number): [number, number] => [tx * CELL, ty * CELL];

    // Free Pack buildings at native scale (castle 320x256=5x4 tiles, tower 128x256,
    // house 128x192). origin (0.5,0.85) plants the base on its tile.
    const building = (tex: string, tx: number, ty: number): void => {
      if (!this.textures.exists(tex)) return;
      const [x, y] = P(tx, ty);
      this.placed(this.add.image(x, y, tex).setOrigin(0.5, 0.85), y);
    };
    building("fp-castle", 3.0, 3.2);
    building("fp-tower", 1.6, 9.8);
    building("fp-tower", 8.6, 15.8);
    const HOUSES = ["fp-house1", "fp-house2", "fp-house3"];
    [[13.6, 5.0], [15.4, 4.8], [14.5, 6.2], [16.5, 5.8], [11.6, 11.8]].forEach(([tx, ty], i) => building(HOUSES[i % HOUSES.length]!, tx!, ty!));

    // Free Pack knights: a Lancer (spearman) column by the castle + scattered units.
    // Lancer frames are 320px (taller, to fit the spear); warrior/pawn are 192px.
    const unit = (tex: string, tx: number, ty: number): void => {
      if (!this.textures.exists(tex)) return;
      const scale = tex === "fp-lancer" ? 0.5 : 0.62;
      const [x, y] = P(tx, ty);
      this.placed(this.add.image(x, y + 8, "shadow").setScale(0.5).setAlpha(0.4), y, -1);
      this.placed(this.add.image(x, y, tex, 0).setScale(scale).setOrigin(0.5, 0.78), y);
    };
    for (const [tx, ty] of [[6.4, 1.8], [7.2, 1.4], [7.9, 2.0], [6.6, 2.8], [7.5, 3.2], [6.0, 2.4]] as Array<[number, number]>) unit("fp-lancer", tx, ty);
    unit("fp-warrior", 7.2, 5.2);
    unit("fp-warrior", 4.2, 13.2);
    unit("fp-warrior", 11.2, 14.2);
    unit("fp-pawn", 16.0, 11.4);

    // trees: STATIC single frame (the tree sheets are sway anims / variant strips;
    // looping them made the sprites visibly scroll). A warm static tint turns the
    // green leaf sheets into the reference's autumn trees.
    const tree = (tex: string, tx: number, ty: number, scale: number, tint?: number): void => {
      if (!this.textures.exists(tex)) return;
      const [x, y] = P(tx, ty);
      const img = this.placed(this.add.image(x, y, tex, 0).setScale(scale).setOrigin(0.5, 0.9), y);
      if (tint !== undefined) img.setTint(tint);
    };
    // dark-green pine cluster across the top + a few by the sign
    for (const [tx, ty] of [[8.8, 0.8], [9.6, 0.5], [10.4, 0.8], [11.2, 0.5], [12.0, 0.9], [12.9, 0.6], [17.4, 0.8], [18.3, 1.6], [19.0, 0.7]] as Array<[number, number]>) tree("t-tree", tx, ty, 1.12);
    // autumn (warm-tinted) leafy trees down the flanks & corners
    const AUTUMN = [0xf4d24a, 0xe9a23a, 0xf2c14e, 0xe6b34a];
    for (const [tx, ty, n] of [
      [0.7, 1.8, 1], [0.9, 3.2, 2], [0.6, 4.6, 3], [1.0, 6.0, 4],
      [17.6, 12.0, 1], [18.6, 13.4, 2], [19.3, 11.6, 3], [20.0, 13.0, 4],
      [13.0, 16.0, 1], [4.6, 16.2, 2], [22.0, 8.4, 3],
    ] as Array<[number, number, number]>) tree(`ftree${n}`, tx, ty, 0.6, AUTUMN[(n - 1) % AUTUMN.length]);

    // sheep grazing near the village
    for (const [tx, ty] of [[17.6, 6.6], [19.0, 6.0], [16.2, 8.6], [12.8, 9.6], [15.0, 13.0]] as Array<[number, number]>) {
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
