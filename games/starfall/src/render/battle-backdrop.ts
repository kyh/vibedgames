import Phaser from "phaser";
import type { BattleBeatFrame } from "./battle-beat";

const SCROLL = 0.22;
const SALVO_CAP = 14;
const FLASH_CAP = 5;
type Salvo = {
  x: number;
  y: number;
  angle: number;
  bornAt: number;
  tint: number;
  speed: number;
  strength: number;
};
type Flash = { x: number; y: number; bornAt: number; radius: number; tint: number };

/** Far-away light, never an arena entity. A separate cosmetic random stream,
 * muted non-red palette and slow parallax keep it distinct from live threats. */
export class BattleBackdrop {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly haze: Phaser.GameObjects.Image[];
  private salvos: Salvo[] = [];
  private flashes: Flash[] = [];
  private nextSalvoAt = 0;
  private previousTime: number | null = null;
  private randomState = 0x514ac29d;
  private formation = 0;
  private readonly motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  constructor(private readonly scene: Phaser.Scene) {
    this.gfx = scene.add
      .graphics()
      .setDepth(-2)
      .setScrollFactor(SCROLL)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.haze = [0x244d86, 0x352765, 0x285260].map((tint) =>
      scene.add
        .image(0, 0, "battle-glow")
        .setDepth(-4)
        .setScrollFactor(SCROLL)
        .setTint(tint)
        .setAlpha(0.18),
    );
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.salvos.length = 0;
      this.flashes.length = 0;
      this.haze.length = 0;
    });
  }

  reset(): void {
    this.salvos.length = 0;
    this.flashes.length = 0;
    this.nextSalvoAt = this.scene.time.now + 600;
    this.previousTime = null;
    this.randomState = 0x514ac29d;
    this.formation = 0;
    this.gfx.clear();
  }

  counts() {
    return { salvos: this.salvos.length, flashes: this.flashes.length };
  }

  update(now: number, frame: BattleBeatFrame): void {
    const previous = this.previousTime;
    if (frame.reset || (previous !== null && (now < previous || now - previous > 1500)))
      this.reset();
    this.previousTime = now;
    const c = this.scene.cameras.main;
    const cx = c.scrollX * SCROLL + c.width / 2;
    const cy = c.scrollY * SCROLL + c.height / 2;
    const w = c.width / c.zoom;
    const h = c.height / c.zoom;
    for (let i = 0; i < this.haze.length; i++) {
      const node = this.haze[i];
      if (!node) continue;
      node
        .setPosition(cx + Math.cos(i * 2.4) * w * 0.3, cy + Math.sin(i * 2.4) * h * 0.25)
        .setDisplaySize(w * 1.3, h * 1.2)
        .setAlpha(frame.beat === "crest" ? 0.2 : frame.beat === "build" ? 0.17 : 0.14);
    }
    this.gfx.clear();
    // Quiet still has distant ships and haze. These are silhouettes, never
    // hostile-red hulls, target marks or warning circles.
    for (let i = 0; i < 3; i++) {
      const x = cx + (i - 1) * w * 0.33;
      const y = cy + (i % 2 === 0 ? -1 : 1) * h * 0.34;
      const facing = i % 2 === 0 ? 1 : -1;
      this.gfx.lineStyle(1, i === 1 ? 0x9c8756 : 0x68a8bd, 0.16);
      this.gfx.lineBetween(x + facing * 20, y, x - facing * 17, y - 6);
      this.gfx.lineBetween(x + facing * 20, y, x - facing * 17, y + 6);
      this.gfx.lineBetween(x - facing * 8, y - 4, x - facing * 23, y);
    }
    if (this.motion.matches || !frame.active || frame.lockedWarning) {
      this.salvos.length = 0;
      this.flashes.length = 0;
      this.nextSalvoAt = now + 700;
      return;
    }
    this.salvos = this.salvos.filter((s) => {
      if (now - s.bornAt < 1250) return true;
      // A late frame drops expired stages, rather than producing a catch-up
      // flash. A resolving encounter leaves its foreground detonation alone.
      if (now - s.bornAt < 1500 && frame.beat !== "aftermath" && this.flashes.length < FLASH_CAP)
        this.flashes.push({
          x: s.x + Math.cos(s.angle) * s.speed * 1.25,
          y: s.y + Math.sin(s.angle) * s.speed * 1.25,
          bornAt: s.bornAt + 1250,
          radius: 10 + this.random() * 8,
          tint: s.tint,
        });
      return false;
    });
    if (frame.beat === "aftermath") {
      this.nextSalvoAt = now + 900;
    } else if (frame.accent || now >= this.nextSalvoAt) {
      const interval = frame.beat === "quiet" ? 3200 : frame.beat === "build" ? 1400 : 800;
      this.nextSalvoAt = now + interval + this.random() * interval * 0.3;
      this.launchFormation(now, frame, cx, cy, w, h);
    }
    const g = this.gfx;
    for (const s of this.salvos) {
      const age = (now - s.bornAt) / 1000;
      const x = s.x + Math.cos(s.angle) * s.speed * age;
      const y = s.y + Math.sin(s.angle) * s.speed * age;
      g.lineStyle(4, s.tint, 0.08 * s.strength).lineBetween(
        x - Math.cos(s.angle) * 22,
        y - Math.sin(s.angle) * 22,
        x,
        y,
      );
      g.lineStyle(1, s.tint, 0.42 * s.strength).lineBetween(
        x - Math.cos(s.angle) * 12,
        y - Math.sin(s.angle) * 12,
        x,
        y,
      );
      // A tiny far hull trails its salvo; no health bar, target or attack shape.
      g.lineStyle(1, s.tint, 0.28 * s.strength);
      const bx = s.x - Math.cos(s.angle) * 35,
        by = s.y - Math.sin(s.angle) * 35;
      g.lineBetween(bx, by, bx - Math.cos(s.angle + 0.6) * 12, by - Math.sin(s.angle + 0.6) * 12);
      g.lineBetween(bx, by, bx - Math.cos(s.angle - 0.6) * 12, by - Math.sin(s.angle - 0.6) * 12);
    }
    this.flashes = this.flashes.filter((f) => now - f.bornAt < 650);
    for (const f of this.flashes) {
      const p = (now - f.bornAt) / 650;
      g.lineStyle(1, f.tint, (1 - p) * 0.4).strokeCircle(f.x, f.y, f.radius * p);
      g.fillStyle(f.tint, (1 - p) * 0.28).fillCircle(f.x, f.y, 4);
    }
  }

  private launchFormation(
    now: number,
    frame: BattleBeatFrame,
    cx: number,
    cy: number,
    w: number,
    h: number,
  ): void {
    const broadside = frame.beat === "crest" || frame.accent !== null;
    const count = broadside ? 6 : frame.beat === "quiet" ? 2 : 3;
    if (this.salvos.length + count > SALVO_CAP) return;
    const direction = this.formation++ % 2 === 0 ? 1 : -1;
    const bank = frame.accent === "phase" ? -1 : 1;
    for (let i = 0; i < count; i++) {
      // Opposing three-ship broadsides bracket the playfield at a crest.
      // Quieter beats send one small wing across a distant upper/lower lane.
      const side = broadside && i >= 3 ? -direction : direction;
      const lane = broadside && i >= 3 ? 1 : -1;
      const row = broadside ? i % 3 : i;
      this.salvos.push({
        x: cx - side * w * 0.24 - side * row * 22,
        y: cy + lane * bank * h * 0.28 + row * 12,
        angle: (side === 1 ? 0 : Math.PI) + lane * bank * 0.12,
        bornAt: now,
        tint: side === 1 ? 0x68a8bd : 0x9c8756,
        speed: (broadside ? 170 : 115) + row * 8,
        strength: broadside ? 1.15 : frame.beat === "quiet" ? 0.6 : 0.9,
      });
    }
  }

  private random(): number {
    // Private cosmetic stream: formations cannot consume gameplay or SFX RNG.
    let x = this.randomState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.randomState = x >>> 0;
    return this.randomState / 0x1_0000_0000;
  }
}
