// Floating damage numbers — the Dragon Nest read: big, chunky, outlined numerals
// that POP, arc out of the hit, and escalate as a combo builds.
//
// Two things make them feel fluid rather than pasted-on:
//
//  1. They live in the WORLD, not on the screen. Each number is a 3D point with a
//     velocity and gravity, reprojected every frame — so it stays nailed to the
//     body you hit while the camera swings, and its arc is a real ballistic one.
//     (They used to be a fixed screen position + a CSS transition, which slid
//     across the world the moment the camera moved.)
//  2. Scale is a curve, not a constant: a fast overshoot punch-in, a settle, then
//     a shrink-out. The punch is what sells the hit; the settle is what keeps a
//     screen full of numbers legible.
//
// Ownership hierarchy is the caller's job (see fx.ts hitNumber) — this module
// just draws what it's told, loudly.
import type { View } from "./view";

/** How long a combo beat stays alive before the escalation resets (ms). */
const COMBO_WINDOW = 1500;
/** Combo escalation caps out here — past this the numbers would eat the screen. */
const COMBO_MAX = 14;
const POOL = 64;

export type NumberStyle =
  | "crit" // a heavy hit YOU landed — the loudest thing on screen
  | "mine" // any other hit you landed; escalates with the combo
  | "incoming" // damage on YOU
  | "bystander" // someone else's fight, kept quiet
  | "heal"
  | "gold"
  | "banner"; // a word, not a number ("PERFECT") — no combo, no arc

type Num = {
  el: HTMLDivElement;
  live: boolean;
  // world position + velocity (u, u/s) — the arc is simulated, then projected
  x: number;
  y: number; // height
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grav: number;
  life: number;
  maxLife: number;
  size: number;
  spin: number;
  style: NumberStyle;
};

/** Combo colour ramp: cold white → gold → ember → molten. Reads as heat. */
const COMBO_RAMP = ["#fff6e2", "#ffe89a", "#ffc247", "#ff8a2b", "#ff5236"];

function comboColor(step: number): string {
  const i = Math.min(COMBO_RAMP.length - 1, Math.floor((step / COMBO_MAX) * COMBO_RAMP.length));
  return COMBO_RAMP[i] ?? "#fff6e2";
}

/** Punch-in overshoot → settle → shrink-out. `t` is 0..1 of the number's life. */
function scaleCurve(t: number): number {
  if (t < 0.12) {
    // ease-out-back: blows past 1 and snaps back — this is the "hit" of the hit
    const k = t / 0.12;
    const e = 1 - (1 - k) ** 3;
    return e * 1.34;
  }
  if (t < 0.26) {
    const k = (t - 0.12) / 0.14;
    return 1.34 - 0.34 * (1 - (1 - k) ** 2);
  }
  if (t > 0.82) return 1 - 0.35 * ((t - 0.82) / 0.18); // shrink as it fades
  return 1;
}

export class DamageNumbers {
  private layer: HTMLDivElement;
  private pool: Num[] = [];
  private combo = 0;
  private comboLastAt = 0;

  constructor(private readonly view: View) {
    this.layer = document.createElement("div");
    this.layer.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:6;overflow:hidden;" +
      // the numbers are drawn with a heavy stroke; contain the paint work
      "contain:strict;";
    document.body.appendChild(this.layer);
    for (let i = 0; i < POOL; i++) {
      const el = document.createElement("div");
      el.style.cssText =
        "position:absolute;left:0;top:0;will-change:transform,opacity;" +
        "font-family:Impact,'Arial Black',ui-monospace,monospace;font-weight:900;" +
        "letter-spacing:-0.02em;font-variant-numeric:tabular-nums;" +
        "transform-origin:50% 50%;visibility:hidden;";
      this.layer.appendChild(el);
      this.pool.push({
        el,
        live: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        grav: 11,
        life: 0,
        maxLife: 1,
        size: 20,
        spin: 0,
        style: "mine",
      });
    }
  }

  /** A hit YOU landed — advances the combo (and returns the beat it landed on,
   *  so the HUD can show a counter if it wants one). */
  bumpCombo(now: number): number {
    this.combo = now - this.comboLastAt > COMBO_WINDOW ? 1 : this.combo + 1;
    this.comboLastAt = now;
    return this.combo;
  }

  /** The combo beat currently running — 0 once the window lapses. */
  beat(now: number): number {
    return now - this.comboLastAt > COMBO_WINDOW ? 0 : this.combo;
  }

