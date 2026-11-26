import type Phaser from "phaser";
import { BlendModes, Loader, Scene } from "phaser";

import { CELL } from "../data/map";
import { CLIFF_FRAMES, SLOPE_FRAMES, autotileFrame, autotileMask } from "../render/autotile";
import { buildGalleryNav } from "./gallery-nav";

interface Subject {
  name: string;
  tex: string;
  animBase: string;
  scale: number;
}

const UNIT_SUBJECTS: Subject[] = [
  { animBase: "u-warrior-blue", name: "Warrior", scale: 0.5, tex: "u-warrior-blue" },
  { animBase: "u-pawn-blue", name: "Pawn", scale: 0.5, tex: "u-pawn-blue" },
  { animBase: "u-archer-blue", name: "Archer", scale: 0.5, tex: "u-archer-blue" },
  { animBase: "u-torch-red", name: "Torch", scale: 0.5, tex: "u-torch-red" },
  { animBase: "u-tnt-red", name: "TNT", scale: 0.5, tex: "u-tnt-red" },
  { animBase: "u-barrel-blue", name: "Barrel", scale: 0.55, tex: "u-barrel-blue" },
  { animBase: "e-skull", name: "Skull (neutral)", scale: 0.46, tex: "e-skull-idle" },
  { animBase: "e-gnoll", name: "Gnoll (neutral)", scale: 0.46, tex: "e-gnoll-idle" },
  { animBase: "e-minotaur", name: "Minotaur (Roshan)", scale: 0.28, tex: "e-minotaur-idle" },
];

const UNIT_ANIMS = ["idle", "walk", "attack", "death"] as const;

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

const HIGH_RECTS: [number, number, number, number][] = [
  [1, 0, 9, 4],
  [10, 5, 15, 8],
  [16, 2, 22, 6],
  [2, 8, 9, 10],
  [2, 12, 7, 14],
  [11, 10, 16, 13],
];

const tileToWorld: (tx: number, ty: number) => [number, number] = (tx, ty) => [
  tx * CELL,
  ty * CELL,
];

export class GalleryScene extends Scene {
  private section = "units";

  constructor() {
    super("Gallery");
  }

  init(data: { section?: string | null }) {
    this.section =
      data.section === undefined || data.section === null || data.section === ""
        ? "units"
        : data.section;
  }

  create() {
    this.cameras.main.setBackgroundColor("#3a8f8a");
    const veil = document.querySelector("#veil");

    if (veil) {
      veil.classList.add("hidden");
      setTimeout(() => {
        veil.remove();
      }, 400);
    }

    if (this.section === "map") {
      this.buildMapPage();
      buildGalleryNav(this, "map");

      return;
    }

    const W = this.scale.width;
    this.add
      .text(W / 2, 64, `ELDERMOOR — ${this.section.toUpperCase()}`, {
        color: "#fff8e0",
        fontSize: "20px",
        fontStyle: "bold",
        stroke: "#234",
        strokeThickness: 4,
      })
      .setOrigin(0.5);
    buildGalleryNav(this, this.section);

    if (this.section === "terrain") {
      this.buildTerrainPage();
    } else if (this.section === "fx") {
      this.buildFxPage();
    } else {
      this.buildUnitsPage();
    }
  }

  private playLoop(sprite: Phaser.GameObjects.Sprite, key: string) {
    sprite.play(key);
    sprite.on("animationcomplete", () =>
      this.time.delayedCall(500, () => sprite.active && sprite.play(key)),
    );
  }

  private collapseLoop(
    sprite: Phaser.GameObjects.Sprite,
    baseX: number,
    baseY: number,
    scale: number,
  ) {
    const run = () => {
      if (!sprite.active) {
        return;
      }

      sprite.setAngle(0).setAlpha(1).setScale(scale).setPosition(baseX, baseY);
      this.tweens.add({
        alpha: 0,
        angle: 78,
        duration: 520,
        ease: "Quad.easeIn",
        onComplete: () => {
          this.time.delayedCall(450, run);
        },
        targets: sprite,
        y: baseY + 14,
      });
    };

    run();
  }

