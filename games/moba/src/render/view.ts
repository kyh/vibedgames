import Phaser from "phaser";

import {
  BASES,
  BRIDGES,
  GRID,
  NEUTRAL_CAMPS,
  TOWERS,
  TREE_CLUSTERS,
  WORLD,
  isCliffCell,
  isHighCell,
  isLandCell,
} from "../data/map";
import type { Team } from "../data/config";
import type { World, Unit, Projectile, GroundEffect, FxEvent } from "../sim/types";
import { sfx } from "./audio";
import { animKey, structureDestroyedTex, unitSprite } from "./sprites";

const CELL = 64;
const COLS = GRID.cols;
const ROWS = GRID.rows;

// Terrain depth bands, composed in the official tilemap-guide order: BG colour →
// water foam → flat ground → drop shadow → elevated ground → cliff faces. All sit
// far below unit depths (= their y, ≥ 0).
const D_WATER = -130;
const D_FOAM = -116;
const D_FLAT = -110;
const D_SHADOW = -105;
const D_ELEV = -100;
const D_CLIFF = -95;
const D_WASH = -92;
const D_RING = -90;
const D_BRIDGE_SHADOW = -89;
const D_BRIDGE = -84; // minus a per-strip index (northern strips on top), stays above the shadow
const DEPTH_DECAL = -50;

// Free Pack tileset autotile (9-wide sheet) — same mapping the ?gallery=map
// reference rebuild verified tile-by-tile against the promo. Keyed by which
// orthogonal neighbours are OUTSIDE the set: N=8,E=4,S=2,W=1.
const FLAT_TILE: Record<number, number> = {
  0: 10, 8: 1, 4: 11, 2: 19, 1: 9, 9: 0, 12: 2, 3: 18, 6: 20, 5: 12, 10: 28,
  13: 3, 7: 21, 11: 27, 14: 29, 15: 30,
};
// Elevated grass is the identical autotile shifted 5 columns right.
const ELEV_TILE: Record<number, number> = Object.fromEntries(
  Object.entries(FLAT_TILE).map(([k, v]) => [Number(k), v + 5]),
);
// Stone cliff faces (2 rows tall) under a plateau's south edge.
const CLIFF = { topL: 41, topM: 42, topR: 43, topNarrow: 44, botL: 50, botM: 51, botR: 52, botNarrow: 53 };
// Bridge_All frames: 0/1/2 = horizontal left-cap/middle/right-cap, 11 = shadow.
const BRIDGE_L = 0;
const BRIDGE_M = 1;
const BRIDGE_R = 2;
const BRIDGE_SHADOW = 11;

