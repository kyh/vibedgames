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
type Fleet = { x: number; y: number; facing: number; tint: number };

/** Far-away light, never an arena entity. A separate cosmetic random stream,
 * muted non-red palette and slow parallax keep it distinct from live threats. */
export class BattleBackdrop {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly haze: Phaser.GameObjects.Image[];
  private salvos: Salvo[] = [];
  private flashes: Flash[] = [];
  private fleets: Fleet[] = [];
  private viewport = "";
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
    const release = () => {
      scene.events.off(Phaser.Scenes.Events.SHUTDOWN, release);
      scene.events.off(Phaser.Scenes.Events.DESTROY, release);
      this.salvos.length = 0;
      this.flashes.length = 0;
      this.fleets.length = 0;
      this.haze.length = 0;
    };
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, release);
    scene.events.once(Phaser.Scenes.Events.DESTROY, release);
  }

  reset(): void {
    this.salvos.length = 0;
    this.flashes.length = 0;
    this.fleets.length = 0;
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
    const viewport = `${c.width}:${c.height}:${c.zoom}`;
    if (this.fleets.length === 0 || this.viewport !== viewport) {
      this.viewport = viewport;
      this.fleets = [
        { x: cx - w * 0.34, y: cy - h * 0.3, facing: 1, tint: 0x68a8bd },
        { x: cx + w * 0.25, y: cy + h * 0.33, facing: -1, tint: 0x9c8756 },
        { x: cx + w * 0.34, y: cy - h * 0.3, facing: -1, tint: 0x9c8756 },
      ];
      this.salvos.length = 0;
      this.flashes.length = 0;
    }
    for (let i = 0; i < this.haze.length; i++) {
      const node = this.haze[i];
      if (!node) continue;
      node
        .setPosition(cx + Math.cos(i * 2.4) * w * 0.3, cy + Math.sin(i * 2.4) * h * 0.25)
        .setDisplaySize(w * 1.3, h * 1.2)
        .setAlpha(frame.beat === "crest" ? 0.2 : frame.beat === "build" ? 0.17 : 0.14);
    }
    this.gfx.clear();
    // Anchors live in the far plane; camera motion no longer cancels their
    // parallax. Recycle only outside the visible margin, with three hulls total.
    for (const fleet of this.fleets) {
      const pad = 140;
      const spanX = w + pad * 2;
      const spanY = h + pad * 2;
      const left = cx - w / 2 - pad;
      const top = cy - h / 2 - pad;
      fleet.x = left + ((((fleet.x - left) % spanX) + spanX) % spanX);
      fleet.y = top + ((((fleet.y - top) % spanY) + spanY) % spanY);
      const alpha = frame.lockedWarning ? 0.12 : frame.beat === "crest" ? 0.42 : 0.3;
      this.drawFleet(fleet, alpha * this.centerFade(fleet.x, fleet.y, cx, cy, w, h));
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
          radius: 14 + this.random() * 8,
          tint: s.tint,
        });
      return false;
    });
    if (frame.beat === "aftermath") {
      this.nextSalvoAt = now + 900;
    } else if (frame.accent || now >= this.nextSalvoAt) {
      const interval = frame.beat === "quiet" ? 3200 : frame.beat === "build" ? 1400 : 800;
      this.nextSalvoAt = now + interval + this.random() * interval * 0.3;
      this.launchFormation(now, frame);
    }
    const g = this.gfx;
    for (const s of this.salvos) {
      const age = (now - s.bornAt) / 1000;
      const x = s.x + Math.cos(s.angle) * s.speed * age;
      const y = s.y + Math.sin(s.angle) * s.speed * age;
      const strength = s.strength * this.centerFade(x, y, cx, cy, w, h);
      g.lineStyle(4, s.tint, 0.1 * strength).lineBetween(
        x - Math.cos(s.angle) * 22,
        y - Math.sin(s.angle) * 22,
        x,
        y,
      );
      g.lineStyle(1, s.tint, 0.58 * strength).lineBetween(
        x - Math.cos(s.angle) * 18,
        y - Math.sin(s.angle) * 18,
        x,
        y,
      );
      // A tiny far hull trails its salvo; no health bar, target or attack shape.
      g.lineStyle(1, s.tint, 0.24 * strength);
      const bx = s.x - Math.cos(s.angle) * 35,
        by = s.y - Math.sin(s.angle) * 35;
      g.lineBetween(bx, by, bx - Math.cos(s.angle + 0.6) * 12, by - Math.sin(s.angle + 0.6) * 12);
      g.lineBetween(bx, by, bx - Math.cos(s.angle - 0.6) * 12, by - Math.sin(s.angle - 0.6) * 12);
    }
    this.flashes = this.flashes.filter((f) => now - f.bornAt < 650);
    for (const f of this.flashes) {
      const p = (now - f.bornAt) / 650;
      const fade = this.centerFade(f.x, f.y, cx, cy, w, h);
      g.lineStyle(1, f.tint, (1 - p) * 0.55 * fade).strokeCircle(f.x, f.y, f.radius * p);
      g.fillStyle(0xc8dce6, (1 - p) * 0.5 * fade).fillCircle(f.x, f.y, 3);
    }
  }

  private launchFormation(now: number, frame: BattleBeatFrame): void {
    const broadside = frame.beat === "crest" || frame.accent !== null;
    const count = broadside ? 6 : frame.beat === "quiet" ? 2 : 3;
    if (this.salvos.length + count > SALVO_CAP) return;
    const reverse = this.formation++ % 2 !== 0;
    for (let i = 0; i < count; i++) {
      // A visible exchange originates on the hulls and resolves at the far
      // opponent. These are decorative broadside ports, never real emitters.
      const swap = broadside && i >= 3 ? !reverse : reverse;
      const from = this.fleets[swap ? 2 : 0];
      const to = this.fleets[swap ? 0 : 2];
      if (!from || !to) return;
      const row = broadside ? i % 3 : i;
      const x = from.x + from.facing * 44;
      const y = from.y - 5 + row * 5;
      const dx = to.x - x;
      const dy = to.y - y;
      this.salvos.push({
        x,
        y,
        angle: Math.atan2(dy, dx),
        bornAt: now,
        tint: from.tint,
        speed: Math.hypot(dx, dy) / 1.25,
        strength: broadside ? 1.15 : frame.beat === "quiet" ? 0.6 : 0.9,
      });
    }
  }

  private drawFleet(fleet: Fleet, alpha: number): void {
    const { x, y, facing, tint } = fleet;
    const g = this.gfx;
    // Long broken keels and recessed engines distinguish the far capital
    // ships from the live triangular fighters without changing their palette.
    g.fillStyle(0x102330, alpha * 0.32);
    g.beginPath();
    g.moveTo(x + facing * 52, y);
    g.lineTo(x + facing * 26, y - 8);
    g.lineTo(x - facing * 34, y - 12);
    g.lineTo(x - facing * 48, y);
    g.lineTo(x - facing * 34, y + 12);
    g.lineTo(x + facing * 26, y + 8);
    g.closePath().fillPath();
    g.lineStyle(1, tint, alpha).strokePath();
    g.lineBetween(x + facing * 35, y, x - facing * 31, y);
    g.lineBetween(x + facing * 15, y - 3, x - facing * 28, y - 7);
    g.lineBetween(x + facing * 15, y + 3, x - facing * 28, y + 7);
    g.lineStyle(2, tint, alpha * 0.8);
    g.lineBetween(x - facing * 38, y - 5, x - facing * 44, y - 5);
    g.lineBetween(x - facing * 38, y + 5, x - facing * 44, y + 5);
  }

  private centerFade(x: number, y: number, cx: number, cy: number, w: number, h: number): number {
    const distance = Math.hypot((x - cx) / (w * 0.22), (y - cy) / (h * 0.2));
    return Math.min(1, Math.max(0.12, distance - 0.5));
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