  private buildUnitsPage() {
    const W = this.scale.width;
    const colX = [340, 600, 860, 1120];
    this.add
      .text(160, 80, "UNIT", { color: "#bfe", fontSize: "13px", fontStyle: "bold" })
      .setOrigin(0.5);

    for (const [i, a] of UNIT_ANIMS.entries()) {
      this.add
        .text(colX[i] ?? 0, 80, a.toUpperCase(), {
          color: "#bfe",
          fontSize: "13px",
          fontStyle: "bold",
        })
        .setOrigin(0.5);
    }

    const rowH = Math.min(86, (this.scale.height - 110) / UNIT_SUBJECTS.length);

    for (const [r, s] of UNIT_SUBJECTS.entries()) {
      const y = 120 + r * rowH;
      this.add
        .rectangle(W / 2, y, W - 60, rowH - 6, r % 2 ? 0x34_7f_7a : 0x2e_75_70, 0.6)
        .setOrigin(0.5);
      this.add
        .text(160, y, s.name, { color: "#fff", fontSize: "14px", fontStyle: "bold" })
        .setOrigin(0.5);

      for (const [i, a] of UNIT_ANIMS.entries()) {
        const key = `${s.animBase}-${a}`;
        const x = colX[i] ?? 0;

        if (this.anims.exists(key)) {
          const spr = this.add.sprite(x, y, s.tex, 0).setScale(s.scale);
          this.playLoop(spr, key);
        } else if (a === "death") {
          const idle = `${s.animBase}-idle`;
          const spr = this.add.sprite(x, y, s.tex, 0).setScale(s.scale);

          if (this.anims.exists(idle)) {
            spr.play(idle);
          }

          this.collapseLoop(spr, x, y, s.scale);
          this.add.text(x, y + 30, "collapse", { color: "#8cc", fontSize: "10px" }).setOrigin(0.5);
        } else {
          this.add.text(x, y, "—", { color: "#6aa", fontSize: "20px" }).setOrigin(0.5);
        }
      }
    }
  }

  private buildFxPage() {
    const cx = this.scale.width / 2;

    const items: { label: string; play: (x: number, y: number) => void }[] = [
      {
        label: "Explosion",
        play: (x, y) => {
          const e = this.add
            .sprite(x, y, "fx-explosion", 0)
            .setScale(1.4)
            .setBlendMode(BlendModes.ADD);

          if (this.anims.exists("fx-explode")) {
            this.playLoop(e, "fx-explode");
          }
        },
      },
      {
        label: "Fire",
        play: (x, y) => {
          const e = this.add.sprite(x, y, "fx-fire", 0).setScale(1.6).setBlendMode(BlendModes.ADD);

          if (this.anims.exists("fx-fire-loop")) {
            e.play("fx-fire-loop");
          }
        },
      },
      {
        label: "Hit puff",
        play: (x, y) => {
          this.time.addEvent({
            callback: () => {
              const p = this.add.image(x, y, "spark").setScale(0.6).setBlendMode(BlendModes.ADD);
              this.tweens.add({
                alpha: 0,
                duration: 220,
                onComplete: () => {
                  p.destroy();
                },
                scale: 1.9,
                targets: p,
              });
            },
            delay: 700,
            loop: true,
          });
        },
      },
      {
        label: "Arrow",
        play: (x, y) => {
          this.add.image(x, y, "fx-arrow").setScale(0.8);
        },
      },
    ];

    const startX = cx - ((items.length - 1) * 220) / 2;

    for (const [i, it] of items.entries()) {
      const x = startX + i * 220;
      const y = 300;
      this.add.rectangle(x, y, 180, 180, 0x2e_75_70, 0.6);
      it.play(x, y);
      this.add
        .text(x, y + 110, it.label, { color: "#fff", fontSize: "16px", fontStyle: "bold" })
        .setOrigin(0.5);
    }
  }

  private buildTerrainPage() {
    const L = this.load;
    L.spritesheet("t-ground", "assets/terrain/ground_flat.webp", {
      frameHeight: CELL,
      frameWidth: CELL,
    });
    L.spritesheet("t-elev", "assets/terrain/ground_elevation.webp", {
      frameHeight: CELL,
      frameWidth: CELL,
    });
    L.once(Loader.Events.COMPLETE, () => {
      this.renderTerrainPage();
    });
    L.start();
  }