/** Deterministic 0..1 hash so decoration scatter is stable across reloads/peers. */
function rng2(x: number, y: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

type UnitView = {
  container: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Image;
  ring: Phaser.GameObjects.Graphics;
  hpBg: Phaser.GameObjects.Rectangle;
  hpFill: Phaser.GameObjects.Rectangle;
  mpFill: Phaser.GameObjects.Rectangle | null;
  label: Phaser.GameObjects.Text | null;
  dx: number;
  dy: number;
  curAnim: string;
  lastAttackAt: number; // detect a fresh swing to play the attack anim once
  lastDustAt: number; // throttle the running dust puffs
  dead: boolean; // playing/played the death anim while hidden (heroes)
};

type StructView = {
  sprite: Phaser.GameObjects.Image;
  hpBg: Phaser.GameObjects.Rectangle;
  hpFill: Phaser.GameObjects.Rectangle;
  range: Phaser.GameObjects.Arc | null;
  fires: Phaser.GameObjects.Sprite[]; // burning-damage flames, count scales with lost HP
  dead: boolean;
};

export class WorldView {
  private scene: Phaser.Scene;
  private units = new Map<string, UnitView>();
  private structs = new Map<string, StructView>();
  private projs = new Map<string, Phaser.GameObjects.Image>();
  private grounds = new Map<string, Phaser.GameObjects.Arc>();
  private mines = new Map<string, Phaser.GameObjects.Arc>();
  private shoreCells: Array<{ x: number; y: number }> = []; // water cells touching land, for ambient splashes
  private splashAcc = 0;
  playerHeroId = "";
  playerTeam: "radiant" | "dire" = "radiant";

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  buildTerrain(): void {
    const s = this.scene;

    // 1) open water everywhere underneath
    s.add.tileSprite(0, 0, WORLD.width, WORLD.height, "t-water").setOrigin(0, 0).setDepth(D_WATER);

    // 2) animated foam lapping every shoreline (under the grass edge tiles)
    this.buildFoam();

    // 3) flat grass islands as one autotiled tilemap layer
    this.buildGroundLayer(false, D_FLAT);

    // 4) plateau drop shadows, elevated grass tops, then their stone cliff faces
    this.buildPlateauShadows();
    this.buildGroundLayer(true, D_ELEV);
    this.buildCliffs();

    // 5) warm multiply wash nudging the tileset green toward the promo's olive
    this.buildWash();

    // 6) wooden bridges across the channel
    this.buildBridges();

    // 7) fountains (glowing pools at each base) + a couple of village houses
    for (const team of ["radiant", "dire"] as const) {
      const b = BASES[team];
      const col = team === "radiant" ? 0x4fa3ff : 0xff5a4a;
      s.add.circle(b.fountain.x, b.fountain.y, b.fountainRadius, col, 0.05).setDepth(D_RING);
      s.add.circle(b.fountain.x, b.fountain.y, 80, 0x2f6f9e, 0.85).setStrokeStyle(5, 0x9fd0ff, 0.7).setDepth(DEPTH_DECAL);
      s.add.circle(b.fountain.x, b.fountain.y, 46, 0x9fd0ff, 0.5).setDepth(DEPTH_DECAL);
      const houseTex = `b-house-${team === "radiant" ? "blue" : "red"}`;
      if (s.textures.exists(houseTex)) {
        const sign = team === "radiant" ? 1 : -1;
        for (const [hx, hy] of [
          [b.fountain.x + sign * 80, b.fountain.y - 230],
          [b.fountain.x + sign * 70, b.fountain.y + 250],
        ] as const) {
          if (!isLandCell(Math.floor(hx / CELL), Math.floor(hy / CELL))) continue;
          s.add.image(hx, hy, houseTex).setOrigin(0.5, 0.8).setDepth(hy);
        }
      }
    }

    // 8) jungle trees (depth-sorted so heroes weave between them)
    this.buildTrees();

    // 9) scattered rocks / animated bushes / mushrooms for texture
    this.buildScatter();

    // 10) subtle marker rings at each neutral camp so the jungle reads as farmable
    for (const c of NEUTRAL_CAMPS) {
      const boss = c.kind === "roshan";
      s.add
        .circle(c.x, c.y, boss ? 130 : 70, 0x000000, 0)
        .setStrokeStyle(boss ? 4 : 3, boss ? 0x8a3a2a : 0x4a6a34, boss ? 0.4 : 0.3)
        .setDepth(D_RING);
    }

    // 11) animated rocks dotting the water, drifting clouds, grazing sheep
    this.buildWaterRocks();
    this.buildClouds();
    this.buildAmbientLife();
  }

  /** Animated 192px foam sprites on every water cell touching land — the guide's
   *  recipe: oversized sprites on the 64 grid, each starting at a different frame. */
  private buildFoam(): void {
    const s = this.scene;
    const hasFoam = s.textures.exists("foam");
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (isLandCell(cx, cy)) continue;
        const touches = (
          [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]] as Array<[number, number]>
        ).some(([dx, dy]) => isLandCell(cx + dx, cy + dy));
        if (!touches) continue;
        const x = cx * CELL + CELL / 2;
        const y = cy * CELL + CELL / 2;
        this.shoreCells.push({ x, y });
        if (!hasFoam) continue;
        const f = s.add.sprite(x, y, "foam", 0).setDepth(D_FOAM);
        if (s.anims.exists("foam-loop")) f.play({ key: "foam-loop", startFrame: (cx * 7 + cy * 5) % 16 });
      }
    }
  }

  /** Flat (elevated=false) or plateau-top (true) grass autotile as one layer. */
  private buildGroundLayer(elevated: boolean, depth: number): void {
    const s = this.scene;
    if (!s.textures.exists("tiles-img")) return;
    const inSet = (cx: number, cy: number): boolean =>
      elevated ? isHighCell(cx, cy) : isLandCell(cx, cy) && !isHighCell(cx, cy);
    const out = (cx: number, cy: number): boolean => (elevated ? !isHighCell(cx, cy) : !isLandCell(cx, cy));
    const data: number[][] = [];
    for (let cy = 0; cy < ROWS; cy++) {
      const row: number[] = [];
      for (let cx = 0; cx < COLS; cx++) {
        if (!inSet(cx, cy)) {
          row.push(-1);
          continue;
        }
        const k =
          (out(cx, cy - 1) ? 8 : 0) | (out(cx + 1, cy) ? 4 : 0) | (out(cx, cy + 1) ? 2 : 0) | (out(cx - 1, cy) ? 1 : 0);
        row.push((elevated ? ELEV_TILE[k] : FLAT_TILE[k]) ?? (elevated ? 15 : 10));
      }
      data.push(row);
    }
    const map = s.make.tilemap({ data, tileWidth: CELL, tileHeight: CELL });
    const tiles = map.addTilesetImage(elevated ? "tilesE" : "tilesF", "tiles-img");
    if (tiles) map.createLayer(0, tiles, 0, 0)?.setDepth(depth);
  }

  /** Drop shadow under the elevated footprint, shifted one tile down (the guide's
   *  layering: between the flat and elevated ground layers). */
  private buildPlateauShadows(): void {
    const s = this.scene;
    if (!s.textures.exists("tshadow")) return;
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (!isHighCell(cx, cy)) continue;
        s.add.image(cx * CELL + CELL / 2, (cy + 1) * CELL + CELL / 2, "tshadow").setDepth(D_SHADOW).setAlpha(0.8);
      }
    }
  }

  /** Stone cliff faces (2 rows) below each plateau's south edge. */
  private buildCliffs(): void {
    const s = this.scene;
    if (!s.textures.exists("tiles")) return;
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (!isHighCell(cx, cy) || isHighCell(cx, cy + 1)) continue; // south edge only
        const cxp = cx * CELL + CELL / 2;
        // a wall run ends where the neighbour isn't itself a south-edge cell
        const leftEnd = !isHighCell(cx - 1, cy) || isHighCell(cx - 1, cy + 1);
        const rightEnd = !isHighCell(cx + 1, cy) || isHighCell(cx + 1, cy + 1);
        const narrow = leftEnd && rightEnd;
        const top = narrow ? CLIFF.topNarrow : leftEnd ? CLIFF.topL : rightEnd ? CLIFF.topR : CLIFF.topM;
        const bot = narrow ? CLIFF.botNarrow : leftEnd ? CLIFF.botL : rightEnd ? CLIFF.botR : CLIFF.botM;
        s.add.image(cxp, (cy + 1) * CELL + CELL / 2, "tiles", top).setDepth(D_CLIFF);
        s.add.image(cxp, (cy + 2) * CELL + CELL / 2, "tiles", bot).setDepth(D_CLIFF);
      }
    }
  }

  /** Multiply wash over the land, nudging the Free Pack green toward the promo olive. */
  private buildWash(): void {
    const wash = this.scene.add.graphics().setDepth(D_WASH).setBlendMode(Phaser.BlendModes.MULTIPLY);
    wash.fillStyle(0xffe2b8, 0.45);
    for (let cy = 0; cy < ROWS; cy++) {
      let run = -1;
      for (let cx = 0; cx <= COLS; cx++) {
        const land = cx < COLS && isLandCell(cx, cy);
        if (land && run < 0) run = cx;
        if (!land && run >= 0) {
          wash.fillRect(run * CELL, cy * CELL, (cx - run) * CELL, CELL);
          run = -1;
        }
      }
    }
  }

  /** Wooden plank bridges with the kit's flat shadow square on the water beneath.
   *  Each strip of the art is one tile tall with posts along its top edge, so a
   *  wide crossing is built from overlapping strips every half tile, northern
   *  strips drawn on top — continuous planking, posts only on the outer rail. */
  private buildBridges(): void {
    const s = this.scene;
    if (!s.textures.exists("t-bridge")) return;
    for (const b of BRIDGES) {
      for (let cy = b.y0; cy <= b.y1; cy++) {
        for (let cx = b.x0; cx <= b.x1; cx++) {
          if (isLandCell(cx, cy)) continue;
          s.add.image(cx * CELL + CELL / 2, cy * CELL + CELL / 2 + 14, "t-bridge", BRIDGE_SHADOW)
            .setDepth(D_BRIDGE_SHADOW)
            .setAlpha(0.55);
        }
      }
      const yTop = b.y0 * CELL + CELL / 2;
      const yBot = b.y1 * CELL + CELL / 2;
      for (let y = yTop, i = 0; y <= yBot; y += CELL / 2, i++) {
        for (let cx = b.x0; cx <= b.x1; cx++) {
          const frame = cx === b.x0 ? BRIDGE_L : cx === b.x1 ? BRIDGE_R : BRIDGE_M;
          s.add.image(cx * CELL + CELL / 2, y, "t-bridge", frame).setDepth(D_BRIDGE - i);
        }
      }
    }
  }

  private buildTrees(): void {
    const s = this.scene;
    const deciduous = [1, 2, 3, 4].filter((i) => s.textures.exists(`ftree${i}`));
    const hasPine = s.textures.exists("t-tree");
    const AUTUMN = [0xf4d24a, 0xe9a23a, 0xf2c14e, 0xe6b34a];

    const plant = (tx: number, ty: number, seed: number): void => {
      const cx = Math.floor(tx / CELL);
      const cy = Math.floor(ty / CELL);
      if (!isLandCell(cx, cy) || isCliffCell(cx, cy)) return;
      s.add.image(tx, ty + 6, "shadow").setDisplaySize(74, 26).setAlpha(0.4).setDepth(ty - 1);
      const pick = rng2(tx + seed, ty - seed);
      if (hasPine && (pick < 0.45 || deciduous.length === 0)) {
        const tree = s.add.sprite(tx, ty, "t-tree", 0).setOrigin(0.5, 0.86).setScale(0.95 + pick * 0.3).setDepth(ty);
        if (pick < 0.12) tree.setTint(AUTUMN[Math.floor(rng2(ty, tx) * AUTUMN.length) % AUTUMN.length]);
        if (s.anims.exists("tree-sway")) tree.play({ key: "tree-sway", startFrame: Math.floor(rng2(ty, tx) * 6) });
      } else {
        const kind = deciduous[Math.floor(rng2(tx, ty) * deciduous.length) % deciduous.length] ?? 1;
        const tree = s.add.sprite(tx, ty, `ftree${kind}`, 0).setOrigin(0.5, 0.82).setScale(0.5 + pick * 0.14).setDepth(ty);
        if (s.anims.exists(`ftree${kind}-sway`)) tree.play({ key: `ftree${kind}-sway`, startFrame: Math.floor(rng2(ty, tx) * 8) });
      }
    };

    // clusters in the jungle pockets
    for (const t of TREE_CLUSTERS) {
      const n = Math.max(6, Math.floor(t.r / 24));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + (t.x % 7);
        const rr = t.r * (0.2 + 0.75 * rng2(t.x + i, t.y - i));
        plant(t.x + Math.cos(a) * rr, t.y + Math.sin(a) * rr, i);
      }
    }
    // sparse pines on the plateau tops so the heights read as wooded
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (!isHighCell(cx, cy) || rng2(cx * 3, cy * 5) > 0.16) continue;
        const tx = cx * CELL + CELL / 2 + (rng2(cx, cy + 1) - 0.5) * 40;
        const ty = cy * CELL + CELL / 2 + (rng2(cx + 1, cy) - 0.5) * 40;
        if (hasPine) {
          const tree = s.add.sprite(tx, ty, "t-tree", 0).setOrigin(0.5, 0.86).setScale(0.9).setDepth(ty);
          if (s.anims.exists("tree-sway")) tree.play({ key: "tree-sway", startFrame: Math.floor(rng2(ty, tx) * 6) });
        }
      }
    }
  }

  private buildScatter(): void {
    const s = this.scene;
    const step = 3; // every ~3 cells, maybe drop a decal
    for (let cy = 2; cy < ROWS - 2; cy += step) {
      for (let cx = 2; cx < COLS - 2; cx += step) {
        const r = rng2(cx, cy);
        if (r > 0.42) continue;
        // wide jitter so decals scatter naturally instead of in rows
        const x = cx * CELL + CELL / 2 + (rng2(cx + 9, cy) - 0.5) * step * CELL * 0.9;
        const y = cy * CELL + CELL / 2 + (rng2(cx, cy + 9) - 0.5) * step * CELL * 0.9;
        const ccx = Math.floor(x / CELL);
        const ccy = Math.floor(y / CELL);
        if (!isLandCell(ccx, ccy) || isCliffCell(ccx, ccy)) continue;
        // keep decals out of the base/fountain footprints
        const near = (fx: number, fy: number) => (x - fx) ** 2 + (y - fy) ** 2 < 420 * 420;
        if (near(BASES.radiant.fountain.x, BASES.radiant.fountain.y)) continue;
        if (near(BASES.dire.fountain.x, BASES.dire.fountain.y)) continue;
        if (r < 0.08) {
          const key = `deco-rock${1 + Math.floor(rng2(cx, cy + 3) * 4)}`;
          if (s.textures.exists(key)) s.add.image(x, y, key).setScale(0.7 + rng2(x, y) * 0.3).setDepth(y);
        } else if (r < 0.16) {
          // bushes are animated sway strips — one 128px frame each, never the sheet
          const n = 1 + Math.floor(rng2(cx + 3, cy) * 4);
          const key = `deco-bush${n}`;
          if (!s.textures.exists(key)) continue;
          const bush = s.add.sprite(x, y, key, 0).setScale(0.55 + rng2(x, y) * 0.25).setDepth(y);
          if (s.anims.exists(`${key}-sway`)) bush.play({ key: `${key}-sway`, startFrame: Math.floor(rng2(y, x) * 8) });
        } else {
          const key = `deco-${String(1 + Math.floor(rng2(cx + 5, cy + 5) * 18)).padStart(2, "0")}`;
          if (s.textures.exists(key)) s.add.image(x, y, key).setScale(0.8 + rng2(x, y) * 0.3).setDepth(y).setAlpha(0.95);
        }
      }
    }
  }

  /** Animated rocks scattered through the open water for detail. */
  private buildWaterRocks(): void {
    const s = this.scene;
    if (!s.textures.exists("wrock1")) return;
    for (let cy = 2; cy < ROWS - 2; cy += 2) {
      for (let cx = 2; cx < COLS - 2; cx += 2) {
        if (isLandCell(cx, cy)) continue;
        const r = rng2(cx * 2, cy * 2);
        if (r > 0.1) continue; // sparse
        const n = 1 + Math.floor(rng2(cx, cy + 7) * 4);
        const x = cx * CELL + CELL / 2;
        const y = cy * CELL + CELL / 2;
        const rk = s.add.sprite(x, y, `wrock${n}`, 0).setScale(0.55).setDepth(D_FOAM + 1).setAlpha(0.95);
        if (s.anims.exists(`wrock${n}-anim`)) rk.play({ key: `wrock${n}-anim`, startFrame: Math.floor(r * 8) });
      }
    }
  }

  /** Soft clouds drifting slowly across the map (depth above everything). */
  private buildClouds(): void {
    const s = this.scene;
    if (!s.textures.exists("cloud1")) return;
    const COUNT = 10;
    for (let i = 0; i < COUNT; i++) {
      const n = 1 + ((i * 3) % 8);
      const x = rng2(i * 13, 1) * WORLD.width;
      const y = rng2(1, i * 17) * WORLD.height;
      const c = s.add
        .image(x, y, `cloud${n}`)
        .setScale(0.7 + rng2(i, i) * 0.6)
        .setAlpha(0.45 + rng2(i, 3) * 0.25)
        .setDepth(9000); // above units, below HUD
      const dist = 600 + rng2(i, 9) * 900;
      s.tweens.add({ targets: c, x: x + dist, duration: 30000 + rng2(i, 5) * 30000, yoyo: true, repeat: -1, ease: "Sine.InOut" });
    }
  }

  /** Ambient grazing sheep on the grass — pure cosmetic life, wanders gently. */
  private buildAmbientLife(): void {
    const s = this.scene;
    if (!s.textures.exists("sheep")) return;
    const spots: Array<{ x: number; y: number }> = [
      { x: 1450, y: 850 }, { x: 950, y: 2250 }, { x: 2650, y: 2250 }, { x: 3150, y: 850 },
      { x: 2000, y: 1340 }, { x: 2120, y: 1700 }, { x: 620, y: 980 }, { x: 3480, y: 2100 },
    ];
    for (const p of spots) {
      if (!isLandCell(Math.floor(p.x / CELL), Math.floor(p.y / CELL))) continue;
      const sh = s.add.sprite(p.x, p.y, "sheep", 0).setScale(0.5).setDepth(p.y);
      if (s.anims.exists("sheep-idle")) sh.play({ key: "sheep-idle", startFrame: Math.floor(rng2(p.x, p.y) * 8) });
      // gentle wander
      s.tweens.add({ targets: sh, x: p.x + (rng2(p.x, 2) - 0.5) * 160, y: p.y + (rng2(2, p.y) - 0.5) * 120, duration: 6000 + rng2(p.x, p.y) * 6000, yoyo: true, repeat: -1, ease: "Sine.InOut", onUpdate: () => sh.setDepth(sh.y) });
    }
  }

  /** Build structure sprites from static map data (works before any world). */
  buildStructures(): void {
    const make = (id: string, team: Team, tier: string, x: number, y: number) => {
      const tex = tier === "ancient" ? `b-castle-${team === "radiant" ? "blue" : "red"}` : `b-tower-${team === "radiant" ? "blue" : "red"}`;
      const scale = tier === "ancient" ? 1.7 : tier === "base" ? 1.15 : 1.35;
      const hpY = tier === "ancient" ? 150 : 110;
      const w = tier === "ancient" ? 120 : 64;
      const sp = this.scene.add.image(x, y - 30, tex).setScale(scale).setDepth(y);
      const hpBg = this.scene.add.rectangle(x, y - hpY, w + 4, 9, 0x101522).setDepth(y + 1);
      const hpFill = this.scene.add.rectangle(x - w / 2, y - hpY, w, 7, teamHpColor(team)).setOrigin(0, 0.5).setDepth(y + 2);
      this.structs.set(id, { sprite: sp, hpBg, hpFill, range: null, fires: [], dead: false });
    };
    for (const t of TOWERS) make(t.id, t.team, t.tier, t.x, t.y);
    for (const team of ["radiant", "dire"] as Team[]) {
      make(team === "radiant" ? "r-ancient" : "d-ancient", team, "ancient", BASES[team].ancient.x, BASES[team].ancient.y);
    }
  }

  /** Per-frame sync of all dynamic objects to the world. */
  sync(world: World, dt: number): void {
    this.syncStructures(world);
    this.syncUnits(world, dt);
    this.syncProjectiles(world);
    this.syncGrounds(world);
    this.syncMines(world);
    this.drainFx(world);
    this.tickAmbientSplashes(dt);
  }

  /** Occasional water splashes along shorelines near the camera, for living water. */
  private tickAmbientSplashes(dt: number): void {
    this.splashAcc += dt;
    if (this.splashAcc < 0.55) return;
    this.splashAcc = 0;
    const s = this.scene;
    if (this.shoreCells.length === 0 || !s.anims.exists("fx-splash")) return;
    const view = s.cameras.main.worldView;
    for (let tries = 0; tries < 10; tries++) {
      const c = this.shoreCells[Math.floor(Math.random() * this.shoreCells.length)];
      if (!c || c.x < view.x - 100 || c.x > view.right + 100 || c.y < view.y - 100 || c.y > view.bottom + 100) continue;
      const sp = s.add.sprite(c.x + (Math.random() - 0.5) * 40, c.y + (Math.random() - 0.5) * 40, "fx-splash", 0)
        .setDepth(D_FOAM + 2)
        .setAlpha(0.9)
        .setScale(0.8 + Math.random() * 0.4);
      sp.play("fx-splash");
      sp.once("animationcomplete", () => sp.destroy());
      break;
    }
  }

  private syncStructures(world: World): void {
    for (const [id, sv] of this.structs) {
      const u = world.units.get(id);
      if (!u) continue;
      if (!u.alive && !sv.dead) {
        sv.dead = true;
        sv.sprite.setTexture(structureDestroyedTex(u.structure?.tier ?? "t1")).setAlpha(0.92);
        sv.hpBg.setVisible(false);
        sv.hpFill.setVisible(false);
        for (const f of sv.fires) f.destroy();
        sv.fires = [];
        continue;
      }
      if (u.alive) {
        const w = u.structure?.tier === "ancient" ? 120 : 64;
        sv.hpFill.width = Math.max(0, (u.hp / u.maxHp) * w);
        const attackable = u.structure?.attackable ?? true;
        sv.hpFill.setFillStyle(attackable ? teamHpColor(u.team) : 0x6a7488);
        this.syncStructureFires(u, sv);
      }
    }
  }

  /** Burning-damage flames on a structure: 1 below ~66% HP, 2 below ~33%. */
  private syncStructureFires(u: Unit, sv: StructView): void {
    const s = this.scene;
    const pct = u.hp / u.maxHp;
    const want = pct < 0.33 ? 2 : pct < 0.66 ? 1 : 0;
    while (sv.fires.length > want) sv.fires.pop()?.destroy();
    if (sv.fires.length >= want) return;
    const big = u.structure?.tier === "ancient";
    const offsets: Array<[number, number]> = big
      ? [[-50, -78], [44, -28]]
      : [[-17, -42], [19, -88]];
    while (sv.fires.length < want) {
      const i = sv.fires.length;
      const [ox, oy] = offsets[i] ?? [0, -60];
      const key = `fx-flame${1 + ((i + Math.abs(Math.round(u.x))) % 3)}`;
      if (!s.anims.exists(key)) return;
      const f = s.add.sprite(u.x + ox, u.y + oy, key, 0).setDepth(u.y + 3).setScale(big ? 2.3 : 1.8);
      f.play({ key, startFrame: (i * 3) % 8 });
      sv.fires.push(f);
    }
  }

  private syncUnits(world: World, dt: number): void {
    const seen = new Set<string>();
    for (const u of world.units.values()) {
      if (u.kind === "structure") continue;
      // dead heroes: play the death anim once, then hide until respawn
      if (!u.alive) {
        const v = this.units.get(u.id);
        if (v && !v.dead) {
          v.dead = true;
          const dkey = animKey(u, "death");
          v.sprite.clearTint();
          if (this.scene.anims.exists(dkey)) {
            v.sprite.play(dkey);
            v.curAnim = dkey;
            v.sprite.once("animationcomplete", () => this.collapseSprite(v.sprite, () => v.container.setVisible(false)));
          } else {
            // no death sheet — procedural collapse (topple + sink + fade)
            this.collapseSprite(v.sprite, () => v.container.setVisible(false));
          }
        }
        continue;
      }
      seen.add(u.id);
      let v = this.units.get(u.id);
      if (!v) v = this.createUnitView(u);
      if (v.dead) {
        // respawned — snap back so we don't slide from the death spot to base,
        // and undo the collapse transform (alpha/angle/local-y) the death applied.
        v.dead = false;
        v.dx = u.x;
        v.dy = u.y;
        v.curAnim = "";
        this.scene.tweens.killTweensOf(v.sprite);
        v.sprite.setAlpha(1).setAngle(0);
        v.sprite.y = -18;
      }
      v.container.setVisible(true);

      // smooth display position toward sim position — snappy enough to track the
      // 30Hz sim without floating, smooth enough to hide the step.
      const k = Math.min(1, dt * 18);
      v.dx = Phaser.Math.Linear(v.dx, u.x, k);
      v.dy = Phaser.Math.Linear(v.dy, u.y, k);
      v.container.setPosition(Math.round(v.dx), Math.round(v.dy));
      v.container.setDepth(v.dy);

      // running dust puffs at the feet (throttled per unit)
      const speed = Math.hypot(u.vx, u.vy);
      if (speed > 70) {
        const now = this.scene.time.now;
        if (now - v.lastDustAt > (u.kind === "hero" ? 240 : 340)) {
          v.lastDustAt = now;
          this.spawnDust(v.dx - u.facing * 12, v.dy + 6, u.kind === "hero" ? 0.85 : 0.6, u.facing < 0);
        }
      }

      // facing + animation. A fresh attack (lastAttackAt advanced) plays the FULL
      // attack swing once; while it's still playing we don't interrupt it with
      // walk/idle, so each hit reads as a complete motion.
      v.sprite.setFlipX(u.facing < 0);
      const attackKey = animKey(u, "attack");
      const attackPlaying = v.curAnim === attackKey && v.sprite.anims.isPlaying;
      if (u.lastAttackAt !== v.lastAttackAt && u.pendingAttack) {
        v.lastAttackAt = u.lastAttackAt;
        if (this.scene.anims.exists(attackKey)) {
          v.sprite.play(attackKey, true);
          v.curAnim = attackKey;
        }
      } else if (!attackPlaying) {
        const moving = Math.hypot(u.vx, u.vy) > 12;
        const key = animKey(u, moving ? "walk" : "idle");
        if (v.curAnim !== key && this.scene.anims.exists(key)) {
          v.sprite.play(key, true);
          v.curAnim = key;
        }
      }

      // no sprite tint at all — units show their true art; hit feedback is the
      // impact puff + floating damage number, so nothing pulses while moving.

      // bars
      const bw = u.kind === "hero" ? 56 : 34;
      v.hpFill.width = Math.max(0, (u.hp / u.maxHp) * bw);
      v.hpFill.setFillStyle(u.neutral ? 0xe0a93a : u.team === "radiant" ? 0x44d07a : 0xff5d5d);
      if (v.mpFill) v.mpFill.width = Math.max(0, (u.mp / Math.max(1, u.maxMp)) * bw);

      // status tints: stun = yellow ring flash handled via ring alpha
      const stunned = u.statuses.some((s) => s.kind === "stun" || s.kind === "taunt");
      v.ring.setAlpha(u.id === this.playerHeroId ? 1 : stunned ? 0.9 : u.kind === "hero" ? 0.5 : 0);
    }
    // remove views for units gone from the world (creeps die + get reaped) —
    // play a one-shot death anim from the sprite's last texture as it leaves.
    for (const [id, v] of this.units) {
      if (!world.units.has(id)) {
        this.spawnDeathAnim(v);
        v.container.destroy();
        this.units.delete(id);
      }
    }
  }

  /** A little kicked-up dust puff at the feet of a running unit. */
  private spawnDust(x: number, y: number, scale: number, flip: boolean): void {
    const s = this.scene;
    if (!s.anims.exists("fx-dust1")) return;
    const d = s.add.sprite(x, y, "fx-dust1", 0).setScale(scale).setAlpha(0.75).setFlipX(flip).setDepth(y - 2);
    d.play("fx-dust1");
    d.once("animationcomplete", () => d.destroy());
  }

  /** One-shot death at a unit's last position (for reaped creeps): play the real
   *  death sheet if the unit has one (barrel goblin's explosion), else collapse. */
  private spawnDeathAnim(v: UnitView): void {
    if (v.dead) return; // a hero already played its death in-place
    const s = this.scene;
    const tex = v.sprite.texture.key;
    const dkey = `${tex}-death`;
    const corpse = s.add
      .sprite(v.dx, v.dy - 18, tex, v.sprite.frame.name)
      .setScale(v.sprite.scaleX, v.sprite.scaleY)
      .setFlipX(v.sprite.flipX)
      .setDepth(v.dy - 2);
    if (s.anims.exists(dkey)) {
      corpse.play(dkey);
      corpse.once("animationcomplete", () => {
        s.tweens.add({ targets: corpse, alpha: 0, duration: 260, onComplete: () => corpse.destroy() });
      });
    } else {
      this.collapseSprite(corpse, () => corpse.destroy());
    }
  }

  /** Procedural death for sheets with no death sequence: freeze the current frame,
   *  then topple over + sink + fade. Reads clearly as a death for any unit. */
  private collapseSprite(sprite: Phaser.GameObjects.Sprite, onDone?: () => void): void {
    sprite.anims.stop();
    const dir = sprite.flipX ? -1 : 1;
    this.scene.tweens.add({
      targets: sprite,
      angle: dir * 78,
      y: sprite.y + 12,
      alpha: 0,
      duration: 520,
      ease: "Quad.easeIn",
      onComplete: () => onDone?.(),
    });
  }

  private createUnitView(u: Unit): UnitView {
    const s = this.scene;
    const { tex, scale } = unitSprite(u);
    const shadow = s.add.image(0, 8, "shadow").setDisplaySize(u.kind === "hero" ? 56 : 36, u.kind === "hero" ? 22 : 16).setAlpha(0.5);
    const ring = s.add.graphics();
    const isPlayer = u.id === this.playerHeroId;
    const ringColor = u.neutral ? 0xd0a23a : u.team === "radiant" ? 0x4fa3ff : 0xff5a4a;
    ring.lineStyle(isPlayer ? 4 : 2.5, isPlayer ? 0xffe14a : ringColor, 1).strokeEllipse(0, 10, u.kind === "hero" ? 56 : 38, u.kind === "hero" ? 26 : 18);
    const sprite = s.add.sprite(0, -18, tex, 0).setScale(scale);
    if (this.scene.anims.exists(animKey(u, "idle"))) sprite.play(animKey(u, "idle"));

    const barY = u.kind === "hero" ? -64 : -42;
    const bw = u.kind === "hero" ? 56 : 34;
    const hpBg = s.add.rectangle(0, barY, bw + 4, u.kind === "hero" ? 8 : 5, 0x0c1018).setStrokeStyle(1, 0x000000, 0.6);
    const hpFill = s.add.rectangle(-bw / 2, barY, bw, u.kind === "hero" ? 6 : 4, 0x44d07a).setOrigin(0, 0.5);
    let mpFill: Phaser.GameObjects.Rectangle | null = null;
    let label: Phaser.GameObjects.Text | null = null;
    const children: Phaser.GameObjects.GameObject[] = [shadow, ring, sprite, hpBg, hpFill];
    if (u.kind === "hero" && u.hero) {
      const mpBg = s.add.rectangle(0, barY + 8, bw + 4, 5, 0x0c1018).setStrokeStyle(1, 0x000000, 0.6);
      mpFill = s.add.rectangle(-bw / 2, barY + 8, bw, 3, 0x4a8fff).setOrigin(0, 0.5);
      label = s.add
        .text(0, barY - 12, "", { fontSize: "12px", color: "#eaf0ff", fontStyle: "bold", stroke: "#000", strokeThickness: 3 })
        .setOrigin(0.5);
      children.push(mpBg, mpFill, label);
    }
    const container = s.add.container(u.x, u.y, children).setDepth(u.y);
    const v: UnitView = { container, sprite, shadow, ring, hpBg, hpFill, mpFill, label, dx: u.x, dy: u.y, curAnim: "", lastAttackAt: 0, lastDustAt: 0, dead: false };
    this.units.set(u.id, v);
    return v;
  }

  /** Update hero name/level labels (called less often by HUD/Game). */
  refreshLabels(world: World): void {
    for (const [id, v] of this.units) {
      const u = world.units.get(id);
      if (!u || u.kind !== "hero" || !u.hero || !v.label) continue;
      v.label.setText(`${shortName(u.hero.defId)} ${u.hero.level}`);
    }
  }

  private syncProjectiles(world: World): void {
    const seen = new Set<string>();
    for (const p of world.projectiles.values()) {
      seen.add(p.id);
      let img = this.projs.get(p.id);
      if (!img) {
        img = this.scene.add.image(p.x, p.y, projTex(p)).setDepth(p.y + 200);
        const sc = p.kind === "fireball" || p.kind === "dynamite" ? 0.5 : 0.7;
        img.setScale(sc);
        if (p.kind === "fireball") img.setTint(0xff8a3a);
        this.projs.set(p.id, img);
      }
      img.setPosition(p.x, p.y);
      img.setDepth(p.y + 200);
      img.setRotation(Math.atan2(p.ty - p.y, p.tx - p.x) + (p.kind === "arrow" || p.kind === "bolt" ? Math.PI / 2 : 0));
    }
    for (const [id, img] of this.projs) if (!seen.has(id)) {
      img.destroy();
      this.projs.delete(id);
    }
  }

  private syncGrounds(world: World): void {
    const seen = new Set<string>();
    for (const g of world.groundEffects) {
      seen.add(g.id);
      let arc = this.grounds.get(g.id);
      if (!arc) {
        arc = this.scene.add.circle(g.x, g.y, g.radius, groundColor(g), 0.22).setDepth(g.y - 10);
        arc.setStrokeStyle(2, groundColor(g), 0.6);
        this.grounds.set(g.id, arc);
      }
      arc.setPosition(g.x, g.y);
    }
    for (const [id, arc] of this.grounds) if (!seen.has(id)) {
      arc.destroy();
      this.grounds.delete(id);
    }
  }

  private syncMines(world: World): void {
    const seen = new Set<string>();
    for (const m of world.mines.values()) {
      seen.add(m.id);
      let img = this.mines.get(m.id);
      if (!img) {
        img = this.scene.add.circle(m.x, m.y, 8, 0xff4d4d, 0.85).setDepth(m.y).setStrokeStyle(2, 0x661111);
        this.mines.set(m.id, img);
      }
    }
    for (const [id, img] of this.mines) if (!seen.has(id)) {
      img.destroy();
      this.mines.delete(id);
    }
  }

  private drainFx(world: World): void {
    for (const fx of world.fx) this.playFx(fx);
    world.fx.length = 0;
  }

  private playFx(fx: FxEvent): void {
    const s = this.scene;
    switch (fx.t) {
      case "hit": {
        sfx.hit();
        // impact puff at the strike point — the clash spark that sells combat
        const puff = s.add
          .image(fx.x + (Math.random() - 0.5) * 12, fx.y, "spark")
          .setDepth(fx.y + 300)
          .setScale(0.55)
          .setTint(fx.dtype === "magic" ? 0xc78bff : 0xffffff)
          .setAlpha(0.95)
          .setBlendMode(Phaser.BlendModes.ADD);
        s.tweens.add({ targets: puff, scale: fx.crit ? 2.4 : 1.7, alpha: 0, duration: fx.crit ? 260 : 180, ease: "Quad.Out", onComplete: () => puff.destroy() });
        // juice: a small camera kick when the player themselves takes a real hit
        if (fx.targetId === this.playerHeroId && fx.amount >= 35) {
          this.scene.cameras.main.shake(110, Math.min(0.006, 0.0016 + fx.amount / 40000));
        }
        const color = fx.dtype === "magic" ? "#c78bff" : fx.crit ? "#ffd23a" : "#ffffff";
        const size = fx.crit ? "20px" : "14px";
        const t = s.add
          .text(fx.x + (Math.random() - 0.5) * 16, fx.y, `${fx.amount}`, { fontSize: size, color, fontStyle: "bold", stroke: "#000", strokeThickness: 3 })
          .setOrigin(0.5)
          .setDepth(90000);
        s.tweens.add({ targets: t, y: fx.y - 38, alpha: 0, duration: 700, ease: "Cubic.Out", onComplete: () => t.destroy() });
        break;
      }
      case "explosion": {
        sfx.explosion();
        // the Particle FX pack's cartoon explosions, played raw (their art carries
        // its own palette — no tint, no additive blend)
        const key = fx.radius >= 130 && s.anims.exists("fx-explode2") ? "fx-explode2" : "fx-explode1";
        if (s.anims.exists(key)) {
          const e = s.add.sprite(fx.x, fx.y - 10, key, 0).setDepth(fx.y + 400);
          e.setScale(Phaser.Math.Clamp(fx.radius / 85, 0.8, 2.4));
          e.play(key);
          e.once("animationcomplete", () => e.destroy());
        } else if (s.anims.exists("fx-explode")) {
          const e = s.add.sprite(fx.x, fx.y, "fx-explosion", 0).setDepth(fx.y + 400).setBlendMode(Phaser.BlendModes.ADD);
          e.setScale((fx.radius / 96) * 1.2).setTint(fx.color);
          e.play("fx-explode");
          e.once("animationcomplete", () => e.destroy());
        }
        break;
      }
      case "blink": {
        for (const [x, y] of [[fx.x, fx.y], [fx.x2, fx.y2]] as const) {
          const c = s.add.circle(x, y, 24, 0x9b6bff, 0.6).setDepth(y + 100);
          s.tweens.add({ targets: c, scale: 0, alpha: 0, duration: 300, onComplete: () => c.destroy() });
        }
        break;
      }
      case "levelup": {
        const v = this.units.get(fx.unitId);
        if (fx.unitId === this.playerHeroId) sfx.level();
        const x = v ? v.dx : fx.x;
        const y = v ? v.dy : fx.y;
        const ring = s.add.circle(x, y + 10, 20, 0xffe14a, 0).setStrokeStyle(4, 0xffe14a, 1).setDepth(y + 50);
        s.tweens.add({ targets: ring, scale: 3, alpha: 0, duration: 600, onComplete: () => ring.destroy() });
        break;
      }
      case "gold": {
        if (fx.heroId !== this.playerHeroId) break;
        sfx.gold();
        const t = s.add.text(fx.x, fx.y, `+${fx.amount}`, { fontSize: "13px", color: "#ffd23a", fontStyle: "bold", stroke: "#000", strokeThickness: 3 }).setOrigin(0.5).setDepth(90000);
        s.tweens.add({ targets: t, y: fx.y - 30, alpha: 0, duration: 800, onComplete: () => t.destroy() });
        break;
      }
      case "heal": {
        const t = s.add.text(fx.x, fx.y - 20, `+${Math.round(fx.amount)}`, { fontSize: "13px", color: "#7bf08b", fontStyle: "bold", stroke: "#000", strokeThickness: 3 }).setOrigin(0.5).setDepth(90000);
        s.tweens.add({ targets: t, y: fx.y - 50, alpha: 0, duration: 700, onComplete: () => t.destroy() });
        break;
      }
      case "structureDown": {
        sfx.structureDown();
        s.cameras.main.shake(260, 0.006);
        if (s.anims.exists("fx-explode2")) {
          const e = s.add.sprite(fx.x, fx.y - 50, "fx-explode2", 0).setDepth(fx.y + 500).setScale(1.7);
          e.play("fx-explode2");
          e.once("animationcomplete", () => e.destroy());
        }
        break;
      }
      case "death": {
        if (fx.kind === "hero") sfx.death();
        if (fx.kind === "creep") {
          if (s.anims.exists("fx-dust2")) {
            const puff = s.add.sprite(fx.x, fx.y - 8, "fx-dust2", 0).setDepth(fx.y + 10).setScale(1.1).setAlpha(0.9);
            puff.play("fx-dust2");
            puff.once("animationcomplete", () => puff.destroy());
          } else {
            const puff = s.add.image(fx.x, fx.y - 10, "spark").setDepth(fx.y + 10).setTint(0xdddddd).setScale(1.5);
            s.tweens.add({ targets: puff, scale: 0, alpha: 0, duration: 320, onComplete: () => puff.destroy() });
          }
        }
        break;
      }
      case "cast": {
        if (fx.team === this.playerTeam) sfx.ability();
        const col = effectColor(fx.effect);
        const ring = s.add.circle(fx.x, fx.y + 6, 34, col, 0).setStrokeStyle(3, col, 0.9).setDepth(fx.y);
        s.tweens.add({ targets: ring, scale: 0.2, alpha: 0, duration: 280, ease: "Quad.Out", onComplete: () => ring.destroy() });
        break;
      }
      case "ability": {
        this.playAbilityFx(fx);
        break;
      }
    }
  }

  private playAbilityFx(fx: Extract<FxEvent, { t: "ability" }>): void {
    const s = this.scene;
    const col = effectColor(fx.effect);
    const isLine = Math.hypot(fx.x2 - fx.x, fx.y2 - fx.y) > 60 && fx.radius < 160;
    if (isLine) {
      // beam / skillshot line
      const g = s.add.graphics().setDepth(fx.y2 + 300).setBlendMode(Phaser.BlendModes.ADD);
      g.lineStyle(Math.max(6, fx.radius), col, 0.8).lineBetween(fx.x, fx.y - 14, fx.x2, fx.y2 - 14);
      s.tweens.add({ targets: g, alpha: 0, duration: 320, onComplete: () => g.destroy() });
    }
    // impact AoE ring at the target point (x2,y2)
    const cx = fx.x2;
    const cy = fx.y2;
    const r = Math.max(40, fx.radius);
    const fill = s.add.circle(cx, cy, r, col, 0.22).setDepth(cy - 8).setBlendMode(Phaser.BlendModes.ADD);
    const ring = s.add.circle(cx, cy, r, col, 0).setStrokeStyle(4, col, 0.95).setDepth(cy - 7);
    fill.setScale(0.4);
    ring.setScale(0.4);
    s.tweens.add({ targets: [fill, ring], scale: 1, alpha: 0, duration: 420, ease: "Quad.Out", onComplete: () => { fill.destroy(); ring.destroy(); } });
  }
}

