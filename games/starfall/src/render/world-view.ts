import { Math as PhaserMath } from "phaser";
import type Phaser from "phaser";
import { sfx } from "../audio/sfx";
import type { HostDirector } from "../net/host-director";
import {
  BEACON_CHARGE_S,
  BEACON_CONTEST_STROBE_HZ,
  BEACON_RADIUS,
  BEACON_TINT,
  BOOSTER_KINDS,
  DEBUT_PIP_MAX,
  EARLY_SPAWN_WINDOW_S,
  ENEMY_SHOT_LEN,
  ENEMY_SHOT_TINT,
  ENEMY_SHOT_WIDTH,
  ENEMY_SPECS,
  ITEM_DRAW_RADIUS,
  SHARD_TINT,
  SHIELD_MOD_KINDS,
  SINGULARITY_PULL_MS,
  SINGULARITY_PULL_RANGE,
  asteroidUnitVerts,
} from "../shared/constants";
import type {
  EnemyKind,
  EnemyState,
  ItemState,
  SerializedBeam,
  SharedState,
} from "../shared/constants";
import type { Link } from "../state/link";
import type { Pilot } from "../state/pilot";
import { serializeBeam } from "../sys/beam";
import { DEG, dist2, inWorld } from "../sys/geometry";
import { SINGULARITY_TINT } from "../sys/weapons";
import type { Weapons } from "../sys/weapons";
import { REDUCED_MOTION } from "./battle-fx";
import { enemyChargeDuration, enemyChargeProgress } from "./charge-progress";
import { weaponLook } from "./combat-visuals";
import type { WeaponLook } from "./combat-visuals";
import type { PipTarget } from "./edge-pips";
import { fleetPose, hostileShotLook } from "./fleet-acting";
import type { FxImportance, FxPool } from "./fx-pool";
import type { Layers } from "./layers";
import { itemTint } from "./tint";
import type { TraumaCamera } from "./trauma-camera";
import {
  GLAIVE_TRI,
  UFO_OUTLINE,
  drawJitteredChain,
  drawPoly,
  drawTelegraphAccent,
  drawWardenArmor,
  enemyHullPoints,
  enemyStrokeWeight,
  graceAlpha,
  hexagonPoints,
  strokeClosed,
  strokeDiamond,
  strokeHexRing,
  strokeRegularPolygon,
  strokeTransformed,
} from "./vector-shapes";

/** Late-built collaborators whose state the view draws. */
export interface WorldViewHooks {
  /** Built after the view; resolved at call time. */
  weapons: () => Weapons;
}

export interface AsteroidObjs {
  gfx: Phaser.GameObjects.Graphics;
  drawnRadius: number;
}

export interface ItemObjs {
  gfx: Phaser.GameObjects.Graphics;
  tint: number;
}

export interface EnemyObjs {
  gfx: Phaser.GameObjects.Graphics;
  kind: EnemyKind;
  /** Dedupe telegraph_warn: remember the last telegraph window we voiced. */
  lastTelegraphUntil: number;
  /** Authored duration captured once; phase changes cannot rewind a live warning. */
  telegraphDuration: number;
  /** Lancer close-pass trauma fires once per charge. */
  chargeTraumaDone: boolean;
  /** Lancer charge-trail cadence on the sim clock (0 = not charging). */
  nextTrailAt: number;
}

export interface Splinter {
  originX: number;
  originY: number;
  angle: number;
  dist: number;
  speed: number;
  diesAt: number;
  x: number;
  y: number;
}

/** Lancer charge-trail spark cadence (sim time). */
export const LANCER_TRAIL_MS = 1000 / 60;

/** Trailer mode: the pip pass draws this (clears the layer, zero alloc). */
export const NO_PIPS: readonly PipTarget[] = [];

export const SPLINTER_LIFE_MS = 7000;

export const SPLINTER_PX = 2;

/** qa-011 stroke weight: hull/telegraph strokes multiply by this so they hold
 *  >=~1.25px on-screen as the camera zooms out — and gain the same touch of
 *  weight at zoom 1, where 1px vector strokes read whisper-thin on 720p. */
export const STROKE_BASE = 1.25;

export const STROKE_MAX = 1.7;

export const deathBurstSize = (boss: boolean, big: boolean): number => {
  if (boss) {
    return 270;
  }
  return big ? 95 : 48;
};

export const deathTrauma = (boss: boolean, big: boolean): number => {
  if (boss) {
    return 0.5;
  }
  return big ? 0.18 : 0.1;
};

/** Enemy shot render family from the shooter's weapon look. */
export const enemyShotBeamLook = (
  look: ReturnType<typeof hostileShotLook>,
): "rail" | "plasma" | "rapid" => {
  if (look === "lance" || look === "rail") {
    return "rail";
  }
  return look === "plasma" ? "plasma" : "rapid";
};

export interface WorldViewDeps {
  scene: Phaser.Scene;
  world: SharedState;
  pilot: Pilot;
  link: Link;
  fx: FxPool;
  layers: Layers;
  trauma: TraumaCamera;
  host: HostDirector;
  hooks: WorldViewHooks;
}

/** Rendering of the host-owned world: asteroids, UFO, items, shards, enemies (with telegraphs, charge trails and death bursts), pulls, the beacon ring, edge pips, enemy shots and beams. */
export class WorldView {
  asteroidObjs = new Map<string, AsteroidObjs>();