  /** Spawn a number at sim (x, y). `dx`/`dy` is the hit direction — the number
   *  arcs AWAY along it, so a flurry fans out instead of stacking into a blob. */
  spawn(text: string, x: number, y: number, style: NumberStyle, now: number, dx = 0, dy = 0): void {
    const n = this.pool.find((p) => !p.live);
    if (!n) return; // pool exhausted: dropping the 65th number this frame is fine

    const beat = style === "mine" || style === "crit" ? this.beat(now) : 0;
    const grow = 1 + Math.min(beat, COMBO_MAX) * 0.035; // combos physically swell

    let size: number;
    let color: string;
    let stroke: string;
    let glow = "";
    switch (style) {
      case "crit":
        size = 52 * grow;
        color = "#ffd76a";
        stroke = "#5c1400";
        glow = "0 0 18px rgba(255,120,40,.85),";
        break;
      case "mine":
        size = 34 * grow;
        color = comboColor(beat);
        stroke = "#3a1f00";
        break;
      case "heal":
        size = 30;
        color = "#7dffa4";
        stroke = "#06351a";
        break;
      case "gold":
        size = 30;
        color = "#ffd24a";
        stroke = "#4a2f00";
        glow = "0 0 14px rgba(255,200,60,.7),";
        break;
      case "banner":
        size = 40;
        color = "#66ffe0";
        stroke = "#00332c";
        glow = "0 0 20px rgba(90,255,225,.8),";
        break;
      case "incoming":
        size = 30;
        color = "#ff5f52";
        stroke = "#3d0000";
        glow = "0 0 14px rgba(255,60,40,.7),";
        break;
      default:
        size = 20;
        color = "#e6ddc8";
        stroke = "#1c1710";
        break;
    }

    // a crit ERUPTS; a normal hit lobs; a bystander number barely leaves the body;
    // a banner hangs where it was earned and doesn't fly off
    const burst = style === "crit" ? 1.35 : style === "bystander" ? 0.55 : 1;
    const banner = style === "banner";
    const spread = banner ? 0 : (Math.random() - 0.5) * 1.6;
    n.x = x + (banner ? 0 : (Math.random() - 0.5) * 0.35);
    n.z = y + (banner ? 0 : (Math.random() - 0.5) * 0.35);
    n.y = 1.5 + (banner ? 0.4 : Math.random() * 0.35);
    n.vx = (dx * 1.5 + spread) * burst;
    n.vz = (dy * 1.5 + spread) * burst;
    n.vy = banner ? 1.1 : (4.6 + Math.random() * 0.9) * burst; // up hard…
    n.grav = banner ? 0.6 : 11; // …and fall back down, except a banner, which hangs
    n.life = 0;
    n.maxLife = style === "crit" ? 1.15 : style === "bystander" ? 0.7 : banner ? 1.1 : 0.95;
    n.size = size;
    n.spin = banner ? 0 : style === "crit" ? (Math.random() - 0.5) * 14 : (Math.random() - 0.5) * 6;
    n.style = style;
    n.live = true;

    n.el.textContent = text;
    n.el.style.color = color;
    n.el.style.fontSize = `${Math.round(size)}px`;
    n.el.style.webkitTextStroke = `${style === "bystander" ? 2 : 3}px ${stroke}`;
    // paint-order keeps the stroke BEHIND the glyph, so heavy strokes don't eat
    // thin numerals ("1" and "7" go to mush without it)
    n.el.style.paintOrder = "stroke fill";
    n.el.style.textShadow = `${glow}0 3px 0 ${stroke},0 6px 10px rgba(0,0,0,.55)`;
    n.el.style.opacity = "1";
    n.el.style.visibility = "visible";
  }

  /** Advance the arcs and reproject. `dt` is REAL seconds — numbers keep reading
   *  during hit-stop (a frozen number mid-air is what you're meant to be reading). */
  update(dt: number): void {
    for (const n of this.pool) {
      if (!n.live) continue;
      n.life += dt;
      if (n.life >= n.maxLife) {
        n.live = false;
        n.el.style.visibility = "hidden";
        continue;
      }
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      n.z += n.vz * dt;
      n.vy -= n.grav * dt; // gravity: the number tips over and falls, it doesn't drift
      n.vx *= 1 - Math.min(1, 2.2 * dt); // air drag on the lateral fan-out
      n.vz *= 1 - Math.min(1, 2.2 * dt);

      const s = this.view.worldToScreen(n.x, n.z, n.y);
      if (!s.visible) {
        n.el.style.visibility = "hidden";
        continue;
      }
      const t = n.life / n.maxLife;
      const scale = scaleCurve(t);
      const rot = n.spin * t;
      n.el.style.visibility = "visible";
      n.el.style.transform =
        `translate3d(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px,0)` +
        ` translate(-50%,-50%) rotate(${rot.toFixed(1)}deg) scale(${scale.toFixed(3)})`;
      // hold full opacity while it's readable, then go — fading early just makes
      // the number hard to read for its whole life
      n.el.style.opacity = t > 0.72 ? ((1 - t) / 0.28).toFixed(2) : "1";
    }
  }

  dispose(): void {
    this.layer.remove();
  }
}
