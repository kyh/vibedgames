import Phaser from "phaser";

import { burstLifetime, burstStage } from "./combat-visuals";
import type { BurstKind, WeaponLook } from "./combat-visuals";
import type { FxImportance } from "./fx-pool";

export const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

const BURST_CAPACITY = 36;
/** Common bursts leave a quarter of the slots for shield/progression/boss beats. */
const COMMON_BURST_LIMIT = BURST_CAPACITY - Math.ceil(BURST_CAPACITY / 4);
const WEAPON_GLOW_BUDGET = 96;
const COMMON_WEAPON_GLOW_BUDGET = WEAPON_GLOW_BUDGET * 0.75;

interface Burst {
  x: number;
  y: number;
  radius: number;
  tint: number;
  angle: number;
  kind: BurstKind;
  importance: FxImportance;
  bornAt: number;
  seed: number;
}

/** Cosmetic light and debris: one bounded slot per blast (all of its stages
 * live in that record), one glow sprite per slot, two shared Graphics layers. */
export class BattleFx {
  private readonly weaponGfx: Phaser.GameObjects.Graphics;
  private readonly blastGfx: Phaser.GameObjects.Graphics;
  private readonly glows: Phaser.GameObjects.Image[] = [];
  private readonly slots: (Burst | null)[] = [];
  private weaponDraws = 0;

  constructor(private readonly scene: Phaser.Scene) {
    // Broad light stays UNDER hulls, live shots and stable warning geometry.
    this.weaponGfx = scene.add.graphics().setDepth(4).setBlendMode(Phaser.BlendModes.ADD);
    this.blastGfx = scene.add.graphics().setDepth(3).setBlendMode(Phaser.BlendModes.ADD);
    for (let i = 0; i < BURST_CAPACITY; i++) {
      // Alpha-blended: Phaser's additive image path leaves rectangular seams
      // where several large translucent sprites overlap.
      this.glows.push(scene.add.image(0, 0, "battle-glow").setDepth(2).setVisible(false));
      this.slots.push(null);
    }
  }

  reset(): void {
    this.slots.fill(null);
    this.weaponDraws = 0;
    for (const glow of this.glows) {
      glow.setVisible(false);
    }
    this.weaponGfx.clear();
    this.blastGfx.clear();
  }

  private visible(x: number, y: number, pad: number): boolean {
    const v = this.scene.cameras.main.worldView;
    return x >= v.x - pad && x <= v.right + pad && y >= v.y - pad && y <= v.bottom + pad;
  }

  burst(
    x: number,
    y: number,
    radius: number,
    tint: number,
    kind: BurstKind,
    angle = 0,
    importance: FxImportance = "common",
  ): void {
    if (!this.visible(x, y, radius + 80)) {
      return;
    }
    let free = -1;
    let live = 0;
    let oldestCommon = -1;
    for (let i = 0; i < this.slots.length; i++) {
      const b = this.slots[i];
      if (!b) {
        if (free < 0) {
          free = i;
        }
        continue;
      }
      live++;
      const oldest = oldestCommon < 0 ? null : this.slots[oldestCommon];
      if (b.importance === "common" && (!oldest || b.bornAt < oldest.bornAt)) {
        oldestCommon = i;
      }
    }
    const limit = importance === "important" ? BURST_CAPACITY : COMMON_BURST_LIMIT;
    const slot = live < limit ? free : oldestCommon;
    if (slot < 0) {
      return;
    }
    this.slots[slot] = {
      angle,
      bornAt: this.scene.time.now,
      importance,
      kind,
      radius,
      seed: Math.random() * Math.PI * 2,
      tint,
      x,
      y,
    };
  }

  beginWeapons(): void {
    this.weaponDraws = 0;
    this.weaponGfx.clear();
  }

  private admitWeaponDraw(importance: FxImportance): boolean {
    const budget = importance === "important" ? WEAPON_GLOW_BUDGET : COMMON_WEAPON_GLOW_BUDGET;
    if (this.weaponDraws >= budget) {
      return false;
    }
    this.weaponDraws++;
    return true;
  }