  private renderTerrainPage() {
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2 + 20;

    const items: {
      label: string;
      tex: string;
      frame?: number;
      scale: number;
      sheet?: boolean;
    }[] = [
      { frame: 11, label: "grass", scale: 1.2, tex: "t-ground" },
      { label: "water", scale: 1.2, tex: "t-water" },
      { frame: 5, label: "cliff", scale: 1.2, tex: "t-elev" },
      { frame: 13, label: "cliff face", scale: 1.2, tex: "t-elev" },
      { frame: 1, label: "bridge", scale: 1.2, tex: "t-bridge" },
      { frame: 0, label: "tree", scale: 0.5, sheet: true, tex: "ftree1" },
      { frame: 0, label: "water rock", scale: 0.7, sheet: true, tex: "wrock1" },
      { frame: 0, label: "sheep", scale: 0.6, sheet: true, tex: "sheep" },
    ];

    const cols = 4;
    const cellW = 200;
    const cellH = 160;
    const startX = cx - ((cols - 1) * cellW) / 2;
    const startY = cy - cellH;

    for (const [i, it] of items.entries()) {
      const x = startX + (i % cols) * cellW;
      const y = startY + Math.floor(i / cols) * cellH;
      this.add.rectangle(x, y, cellW - 16, cellH - 16, 0x2e_75_70, 0.6);

      if (this.textures.exists(it.tex)) {
        if (it.sheet === true && this.anims.exists(`${it.tex}-anim`)) {
          const sp = this.add.sprite(x, y, it.tex, 0).setScale(it.scale);
          sp.play(`${it.tex}-anim`);
        } else if (it.sheet === true && this.anims.exists(`${it.tex}-sway`)) {
          const sp = this.add.sprite(x, y, it.tex, 0).setScale(it.scale);
          sp.play(`${it.tex}-sway`);
        } else if (it.sheet === true && this.anims.exists("sheep-idle") && it.tex === "sheep") {
          const sp = this.add.sprite(x, y, it.tex, 0).setScale(it.scale);
          sp.play("sheep-idle");
        } else {
          this.add.image(x, y, it.tex, it.frame ?? 0).setScale(it.scale);
        }
      }

      this.add.text(x, y + 70, it.label, { color: "#fff", fontSize: "14px" }).setOrigin(0.5);
    }
  }

  private static land(cx: number, cy: number) {
    return cy >= 0 && cy < MAP_MASK.length && cx >= 0 && cx < 25 && MAP_MASK[cy]?.[cx] === "1";
  }

  private static high(cx: number, cy: number) {
    if (!GalleryScene.land(cx, cy)) {
      return false;
    }

    return HIGH_RECTS.some(([x0, y0, x1, y1]) => cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1);
  }

  private static placed<
    T extends Phaser.GameObjects.Components.Depth & Phaser.GameObjects.Components.Transform,
  >(obj: T, y: number, dz = 0) {
    obj.setDepth(y + dz);

    return obj;
  }

  private buildMapPage() {
    const L = this.load;
    L.image("sc-tiles-img", "assets/terrain/tiles.webp");
    L.spritesheet("sc-tiles", "assets/terrain/tiles.webp", { frameHeight: CELL, frameWidth: CELL });
    L.image("sc-castle", "assets/showcase/castle.webp");
    L.image("sc-tower", "assets/showcase/tower.webp");

    for (let i = 1; i <= 3; i += 1) {
      L.image(`sc-house${i}`, `assets/showcase/house${i}.webp`);
    }

    L.spritesheet("sc-warrior", "assets/showcase/warrior.webp", {
      frameHeight: 192,
      frameWidth: 192,
    });
    L.spritesheet("sc-lancer", "assets/showcase/lancer.webp", {
      frameHeight: 320,
      frameWidth: 320,
    });
    L.spritesheet("sc-pawn", "assets/showcase/pawn.webp", { frameHeight: 192, frameWidth: 192 });
    L.spritesheet("sc-foam", "assets/terrain/foam.webp", { frameHeight: 192, frameWidth: 192 });
    L.image("sc-shadow", "assets/terrain/shadow.webp");
    L.once(Loader.Events.COMPLETE, () => {
      this.renderMap();
    });
    L.start();
  }

