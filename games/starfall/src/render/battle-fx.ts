import Phaser from "phaser";

import { admitFx, type FxImportance } from "./fx-priority";
import { burstLifetime, burstStage, type BurstKind, type WeaponLook } from "./combat-visuals";

const BURST_CAPACITY = 36;
const WEAPON_GLOW_BUDGET = 96;

type Burst = {
  x: number;
  y: number;
  radius: number;
  tint: number;
  angle: number;
  kind: BurstKind;
  importance: FxImportance;
  bornAt: number;
  seed: number;
  glow: Phaser.GameObjects.Image;
};

/** Cosmetic light and debris only. All stages belong to one bounded record;
 * there are no delayed timers, hidden emitters or children per explosion. */
export class BattleFx {
  private readonly weaponGfx: Phaser.GameObjects.Graphics;
  private readonly blastGfx: Phaser.GameObjects.Graphics;
  private readonly glows: Phaser.GameObjects.Image[] = [];
  private bursts: Burst[] = [];
  private weaponDraws = 0;
  private readonly motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  constructor(private readonly scene: Phaser.Scene) {
    // Broad light stays UNDER hulls, live shots and stable warning geometry.
    this.weaponGfx = scene.add.graphics().setDepth(4).setBlendMode(Phaser.BlendModes.ADD);
    this.blastGfx = scene.add.graphics().setDepth(3).setBlendMode(Phaser.BlendModes.ADD);
    for (let i = 0; i < BURST_CAPACITY; i++) {
      // Alpha blend the broad sprite falloff. Phaser's additive image path
      // leaves rectangular seams where several large translucent bounds overlap.
      this.glows.push(scene.add.image(0, 0, "battle-glow").setDepth(2).setVisible(false));
    }
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.bursts.length = 0;
      this.glows.length = 0;
    });
  }

  reset(): void {
    this.bursts.length = 0;
    this.weaponDraws = 0;
    for (const glow of this.glows) glow.setVisible(false);
    this.weaponGfx.clear();
    this.blastGfx.clear();
  }

  counts() {
    return {
      bursts: this.bursts.length,
      capacity: BURST_CAPACITY,
      important: this.bursts.filter((b) => b.importance === "important").length,
      weaponGlows: this.weaponDraws,
    };
  }

  reducedMotion(): boolean {
    return this.motion.matches;
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
    if (!this.visible(x, y, radius + 80) || !admitFx(this.bursts, BURST_CAPACITY, importance))
      return;
    const glow = this.glows.find((node) => !this.bursts.some((burst) => burst.glow === node));
    if (!glow) return;
    this.bursts.push({
      x,
      y,
      radius,
      tint,
      kind,
      angle,
      importance,
      bornAt: this.scene.time.now,
      seed: Math.random() * Math.PI * 2,
      glow,
    });
  }

  beginWeapons(): void {
    this.weaponDraws = 0;
    this.weaponGfx.clear();
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
    const budget = importance === "important" ? WEAPON_GLOW_BUDGET : WEAPON_GLOW_BUDGET * 0.75;
    if (this.weaponDraws >= budget) return;
    const length = Math.hypot(hx - tx, hy - ty);
    if (!this.visible((tx + hx) / 2, (ty + hy) / 2, length / 2 + 40)) return;
    this.weaponDraws++;
    const g = this.weaponGfx;
    const scale = this.motion.matches ? 0.65 : 1;
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
      g.fillStyle(0xfff3cf, 0.85 * scale).fillCircle(hx, hy, look === "missile" ? 2.2 : 1.4);
    } else if (look === "rail" || look === "laser") {
      // Parallel filaments stay close to the real lance; no false wider beam.
      const offset = look === "rail" ? 4 : 2.5;
      g.lineStyle(0.8, tint, 0.38 * scale);
      g.lineBetween(tx + dy * offset, ty - dx * offset, hx + dy * offset, hy - dx * offset);
      g.lineBetween(tx - dy * offset, ty + dx * offset, hx - dy * offset, hy + dx * offset);
    } else if (look === "drill") {
      g.lineStyle(1.2, 0xffddaa, 0.7 * scale);
      for (let i = 0; i < 5; i++) {
        const t = i / 5;
        const offset = this.motion.matches ? 0 : Math.sin(now * 0.014 + i * 1.5) * 4;
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
    const budget = importance === "important" ? WEAPON_GLOW_BUDGET : WEAPON_GLOW_BUDGET * 0.75;
    if (this.weaponDraws >= budget || !this.visible(x, y, radius + 40)) return;
    this.weaponDraws++;
    const g = this.weaponGfx;
    const alpha = this.motion.matches ? 0.12 : 0.22;
    g.lineStyle(nova ? 8 : 5, tint, alpha).strokeCircle(x, y, radius);
    g.lineStyle(nova ? 3 : 2, tint, alpha * 1.5).strokeCircle(x, y, radius);
    if (!this.motion.matches && !nova) {
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
    for (const glow of this.glows) glow.setVisible(false);
    this.bursts = this.bursts.filter((b) => now - b.bornAt < burstLifetime(b.kind));
    const reduced = this.motion.matches;
    for (const b of this.bursts) {
      const age = Math.max(0, now - b.bornAt);
      const life = burstLifetime(b.kind);
      const t = age / life;
      const boss = b.kind === "boss";
      const impact = b.kind === "impact" || b.kind === "muzzle";
      if (b.kind === "fracture") {
        // Matter breaks into cold facets. Ship kills retain the hot cores and
        // broad shock fronts, even when the destroyed rock was much larger.
        const g = this.blastGfx;
        const envelope = 1 - t;
        const reach = Math.min(b.radius, 72);
        const heat = burstStage(age, 0, 110);
        b.glow
          .setPosition(b.x, b.y)
          .setTint(0xaec6dd)
          .setAlpha(heat * (reduced ? 0.12 : 0.32))
          .setDisplaySize(reach * 1.2, reach * 1.2)
          .setVisible(heat > 0);
        g.fillStyle(0xe4eff7, heat * (reduced ? 0.25 : 0.65));
        g.fillCircle(b.x, b.y, Math.min(8, reach * 0.13));
        const count = reduced ? 4 : 9;
        for (let i = 0; i < count; i++) {
          const angle = b.seed + (i * Math.PI * 2) / count;
          const distance = reach * (0.2 + t * (reduced ? 0.35 : 1.05));
          const x = b.x + Math.cos(angle) * distance;
          const y = b.y + Math.sin(angle) * distance;
          const size = (2 + (i % 3) * 1.5) * envelope;
          g.lineStyle(1, i % 3 === 0 ? 0xe4eff7 : 0x8195ac, envelope * 0.85);
          g.beginPath();
          g.moveTo(x - size, y);
          g.lineTo(x, y - size * 0.7);
          g.lineTo(x + size * 0.6, y + size);
          g.closePath().strokePath();
        }
        continue;
      }
      // Destroyed hulls burn white/amber; red remains an incoming threat.
      const blastTint = boss || b.kind === "death" ? 0xffb35c : b.tint;
      const flash = burstStage(age, 0, impact ? 110 : boss ? 520 : 300);
      const afterglow = Math.max(0, 1 - t) * (impact ? 0.15 : 0.3);
      const alpha = (flash * 0.95 + afterglow) * (reduced ? 0.35 : 1);
      const glowRadius = b.radius * (impact ? 1.2 : 2.4) * (reduced ? 1 : 0.8 + t * 1.3);
      b.glow
        .setPosition(b.x, b.y)
        .setTint(impact ? b.tint : blastTint)
        .setAlpha(alpha)
        .setDisplaySize(glowRadius * 2, glowRadius * 2)
        .setVisible(true);
      const g = this.blastGfx;
      if (impact) {
        const envelope = 1 - t;
        const cos = Math.cos(b.angle),
          sin = Math.sin(b.angle);
        const reach = b.radius * (reduced ? 0.65 : 0.4 + t);
        g.lineStyle(2, 0xfff5e5, envelope * (reduced ? 0.35 : 0.9));
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
        if (b.kind === "impact")
          g.lineStyle(1, b.tint, envelope * 0.6).strokeCircle(b.x, b.y, b.radius * (0.2 + t));
        continue;
      }
      // An admitted blast owns these stages until it expires. Every stage
      // retains its original importance and consumes no extra pool entries.
      const stages = boss && !reduced ? 3 : 1;
      for (let stage = 0; stage < stages; stage++) {
        const delay = stage * 140;
        const envelope = burstStage(age, delay, boss ? 1000 : 600);
        if (envelope <= 0) continue;
        const p = 1 - envelope;
        const angle = b.seed + stage * 2.4;
        const offset = stage === 0 ? 0 : b.radius * 0.32;
        const x = b.x + Math.cos(angle) * offset;
        const y = b.y + Math.sin(angle) * offset;
        const radius = b.radius * (stage === 0 ? 1 : 0.62) * (reduced ? 0.7 : 0.12 + Math.sqrt(p));
        // A compact, white-hot core gives destruction an unmistakable beat.
        // It contracts into an ember while the shock front travels outward.
        const heat = burstStage(age, delay, boss ? 520 : 300);
        const core = b.radius * (boss ? 0.19 : 0.25) * (0.55 + heat * 0.45);
        const heatAlpha = heat * (reduced ? 0.2 : 1);
        g.fillStyle(blastTint, heatAlpha * 0.16).fillCircle(x, y, core * 2.4);
        g.fillStyle(blastTint, heatAlpha * 0.38).fillCircle(x, y, core * 1.55);
        g.fillStyle(0xffe2a4, heatAlpha * 0.7).fillCircle(x, y, core);
        g.fillStyle(0xfffcf1, heatAlpha).fillCircle(x, y, core * 0.58);
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
        g.lineStyle(1.8, 0xffedc7, envelope * 0.95).strokeCircle(x, y, radius);
        if (!reduced) {
          const count = boss ? 24 : 12;
          for (let i = 0; i < count; i++) {
            const a = b.seed + (i * Math.PI * 2) / count;
            const spread = 0.7 + 0.3 * Math.sin(i * 7.1 + b.seed);
            const distance = b.radius * spread * (0.12 + p * 1.45);
            const tail = Math.max(0, distance - b.radius * 0.3 * envelope);
            g.lineStyle(
              i % 3 === 0 ? 2.4 : 1.3,
              i % 3 === 0 ? 0xfff2cb : blastTint,
              envelope * 0.95,
            );
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
  }
}
