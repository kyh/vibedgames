import Phaser from "phaser";
import { CROP_ORDER } from "../data/crops";
import {
  CELL,
  type Cell,
  classifyLandIndex,
  classifyPathIndex,
  isDecoSolidIndex,
  tileIndex,
  layerByName,
  type WorldMap,
} from "../world/worldmap";
import { getWorldMap } from "../world/map-store";

// Asset inspection page (open the game with ?gallery). Every tile index the
// world map actually uses, with its gameplay classification; every placed
// deco sprite with its animation; character/animal/crop sheets. Click any
// cell to pin its details in the top bar.

const CLASS_COLOR: Record<Cell, number> = {
  [CELL.void]: 0x16324f,
  [CELL.grass]: 0x3fae49,
  [CELL.sand]: 0xe8d36a,
  [CELL.dirt]: 0xa9744a,
  [CELL.water]: 0x3fc6e8,
  [CELL.solid]: 0xe84a4a,
};
const CLASS_NAME: Record<Cell, string> = {
  [CELL.void]: "void",
  [CELL.grass]: "grass",
  [CELL.sand]: "sand",
  [CELL.dirt]: "dirt",
  [CELL.water]: "water",
  [CELL.solid]: "solid",
};
const PATH_COLOR = { solid: 0xe84a4a, walk: 0xa9744a, overlay: 0x888888 } as const;

export class GalleryScene extends Phaser.Scene {
  private cursorY = 0;
  private info: Phaser.GameObjects.Text | null = null;

  constructor() {
    super("Gallery");
  }

  create(): void {
    document.getElementById("veil")?.classList.add("hidden");
    this.cursorY = 0;
    this.cameras.main.setBackgroundColor(0x1d1f27);
    const map = getWorldMap();

    this.header(
      "FARM ASSET GALLERY — wheel/arrows scroll, click a cell to inspect. " +
        "Border = gameplay class: green walk/till, yellow sand, brown dirt/walkway, " +
        "blue water (blocks, fishable), red solid, gray overlay (inherits land).",
    );

    this.tileSection(map, "land", (i) => {
      const c = classifyLandIndex(i);
      return { color: CLASS_COLOR[c], label: CLASS_NAME[c] };
    });
    this.tileSection(map, "paths", (i) => {
      const c = classifyPathIndex(i);
      return { color: PATH_COLOR[c], label: `path ${c}` };
    });
    for (const name of ["decoration_01", "decoration_02", "decoration_03"]) {
      this.tileSection(map, name, (i) =>
        isDecoSolidIndex(i)
          ? { color: CLASS_COLOR[CELL.solid], label: "solid prop" }
          : { color: 0x888888, label: "dressing" },
      );
    }
    for (const name of ["building", "walls", "forest"]) {
      this.tileSection(map, name, () => ({
        color: CLASS_COLOR[CELL.solid],
        label: "structure (solid)",
      }));
    }

    this.decoSpriteSection(map);
    this.sheetSection();

    const maxScroll = Math.max(0, this.cursorY + 40 - this.scale.height);
    const cam = this.cameras.main;
    this.input.on("wheel", (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      cam.scrollY = Phaser.Math.Clamp(cam.scrollY + dy, 0, maxScroll);
    });
    const kb = this.input.keyboard;
    if (kb) {
      kb.on("keydown-UP", () => (cam.scrollY = Phaser.Math.Clamp(cam.scrollY - 60, 0, maxScroll)));
      kb.on(
        "keydown-DOWN",
        () => (cam.scrollY = Phaser.Math.Clamp(cam.scrollY + 60, 0, maxScroll)),
      );
    }

    // pinned info bar on top of everything
    this.add
      .rectangle(0, 0, this.scale.width, 26, 0x000000, 0.85)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(10);
    this.info = this.add
      .text(8, 6, "click a cell…", { fontFamily: "monospace", fontSize: "12px", color: "#9ee" })
      .setScrollFactor(0)
      .setDepth(11);
  }

  private header(text: string): void {
    this.cursorY += 34;
    this.add.text(12, this.cursorY, text, {
      fontFamily: "monospace",
      fontSize: "11px",
      color: "#ccc",
      wordWrap: { width: this.scale.width - 24 },
    });
    this.cursorY += 44;
  }

  private title(text: string): void {
    this.cursorY += 14;
    this.add.text(12, this.cursorY, text, {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#fff",
      fontStyle: "bold",
    });
    this.cursorY += 24;
  }