  itemObjs = new Map<string, ItemObjs>();

  enemyObjs = new Map<string, EnemyObjs>();

  ufoGfx: Phaser.GameObjects.Graphics | null = null;

  ufoId = "";

  splinters: Splinter[] = [];

  private readonly scene: Phaser.Scene;

  private readonly world: SharedState;

  private readonly pilot: Pilot;

  private readonly link: Link;

  private readonly fx: FxPool;

  private readonly layers: Layers;

  private readonly trauma: TraumaCamera;

  private readonly host: HostDirector;

  private readonly hooks: WorldViewHooks;

  constructor(deps: WorldViewDeps) {
    this.scene = deps.scene;
    this.world = deps.world;
    this.pilot = deps.pilot;
    this.link = deps.link;
    this.fx = deps.fx;
    this.layers = deps.layers;
    this.trauma = deps.trauma;
    this.host = deps.host;
    this.hooks = deps.hooks;
  }

  /** Tiny wireframe crystals, one pooled Graphics pass (additive layer):
   *  4-point diamond + vertical facet, gentle pulse, fade in the last 1.5s. */
  drawShards(now: number): void {
    const g = this.layers.shardGfx;
    g.clear();
    for (const s of this.world.shards) {
      const left = s.diesAt - now;
      if (left <= 0) {
        continue;
      }
      const alpha = 0.9 * Math.min(1, left / 1500);
      const r = 2.5 + 0.7 * Math.sin(now / 180 + s.x * 0.05);
      g.lineStyle(1, SHARD_TINT, alpha);
      strokeDiamond(g, s.x, s.y, r);
      g.lineBetween(s.x, s.y - r, s.x, s.y + r);
    }
  }

  onScreen(x: number, y: number): boolean {
    const v = this.scene.cameras.main.worldView;
    return x >= v.x - 100 && x <= v.right + 100 && y >= v.y - 100 && y <= v.bottom + 100;
  }

  syncAsteroids(now: number): void {
    const seen = new Set<string>();
    for (const a of this.world.asteroids) {
      seen.add(a.id);
      let rec = this.asteroidObjs.get(a.id);
      if (!rec) {
        rec = { drawnRadius: 0, gfx: this.scene.add.graphics().setDepth(5) };
        this.asteroidObjs.set(a.id, rec);
      }
      if (rec.drawnRadius !== a.radius) {
        drawPoly(
          rec.gfx,
          asteroidUnitVerts(a.id).map((v) => ({ x: v.x * a.radius, y: v.y * a.radius })),
        );
        if (rec.drawnRadius > a.radius) {
          // Took a hit: brief scale pop + matter debris + energy sparks.
          rec.gfx.setScale(1.15);
          this.scene.tweens.add({ duration: 120, ease: "Quad.Out", scale: 1, targets: rec.gfx });
          this.fx.debris(a.x, a.y, 4, 0xff_ff_ff, {
            lifeMax: 500,
            lifeMin: 300,
            speedMax: 160,
            speedMin: 60,
          });
          this.fx.sparks(a.x, a.y, 4, 0xff_ff_ff, { lifeMax: 250, lifeMin: 150 });
        }
        rec.drawnRadius = a.radius;
      }
      rec.gfx.setPosition(a.x, a.y).setRotation(a.rot);
    }
    for (const [id, rec] of this.asteroidObjs) {
      if (seen.has(id)) {
        continue;
      }
      // Destroyed (visible burst) or culled off-world (burst hidden by mask).
      this.fx.battle.burst(
        rec.gfx.x,
        rec.gfx.y,
        Math.min(115, rec.drawnRadius * 1.4),
        0xae_c6_dd,
        "fracture",
      );
      this.splinterBurst(rec.gfx.x, rec.gfx.y, rec.drawnRadius, 20, now);
      this.fx.sparks(rec.gfx.x, rec.gfx.y, 6, 0xff_ff_ff, { lifeMax: 250, lifeMin: 150 });
      if (dist2(rec.gfx.x, rec.gfx.y, this.pilot.shipX, this.pilot.shipY) < 400 * 400) {
        this.trauma.add(0.05);
      }
      this.scene.tweens.killTweensOf(rec.gfx);
      rec.gfx.destroy();
      this.asteroidObjs.delete(id);
    }
  }

  syncUfo(now: number): void {
    const u = this.world.ufo;
    if (!u) {
      if (this.ufoGfx) {
        this.fx.battle.burst(this.ufoGfx.x, this.ufoGfx.y, 85, 0x83_d6_f5, "death");
        this.splinterBurst(this.ufoGfx.x, this.ufoGfx.y, 25, 20, now);
        this.fx.sparks(this.ufoGfx.x, this.ufoGfx.y, 8, 0xff_ff_ff, {
          lifeMax: 350,
          lifeMin: 200,
        });
        this.ufoGfx.destroy();
        this.ufoGfx = null;
      }
      return;
    }
    if (!this.ufoGfx || this.ufoId !== u.id) {
      this.ufoGfx?.destroy();
      this.ufoGfx = this.makeUfoGfx();
      this.ufoId = u.id;
    }
    this.ufoGfx.setPosition(u.x, u.y);
    // Damage flicker: hidden every 4th 66ms slot (legacy: every 4th tick of 40).
    const hidden = now < u.blinkUntil && Math.floor(now / 66) % 4 === 0;
    this.ufoGfx.setVisible(!hidden);
  }