/** Color an ability/cast effect by its element keyword. */
function effectColor(effect: string): number {
  if (effect.startsWith("emberhex") || effect.includes("fire") || effect.includes("flash") || effect.includes("conflag")) return 0xff7a2a;
  if (effect.startsWith("stormcaller") || effect.includes("storm") || effect.includes("pierc")) return 0x6ab8ff;
  if (effect.startsWith("brewkeeper")) return 0x8be07a;
  if (effect.startsWith("boomtinker")) return 0xffd24d;
  if (effect.startsWith("duskblade")) return 0xb06bff;
  if (effect.startsWith("ironvow")) return 0x9cc4ff;
  return 0xffffff;
}

function teamHpColor(team: string): number {
  return team === "radiant" ? 0x44d07a : 0xff5d5d;
}
function projTex(p: Projectile): string {
  if (p.kind === "fireball") return "glow";
  if (p.kind === "dynamite") return "spark";
  return "fx-arrow";
}
function groundColor(g: GroundEffect): number {
  if (g.allyHealPerTick) return 0x6be07a;
  if (g.effect.includes("storm")) return 0x6aa8ff;
  return 0xff6a2a;
}
function shortName(defId: string): string {
  const m: Record<string, string> = { ironvow: "Garran", duskblade: "Vesper", stormcaller: "Aelwyn", emberhex: "Grix", boomtinker: "Fizzle", brewkeeper: "Bramble" };
  return m[defId] ?? defId;
}