  private renderMap() {
    const COLS = 25;
    const ROWS = MAP_MASK.length;
    const Wpx = COLS * CELL;
    const Hpx = ROWS * CELL;

    this.registerMapAnims();

    if (this.textures.exists("t-water")) {
      this.add.tileSprite(0, 0, Wpx, Hpx, "t-water").setOrigin(0, 0).setDepth(-1000);
    } else {
      this.add.rectangle(0, 0, Wpx, Hpx, 0x3a_8f_8a).setOrigin(0, 0).setDepth(-1000);
    }

    this.buildMapFoam(COLS, ROWS);
    this.buildMapGround(COLS, ROWS, false, -900);
    this.buildMapShadows(COLS, ROWS);
    this.buildMapGround(COLS, ROWS, true, -860);
    this.buildMapWash(COLS, ROWS);
    this.buildMapCliffs(COLS, ROWS);
    this.buildMapStairs();
    this.buildMapObjects();

    const cam = this.cameras.main;
    cam.setBackgroundColor("#3a8f8a");
    cam.setZoom(Math.min(1, this.scale.width / Wpx, this.scale.height / Hpx));
    cam.centerOn(Wpx / 2, Hpx / 2);
  }

  private registerMapAnims() {
    if (this.textures.exists("sc-foam") && !this.anims.exists("sc-foam-anim")) {
      this.anims.create({
        frameRate: 9,
        frames: this.anims.generateFrameNumbers("sc-foam", { end: 15, start: 0 }),
        key: "sc-foam-anim",
        repeat: -1,
      });
    }

    if (this.textures.exists("t-tree") && !this.anims.exists("tree-sway")) {
      this.anims.create({
        frameRate: 5,
        frames: this.anims.generateFrameNumbers("t-tree", { end: 5, start: 0 }),
        key: "tree-sway",
        repeat: -1,
      });
    }
  }

  private buildMapGround(cols: number, rows: number, elevated: boolean, depth: number) {
    if (!this.textures.exists("sc-tiles-img")) {
      return;
    }

    const inSet = (cx: number, cy: number) =>
      elevated
        ? GalleryScene.high(cx, cy)
        : GalleryScene.land(cx, cy) && !GalleryScene.high(cx, cy);

    const out = (cx: number, cy: number) =>
      elevated ? !GalleryScene.high(cx, cy) : !GalleryScene.land(cx, cy);

    const data: number[][] = [];

    for (let cy = 0; cy < rows; cy += 1) {
      const row: number[] = [];

      for (let cx = 0; cx < cols; cx += 1) {
        row.push(inSet(cx, cy) ? autotileFrame(elevated, autotileMask(out, cx, cy)) : -1);
      }

      data.push(row);
    }

    const map = this.make.tilemap({ data, tileHeight: CELL, tileWidth: CELL });
    const tiles = map.addTilesetImage(elevated ? "tilesE" : "tilesF", "sc-tiles-img");

    if (tiles) {
      map.createLayer(0, tiles, 0, 0)?.setDepth(depth);
    }
  }

  private buildMapWash(cols: number, rows: number) {
    const wash = this.add.graphics().setDepth(-855).setBlendMode(BlendModes.MULTIPLY);
    wash.fillStyle(0xff_e2_b8, 0.45);

    for (let cy = 0; cy < rows; cy += 1) {
      for (let cx = 0; cx < cols; cx += 1) {
        if (GalleryScene.land(cx, cy)) {
          wash.fillRect(cx * CELL, cy * CELL, CELL, CELL);
        }
      }
    }
  }

  private buildMapFoam(cols: number, rows: number) {
    if (!this.textures.exists("sc-foam")) {
      return;
    }

    for (let cy = 0; cy < rows; cy += 1) {
      for (let cx = 0; cx < cols; cx += 1) {
        if (GalleryScene.land(cx, cy)) {
          continue;
        }

        const touches = (
          [
            [-1, 0],
            [1, 0],
            [0, -1],
            [0, 1],
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
          ] satisfies [number, number][]
        ).some(([dx, dy]) => GalleryScene.land(cx + dx, cy + dy));

        if (!touches) {
          continue;
        }

        const f = this.add
          .sprite(cx * CELL + CELL / 2, cy * CELL + CELL / 2, "sc-foam", 0)
          .setDepth(-950);

        if (this.anims.exists("sc-foam-anim")) {
          f.play({ key: "sc-foam-anim", startFrame: (cx * 7 + cy * 5) % 16 });
        }
      }
    }
  }

