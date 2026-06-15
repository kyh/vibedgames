import Phaser from "phaser";

import {
  BASES,
  BRIDGES,
  ELEV_LIFT,
  GRID,
  NEUTRAL_CAMPS,
  TOWERS,
  TREE_CLUSTERS,
  WORLD,
  elevationFrac,
  isCliffCell,
  isHighCell,
  isLandCell,
  isRampCell,
  isWalkableHighCell,
  rampAt,
} from "../data/map";
import type { Team } from "../data/config";
import type { World, Unit, Projectile, GroundEffect, FxEvent } from "../sim/types";
import { sfx } from "./audio";
import { FONT } from "./font";
import { abilityCastFx, effectColor, groundFxKind } from "./fx-map";
import { animKey, structureDestroyedTex, unitSprite } from "./sprites";

const CELL = 64;
const COLS = GRID.cols;
const ROWS = GRID.rows;

// How far (px) a plateau rises above flat ground (shared with the click-picker so
// lifted units stay selectable). The elevated grass layer + anything on it is
// drawn shifted up by this; the cliff fills the gap; ramps rise by it.
const LIFT = ELEV_LIFT;

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

// Terrain tileset autotile (9-wide sheet) — same mapping the ?gallery=map
// showcase rebuild uses, verified tile-by-tile. Keyed by which
// orthogonal neighbours are OUTSIDE the set: N=8,E=4,S=2,W=1.
const FLAT_TILE: Record<number, number> = {
  0: 10,
  8: 1,
  4: 11,
  2: 19,
  1: 9,
  9: 0,
  12: 2,
  3: 18,
  6: 20,
  5: 12,
  10: 28,
  13: 3,
  7: 21,
  11: 27,
  14: 29,
  15: 30,
};
// Elevated grass is the identical autotile shifted 5 columns right.
const ELEV_TILE: Record<number, number> = Object.fromEntries(
  Object.entries(FLAT_TILE).map(([k, v]) => [Number(k), v + 5]),
);
// Stone cliff face tiles under a plateau's south edge (single-tile wall — the
// grass-lipped top row of the tileset's cliff block).
const CLIFF = {
  topL: 41,
  topM: 42,
  topR: 43,
  topNarrow: 44,
};
// Diagonal grass slope tiles for SIDE ramps (top row + bottom row). The "right"
// slope (descends to the east) fronts a ramp climbed westward; "left" the mirror.
const SLOPE = { rightTop: 39, rightBot: 48, leftTop: 36, leftBot: 45 };
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
  recoilX: number; // hit knockback offset (decays each frame)
  recoilY: number;
  flashUntil: number; // ms; sprite shows a red damage flash until then
};

/** A live ground zone's display: the coloured ring + any looping effect sprites
 *  (each kept with its offset from the zone centre so followOwner zones can track). */