  /** Draw-only: no replayed bursts when a remote snapshot repeats. */
  beam(
    tx: number,
    ty: number,
    hx: number,
    hy: number,
    width: number,
    tint: number,
    look: WeaponLook,
    now: number,
    importance: FxImportance = "common",
  ): void {
    const length = Math.hypot(hx - tx, hy - ty);
    if (!this.visible((tx + hx) / 2, (ty + hy) / 2, length / 2 + 40)) {
      return;
    }
    if (!this.admitWeaponDraw(importance)) {
      return;
    }
    const g = this.weaponGfx;
    const reduced = REDUCED_MOTION.matches;
    const scale = reduced ? 0.65 : 1;
    const heavy = look === "rail" || look === "heavy" || look === "drill";
    const broad = Math.max(5, width * (heavy ? 6 : 4));
    g.lineStyle(broad, tint, 0.09 * scale).lineBetween(tx, ty, hx, hy);
    g.lineStyle(Math.max(3, width * 2.5), tint, 0.28 * scale).lineBetween(tx, ty, hx, hy);
    const dx = length > 0 ? (hx - tx) / length : 1;
    const dy = length > 0 ? (hy - ty) / length : 0;
    if (look === "missile" || look === "plasma" || look === "rapid") {
      const exhaust = look === "missile" ? 44 : look === "plasma" ? 30 : 16;
      for (let i = 0; i < 3; i++) {
        const tail = exhaust * (1 - i * 0.23);
        g.lineStyle((3 - i) * (look === "plasma" ? 3 : 1.8), tint, (0.09 + i * 0.06) * scale);
        g.lineBetween(hx - dx * tail, hy - dy * tail, hx, hy);
      }
      g.fillStyle(0xff_f3_cf, 0.85 * scale).fillCircle(hx, hy, look === "missile" ? 2.2 : 1.4);
    } else if (look === "rail" || look === "laser") {
      // Parallel filaments stay close to the real lance; no false wider beam.
      const offset = look === "rail" ? 4 : 2.5;
      g.lineStyle(0.8, tint, 0.38 * scale);
      g.lineBetween(tx + dy * offset, ty - dx * offset, hx + dy * offset, hy - dx * offset);
      g.lineBetween(tx - dy * offset, ty + dx * offset, hx - dy * offset, hy + dx * offset);
    } else if (look === "drill") {
      g.lineStyle(1.2, 0xff_dd_aa, 0.7 * scale);
      for (let i = 0; i < 5; i++) {
        const t = i / 5;
        const offset = reduced ? 0 : Math.sin(now * 0.014 + i * 1.5) * 4;
        const x = tx + (hx - tx) * t;
        const y = ty + (hy - ty) * t;
        g.lineBetween(
          x + dy * offset,
          y - dx * offset,
          x + dx * 5 - dy * offset,
          y + dy * 5 + dx * offset,
        );
      }
    }
  }

  orbit(
    x: number,
    y: number,
    radius: number,
    tint: number,
    angle: number,
    nova = false,
    importance: FxImportance = "common",
  ): void {
    if (!this.visible(x, y, radius + 40) || !this.admitWeaponDraw(importance)) {
      return;
    }
    const g = this.weaponGfx;
    const reduced = REDUCED_MOTION.matches;
    const alpha = reduced ? 0.12 : 0.22;
    g.lineStyle(nova ? 8 : 5, tint, alpha).strokeCircle(x, y, radius);
    g.lineStyle(nova ? 3 : 2, tint, alpha * 1.5).strokeCircle(x, y, radius);
    if (!reduced && !nova) {
      for (let i = 0; i < 3; i++) {
        const a = angle + (i * Math.PI * 2) / 3;
        g.lineStyle(1, tint, 0.65);
        g.beginPath();
        g.arc(x, y, radius + 3 + i * 2, a, a + 1.5);
        g.strokePath();
      }
    }
  }