  private buildMapShadows(cols: number, rows: number) {
    if (!this.textures.exists("sc-shadow")) {
      return;
    }

    for (let cy = 0; cy < rows; cy += 1) {
      for (let cx = 0; cx < cols; cx += 1) {
        if (!GalleryScene.high(cx, cy)) {
          continue;
        }

        this.add
          .image(cx * CELL + CELL / 2, (cy + 1) * CELL + CELL / 2, "sc-shadow")
          .setDepth(-880)
          .setAlpha(0.8);
      }
    }
  }

  private buildMapStairs() {
    if (!this.textures.exists("sc-tiles")) {
      return;
    }

    const stairs: [number, number, "L" | "R"][] = [
      [4, 5, "L"],
      [13, 9, "R"],
      [4, 11, "L"],
      [13, 14, "R"],
    ];

    for (const [tx, ty, side] of stairs) {
      const top = side === "L" ? SLOPE_FRAMES.leftTop : SLOPE_FRAMES.rightTop;
      const bot = side === "L" ? SLOPE_FRAMES.leftBot : SLOPE_FRAMES.rightBot;
      this.add.image(tx * CELL + CELL / 2, ty * CELL + CELL / 2, "sc-tiles", top).setDepth(-845);
      this.add
        .image(tx * CELL + CELL / 2, (ty + 1) * CELL + CELL / 2, "sc-tiles", bot)
        .setDepth(-845);
    }
  }

  private buildMapCliffs(cols: number, rows: number) {
    if (!this.textures.exists("sc-tiles")) {
      return;
    }

    for (let cy = 0; cy < rows; cy += 1) {
      for (let cx = 0; cx < cols; cx += 1) {
        if (!GalleryScene.high(cx, cy) || GalleryScene.high(cx, cy + 1)) {
          continue;
        }

        const cxp = cx * CELL + CELL / 2;
        const leftEnd = !GalleryScene.high(cx - 1, cy) || GalleryScene.high(cx - 1, cy + 1);
        const rightEnd = !GalleryScene.high(cx + 1, cy) || GalleryScene.high(cx + 1, cy + 1);
        let end: "L" | "M" | "Narrow" | "R" = "M";

        if (leftEnd && rightEnd) {
          end = "Narrow";
        } else if (leftEnd) {
          end = "L";
        } else if (rightEnd) {
          end = "R";
        }

        this.add
          .image(cxp, (cy + 1) * CELL + CELL / 2, "sc-tiles", CLIFF_FRAMES[`top${end}`])
          .setDepth(-850);
        this.add
          .image(cxp, (cy + 2) * CELL + CELL / 2, "sc-tiles", CLIFF_FRAMES[`bot${end}`])
          .setDepth(-850);
      }
    }
  }

