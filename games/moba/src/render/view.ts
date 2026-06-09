import Phaser from "phaser";

import { BASES, BRIDGES, NEUTRAL_CAMPS, TOWERS, TREE_CLUSTERS, WORLD, isRiver } from "../data/map";
import type { Team } from "../data/config";
import type { World, Unit, Projectile, GroundEffect, FxEvent } from "../sim/types";
import { sfx } from "./audio";
import { animKey, heroTint, structureDestroyedTex, unitSprite } from "./sprites";

const GRASS_FRAME = 11; // solid-green centre tile of ground_flat autotile
const DEPTH_GROUND = -100;
const DEPTH_DECAL = -50;
const CELL = 64;

// 4-bit autotile: which orthogonal neighbours are WATER (N=8,E=4,S=2,W=1) -> the
// ground_flat green tile index whose dark edge faces that water. Verified against
// the sheet: 0=TL corner, 11=interior, 33=isolated.
const GRASS_AUTOTILE: Record<number, number> = {
  0: 11, 1: 10, 2: 21, 3: 20, 4: 12, 5: 13, 6: 22, 7: 23,
  8: 1, 9: 0, 10: 31, 11: 30, 12: 2, 13: 3, 14: 32, 15: 33,
};

// Elevation (cliff) autotile — Tilemap_Elevation tall block. Same neighbour bits
// (N=8,E=4,S=2,W=1, set when that neighbour is LOWER ground): TL=0 top=1 TR=2,
// left=4 interior=5 right=6, cliff-BL=12 cliff-bottom=13 cliff-BR=14.
const ELEV_AUTOTILE: Record<number, number> = {
  0: 5, 8: 1, 4: 6, 2: 13, 1: 4, 9: 0, 12: 2, 3: 12,
  6: 14, 10: 13, 5: 7, 13: 3, 7: 15, 11: 12, 14: 14, 15: 15,
};

// Raised grassy plateaus with rock cliff edges, in the off-lane jungle quadrants
// (clear of the river + lanes). {x,y,r} circles → a "high" cell mask.
const PLATEAUS: Array<{ x: number; y: number; r: number }> = [
  { x: 1850, y: 4480, r: 380 }, // radiant top jungle
  { x: 2980, y: 5180, r: 340 }, // radiant bottom jungle
  { x: 4550, y: 1920, r: 380 }, // dire bottom jungle
  { x: 3220, y: 1880, r: 340 }, // dire top jungle
  { x: 1180, y: 5060, r: 300 }, // radiant base-side rise
  { x: 5220, y: 1540, r: 300 }, // dire base-side rise
];

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
  flashUntil: number;
  lastAttackAt: number; // detect a fresh swing to play the attack anim once
  dead: boolean; // playing/played the death anim while hidden (heroes)
};

type StructView = {
  sprite: Phaser.GameObjects.Image;
  hpBg: Phaser.GameObjects.Rectangle;
  hpFill: Phaser.GameObjects.Rectangle;
  range: Phaser.GameObjects.Arc | null;
  dead: boolean;
};