  update(now: number): void {
    this.blastGfx.clear();
    const reduced = REDUCED_MOTION.matches;
    for (let i = 0; i < this.slots.length; i++) {
      const b = this.slots[i];
      const glow = this.glows[i];
      if (!glow) {
        continue;
      }
      if (!b || now - b.bornAt >= burstLifetime(b.kind)) {
        this.slots[i] = null;
        glow.setVisible(false);
        continue;
      }
      const age = Math.max(0, now - b.bornAt);
      const t = age / burstLifetime(b.kind);
      if (b.kind === "fracture") {
        this.drawFracture(b, glow, age, t, reduced);
      } else if (b.kind === "impact" || b.kind === "muzzle") {
        this.drawImpact(b, glow, age, t, reduced);
      } else {
        this.drawBlast(b, glow, age, t, reduced);
      }
    }
  }

  /** Matter breaks into cold facets; ship kills keep the hot cores below. */
  private drawFracture(
    b: Burst,
    glow: Phaser.GameObjects.Image,
    age: number,
    t: number,
    reduced: boolean,
  ): void {
    const g = this.blastGfx;
    const envelope = 1 - t;
    const reach = Math.min(b.radius, 72);
    const heat = burstStage(age, 0, 110);
    glow
      .setPosition(b.x, b.y)
      .setTint(0xae_c6_dd)
      .setAlpha(heat * (reduced ? 0.12 : 0.32))
      .setDisplaySize(reach * 1.2, reach * 1.2)
      .setVisible(heat > 0);
    g.fillStyle(0xe4_ef_f7, heat * (reduced ? 0.25 : 0.65));
    g.fillCircle(b.x, b.y, Math.min(8, reach * 0.13));
    const count = reduced ? 4 : 9;
    for (let i = 0; i < count; i++) {
      const angle = b.seed + (i * Math.PI * 2) / count;
      const distance = reach * (0.2 + t * (reduced ? 0.35 : 1.05));
      const x = b.x + Math.cos(angle) * distance;
      const y = b.y + Math.sin(angle) * distance;
      const size = (2 + (i % 3) * 1.5) * envelope;
      g.lineStyle(1, i % 3 === 0 ? 0xe4_ef_f7 : 0x81_95_ac, envelope * 0.85);
      g.beginPath();
      g.moveTo(x - size, y);
      g.lineTo(x, y - size * 0.7);
      g.lineTo(x + size * 0.6, y + size);
      g.closePath().strokePath();
    }
  }

  private drawImpact(
    b: Burst,
    glow: Phaser.GameObjects.Image,
    age: number,
    t: number,
    reduced: boolean,
  ): void {
    const g = this.blastGfx;
    const flash = burstStage(age, 0, 110);
    const alpha = (flash * 0.95 + Math.max(0, 1 - t) * 0.15) * (reduced ? 0.35 : 1);
    const glowRadius = b.radius * 1.2 * (reduced ? 1 : 0.8 + t * 1.3);
    glow
      .setPosition(b.x, b.y)
      .setTint(b.tint)
      .setAlpha(alpha)
      .setDisplaySize(glowRadius * 2, glowRadius * 2)
      .setVisible(true);
    const envelope = 1 - t;
    const cos = Math.cos(b.angle);
    const sin = Math.sin(b.angle);
    const reach = b.radius * (reduced ? 0.65 : 0.4 + t);
    g.lineStyle(2, 0xff_f5_e5, envelope * (reduced ? 0.35 : 0.9));
    g.lineBetween(
      b.x - cos * reach * 0.3,
      b.y - sin * reach * 0.3,
      b.x + cos * reach,
      b.y + sin * reach,
    );
    g.lineStyle(1, b.tint, envelope * 0.8);
    g.lineBetween(
      b.x - sin * reach * 0.65,
      b.y + cos * reach * 0.65,
      b.x + sin * reach * 0.65,
      b.y - cos * reach * 0.65,
    );
    if (b.kind === "impact") {
      g.lineStyle(1, b.tint, envelope * 0.6).strokeCircle(b.x, b.y, b.radius * (0.2 + t));
    }
  }

