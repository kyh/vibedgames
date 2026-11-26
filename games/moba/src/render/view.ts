import type Phaser from "phaser";
import { BlendModes, Math as PhaserMath, Scenes } from "phaser";

import {
  BASES,
  BRIDGES,
  CELL,
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
import type { Vec2 } from "../sim/math";
import { CLIFF_FRAMES, FLAT_AUTOTILE, SLOPE_FRAMES, autotileFrame, autotileMask } from "./autotile";
import { sfx } from "./audio";
import { FONT } from "./font";
import { abilityCastFx, effectColor, groundFxKind, hitColor } from "./fx-map";
import type { SpellCastFx } from "./fx-map";
import { CommonFx } from "./common-fx";
import { layoutHeroPlates } from "./combat-plates";
import type { HeroPlate } from "./combat-plates";
import { attackClipFrame, attackPose, attackRecoveryFrame } from "./attack-pose";
import type { AttackCue } from "./attack-pose";
import { spellPose } from "./spell-pose";
import type { SpellCue } from "./spell-pose";
import { presentationSettings, watchPresentationSettings } from "./presentation-settings";
import { animKey, structureDestroyedTex, unitSprite } from "./sprites";

const COLS = GRID.cols;
const ROWS = GRID.rows;

const LIFT = ELEV_LIFT;

const D_WATER = -130;
const D_FOAM = -116;
const D_FLAT = -110;
const D_SHADOW = -105;
const D_ELEV = -100;
const D_CLIFF = -95;
const D_WASH = -92;
const D_RING = -90;
const D_BRIDGE_SHADOW = -89;
const D_BRIDGE = -84;
const DEPTH_DECAL = -50;
const DEPTH_GROUND_ZONE = -40;
const DEPTH_UNIT_PLATE = 91_000;

const BRIDGE_L = 0;
const BRIDGE_M = 1;
const BRIDGE_R = 2;
const BRIDGE_SHADOW = 11;

const bridgeFrame = (cx: number, x0: number, x1: number) => {
  if (cx === x0) {
    return BRIDGE_L;
  }

  if (cx === x1) {
    return BRIDGE_R;
  }

  return BRIDGE_M;
};

const cliffTopFrame = (leftEnd: boolean, rightEnd: boolean) => {
  if (leftEnd && rightEnd) {
    return CLIFF_FRAMES.topNarrow;
  }

  if (leftEnd) {
    return CLIFF_FRAMES.topL;
  }

  if (rightEnd) {
    return CLIFF_FRAMES.topR;
  }

  return CLIFF_FRAMES.topM;
};

const slopeFrame = (left: boolean, topRow: boolean) => {
  if (topRow) {
    return left ? SLOPE_FRAMES.leftTop : SLOPE_FRAMES.rightTop;
  }

  return left ? SLOPE_FRAMES.leftBot : SLOPE_FRAMES.rightBot;
};

const reticleSize = (u: Unit, struct: boolean) => {
  if (struct) {
    return Math.max(120, u.radius * 2.4);
  }

  return u.kind === "hero" ? 96 : 68;
};

interface HitBurstTiers {
  reduced: number;
  focused: number;
  crit: number;
  normal: number;
}

const projTrailColor = (p: Projectile) => {
  if (p.kind === "fireball") {
    return 0xff_9a_3a;
  }

  if (p.kind === "bolt") {
    return 0xb9_8b_ff;
  }

  if (p.kind === "dynamite") {
    return 0xff_ae_4a;
  }

  return 0xdf_e8_ff;
};

const damageLabelColor = (magic: boolean, crit: boolean | undefined) => {
  if (magic) {
    return "#c78bff";
  }

  return crit === true ? "#ffd23a" : "#ffffff";
};

const unitRingColor = (u: Unit) => {
  if (u.neutral === true) {
    return 0xd0_a2_3a;
  }

  return u.team === "radiant" ? 0x4f_a3_ff : 0xff_5a_4a;
};

const structureScale = (tier: string) => {
  if (tier === "ancient") {
    return 1.7;
  }

  if (tier === "base") {
    return 1.15;
  }

  return 1.35;
};

const rng2 = (x: number, y: number) => {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43_758.5453;

  return v - Math.floor(v);
};

interface UnitView {
  container: Phaser.GameObjects.Container;
  plate: Phaser.GameObjects.Container;
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
  lastAttackAt: number;
  lastSwingAt: number;
  attackCue: AttackCue | null;
  spellCue: SpellCue | null;
  lastCast: { at: number; effect: string } | null;
  baseScale: number;
  lastDustAt: number;
  dead: boolean;
  recoilX: number;
  recoilY: number;
  flashUntil: number;
  stunStars: Phaser.GameObjects.Image[];
  shieldFx: Phaser.GameObjects.Arc | null;
}

interface GroundView {
  arc: Phaser.GameObjects.Arc;
  sprites: { sp: Phaser.GameObjects.Sprite; ox: number; oy: number }[];
  nextStrikeAt: number;
}

interface StructView {
  sprite: Phaser.GameObjects.Image;
  hpBg: Phaser.GameObjects.Rectangle;
  hpFill: Phaser.GameObjects.Rectangle;
  range: Phaser.GameObjects.Arc | null;
  fires: Phaser.GameObjects.Sprite[];
  dead: boolean;
}

const teamHpColor = (team: string) => (team === "radiant" ? 0x44_d0_7a : 0xff_5d_5d);

const projTex = (p: Projectile) => {
  if (p.kind === "fireball") {
    return "glow";
  }

  if (p.kind === "dynamite") {
    return "spark";
  }

  return "fx-arrow";
};

const groundColor = (g: GroundEffect) => {
  if (g.allyHealPerTick !== undefined && g.allyHealPerTick !== 0) {
    return 0x6b_e0_7a;
  }

  if (g.effect.includes("storm")) {
    return 0x6a_a8_ff;
  }

  return 0xff_6a_2a;
};

const shortName = (defId: string) => {
  const m = new Map([
    ["ironvow", "Garran"],
    ["duskblade", "Vesper"],
    ["stormcaller", "Aelwyn"],
    ["emberhex", "Grix"],
    ["boomtinker", "Fizzle"],
    ["brewkeeper", "Bramble"],
  ]);

  return m.get(defId) ?? defId;
};

export class WorldView {
  private readonly scene: Phaser.Scene;
  private readonly commonFx: CommonFx;
  private readonly units = new Map<string, UnitView>();
  private readonly structs = new Map<string, StructView>();
  private readonly projs = new Map<string, Phaser.GameObjects.Image | Phaser.GameObjects.Sprite>();
  private readonly projTrailAt = new Map<string, number>();
  private readonly grounds = new Map<string, GroundView>();
  private readonly mines = new Map<string, Phaser.GameObjects.Arc>();
  private readonly shoreCells: { x: number; y: number }[] = [];
  private splashAcc = 0;
  private readonly scorches: Phaser.GameObjects.Image[] = [];
  private reticle: Phaser.GameObjects.Image | null = null;
  private reticleId = "";
  private aimDir: Vec2 | null = null;
  private aimChevron: Phaser.GameObjects.Image | null = null;
  private plateLeaders: Phaser.GameObjects.Graphics | null = null;
  private reducedMotion = false;
  private focused = false;
  private readonly clouds: Phaser.GameObjects.Image[] = [];
  playerHeroId = "";
  playerTeam: "radiant" | "dire" = "radiant";
  /** Where to draw a unit or projectile, by id. Set, bodies sit exactly there
   *  (falling back to the world's own x/y) — the game scene hands over sim
   *  positions blended between steps, or a guest's interpolated ones. Unset
   *  (showcase, trailer), bodies chase the sim position to hide its 30 Hz step. */
  poseOf: ((id: string) => Vec2 | undefined) | null = null;

  private trauma = 0;
  shakeX = 0;
  shakeY = 0;
  shakeRot = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.commonFx = new CommonFx(scene);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const syncMotion = () => {
      const settings = presentationSettings();
      this.reducedMotion = motion.matches || settings.motion === "reduced";
      this.focused = settings.effects === "focused";
      this.commonFx.setFocused(this.focused);

      for (const cloud of this.clouds) {
        cloud.setVisible(!this.focused);
      }

      if (this.reducedMotion) {
        this.trauma = 0;
      }
    };

    syncMotion();
    const stopSettings = watchPresentationSettings(syncMotion);
    motion.addEventListener("change", syncMotion);
    scene.events.once(Scenes.Events.SHUTDOWN, () => {
      motion.removeEventListener("change", syncMotion);
      stopSettings();
    });
  }

  private playLoop(sprite: Phaser.GameObjects.Sprite, key: string, startSeed = 0) {
    const anim = this.scene.anims.get(key);
    const n = anim?.frames.length ?? 0;

    if (n <= 0) {
      return;
    }

    sprite.play({ key, startFrame: ((Math.floor(startSeed) % n) + n) % n });
  }

  buildTerrain() {
    const s = this.scene;

    s.add.tileSprite(0, 0, WORLD.width, WORLD.height, "t-water").setOrigin(0, 0).setDepth(D_WATER);

    this.buildFoam();

    this.buildGroundLayer(false, D_FLAT);

    this.buildPlateauShadows();
    this.buildCliffs();
    this.buildGroundLayer(true, D_ELEV, -LIFT);
    this.buildRamps();

    this.buildWash();

    this.buildBridges();

    for (const team of ["radiant", "dire"] as const) {
      const b = BASES[team];
      const col = team === "radiant" ? 0x4f_a3_ff : 0xff_5a_4a;
      s.add.circle(b.fountain.x, b.fountain.y, b.fountainRadius, col, 0.05).setDepth(D_RING);
      s.add.ellipse(b.fountain.x, b.fountain.y, 168, 122, 0x6a_7a_82, 1).setDepth(DEPTH_DECAL - 2);
      s.add.ellipse(b.fountain.x, b.fountain.y, 146, 102, 0x2e_8f_8a, 1).setDepth(DEPTH_DECAL - 1);
      s.add
        .ellipse(b.fountain.x, b.fountain.y - 4, 104, 68, 0x6f_d6_cf, 0.85)
        .setDepth(DEPTH_DECAL);
      s.add
        .ellipse(b.fountain.x, b.fountain.y - 6, 56, 34, 0xc9_f3_ef, 0.9)
        .setDepth(DEPTH_DECAL + 1);

      const pulse = s.add
        .ellipse(b.fountain.x, b.fountain.y - 4, 70, 44, col, 0)
        .setStrokeStyle(3, 0xea_ff_fd, 0.8)
        .setDepth(DEPTH_DECAL + 2);

      s.tweens.add({
        alpha: 0,
        duration: 2200,
        ease: "Sine.Out",
        repeat: -1,
        scaleX: 1.7,
        scaleY: 1.7,
        targets: pulse,
      });
      this.shoreCells.push({ x: b.fountain.x, y: b.fountain.y });
      const houseTex = `b-house-${team === "radiant" ? "blue" : "red"}`;

      if (s.textures.exists(houseTex)) {
        const sign = team === "radiant" ? 1 : -1;

        for (const [hx, hy] of [
          [b.fountain.x + sign * 110, b.fountain.y - 250],
          [b.fountain.x + sign * 90, b.fountain.y + 240],
        ] as const) {
          if (!isLandCell(Math.floor(hx / CELL), Math.floor(hy / CELL))) {
            continue;
          }

          s.add.image(hx, hy, houseTex).setOrigin(0.5, 0.8).setDepth(hy);
        }
      }
    }

    this.buildRoshanPit();

    if (s.textures.exists("deco-goldmine")) {
      for (const c of NEUTRAL_CAMPS) {
        if (c.kind !== "large") {
          continue;
        }

        s.add
          .image(c.x, c.y - 64, "deco-goldmine")
          .setOrigin(0.5, 0.78)
          .setDepth(c.y - 64);
      }
    }

    this.buildTrees();

    this.buildScatter();

    for (const c of NEUTRAL_CAMPS) {
      const boss = c.kind === "roshan";
      s.add
        .circle(c.x, c.y, boss ? 130 : 70, 0x00_00_00, 0)
        .setStrokeStyle(boss ? 4 : 3, boss ? 0x8a_3a_2a : 0x4a_6a_34, boss ? 0.4 : 0.3)
        .setDepth(D_RING);
    }

    this.buildWaterRocks();
    this.buildClouds();
    this.buildAmbientLife();
    this.buildLightMotes();
  }

  private buildLightMotes() {
    const s = this.scene;
    const COUNT = 18;

    for (let i = 0; i < COUNT; i += 1) {
      const x = rng2(i * 7, 3) * WORLD.width;
      const y = rng2(2, i * 11) * WORLD.height;

      const m = s.add
        .image(x, y, "spark")
        .setScale(0.12 + rng2(i, i) * 0.13)
        .setAlpha(0.28 + rng2(i, 4) * 0.22)
        .setTint(0xff_f6_d8)
        .setDepth(8600)
        .setBlendMode(BlendModes.ADD);

      s.tweens.add({
        duration: 9000 + rng2(i, 2) * 8000,
        ease: "Sine.InOut",
        repeat: -1,
        targets: m,
        x: x + (rng2(i, 5) - 0.5) * 150,
        y: y - 60 - rng2(i, 9) * 130,
        yoyo: true,
      });
      s.tweens.add({
        alpha: 0.08,
        delay: rng2(i, i) * 3000,
        duration: 2200 + rng2(i, 6) * 2600,
        ease: "Sine.InOut",
        repeat: -1,
        targets: m,
        yoyo: true,
      });
    }
  }

  private buildRoshanPit() {
    const s = this.scene;
    const pit = NEUTRAL_CAMPS.find((c) => c.kind === "roshan");

    if (!pit) {
      return;
    }

    s.add
      .ellipse(pit.x, pit.y, 330, 240, 0x3a_2c_20, 0.3)
      .setDepth(D_RING - 1)
      .setBlendMode(BlendModes.MULTIPLY);
    s.add
      .ellipse(pit.x, pit.y, 220, 156, 0x2c_21_18, 0.25)
      .setDepth(D_RING - 1)
      .setBlendMode(BlendModes.MULTIPLY);

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

    for (const [i, key] of props.entries()) {
      if (!s.textures.exists(key)) {
        continue;
      }

      const a = (i / props.length) * Math.PI * 2 + 0.5;
      const r = 95 + rng2(i * 13, i * 7) * 75;
      const x = pit.x + Math.cos(a) * r * 1.25;
      const y = pit.y + Math.sin(a) * r * 0.8;
      s.add
        .image(x, y, key)
        .setScale(0.85 + rng2(i, i * 3) * 0.3)
        .setAngle((rng2(i * 5, i) - 0.5) * 50)
        .setDepth(y);
    }
  }

  private buildFoam() {
    const s = this.scene;
    const hasFoam = s.textures.exists("foam");

    const neighbours = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] satisfies [number, number][];

    for (let cy = 0; cy < ROWS; cy += 1) {
      for (let cx = 0; cx < COLS; cx += 1) {
        const land = isLandCell(cx, cy);
        const boundary = neighbours.some(([dx, dy]) => isLandCell(cx + dx, cy + dy) !== land);

        if (!boundary) {
          continue;
        }

        const x = cx * CELL + CELL / 2;
        const y = cy * CELL + CELL / 2;

        if (!land) {
          this.shoreCells.push({ x, y });
          continue;
        }

        if (!hasFoam) {
          continue;
        }

        const f = s.add.sprite(x, y, "foam", 0).setDepth(D_FOAM);
        this.playLoop(f, "foam-loop", cx * 7 + cy * 5);
      }
    }
  }

  private buildGroundLayer(elevated: boolean, depth: number, yOff = 0) {
    const s = this.scene;

    if (!s.textures.exists("tiles-img")) {
      return;
    }

    const inSet = (cx: number, cy: number) =>
      elevated ? isHighCell(cx, cy) : isLandCell(cx, cy) && !isHighCell(cx, cy);

    const out = (cx: number, cy: number) => (elevated ? !isHighCell(cx, cy) : !isLandCell(cx, cy));

    const data: number[][] = [];

    for (let cy = 0; cy < ROWS; cy += 1) {
      const row: number[] = [];

      for (let cx = 0; cx < COLS; cx += 1) {
        if (!inSet(cx, cy)) {
          row.push(-1);
          continue;
        }

        row.push(autotileFrame(elevated, autotileMask(out, cx, cy)));
      }

      data.push(row);
    }

    const map = s.make.tilemap({ data, tileHeight: CELL, tileWidth: CELL });
    const tiles = map.addTilesetImage(elevated ? "tilesE" : "tilesF", "tiles-img");

    if (tiles) {
      map.createLayer(0, tiles, 0, yOff)?.setDepth(depth);
    }
  }

  private buildPlateauShadows() {
    const s = this.scene;

    if (!s.textures.exists("tshadow")) {
      return;
    }

    for (let cy = 0; cy < ROWS; cy += 1) {
      for (let cx = 0; cx < COLS; cx += 1) {
        if (!isHighCell(cx, cy)) {
          continue;
        }

        s.add
          .image(cx * CELL + CELL / 2, (cy + 1) * CELL + CELL / 2, "tshadow")
          .setDepth(D_SHADOW)
          .setAlpha(0.8);
      }
    }
  }

  private buildCliffs() {
    const s = this.scene;

    if (!s.textures.exists("tiles")) {
      return;
    }

    for (let cy = 0; cy < ROWS; cy += 1) {
      for (let cx = 0; cx < COLS; cx += 1) {
        if (!isHighCell(cx, cy) || isHighCell(cx, cy + 1)) {
          continue;
        }

        if (isRampCell(cx, cy + 1)) {
          continue;
        }

        const cxp = cx * CELL + CELL / 2;

        const leftEnd =
          !isHighCell(cx - 1, cy) || isHighCell(cx - 1, cy + 1) || isRampCell(cx - 1, cy + 1);

        const rightEnd =
          !isHighCell(cx + 1, cy) || isHighCell(cx + 1, cy + 1) || isRampCell(cx + 1, cy + 1);

        const tile = cliffTopFrame(leftEnd, rightEnd);
        const wallTopY = (cy + 1) * CELL - LIFT;
        s.add.ellipse(cxp, wallTopY + CELL + 2, CELL + 10, 16, 0x05_08_0e, 0.3).setDepth(D_SHADOW);
        s.add.image(cxp, wallTopY, "tiles", tile).setOrigin(0.5, 0).setDepth(D_CLIFF);
      }
    }
  }

  private buildRamps() {
    const s = this.scene;

    if (!s.textures.exists("tiles-img") || !s.textures.exists("tiles")) {
      return;
    }

    const FILL = FLAT_AUTOTILE.get(0) ?? 10;

    for (let cy = 0; cy < ROWS; cy += 1) {
      for (let cx = 0; cx < COLS; cx += 1) {
        const r = rampAt(cx, cy);

        if (!r) {
          continue;
        }

        const cxp = cx * CELL + CELL / 2;
        const lift = elevationFrac(cxp, cy * CELL + CELL / 2) * LIFT;
        s.add
          .image(cxp, cy * CELL - lift, "tiles", FILL)
          .setOrigin(0.5, 0)
          .setDisplaySize(CELL + 2, CELL + LIFT)
          .setDepth(D_CLIFF + 1);
        const left = r.dir === "E";
        const tile = slopeFrame(left, cy === r.y0);
        s.add
          .image(cxp, cy * CELL - lift, "tiles", tile)
          .setOrigin(0.5, 0)
          .setDepth(D_CLIFF + 2);
      }
    }
  }

  private buildWash() {
    const wash = this.scene.add.graphics().setDepth(D_WASH).setBlendMode(BlendModes.MULTIPLY);
    wash.fillStyle(0xff_e2_b8, 0.45);

    for (let cy = 0; cy < ROWS; cy += 1) {
      let run = -1;

      for (let cx = 0; cx <= COLS; cx += 1) {
        const land = cx < COLS && isLandCell(cx, cy);

        if (land && run < 0) {
          run = cx;
        }

        if (!land && run >= 0) {
          wash.fillRect(run * CELL, cy * CELL, (cx - run) * CELL, CELL);
          run = -1;
        }
      }
    }
  }

  private buildBridges() {
    const s = this.scene;

    if (!s.textures.exists("t-bridge")) {
      return;
    }

    for (const b of BRIDGES) {
      for (let cy = b.y0; cy <= b.y1; cy += 1) {
        for (let cx = b.x0; cx <= b.x1; cx += 1) {
          if (isLandCell(cx, cy)) {
            continue;
          }

          s.add
            .image(cx * CELL + CELL / 2, cy * CELL + CELL / 2 + 14, "t-bridge", BRIDGE_SHADOW)
            .setDepth(D_BRIDGE_SHADOW)
            .setAlpha(0.55);
        }
      }

      const yTop = b.y0 * CELL + CELL / 2;
      const yBot = b.y1 * CELL + CELL / 2;
      let i = 0;

      for (let y = yTop; y <= yBot; y += CELL / 2) {
        for (let cx = b.x0; cx <= b.x1; cx += 1) {
          const frame = bridgeFrame(cx, b.x0, b.x1);
          s.add.image(cx * CELL + CELL / 2, y, "t-bridge", frame).setDepth(D_BRIDGE - i);
        }

        i += 1;
      }
    }
  }

  private buildTrees() {
    const s = this.scene;
    const deciduous = [1, 2, 3, 4].filter((i) => s.textures.exists(`ftree${i}`));
    const hasPine = s.textures.exists("t-tree");
    const AUTUMN = [0xf4_d2_4a, 0xe9_a2_3a, 0xf2_c1_4e, 0xe6_b3_4a];

    const plant = (tx: number, ty: number, seed: number) => {
      const cx = Math.floor(tx / CELL);
      const cy = Math.floor(ty / CELL);

      if (!isLandCell(cx, cy) || isCliffCell(cx, cy)) {
        return;
      }

      if (isWalkableHighCell(cx, cy) || isRampCell(cx, cy)) {
        return;
      }

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

        if (pick < 0.12) {
          tree.setTint(AUTUMN[Math.floor(rng2(ty, tx) * AUTUMN.length) % AUTUMN.length]);
        }

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

    for (const t of TREE_CLUSTERS) {
      const n = Math.max(6, Math.floor(t.r / 24));

      for (let i = 0; i < n; i += 1) {
        const a = (i / n) * Math.PI * 2 + (t.x % 7);
        const rr = t.r * (0.2 + 0.75 * rng2(t.x + i, t.y - i));
        plant(t.x + Math.cos(a) * rr, t.y + Math.sin(a) * rr, i);
      }
    }

    for (let cy = 0; cy < ROWS; cy += 1) {
      for (let cx = 0; cx < COLS; cx += 1) {
        if (!isHighCell(cx, cy) || isWalkableHighCell(cx, cy) || rng2(cx * 3, cy * 5) > 0.16) {
          continue;
        }

        const tx = cx * CELL + CELL / 2 + (rng2(cx, cy + 1) - 0.5) * 40;
        const ty = cy * CELL + CELL / 2 + (rng2(cx + 1, cy) - 0.5) * 40;

        const nearAncient = (["radiant", "dire"] as const).some(
          (t) => (tx - BASES[t].ancient.x) ** 2 + (ty - BASES[t].ancient.y) ** 2 < 320 * 320,
        );

        if (nearAncient) {
          continue;
        }

        if (hasPine) {
          const tree = s.add
            .sprite(tx, ty - LIFT, "t-tree", 0)
            .setOrigin(0.5, 0.86)
            .setScale(0.9)
            .setDepth(ty - LIFT);

          this.playLoop(tree, "tree-sway", Math.floor(rng2(ty, tx) * 6));
        }
      }
    }
  }

  private buildScatter() {
    const s = this.scene;
    const step = 3;

    for (let cy = 2; cy < ROWS - 2; cy += step) {
      for (let cx = 2; cx < COLS - 2; cx += step) {
        const r = rng2(cx, cy);

        if (r > 0.42) {
          continue;
        }

        const x = cx * CELL + CELL / 2 + (rng2(cx + 9, cy) - 0.5) * step * CELL * 0.9;
        const y = cy * CELL + CELL / 2 + (rng2(cx, cy + 9) - 0.5) * step * CELL * 0.9;
        const ccx = Math.floor(x / CELL);
        const ccy = Math.floor(y / CELL);

        if (!isLandCell(ccx, ccy) || isCliffCell(ccx, ccy) || isRampCell(ccx, ccy)) {
          continue;
        }

        const near = (fx: number, fy: number) => (x - fx) ** 2 + (y - fy) ** 2 < 420 * 420;

        if (near(BASES.radiant.fountain.x, BASES.radiant.fountain.y)) {
          continue;
        }

        if (near(BASES.dire.fountain.x, BASES.dire.fountain.y)) {
          continue;
        }

        const lift = isHighCell(ccx, ccy) ? -LIFT : 0;

        if (r < 0.08) {
          const key = `deco-rock${1 + Math.floor(rng2(cx, cy + 3) * 4)}`;

          if (s.textures.exists(key)) {
            s.add
              .image(x, y + lift, key)
              .setScale(0.7 + rng2(x, y) * 0.3)
              .setDepth(y + lift);
          }
        } else if (r < 0.16) {
          const n = 1 + Math.floor(rng2(cx + 3, cy) * 4);
          const key = `deco-bush${n}`;

          if (!s.textures.exists(key)) {
            continue;
          }

          const bush = s.add
            .sprite(x, y + lift, key, 0)
            .setScale(0.55 + rng2(x, y) * 0.25)
            .setDepth(y + lift);

          this.playLoop(bush, `${key}-sway`, Math.floor(rng2(y, x) * 8));
        } else {
          const key = `deco-${String(1 + Math.floor(rng2(cx + 5, cy + 5) * 18)).padStart(2, "0")}`;

          if (s.textures.exists(key)) {
            s.add
              .image(x, y + lift, key)
              .setScale(0.8 + rng2(x, y) * 0.3)
              .setDepth(y + lift)
              .setAlpha(0.95);
          }
        }
      }
    }
  }

  private buildWaterRocks() {
    const s = this.scene;

    if (!s.textures.exists("wrock1")) {
      return;
    }

    for (let cy = 2; cy < ROWS - 2; cy += 2) {
      for (let cx = 2; cx < COLS - 2; cx += 2) {
        if (isLandCell(cx, cy)) {
          continue;
        }

        const r = rng2(cx * 2, cy * 2);

        if (r > 0.1) {
          continue;
        }

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

  private buildClouds() {
    const s = this.scene;

    if (!s.textures.exists("clouds")) {
      return;
    }

    const COUNT = 10;

    for (let i = 0; i < COUNT; i += 1) {
      const frame = (i * 3) % 8;
      const x = rng2(i * 13, 1) * WORLD.width;
      const y = rng2(1, i * 17) * WORLD.height;

      const c = s.add
        .image(x, y, "clouds", frame)
        .setScale(0.7 + rng2(i, i) * 0.6)
        .setAlpha(0.45 + rng2(i, 3) * 0.25)
        .setVisible(!this.focused)
        .setDepth(9000);

      const dist = 600 + rng2(i, 9) * 900;
      this.clouds.push(c);
      s.tweens.add({
        duration: 30_000 + rng2(i, 5) * 30_000,
        ease: "Sine.InOut",
        repeat: -1,
        targets: c,
        x: x + dist,
        yoyo: true,
      });
    }
  }

  private buildAmbientLife() {
    const s = this.scene;

    if (!s.textures.exists("sheep")) {
      return;
    }

    const spots: { x: number; y: number }[] = [
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
      if (!isLandCell(Math.floor(p.x / CELL), Math.floor(p.y / CELL))) {
        continue;
      }

      const sh = s.add.sprite(p.x, p.y, "sheep", 0).setScale(0.5).setDepth(p.y);
      this.playLoop(sh, "sheep-idle", Math.floor(rng2(p.x, p.y) * 8));
      s.tweens.add({
        duration: 6000 + rng2(p.x, p.y) * 6000,
        ease: "Sine.InOut",
        onUpdate: () => sh.setDepth(sh.y),
        repeat: -1,
        targets: sh,
        x: p.x + (rng2(p.x, 2) - 0.5) * 160,
        y: p.y + (rng2(2, p.y) - 0.5) * 120,
        yoyo: true,
      });
    }
  }

  /** Build structure sprites from static map data (works before any world). */
  buildStructures() {
    const make = (id: string, team: Team, tier: string, x: number, y: number) => {
      const tex =
        tier === "ancient"
          ? `b-castle-${team === "radiant" ? "blue" : "red"}`
          : `b-tower-${team === "radiant" ? "blue" : "red"}`;

      const scale = structureScale(tier);
      const hpY = tier === "ancient" ? 150 : 110;
      const w = tier === "ancient" ? 120 : 64;

      const sp = this.scene.add
        .image(x, y - 30, tex)
        .setScale(scale)
        .setDepth(y);

      const hpBg = this.scene.add.rectangle(x, y - hpY, w + 4, 9, 0x10_15_22).setDepth(y + 1);

      const hpFill = this.scene.add
        .rectangle(x - w / 2, y - hpY, w, 7, teamHpColor(team))
        .setOrigin(0, 0.5)
        .setDepth(y + 2);

      this.structs.set(id, { dead: false, fires: [], hpBg, hpFill, range: null, sprite: sp });
    };

    for (const t of TOWERS) {
      make(t.id, t.team, t.tier, t.x, t.y);
    }

    for (const team of ["radiant", "dire"] as const) {
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
  setTarget(id: string) {
    this.reticleId = id;
  }

  /** Per-frame sync of all dynamic objects to the world. */
  sync(world: World, dt: number) {
    this.syncStructures(world);
    this.admitSpellCues(world);
    this.syncUnits(world, dt);
    this.syncHeroPlates(world);
    this.syncProjectiles(world);
    this.syncGrounds(world, dt);
    this.syncMines(world);
    this.syncReticle(world);
    this.syncAimChevron();
    this.drainFx(world);
    this.commonFx.update(dt);
    this.tickAmbientSplashes(dt);
    this.tickShake(dt);
  }

  fxCounts() {
    return this.commonFx.counts();
  }

  /** Add screen-shake trauma (0..1), clamped. Bigger events add more. */
  addTrauma(amount: number) {
    if (this.reducedMotion) {
      return;
    }

    this.trauma = Math.min(1, this.trauma + amount);
  }

  private traumaAt(x: number, y: number, base: number) {
    const v = this.scene.cameras.main.worldView;
    const d = Math.hypot(x - (v.x + v.width / 2), y - (v.y + v.height / 2));
    const falloff = Math.max(0, 1 - d / 1000);

    if (falloff > 0) {
      this.addTrauma(base * falloff);
    }
  }

  private soundGainAt(x: number, y: number) {
    const v = this.scene.cameras.main.worldView;
    const distance = Math.hypot(x - v.centerX, y - v.centerY);

    return Math.max(0, 1 - Math.max(0, distance - 180) / 1200);
  }

  private tickShake(dt: number) {
    if (this.trauma <= 0) {
      this.shakeX = 0;
      this.shakeY = 0;
      this.shakeRot = 0;

      return;
    }

    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    const s = this.trauma * this.trauma;
    const t = this.scene.time.now;
    this.shakeX = Math.sin(t * 0.055) * 15 * s;
    this.shakeY = Math.cos(t * 0.063 + 1.3) * 15 * s;
    this.shakeRot = Math.sin(t * 0.048 + 0.7) * 0.022 * s;
  }

  /** The local hero's resolved cast aim, shown as a chevron on the ground ring. */
  setAim(dir: Vec2 | null) {
    this.aimDir = dir;
  }

  private syncAimChevron() {
    const v = this.aimDir ? this.units.get(this.playerHeroId) : undefined;

    if (!v || v.dead || !this.aimDir) {
      this.aimChevron?.setVisible(false);

      return;
    }

    if (!this.aimChevron) {
      this.aimChevron = this.scene.add.image(0, 0, "fx-chevron").setTint(0xff_e1_4a).setAlpha(0.9);
    }

    const { x, y } = this.aimDir;
    this.aimChevron
      .setVisible(true)
      .setPosition(v.container.x + x * 34, v.container.y + 10 + y * 16)
      .setRotation(Math.atan2(y, x))
      .setDepth(v.container.depth - 0.5);
  }

  private syncReticle(world: World) {
    const target = this.reticleTarget(world);

    if (!target) {
      if (this.reticle) {
        this.reticle.setVisible(false);
      }

      return;
    }

    const { u, struct, v } = target;

    if (!this.reticle) {
      this.reticle = this.scene.add.image(0, 0, "cursor-target").setDepth(89_000);
    }

    const size = reticleSize(u, struct);
    const bx = struct ? u.x : (v?.dx ?? u.x);
    const by = struct ? u.y : (v?.dy ?? u.y);
    const elev = elevationFrac(bx, by) * LIFT;
    const cx = bx;
    const cy = (struct ? by - 24 : by - 16) - elev;
    this.reticle
      .setVisible(true)
      .setPosition(cx, cy)
      .setDisplaySize(size, size)
      .setTint(u.team === this.playerTeam ? 0x5d_ff_a0 : 0xff_3b_3b);
    const pulse = 1 + 0.06 * Math.sin(this.scene.time.now / 120);
    this.reticle.setScale(this.reticle.scaleX * pulse, this.reticle.scaleY * pulse);
  }

  private reticleTarget(world: World) {
    const u = this.reticleId ? world.units.get(this.reticleId) : undefined;

    if (!u || !u.alive) {
      return null satisfies { u: Unit; struct: boolean; v: UnitView | undefined } | null;
    }

    const struct = u.kind === "structure";

    if (struct) {
      return { struct, u, v: undefined } satisfies {
        u: Unit;
        struct: boolean;
        v: UnitView | undefined;
      } | null;
    }

    const v = this.units.get(u.id);

    if (!v || v.dead) {
      return null satisfies { u: Unit; struct: boolean; v: UnitView | undefined } | null;
    }

    return { struct, u, v } satisfies { u: Unit; struct: boolean; v: UnitView | undefined } | null;
  }

  private tickAmbientSplashes(dt: number) {
    if (this.focused) {
      return;
    }

    this.splashAcc += dt;

    if (this.splashAcc < 0.55) {
      return;
    }

    this.splashAcc = 0;
    const s = this.scene;

    if (this.shoreCells.length === 0 || !s.anims.exists("fx-splash")) {
      return;
    }

    const view = s.cameras.main.worldView;

    for (let tries = 0; tries < 10; tries += 1) {
      const c = this.shoreCells[Math.floor(Math.random() * this.shoreCells.length)];

      if (
        !c ||
        c.x < view.x - 100 ||
        c.x > view.right + 100 ||
        c.y < view.y - 100 ||
        c.y > view.bottom + 100
      ) {
        continue;
      }

      const sp = s.add
        .sprite(c.x + (Math.random() - 0.5) * 40, c.y + (Math.random() - 0.5) * 40, "fx-splash", 0)
        .setDepth(D_FOAM + 2)
        .setAlpha(0.9)
        .setScale(0.8 + Math.random() * 0.4);

      sp.play("fx-splash");
      sp.once("animationcomplete", () => {
        sp.destroy();
      });
      break;
    }
  }

  private syncStructures(world: World) {
    for (const [id, sv] of this.structs) {
      const u = world.units.get(id);

      if (!u) {
        continue;
      }

      if (!u.alive && !sv.dead) {
        sv.dead = true;
        sv.sprite.setTexture(structureDestroyedTex(u.structure?.tier ?? "t1")).setAlpha(0.92);
        sv.hpBg.setVisible(false);
        sv.hpFill.setVisible(false);

        for (const f of sv.fires) {
          f.destroy();
        }

        sv.fires = [];
        sv.range?.destroy();
        sv.range = null;
        continue;
      }

      if (u.alive) {
        const w = u.structure?.tier === "ancient" ? 120 : 64;
        sv.hpFill.width = Math.max(0, (u.hp / u.maxHp) * w);
        const attackable = u.structure?.attackable ?? true;
        sv.hpFill.setFillStyle(attackable ? teamHpColor(u.team) : 0x6a_74_88);
        this.syncStructureFires(u, sv);
        this.syncTowerRangeRing(world, u, sv);
      }
    }
  }

  private syncTowerRangeRing(world: World, u: Unit, sv: StructView) {
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
        .circle(u.x, u.y, range, 0xff_5a_4a, 0.04)
        .setStrokeStyle(2.5, 0xff_5a_4a, 0.4)
        .setDepth(D_RING + 1);
    } else if (!show && sv.range) {
      sv.range.destroy();
      sv.range = null;
    }
  }

  private syncStructureFires(u: Unit, sv: StructView) {
    const s = this.scene;
    const pct = u.hp / u.maxHp;
    let want = 0;

    if (pct < 0.33) {
      want = 2;
    } else if (pct < 0.66) {
      want = 1;
    }

    while (sv.fires.length > want) {
      sv.fires.pop()?.destroy();
    }

    if (sv.fires.length >= want) {
      return;
    }

    const big = u.structure?.tier === "ancient";

    const offsets: [number, number][] = big
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

      if (!s.anims.exists(key)) {
        return;
      }

      const f = s.add
        .sprite(u.x + ox, u.y + oy, key, 0)
        .setDepth(u.y + 3)
        .setScale(big ? 2.3 : 1.8);

      this.playLoop(f, key, i * 3);
      sv.fires.push(f);
    }
  }

  private admitSpellCues(world: World) {
    for (const fx of world.fx) {
      if (fx.t !== "cast") {
        continue;
      }

      const { actor } = fx;

      if (!actor || actor.at > world.now || world.now - actor.at > 450) {
        continue;
      }

      const unit = world.units.get(actor.unitId);

      if (unit?.alive !== true || !unit.hero || !fx.effect.startsWith(`${unit.hero.defId}:`)) {
        continue;
      }

      const view = this.units.get(unit.id) ?? this.createUnitView(unit);

      if (
        view.lastCast &&
        (actor.at < view.lastCast.at ||
          (actor.at === view.lastCast.at && fx.effect === view.lastCast.effect))
      ) {
        continue;
      }

      view.lastCast = { at: actor.at, effect: fx.effect };
      view.spellCue = { at: actor.at, effect: fx.effect, facing: unit.facing };
    }
  }

  private syncUnits(world: World, dt: number) {
    for (const u of world.units.values()) {
      if (u.kind === "structure") {
        continue;
      }

      if (!u.alive) {
        const v = this.units.get(u.id);

        if (v && !v.dead) {
          this.playUnitDeath(u, v);
        }

        continue;
      }

      let v = this.units.get(u.id);

      if (!v) {
        v = this.createUnitView(u);
      }

      if (v.dead) {
        this.reviveUnitView(u, v);
      }

      v.container.setVisible(true);
      v.plate.setVisible(true);
      v.ring.setVisible(true);
      this.smoothUnitBody(u, v, dt);
      const speed = Math.hypot(u.vx, u.vy);

      if (speed > 70 && !this.focused) {
        this.tickRunningDust(u, v);
      }

      const attackKey = animKey(u, "attack");
      this.syncAttackPose(world, u, v, speed, attackKey);
      this.syncSpellPose(world, u, v, attackKey);
      this.syncUnitBars(u, v);
      this.syncStatusFx(u, v);
    }

    for (const [id, v] of this.units) {
      if (!world.units.has(id)) {
        this.spawnDeathAnim(v);
        v.container.destroy();
        v.plate.destroy();
        this.units.delete(id);
      }
    }
  }

  private playUnitDeath(u: Unit, v: UnitView) {
    v.dead = true;
    v.attackCue = null;
    v.spellCue = null;
    v.plate.setVisible(false);
    v.ring.setVisible(false);

    for (const star of v.stunStars) {
      star.setVisible(false);
    }

    v.shieldFx?.setVisible(false);
    const dkey = animKey(u, "death");
    v.sprite.clearTint();
    this.spawnSkull(v.dx, v.dy, u.kind === "hero" ? 0.62 : 0.5);

    if (u.kind === "hero") {
      this.spawnHeroDeathFx(v.dx, v.dy);
    }

    if (this.scene.anims.exists(dkey)) {
      v.sprite.play(dkey);
      v.curAnim = dkey;
      v.sprite.once("animationcomplete", () => {
        this.collapseSprite(v.sprite, () => v.container.setVisible(false));
      });
    } else {
      this.collapseSprite(v.sprite, () => v.container.setVisible(false));
    }
  }

  private reviveUnitView(u: Unit, v: UnitView) {
    v.dead = false;
    v.dx = u.x;
    v.dy = u.y;
    v.curAnim = "";
    this.scene.tweens.killTweensOf(v.sprite);
    v.sprite.setAlpha(1).setAngle(0).setScale(v.baseScale);
    v.spellCue = null;
    v.lastCast = null;
    v.sprite.setPosition(0, -18);
    v.recoilX = 0;
    v.recoilY = 0;
  }

  private smoothUnitBody(u: Unit, v: UnitView, dt: number) {
    if (this.poseOf) {
      const at = this.poseOf(u.id);
      v.dx = at?.x ?? u.x;
      v.dy = at?.y ?? u.y;
    } else {
      const k = Math.min(1, dt * 18);
      v.dx = PhaserMath.Linear(v.dx, u.x, k);
      v.dy = PhaserMath.Linear(v.dy, u.y, k);
    }

    v.recoilX *= 0.0008 ** dt;
    v.recoilY *= 0.0008 ** dt;

    if (this.reducedMotion) {
      v.recoilX = 0;
      v.recoilY = 0;
    }

    if (Math.abs(v.recoilX) < 0.3) {
      v.recoilX = 0;
    }

    if (Math.abs(v.recoilY) < 0.3) {
      v.recoilY = 0;
    }

    const elev = elevationFrac(v.dx, v.dy) * LIFT;
    v.container.setPosition(Math.round(v.dx), Math.round(v.dy - elev));
    v.sprite
      .setPosition(v.recoilX, -18 + v.recoilY)
      .setAngle(0)
      .setScale(v.baseScale);
    v.plate.setPosition(Math.round(v.dx), Math.round(v.dy - elev));
    v.container.setDepth(v.dy - elev);

    if (v.flashUntil > 0 && this.scene.time.now >= v.flashUntil) {
      v.flashUntil = 0;
      v.sprite.clearTint();
    }
  }

  private tickRunningDust(u: Unit, v: UnitView) {
    const { now } = this.scene.time;

    if (now - v.lastDustAt > (u.kind === "hero" ? 240 : 340)) {
      v.lastDustAt = now;
      this.spawnDust(v.dx - u.facing * 12, v.dy + 6, u.kind === "hero" ? 0.85 : 0.6, u.facing < 0);
    }
  }

  private syncAttackPose(world: World, u: Unit, v: UnitView, speed: number, attackKey: string) {
    v.sprite.setFlipX(u.facing < 0);

    if (u.lastAttackAt !== v.lastAttackAt && u.pendingAttack) {
      v.lastAttackAt = u.lastAttackAt;
      v.attackCue = {
        facing: u.facing,
        resolveAt: u.pendingAttack.resolveAt,
        startedAt: u.lastAttackAt,
      };
    }

    const cue = v.attackCue;
    const cancelled = cue && !u.pendingAttack && (speed > 12 || world.now < cue.resolveAt);
    const attack = cue && cancelled !== true ? attackPose(cue, world.now) : null;

    if (!cue || !attack) {
      v.attackCue = null;
      this.playLocomotion(u, v, speed);

      return;
    }

    const clip = this.scene.anims.get(attackKey);
    const index = clip ? attackClipFrame(cue, world.now, attackKey, clip.frames.length) : null;
    const attackFrame = index === null ? undefined : clip?.frames[index];

    if (attackFrame) {
      v.sprite.anims.stop();
      v.sprite.setFrame(attackFrame.textureFrame);
      v.curAnim = attackKey;
    } else {
      this.playLocomotion(u, v, speed);

      if (!this.reducedMotion) {
        v.sprite.setAngle(attack.angle);
        v.sprite.x += attack.x;
      }
    }

    if (world.now >= cue.resolveAt && v.lastSwingAt !== cue.startedAt) {
      v.lastSwingAt = cue.startedAt;

      if (u.kind === "hero") {
        this.spawnSwing(v.dx, v.dy, cue.facing, u.projectileSpeed > 0, u.hero?.defId);
      }
    }
  }

  private playLocomotion(u: Unit, v: UnitView, speed: number) {
    const key = animKey(u, speed > 12 ? "walk" : "idle");

    if (v.curAnim !== key && this.scene.anims.exists(key)) {
      v.sprite.play(key, true);
      v.curAnim = key;
    }
  }

  private syncSpellPose(world: World, u: Unit, v: UnitView, attackKey: string) {
    const pose = spellPose(v.spellCue, u.hero?.channel ?? null, world.now, u.facing);

    if (!pose) {
      v.spellCue = null;

      return;
    }

    if (pose.frame !== null && !u.pendingAttack) {
      const clip = this.scene.anims.get(attackKey);
      const index = attackRecoveryFrame(pose.frame, attackKey, clip?.frames.length ?? 0);
      const frame = index === null ? undefined : clip?.frames[index];

      if (frame) {
        v.sprite.anims.stop();
        v.sprite.setFrame(frame.textureFrame);
        v.curAnim = "spell-release";
      }
    }

    if (!this.reducedMotion) {
      v.sprite.x += pose.x;
      v.sprite.y += pose.y;
      v.sprite.setAngle(pose.angle).setScale(v.baseScale * pose.scaleX, v.baseScale * pose.scaleY);
    }
  }

  private syncUnitBars(u: Unit, v: UnitView) {
    const bw = u.kind === "hero" ? 56 : 34;
    v.hpFill.width = Math.max(0, (u.hp / u.maxHp) * bw);
    v.hpFill.setFillStyle(u.neutral === true ? 0xe0_a9_3a : teamHpColor(u.team));

    if (v.mpFill) {
      v.mpFill.width = Math.max(0, (u.mp / Math.max(1, u.maxMp)) * bw);
    }

    const stunned = u.statuses.some((s) => s.kind === "stun" || s.kind === "taunt");
    v.ring.setAlpha(this.unitRingAlpha(u, v, stunned));
  }

  private unitRingAlpha(u: Unit, v: UnitView, stunned: boolean) {
    if (u.id === this.playerHeroId) {
      return 1;
    }

    if (stunned) {
      return 0.9;
    }

    if (v.attackCue) {
      return 0.8;
    }

    return u.kind === "hero" ? 0.5 : 0;
  }

  private syncHeroPlates(world: World) {
    if (!this.plateLeaders) {
      this.plateLeaders = this.scene.add.graphics().setDepth(DEPTH_UNIT_PLATE - 1);
    }

    this.plateLeaders.clear();
    const plates: HeroPlate[] = [];

    for (const [id, v] of this.units) {
      const u = world.units.get(id);

      if (u?.alive !== true || u.kind !== "hero" || !v.label) {
        continue;
      }

      if (!this.commonFx.visible(v.dx, v.dy, 100)) {
        continue;
      }

      plates.push({
        height: 36,
        id,
        priority: this.platePriority(id),
        width: Math.max(64, v.label.width),
        x: v.container.x,
        y: v.container.y - 87,
      });
    }

    for (const plate of layoutHeroPlates(plates)) {
      const v = this.units.get(plate.id);

      if (!v) {
        continue;
      }

      v.plate.y -= plate.lift;
      const local = plate.id === this.playerHeroId;
      v.hpBg.setStrokeStyle(local ? 2 : 1, local ? 0xff_e1_4a : 0x00_00_00, local ? 1 : 0.6);

      if (plate.lift <= 0) {
        continue;
      }

      this.plateLeaders.lineStyle(3, 0x10_15_22, 0.85);
      this.plateLeaders.lineBetween(plate.x, plate.y + 36, plate.x, v.container.y - 42);
      this.plateLeaders.lineStyle(1, local ? 0xff_e1_4a : 0xea_f0_ff, 0.85);
      this.plateLeaders.lineBetween(plate.x, plate.y + 36, plate.x, v.container.y - 42);
    }
  }

  /** Drop every unit sprite immediately, with no death animation. The showcase
   *  uses this when swapping subjects — a character swap isn't a death, so the
   *  default "unit vanished → death pop" path would litter the stage with skulls. */
  clearUnitViews() {
    this.commonFx.reset();
    this.trauma = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeRot = 0;

    for (const [, v] of this.units) {
      v.container.destroy();
      v.plate.destroy();
    }

    this.plateLeaders?.clear();
    this.units.clear();
  }

  /** Staging hook (trailer/director): restore structure views to match a freshly
   *  staged world. The normal game never revives a structure, so syncStructures
   *  only handles the alive→dead edge; a director that swaps in a new World needs
   *  the reverse (rubble back to the intact tower/castle art + bars). */
  resetStructures(world: World) {
    this.commonFx.reset();

    for (const [id, sv] of this.structs) {
      const u = world.units.get(id);

      if (!u || !u.alive || !sv.dead) {
        continue;
      }

      sv.dead = false;
      const tier = u.structure?.tier ?? "t1";

      const tex =
        tier === "ancient"
          ? `b-castle-${u.team === "radiant" ? "blue" : "red"}`
          : `b-tower-${u.team === "radiant" ? "blue" : "red"}`;

      sv.sprite.setTexture(tex).setAlpha(1);
      sv.hpBg.setVisible(true);
      sv.hpFill.setVisible(true);
    }
  }

  private spawnSwing(x: number, y: number, facing: number, ranged: boolean, hero?: string) {
    const tint = hitColor(hero, ranged);
    const rotation = facing < 0 ? Math.PI : 0;
    const priority = "common";

    if (ranged) {
      this.commonFx.image({
        alpha: 0.95,
        depth: y + 60,
        endScale: 0.2,
        endScaleY: 0.2,
        hold: 0.025,
        life: 0.14,
        priority,
        rotation,
        scale: 1.35,
        scaleY: 0.65,
        texture: "fx-star",
        tint,
        x: x + facing * 30,
        y: y - 22,
      });

      return;
    }

    this.commonFx.image({
      alpha: 0.95,
      depth: y + 60,
      endRotation: rotation + (this.reducedMotion ? -facing * 0.22 : facing * 0.28),
      endScale: this.reducedMotion ? 1.05 : 1.3,
      endScaleY: this.reducedMotion ? 0.85 : 1,
      hold: 0.035,
      life: 0.22,
      priority,
      rotation: rotation - facing * 0.22,
      scale: 1.05,
      scaleY: 0.85,
      texture: "fx-cleave",
      tint,
      x: x + facing * 14,
      y: y - 22,
    });

    if (!this.focused && !this.reducedMotion) {
      this.commonFx.image({
        alpha: 0.9,
        depth: y + 61,
        dx: facing * 12,
        endScale: 0.3,
        endScaleY: 0.2,
        life: 0.12,
        priority,
        rotation: rotation + facing * 0.7,
        scale: 1.7,
        scaleY: 0.8,
        texture: "streak",
        tint: 0xff_f6_dc,
        x: x + facing * 43,
        y: y - 24,
      });
    }
  }

  private spawnHitSparks(
    x: number,
    y: number,
    nx: number,
    ny: number,
    tint: number,
    crit?: boolean,
    important = false,
  ) {
    if (!this.commonFx.visible(x, y)) {
      return;
    }

    const baseAng = Math.atan2(ny, nx);
    const priority = important || crit === true ? "important" : "common";
    const sparks = this.hitBurstCount(crit, { crit: 7, focused: 2, normal: 4, reduced: 1 });

    for (let i = 0; i < sparks; i += 1) {
      const a = baseAng + (Math.random() - 0.5) * 1.5;
      const speed = this.reducedMotion ? 0 : (crit === true ? 90 : 60) + Math.random() * 70;
      this.commonFx.image({
        depth: y + 320,
        dx: Math.cos(a) * speed,
        dy: Math.sin(a) * speed + (this.reducedMotion ? 0 : 18),
        endScale: 0,
        life: (230 + Math.random() * 130) / 1000,
        priority,
        scale: 0.18 + Math.random() * 0.16,
        texture: "spark",
        tint,
        x,
        y,
      });
    }

    const puffs = this.hitBurstCount(crit, { crit: 4, focused: 1, normal: 2, reduced: 0 });

    for (let i = 0; i < puffs; i += 1) {
      const a = baseAng + (Math.random() - 0.5) * 1.1;
      const speed = (crit === true ? 130 : 95) + Math.random() * 90;
      this.commonFx.image({
        alpha: 0.9,
        depth: y + 321,
        dx: Math.cos(a) * speed,
        dy: Math.sin(a) * speed + 12,
        endScale: 0.15,
        endScaleY: 0.25,
        life: (180 + Math.random() * 110) / 1000,
        priority,
        rotation: a,
        scale: crit === true ? 1.5 : 1.05,
        scaleY: 0.7,
        texture: "streak",
        tint,
        x,
        y,
      });
    }
  }

  private stampScorch(x: number, y: number, radius: number) {
    if (!this.commonFx.visible(x, y, radius + 160)) {
      return;
    }

    const s = this.scene;

    if (!s.textures.exists("fx-scorch")) {
      return;
    }

    const mark = s.add
      .image(x, y, "fx-scorch")
      .setDepth(DEPTH_DECAL - 3)
      .setAlpha(0)
      .setAngle(Math.random() * 360)
      .setScale(PhaserMath.Clamp((radius / 96) * 1.4, 0.5, 2.6));

    s.tweens.add({ alpha: 0.7, duration: 120, targets: mark });
    s.tweens.add({
      alpha: 0,
      delay: 3500,
      duration: 3500,
      onComplete: () => {
        const i = this.scorches.indexOf(mark);

        if (i !== -1) {
          this.scorches.splice(i, 1);
        }

        mark.destroy();
      },
      targets: mark,
    });
    this.scorches.push(mark);

    while (this.scorches.length > 36) {
      this.scorches.shift()?.destroy();
    }
  }

  private spawnShockwave(x: number, y: number, tint: number, strength: number) {
    this.commonFx.image({
      alpha: 0.7 * strength,
      depth: y + 260,
      ease: "cubic",
      endScale: 1.3 + strength * 0.7,
      life: 0.34,
      priority: "important",
      scale: 0.25,
      texture: "fx-ring",
      tint,
      x,
      y,
    });
  }

  private spawnDust(x: number, y: number, scale: number, flip: boolean) {
    this.commonFx.sprite({ alpha: 0.75, depth: y - 2, flip, scale, sheet: "fx-dust1", x, y });
  }

  private spawnDeathAnim(v: UnitView) {
    if (v.dead) {
      return;
    }

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
          alpha: 0,
          duration: 260,
          onComplete: () => {
            corpse.destroy();
          },
          targets: corpse,
        });
      });
    } else {
      this.collapseSprite(corpse, () => {
        corpse.destroy();
      });
    }
  }

  private spawnHeroDeathFx(x: number, y: number) {
    const s = this.scene;
    this.stampScorch(x, y + 8, 58);

    const wisp = s.add
      .image(x, y - 8, "glow")
      .setTint(0xbf_e0_ff)
      .setAlpha(0.7)
      .setScale(0.5)
      .setDepth(y + 400)
      .setBlendMode(BlendModes.ADD);

    s.tweens.add({
      alpha: 0,
      duration: 900,
      ease: "Sine.Out",
      onComplete: () => {
        wisp.destroy();
      },
      scaleX: 0.2,
      scaleY: 0.95,
      targets: wisp,
      y: y - 72,
    });

    if (!s.textures.exists("fx-star")) {
      return;
    }

    for (let i = 0; i < 4; i += 1) {
      const st = s.add
        .image(x + (Math.random() - 0.5) * 24, y - 4, "fx-star")
        .setTint(0xcf_e6_ff)
        .setScale(0.22)
        .setAlpha(0.9)
        .setDepth(y + 401)
        .setBlendMode(BlendModes.ADD);

      s.tweens.add({
        alpha: 0,
        angle: 140,
        duration: 700 + Math.random() * 300,
        ease: "Sine.Out",
        onComplete: () => {
          st.destroy();
        },
        targets: st,
        x: st.x + (Math.random() - 0.5) * 30,
        y: y - 50 - Math.random() * 30,
      });
    }
  }

  private spawnSkull(x: number, y: number, scale: number) {
    const s = this.scene;

    if (!s.anims.exists("skull-pop")) {
      return;
    }

    const sk = s.add
      .sprite(x + (Math.random() - 0.5) * 10, y - 14, "skull-pop", 0)
      .setScale(scale)
      .setDepth(y + 1);

    sk.play("skull-pop");
    sk.once("animationcomplete", () => {
      sk.destroy();
    });
  }

  private collapseSprite(sprite: Phaser.GameObjects.Sprite, onDone?: () => void) {
    sprite.anims.stop();
    const dir = sprite.flipX ? -1 : 1;
    this.scene.tweens.add({
      alpha: 0,
      angle: dir * 78,
      duration: 520,
      ease: "Quad.easeIn",
      onComplete: () => onDone?.(),
      targets: sprite,
      y: sprite.y + 12,
    });
  }

  private platePriority(id: string) {
    if (id === this.playerHeroId) {
      return "player";
    }

    return id === this.reticleId ? "target" : "hero";
  }

  private hitBurstCount(crit: boolean | undefined, tiers: HitBurstTiers) {
    if (this.reducedMotion) {
      return tiers.reduced;
    }

    if (this.focused) {
      return tiers.focused;
    }

    return crit === true ? tiers.crit : tiers.normal;
  }

  private createUnitView(u: Unit) {
    const s = this.scene;
    const { tex, scale } = unitSprite(u);

    const shadow = s.add
      .image(0, 8, "shadow")
      .setDisplaySize(u.kind === "hero" ? 56 : 36, u.kind === "hero" ? 22 : 16)
      .setAlpha(0.5);

    const ring = s.add.graphics();
    const isPlayer = u.id === this.playerHeroId;
    const ringColor = unitRingColor(u);
    ring
      .lineStyle(isPlayer ? 4 : 2.5, isPlayer ? 0xff_e1_4a : ringColor, 1)
      .strokeEllipse(0, 10, u.kind === "hero" ? 56 : 38, u.kind === "hero" ? 26 : 18);
    const sprite = s.add.sprite(0, -18, tex, 0).setScale(scale);

    if (this.scene.anims.exists(animKey(u, "idle"))) {
      sprite.play(animKey(u, "idle"));
    }

    const barY = u.kind === "hero" ? -64 : -42;
    const bw = u.kind === "hero" ? 56 : 34;

    const hpBg = s.add
      .rectangle(0, barY, bw + 4, u.kind === "hero" ? 8 : 5, 0x0c_10_18)
      .setStrokeStyle(1, 0x00_00_00, 0.6);

    const hpFill = s.add
      .rectangle(-bw / 2, barY, bw, u.kind === "hero" ? 6 : 4, 0x44_d0_7a)
      .setOrigin(0, 0.5);

    let mpFill: Phaser.GameObjects.Rectangle | null = null;
    let label: Phaser.GameObjects.Text | null = null;
    const plateChildren: Phaser.GameObjects.GameObject[] = [hpBg, hpFill];

    if (u.kind === "hero" && u.hero) {
      const mpBg = s.add
        .rectangle(0, barY + 8, bw + 4, 5, 0x0c_10_18)
        .setStrokeStyle(1, 0x00_00_00, 0.6);

      mpFill = s.add.rectangle(-bw / 2, barY + 8, bw, 3, 0x4a_8f_ff).setOrigin(0, 0.5);
      label = s.add
        .text(0, barY - 12, "", {
          color: "#eaf0ff",
          fontFamily: FONT,
          fontSize: "13px",
          stroke: "#1c1410",
          strokeThickness: 3,
        })
        .setOrigin(0.5);
      plateChildren.push(mpBg, mpFill, label);
    }

    const container = s.add.container(u.x, u.y, [shadow, ring, sprite]).setDepth(u.y);
    const plate = s.add.container(u.x, u.y, plateChildren).setDepth(DEPTH_UNIT_PLATE);

    const v: UnitView = {
      attackCue: null,
      baseScale: scale,
      container,
      curAnim: "",
      dead: false,
      dx: u.x,
      dy: u.y,
      flashUntil: 0,
      hpBg,
      hpFill,
      label,
      lastAttackAt: 0,
      lastCast: null,
      lastDustAt: 0,
      lastSwingAt: 0,
      mpFill,
      plate,
      recoilX: 0,
      recoilY: 0,
      ring,
      shadow,
      shieldFx: null,
      spellCue: null,
      sprite,
      stunStars: [],
    };

    this.units.set(u.id, v);

    return v;
  }

  private syncStatusFx(u: Unit, v: UnitView) {
    this.syncStunStars(u, v);
    this.syncShieldFx(u, v);
  }

  private syncStunStars(u: Unit, v: UnitView) {
    const s = this.scene;
    const { now } = s.time;
    const headY = u.kind === "hero" ? -50 : -34;
    const stunned = u.statuses.some((st) => st.kind === "stun" || st.kind === "taunt");

    if (stunned && v.stunStars.length === 0 && s.textures.exists("fx-star")) {
      for (let i = 0; i < 3; i += 1) {
        const star = s.add
          .image(0, headY, "fx-star")
          .setScale(0.3)
          .setTint(0xff_e1_4a)
          .setBlendMode(BlendModes.ADD);

        v.container.add(star);
        v.stunStars.push(star);
      }
    } else if (!stunned && v.stunStars.length > 0) {
      for (const st of v.stunStars) {
        st.destroy();
      }

      v.stunStars = [];
    }

    const n = v.stunStars.length;

    for (let i = 0; i < n; i += 1) {
      const a = (this.reducedMotion ? 0 : now / 260) + (i / n) * Math.PI * 2;
      v.stunStars[i]?.setVisible(true).setPosition(Math.cos(a) * 15, headY + Math.sin(a) * 5);
    }
  }

  private syncShieldFx(u: Unit, v: UnitView) {
    const s = this.scene;
    const { now } = s.time;
    const shielded = u.statuses.some((st) => st.kind === "shield");

    if (shielded && !v.shieldFx) {
      v.shieldFx = s.add
        .circle(0, u.kind === "hero" ? -12 : -8, u.kind === "hero" ? 32 : 22, 0x6a_d0_ff, 0.06)
        .setStrokeStyle(2, 0x9f_e6_ff, 0.8);
      v.container.add(v.shieldFx);
    } else if (!shielded && v.shieldFx) {
      v.shieldFx.destroy();
      v.shieldFx = null;
    }

    if (v.shieldFx) {
      v.shieldFx.setVisible(true);
      v.shieldFx.setScale(this.reducedMotion ? 1 : 1 + 0.07 * Math.sin(now / 130));
      v.shieldFx.setStrokeStyle(
        2,
        0x9f_e6_ff,
        this.reducedMotion ? 0.8 : 0.55 + 0.3 * Math.sin(now / 150),
      );
    }
  }

  /** Update hero name/level labels (called less often by HUD/Game). */
  refreshLabels(world: World) {
    for (const [id, v] of this.units) {
      const u = world.units.get(id);

      if (!u || u.kind !== "hero" || !u.hero || !v.label) {
        continue;
      }

      v.label.setText(`${shortName(u.hero.defId)} ${u.hero.level}`);
    }
  }

  private syncProjectiles(world: World) {
    for (const p of world.projectiles.values()) {
      let img = this.projs.get(p.id);

      if (!img) {
        if (p.kind === "fireball" && this.scene.anims.exists("sp-fireball-fly")) {
          const fb = this.scene.add.sprite(p.x, p.y, "sp-fireball", 6).setScale(0.8);
          fb.play("sp-fireball-fly");
          img = fb;
        } else if (p.kind === "dynamite") {
          img = this.scene.add.image(p.x, p.y, "bomb").setScale(0.6);
        } else {
          img = this.scene.add.image(p.x, p.y, projTex(p), 0).setScale(0.7);

          if (p.kind === "bolt") {
            img.setTint(0xb9_8b_ff);
          }
        }

        this.projs.set(p.id, img);
      }

      const at = this.poseOf?.(p.id) ?? p;
      img.setPosition(at.x, at.y);
      img.setDepth(at.y + 200);
      const ang = Math.atan2(p.ty - at.y, p.tx - at.x);

      if (p.kind === "arrow" || p.kind === "bolt" || p.kind === "fireball" || p.kind === "tower") {
        img.setRotation(ang);
      } else {
        img.setRotation(0);
      }

      this.tickProjTrail(p, at);
    }

    for (const [id, img] of this.projs) {
      if (!world.projectiles.has(id)) {
        img.destroy();
        this.projs.delete(id);
        this.projTrailAt.delete(id);
      }
    }
  }

  private tickProjTrail(p: Projectile, at: Vec2) {
    if (this.reducedMotion) {
      return;
    }

    const { now } = this.scene.time;

    if (now - (this.projTrailAt.get(p.id) ?? 0) < (this.focused ? 70 : 22)) {
      return;
    }

    const view = this.scene.cameras.main.worldView;

    if (
      at.x < view.x - 80 ||
      at.x > view.right + 80 ||
      at.y < view.y - 80 ||
      at.y > view.bottom + 80
    ) {
      return;
    }

    this.projTrailAt.set(p.id, now);
    const hot = p.kind === "fireball";
    const col = projTrailColor(p);
    this.commonFx.image({
      alpha: hot ? 0.75 : 0.5,
      depth: at.y + 199,
      endScale: 0,
      endScaleY: 0.1,
      life: hot ? 0.24 : 0.14,
      rotation: Math.atan2(p.ty - at.y, p.tx - at.x),
      scale: hot ? 0.65 : 1.05,
      scaleY: hot ? 0.35 : 0.55,
      texture: hot || p.kind === "dynamite" ? "spark" : "streak",
      tint: col,
      x: at.x,
      y: at.y,
    });
  }

  private syncGrounds(world: World, dt: number) {
    const s = this.scene;
    const seen = new Set<string>();

    for (const g of world.groundEffects) {
      seen.add(g.id);

      const kind = groundFxKind(
        g.effect,
        g.allyHealPerTick !== undefined && g.allyHealPerTick !== 0,
      );

      let gv = this.grounds.get(g.id);

      if (!gv) {
        const col = groundColor(g);

        const arc = s.add
          .circle(g.x, g.y, g.radius, col, kind === "storm" ? 0.1 : 0.2)
          .setStrokeStyle(2.5, col, 0.7)
          .setDepth(DEPTH_GROUND_ZONE);

        const sprites: GroundView["sprites"] = [];

        if (kind === "fire" || kind === "heal") {
          const sheet = kind === "fire" ? "sp-fire" : "sp-water";

          if (s.anims.exists(`${sheet}-loop`)) {
            const ring = PhaserMath.Clamp(Math.round(g.radius / 80), 0, 6);
            const spots: [number, number, number][] = [[0, 0, (g.radius * 1.1) / 128]];

            for (let i = 0; i < ring; i += 1) {
              const a = (i / ring) * Math.PI * 2;
              const rr = g.radius * 0.6;
              spots.push([Math.cos(a) * rr, Math.sin(a) * rr, (g.radius * 0.7) / 128]);
            }

            for (const [ox, oy, sc] of spots) {
              const sp = s.add
                .sprite(g.x + ox, g.y + oy, sheet, 0)
                .setScale(sc)
                .setAlpha(0.85)
                .setDepth(DEPTH_GROUND_ZONE + 1);

              if (kind === "heal") {
                sp.setTint(0x9b_f0_b0).setBlendMode(BlendModes.ADD);
              }

              this.playLoop(sp, `${sheet}-loop`, Math.floor(Math.random() * 6));
              sprites.push({ ox, oy, sp });
            }
          }
        }

        gv = { arc, nextStrikeAt: 0, sprites };
        this.grounds.set(g.id, gv);
      }

      const at = this.groundAt(g);
      gv.arc.setPosition(at.x, at.y);

      for (const { sp, ox, oy } of gv.sprites) {
        sp.setPosition(at.x + ox, at.y + oy);
      }

      if (kind === "storm" && s.anims.exists("sp-lightning")) {
        gv.nextStrikeAt -= dt * 1000;

        if (gv.nextStrikeAt <= 0) {
          gv.nextStrikeAt = 200 + Math.random() * 160;
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * g.radius;
          const bx = at.x + Math.cos(a) * rr;
          const by = at.y + Math.sin(a) * rr;

          const bolt = s.add
            .sprite(bx, by, "sp-lightning", 0)
            .setDepth(by + 500)
            .setScale((g.radius / 320) * 1.1)
            .setOrigin(0.5, 0.9)
            .setBlendMode(BlendModes.ADD);

          bolt.play("sp-lightning");
          bolt.once("animationcomplete", () => {
            bolt.destroy();
          });
        }
      }
    }

    for (const [id, gv] of this.grounds) {
      if (!seen.has(id)) {
        gv.arc.destroy();

        for (const { sp } of gv.sprites) {
          sp.destroy();
        }

        this.grounds.delete(id);
      }
    }
  }

  private groundAt(g: GroundEffect) {
    return (g.followOwner === true ? this.poseOf?.(g.ownerId) : undefined) ?? g;
  }

  private syncMines(world: World) {
    for (const m of world.mines.values()) {
      let img = this.mines.get(m.id);

      if (!img) {
        img = this.scene.add
          .circle(m.x, m.y, 8, 0xff_4d_4d, 0.85)
          .setDepth(m.y)
          .setStrokeStyle(2, 0x66_11_11);
        this.mines.set(m.id, img);
      }
    }

    for (const [id, img] of this.mines) {
      if (!world.mines.has(id)) {
        img.destroy();
        this.mines.delete(id);
      }
    }
  }

  private drainFx(world: World) {
    for (const fx of world.fx) {
      this.playFx(fx);
    }

    world.fx.length = 0;
  }

  private playFx(fx: FxEvent) {
    switch (fx.t) {
      case "hit": {
        this.playHitFx(fx);
        break;
      }

      case "explosion": {
        this.playExplosionFx(fx);
        break;
      }

      case "blink": {
        this.playBlinkFx(fx);
        break;
      }

      case "levelup": {
        this.playLevelupFx(fx);
        break;
      }

      case "gold": {
        this.playGoldFx(fx);
        break;
      }

      case "heal": {
        this.playHealFx(fx);
        break;
      }

      case "structureDown": {
        this.playStructureDownFx(fx);
        break;
      }

      case "death": {
        this.playDeathFx(fx);
        break;
      }

      case "cast": {
        this.playCastFx(fx);
        break;
      }

      case "ability": {
        this.playAbilityFx(fx);
        break;
      }

      default: {
        break;
      }
    }
  }

  private playHitFx(fx: Extract<FxEvent, { t: "hit" }>) {
    const localVictim = fx.targetId === this.playerHeroId;
    sfx.hit({ gain: localVictim ? 1 : this.soundGainAt(fx.x, fx.y), important: localVictim });
    const magic = fx.dtype === "magic";
    const tintCol = hitColor(fx.attackerHero, magic);

    const important =
      fx.targetId === this.playerHeroId ||
      fx.targetId === this.reticleId ||
      fx.crit === true ||
      (fx.isAttack !== true && fx.amount >= 60);

    const priority = important ? "important" : "common";
    const bigHit = fx.isAttack === true || fx.crit === true || fx.amount >= 30;
    this.spawnHitImpact(fx, magic, tintCol, priority, bigHit);
    this.applyHitToVictim(fx, magic, bigHit);

    if (bigHit) {
      this.spawnHitSparks(fx.x, fx.y, fx.nx, fx.ny, tintCol, fx.crit, important);
    }

    if (fx.crit === true || fx.amount >= 55) {
      this.spawnShockwave(fx.x, fx.y, tintCol, fx.crit === true ? 1 : 0.8);
    }

    if (fx.targetId === this.playerHeroId && fx.amount >= 25) {
      this.addTrauma(Math.min(0.5, 0.14 + fx.amount / 400));
    } else if (fx.crit === true || fx.amount >= 60) {
      this.traumaAt(fx.x, fx.y, 0.2);
    }

    this.commonFx.label({
      color: damageLabelColor(magic, fx.crit),
      crit: fx.crit,
      depth: 90_000,
      group: fx.targetId,
      life: fx.crit === true ? 0.82 : 0.7,
      priority,
      rise: fx.crit === true ? 52 : 38,
      size: fx.crit === true ? 24 : 15,
      text: `${fx.amount}`,
      x: fx.x,
      y: fx.y,
    });
  }

  private spawnHitImpact(
    fx: Extract<FxEvent, { t: "hit" }>,
    magic: boolean,
    tintCol: number,
    priority: "important" | "common",
    bigHit: boolean,
  ) {
    this.commonFx.image({
      alpha: 0.85,
      depth: fx.y + 300,
      endScale: 0.15,
      endScaleY: 0.1,
      hold: fx.crit === true ? 0.045 : 0.025,
      life: fx.crit === true ? 0.26 : 0.17,
      priority,
      rotation: Math.atan2(fx.ny, fx.nx) + 0.55,
      scale: fx.crit === true ? 1.8 : 1.05,
      scaleY: magic ? 1.3 : 0.65,
      texture: "fx-star",
      tint: tintCol,
      x: fx.x,
      y: fx.y,
    });

    if (bigHit) {
      this.commonFx.image({
        alpha: 0.95,
        depth: fx.y + 301,
        endScale: 0,
        endScaleY: 0.1,
        hold: 0.02,
        life: fx.crit === true ? 0.15 : 0.095,
        priority,
        rotation: Math.atan2(fx.ny, fx.nx) - 0.55,
        scale: fx.crit === true ? 2.7 : 1.7,
        scaleY: fx.crit === true ? 1.1 : 0.65,
        texture: "streak",
        x: fx.x,
        y: fx.y,
      });
    }
  }

  private applyHitToVictim(fx: Extract<FxEvent, { t: "hit" }>, magic: boolean, bigHit: boolean) {
    const vv = this.units.get(fx.targetId);

    if (!vv || vv.dead) {
      return;
    }

    vv.sprite.setTint(magic ? 0xd9_a6_ff : 0xff_8a_8a);
    vv.flashUntil = this.scene.time.now + (fx.crit === true ? 130 : 90);

    if (bigHit && !this.reducedMotion) {
      const kick =
        Math.min(fx.isAttack === true ? 16 : 9, 4 + fx.amount * 0.12) *
        (fx.crit === true ? 1.6 : 1);

      vv.recoilX += fx.nx * kick;
      vv.recoilY += fx.ny * kick;
      const recoil = Math.hypot(vv.recoilX, vv.recoilY);

      if (recoil > 18) {
        vv.recoilX *= 18 / recoil;
        vv.recoilY *= 18 / recoil;
      }
    }
  }

  private playExplosionFx(fx: Extract<FxEvent, { t: "explosion" }>) {
    const s = this.scene;
    sfx.explosion({ gain: this.soundGainAt(fx.x, fx.y) });
    this.stampScorch(fx.x, fx.y, fx.radius);
    this.traumaAt(fx.x, fx.y, PhaserMath.Clamp(0.12 + fx.radius / 500, 0.12, 0.5));
    this.commonFx.image({
      alpha: 0.85,
      depth: fx.y + 402,
      endScale: (fx.radius / 128) * 1.5,
      life: 0.15,
      priority: "important",
      radius: fx.radius + 160,
      scale: (fx.radius / 128) * 0.6,
      texture: "glow",
      tint: 0xff_f2_d6,
      x: fx.x,
      y: fx.y - 6,
    });
    const conflagration = abilityCastFx("emberhex:R");

    if (fx.color === 0xff_5a_1a && conflagration) {
      this.spawnSpellSprite(fx.x, fx.y, conflagration);
    }

    const key = fx.radius >= 130 && s.anims.exists("fx-explode2") ? "fx-explode2" : "fx-explode1";

    if (s.anims.exists(key)) {
      this.commonFx.sprite({
        depth: fx.y + 400,
        priority: "important",
        radius: fx.radius + 160,
        scale: PhaserMath.Clamp(fx.radius / 85, 0.8, 2.4),
        sheet: key,
        x: fx.x,
        y: fx.y - 10,
      });
    } else {
      this.commonFx.sprite({
        additive: true,
        anim: "fx-explode",
        depth: fx.y + 400,
        priority: "important",
        radius: fx.radius + 160,
        scale: (fx.radius / 96) * 1.2,
        sheet: "fx-explosion",
        tint: fx.color,
        x: fx.x,
        y: fx.y,
      });
    }
  }

  private playBlinkFx(fx: Extract<FxEvent, { t: "blink" }>) {
    const s = this.scene;

    for (const [x, y] of [
      [fx.x, fx.y],
      [fx.x2, fx.y2],
    ] as const) {
      const c = s.add.circle(x, y, 24, 0x9b_6b_ff, 0.6).setDepth(y + 100);
      s.tweens.add({
        alpha: 0,
        duration: 300,
        onComplete: () => {
          c.destroy();
        },
        scale: 0,
        targets: c,
      });
    }
  }

  private playLevelupFx(fx: Extract<FxEvent, { t: "levelup" }>) {
    const s = this.scene;
    const v = this.units.get(fx.unitId);
    const isMe = fx.unitId === this.playerHeroId;

    if (isMe) {
      sfx.level();
    }

    if (!this.commonFx.visible(fx.x, fx.y)) {
      return;
    }

    const x = v ? v.dx : fx.x;
    const y = v ? v.dy : fx.y;

    const ring = s.add
      .circle(x, y + 10, 20, 0xff_e1_4a, 0)
      .setStrokeStyle(4, 0xff_e1_4a, 1)
      .setDepth(y + 50);

    s.tweens.add({
      alpha: 0,
      duration: 600,
      onComplete: () => {
        ring.destroy();
      },
      scale: 3,
      targets: ring,
    });

    const glow = s.add
      .image(x, y - 14, "glow")
      .setTint(0xff_e8_9a)
      .setAlpha(0.7)
      .setScale(0.4)
      .setDepth(y + 51)
      .setBlendMode(BlendModes.ADD);

    s.tweens.add({
      alpha: 0,
      duration: 520,
      ease: "Quad.Out",
      onComplete: () => {
        glow.destroy();
      },
      scaleX: 0.9,
      scaleY: 2.2,
      targets: glow,
    });

    if (s.textures.exists("fx-star")) {
      const count = isMe ? 8 : 5;

      for (let i = 0; i < count; i += 1) {
        const sx = x + (Math.random() - 0.5) * 44;

        const star = s.add
          .image(sx, y + 6, "fx-star")
          .setTint(0xff_f0_a8)
          .setDepth(y + 60)
          .setScale(0.3 + Math.random() * 0.25)
          .setAlpha(0.95)
          .setBlendMode(BlendModes.ADD);

        s.tweens.add({
          alpha: 0,
          angle: 180,
          delay: i * 32,
          duration: 620 + Math.random() * 260,
          ease: "Sine.Out",
          onComplete: () => {
            star.destroy();
          },
          targets: star,
          y: y - 40 - Math.random() * 42,
        });
      }
    }
  }

  private playGoldFx(fx: Extract<FxEvent, { t: "gold" }>) {
    if (fx.heroId !== this.playerHeroId) {
      return;
    }

    sfx.gold();
    this.commonFx.label({
      color: "#ffd23a",
      depth: 90_000,
      life: 0.8,
      priority: "important",
      rise: 30,
      size: 14,
      text: `+${fx.amount}`,
      x: fx.x,
      y: fx.y,
    });
  }

  private playHealFx(fx: Extract<FxEvent, { t: "heal" }>) {
    this.commonFx.label({
      color: "#7bf08b",
      depth: 90_000,
      life: 0.7,
      rise: 30,
      size: 14,
      text: `+${Math.round(fx.amount)}`,
      x: fx.x,
      y: fx.y - 20,
    });
  }

  private playStructureDownFx(fx: Extract<FxEvent, { t: "structureDown" }>) {
    const s = this.scene;
    sfx.structureDown();
    this.traumaAt(fx.x, fx.y, 0.85);
    this.stampScorch(fx.x, fx.y, 150);
    this.spawnShockwave(fx.x, fx.y, 0xff_d9_a0, 1.4);

    const bursts: [number, number, number, number][] = [
      [0, -50, 1.7, 0],
      [-42, -20, 1.1, 120],
      [46, -34, 1.2, 210],
      [8, -84, 1, 340],
    ];

    for (const [ox, oy, sc, delay] of bursts) {
      const key = s.anims.exists("fx-explode2") ? "fx-explode2" : "fx-explode1";

      if (!s.anims.exists(key)) {
        break;
      }

      this.commonFx.sprite({
        delay: delay / 1000,
        depth: fx.y + 500,
        priority: "important",
        radius: 300,
        scale: sc,
        sheet: key,
        x: fx.x + ox,
        y: fx.y + oy,
      });
    }
  }

  private playDeathFx(fx: Extract<FxEvent, { t: "death" }>) {
    const s = this.scene;

    if (fx.kind === "hero") {
      const localVictim = fx.unitId === this.playerHeroId;
      sfx.death({
        gain: localVictim ? 1 : this.soundGainAt(fx.x, fx.y),
        important: localVictim,
      });
    }

    if (fx.kind === "creep") {
      if (s.anims.exists("fx-dust2")) {
        this.commonFx.sprite({
          alpha: 0.9,
          depth: fx.y + 10,
          scale: 1.1,
          sheet: "fx-dust2",
          x: fx.x,
          y: fx.y - 8,
        });
      } else {
        this.commonFx.image({
          depth: fx.y + 10,
          endScale: 0,
          life: 0.32,
          scale: 1.5,
          texture: "spark",
          tint: 0xdd_dd_dd,
          x: fx.x,
          y: fx.y - 10,
        });
      }
    }
  }

  private playCastFx(fx: Extract<FxEvent, { t: "cast" }>) {
    const { actor } = fx;
    const local = actor?.unitId === this.playerHeroId;

    const gain = local
      ? 1
      : this.soundGainAt(fx.x, fx.y) * (fx.team === this.playerTeam ? 0.6 : 0.45);

    sfx.ability(fx.effect, gain, local);
    const col = effectColor(fx.effect);
    this.commonFx.image({
      alpha: 0.9,
      depth: fx.y,
      endScale: 6.8 / 28,
      life: 0.28,
      priority: "important",
      scale: 34 / 28,
      texture: "fx-ring",
      tint: col,
      x: fx.x,
      y: fx.y + 6,
    });
    const spec = abilityCastFx(fx.effect);

    if (spec && spec.at === "caster") {
      this.spawnSpellSprite(fx.x, fx.y, spec);
    }
  }

  private spawnSpellSprite(x: number, y: number, spec: SpellCastFx, rotation = 0, delay = 0) {
    const ox = (spec.offsetX ?? 0) * spec.scale;
    const oy = (spec.offsetY ?? 0) * spec.scale;
    this.commonFx.sprite({
      additive: spec.additive,
      delay,
      depth: y + 360,
      priority: "important",
      radius: 160 + spec.scale * 128,
      rotation,
      scale: spec.scale,
      sheet: spec.sheet,
      startFrame: spec.startFrame,
      tint: spec.tint,
      x: x + Math.cos(rotation) * ox,
      y: y + oy + Math.sin(rotation) * ox,
    });
  }

  private playAbilityFx(fx: Extract<FxEvent, { t: "ability" }>) {
    if (fx.effect === "emberhex:R") {
      return;
    }

    const col = effectColor(fx.effect);
    const spec = abilityCastFx(fx.effect);

    if (fx.effect === "stormcaller:Q") {
      this.spawnBeam(fx.x, fx.y - 16, fx.x2, fx.y2 - 16, 0x8f_d0_ff, spec);

      return;
    }

    if (spec?.at === "target") {
      this.spawnSpellSprite(fx.x2, fx.y2, spec);
    } else if (spec?.at === "aimed") {
      this.spawnSpellSprite(fx.x, fx.y - 12, spec, Math.atan2(fx.y2 - fx.y, fx.x2 - fx.x));
    }

    if (fx.radius >= 90 && fx.effect !== "duskblade:W") {
      this.spawnSoftImpact(fx.x2, fx.y2, fx.radius, col);
      this.traumaAt(fx.x2, fx.y2, PhaserMath.Clamp(fx.radius / 900, 0.08, 0.4));

      if (fx.radius >= 150) {
        this.spawnShockwave(fx.x2, fx.y2, col, 1);
      }
    }
  }

  private spawnBeam(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    col: number,
    arrow: SpellCastFx | null,
  ) {
    const len = Math.hypot(x2 - x1, y2 - y1);

    if (len < 1) {
      return;
    }

    const rotation = Math.atan2(y2 - y1, x2 - x1);
    const x = (x1 + x2) / 2;
    const y = (y1 + y2) / 2;
    const depth = Math.max(y1, y2) + 320;
    this.commonFx.image({
      alpha: 0.85,
      depth,
      endScale: len / 128,
      endScaleY: 0.08,
      hold: 0.04,
      life: 0.24,
      priority: "important",
      radius: len / 2 + 80,
      rotation,
      scale: len / 128,
      scaleY: 0.45,
      texture: "glow",
      tint: col,
      x,
      y,
    });
    this.commonFx.image({
      alpha: 0.95,
      depth: depth + 1,
      endScale: len / 24,
      endScaleY: 0.15,
      hold: 0.035,
      life: 0.16,
      priority: "important",
      radius: len / 2 + 80,
      rotation,
      scale: len / 24,
      scaleY: 0.8,
      texture: "streak",
      tint: 0xea_f6_ff,
      x,
      y,
    });

    if (arrow) {
      const stops = this.focused || this.reducedMotion ? [0.5] : [0.2, 0.5, 0.8];

      for (const [i, t] of stops.entries()) {
        this.spawnSpellSprite(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, arrow, rotation, i * 0.045);
      }
    }
  }

  private spawnSoftImpact(x: number, y: number, r: number, col: number) {
    const scale = (r * 2) / 128;
    this.commonFx.image({
      alpha: 0.4,
      depth: y + 200,
      endScale: scale,
      hold: 0.035,
      life: 0.3,
      priority: "important",
      radius: r + 160,
      scale: this.reducedMotion ? scale : scale * 0.7,
      texture: "glow",
      tint: col,
      x,
      y,
    });
    const ring = r / 28;
    this.commonFx.image({
      alpha: 0.5,
      depth: y + 201,
      endScale: ring,
      life: 0.32,
      priority: "important",
      radius: r + 160,
      scale: this.reducedMotion ? ring : ring * 0.72,
      texture: "fx-ring",
      tint: col,
      x,
      y,
    });
  }
}