export class WorldView {
  private scene: Phaser.Scene;
  private units = new Map<string, UnitView>();
  private structs = new Map<string, StructView>();
  private projs = new Map<string, Phaser.GameObjects.Image>();
  private grounds = new Map<string, Phaser.GameObjects.Arc>();
  private mines = new Map<string, Phaser.GameObjects.Arc>();
  playerHeroId = "";
  playerTeam: "radiant" | "dire" = "radiant";

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  buildTerrain(): void {
    const s = this.scene;
    const cols = Math.ceil(WORLD.width / CELL);
    const rows = Math.ceil(WORLD.height / CELL);

    // The whole world is an island: water everywhere, grass painted on top as an
    // autotiled landmass with a 2-cell water border and the river carved through.
    const isLand = (cx: number, cy: number): boolean => {
      if (cx < 2 || cy < 2 || cx >= cols - 2 || cy >= rows - 2) return false;
      return !isRiver(cx * CELL + CELL / 2, cy * CELL + CELL / 2);
    };

    // 1) animated-feeling deep water underlay
    s.add.tileSprite(0, 0, WORLD.width, WORLD.height, "t-water").setOrigin(0, 0).setDepth(DEPTH_GROUND - 10);
    // a subtle darker tint band over the river centre to give it depth
    const riverShade = s.add.graphics().setDepth(DEPTH_GROUND - 9);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const x = cx * CELL;
        const y = cy * CELL;
        if (!isLand(cx, cy) && isRiver(x + CELL / 2, y + CELL / 2)) {
          riverShade.fillStyle(0x1c4a6e, 0.5).fillRect(x, y, CELL, CELL);
        }
      }
    }

    // 2) autotiled grass landmass as a single tilemap layer (one draw)
    this.buildGroundLayer(isLand, cols, rows);

    // 2b) raised stone mesas (cliff autotile) for vertical depth
    if (this.scene.textures.exists("t-elev")) this.buildElevation(isLand, cols, rows);

    // 3) foam along the river shoreline (sampled so it stays cheap)
    if (this.scene.textures.exists("t-foam")) this.buildFoam(isLand, cols, rows);

    // 4) bridges where lanes cross the river
    this.buildBridges();

    // 5) fountains (glowing pools at each base)
    for (const team of ["radiant", "dire"] as const) {
      const b = BASES[team];
      const col = team === "radiant" ? 0x4fa3ff : 0xff5a4a;
      s.add.circle(b.fountain.x, b.fountain.y, b.fountainRadius, col, 0.06).setDepth(DEPTH_GROUND + 1);
      s.add.circle(b.fountain.x, b.fountain.y, 90, 0x2f6f9e, 0.85).setStrokeStyle(5, 0x9fd0ff, 0.7).setDepth(DEPTH_DECAL);
      s.add.circle(b.fountain.x, b.fountain.y, 54, 0x9fd0ff, 0.5).setDepth(DEPTH_DECAL);
    }

    // 6) jungle trees (depth-sorted so heroes weave between them)
    this.buildTrees(isLand);

    // 7) scattered rocks / bushes / mushrooms for texture
    this.buildScatter(isLand, cols, rows);

    // 8) faint marker rings at each neutral camp so the jungle reads as farmable
    for (const c of NEUTRAL_CAMPS) {
      const boss = c.kind === "roshan";
      s.add
        .circle(c.x, c.y, boss ? 150 : 90, boss ? 0x7a2a2a : 0x2a3a22, boss ? 0.22 : 0.16)
        .setStrokeStyle(2, boss ? 0xc8643c : 0x6a8a4c, 0.5)
        .setDepth(DEPTH_GROUND + 2);
    }
  }

  private buildGroundLayer(isLand: (cx: number, cy: number) => boolean, cols: number, rows: number): void {
    const s = this.scene;
    if (!s.textures.exists("t-ground-img")) {
      s.add.tileSprite(0, 0, WORLD.width, WORLD.height, "t-ground", GRASS_FRAME).setOrigin(0, 0).setDepth(DEPTH_GROUND);
      return;
    }
    const data: number[][] = [];
    for (let cy = 0; cy < rows; cy++) {
      const row: number[] = [];
      for (let cx = 0; cx < cols; cx++) {
        if (!isLand(cx, cy)) {
          row.push(-1);
          continue;
        }
        const k =
          (isLand(cx, cy - 1) ? 0 : 8) |
          (isLand(cx + 1, cy) ? 0 : 4) |
          (isLand(cx, cy + 1) ? 0 : 2) |
          (isLand(cx - 1, cy) ? 0 : 1);
        row.push(GRASS_AUTOTILE[k] ?? GRASS_FRAME);
      }
      data.push(row);
    }
    const map = s.make.tilemap({ data, tileWidth: CELL, tileHeight: CELL });
    const tiles = map.addTilesetImage("ground", "t-ground-img");
    if (tiles) {
      const layer = map.createLayer(0, tiles, 0, 0);
      layer?.setDepth(DEPTH_GROUND);
    } else {
      s.add.tileSprite(0, 0, WORLD.width, WORLD.height, "t-ground", GRASS_FRAME).setOrigin(0, 0).setDepth(DEPTH_GROUND);
    }
  }

  /** Raised stone mesas via the cliff autotile, with a grounding shadow at the drop. */
  private buildElevation(isLand: (cx: number, cy: number) => boolean, cols: number, rows: number): void {
    const s = this.scene;
    const high = (cx: number, cy: number): boolean => {
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows || !isLand(cx, cy)) return false;
      const x = cx * CELL + CELL / 2;
      const y = cy * CELL + CELL / 2;
      for (const p of PLATEAUS) if ((x - p.x) ** 2 + (y - p.y) ** 2 <= p.r * p.r) return true;
      return false;
    };
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        if (!high(cx, cy)) continue;
        const sLow = !high(cx, cy + 1);
        const k =
          (high(cx, cy - 1) ? 0 : 8) |
          (high(cx + 1, cy) ? 0 : 4) |
          (sLow ? 2 : 0) |
          (high(cx - 1, cy) ? 0 : 1);
        if (k === 0) continue; // interior stays grass — only edges get the rock rim/cliff
        const frame = ELEV_AUTOTILE[k] ?? 5;
        const x = cx * CELL;
        const y = cy * CELL;
        const cxp = x + CELL / 2;
        // grounding shadow just below a south-facing cliff edge (the tileset's face
        // is only ~half a tile, so a soft shadow sells the drop without terracing).
        if (sLow) {
          s.add.ellipse(cxp, y + CELL + 14, CELL + 16, 26, 0x000000, 0.34).setDepth(DEPTH_GROUND + 1);
        }
        s.add.image(cxp, y + CELL / 2, "t-elev", frame).setDepth(DEPTH_GROUND + 3);
      }
    }
  }

  private buildFoam(isLand: (cx: number, cy: number) => boolean, cols: number, rows: number): void {
    const s = this.scene;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        if (isLand(cx, cy)) continue; // foam sits on the water side
        const shore =
          isLand(cx, cy - 1) || isLand(cx + 1, cy) || isLand(cx, cy + 1) || isLand(cx - 1, cy);
        if (!shore) continue;
        if ((cx + cy) % 2 !== 0) continue; // sample every other shore cell
        const f = s.add
          .sprite(cx * CELL + CELL / 2, cy * CELL + CELL / 2, "t-foam", 0)
          .setScale(0.5)
          .setAlpha(0.8)
          .setDepth(DEPTH_GROUND - 8);
        if (s.anims.exists("t-foam-loop")) f.play({ key: "t-foam-loop", startFrame: (cx + cy) % 8 });
      }
    }
  }

  private buildBridges(): void {
    const s = this.scene;
    const hasTex = s.textures.exists("t-bridge");
    for (const b of BRIDGES) {
      if (hasTex) {
        // plank strip (frame 1 = horizontal middle) spanning the river, with caps,
        // rotated -45° to cross the y=x river perpendicular to its flow.
        const len = b.r * 1.5;
        const strip = s.add
          .tileSprite(b.x, b.y, len, 64, "t-bridge", 1)
          .setScale(1.25)
          .setAngle(-45)
          .setDepth(DEPTH_DECAL);
        void strip;
        const ang = (-45 * Math.PI) / 180;
        const ex = Math.cos(ang) * (len * 1.25) / 2;
        const ey = Math.sin(ang) * (len * 1.25) / 2;
        s.add.image(b.x - ex, b.y - ey, "t-bridge", 0).setScale(1.25).setAngle(-45).setDepth(DEPTH_DECAL + 1);
        s.add.image(b.x + ex, b.y + ey, "t-bridge", 2).setScale(1.25).setAngle(-45).setDepth(DEPTH_DECAL + 1);
      } else {
        s.add.rectangle(b.x, b.y, b.r * 1.6, b.r * 1.2, 0x8a5a2b).setStrokeStyle(6, 0x5e3c1a).setDepth(DEPTH_DECAL).setAngle(-45);
      }
    }
  }

  private buildTrees(isLand: (cx: number, cy: number) => boolean): void {
    const s = this.scene;
    const hasTree = s.textures.exists("t-tree");
    for (const t of TREE_CLUSTERS) {
      const n = Math.max(6, Math.floor(t.r / 30));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + (t.x % 7);
        const rr = t.r * (0.25 + 0.7 * rng2(t.x + i, t.y - i));
        const tx = t.x + Math.cos(a) * rr;
        const ty = t.y + Math.sin(a) * rr;
        if (!isLand(Math.floor(tx / CELL), Math.floor(ty / CELL))) continue;
        s.add.image(tx, ty + 26, "shadow").setDisplaySize(70, 26).setAlpha(0.4).setDepth(ty - 1);
        if (hasTree) s.add.image(tx, ty, "t-tree", 0).setScale(0.5 + rng2(tx, ty) * 0.18).setDepth(ty);
        else s.add.circle(tx, ty, 26, 0x2f5a2a).setDepth(ty);
      }
    }
  }

  private buildScatter(isLand: (cx: number, cy: number) => boolean, cols: number, rows: number): void {
    const s = this.scene;
    const step = 5; // every ~5 cells, maybe drop a decal
    for (let cy = 4; cy < rows - 4; cy += step) {
      for (let cx = 4; cx < cols - 4; cx += step) {
        const r = rng2(cx, cy);
        if (r > 0.34) continue;
        const x = cx * CELL + CELL / 2 + (rng2(cx + 9, cy) - 0.5) * 120;
        const y = cy * CELL + CELL / 2 + (rng2(cx, cy + 9) - 0.5) * 120;
        if (!isLand(Math.floor(x / CELL), Math.floor(y / CELL))) continue;
        // keep decals out of the base/fountain footprints
        const near = (fx: number, fy: number) => (x - fx) ** 2 + (y - fy) ** 2 < 460 * 460;
        if (near(BASES.radiant.fountain.x, BASES.radiant.fountain.y)) continue;
        if (near(BASES.dire.fountain.x, BASES.dire.fountain.y)) continue;
        let key: string;
        if (r < 0.1) key = `deco-rock${1 + Math.floor(rng2(cx, cy + 3) * 4)}`;
        else if (r < 0.2) key = `deco-bush${1 + Math.floor(rng2(cx + 3, cy) * 4)}`;
        else key = `deco-${String(1 + Math.floor(rng2(cx + 5, cy + 5) * 18)).padStart(2, "0")}`;
        if (!s.textures.exists(key)) continue;
        s.add.image(x, y, key).setScale(0.6 + rng2(x, y) * 0.4).setDepth(y).setAlpha(0.95);
      }
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
      this.structs.set(id, { sprite: sp, hpBg, hpFill, range: null, dead: false });
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
        continue;
      }
      if (u.alive) {
        const w = u.structure?.tier === "ancient" ? 120 : 64;
        sv.hpFill.width = Math.max(0, (u.hp / u.maxHp) * w);
        const attackable = u.structure?.attackable ?? true;
        sv.hpFill.setFillStyle(attackable ? teamHpColor(u.team) : 0x6a7488);
      }
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
            v.sprite.once("animationcomplete", () => v.container.setVisible(false));
          } else {
            v.container.setVisible(false);
          }
        }
        continue;
      }
      seen.add(u.id);
      let v = this.units.get(u.id);
      if (!v) v = this.createUnitView(u);
      if (v.dead) {
        // respawned — snap back so we don't slide from the death spot to base
        v.dead = false;
        v.dx = u.x;
        v.dy = u.y;
        v.curAnim = "";
      }
      v.container.setVisible(true);

      // smooth display position toward sim position
      const k = 1 - Math.pow(0.001, dt);
      v.dx = Phaser.Math.Linear(v.dx, u.x, k);
      v.dy = Phaser.Math.Linear(v.dy, u.y, k);
      v.container.setPosition(v.dx, v.dy);
      v.container.setDepth(v.dy);

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

      // hit flash — compare against the SAME render clock that set flashUntil
      // (scene.time.now), not the sim clock, so it lasts ~90ms instead of lingering.
      if (this.scene.time.now < v.flashUntil) v.sprite.setTint(0xff6b6b);
      else if (u.kind === "hero") v.sprite.setTint(heroTint(u));
      else v.sprite.clearTint();

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

  /** One-shot death animation at a unit's last position (for reaped creeps). */
  private spawnDeathAnim(v: UnitView): void {
    if (v.dead) return; // a hero already played its death in-place
    const tex = v.sprite.texture.key;
    const dkey = `${tex}-death`;
    if (!this.scene.anims.exists(dkey)) return;
    const s = this.scene;
    const corpse = s.add
      .sprite(v.dx, v.dy - 18, tex, 0)
      .setScale(v.sprite.scaleX, v.sprite.scaleY)
      .setFlipX(v.sprite.flipX)
      .setDepth(v.dy - 2);
    corpse.play(dkey);
    corpse.once("animationcomplete", () => {
      s.tweens.add({ targets: corpse, alpha: 0, duration: 260, onComplete: () => corpse.destroy() });
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
    if (u.kind === "hero") sprite.setTint(heroTint(u));

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
    const v: UnitView = { container, sprite, shadow, ring, hpBg, hpFill, mpFill, label, dx: u.x, dy: u.y, curAnim: "", flashUntil: 0, lastAttackAt: 0, dead: false };
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
        const v = this.units.get(fx.targetId);
        if (v) v.flashUntil = (this.scene.time.now) + 90;
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
        if (s.anims.exists("fx-explode")) {
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
        break;
      }
      case "death": {
        if (fx.kind === "hero") sfx.death();
        if (fx.kind === "creep") {
          const puff = s.add.image(fx.x, fx.y - 10, "spark").setDepth(fx.y + 10).setTint(0xdddddd).setScale(1.5);
          s.tweens.add({ targets: puff, scale: 0, alpha: 0, duration: 320, onComplete: () => puff.destroy() });
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