type GroundView = {
  arc: Phaser.GameObjects.Arc;
  sprites: Array<{ sp: Phaser.GameObjects.Sprite; ox: number; oy: number }>;
  nextStrikeAt: number; // for storm zones: when to drop the next lightning bolt
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
  private projs = new Map<string, Phaser.GameObjects.Image | Phaser.GameObjects.Sprite>();
  private grounds = new Map<string, GroundView>();
  private mines = new Map<string, Phaser.GameObjects.Arc>();
  private shoreCells: Array<{ x: number; y: number }> = []; // water cells touching land, for ambient splashes
  private splashAcc = 0;
  private reticle: Phaser.GameObjects.Image | null = null; // target marker (Cursor_04)
  private reticleId = ""; // unit the player is currently targeting/hovering
  playerHeroId = "";
  playerTeam: "radiant" | "dire" = "radiant";

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** Start a looping anim at a deterministic offset, CLAMPED to its real frame
   *  count. A sheet can load with fewer frames than authored when its source PNG
   *  exceeds the GPU's max texture size (e.g. a wide strip on a weaker/mobile GPU),
   *  and a hardcoded `startFrame % N` would then index past the end and crash
   *  Phaser's getFirstTick (`undefined.duration`). No-ops if the anim is missing. */
  private playLoop(sprite: Phaser.GameObjects.Sprite, key: string, startSeed = 0): void {
    const anim = this.scene.anims.get(key);
    const n = anim?.frames.length ?? 0;
    if (n <= 0) return;
    sprite.play({ key, startFrame: ((Math.floor(startSeed) % n) + n) % n });
  }

  buildTerrain(): void {
    const s = this.scene;

    // 1) open water everywhere underneath
    s.add.tileSprite(0, 0, WORLD.width, WORLD.height, "t-water").setOrigin(0, 0).setDepth(D_WATER);

    // 2) animated foam lapping every shoreline (under the grass edge tiles)
    this.buildFoam();

    // 3) flat grass islands as one autotiled tilemap layer
    this.buildGroundLayer(false, D_FLAT);

    // 4) plateau drop shadows, then cliff faces, then the elevated grass tops
    //    LIFTED up so heights read as a raised 3rd dimension, then walkable ramps
    this.buildPlateauShadows();
    this.buildCliffs();
    this.buildGroundLayer(true, D_ELEV, -LIFT);
    this.buildRamps();

    // 5) warm multiply wash nudging the tileset green toward olive
    this.buildWash();

    // 6) wooden bridges across the channel
    this.buildBridges();

    // 7) fountains (healing pools at the castle's foot) + a couple of village houses
    for (const team of ["radiant", "dire"] as const) {
      const b = BASES[team];
      const col = team === "radiant" ? 0x4fa3ff : 0xff5a4a;
      s.add.circle(b.fountain.x, b.fountain.y, b.fountainRadius, col, 0.05).setDepth(D_RING);
      // carved pool: stone lip, teal water, bright centre, slow pulsing ring
      s.add.ellipse(b.fountain.x, b.fountain.y, 168, 122, 0x6a7a82, 1).setDepth(DEPTH_DECAL - 2);
      s.add.ellipse(b.fountain.x, b.fountain.y, 146, 102, 0x2e8f8a, 1).setDepth(DEPTH_DECAL - 1);
      s.add.ellipse(b.fountain.x, b.fountain.y - 4, 104, 68, 0x6fd6cf, 0.85).setDepth(DEPTH_DECAL);
      s.add
        .ellipse(b.fountain.x, b.fountain.y - 6, 56, 34, 0xc9f3ef, 0.9)
        .setDepth(DEPTH_DECAL + 1);
      const pulse = s.add
        .ellipse(b.fountain.x, b.fountain.y - 4, 70, 44, col, 0)
        .setStrokeStyle(3, 0xeafffd, 0.8)
        .setDepth(DEPTH_DECAL + 2);
      s.tweens.add({
        targets: pulse,
        scaleX: 1.7,
        scaleY: 1.7,
        alpha: 0,
        duration: 2200,
        repeat: -1,
        ease: "Sine.Out",
      });
      // splash sparkle: the pool joins the ambient splash pool
      this.shoreCells.push({ x: b.fountain.x, y: b.fountain.y });
      const houseTex = `b-house-${team === "radiant" ? "blue" : "red"}`;
      if (s.textures.exists(houseTex)) {
        const sign = team === "radiant" ? 1 : -1;
        for (const [hx, hy] of [
          [b.fountain.x + sign * 110, b.fountain.y - 250],
          [b.fountain.x + sign * 90, b.fountain.y + 240],
        ] as const) {
          if (!isLandCell(Math.floor(hx / CELL), Math.floor(hy / CELL))) continue;
          s.add.image(hx, hy, houseTex).setOrigin(0.5, 0.8).setDepth(hy);
        }
      }
    }

    // 7b) Roshan pit dressing: a trampled dark patch ringed with bones and rocks
    this.buildRoshanPit();

    // 7c) gold mines behind the large jungle camps (flavour landmarks)
    if (s.textures.exists("deco-goldmine")) {
      for (const c of NEUTRAL_CAMPS) {
        if (c.kind !== "large") continue;
        s.add
          .image(c.x, c.y - 64, "deco-goldmine")
          .setOrigin(0.5, 0.78)
          .setDepth(c.y - 64);
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

  /** The Roshan pit: dark trampled ground + a deterministic ring of bones/rocks. */
  private buildRoshanPit(): void {
    const s = this.scene;
    const pit = NEUTRAL_CAMPS.find((c) => c.kind === "roshan");
    if (!pit) return;
    s.add
      .ellipse(pit.x, pit.y, 330, 240, 0x3a2c20, 0.3)
      .setDepth(D_RING - 1)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
    s.add
      .ellipse(pit.x, pit.y, 220, 156, 0x2c2118, 0.25)
      .setDepth(D_RING - 1)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
    const props = [
      "deco-14",
      "deco-15",
      "deco-rock2",
      "deco-14",
      "deco-15",
      "deco-rock3",
      "deco-15",
      "deco-14",
    ];
    props.forEach((key, i) => {
      if (!s.textures.exists(key)) return;
      const a = (i / props.length) * Math.PI * 2 + 0.5;
      const r = 95 + rng2(i * 13, i * 7) * 75;
      const x = pit.x + Math.cos(a) * r * 1.25;
      const y = pit.y + Math.sin(a) * r * 0.8;
      s.add
        .image(x, y, key)
        .setScale(0.85 + rng2(i, i * 3) * 0.3)
        .setAngle((rng2(i * 5, i) - 0.5) * 50)
        .setDepth(y);
    });
  }

  /** Animated 192px foam sprites on every water cell touching land —
   *  oversized sprites on the 64 grid, each starting at a different frame. */
  private buildFoam(): void {
    const s = this.scene;
    const hasFoam = s.textures.exists("foam");
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (isLandCell(cx, cy)) continue;
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
          ] as Array<[number, number]>
        ).some(([dx, dy]) => isLandCell(cx + dx, cy + dy));
        if (!touches) continue;
        const x = cx * CELL + CELL / 2;
        const y = cy * CELL + CELL / 2;
        this.shoreCells.push({ x, y });
        if (!hasFoam) continue;
        const f = s.add.sprite(x, y, "foam", 0).setDepth(D_FOAM);
        this.playLoop(f, "foam-loop", cx * 7 + cy * 5);
      }
    }
  }

  /** Flat (elevated=false) or plateau-top (true) grass autotile as one layer.
   *  `yOff` lifts the layer up (elevated grass) so plateaus read as raised. */
  private buildGroundLayer(elevated: boolean, depth: number, yOff = 0): void {
    const s = this.scene;
    if (!s.textures.exists("tiles-img")) return;
    const inSet = (cx: number, cy: number): boolean =>
      elevated ? isHighCell(cx, cy) : isLandCell(cx, cy) && !isHighCell(cx, cy);
    const out = (cx: number, cy: number): boolean =>
      elevated ? !isHighCell(cx, cy) : !isLandCell(cx, cy);
    const data: number[][] = [];
    for (let cy = 0; cy < ROWS; cy++) {
      const row: number[] = [];
      for (let cx = 0; cx < COLS; cx++) {
        if (!inSet(cx, cy)) {
          row.push(-1);
          continue;
        }
        const k =
          (out(cx, cy - 1) ? 8 : 0) |
          (out(cx + 1, cy) ? 4 : 0) |
          (out(cx, cy + 1) ? 2 : 0) |
          (out(cx - 1, cy) ? 1 : 0);
        row.push((elevated ? ELEV_TILE[k] : FLAT_TILE[k]) ?? (elevated ? 15 : 10));
      }
      data.push(row);
    }
    const map = s.make.tilemap({ data, tileWidth: CELL, tileHeight: CELL });
    const tiles = map.addTilesetImage(elevated ? "tilesE" : "tilesF", "tiles-img");
    if (tiles) map.createLayer(0, tiles, 0, yOff)?.setDepth(depth);
  }

  /** Drop shadow under the elevated footprint, shifted one tile down
   *  (layered between the flat and elevated ground layers). */
  private buildPlateauShadows(): void {
    const s = this.scene;
    if (!s.textures.exists("tshadow")) return;
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (!isHighCell(cx, cy)) continue;
        s.add
          .image(cx * CELL + CELL / 2, (cy + 1) * CELL + CELL / 2, "tshadow")
          .setDepth(D_SHADOW)
          .setAlpha(0.8);
      }
    }
  }

  /** Stone cliff face along each plateau's south edge: a one-tile wall hanging
   *  from the LIFTED grass lip down to the ground, so the plateau reads as a raised
   *  block. Skipped where a ramp descends (the ramp grass shows there instead). */
  private buildCliffs(): void {
    const s = this.scene;
    if (!s.textures.exists("tiles")) return;
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (!isHighCell(cx, cy) || isHighCell(cx, cy + 1)) continue; // south edge only
        if (isRampCell(cx, cy + 1)) continue; // a ramp descends here — leave it open
        const cxp = cx * CELL + CELL / 2;
        // a run ends where the neighbour isn't a south-edge wall (incl. ramp gaps)
        const leftEnd =
          !isHighCell(cx - 1, cy) || isHighCell(cx - 1, cy + 1) || isRampCell(cx - 1, cy + 1);
        const rightEnd =
          !isHighCell(cx + 1, cy) || isHighCell(cx + 1, cy + 1) || isRampCell(cx + 1, cy + 1);
        const narrow = leftEnd && rightEnd;
        const tile = narrow
          ? CLIFF.topNarrow
          : leftEnd
            ? CLIFF.topL
            : rightEnd
              ? CLIFF.topR
              : CLIFF.topM;
        const wallTopY = (cy + 1) * CELL - LIFT;
        s.add.ellipse(cxp, wallTopY + CELL + 2, CELL + 10, 16, 0x05080e, 0.3).setDepth(D_SHADOW);
        // a natural-height tile from the lifted lip; its base laps slightly past the
        // ground line so the stone meets the grass below cleanly.
        s.add.image(cxp, wallTopY, "tiles", tile).setOrigin(0.5, 0).setDepth(D_CLIFF);
      }
    }
  }

  /** Walkable SIDE ramps: a diagonal grass slope (tileset slope tiles) on the
   *  plateau's side that rises from low ground up to the top. Lifted grass fills
   *  behind the slope so there are no holes; units crossing rise smoothly. */
  private buildRamps(): void {
    const s = this.scene;
    if (!s.textures.exists("tiles-img") || !s.textures.exists("tiles")) return;
    const FILL = FLAT_TILE[0] ?? 10; // grass interior, to back-fill the slope
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        const r = rampAt(cx, cy);
        if (!r) continue;
        const cxp = cx * CELL + CELL / 2;
        const lift = elevationFrac(cxp, cy * CELL + CELL / 2) * LIFT;
        // grass fill behind the slope (lifted to this cell's height, stretched down)
        s.add
          .image(cxp, cy * CELL - lift, "tiles", FILL)
          .setOrigin(0.5, 0)
          .setDisplaySize(CELL + 2, CELL + LIFT)
          .setDepth(D_CLIFF + 1);
        // diagonal slope tile on top: top vs bottom row of the ramp, left vs right
        // facing by ascent direction (W = plateau to the west = east-descending).
        const left = r.dir === "E";
        const tile =
          cy === r.y0
            ? left
              ? SLOPE.leftTop
              : SLOPE.rightTop
            : left
              ? SLOPE.leftBot
              : SLOPE.rightBot;
        s.add
          .image(cxp, cy * CELL - lift, "tiles", tile)
          .setOrigin(0.5, 0)
          .setDepth(D_CLIFF + 2);
      }
    }
  }

  /** Multiply wash over the land, nudging the tileset green toward olive. */
  private buildWash(): void {
    const wash = this.scene.add
      .graphics()
      .setDepth(D_WASH)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
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
          s.add
            .image(cx * CELL + CELL / 2, cy * CELL + CELL / 2 + 14, "t-bridge", BRIDGE_SHADOW)
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
      // keep walkable high ground + ramps clear so they read (and aren't cluttered)
      if (isWalkableHighCell(cx, cy) || isRampCell(cx, cy)) return;
      // trees on a plateau stand on its raised surface, so lift the whole sprite
      const lift = isHighCell(cx, cy) ? -LIFT : 0;
      s.add
        .image(tx, ty + 6 + lift, "shadow")
        .setDisplaySize(74, 26)
        .setAlpha(0.4)
        .setDepth(ty - 1 + lift);
      const pick = rng2(tx + seed, ty - seed);
      if (hasPine && (pick < 0.45 || deciduous.length === 0)) {
        const tree = s.add
          .sprite(tx, ty + lift, "t-tree", 0)
          .setOrigin(0.5, 0.86)
          .setScale(0.95 + pick * 0.3)
          .setDepth(ty + lift);
        if (pick < 0.12)
          tree.setTint(AUTUMN[Math.floor(rng2(ty, tx) * AUTUMN.length) % AUTUMN.length]);
        this.playLoop(tree, "tree-sway", Math.floor(rng2(ty, tx) * 6));
      } else {
        const kind = deciduous[Math.floor(rng2(tx, ty) * deciduous.length) % deciduous.length] ?? 1;
        const tree = s.add
          .sprite(tx, ty + lift, `ftree${kind}`, 0)
          .setOrigin(0.5, 0.82)
          .setScale(0.5 + pick * 0.14)
          .setDepth(ty + lift);
        this.playLoop(tree, `ftree${kind}-sway`, Math.floor(rng2(ty, tx) * 8));
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
    // sparse pines on the plateau tops so the heights read as wooded — but not
    // on the castle outcrops, where they'd poke through the keep
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (!isHighCell(cx, cy) || isWalkableHighCell(cx, cy) || rng2(cx * 3, cy * 5) > 0.16)
          continue; // pines only on blocked deco rises, never on walkable plateaus
        const tx = cx * CELL + CELL / 2 + (rng2(cx, cy + 1) - 0.5) * 40;
        const ty = cy * CELL + CELL / 2 + (rng2(cx + 1, cy) - 0.5) * 40;
        const nearAncient = (["radiant", "dire"] as const).some(
          (t) => (tx - BASES[t].ancient.x) ** 2 + (ty - BASES[t].ancient.y) ** 2 < 320 * 320,
        );
        if (nearAncient) continue;
        if (hasPine) {
          const tree = s.add
            .sprite(tx, ty - LIFT, "t-tree", 0) // pines here are on the plateau top
            .setOrigin(0.5, 0.86)
            .setScale(0.9)
            .setDepth(ty - LIFT);
          this.playLoop(tree, "tree-sway", Math.floor(rng2(ty, tx) * 6));
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
        if (!isLandCell(ccx, ccy) || isCliffCell(ccx, ccy) || isRampCell(ccx, ccy)) continue;
        // keep decals out of the base/fountain footprints
        const near = (fx: number, fy: number) => (x - fx) ** 2 + (y - fy) ** 2 < 420 * 420;
        if (near(BASES.radiant.fountain.x, BASES.radiant.fountain.y)) continue;
        if (near(BASES.dire.fountain.x, BASES.dire.fountain.y)) continue;
        // decals on a plateau sit on its raised surface
        const lift = isHighCell(ccx, ccy) ? -LIFT : 0;
        if (r < 0.08) {
          const key = `deco-rock${1 + Math.floor(rng2(cx, cy + 3) * 4)}`;
          if (s.textures.exists(key))
            s.add
              .image(x, y + lift, key)
              .setScale(0.7 + rng2(x, y) * 0.3)
              .setDepth(y + lift);
        } else if (r < 0.16) {
          // bushes are animated sway strips — one 128px frame each, never the sheet
          const n = 1 + Math.floor(rng2(cx + 3, cy) * 4);
          const key = `deco-bush${n}`;
          if (!s.textures.exists(key)) continue;
          const bush = s.add
            .sprite(x, y + lift, key, 0)
            .setScale(0.55 + rng2(x, y) * 0.25)
            .setDepth(y + lift);
          this.playLoop(bush, `${key}-sway`, Math.floor(rng2(y, x) * 8));
        } else {
          const key = `deco-${String(1 + Math.floor(rng2(cx + 5, cy + 5) * 18)).padStart(2, "0")}`;
          if (s.textures.exists(key))
            s.add
              .image(x, y + lift, key)
              .setScale(0.8 + rng2(x, y) * 0.3)
              .setDepth(y + lift)
              .setAlpha(0.95);
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
        const rk = s.add
          .sprite(x, y, `wrock${n}`, 0)
          .setScale(0.55)
          .setDepth(D_FOAM + 1)
          .setAlpha(0.95);
        this.playLoop(rk, `wrock${n}-anim`, Math.floor(r * 8));
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
      s.tweens.add({
        targets: c,
        x: x + dist,
        duration: 30000 + rng2(i, 5) * 30000,
        yoyo: true,
        repeat: -1,
        ease: "Sine.InOut",
      });
    }
  }

  /** Ambient grazing sheep on the grass — pure cosmetic life, wanders gently. */
  private buildAmbientLife(): void {
    const s = this.scene;
    if (!s.textures.exists("sheep")) return;
    const spots: Array<{ x: number; y: number }> = [
      { x: 1450, y: 850 },
      { x: 950, y: 2250 },
      { x: 2650, y: 2250 },
      { x: 3150, y: 850 },
      { x: 2000, y: 1340 },
      { x: 2120, y: 1700 },
      { x: 620, y: 980 },
      { x: 3480, y: 2100 },
    ];
    for (const p of spots) {
      if (!isLandCell(Math.floor(p.x / CELL), Math.floor(p.y / CELL))) continue;
      const sh = s.add.sprite(p.x, p.y, "sheep", 0).setScale(0.5).setDepth(p.y);
      this.playLoop(sh, "sheep-idle", Math.floor(rng2(p.x, p.y) * 8));
      // gentle wander
      s.tweens.add({
        targets: sh,
        x: p.x + (rng2(p.x, 2) - 0.5) * 160,
        y: p.y + (rng2(2, p.y) - 0.5) * 120,
        duration: 6000 + rng2(p.x, p.y) * 6000,
        yoyo: true,
        repeat: -1,
        ease: "Sine.InOut",
        onUpdate: () => sh.setDepth(sh.y),
      });
    }
  }

  /** Build structure sprites from static map data (works before any world). */
  buildStructures(): void {
    const make = (id: string, team: Team, tier: string, x: number, y: number) => {
      const tex =
        tier === "ancient"
          ? `b-castle-${team === "radiant" ? "blue" : "red"}`
          : `b-tower-${team === "radiant" ? "blue" : "red"}`;
      const scale = tier === "ancient" ? 1.7 : tier === "base" ? 1.15 : 1.35;
      const hpY = tier === "ancient" ? 150 : 110;
      const w = tier === "ancient" ? 120 : 64;
      const sp = this.scene.add
        .image(x, y - 30, tex)
        .setScale(scale)
        .setDepth(y);
      const hpBg = this.scene.add.rectangle(x, y - hpY, w + 4, 9, 0x101522).setDepth(y + 1);
      const hpFill = this.scene.add
        .rectangle(x - w / 2, y - hpY, w, 7, teamHpColor(team))
        .setOrigin(0, 0.5)
        .setDepth(y + 2);
      this.structs.set(id, { sprite: sp, hpBg, hpFill, range: null, fires: [], dead: false });
    };
    for (const t of TOWERS) make(t.id, t.team, t.tier, t.x, t.y);
    for (const team of ["radiant", "dire"] as Team[]) {
      make(
        team === "radiant" ? "r-ancient" : "d-ancient",
        team,
        "ancient",
        BASES[team].ancient.x,
        BASES[team].ancient.y,
      );
    }
  }

  /** Game scene tells us which enemy the player is targeting/hovering so we can
   *  mark it with the Cursor_04 reticle. "" clears it. */
  setTarget(id: string): void {
    this.reticleId = id;
  }

  /** Per-frame sync of all dynamic objects to the world. */
  sync(world: World, dt: number): void {
    this.syncStructures(world);
    this.syncUnits(world, dt);
    this.syncProjectiles(world);
    this.syncGrounds(world, dt);
    this.syncMines(world);
    this.syncReticle(world);
    this.drainFx(world);
    this.tickAmbientSplashes(dt);
  }

  /** Position the target reticle over the currently-targeted unit (4 corner
   *  brackets that frame the body), or hide it when there's no valid target. */
  private syncReticle(world: World): void {
    const u = this.reticleId ? world.units.get(this.reticleId) : undefined;
    // structures live in `structs`, not the unit-view map, so resolve them directly
    const struct = !!u && u.kind === "structure";
    const v = u && !struct ? this.units.get(u.id) : undefined;
    const ok = !!u && u.alive && (struct || (!!v && !v.dead));
    if (!ok) {
      if (this.reticle) this.reticle.setVisible(false);
      return;
    }
    if (!this.reticle) {
      // crisp opaque corner-brackets (NORMAL blend) so the marker reads clearly
      // over the busy map; tinted per relationship.
      this.reticle = this.scene.add.image(0, 0, "cursor-target").setDepth(89000);
    }
    const size = struct ? Math.max(120, u.radius * 2.4) : u.kind === "hero" ? 96 : 68;
    const bx = struct ? u.x : (v?.dx ?? u.x);
    const by = struct ? u.y : (v?.dy ?? u.y);
    const elev = elevationFrac(bx, by) * LIFT; // ride the lifted sprite on high ground
    const cx = bx;
    const cy = (struct ? by - 24 : by - 16) - elev;
    this.reticle
      .setVisible(true)
      .setPosition(cx, cy)
      .setDisplaySize(size, size)
      .setTint(u.team === this.playerTeam ? 0x5dffa0 : 0xff3b3b);
    // gentle breathing so it reads as "locked on"
    const pulse = 1 + 0.06 * Math.sin(this.scene.time.now / 120);
    this.reticle.setScale(this.reticle.scaleX * pulse, this.reticle.scaleY * pulse);
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
      if (
        !c ||
        c.x < view.x - 100 ||
        c.x > view.right + 100 ||
        c.y < view.y - 100 ||
        c.y > view.bottom + 100
      )
        continue;
      const sp = s.add
        .sprite(c.x + (Math.random() - 0.5) * 40, c.y + (Math.random() - 0.5) * 40, "fx-splash", 0)
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
        this.syncTowerRangeRing(world, u, sv);
      }
    }
  }

  /** Show an enemy tower's attack radius while the player hero is close to it —
   *  the "you are about to get shot" warning every MOBA needs. */
  private syncTowerRangeRing(world: World, u: Unit, sv: StructView): void {
    const me = world.units.get(this.playerHeroId);
    const st = u.structure;
    const range = u.attackRange + u.radius;
    const show =
      !!me &&
      me.alive &&
      !!st &&
      st.tier !== "ancient" &&
      st.attackable &&
      u.team !== me.team &&
      (me.x - u.x) ** 2 + (me.y - u.y) ** 2 <= (range + 280) ** 2;
    if (show && !sv.range) {
      sv.range = this.scene.add
        .circle(u.x, u.y, range, 0xff5a4a, 0.04)
        .setStrokeStyle(2.5, 0xff5a4a, 0.4)
        .setDepth(D_RING + 1);
    } else if (!show && sv.range) {
      sv.range.destroy();
      sv.range = null;
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
      ? [
          [-50, -78],
          [44, -28],
        ]
      : [
          [-17, -42],
          [19, -88],
        ];
    while (sv.fires.length < want) {
      const i = sv.fires.length;
      const [ox, oy] = offsets[i] ?? [0, -60];
      const key = `fx-flame${1 + ((i + Math.abs(Math.round(u.x))) % 3)}`;
      if (!s.anims.exists(key)) return;
      const f = s.add
        .sprite(u.x + ox, u.y + oy, key, 0)
        .setDepth(u.y + 3)
        .setScale(big ? 2.3 : 1.8);
      this.playLoop(f, key, i * 3);
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
          this.spawnSkull(v.dx, v.dy, u.kind === "hero" ? 0.62 : 0.5);
          if (this.scene.anims.exists(dkey)) {
            v.sprite.play(dkey);
            v.curAnim = dkey;
            v.sprite.once("animationcomplete", () =>
              this.collapseSprite(v.sprite, () => v.container.setVisible(false)),
            );
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
      // hit recoil: a quick knockback offset on the sprite that springs back —
      // purely visual (the sim position is untouched, so nav/MP stay authoritative).
      v.recoilX *= Math.pow(0.0008, dt);
      v.recoilY *= Math.pow(0.0008, dt);
      if (Math.abs(v.recoilX) < 0.3) v.recoilX = 0;
      if (Math.abs(v.recoilY) < 0.3) v.recoilY = 0;
      // elevation lift: raise the sprite when on a plateau / climbing a ramp so it
      // stands on the high ground (sim x/y is untouched — depth still sorts by feet)
      const elev = elevationFrac(v.dx, v.dy) * LIFT;
      v.container.setPosition(Math.round(v.dx + v.recoilX), Math.round(v.dy + v.recoilY - elev));
      // sort by the lifted "screen feet" so plateau units order correctly against
      // the lifted plateau trees/decor (which use depth = y - LIFT)
      v.container.setDepth(v.dy - elev);

      // damage flash: a brief red tint on the body when struck (cleared on expiry)
      if (v.flashUntil > 0 && this.scene.time.now >= v.flashUntil) {
        v.flashUntil = 0;
        v.sprite.clearTint();
      }

      // running dust puffs at the feet (throttled per unit)
      const speed = Math.hypot(u.vx, u.vy);
      if (speed > 70) {
        const now = this.scene.time.now;
        if (now - v.lastDustAt > (u.kind === "hero" ? 240 : 340)) {
          v.lastDustAt = now;
          this.spawnDust(
            v.dx - u.facing * 12,
            v.dy + 6,
            u.kind === "hero" ? 0.85 : 0.6,
            u.facing < 0,
          );
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
        if (u.kind === "hero") this.spawnSwing(v.dx, v.dy, u.facing, u.projectileSpeed > 0);
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

  /** Hero attack flourish: a sweeping slash arc for melee, a muzzle spark for
   *  ranged — drawn in the facing direction so swings read as deliberate hits. */
  private spawnSwing(x: number, y: number, facing: number, ranged: boolean): void {
    const s = this.scene;
    const cx = x + facing * (ranged ? 30 : 40);
    const cy = y - 22;
    if (ranged) {
      const flash = s.add
        .image(cx, cy, "spark")
        .setDepth(y + 60)
        .setScale(1.1)
        .setTint(0xfff1c0)
        .setBlendMode(Phaser.BlendModes.ADD);
      s.tweens.add({
        targets: flash,
        scale: 0,
        alpha: 0,
        duration: 160,
        ease: "Quad.Out",
        onComplete: () => flash.destroy(),
      });
      return;
    }
    // melee: a thin bright arc that sweeps down-forward, fading fast
    const g = s.add
      .graphics()
      .setDepth(y + 60)
      .setBlendMode(Phaser.BlendModes.ADD);
    const baseAng = facing >= 0 ? -0.9 : Math.PI + 0.9;
    const sweep = facing >= 0 ? 1.8 : -1.8;
    const r = 46;
    g.lineStyle(6, 0xffffff, 0.85);
    g.beginPath();
    g.arc(cx, cy, r, baseAng, baseAng + sweep, sweep < 0);
    g.strokePath();
    g.lineStyle(2, 0xbfe6ff, 0.9);
    g.beginPath();
    g.arc(cx, cy, r + 5, baseAng, baseAng + sweep, sweep < 0);
    g.strokePath();
    g.setScale(0.7);
    s.tweens.add({
      targets: g,
      scaleX: 1.1,
      scaleY: 1.1,
      alpha: 0,
      duration: 180,
      ease: "Quad.Out",
      onComplete: () => g.destroy(),
    });
  }

  /** A short burst of sparks spraying away from the attacker on a hit — the
   *  "damage particles" that give every strike a sense of impact. */
  private spawnHitSparks(
    x: number,
    y: number,
    nx: number,
    ny: number,
    tint: number,
    crit?: boolean,
  ): void {
    const s = this.scene;
    const baseAng = Math.atan2(ny, nx);
    const n = crit ? 7 : 4;
    for (let i = 0; i < n; i++) {
      const a = baseAng + (Math.random() - 0.5) * 1.5;
      const spd = (crit ? 90 : 60) + Math.random() * 70;
      const sp = s.add
        .image(x, y, "spark")
        .setDepth(y + 320)
        .setScale(0.18 + Math.random() * 0.16)
        .setTint(tint)
        .setBlendMode(Phaser.BlendModes.ADD);
      s.tweens.add({
        targets: sp,
        x: x + Math.cos(a) * spd,
        y: y + Math.sin(a) * spd + 18, // slight gravity droop
        scale: 0,
        alpha: 0,
        duration: 230 + Math.random() * 130,
        ease: "Quad.Out",
        onComplete: () => sp.destroy(),
      });
    }
  }

  /** A little kicked-up dust puff at the feet of a running unit. */
  private spawnDust(x: number, y: number, scale: number, flip: boolean): void {
    const s = this.scene;
    if (!s.anims.exists("fx-dust1")) return;
    const d = s.add
      .sprite(x, y, "fx-dust1", 0)
      .setScale(scale)
      .setAlpha(0.75)
      .setFlipX(flip)
      .setDepth(y - 2);
    d.play("fx-dust1");
    d.once("animationcomplete", () => d.destroy());
  }

  /** One-shot death at a unit's last position (for reaped creeps): play the real
   *  death sheet if the unit has one (barrel goblin's explosion), else collapse —
   *  plus the bouncing-skull pop either way. */
  private spawnDeathAnim(v: UnitView): void {
    if (v.dead) return; // a hero already played its death in-place
    const s = this.scene;
    const tex = v.sprite.texture.key;
    const dkey = `${tex}-death`;
    this.spawnSkull(v.dx, v.dy, 0.5);
    const corpse = s.add
      .sprite(v.dx, v.dy - 18, tex, v.sprite.frame.name)
      .setScale(v.sprite.scaleX, v.sprite.scaleY)
      .setFlipX(v.sprite.flipX)
      .setDepth(v.dy - 2);
    if (s.anims.exists(dkey)) {
      corpse.play(dkey);
      corpse.once("animationcomplete", () => {
        s.tweens.add({
          targets: corpse,
          alpha: 0,
          duration: 260,
          onComplete: () => corpse.destroy(),
        });
      });
    } else {
      this.collapseSprite(corpse, () => corpse.destroy());
    }
  }

  /** The pack's death skull: pops out, bounces, sinks into the ground. */
  private spawnSkull(x: number, y: number, scale: number): void {
    const s = this.scene;
    if (!s.anims.exists("skull-pop")) return;
    const sk = s.add
      .sprite(x + (Math.random() - 0.5) * 10, y - 14, "skull-pop", 0)
      .setScale(scale)
      .setDepth(y + 1);
    sk.play("skull-pop");
    sk.once("animationcomplete", () => sk.destroy());
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
    const shadow = s.add
      .image(0, 8, "shadow")
      .setDisplaySize(u.kind === "hero" ? 56 : 36, u.kind === "hero" ? 22 : 16)
      .setAlpha(0.5);
    const ring = s.add.graphics();
    const isPlayer = u.id === this.playerHeroId;
    const ringColor = u.neutral ? 0xd0a23a : u.team === "radiant" ? 0x4fa3ff : 0xff5a4a;
    ring
      .lineStyle(isPlayer ? 4 : 2.5, isPlayer ? 0xffe14a : ringColor, 1)
      .strokeEllipse(0, 10, u.kind === "hero" ? 56 : 38, u.kind === "hero" ? 26 : 18);
    const sprite = s.add.sprite(0, -18, tex, 0).setScale(scale);
    if (this.scene.anims.exists(animKey(u, "idle"))) sprite.play(animKey(u, "idle"));

    const barY = u.kind === "hero" ? -64 : -42;
    const bw = u.kind === "hero" ? 56 : 34;
    const hpBg = s.add
      .rectangle(0, barY, bw + 4, u.kind === "hero" ? 8 : 5, 0x0c1018)
      .setStrokeStyle(1, 0x000000, 0.6);
    const hpFill = s.add
      .rectangle(-bw / 2, barY, bw, u.kind === "hero" ? 6 : 4, 0x44d07a)
      .setOrigin(0, 0.5);
    let mpFill: Phaser.GameObjects.Rectangle | null = null;
    let label: Phaser.GameObjects.Text | null = null;
    const children: Phaser.GameObjects.GameObject[] = [shadow, ring, sprite, hpBg, hpFill];
    if (u.kind === "hero" && u.hero) {
      const mpBg = s.add
        .rectangle(0, barY + 8, bw + 4, 5, 0x0c1018)
        .setStrokeStyle(1, 0x000000, 0.6);
      mpFill = s.add.rectangle(-bw / 2, barY + 8, bw, 3, 0x4a8fff).setOrigin(0, 0.5);
      label = s.add
        .text(0, barY - 12, "", {
          fontFamily: FONT,
          fontSize: "13px",
          color: "#eaf0ff",
          stroke: "#1c1410",
          strokeThickness: 3,
        })
        .setOrigin(0.5);
      children.push(mpBg, mpFill, label);
    }
    const container = s.add.container(u.x, u.y, children).setDepth(u.y);
    const v: UnitView = {
      container,
      sprite,
      shadow,
      ring,
      hpBg,
      hpFill,
      mpFill,
      label,
      dx: u.x,
      dy: u.y,
      curAnim: "",
      lastAttackAt: 0,
      lastDustAt: 0,
      dead: false,
      recoilX: 0,
      recoilY: 0,
      flashUntil: 0,
    };
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
        if (p.kind === "fireball" && this.scene.anims.exists("sp-fireball-fly")) {
          // formed flying fireball (no mid-air explosion); rotated to face travel
          const fb = this.scene.add.sprite(p.x, p.y, "sp-fireball", 3).setScale(0.85);
          fb.play("sp-fireball-fly");
          img = fb;
        } else if (p.kind === "dynamite") {
          img = this.scene.add.image(p.x, p.y, "bomb").setScale(0.95);
        } else {
          img = this.scene.add.image(p.x, p.y, projTex(p)).setScale(0.7);
          if (p.kind === "bolt") img.setTint(0xb98bff); // magic bolts read distinct from arrows
        }
        img.setDepth(p.y + 200);
        this.projs.set(p.id, img);
      }
      img.setPosition(p.x, p.y);
      img.setDepth(p.y + 200);
      const ang = Math.atan2(p.ty - p.y, p.tx - p.x);
      if (p.kind === "arrow" || p.kind === "bolt") img.setRotation(ang + Math.PI / 2);
      else if (p.kind === "fireball") img.setRotation(ang); // tail trails behind the head
      else if (p.kind === "dynamite") img.setRotation(img.rotation + 0.4); // tumble
      else img.setRotation(0);
    }
    for (const [id, img] of this.projs)
      if (!seen.has(id)) {
        img.destroy();
        this.projs.delete(id);
      }
  }

  private syncGrounds(world: World, dt: number): void {
    const s = this.scene;
    const seen = new Set<string>();
    for (const g of world.groundEffects) {
      seen.add(g.id);
      const kind = groundFxKind(g.effect, !!g.allyHealPerTick);
      let gv = this.grounds.get(g.id);
      if (!gv) {
        const col = groundColor(g);
        const arc = s.add
          .circle(g.x, g.y, g.radius, col, kind === "storm" ? 0.1 : 0.2)
          .setStrokeStyle(2.5, col, 0.7)
          .setDepth(g.y - 10);
        const sprites: GroundView["sprites"] = [];
        // fire / heal zones tile a few looping effect sprites across the radius
        if (kind === "fire" || kind === "heal") {
          const sheet = kind === "fire" ? "sp-fire" : "sp-water";
          if (s.anims.exists(`${sheet}-loop`)) {
            const ring = Phaser.Math.Clamp(Math.round(g.radius / 80), 0, 6);
            const spots: Array<[number, number, number]> = [[0, 0, (g.radius * 1.1) / 128]];
            for (let i = 0; i < ring; i++) {
              const a = (i / ring) * Math.PI * 2;
              const rr = g.radius * 0.6;
              spots.push([Math.cos(a) * rr, Math.sin(a) * rr, (g.radius * 0.7) / 128]);
            }
            for (const [ox, oy, sc] of spots) {
              const sp = s.add
                .sprite(g.x + ox, g.y + oy, sheet, 0)
                .setScale(sc)
                .setAlpha(0.85)
                .setDepth(g.y - 6);
              if (kind === "heal") sp.setTint(0x9bf0b0).setBlendMode(Phaser.BlendModes.ADD);
              this.playLoop(sp, `${sheet}-loop`, Math.floor(Math.random() * 6));
              sprites.push({ sp, ox, oy });
            }
          }
        }
        gv = { arc, sprites, nextStrikeAt: 0 };
        this.grounds.set(g.id, gv);
      }
      gv.arc.setPosition(g.x, g.y);
      // followOwner zones (flashfire) move with the caster — keep sprites attached
      for (const { sp, ox, oy } of gv.sprites) {
        sp.setPosition(g.x + ox, g.y + oy);
        sp.setDepth(g.y - 6);
      }
      // storm zones rain lightning bolts on random points inside the radius
      if (kind === "storm" && s.anims.exists("sp-lightning")) {
        gv.nextStrikeAt -= dt * 1000;
        if (gv.nextStrikeAt <= 0) {
          gv.nextStrikeAt = 200 + Math.random() * 160;
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * g.radius;
          const bx = g.x + Math.cos(a) * rr;
          const by = g.y + Math.sin(a) * rr;
          const bolt = s.add
            .sprite(bx, by, "sp-lightning", 0)
            .setDepth(by + 500)
            .setScale((g.radius / 320) * 1.1)
            .setOrigin(0.5, 0.9)
            .setBlendMode(Phaser.BlendModes.ADD);
          bolt.play("sp-lightning");
          bolt.once("animationcomplete", () => bolt.destroy());
        }
      }
    }
    for (const [id, gv] of this.grounds)
      if (!seen.has(id)) {
        gv.arc.destroy();
        for (const { sp } of gv.sprites) sp.destroy();
        this.grounds.delete(id);
      }
  }

  private syncMines(world: World): void {
    const seen = new Set<string>();
    for (const m of world.mines.values()) {
      seen.add(m.id);
      let img = this.mines.get(m.id);
      if (!img) {
        img = this.scene.add
          .circle(m.x, m.y, 8, 0xff4d4d, 0.85)
          .setDepth(m.y)
          .setStrokeStyle(2, 0x661111);
        this.mines.set(m.id, img);
      }
    }
    for (const [id, img] of this.mines)
      if (!seen.has(id)) {
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
        const magic = fx.dtype === "magic";
        const tintCol = magic ? 0xc78bff : 0xffffff;
        // impact puff at the strike point — the clash spark that sells combat
        const puff = s.add
          .image(fx.x + (Math.random() - 0.5) * 12, fx.y, "spark")
          .setDepth(fx.y + 300)
          .setScale(0.5)
          .setTint(tintCol)
          .setAlpha(0.85)
          .setBlendMode(Phaser.BlendModes.ADD);
        s.tweens.add({
          targets: puff,
          scale: fx.crit ? 2.0 : 1.35,
          alpha: 0,
          duration: fx.crit ? 260 : 170,
          ease: "Quad.Out",
          onComplete: () => puff.destroy(),
        });
        // damage flash + knockback recoil + spark spray on the victim's sprite —
        // the impact reactions that make combat feel weighty/action-y. Recoil and
        // sparks fire only on real swings / crits / big nukes; small DoT & ground
        // ticks (every 0.5s) just get the cheap flash so burning units don't twitch
        // or spray particles twice a second.
        const bigHit = fx.isAttack === true || fx.crit === true || fx.amount >= 30;
        const vv = this.units.get(fx.targetId);
        if (vv && !vv.dead) {
          vv.sprite.setTint(magic ? 0xd9a6ff : 0xff8a8a);
          vv.flashUntil = s.time.now + (fx.crit ? 130 : 90);
          if (bigHit) {
            const kick = Math.min(fx.isAttack ? 16 : 9, 4 + fx.amount * 0.12) * (fx.crit ? 1.6 : 1);
            vv.recoilX += fx.nx * kick;
            vv.recoilY += fx.ny * kick;
          }
        }
        if (bigHit) this.spawnHitSparks(fx.x, fx.y, fx.nx, fx.ny, tintCol, fx.crit);
        // juice: a small camera kick when the player themselves takes a real hit
        if (fx.targetId === this.playerHeroId && fx.amount >= 35) {
          this.scene.cameras.main.shake(110, Math.min(0.006, 0.0016 + fx.amount / 40000));
        }
        const color = fx.dtype === "magic" ? "#c78bff" : fx.crit ? "#ffd23a" : "#ffffff";
        const size = fx.crit ? "22px" : "15px";
        const t = s.add
          .text(fx.x + (Math.random() - 0.5) * 16, fx.y, `${fx.amount}`, {
            fontFamily: FONT,
            fontSize: size,
            color,
            stroke: "#1c1410",
            strokeThickness: 4,
          })
          .setOrigin(0.5)
          .setDepth(90000);
        s.tweens.add({
          targets: t,
          y: fx.y - 38,
          alpha: 0,
          duration: 700,
          ease: "Cubic.Out",
          onComplete: () => t.destroy(),
        });
        break;
      }
      case "explosion": {
        sfx.explosion();
        // the Particle FX pack's cartoon explosions, played raw (their art carries
        // its own palette — no tint, no additive blend)
        const key =
          fx.radius >= 130 && s.anims.exists("fx-explode2") ? "fx-explode2" : "fx-explode1";
        if (s.anims.exists(key)) {
          const e = s.add.sprite(fx.x, fx.y - 10, key, 0).setDepth(fx.y + 400);
          e.setScale(Phaser.Math.Clamp(fx.radius / 85, 0.8, 2.4));
          e.play(key);
          e.once("animationcomplete", () => e.destroy());
        } else if (s.anims.exists("fx-explode")) {
          const e = s.add
            .sprite(fx.x, fx.y, "fx-explosion", 0)
            .setDepth(fx.y + 400)
            .setBlendMode(Phaser.BlendModes.ADD);
          e.setScale((fx.radius / 96) * 1.2).setTint(fx.color);
          e.play("fx-explode");
          e.once("animationcomplete", () => e.destroy());
        }
        break;
      }
      case "blink": {
        for (const [x, y] of [
          [fx.x, fx.y],
          [fx.x2, fx.y2],
        ] as const) {
          const c = s.add.circle(x, y, 24, 0x9b6bff, 0.6).setDepth(y + 100);
          s.tweens.add({
            targets: c,
            scale: 0,
            alpha: 0,
            duration: 300,
            onComplete: () => c.destroy(),
          });
        }
        break;
      }
      case "levelup": {
        const v = this.units.get(fx.unitId);
        if (fx.unitId === this.playerHeroId) sfx.level();
        const x = v ? v.dx : fx.x;
        const y = v ? v.dy : fx.y;
        const ring = s.add
          .circle(x, y + 10, 20, 0xffe14a, 0)
          .setStrokeStyle(4, 0xffe14a, 1)
          .setDepth(y + 50);
        s.tweens.add({
          targets: ring,
          scale: 3,
          alpha: 0,
          duration: 600,
          onComplete: () => ring.destroy(),
        });
        break;
      }
      case "gold": {
        if (fx.heroId !== this.playerHeroId) break;
        sfx.gold();
        const t = s.add
          .text(fx.x, fx.y, `+${fx.amount}`, {
            fontFamily: FONT,
            fontSize: "14px",
            color: "#ffd23a",
            stroke: "#1c1410",
            strokeThickness: 4,
          })
          .setOrigin(0.5)
          .setDepth(90000);
        s.tweens.add({
          targets: t,
          y: fx.y - 30,
          alpha: 0,
          duration: 800,
          onComplete: () => t.destroy(),
        });
        break;
      }
      case "heal": {
        const t = s.add
          .text(fx.x, fx.y - 20, `+${Math.round(fx.amount)}`, {
            fontFamily: FONT,
            fontSize: "14px",
            color: "#7bf08b",
            stroke: "#1c1410",
            strokeThickness: 4,
          })
          .setOrigin(0.5)
          .setDepth(90000);
        s.tweens.add({
          targets: t,
          y: fx.y - 50,
          alpha: 0,
          duration: 700,
          onComplete: () => t.destroy(),
        });
        break;
      }
      case "structureDown": {
        sfx.structureDown();
        s.cameras.main.shake(260, 0.006);
        if (s.anims.exists("fx-explode2")) {
          const e = s.add
            .sprite(fx.x, fx.y - 50, "fx-explode2", 0)
            .setDepth(fx.y + 500)
            .setScale(1.7);
          e.play("fx-explode2");
          e.once("animationcomplete", () => e.destroy());
        }
        break;
      }
      case "death": {
        if (fx.kind === "hero") sfx.death();
        if (fx.kind === "creep") {
          if (s.anims.exists("fx-dust2")) {
            const puff = s.add
              .sprite(fx.x, fx.y - 8, "fx-dust2", 0)
              .setDepth(fx.y + 10)
              .setScale(1.1)
              .setAlpha(0.9);
            puff.play("fx-dust2");
            puff.once("animationcomplete", () => puff.destroy());
          } else {
            const puff = s.add
              .image(fx.x, fx.y - 10, "spark")
              .setDepth(fx.y + 10)
              .setTint(0xdddddd)
              .setScale(1.5);
            s.tweens.add({
              targets: puff,
              scale: 0,
              alpha: 0,
              duration: 320,
              onComplete: () => puff.destroy(),
            });
          }
        }
        break;
      }
      case "cast": {
        if (fx.team === this.playerTeam) sfx.ability();
        const col = effectColor(fx.effect);
        const ring = s.add
          .circle(fx.x, fx.y + 6, 34, col, 0)
          .setStrokeStyle(3, col, 0.9)
          .setDepth(fx.y);
        s.tweens.add({
          targets: ring,
          scale: 0.2,
          alpha: 0,
          duration: 280,
          ease: "Quad.Out",
          onComplete: () => ring.destroy(),
        });
        // self/aura cast bursts (windfoot, flashfire, powder keg, blink puff…)
        const spec = abilityCastFx(fx.effect);
        if (spec && spec.at === "caster") this.spawnSpellSprite(fx.x, fx.y, spec.sheet, spec.scale, spec.tint);
        break;
      }
      case "ability": {
        this.playAbilityFx(fx);
        break;
      }
    }
  }

  /** Play a one-shot spell-effect sprite centred at (x,y). The packed effect art
   *  carries its own palette, so tint is applied lightly (ADD) only when given. */
  private spawnSpellSprite(
    x: number,
    y: number,
    sheet: string,
    scale: number,
    tint?: number,
  ): void {
    const s = this.scene;
    if (!s.anims.exists(sheet)) return;
    const sp = s.add
      .sprite(x, y, sheet, 0)
      .setDepth(y + 360)
      .setScale(scale);
    if (tint !== undefined) sp.setTint(tint);
    sp.play(sheet);
    sp.once("animationcomplete", () => sp.destroy());
  }

  private playAbilityFx(fx: Extract<FxEvent, { t: "ability" }>): void {
    const col = effectColor(fx.effect);
    // targeted spell bursts (shield bash, fanned daggers, death waltz, hex, heal…)
    const spec = abilityCastFx(fx.effect);
    if (spec && spec.at === "target")
      this.spawnSpellSprite(fx.x2, fx.y2, spec.sheet, spec.scale, spec.tint);
    // the one true skillshot LINE (Piercing Shot) → a soft electric beam, never a
    // bare white line.
    if (fx.effect === "stormcaller:Q") {
      this.spawnBeam(fx.x, fx.y - 16, fx.x2, fx.y2 - 16, 0x8fd0ff);
      return;
    }
    // area abilities → a soft radial impact glow sized to the zone (the detailed
    // art is the cast-fx sprite / explosion / ground zone; this just reads the AoE).
    if (fx.radius >= 90) this.spawnSoftImpact(fx.x2, fx.y2, fx.radius, col);
  }

  /** A soft glowing energy beam (stretched radial glow + bright core), not a flat
   *  line — for the piercing skillshot. */
  private spawnBeam(x1: number, y1: number, x2: number, y2: number, col: number): void {
    const s = this.scene;
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const depth = Math.max(y1, y2) + 320;
    const glow = s.add
      .image(mx, my, "glow")
      .setRotation(ang)
      .setDisplaySize(len, 60)
      .setTint(col)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.5)
      .setDepth(depth);
    const core = s.add
      .image(mx, my, "glow")
      .setRotation(ang)
      .setDisplaySize(len, 16)
      .setTint(0xeaf6ff)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.95)
      .setDepth(depth + 1);
    s.tweens.add({
      targets: [glow, core],
      alpha: 0,
      duration: 300,
      ease: "Quad.Out",
      onComplete: () => {
        glow.destroy();
        core.destroy();
      },
    });
    // a little crackle along the bolt
    for (let i = 1; i <= 4; i++) {
      const t = i / 5;
      this.spawnHitSparks(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, Math.cos(ang + 1.6), Math.sin(ang + 1.6), col, false);
    }
  }

  /** Soft radial impact glow + faint ring sized to an ability's radius (replaces
   *  the old harsh hard-stroked ring). */
  private spawnSoftImpact(x: number, y: number, r: number, col: number): void {
    const s = this.scene;
    const sc = (r * 2.2) / 128; // "glow" is 128px
    const g = s.add
      .image(x, y, "glow")
      .setTint(col)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.5)
      .setDepth(y + 200)
      .setScale(sc * 0.6);
    s.tweens.add({ targets: g, scale: sc, alpha: 0, duration: 360, ease: "Quad.Out", onComplete: () => g.destroy() });
    const ring = s.add
      .circle(x, y, r, col, 0)
      .setStrokeStyle(3, col, 0.45)
      .setDepth(y + 201)
      .setScale(0.5);
    s.tweens.add({ targets: ring, scale: 1.05, alpha: 0, duration: 380, ease: "Quad.Out", onComplete: () => ring.destroy() });
  }
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
  const m: Record<string, string> = {
    ironvow: "Garran",
    duskblade: "Vesper",
    stormcaller: "Aelwyn",
    emberhex: "Grix",
    boomtinker: "Fizzle",
    brewkeeper: "Bramble",
  };
  return m[defId] ?? defId;
}