  syncItems(): void {
    const seen = new Set<string>();
    for (const it of this.world.items) {
      seen.add(it.id);
      let rec = this.itemObjs.get(it.id);
      if (!rec) {
        rec = { gfx: this.makeItemGfx(it), tint: itemTint(it) };
        this.itemObjs.set(it.id, rec);
        this.scene.tweens.add({
          duration: 600,
          ease: "Sine.InOut",
          repeat: -1,
          scale: { from: 0.92, to: 1.1 },
          targets: rec.gfx,
          yoyo: true,
        });
      }
      rec.gfx.setPosition(it.x, it.y);
    }
    for (const [id, rec] of this.itemObjs) {
      if (seen.has(id)) {
        continue;
      }
      this.fx.sparks(rec.gfx.x, rec.gfx.y, 10, rec.tint, {
        lifeMax: 420,
        lifeMin: 200,
        speedMax: 140,
        speedMin: 30,
      });
      this.scene.tweens.killTweensOf(rec.gfx);
      rec.gfx.destroy();
      this.itemObjs.delete(id);
    }
  }

  syncEnemies(now: number): void {
    const seen = new Set<string>();
    const reduced = REDUCED_MOTION.matches;
    for (const e of this.world.enemies) {
      seen.add(e.id);
      const rec = this.enemyRec(e);
      // A hit accents the hull without hiding the threat.
      rec.gfx.setVisible(true);
      rec.gfx.setAlpha(e.graceUntil > now ? graceAlpha(reduced, now) : 1);
      this.voiceTelegraph(e, rec, now);
      const pose = fleetPose(e, now, rec.telegraphDuration, reduced);
      rec.gfx
        .setPosition(e.x - Math.cos(e.angle) * pose.recoil, e.y - Math.sin(e.angle) * pose.recoil)
        .setRotation(e.angle)
        .setScale(pose.scaleX, pose.scaleY);
      if (e.kind === "lancer") {
        this.syncLancerCharge(e, rec, reduced, now);
      }
    }
    // Ordinary enemies can also despawn far away. Only dreadnought removal
    // warrants a victory cue; trailer cuts clear the display cache silently.
    for (const [id, rec] of this.enemyObjs) {
      if (seen.has(id)) {
        continue;
      }
      this.enemyDeathFx(rec);
      rec.gfx.destroy();
      this.enemyObjs.delete(id);
    }
  }

  private enemyRec(e: EnemyState): EnemyObjs {
    const existing = this.enemyObjs.get(e.id);
    if (existing) {
      return existing;
    }
    const rec: EnemyObjs = {
      chargeTraumaDone: false,
      gfx: this.makeEnemyGfx(e.kind),
      kind: e.kind,
      lastTelegraphUntil: 0,
      nextTrailAt: 0,
      telegraphDuration: 0,
    };
    this.enemyObjs.set(e.id, rec);
    return rec;
  }

  /** Telegraph audio: LANCER windup + WASP burst, on-screen only (§6.1). */
  private voiceTelegraph(e: EnemyState, rec: EnemyObjs, now: number): void {
    if (e.telegraphUntil <= now || rec.lastTelegraphUntil === e.telegraphUntil) {
      return;
    }
    rec.lastTelegraphUntil = e.telegraphUntil;
    rec.telegraphDuration = enemyChargeDuration(e);
    if (
      (e.kind === "lancer" ||
        e.kind === "wasp" ||
        e.kind === "warden" ||
        e.kind === "sniper" ||
        e.kind === "dreadnought") &&
      this.onScreen(e.x, e.y)
    ) {
      sfx.play("telegraph_warn");
    }
  }

  private syncLancerCharge(e: EnemyState, rec: EnemyObjs, reduced: boolean, now: number): void {
    if (e.chargeUntil <= now) {
      rec.chargeTraumaDone = false;
      rec.nextTrailAt = 0;
      return;
    }
    // Charge trail (ADD, hull tint) at 60/s of SIM time so density is
    // frame-rate independent; a long gap emits at most 3, not a backlog.
    if (rec.nextTrailAt === 0) {
      rec.nextTrailAt = now;
    }
    const due = Math.max(0, Math.floor((now - rec.nextTrailAt) / LANCER_TRAIL_MS) + 1);
    rec.nextTrailAt += due * LANCER_TRAIL_MS;
    if (due > 0 && !reduced) {
      this.fx.sparks(e.x, e.y, Math.min(3, due), ENEMY_SPECS.lancer.tint, {
        lifeMax: 250,
        lifeMin: 250,
        scale: 0.5,
        speedMax: 20,
        speedMin: 0,
      });
    }
    if (
      !rec.chargeTraumaDone &&
      this.pilot.alive &&
      dist2(e.x, e.y, this.pilot.shipX, this.pilot.shipY) < 100 * 100
    ) {
      rec.chargeTraumaDone = true;
      this.trauma.add(0.15);
    }
  }