  private buildMapObjects() {
    const building = (tex: string, tx: number, ty: number) => {
      if (!this.textures.exists(tex)) {
        return;
      }

      const [x, y] = tileToWorld(tx, ty);
      GalleryScene.placed(this.add.image(x, y, tex).setOrigin(0.5, 0.85), y);
    };

    building("sc-castle", 3, 3.2);
    building("sc-tower", 1.6, 9.8);
    building("sc-tower", 8.6, 15.8);
    const HOUSES = ["sc-house1", "sc-house2", "sc-house3"];

    const HOUSE_SPOTS: readonly [number, number][] = [
      [13.6, 5],
      [15.4, 4.8],
      [14.5, 6.2],
      [16.5, 5.8],
      [11.6, 11.8],
    ];

    for (const [i, [tx, ty]] of HOUSE_SPOTS.entries()) {
      building(HOUSES[i % HOUSES.length] ?? "sc-house1", tx, ty);
    }

    const unit = (tex: string, tx: number, ty: number) => {
      if (!this.textures.exists(tex)) {
        return;
      }

      const scale = tex === "sc-lancer" ? 0.72 : 0.9;
      const [x, y] = tileToWorld(tx, ty);
      GalleryScene.placed(
        this.add
          .image(x, y + 10, "shadow")
          .setScale(0.7)
          .setAlpha(0.4),
        y,
        -1,
      );
      GalleryScene.placed(this.add.image(x, y, tex, 0).setScale(scale).setOrigin(0.5, 0.78), y);
    };

    for (const [tx, ty] of [
      [6.4, 1.8],
      [7.2, 1.4],
      [7.9, 2],
      [6.6, 2.8],
      [7.5, 3.2],
      [6, 2.4],
    ] satisfies [number, number][]) {
      unit("sc-lancer", tx, ty);
    }

    unit("sc-warrior", 7.2, 5.2);
    unit("sc-warrior", 4.2, 13.2);
    unit("sc-warrior", 11.2, 14.2);
    unit("sc-pawn", 16, 11.4);

    const tree = (tx: number, ty: number, scale: number, tint?: number) => {
      if (!this.textures.exists("t-tree")) {
        return;
      }

      const [x, y] = tileToWorld(tx, ty);

      const spr = GalleryScene.placed(
        this.add.sprite(x, y, "t-tree", 0).setScale(scale).setOrigin(0.5, 0.9),
        y,
      );

      if (tint !== undefined) {
        spr.setTint(tint);
      }

      if (this.anims.exists("tree-sway")) {
        spr.play({ key: "tree-sway", startFrame: Math.floor((tx * 2 + ty) % 6) });
      }
    };

    for (const [tx, ty] of [
      [8.8, 0.8],
      [9.6, 0.5],
      [10.4, 0.8],
      [11.2, 0.5],
      [12, 0.9],
      [12.9, 0.6],
      [17.4, 0.8],
      [18.3, 1.6],
      [19, 0.7],
    ] satisfies [number, number][]) {
      tree(tx, ty, 1.15);
    }

    const AUTUMN = [0xf4_d2_4a, 0xe9_a2_3a, 0xf2_c1_4e, 0xe6_b3_4a];

    for (const [tx, ty, n] of [
      [0.7, 1.8, 0],
      [0.9, 3.2, 1],
      [0.6, 4.6, 2],
      [1, 6, 3],
      [17.6, 12, 0],
      [18.6, 13.4, 1],
      [19.3, 11.6, 2],
      [20, 13, 3],
      [13, 16, 0],
      [4.6, 16.2, 1],
      [22, 8.4, 2],
    ] satisfies [number, number, number][]) {
      tree(tx, ty, 1, AUTUMN[n % AUTUMN.length]);
    }

    for (const [tx, ty] of [
      [17.6, 6.6],
      [19, 6],
      [16.2, 8.6],
      [12.8, 9.6],
      [15, 13],
    ] satisfies [number, number][]) {
      if (!this.textures.exists("sheep")) {
        break;
      }

      const [x, y] = tileToWorld(tx, ty);

      const spr = GalleryScene.placed(
        this.add.sprite(x, y, "sheep", 0).setScale(0.5).setOrigin(0.5, 0.8),
        y,
      );

      if (this.anims.exists("sheep-idle")) {
        spr.play("sheep-idle");
      }
    }

    for (const [tx, ty, n] of [
      [3.5, 5.5, 1],
      [13.5, 17, 2],
      [2.5, 16, 3],
      [23, 9, 4],
      [10.5, 9.5, 1],
    ] satisfies [number, number, number][]) {
      const tex = `deco-rock${n}`;

      if (!this.textures.exists(tex)) {
        continue;
      }

      const [x, y] = tileToWorld(tx, ty);
      GalleryScene.placed(this.add.image(x, y, tex).setScale(0.7), y);
    }

    this.buildMapSign();
  }

  private buildMapSign() {
    const x = 21.4 * CELL;
    const y = 1.35 * CELL;
    const g = this.add.graphics().setDepth(100_000);
    g.fillStyle(0x4a_55_62, 1).fillRoundedRect(x - 165, y - 64, 330, 128, 18);
    g.fillStyle(0x2f_37_42, 1).fillRoundedRect(x - 153, y - 52, 306, 104, 13);
    g.fillStyle(0xe9_dc_b8, 1).fillRoundedRect(x - 141, y - 40, 282, 80, 10);
    g.lineStyle(3, 0x9b_8a_5e, 1).strokeRoundedRect(x - 141, y - 40, 282, 80, 10);
    this.add
      .text(x, y, "Eldermoor", {
        color: "#b23a3a",
        fontSize: "42px",
        fontStyle: "bold italic",
        stroke: "#6a1f1f",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(100_001);
  }
}