  // all indices a tile layer uses, sorted, each with art + class border
  private tileSection(
    map: WorldMap,
    layerName: string,
    classify: (idx: number) => { color: number; label: string },
  ): void {
    const layer = layerByName(map, layerName);
    if (!layer) return;
    const counts = new Map<number, number>();
    for (const v of layer.grid) {
      if (v < 0) continue;
      const idx = tileIndex(v);
      counts.set(idx, (counts.get(idx) ?? 0) + 1);
    }
    const indices = [...counts.keys()].sort((a, b) => a - b);
    this.title(`${layerName} — ${indices.length} tile indices`);

    const cellW = 64;
    const cellH = 76;
    const cols = Math.floor((this.scale.width - 24) / cellW);
    indices.forEach((idx, n) => {
      const x = 12 + (n % cols) * cellW + cellW / 2;
      const y = this.cursorY + Math.floor(n / cols) * cellH + 24;
      const { color, label } = classify(idx);
      this.add.rectangle(x, y, 52, 52, 0x000000, 0.25).setStrokeStyle(2, color);
      const img = this.add.image(x, y, "atlas-sheet", idx).setScale(3);
      this.add
        .text(x, y + 30, String(idx), {
          fontFamily: "monospace",
          fontSize: "10px",
          color: "#aaa",
        })
        .setOrigin(0.5, 0);
      img.setInteractive();
      img.on("pointerdown", () =>
        this.pin(`${layerName} idx ${idx} — ${label}, used ${counts.get(idx) ?? 0}×`),
      );
    });
    this.cursorY += Math.ceil(indices.length / cols) * cellH + 12;
  }

  // every placed GM sprite, animating like in the world
  private decoSpriteSection(map: WorldMap): void {
    const placed = new Map<string, number>();
    for (const s of map.sprites) placed.set(s.sprite, (placed.get(s.sprite) ?? 0) + 1);
    const names = Object.keys(map.deco).sort();
    this.title(`deco sprites — ${names.length} baked (label: placements × frames)`);

    const cellW = 130;
    const cellH = 130;
    const cols = Math.floor((this.scale.width - 24) / cellW);
    names.forEach((name, n) => {
      const def = map.deco[name];
      if (!def) return;
      const x = 12 + (n % cols) * cellW + cellW / 2;
      const y = this.cursorY + Math.floor(n / cols) * cellH + 52;
      this.add.rectangle(x, y, cellW - 10, 104, 0x000000, 0.25).setStrokeStyle(1, 0x555555);
      if (!this.textures.get("deco-atlas").has(`${name}/0`)) return;
      const spr = this.add.sprite(x, y, "deco-atlas", `${name}/0`);
      const scale = Math.min(2.5, 92 / Math.max(def.fw, def.fh));
      spr.setScale(scale);
      if (def.frames > 1 && this.anims.exists(`deco-${name}`)) spr.play(`deco-${name}`);
      const short = name.replace(/^spr_deco_/, "");
      this.add
        .text(x, y + 56, `${short}\n${placed.get(name) ?? 0}× · ${def.frames}f`, {
          fontFamily: "monospace",
          fontSize: "9px",
          color: "#aaa",
          align: "center",
        })
        .setOrigin(0.5, 0);
      spr.setInteractive();
      spr.on("pointerdown", () =>
        this.pin(
          `${name} — ${def.fw}x${def.fh}, origin (${def.ox},${def.oy}), ` +
            `${def.frames} frames @${def.fps}fps, placed ${placed.get(name) ?? 0}×`,
        ),
      );
    });
    this.cursorY += Math.ceil(names.length / cols) * cellH + 12;
  }

  // characters, enemies, animals, crops
  private sheetSection(): void {
    this.title("characters · animals · crops");
    const y0 = this.cursorY + 60;
    const entries: Array<{ label: string; make: (x: number, y: number) => void }> = [
      { label: "player idle", make: (x, y) => this.anim(x, y, "p-idle", 2) },
      { label: "player walk", make: (x, y) => this.anim(x, y, "p-walk", 2) },
      { label: "player axe", make: (x, y) => this.anim(x, y, "p-axe", 2) },
      { label: "skeleton", make: (x, y) => this.anim(x, y, "e-skel-walk", 2) },
      { label: "chicken", make: (x, y) => this.anim(x, y, "chicken-walk", 2) },
      { label: "cow", make: (x, y) => this.anim(x, y, "cow-idle", 2) },
      { label: "pig", make: (x, y) => this.anim(x, y, "pig-idle", 2) },
      { label: "sheep", make: (x, y) => this.anim(x, y, "sheep-idle", 2) },
      { label: "duck", make: (x, y) => this.anim(x, y, "duck-walk", 3) },
      { label: "mushroom", make: (x, y) => this.anim(x, y, "mushroom-red-bob", 3) },
    ];
    const cellW = 110;
    entries.forEach((e, n) => {
      const x = 12 + n * cellW + cellW / 2;
      e.make(x, y0);
      this.add
        .text(x, y0 + 44, e.label, { fontFamily: "monospace", fontSize: "10px", color: "#aaa" })
        .setOrigin(0.5, 0);
    });
    this.cursorY = y0 + 70;

    // crop growth rows
    for (const c of CROP_ORDER) {
      const y = this.cursorY + 24;
      this.add
        .text(12, y - 8, c, { fontFamily: "monospace", fontSize: "10px", color: "#aaa" })
        .setOrigin(0, 0);
      for (let f = 0; f < 6; f++) {
        this.add.image(110 + f * 56 + 24, y, `crop-${c}`, f).setScale(2.5);
      }
      this.cursorY += 52;
    }
    this.cursorY += 20;
  }

  private anim(x: number, y: number, key: string, scale: number): void {
    const s = this.add.sprite(x, y, "__MISSING");
    s.setScale(scale);
    if (this.anims.exists(key)) s.play(key);
  }

  private pin(text: string): void {
    if (this.info) this.info.setText(text);
    console.log(`[gallery] ${text}`);
  }
}