  private enemyDeathFx(rec: EnemyObjs): void {
    const spec = ENEMY_SPECS[rec.kind];
    const { x } = rec.gfx;
    const { y } = rec.gfx;
    const big = spec.hp >= 80;
    const boss = rec.kind === "dreadnought";
    const importance = boss ? "important" : "common";
    this.fx.battle.burst(
      x,
      y,
      deathBurstSize(boss, big),
      spec.tint,
      boss ? "boss" : "death",
      rec.gfx.rotation,
      importance,
    );
    this.fx.shatter(x, y, enemyHullPoints(rec.kind), rec.gfx.rotation, spec.tint, importance);
    this.fx.sparks(x, y, 8, spec.tint, { importance, lifeMax: 350, lifeMin: 200 });
    if (rec.kind === "lancer" || rec.kind === "splitter" || boss) {
      this.fx.ring(
        x,
        y,
        boss ? 16 : 6,
        boss ? 240 : 60,
        boss ? 700 : 350,
        spec.tint,
        0.85,
        importance,
      );
    }
    if (boss) {
      // Big multi-ring death blast for the marquee kill.
      this.fx.bossDefeat(x, y, spec.tint);
      this.fx.ring(x, y, 10, 140, 500, 0xff_ff_ff, 0.65, "important");
      this.fx.sparks(x, y, 40, spec.tint, {
        importance: "important",
        lifeMax: 600,
        lifeMin: 300,
        speedMax: 360,
        speedMin: 120,
      });
    }
    if (this.onScreen(x, y)) {
      // The accepted encounter edge owns the single boss resolve cue.
      if (!boss) {
        sfx.play("enemy_death", big ? { gain: 1.3, rate: 0.8 } : {});
      }
      this.trauma.add(deathTrauma(boss, big));
    }
  }