  /** Destroyed hulls burn white/amber; red stays reserved for incoming threats.
   * A boss blast runs three staggered sub-stages out of the same record. */
  private drawBlast(
    b: Burst,
    glow: Phaser.GameObjects.Image,
    age: number,
    t: number,
    reduced: boolean,
  ): void {
    const g = this.blastGfx;
    const boss = b.kind === "boss";
    const blastTint = boss || b.kind === "death" ? 0xff_b3_5c : b.tint;
    const flash = burstStage(age, 0, boss ? 520 : 300);
    const alpha = (flash * 0.95 + Math.max(0, 1 - t) * 0.3) * (reduced ? 0.35 : 1);
    const glowRadius = b.radius * 2.4 * (reduced ? 1 : 0.8 + t * 1.3);
    glow
      .setPosition(b.x, b.y)
      .setTint(blastTint)
      .setAlpha(alpha)
      .setDisplaySize(glowRadius * 2, glowRadius * 2)
      .setVisible(true);
    const stages = boss && !reduced ? 3 : 1;
    for (let stage = 0; stage < stages; stage++) {
      const delay = stage * 140;
      const envelope = burstStage(age, delay, boss ? 1000 : 600);
      if (envelope <= 0) {
        continue;
      }
      const p = 1 - envelope;
      const angle = b.seed + stage * 2.4;
      const offset = stage === 0 ? 0 : b.radius * 0.32;
      const x = b.x + Math.cos(angle) * offset;
      const y = b.y + Math.sin(angle) * offset;
      const radius = b.radius * (stage === 0 ? 1 : 0.62) * (reduced ? 0.7 : 0.12 + Math.sqrt(p));
      // A compact white-hot core contracts into an ember while the shock front travels out.
      const heat = burstStage(age, delay, boss ? 520 : 300);
      const core = b.radius * (boss ? 0.19 : 0.25) * (0.55 + heat * 0.45);
      const heatAlpha = heat * (reduced ? 0.2 : 1);
      g.fillStyle(blastTint, heatAlpha * 0.16).fillCircle(x, y, core * 2.4);
      g.fillStyle(blastTint, heatAlpha * 0.38).fillCircle(x, y, core * 1.55);
      g.fillStyle(0xff_e2_a4, heatAlpha * 0.7).fillCircle(x, y, core);
      g.fillStyle(0xff_fc_f1, heatAlpha).fillCircle(x, y, core * 0.58);
      g.lineStyle(12 * envelope, blastTint, envelope * (reduced ? 0.08 : 0.19)).strokeCircle(
        x,
        y,
        radius,
      );
      g.lineStyle(5 * envelope, blastTint, envelope * (reduced ? 0.1 : 0.55)).strokeCircle(
        x,
        y,
        radius,
      );
      g.lineStyle(1.8, 0xff_ed_c7, envelope * 0.95).strokeCircle(x, y, radius);
      if (reduced) {
        continue;
      }
      const count = boss ? 24 : 12;
      for (let i = 0; i < count; i++) {
        const a = b.seed + (i * Math.PI * 2) / count;
        const spread = 0.7 + 0.3 * Math.sin(i * 7.1 + b.seed);
        const distance = b.radius * spread * (0.12 + p * 1.45);
        const tail = Math.max(0, distance - b.radius * 0.3 * envelope);
        g.lineStyle(i % 3 === 0 ? 2.4 : 1.3, i % 3 === 0 ? 0xff_f2_cb : blastTint, envelope * 0.95);
        g.lineBetween(
          x + Math.cos(a) * tail,
          y + Math.sin(a) * tail,
          x + Math.cos(a) * distance,
          y + Math.sin(a) * distance,
        );
      }
    }
  }
}
