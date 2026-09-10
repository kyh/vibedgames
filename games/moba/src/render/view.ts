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
// minus a per-strip index (northern strips on top), stays above the shadow
const D_BRIDGE = -84;
const DEPTH_DECAL = -50;
const DEPTH_GROUND_ZONE = -40;
const DEPTH_UNIT_PLATE = 91_000;

// Terrain autotile tables (flat/elevated grass), cliff + slope frames live in
// ./autotile — the single source shared with the ?gallery=map gallery.
// Bridge_All frames: 0/1/2 = horizontal left-cap/middle/right-cap, 11 = shadow.
const BRIDGE_L = 0;
const BRIDGE_M = 1;
const BRIDGE_R = 2;
const BRIDGE_SHADOW = 11;

const bridgeFrame = (cx: number, x0: number, x1: number): number => {
  if (cx === x0) {
    return BRIDGE_L;
  }
  if (cx === x1) {
    return BRIDGE_R;
  }
  return BRIDGE_M;
};

const cliffTopFrame = (leftEnd: boolean, rightEnd: boolean): number => {
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

const slopeFrame = (left: boolean, topRow: boolean): number => {
  if (topRow) {
    return left ? SLOPE_FRAMES.leftTop : SLOPE_FRAMES.rightTop;
  }
  return left ? SLOPE_FRAMES.leftBot : SLOPE_FRAMES.rightBot;
};

const reticleSize = (u: Unit, struct: boolean): number => {
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

const projTrailColor = (p: Projectile): number => {
  if (p.kind === "fireball") {
    return 0xff_9a_3a;
  }
  if (p.kind === "bolt") {
    return 0xb9_8b_ff;
  }
  if (p.kind === "dynamite") {
    return 0xff_ae_4a;
  }
  // arrows/tower: a faint white streak
  return 0xdf_e8_ff;
};

const damageLabelColor = (magic: boolean, crit: boolean | undefined): string => {
  if (magic) {
    return "#c78bff";
  }
  return crit ? "#ffd23a" : "#ffffff";
};

const unitRingColor = (u: Unit): number => {
  if (u.neutral) {
    return 0xd0_a2_3a;
  }
  return u.team === "radiant" ? 0x4f_a3_ff : 0xff_5a_4a;
};

const structureScale = (tier: string): number => {
  if (tier === "ancient") {
    return 1.7;
  }
  if (tier === "base") {
    return 1.15;
  }
  return 1.35;
};

/** Deterministic 0..1 hash so decoration scatter is stable across reloads/peers. */
const rng2 = (x: number, y: number): number => {
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
  // throttle the running dust puffs
  lastDustAt: number;
  // playing/played the death anim while hidden (heroes)
  dead: boolean;
  // hit knockback offset (decays each frame)
  recoilX: number;
  recoilY: number;
  // ms; sprite shows a red damage flash until then
  flashUntil: number;
  // orbiting stars while stunned/taunted
  stunStars: Phaser.GameObjects.Image[];
  // shimmer ring while shielded
  shieldFx: Phaser.GameObjects.Arc | null;
}

/** A live ground zone's display: the coloured ring + any looping effect sprites
 *  (each kept with its offset from the zone centre so followOwner zones can track). */
interface GroundView {
  arc: Phaser.GameObjects.Arc;
  sprites: { sp: Phaser.GameObjects.Sprite; ox: number; oy: number }[];
  // for storm zones: when to drop the next lightning bolt
  nextStrikeAt: number;
}

interface StructView {
  sprite: Phaser.GameObjects.Image;
  hpBg: Phaser.GameObjects.Rectangle;
  hpFill: Phaser.GameObjects.Rectangle;
  range: Phaser.GameObjects.Arc | null;
  // burning-damage flames, count scales with lost HP
  fires: Phaser.GameObjects.Sprite[];
  dead: boolean;
}

const teamHpColor = (team: string): number => (team === "radiant" ? 0x44_d0_7a : 0xff_5d_5d);
const projTex = (p: Projectile): string => {
  if (p.kind === "fireball") {
    return "glow";
  }
  if (p.kind === "dynamite") {
    return "spark";
  }
  return "fx-arrow";
};
const groundColor = (g: GroundEffect): number => {
  if (g.allyHealPerTick) {
    return 0x6b_e0_7a;
  }
  if (g.effect.includes("storm")) {
    return 0x6a_a8_ff;
  }
  return 0xff_6a_2a;
};
const shortName = (defId: string): string => {
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
  private scene: Phaser.Scene;
  private readonly commonFx: CommonFx;
  private units = new Map<string, UnitView>();
  private structs = new Map<string, StructView>();
  private projs = new Map<string, Phaser.GameObjects.Image | Phaser.GameObjects.Sprite>();
  // throttle per-projectile trail puffs
  private projTrailAt = new Map<string, number>();
  private grounds = new Map<string, GroundView>();
  private mines = new Map<string, Phaser.GameObjects.Arc>();
  // water cells touching land, for ambient splashes
  private shoreCells: { x: number; y: number }[] = [];
  private splashAcc = 0;
  // lingering blast marks (capped)
  private scorches: Phaser.GameObjects.Image[] = [];
  // target marker (Cursor_04)
  private reticle: Phaser.GameObjects.Image | null = null;
  // unit the player is currently targeting/hovering
  private reticleId = "";
  // where the local hero's next point cast goes (unit vector); null hides it
  private aimDir: Vec2 | null = null;
  private aimChevron: Phaser.GameObjects.Image | null = null;
  private plateLeaders: Phaser.GameObjects.Graphics | null = null;
  private reducedMotion = false;
  private focused = false;
  private clouds: Phaser.GameObjects.Image[] = [];
  playerHeroId = "";
  playerTeam: "radiant" | "dire" = "radiant";

  // Trauma-based screen shake (Eiserloh): fx add trauma, offset = maxOffset·trauma²,
  // decaying to 0. One accumulator so many hits don't fight; GameScene reads the
  // computed offset/rotation each frame and applies it to the camera it owns.
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
    // A restarted scene builds a fresh WorldView; the old one must stop listening.
    scene.events.once(Scenes.Events.SHUTDOWN, () => {
      motion.removeEventListener("change", syncMotion);
      stopSettings();
    });
  }

  /** Start a looping anim at a deterministic offset, CLAMPED to its real frame
   *  count. A sheet can load with fewer frames than authored when its source PNG
   *  exceeds the GPU's max texture size (e.g. a wide strip on a weaker/mobile GPU),
   *  and a hardcoded `startFrame % N` would then index past the end and crash
   *  Phaser's getFirstTick (`undefined.duration`). No-ops if the anim is missing. */
  private playLoop(sprite: Phaser.GameObjects.Sprite, key: string, startSeed = 0): void {
    const anim = this.scene.anims.get(key);
    const n = anim?.frames.length ?? 0;
    if (n <= 0) {
      return;
    }
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
      const col = team === "radiant" ? 0x4f_a3_ff : 0xff_5a_4a;
      s.add.circle(b.fountain.x, b.fountain.y, b.fountainRadius, col, 0.05).setDepth(D_RING);
      // carved pool: stone lip, teal water, bright centre, slow pulsing ring
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
      // splash sparkle: the pool joins the ambient splash pool
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

    // 7b) Roshan pit dressing: a trampled dark patch ringed with bones and rocks
    this.buildRoshanPit();

    // 7c) gold mines behind the large jungle camps (flavour landmarks)
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

    // 8) jungle trees (depth-sorted so heroes weave between them)
    this.buildTrees();

    // 9) scattered rocks / animated bushes / mushrooms for texture
    this.buildScatter();

    // 10) subtle marker rings at each neutral camp so the jungle reads as farmable
    for (const c of NEUTRAL_CAMPS) {
      const boss = c.kind === "roshan";
      s.add
        .circle(c.x, c.y, boss ? 130 : 70, 0x00_00_00, 0)
        .setStrokeStyle(boss ? 4 : 3, boss ? 0x8a_3a_2a : 0x4a_6a_34, boss ? 0.4 : 0.3)
        .setDepth(D_RING);
    }

    // 11) animated rocks dotting the water, drifting clouds, grazing sheep
    this.buildWaterRocks();
    this.buildClouds();
    this.buildAmbientLife();
    // 12) drifting light motes — soft filmic dust catching the light
    this.buildLightMotes();
  }

  /** A sparse field of slow-drifting, softly twinkling light motes over the map —
   *  pure atmosphere. Kept few + faint so they read as bokeh, not gameplay. */
  private buildLightMotes(): void {
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

  /** The Roshan pit: dark trampled ground + a deterministic ring of bones/rocks. */
  private buildRoshanPit(): void {
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

  /** The original foam has a filled centre: place it UNDER each boundary land
   *  cell so the grass hides that centre and only the ripple reaches the water.
   *  Water-cell candidates remain separate for the occasional ambient splash. */
  private buildFoam(): void {
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

  /** Flat (elevated=false) or plateau-top (true) grass autotile as one layer.
   *  `yOff` lifts the layer up (elevated grass) so plateaus read as raised. */
  private buildGroundLayer(elevated: boolean, depth: number, yOff = 0): void {
    const s = this.scene;
    if (!s.textures.exists("tiles-img")) {
      return;
    }
    const inSet = (cx: number, cy: number): boolean =>
      elevated ? isHighCell(cx, cy) : isLandCell(cx, cy) && !isHighCell(cx, cy);
    const out = (cx: number, cy: number): boolean =>
      elevated ? !isHighCell(cx, cy) : !isLandCell(cx, cy);
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

  /** Drop shadow under the elevated footprint, shifted one tile down
   *  (layered between the flat and elevated ground layers). */
  private buildPlateauShadows(): void {
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

  /** Stone cliff face along each plateau's south edge: a one-tile wall hanging
   *  from the LIFTED grass lip down to the ground, so the plateau reads as a raised
   *  block. Skipped where a ramp descends (the ramp grass shows there instead). */
  private buildCliffs(): void {
    const s = this.scene;
    if (!s.textures.exists("tiles")) {
      return;
    }
    for (let cy = 0; cy < ROWS; cy += 1) {
      for (let cx = 0; cx < COLS; cx += 1) {
        // south edge only
        if (!isHighCell(cx, cy) || isHighCell(cx, cy + 1)) {
          continue;
        }
        // a ramp descends here — leave it open
        if (isRampCell(cx, cy + 1)) {
          continue;
        }
        const cxp = cx * CELL + CELL / 2;
        // a run ends where the neighbour isn't a south-edge wall (incl. ramp gaps)
        const leftEnd =
          !isHighCell(cx - 1, cy) || isHighCell(cx - 1, cy + 1) || isRampCell(cx - 1, cy + 1);
        const rightEnd =
          !isHighCell(cx + 1, cy) || isHighCell(cx + 1, cy + 1) || isRampCell(cx + 1, cy + 1);
        const tile = cliffTopFrame(leftEnd, rightEnd);
        const wallTopY = (cy + 1) * CELL - LIFT;
        s.add.ellipse(cxp, wallTopY + CELL + 2, CELL + 10, 16, 0x05_08_0e, 0.3).setDepth(D_SHADOW);
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
    if (!s.textures.exists("tiles-img") || !s.textures.exists("tiles")) {
      return;
    }
    // grass interior, to back-fill the slope
    const FILL = FLAT_AUTOTILE.get(0) ?? 10;
    for (let cy = 0; cy < ROWS; cy += 1) {
      for (let cx = 0; cx < COLS; cx += 1) {
        const r = rampAt(cx, cy);
        if (!r) {
          continue;
        }
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
        const tile = slopeFrame(left, cy === r.y0);
        s.add
          .image(cxp, cy * CELL - lift, "tiles", tile)
          .setOrigin(0.5, 0)
          .setDepth(D_CLIFF + 2);
      }
    }
  }

  /** Multiply wash over the land, nudging the tileset green toward olive. */
  private buildWash(): void {
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

  /** Wooden plank bridges with the kit's flat shadow square on the water beneath.
   *  Each strip of the art is one tile tall with posts along its top edge, so a
   *  wide crossing is built from overlapping strips every half tile, northern
   *  strips drawn on top — continuous planking, posts only on the outer rail. */
  private buildBridges(): void {
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

  private buildTrees(): void {
    const s = this.scene;
    const deciduous = [1, 2, 3, 4].filter((i) => s.textures.exists(`ftree${i}`));
    const hasPine = s.textures.exists("t-tree");
    const AUTUMN = [0xf4_d2_4a, 0xe9_a2_3a, 0xf2_c1_4e, 0xe6_b3_4a];

    const plant = (tx: number, ty: number, seed: number): void => {
      const cx = Math.floor(tx / CELL);
      const cy = Math.floor(ty / CELL);
      if (!isLandCell(cx, cy) || isCliffCell(cx, cy)) {
        return;
      }
      // keep walkable high ground + ramps clear so they read (and aren't cluttered)
      if (isWalkableHighCell(cx, cy) || isRampCell(cx, cy)) {
        return;
      }
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

    // clusters in the jungle pockets
    for (const t of TREE_CLUSTERS) {
      const n = Math.max(6, Math.floor(t.r / 24));
      for (let i = 0; i < n; i += 1) {
        const a = (i / n) * Math.PI * 2 + (t.x % 7);
        const rr = t.r * (0.2 + 0.75 * rng2(t.x + i, t.y - i));
        plant(t.x + Math.cos(a) * rr, t.y + Math.sin(a) * rr, i);
      }
    }
    // sparse pines on the plateau tops so the heights read as wooded — but not
    // on the castle outcrops, where they'd poke through the keep
    for (let cy = 0; cy < ROWS; cy += 1) {
      for (let cx = 0; cx < COLS; cx += 1) {
        // pines only on blocked deco rises, never on walkable plateaus
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
            // pines here are on the plateau top
            .sprite(tx, ty - LIFT, "t-tree", 0)
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
    // every ~3 cells, maybe drop a decal
    const step = 3;
    for (let cy = 2; cy < ROWS - 2; cy += step) {
      for (let cx = 2; cx < COLS - 2; cx += step) {
        const r = rng2(cx, cy);
        if (r > 0.42) {
          continue;
        }
        // wide jitter so decals scatter naturally instead of in rows
        const x = cx * CELL + CELL / 2 + (rng2(cx + 9, cy) - 0.5) * step * CELL * 0.9;
        const y = cy * CELL + CELL / 2 + (rng2(cx, cy + 9) - 0.5) * step * CELL * 0.9;
        const ccx = Math.floor(x / CELL);
        const ccy = Math.floor(y / CELL);
        if (!isLandCell(ccx, ccy) || isCliffCell(ccx, ccy) || isRampCell(ccx, ccy)) {
          continue;
        }
        // keep decals out of the base/fountain footprints
        const near = (fx: number, fy: number) => (x - fx) ** 2 + (y - fy) ** 2 < 420 * 420;
        if (near(BASES.radiant.fountain.x, BASES.radiant.fountain.y)) {
          continue;
        }
        if (near(BASES.dire.fountain.x, BASES.dire.fountain.y)) {
          continue;
        }
        // decals on a plateau sit on its raised surface
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
          // bushes are animated sway strips — one 128px frame each, never the sheet
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

  /** Animated rocks scattered through the open water for detail. */
  private buildWaterRocks(): void {
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
        // sparse
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

  /** Soft clouds drifting slowly across the map (depth above everything). */
  private buildClouds(): void {
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
        // above units, below HUD
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

  /** Ambient grazing sheep on the grass — pure cosmetic life, wanders gently. */
  private buildAmbientLife(): void {
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
      // gentle wander
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
  buildStructures(): void {
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
  setTarget(id: string): void {
    this.reticleId = id;
  }

  /** Per-frame sync of all dynamic objects to the world. */
  sync(world: World, dt: number): void {
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
  addTrauma(amount: number): void {
    if (this.reducedMotion) {
      return;
    }
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Add trauma scaled by how close a world point is to the camera centre, so a
   *  distant explosion barely nudges the view while a hit in your face rattles it. */
  private traumaAt(x: number, y: number, base: number): void {
    const v = this.scene.cameras.main.worldView;
    const d = Math.hypot(x - (v.x + v.width / 2), y - (v.y + v.height / 2));
    const falloff = Math.max(0, 1 - d / 1000);
    if (falloff > 0) {
      this.addTrauma(base * falloff);
    }
  }

  /** Cosmetic attenuation follows the viewed battle, never simulation state. */
  private soundGainAt(x: number, y: number): number {
    const v = this.scene.cameras.main.worldView;
    const distance = Math.hypot(x - v.centerX, y - v.centerY);
    return Math.max(0, 1 - Math.max(0, distance - 180) / 1200);
  }

  /** Decay trauma and recompute the camera offset/rotation (offset ∝ trauma², from
   *  smooth per-axis oscillation). GameScene applies shakeX/Y/Rot after its follow. */
  private tickShake(dt: number): void {
    if (this.trauma <= 0) {
      this.shakeX = 0;
      this.shakeY = 0;
      this.shakeRot = 0;
      return;
    }
    // ~0.6s to fully settle
    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    const s = this.trauma * this.trauma;
    const t = this.scene.time.now;
    this.shakeX = Math.sin(t * 0.055) * 15 * s;
    this.shakeY = Math.cos(t * 0.063 + 1.3) * 15 * s;
    // ≤ ~1.3°, keeps pixels calm
    this.shakeRot = Math.sin(t * 0.048 + 0.7) * 0.022 * s;
  }

  /** The local hero's resolved cast aim, shown as a chevron on the ground ring. */
  setAim(dir: Vec2 | null): void {
    this.aimDir = dir;
  }

  private syncAimChevron(): void {
    const v = this.aimDir ? this.units.get(this.playerHeroId) : undefined;
    if (!v || v.dead || !this.aimDir) {
      this.aimChevron?.setVisible(false);
      return;
    }
    if (!this.aimChevron) {
      this.aimChevron = this.scene.add.image(0, 0, "fx-chevron").setTint(0xff_e1_4a).setAlpha(0.9);
    }
    const { x, y } = this.aimDir;
    // sits on the ring ellipse (56×26 around the feet, +10 down) so it reads as
    // part of the selection mark, and sorts just under the body
    this.aimChevron
      .setVisible(true)
      .setPosition(v.container.x + x * 34, v.container.y + 10 + y * 16)
      .setRotation(Math.atan2(y, x))
      .setDepth(v.container.depth - 0.5);
  }

  /** Position the target reticle over the currently-targeted unit (4 corner
   *  brackets that frame the body), or hide it when there's no valid target. */
  private syncReticle(world: World): void {
    const target = this.reticleTarget(world);
    if (!target) {
      if (this.reticle) {
        this.reticle.setVisible(false);
      }
      return;
    }
    const { u, struct, v } = target;
    if (!this.reticle) {
      // crisp opaque corner-brackets (NORMAL blend) so the marker reads clearly
      // over the busy map; tinted per relationship.
      this.reticle = this.scene.add.image(0, 0, "cursor-target").setDepth(89_000);
    }
    const size = reticleSize(u, struct);
    const bx = struct ? u.x : (v?.dx ?? u.x);
    const by = struct ? u.y : (v?.dy ?? u.y);
    // ride the lifted sprite on high ground
    const elev = elevationFrac(bx, by) * LIFT;
    const cx = bx;
    const cy = (struct ? by - 24 : by - 16) - elev;
    this.reticle
      .setVisible(true)
      .setPosition(cx, cy)
      .setDisplaySize(size, size)
      .setTint(u.team === this.playerTeam ? 0x5d_ff_a0 : 0xff_3b_3b);
    // gentle breathing so it reads as "locked on"
    const pulse = 1 + 0.06 * Math.sin(this.scene.time.now / 120);
    this.reticle.setScale(this.reticle.scaleX * pulse, this.reticle.scaleY * pulse);
  }

  /** The reticle's live target: an alive, visible unit, or a standing structure
   *  (structures live in `structs`, not the unit-view map, so they resolve directly). */
  private reticleTarget(
    world: World,
  ): { u: Unit; struct: boolean; v: UnitView | undefined } | null {
    const u = this.reticleId ? world.units.get(this.reticleId) : undefined;
    if (!u || !u.alive) {
      return null;
    }
    const struct = u.kind === "structure";
    if (struct) {
      return { struct, u, v: undefined };
    }
    const v = this.units.get(u.id);
    if (!v || v.dead) {
      return null;
    }
    return { struct, u, v };
  }

  /** Occasional water splashes along shorelines near the camera, for living water. */
  private tickAmbientSplashes(dt: number): void {
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
      sp.once("animationcomplete", () => sp.destroy());
      break;
    }
  }

  private syncStructures(world: World): void {
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
        // the attack-range warning ring lives only while alive — drop it, or a
        // tower killed while you stand in range leaves an orphaned circle forever.
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
        .circle(u.x, u.y, range, 0xff_5a_4a, 0.04)
        .setStrokeStyle(2.5, 0xff_5a_4a, 0.4)
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

  private admitSpellCues(world: World): void {
    for (const fx of world.fx) {
      if (fx.t !== "cast") {
        continue;
      }
      const { actor } = fx;
      if (!actor || actor.at > world.now || world.now - actor.at > 450) {
        continue;
      }
      const unit = world.units.get(actor.unitId);
      if (!unit?.alive || !unit.hero || !fx.effect.startsWith(`${unit.hero.defId}:`)) {
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

  private syncUnits(world: World, dt: number): void {
    for (const u of world.units.values()) {
      if (u.kind === "structure") {
        continue;
      }
      // dead heroes: play the death anim once, then hide until respawn
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
      // running dust puffs at the feet (throttled per unit)
      const speed = Math.hypot(u.vx, u.vy);
      if (speed > 70 && !this.focused) {
        this.tickRunningDust(u, v);
      }
      const attackKey = animKey(u, "attack");
      this.syncAttackPose(world, u, v, speed, attackKey);
      this.syncSpellPose(world, u, v, attackKey);
      // no sprite tint at all — units show their true art; hit feedback is the
      // impact puff + floating damage number, so nothing pulses while moving.
      this.syncUnitBars(u, v);
      // persistent status auras (orbiting stun stars, shield shimmer)
      this.syncStatusFx(u, v);
    }
    // remove views for units gone from the world (creeps die + get reaped) —
    // play a one-shot death anim from the sprite's last texture as it leaves.
    for (const [id, v] of this.units) {
      if (!world.units.has(id)) {
        this.spawnDeathAnim(v);
        v.container.destroy();
        v.plate.destroy();
        this.units.delete(id);
      }
    }
  }

  private playUnitDeath(u: Unit, v: UnitView): void {
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
      v.sprite.once("animationcomplete", () =>
        this.collapseSprite(v.sprite, () => v.container.setVisible(false)),
      );
    } else {
      // no death sheet — procedural collapse (topple + sink + fade)
      this.collapseSprite(v.sprite, () => v.container.setVisible(false));
    }
  }

  /** Respawned — snap back so we don't slide from the death spot to base, and
   *  undo the collapse transform (alpha/angle/local-y) the death applied. */
  private reviveUnitView(u: Unit, v: UnitView): void {
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

  /** Smooth display position toward sim position — snappy enough to track the
   *  30Hz sim without floating, smooth enough to hide the step — then place the
   *  body, plate and depth from it. */
  private smoothUnitBody(u: Unit, v: UnitView, dt: number): void {
    const k = Math.min(1, dt * 18);
    v.dx = PhaserMath.Linear(v.dx, u.x, k);
    v.dy = PhaserMath.Linear(v.dy, u.y, k);
    // hit recoil: a quick knockback offset on the sprite that springs back —
    // purely visual (the sim position is untouched, so nav/MP stay authoritative).
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
    // elevation lift: raise the sprite when on a plateau / climbing a ramp so it
    // stands on the high ground (sim x/y is untouched — depth still sorts by feet)
    const elev = elevationFrac(v.dx, v.dy) * LIFT;
    v.container.setPosition(Math.round(v.dx), Math.round(v.dy - elev));
    // Only the body recoils. Ground rings and health stay on the actual feet.
    v.sprite
      .setPosition(v.recoilX, -18 + v.recoilY)
      .setAngle(0)
      .setScale(v.baseScale);
    v.plate.setPosition(Math.round(v.dx), Math.round(v.dy - elev));
    // sort by the lifted "screen feet" so plateau units order correctly against
    // the lifted plateau trees/decor (which use depth = y - LIFT)
    v.container.setDepth(v.dy - elev);

    // damage flash: a brief red tint on the body when struck (cleared on expiry)
    if (v.flashUntil > 0 && this.scene.time.now >= v.flashUntil) {
      v.flashUntil = 0;
      v.sprite.clearTint();
    }
  }

  private tickRunningDust(u: Unit, v: UnitView): void {
    const { now } = this.scene.time;
    if (now - v.lastDustAt > (u.kind === "hero" ? 240 : 340)) {
      v.lastDustAt = now;
      this.spawnDust(v.dx - u.facing * 12, v.dy + 6, u.kind === "hero" ? 0.85 : 0.6, u.facing < 0);
    }
  }

  /** Body frames follow the accepted wind-up, contact and recovery. A late
   *  snapshot samples its present age instead of replaying anticipation. */
  private syncAttackPose(
    world: World,
    u: Unit,
    v: UnitView,
    speed: number,
    attackKey: string,
  ): void {
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
    const attack = cue && !cancelled ? attackPose(cue, world.now) : null;
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

  private playLocomotion(u: Unit, v: UnitView, speed: number): void {
    const key = animKey(u, speed > 12 ? "walk" : "idle");
    if (v.curAnim !== key && this.scene.anims.exists(key)) {
      v.sprite.play(key, true);
      v.curAnim = key;
    }
  }

  private syncSpellPose(world: World, u: Unit, v: UnitView, attackKey: string): void {
    const pose = spellPose(v.spellCue, u.hero?.channel ?? null, world.now, u.facing);
    if (!pose) {
      v.spellCue = null;
      return;
    }
    // An actual pending basic attack keeps ownership of its existing clip.
    // Otherwise sample only the release/recovery part of the original art.
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

  private syncUnitBars(u: Unit, v: UnitView): void {
    const bw = u.kind === "hero" ? 56 : 34;
    v.hpFill.width = Math.max(0, (u.hp / u.maxHp) * bw);
    v.hpFill.setFillStyle(u.neutral ? 0xe0_a9_3a : teamHpColor(u.team));
    if (v.mpFill) {
      v.mpFill.width = Math.max(0, (u.mp / Math.max(1, u.maxMp)) * bw);
    }
    // status tints: stun = yellow ring flash handled via ring alpha
    const stunned = u.statuses.some((s) => s.kind === "stun" || s.kind === "taunt");
    v.ring.setAlpha(this.unitRingAlpha(u, v, stunned));
  }

  private unitRingAlpha(u: Unit, v: UnitView, stunned: boolean): number {
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

  /** Health/name plates sit above combat decoration, with a leader only when a
   * crowd displaces a hero's label. Their original art and team colors remain. */
  private syncHeroPlates(world: World): void {
    if (!this.plateLeaders) {
      this.plateLeaders = this.scene.add.graphics().setDepth(DEPTH_UNIT_PLATE - 1);
    }
    this.plateLeaders.clear();
    const plates: HeroPlate[] = [];
    for (const [id, v] of this.units) {
      const u = world.units.get(id);
      if (!u?.alive || u.kind !== "hero" || !v.label) {
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
      // A dark under-stroke stays readable over both pale spells and grass.
      this.plateLeaders.lineStyle(3, 0x10_15_22, 0.85);
      this.plateLeaders.lineBetween(plate.x, plate.y + 36, plate.x, v.container.y - 42);
      this.plateLeaders.lineStyle(1, local ? 0xff_e1_4a : 0xea_f0_ff, 0.85);
      this.plateLeaders.lineBetween(plate.x, plate.y + 36, plate.x, v.container.y - 42);
    }
  }

  /** Drop every unit sprite immediately, with no death animation. The showcase
   *  uses this when swapping subjects — a character swap isn't a death, so the
   *  default "unit vanished → death pop" path would litter the stage with skulls. */
  clearUnitViews(): void {
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
  resetStructures(world: World): void {
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

  /** Hero attack flourish: a sweeping slash arc for melee, a muzzle spark for
   *  ranged — drawn in the facing direction so swings read as deliberate hits. */
  private spawnSwing(x: number, y: number, facing: number, ranged: boolean, hero?: string): void {
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

  /** A short burst of sparks spraying away from the attacker on a hit — the
   *  "damage particles" that give every strike a sense of impact. */
  private spawnHitSparks(
    x: number,
    y: number,
    nx: number,
    ny: number,
    tint: number,
    crit?: boolean,
    important = false,
  ): void {
    if (!this.commonFx.visible(x, y)) {
      return;
    }
    const baseAng = Math.atan2(ny, nx);
    const priority = important || crit ? "important" : "common";
    const sparks = this.hitBurstCount(crit, { crit: 7, focused: 2, normal: 4, reduced: 1 });
    for (let i = 0; i < sparks; i += 1) {
      const a = baseAng + (Math.random() - 0.5) * 1.5;
      const speed = this.reducedMotion ? 0 : (crit ? 90 : 60) + Math.random() * 70;
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
      const speed = (crit ? 130 : 95) + Math.random() * 90;
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
        scale: crit ? 1.5 : 1.05,
        scaleY: 0.7,
        texture: "streak",
        tint,
        x,
        y,
      });
    }
  }

  /** Stamp a lingering scorch mark where a blast/AoE landed (permanence — the field
   *  remembers the fight). Capped + slowly faded so marks don't pile up forever. */
  private stampScorch(x: number, y: number, radius: number): void {
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
    // hard cap: retire the oldest immediately if we're flooding (busy teamfights)
    while (this.scorches.length > 36) {
      this.scorches.shift()?.destroy();
    }
  }

  /** An expanding shockwave ring — reserved for crits / big nukes (not every hit). */
  private spawnShockwave(x: number, y: number, tint: number, strength: number): void {
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

  /** A little kicked-up dust puff at the feet of a running unit. */
  private spawnDust(x: number, y: number, scale: number, flip: boolean): void {
    this.commonFx.sprite({ alpha: 0.75, depth: y - 2, flip, scale, sheet: "fx-dust1", x, y });
  }

  /** One-shot death at a unit's last position (for reaped creeps): play the real
   *  death sheet if the unit has one (barrel goblin's explosion), else collapse —
   *  plus the bouncing-skull pop either way. */
  private spawnDeathAnim(v: UnitView): void {
    // a hero already played its death in-place
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
          onComplete: () => corpse.destroy(),
          targets: corpse,
        });
      });
    } else {
      this.collapseSprite(corpse, () => corpse.destroy());
    }
  }

  /** Hero death flourish: a scorch where they fell + a rising soul wisp and a few
   *  drifting sparkle motes — a death reads as a moment, not just a vanish. */
  private spawnHeroDeathFx(x: number, y: number): void {
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
      onComplete: () => wisp.destroy(),
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
        onComplete: () => st.destroy(),
        targets: st,
        x: st.x + (Math.random() - 0.5) * 30,
        y: y - 50 - Math.random() * 30,
      });
    }
  }

  /** The pack's death skull: pops out, bounces, sinks into the ground. */
  private spawnSkull(x: number, y: number, scale: number): void {
    const s = this.scene;
    if (!s.anims.exists("skull-pop")) {
      return;
    }
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
      alpha: 0,
      angle: dir * 78,
      duration: 520,
      ease: "Quad.easeIn",
      onComplete: () => onDone?.(),
      targets: sprite,
      y: sprite.y + 12,
    });
  }

  private platePriority(id: string): HeroPlate["priority"] {
    if (id === this.playerHeroId) {
      return "player";
    }
    return id === this.reticleId ? "target" : "hero";
  }

  /** How many burst particles a hit spawns at each tier of effort. */
  private hitBurstCount(crit: boolean | undefined, tiers: HitBurstTiers): number {
    if (this.reducedMotion) {
      return tiers.reduced;
    }
    if (this.focused) {
      return tiers.focused;
    }
    return crit ? tiers.crit : tiers.normal;
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

  /** Persistent status auras that read the sim's statuses: orbiting stars while
   *  disabled (stun/taunt), a cyan shimmer ring while shielded. Created/destroyed
   *  as the status comes and goes; both ride the unit container so they follow it. */
  private syncStatusFx(u: Unit, v: UnitView): void {
    this.syncStunStars(u, v);
    this.syncShieldFx(u, v);
  }

  private syncStunStars(u: Unit, v: UnitView): void {
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

  private syncShieldFx(u: Unit, v: UnitView): void {
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
  refreshLabels(world: World): void {
    for (const [id, v] of this.units) {
      const u = world.units.get(id);
      if (!u || u.kind !== "hero" || !u.hero || !v.label) {
        continue;
      }
      v.label.setText(`${shortName(u.hero.defId)} ${u.hero.level}`);
    }
  }

  private syncProjectiles(world: World): void {
    for (const p of world.projectiles.values()) {
      let img = this.projs.get(p.id);
      if (!img) {
        if (p.kind === "fireball" && this.scene.anims.exists("sp-fireball-fly")) {
          // formed flying fireball (steady-size frames, no grow/explode); faces travel
          const fb = this.scene.add.sprite(p.x, p.y, "sp-fireball", 6).setScale(0.8);
          fb.play("sp-fireball-fly");
          img = fb;
        } else if (p.kind === "dynamite") {
          img = this.scene.add.image(p.x, p.y, "bomb").setScale(0.6);
        } else {
          // arrow/bolt/tower share the arrow sheet — frame 0 is the full arrow
          img = this.scene.add.image(p.x, p.y, projTex(p), 0).setScale(0.7);
          // magic bolts read distinct from arrows
          if (p.kind === "bolt") {
            img.setTint(0xb9_8b_ff);
          }
        }
        // position + depth set every frame just below
        this.projs.set(p.id, img);
      }
      img.setPosition(p.x, p.y);
      img.setDepth(p.y + 200);
      const ang = Math.atan2(p.ty - p.y, p.tx - p.x);
      // arrow/bolt/tower art and the fireball both point EAST (+x) natively → face travel
      if (p.kind === "arrow" || p.kind === "bolt" || p.kind === "fireball" || p.kind === "tower") {
        img.setRotation(ang);
        // dynamite stays upright so its lit fuse reads
      } else {
        img.setRotation(0);
      }
      this.tickProjTrail(p);
    }
    for (const [id, img] of this.projs) {
      if (!world.projectiles.has(id)) {
        img.destroy();
        this.projs.delete(id);
        this.projTrailAt.delete(id);
      }
    }
  }

  /** A fading additive puff dropped behind a projectile as it flies — each starts
   *  brightest and dims as the projectile pulls away, reading as speed. Throttled
   *  per projectile so the trail is a ribbon of a few puffs, not a solid smear. */
  private tickProjTrail(p: Projectile): void {
    if (this.reducedMotion) {
      return;
    }
    const { now } = this.scene.time;
    if (now - (this.projTrailAt.get(p.id) ?? 0) < (this.focused ? 70 : 22)) {
      return;
    }
    // no point trailing a projectile the camera can't see — a fight on the far side
    // of the map would otherwise spawn puffs nobody renders (kill invisible work).
    const view = this.scene.cameras.main.worldView;
    if (p.x < view.x - 80 || p.x > view.right + 80 || p.y < view.y - 80 || p.y > view.bottom + 80) {
      return;
    }
    this.projTrailAt.set(p.id, now);
    const hot = p.kind === "fireball";
    const col = projTrailColor(p);
    this.commonFx.image({
      alpha: hot ? 0.75 : 0.5,
      depth: p.y + 199,
      endScale: 0,
      endScaleY: 0.1,
      life: hot ? 0.24 : 0.14,
      rotation: Math.atan2(p.ty - p.y, p.tx - p.x),
      scale: hot ? 0.65 : 1.05,
      scaleY: hot ? 0.35 : 0.55,
      texture: hot || p.kind === "dynamite" ? "spark" : "streak",
      tint: col,
      x: p.x,
      y: p.y,
    });
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
          .setDepth(DEPTH_GROUND_ZONE);
        const sprites: GroundView["sprites"] = [];
        // fire / heal zones tile a few looping effect sprites across the radius
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
      gv.arc.setPosition(g.x, g.y);
      // followOwner zones (flashfire) move with the caster — keep sprites attached
      for (const { sp, ox, oy } of gv.sprites) {
        sp.setPosition(g.x + ox, g.y + oy);
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
            .setBlendMode(BlendModes.ADD);
          bolt.play("sp-lightning");
          bolt.once("animationcomplete", () => bolt.destroy());
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

  private syncMines(world: World): void {
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

  private drainFx(world: World): void {
    for (const fx of world.fx) {
      this.playFx(fx);
    }
    world.fx.length = 0;
  }

  private playFx(fx: FxEvent): void {
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

  private playHitFx(fx: Extract<FxEvent, { t: "hit" }>): void {
    const localVictim = fx.targetId === this.playerHeroId;
    sfx.hit({ gain: localVictim ? 1 : this.soundGainAt(fx.x, fx.y), important: localVictim });
    const magic = fx.dtype === "magic";
    const tintCol = hitColor(fx.attackerHero, magic);
    const important =
      fx.targetId === this.playerHeroId ||
      fx.targetId === this.reticleId ||
      fx.crit === true ||
      (!fx.isAttack && fx.amount >= 60);
    const priority = important ? "important" : "common";
    const bigHit = fx.isAttack === true || fx.crit === true || fx.amount >= 30;
    this.spawnHitImpact(fx, magic, tintCol, priority, bigHit);
    // Culling is confined to decoration. Victim tint/recoil and local damage
    // response still happen even when its impact is outside the camera.
    this.applyHitToVictim(fx, magic, bigHit);
    if (bigHit) {
      this.spawnHitSparks(fx.x, fx.y, fx.nx, fx.ny, tintCol, fx.crit, important);
    }
    if (fx.crit || fx.amount >= 55) {
      this.spawnShockwave(fx.x, fx.y, tintCol, fx.crit ? 1 : 0.8);
    }
    if (fx.targetId === this.playerHeroId && fx.amount >= 25) {
      this.addTrauma(Math.min(0.5, 0.14 + fx.amount / 400));
    } else if (fx.crit || fx.amount >= 60) {
      this.traumaAt(fx.x, fx.y, 0.2);
    }
    this.commonFx.label({
      color: damageLabelColor(magic, fx.crit),
      crit: fx.crit,
      depth: 90_000,
      group: fx.targetId,
      life: fx.crit ? 0.82 : 0.7,
      priority,
      rise: fx.crit ? 52 : 38,
      size: fx.crit ? 24 : 15,
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
  ): void {
    this.commonFx.image({
      alpha: 0.85,
      depth: fx.y + 300,
      endScale: 0.15,
      endScaleY: 0.1,
      hold: fx.crit ? 0.045 : 0.025,
      life: fx.crit ? 0.26 : 0.17,
      priority,
      rotation: Math.atan2(fx.ny, fx.nx) + 0.55,
      scale: fx.crit ? 1.8 : 1.05,
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
        life: fx.crit ? 0.15 : 0.095,
        priority,
        rotation: Math.atan2(fx.ny, fx.nx) - 0.55,
        scale: fx.crit ? 2.7 : 1.7,
        scaleY: fx.crit ? 1.1 : 0.65,
        texture: "streak",
        x: fx.x,
        y: fx.y,
      });
    }
  }

  private applyHitToVictim(
    fx: Extract<FxEvent, { t: "hit" }>,
    magic: boolean,
    bigHit: boolean,
  ): void {
    const vv = this.units.get(fx.targetId);
    if (!vv || vv.dead) {
      return;
    }
    vv.sprite.setTint(magic ? 0xd9_a6_ff : 0xff_8a_8a);
    vv.flashUntil = this.scene.time.now + (fx.crit ? 130 : 90);
    if (bigHit && !this.reducedMotion) {
      const kick = Math.min(fx.isAttack ? 16 : 9, 4 + fx.amount * 0.12) * (fx.crit ? 1.6 : 1);
      vv.recoilX += fx.nx * kick;
      vv.recoilY += fx.ny * kick;
      const recoil = Math.hypot(vv.recoilX, vv.recoilY);
      if (recoil > 18) {
        vv.recoilX *= 18 / recoil;
        vv.recoilY *= 18 / recoil;
      }
    }
  }

  private playExplosionFx(fx: Extract<FxEvent, { t: "explosion" }>): void {
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
    // Conflagration's fuse emits an ability cue; only this real detonation
    // draws the rune igniting into its pillar.
    const conflagration = abilityCastFx("emberhex:R");
    if (fx.color === 0xff_5a_1a && conflagration) {
      this.spawnSpellSprite(fx.x, fx.y, conflagration);
    }
    // Authored explosion sheets retain their own palette and frame timing.
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

  private playBlinkFx(fx: Extract<FxEvent, { t: "blink" }>): void {
    const s = this.scene;
    for (const [x, y] of [
      [fx.x, fx.y],
      [fx.x2, fx.y2],
    ] as const) {
      const c = s.add.circle(x, y, 24, 0x9b_6b_ff, 0.6).setDepth(y + 100);
      s.tweens.add({
        alpha: 0,
        duration: 300,
        onComplete: () => c.destroy(),
        scale: 0,
        targets: c,
      });
    }
  }

  private playLevelupFx(fx: Extract<FxEvent, { t: "levelup" }>): void {
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
    // overload: an expanding golden ring at the feet + a warm flash column
    const ring = s.add
      .circle(x, y + 10, 20, 0xff_e1_4a, 0)
      .setStrokeStyle(4, 0xff_e1_4a, 1)
      .setDepth(y + 50);
    s.tweens.add({
      alpha: 0,
      duration: 600,
      onComplete: () => ring.destroy(),
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
      onComplete: () => glow.destroy(),
      scaleX: 0.9,
      scaleY: 2.2,
      targets: glow,
    });
    // processing: sparkle stars rising off the hero (the lingering payoff)
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
          onComplete: () => star.destroy(),
          targets: star,
          y: y - 40 - Math.random() * 42,
        });
      }
    }
  }

  private playGoldFx(fx: Extract<FxEvent, { t: "gold" }>): void {
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

  private playHealFx(fx: Extract<FxEvent, { t: "heal" }>): void {
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

  private playStructureDownFx(fx: Extract<FxEvent, { t: "structureDown" }>): void {
    const s = this.scene;
    sfx.structureDown();
    this.traumaAt(fx.x, fx.y, 0.85);
    this.stampScorch(fx.x, fx.y, 150);
    this.spawnShockwave(fx.x, fx.y, 0xff_d9_a0, 1.4);
    // a barrage: the main blast plus offset secondary bursts (never one long one)
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

  private playDeathFx(fx: Extract<FxEvent, { t: "death" }>): void {
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

  private playCastFx(fx: Extract<FxEvent, { t: "cast" }>): void {
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
    // self/aura cast bursts (windfoot, flashfire, powder keg, blink puff…)
    const spec = abilityCastFx(fx.effect);
    if (spec && spec.at === "caster") {
      this.spawnSpellSprite(fx.x, fx.y, spec);
    }
  }

  /** Play a one-shot spell-effect sprite at (x,y). `rotation` turns aimed
   *  art toward its target; `delay` staggers copies laid along a shot. */
  private spawnSpellSprite(x: number, y: number, spec: SpellCastFx, rotation = 0, delay = 0): void {
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

  private playAbilityFx(fx: Extract<FxEvent, { t: "ability" }>): void {
    // This event starts the fuse. The existing ground zone owns the warning.
    if (fx.effect === "emberhex:R") {
      return;
    }
    const col = effectColor(fx.effect);
    const spec = abilityCastFx(fx.effect);
    // the one true skillshot LINE (Piercing Shot) → a soft electric beam with
    // the lightning-arrow art laid along it, never a bare white line.
    if (fx.effect === "stormcaller:Q") {
      this.spawnBeam(fx.x, fx.y - 16, fx.x2, fx.y2 - 16, 0x8f_d0_ff, spec);
      return;
    }
    // targeted spell bursts (shield bash, death waltz, hex, heal…) and aimed
    // cones (fanned daggers) that start on the caster facing the target
    if (spec?.at === "target") {
      this.spawnSpellSprite(fx.x2, fx.y2, spec);
    } else if (spec?.at === "aimed") {
      this.spawnSpellSprite(fx.x, fx.y - 12, spec, Math.atan2(fx.y2 - fx.y, fx.x2 - fx.x));
    }
    // area abilities → a soft radial impact glow sized to the zone (the detailed
    // art is the cast-fx sprite / explosion / ground zone; this just reads the AoE),
    // plus a distance-weighted rumble and, for the big ones, a shockwave ring.
    if (fx.radius >= 90 && fx.effect !== "duskblade:W") {
      this.spawnSoftImpact(fx.x2, fx.y2, fx.radius, col);
      this.traumaAt(fx.x2, fx.y2, PhaserMath.Clamp(fx.radius / 900, 0.08, 0.4));
      if (fx.radius >= 150) {
        this.spawnShockwave(fx.x2, fx.y2, col, 1);
      }
    }
  }

  /** A soft glowing energy beam (stretched radial glow + bright core), not a flat
   *  line — for the piercing skillshot. */
  private spawnBeam(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    col: number,
    arrow: SpellCastFx | null,
  ): void {
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
      // three arrows fired in quick succession read as travel along the shot
      const stops = this.focused || this.reducedMotion ? [0.5] : [0.2, 0.5, 0.8];
      for (const [i, t] of stops.entries()) {
        this.spawnSpellSprite(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, arrow, rotation, i * 0.045);
      }
    }
  }

  /** A brief ground response; the outer edge stops at the actual event radius. */
  private spawnSoftImpact(x: number, y: number, r: number, col: number): void {
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