  /** Stable warnings live outside decorative budgets. Charge reads the host's
   * sim-clock deadline; no sight is re-aimed or hidden on a blink frame. */
  drawEnemyTelegraphs(now: number): void {
    const g = this.layers.telegraphGfx;
    const sw = this.strokeScale();
    g.clear();
    for (const e of this.world.enemies) {
      const spec = ENEMY_SPECS[e.kind];
      if (e.kind === "warden") {
        drawWardenArmor(g, e, spec.hitRadius + 6, sw);
      }
      // Retain the existing damage response independently of anticipation.
      if (e.blinkUntil > now && (REDUCED_MOTION.matches || Math.floor(now / 66) % 4 === 0)) {
        g.lineStyle(2 * sw, 0xff_ff_ff, 0.9);
        strokeTransformed(g, enemyHullPoints(e.kind), e.x, e.y, e.angle);
      }
      if (e.telegraphUntil <= now) {
        continue;
      }
      const duration = this.enemyObjs.get(e.id)?.telegraphDuration ?? enemyChargeDuration(e);
      const progress = enemyChargeProgress(e.telegraphUntil, now, duration);
      const radius = spec.hitRadius + (e.kind === "warden" ? 12 : 7);
      g.lineStyle(sw, spec.tint, 0.25);
      g.strokeCircle(e.x, e.y, radius);
      if (progress > 0) {
        g.lineStyle(1.5 * sw, spec.tint, 0.85);
        g.beginPath();
        g.arc(e.x, e.y, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
        g.strokePath();
      }
      drawTelegraphAccent(g, e, progress, sw);
    }
  }

  /** SINGULARITY vortices, from the shared pulls entries (every client
   *  agrees). Appends to telegraphGfx, which drawEnemyTelegraphs cleared
   *  this frame. The inward particle ring reuses the pooled converge FX. */
  drawPulls(now: number): void {
    const g = this.layers.telegraphGfx;
    for (const p of this.world.pulls) {
      if (p.until <= now) {
        continue;
      }
      // 1 -> 0
      const frac = Math.max(0, Math.min(1, (p.until - now) / SINGULARITY_PULL_MS));
      // Event horizon shrinks as the collapse completes.
      g.lineStyle(1, SINGULARITY_TINT, 0.3);
      g.strokeCircle(p.x, p.y, 30 + (SINGULARITY_PULL_RANGE - 30) * frac);
      // Three inward-spiraling arc shards.
      const spin = (now / 1000) * 540 * DEG;
      g.lineStyle(1, SINGULARITY_TINT, 0.85);
      for (let i = 0; i < 3; i += 1) {
        const a0 = spin + (Math.PI * 2 * i) / 3;
        g.beginPath();
        g.arc(p.x, p.y, 12 + 70 * frac, a0, a0 + Math.PI / 3);
        g.strokePath();
      }
      if (Math.random() < 0.3) {
        this.fx.converge(p.x, p.y, 2, 150, 200, SINGULARITY_TINT);
      }
    }
  }

  /** BEACON zone (dir-004). CHARGE: dashed hex shrinking 1.5×→1× radius,
   *  dashes rotating. ACTIVE: solid slow-spinning hex + a depleting countdown
   *  arc; CONTESTED strobes gold↔white at 4Hz; controlled drifts gold motes
   *  toward the controller. Gold stays off enemy and player kit. */
  drawBeacon(now: number): void {
    const g = this.layers.beaconGfx;
    g.clear();
    const b = this.world.beacon;
    if (!b || now >= b.diesAt) {
      return;
    }
    if (now < b.activeAt) {
      const p = PhaserMath.Clamp(1 - (b.activeAt - now) / (BEACON_CHARGE_S * 1000), 0, 1);
      const r = BEACON_RADIUS * (1.5 - 0.5 * p);
      g.lineStyle(2, BEACON_TINT, 0.3 + 0.5 * p);
      strokeHexRing(g, b.x, b.y, r, (now / 1000) * 0.6, 0.55);
      g.fillStyle(0xff_ff_ff, 0.4 + 0.5 * p);
      g.fillCircle(b.x, b.y, 3 + 4 * p);
      // qa-014: point-blank the 1.5x ring exceeds the viewport and the dashes
      // read as stray gold segments — a pulsing gold center diamond (the
      // beacon's minimap glyph, writ large) gives close witnesses a focus.
      const pulse = 1 + 0.2 * Math.sin((now / 1000) * Math.PI * 3);
      const dr = (10 + 8 * p) * pulse;
      g.lineStyle(2, BEACON_TINT, 0.45 + 0.45 * p);
      g.beginPath();
      g.moveTo(b.x, b.y - dr);
      g.lineTo(b.x + dr * 0.7, b.y);
      g.lineTo(b.x, b.y + dr);
      g.lineTo(b.x - dr * 0.7, b.y);
      g.closePath();
      g.strokePath();
      return;
    }
    const strobeWhite =
      b.contested && Math.floor((now * BEACON_CONTEST_STROBE_HZ * 2) / 1000) % 2 === 1;
    const tint = strobeWhite ? 0xff_ff_ff : BEACON_TINT;
    g.lineStyle(3, tint, b.contested ? 0.95 : 0.75);
    strokeHexRing(g, b.x, b.y, BEACON_RADIUS, (now / 1000) * 0.12, 1);
    // Countdown arc depletes across ACTIVE — the "hold it to the end" read.
    const frac = PhaserMath.Clamp((b.diesAt - now) / Math.max(1, b.diesAt - b.activeAt), 0, 1);
    g.lineStyle(1, tint, 0.5);
    g.beginPath();
    g.arc(b.x, b.y, BEACON_RADIUS - 26, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    g.strokePath();
    g.fillStyle(0xff_ff_ff, 0.85);
    g.fillCircle(b.x, b.y, 5);
    if (b.controllerId && !b.contested && Math.random() < 0.3) {
      const c = this.host.playerPos(b.controllerId);
      if (c) {
        this.fx.converge(c.x, c.y, 1, BEACON_RADIUS, 500, BEACON_TINT);
      }
    }
  }

  /** The ONE viewport-edge pip pass (dir-004 mandate, shared component):
   *  beacon gold diamond, UFO blinking circle (qa-010), and — while the arena
   *  is young and the screen shows no hostiles — red triangles at the nearest
   *  inbound enemies (qa-007: an empty screen still telegraphs the action). */
  drawEdgePips(now: number): void {
    if (this.link.trailer) {
      // HUD policy: no pips
      this.layers.edgePips.draw(this.scene.cameras.main, NO_PIPS, now);
      return;
    }
    const targets: PipTarget[] = [];
    const b = this.world.beacon;
    if (b && now < b.diesAt) {
      targets.push({ glyph: "diamond", tint: BEACON_TINT, x: b.x, y: b.y });
    }
    const u = this.world.ufo;
    if (u) {
      targets.push({ blink: true, glyph: "circle", tint: 0xff_ff_ff, x: u.x, y: u.y });
    }
    const tSec = Math.max(0, (now - this.world.arenaEpoch) / 1000);
    if (tSec < EARLY_SPAWN_WINDOW_S && this.world.enemies.length > 0) {
      const view = this.scene.cameras.main.worldView;
      const anyVisible = this.world.enemies.some(
        (e) => e.x >= view.x && e.x <= view.right && e.y >= view.y && e.y <= view.bottom,
      );
      if (!anyVisible) {
        const byDist = this.world.enemies.toSorted(
          (a, z) =>
            Math.hypot(a.x - this.pilot.shipX, a.y - this.pilot.shipY) -
            Math.hypot(z.x - this.pilot.shipX, z.y - this.pilot.shipY),
        );
        for (const e of byDist.slice(0, DEBUT_PIP_MAX)) {
          targets.push({ glyph: "triangle", tint: ENEMY_SHOT_TINT, x: e.x, y: e.y });
        }
      }
    }
    this.layers.edgePips.draw(this.scene.cameras.main, targets, now);
  }

  /** Enemy projectiles: red is reserved — nothing friendly is ever red. */
  drawEnemyShots(): void {
    const g = this.layers.enemyShotGfx;
    g.clear();
    if (this.world.enemyShots.length === 0) {
      return;
    }
    g.lineStyle(ENEMY_SHOT_WIDTH, ENEMY_SHOT_TINT, 1);
    for (const s of this.world.enemyShots) {
      const len = Math.hypot(s.vx, s.vy) || 1;
      const ux = s.vx / len;
      const uy = s.vy / len;
      const look = hostileShotLook(len);
      this.fx.battle.beam(
        s.x - ux * ENEMY_SHOT_LEN,
        s.y - uy * ENEMY_SHOT_LEN,
        s.x,
        s.y,
        ENEMY_SHOT_WIDTH,
        ENEMY_SHOT_TINT,
        enemyShotBeamLook(look),
        this.scene.time.now,
      );
      // Original red collision stroke stays exact. Nose marks describe speed
      // bands; every mark travels with its accepted projectile, never an aim.
      g.lineStyle(ENEMY_SHOT_WIDTH, ENEMY_SHOT_TINT, 1);
      g.lineBetween(s.x - ux * ENEMY_SHOT_LEN, s.y - uy * ENEMY_SHOT_LEN, s.x, s.y);
      if (look === "plasma") {
        g.fillStyle(ENEMY_SHOT_TINT, 0.9).fillCircle(s.x, s.y, 2.6);
      } else if (look === "lance" || look === "rail") {
        g.lineStyle(1, 0xff_b4_ba, 0.9);
        g.lineBetween(s.x - ux * 8, s.y - uy * 8, s.x, s.y);
        if (look === "lance") {
          g.lineStyle(1, ENEMY_SHOT_TINT, 0.9);
          g.lineBetween(s.x - ux * 5 - uy * 3, s.y - uy * 5 + ux * 3, s.x, s.y);
          g.lineBetween(s.x - ux * 5 + uy * 3, s.y - uy * 5 - ux * 3, s.x, s.y);
        }
      } else {
        g.lineStyle(1, ENEMY_SHOT_TINT, 0.8);
        g.lineBetween(
          s.x - ux * 4 - uy * 2,
          s.y - uy * 4 + ux * 2,
          s.x - ux * 4 + uy * 2,
          s.y - uy * 4 - ux * 2,
        );
      }
    }
  }

  /** All beams — mine simulated, everyone else's raw from their snapshots. */
  drawBeams(now: number): void {
    const g = this.layers.beamGfx;
    g.clear();
    const { myId } = this.link;
    const draw = (
      sb: SerializedBeam,
      look: WeaponLook = "bolt",
      importance: FxImportance = "common",
    ): void => {
      if (sb.mine && !sb.exploding) {
        this.fx.battle.orbit(sb.hx, sb.hy, 9, sb.tint, 0, true, importance);
        // Remote mine: open diamond at the armed 1Hz blink (arm state isn't
        // on the wire; owners render the 4Hz arming blink locally).
        if (Math.floor(now / 500) % 2 === 0) {
          g.lineStyle(1, sb.tint, 1);
          strokeDiamond(g, sb.hx, sb.hy, 6);
        }
        return;
      }
      if (sb.chain && sb.chain.length >= 2) {
        for (let i = 1; i < sb.chain.length; i += 1) {
          const a = sb.chain[i - 1];
          const b = sb.chain[i];
          if (a && b) {
            this.fx.battle.beam(a.x, a.y, b.x, b.y, 2, sb.tint, "arc", now, importance);
          }
        }
        drawJitteredChain(g, sb.chain, sb.tint, REDUCED_MOTION.matches ? 0 : now);
        return;
      }
      if (sb.glaive) {
        this.fx.battle.orbit(sb.hx, sb.hy, 13, sb.tint, now * 0.012, false, importance);
        // Remote glaive: same spinning triangle the owner sees (clock-driven
        // spin at the local 12 rad/s rate; phase doesn't need to match).
        g.lineStyle(2, sb.tint, 1);
        strokeTransformed(g, GLAIVE_TRI, sb.hx, sb.hy, (now / 1000) * 12);
        return;
      }
      if (sb.orb) {
        // SINGULARITY orb: pulsing filled core + ring (flight and collapse;
        // the collapse vortex itself renders from the shared pulls entry).
        const r = 4 + Math.sin(now / 60) * 1.2;
        this.fx.battle.orbit(sb.hx, sb.hy, r + 7, sb.tint, now * 0.006, false, importance);
        g.fillStyle(sb.tint, 0.55).fillCircle(sb.hx, sb.hy, r * 0.6);
        g.lineStyle(1, sb.tint, 0.95).strokeCircle(sb.hx, sb.hy, r + 2);
        return;
      }
      if (sb.exploding) {
        this.fx.battle.orbit(sb.hx, sb.hy, sb.explosionRadius, sb.tint, 0, true, importance);
        g.lineStyle(1, sb.tint, 1).strokeCircle(sb.hx, sb.hy, sb.explosionRadius);
      } else {
        this.fx.battle.beam(sb.tx, sb.ty, sb.hx, sb.hy, sb.width, sb.tint, look, now, importance);
        g.lineStyle(sb.width, sb.tint, 1).lineBetween(sb.tx, sb.ty, sb.hx, sb.hy);
        g.lineStyle(Math.max(0.65, sb.width * 0.45), 0xff_f9_eb, 0.92).lineBetween(
          sb.tx,
          sb.ty,
          sb.hx,
          sb.hy,
        );
      }
    };
    for (const b of this.hooks.weapons().beams) {
      if (b.vanished) {
        continue;
      }
      if (b.mine && !b.exploding) {
        this.fx.battle.orbit(b.head.x, b.head.y, 9, b.weapon.tint, 0, true, "important");
        // Blink 4Hz while arming, 1Hz once armed (zero particles, §C).
        const armed = now >= b.mine.armAt;
        const on = armed ? Math.floor(now / 500) % 2 === 0 : Math.floor(now / 125) % 2 === 0;
        if (on) {
          g.lineStyle(1, b.weapon.tint, 1);
          strokeDiamond(g, b.head.x, b.head.y, 6);
        }
        continue;
      }
      if (b.glaive) {
        this.fx.battle.orbit(b.head.x, b.head.y, 13, b.weapon.tint, b.spin, false, "important");
        // Spinning open triangle (remotes draw it via the serialized flag).
        g.lineStyle(2, b.weapon.tint, 1);
        strokeTransformed(g, GLAIVE_TRI, b.head.x, b.head.y, b.spin);
        continue;
      }
      draw(serializeBeam(b), weaponLook(b.weapon), "important");
    }
    for (const [id, st] of this.link.peerStates) {
      if (id === myId) {
        continue;
      }
      if (!st || !st.alive) {
        continue;
      }
      for (const sb of st.beams) {
        draw(sb);
      }
    }
    // Transient muzzle strokes (1–2 frames, additive layer).
    const mg = this.layers.muzzleGfx;
    mg.clear();
    this.hooks.weapons().muzzleFlashes = this.hooks
      .weapons()
      .muzzleFlashes.filter((f) => now < f.diesAt);
    for (const f of this.hooks.weapons().muzzleFlashes) {
      if (f.kind === "ring") {
        mg.lineStyle(1, f.tint, 0.9).strokeCircle(f.x, f.y, f.size);
      } else if (f.kind === "line") {
        const cos = Math.cos(f.angle);
        const sin = Math.sin(f.angle);
        mg.lineStyle(3, f.tint, 0.9).lineBetween(f.x, f.y, f.x + cos * f.size, f.y + sin * f.size);
      } else {
        const cos = Math.cos(f.angle);
        const sin = Math.sin(f.angle);
        const h = f.size / 2;
        mg.lineStyle(1, f.tint, 0.95);
        mg.lineBetween(f.x - cos * h, f.y - sin * h, f.x + cos * h, f.y + sin * h);
        mg.lineBetween(f.x + sin * h, f.y - cos * h, f.x - sin * h, f.y + cos * h);
      }
    }
  }

  /** Classic vector death debris: white pixel squares radiating outward. */
  splinterBurst(x: number, y: number, radius: number, count: number, now: number): void {
    for (let i = 0; i < count; i += 1) {
      this.splinters.push({
        angle: Math.random() * Math.PI * 2,
        diesAt: now + SPLINTER_LIFE_MS,
        dist: Math.random() * radius,
        originX: x,
        originY: y,
        // legacy 0..1 px/tick
        speed: Math.random() * 60,
        x,
        y,
      });
    }
  }

  updateSplinters(dt: number, now: number): void {
    this.splinters = this.splinters.filter((s) => {
      s.dist += s.speed * dt;
      s.x = s.originX + Math.cos(s.angle) * s.dist;
      s.y = s.originY + Math.sin(s.angle) * s.dist;
      return now < s.diesAt && inWorld(s.x, s.y, 10);
    });
    const g = this.layers.splinterGfx;
    g.clear();
    g.fillStyle(0xff_ff_ff, 1);
    for (const s of this.splinters) {
      g.fillRect(s.x, s.y, SPLINTER_PX, SPLINTER_PX);
    }
  }

  /** Hull grows + gains detail per level (1..3): L2 adds swept wings + a
   *  cockpit; L3 adds an inner frame, a nose spike + wingtip nodes. */
  /**
   * TRAILER ONLY: how much of its authored size the pilot's own additive glow
   * keeps at this shot's zoom.
   *
   * The hull is a 1px vector stroke ~16 world px across; the glow around it —
   * thruster puffs, muzzle sparks, the shield-impact burst — is the 32px soft
   * "spark" dot on ADD. Both are world-space, so both scale with the camera,
   * but only one of them GROWS: a stroked outline gains no ink when it is
   * magnified, while a soft additive dot gains area (and therefore saturates)
   * as the square of the zoom. At the reel's 1.9-2.5 zooms that inverted the
   * shot — measured on the last capture, the player read as a formless white
   * splat in calm-open, elite-behaviours, chain-reactor and pvp-duel while the
   * ENEMIES, which are pure stroke, read cleanly. The hero was the least
   * legible object in its own tight shots.
   *
   * So inside ?trailer=1 the glow is pinned to the SCREEN size it has at zoom
   * 1 (the framing the game itself ships) and the hull is the only thing the
   * tightening magnifies. Clamped at 1 so it can only ever damp — a shot below
   * zoom 1 would be wider than normal play, which the framing contract forbids
   * anyway. Outside trailer mode this is a constant 1 and every call site is
   * unchanged arithmetic.
   */
  hullGlow(): number {
    if (!this.link.trailer) {
      return 1;
    }
    // Quantised: three scenes lerp their zoom, and the trail's scale lives in
    // the emitter CONFIG — re-parsing it every frame to chase a continuous
    // ramp buys nothing the eye can see.
    return Math.min(1, Math.round(20 / this.scene.cameras.main.zoom) / 20);
  }

  /** Entity stroke width multiplier (qa-011). Zoom is static per viewport, so
   *  hulls built before a resize keep the old weight — the drift is <0.2px
   *  and enemies are short-lived; not worth a rebuild pass. */
  strokeScale(): number {
    return PhaserMath.Clamp(STROKE_BASE / this.scene.cameras.main.zoom, STROKE_BASE, STROKE_MAX);
  }

  private makeUfoGfx(): Phaser.GameObjects.Graphics {
    const g = this.scene.add.graphics().setDepth(6);
    g.lineStyle(this.strokeScale(), 0xff_ff_ff, 1);
    strokeClosed(g, UFO_OUTLINE);
    const { 2: p2, 3: p3, 6: p6, 7: p7 } = UFO_OUTLINE;
    if (p2 && p3 && p6 && p7) {
      g.lineBetween(p2.x, p2.y, p7.x, p7.y);
      g.lineBetween(p3.x, p3.y, p6.x, p6.y);
    }
    return g;
  }

  makeEnemyGfx(kind: EnemyKind): Phaser.GameObjects.Graphics {
    const g = this.scene.add.graphics().setDepth(kind === "dreadnought" ? 8 : 7);
    const sw = this.strokeScale();
    g.lineStyle(enemyStrokeWeight(kind) * sw, ENEMY_SPECS[kind].tint, 1);
    const pts = enemyHullPoints(kind);
    g.fillStyle(0x05_0c_17, 0.9).fillPoints(
      pts.map((p) => new PhaserMath.Vector2(p.x, p.y)),
      true,
    );
    g.fillStyle(ENEMY_SPECS[kind].tint, 0.1).fillPoints(
      pts.map((p) => new PhaserMath.Vector2(p.x, p.y)),
      true,
    );
    strokeClosed(g, pts);
    if (kind === "dreadnought") {
      // Bridge dot + cross-struts so the capital ship reads as a boss.
      g.fillStyle(0xff_ff_ff, 0.9).fillCircle(10, 0, 5);
      g.lineStyle(sw, ENEMY_SPECS.dreadnought.tint, 0.7);
      g.lineBetween(-54, 0, 36, 0);
    }
    if (kind === "splitter") {
      // Inner pentagram: connect every other vertex.
      for (let i = 0; i < 5; i += 1) {
        const a = pts[i];
        const b = pts[(i + 2) % 5];
        if (a && b) {
          g.lineBetween(a.x, a.y, b.x, b.y);
        }
      }
    }
    return g;
  }

  /** Self-describing shells: weapon = hexagon + spokes; shield = double
   *  hexagon + its halo glyph; booster = diamond + its effect glyph. */
  private makeItemGfx(it: ItemState): Phaser.GameObjects.Graphics {
    const g = this.scene.add.graphics().setDepth(4);
    const tint = itemTint(it);
    g.lineStyle(1, tint, 1);
    if (it.kind === "booster") {
      strokeDiamond(g, 0, 0, 9);
      const kind = BOOSTER_KINDS[it.boosterIdx] ?? "repair";
      if (kind === "overdrive") {
        // 3 stacked chevrons.
        for (let i = 0; i < 3; i += 1) {
          const y0 = -3 + i * 3;
          g.beginPath();
          g.moveTo(-3, y0 + 2);
          g.lineTo(0, y0 - 1);
          g.lineTo(3, y0 + 2);
          g.strokePath();
        }
      } else if (kind === "nitro") {
        // Flame triangle.
        g.beginPath();
        g.moveTo(0, -4.5);
        g.lineTo(3, 3);
        g.lineTo(-3, 3);
        g.closePath();
        g.strokePath();
      } else if (kind === "repair") {
        // Plus.
        g.lineBetween(-3, 0, 3, 0);
        g.lineBetween(0, -3, 0, 3);
      } else if (kind === "twin") {
        // Two dots.
        g.fillStyle(tint, 1);
        g.fillCircle(-2.5, 0, 1.2);
        g.fillCircle(2.5, 0, 1.2);
      } else {
        // MAGNET: a U.
        g.beginPath();
        g.arc(0, 0.5, 3, 0, Math.PI);
        g.strokePath();
        g.lineBetween(-3, 0.5, -3, -3.5);
        g.lineBetween(3, 0.5, 3, -3.5);
      }
      return g;
    }
    const outer = hexagonPoints(ITEM_DRAW_RADIUS);
    strokeClosed(g, outer);
    if (it.kind === "weapon") {
      for (let i = 0; i < 3; i += 1) {
        const a = outer[i];
        const b = outer[i + 3];
        if (a && b) {
          g.lineBetween(a.x, a.y, b.x, b.y);
        }
      }
      return g;
    }
    strokeClosed(g, hexagonPoints(6));
    const kind = SHIELD_MOD_KINDS[it.shieldIdx] ?? "overshield";
    // Self-describing glyph: the halo shape the pickup grants.
    if (kind === "overshield") {
      strokeRegularPolygon(g, 0, 0, 3, 6, 0);
    } else if (kind === "reflect") {
      strokeRegularPolygon(g, 0, 0, 3, 3, -Math.PI / 2);
    } else if (kind === "ram") {
      g.beginPath();
      g.arc(0, 0, 3, -Math.PI / 4, Math.PI / 4);
      g.strokePath();
    } else if (kind === "phase") {
      for (let i = 0; i < 4; i += 1) {
        const a0 = (Math.PI * 2 * i) / 4;
        g.beginPath();
        g.arc(0, 0, 3, a0, a0 + ((Math.PI * 2) / 4) * 0.55);
        g.strokePath();
      }
    } else if (kind === "siphon") {
      // Double-ring dot.
      g.strokeCircle(0, 0, 3);
      g.fillStyle(tint, 1);
      g.fillCircle(0, 0, 1);
    } else {
      // AEGIS: 4-dot ring.
      g.fillStyle(tint, 1);
      for (let i = 0; i < 4; i += 1) {
        const a0 = (Math.PI * 2 * i) / 4;
        g.fillCircle(Math.cos(a0) * 3, Math.sin(a0) * 3, 0.9);
      }
    }
    return g;
  }
}
