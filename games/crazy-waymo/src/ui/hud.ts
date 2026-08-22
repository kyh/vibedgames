import { TIER_COLORS, tierColor } from "../fx/tier";

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

// ---- Drift rails (tuning knobs) -------------------------------------------
// Rail fill is LADDER position, (tier + charge) / steps — never within-tier
// charge, which resets to 0 at the exact moment of earning. A tier boundary
// is a step; only opacity is eased.
const RAIL_STEPS = 3;
const RAIL_ON_BASE = 0.44;
const RAIL_ON_FILL = 0.16;
const RAIL_ON_TIER = 0.13;
const RAIL_RISE_LAMBDA = 22;
const RAIL_FALL_LAMBDA = 8;
/** The earning (next-tier) rail cap per held tier; index 2 is the violet
 *  release preview — never a holdable state, matching fx/tier.ts doctrine. */
const RAIL_NEXT_COLOR = {
  0: TIER_COLORS[0],
  1: TIER_COLORS[1],
  2: TIER_COLORS[2],
} satisfies Record<0 | 1 | 2, string>;

// ---- Off-screen destination arrow -----------------------------------------
/** HUD boxes the arrow must stay clear of, top band and bottom band alike. */
const ARROW_OBSTACLES = [
  "timer",
  "score",
  "combo-meter",
  "district",
  "area",
  "fare-card",
  "t-chat",
  "speed",
  "minimap",
  "t-brake",
  "t-boost",
] as const;
/** #dest-arrow is a 64px box positioned by its top-left corner. */
const ARROW_HALF = 32;
const ARROW_GUTTER = 8;
/** Floor on the vertical band, for viewports too short to fit both HUD bands
 *  and a gap. Overlapping something beats having nowhere to draw. */
const ARROW_MIN_BAND = 140;
/** Layout reads are cheap at this rate and the boxes only move on resize,
 *  orientation change, or a HUD card appearing. */
const ARROW_BOX_MS = 500;

// ---- Speedometer paint (warm-ink cluster; every value is a tuning knob) ---
const DIAL_W = 120;
const DIAL_H = 84;
const DIAL_CX = 60;
const DIAL_CY = 42;
const DIAL_R = 29;
const DIAL_FACE_R = 38;
// 240° sweep, symmetric about 12 o'clock, opening at the bottom (the digital
// readout sits in the gap).
const DIAL_A0 = Math.PI * (5 / 6);
const DIAL_SWEEP = Math.PI * (4 / 3);
const DIAL_MAX_MPH = 100;
const REDLINE_FRAC = 0.85;
const CHAN_W = 7; // channel groove width
const CHAN_FILL_FRAC = 0.78; // fill/scale width inside the groove
const CHAN_INK = "rgba(18, 10, 4, 0.64)";
// ONE flat low value — a low-alpha ramp behind the fill reads as a fault.
const CHAN_SCALE = "rgba(255, 232, 202, 0.15)";
const DIAL_FILL_LO = "#fff4e2";
const DIAL_FILL_MID = "#ffcf6b";
const DIAL_FILL_HI = "#e0453f";
const DIAL_FILL_GLOW = "rgba(255, 190, 110, 0.34)";
const REDLINE_INK = "rgba(224, 69, 63, 0.55)";
const REDLINE_OVER = "rgba(255, 150, 96, 0.92)";
const TICK_OUT_R = 24;
const TICK_MAJOR_IN_R = 17.5;
const TICK_MINOR_IN_R = 21;
const TICK_INK = "rgba(18, 10, 4, 0.82)";
const TICK_CREAM_MAJOR = "rgba(255, 244, 226, 0.72)";
const TICK_CREAM_MINOR = "rgba(255, 244, 226, 0.42)";
const NEEDLE_TIP_R = DIAL_R - CHAN_W * 0.62;
const NEEDLE_TAIL_R = DIAL_R * 0.3;
const NEEDLE_HALF_W = DIAL_R * 0.078;
const HUB_R = 4.5;
const PAPER = "#fff4e2";
const DIAL_INK = "rgba(18, 10, 4, 0.92)";
const DIAL_FONT = '"Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", sans-serif';

function sub(selector: string): HTMLElement {
  const node = document.querySelector(selector);
  if (!(node instanceof HTMLElement)) throw new Error(`missing ${selector}`);
  return node;
}

/** The pre-bundle bar creep, published by the inline script in index.html. */
type BootBar = { stop(): void; at(): number };

function boot(): BootBar | null {
  // SAFETY: __bootBar is published only by the inline script in index.html,
  // which sets it to { stop, at }; both members are verified callable below.
  const c = (globalThis as { __bootBar?: Partial<BootBar> }).__bootBar;
  if (!c || !(c.stop instanceof Function) || !(c.at instanceof Function)) return null;
  // SAFETY: stop and at were just verified callable, so c is a working BootBar.
  return c as BootBar;
}

/** One keycap group: the keys that do it, and what they do. */
export type ControlHint = { readonly keys: readonly string[]; readonly label: string };

/** One input method's row: the pause overlay's KEYS/TOUCH/PAD tag + its chips. */
export type ControlHintGroup = { readonly tag: string; readonly hints: readonly ControlHint[] };

export type BannerSpec = {
  readonly title: string;
  readonly sub: string;
  readonly stats?: string;
  /** Control legend. Landing screen only — never shown over live gameplay. */
  readonly controls?: readonly ControlHintGroup[];
  readonly cta: string;
};

export type ReceiptLine = { readonly text: string; readonly color: string };

export class Hud {
  private timer = el("timer");
  private timerVal = el("timer").querySelector<HTMLElement>(".value");
  private timeBonus = el("time-bonus");
  private district = el("district");
  private area = el("area");
  private scoreVal = el("score").querySelector<HTMLElement>(".value");
  private scorePill = el("score");
  private scoreLabel = el("score").querySelector<HTMLElement>(".label");
  private boostPill = el("speed"); // boost meter lives inside the MPH card
  private boostFill = el("boost-fill");
  private dial = el("dash-dial");
  private dialCtx: CanvasRenderingContext2D | null = null;
  // Dial gradients cached at first draw — they never change frame to frame.
  private dialFaceGrad: CanvasGradient | null = null;
  private dialValueGrad: CanvasGradient | null = null;
  private dialHubGrad: CanvasGradient | null = null;
  private railL = el("rail-l");
  private railR = el("rail-r");
  private railBarL = sub("#rail-l > i");
  private railBarR = sub("#rail-r > i");
  private railOn = 0;
  // Shown-value memos: a style write that changes nothing still dirties style.
  private railOnShown = -1;
  private railFillShown = -1;
  private railTierShown = -1;
  private fareCard = el("fare-card");
  private fareWho = el("fare-card").querySelector<HTMLElement>(".who");
  private fareDist = el("fare-card").querySelector<HTMLElement>(".dist");
  private patienceFill = el("patience-fill");
  private combo = el("combo");
  private announceMinorEl = el("announce-minor");
  private receipt = el("receipt");
  private comboMeter = el("combo-meter");
  private comboMult = el("combo-meter").querySelector<HTMLElement>(".mult");
  private comboFill = el("combo-fill");
  private countdown = el("countdown");
  private vignette = el("vignette");
  private arrow = el("dest-arrow");
  private arrowPoly = el("dest-arrow").querySelector<SVGPolygonElement>("polygon");
  private arrowBox: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
  private arrowBoxAt = 0;
  private banner = el("banner");
  private bannerTitle = el("banner-title");
  private bannerSub = el("banner-sub");
  private bannerStats = el("banner-stats");
  private bannerControls = el("banner-controls");
  private bannerCta = el("banner-cta");
  private flashEl = el("flash");
  private loading = el("loading");
  private barFill = el("bar-fill");
  private loadSub = sub("#loading .ls");
  private loadFrac = 0;
  private loadLabel = "";
  private reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Score rolls up toward the real value — dollars should count, not teleport.
  private scoreShown = 0;
  private scoreTarget = 0;
  private lastScorePop = 0;
  private lastMphDrawn = -1;
  // Needle spring: the displayed mph trails the real one with a little mass.
  private mphTarget = 0;
  private mphShown = 0;
  private mphVel = 0;
  private dialLive = false;

  // `coarseUi` (mobile): skip sub-mph dial redraws — the needle moves less
  // than a pixel between same-rounded values. Desktop redraws while moving.
  constructor(private coarseUi = false) {}

  update(dt: number): void {
    if (this.scoreShown !== this.scoreTarget) {
      const diff = this.scoreTarget - this.scoreShown;
      const step = Math.max(1, Math.abs(diff) * Math.min(1, dt * 9));
      this.scoreShown =
        diff > 0
          ? Math.min(this.scoreTarget, this.scoreShown + step)
          : Math.max(this.scoreTarget, this.scoreShown - step);
      if (this.scoreVal) {
        this.scoreVal.textContent = `$${Math.round(this.scoreShown).toLocaleString("en-US")}`;
      }
    }
    if (this.dialLive) {
      // Under-damped follower (ratio ~0.58 of critical): a hard throttle or
      // brake makes the needle overshoot slightly, like a gauge with mass.
      // Two substeps keep it stable across a clamped 50ms frame.
      const h = Math.min(dt, 0.05) / 2;
      for (let i = 0; i < 2; i++) {
        this.mphVel += (190 * (this.mphTarget - this.mphShown) - 16 * this.mphVel) * h;
        this.mphShown += this.mphVel * h;
      }
      const settled =
        Math.abs(this.mphVel) < 0.05 && Math.abs(this.mphTarget - this.mphShown) < 0.05;
      const rounded = Math.round(Math.max(0, this.mphShown));
      // The coarse throttle keys off the DISPLAYED value, so the spring still
      // animates on mobile — it only skips sub-mph repaints.
      if (rounded !== this.lastMphDrawn || (!this.coarseUi && !settled)) {
        this.lastMphDrawn = rounded;
        this.drawDial(Math.max(0, this.mphShown));
      }
    }
    this.updateRails(dt);
  }

  /** Screen-edge drift rails: fill = ladder position, tier triple-encoded as
   *  height + hue + pulse-rate (pulse lives in CSS via the .tN classes). One
   *  composited translateY per frame; only opacity is eased. */
  private updateRails(dt: number): void {
    const charge = Math.max(0, Math.min(1, this.driftCharge));
    const active = this.driftTier > 0 || charge > 0;
    const fill = Math.min(1, (this.driftTier + charge) / RAIL_STEPS);
    const want = active ? RAIL_ON_BASE + RAIL_ON_FILL * fill + RAIL_ON_TIER * this.driftTier : 0;
    this.railOn = damp(
      this.railOn,
      want,
      want > this.railOn ? RAIL_RISE_LAMBDA : RAIL_FALL_LAMBDA,
      dt,
    );
    const on = this.railOn < 0.015 ? 0 : this.railOn;
    if (Math.abs(on - this.railOnShown) > 0.005) {
      this.railOnShown = on;
      const o = on.toFixed(3);
      this.railL.style.opacity = o;
      this.railR.style.opacity = o;
    }
    if (Math.abs(fill - this.railFillShown) > 0.004) {
      this.railFillShown = fill;
      const t = `translateY(${((1 - fill) * 100).toFixed(2)}%)`;
      this.railBarL.style.transform = t;
      this.railBarR.style.transform = t;
    }
    const tier = this.driftTier;
    if (tier !== this.railTierShown) {
      // Promotion (not the first sync, not the post-drift reset) refires the
      // flare; colors come from fx/tier.ts so rails and sparks agree.
      const promoted = tier > this.railTierShown && this.railTierShown >= 0 && active;
      this.railTierShown = tier;
      const banked = tierColor(tier);
      const next = RAIL_NEXT_COLOR[tier];
      for (const rail of [this.railL, this.railR]) {
        rail.classList.remove("t0", "t1", "t2", "pop");
        rail.classList.add(`t${tier}`);
        rail.style.setProperty("--cc", banked);
        rail.style.setProperty("--cn", next);
        if (promoted && !this.reduceMotion) {
          void rail.offsetWidth;
          rail.classList.add("pop");
        }
      }
    }
  }

  setTimer(_seconds: number, _low: boolean): void {
    // Global run clock removed — the passenger patience/delivery bar is the
    // only timer. Keep the hook so call sites stay stable; hide the pill.
    this.timer.style.display = "none";
  }
  flashTimeBonus(amount: number): void {
    this.timeBonus.textContent = `+${amount}s`;
    this.timeBonus.animate(
      [
        { opacity: 0, transform: "translateX(-50%) translateY(8px) scale(0.8)" },
        { opacity: 1, transform: "translateX(-50%) translateY(0) scale(1.1)", offset: 0.3 },
        { opacity: 0, transform: "translateX(-50%) translateY(-18px) scale(1)" },
      ],
      { duration: 1100, easing: "ease-out" },
    );
  }
  setScore(n: number): void {
    if (this.scoreTarget === n) return;
    this.scoreTarget = n;
    // Throttle the pop: drift score trickles in every frame and would restart
    // the animation forever.
    const now = performance.now();
    if (now - this.lastScorePop < 300) return;
    this.lastScorePop = now;
    this.scorePill.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.1)" }, { transform: "scale(1)" }],
      { duration: 180, easing: "ease-out" },
    );
  }
  // Instant sync (run start/reset) — no roll-up, no pop.
  resetScore(n: number): void {
    this.scoreTarget = n;
    this.scoreShown = n;
    if (this.scoreVal) this.scoreVal.textContent = `$${n.toLocaleString("en-US")}`;
  }
  // Persistent top-centre area label (always current while driving).
  setArea(name: string): void {
    if (name === "") {
      this.area.classList.remove("show");
      return;
    }
    this.area.classList.add("show");
    this.area.textContent = name.toUpperCase();
  }

  showDistrict(name: string): void {
    this.district.textContent = `◢ ${name.toUpperCase()}`;
    this.district.animate(
      [
        { opacity: 0, transform: "translateX(-50%) translateY(-8px)" },
        { opacity: 1, transform: "translateX(-50%) translateY(0)", offset: 0.18 },
        { opacity: 1, transform: "translateX(-50%) translateY(0)", offset: 0.78 },
        { opacity: 0, transform: "translateX(-50%) translateY(0)" },
      ],
      { duration: 2600, easing: "ease-out" },
    );
  }
  setSpeed(mph: number): void {
    this.mphTarget = Math.max(0, mph);
    if (!this.dialLive) {
      // Seed the follower with the first reading — no full-sweep spawn swing.
      this.dialLive = true;
      this.mphShown = this.mphTarget;
      this.lastMphDrawn = Math.round(this.mphShown);
      this.drawDial(this.mphShown);
    }
  }

  // Warm-ink cluster instrument: channel groove, gradient value fill
  // (cream → gold → kerb red), redline segment, ink-under-cream ticks, and a
  // MOUNTED needle — counterweight + cast shadow + chrome hub are the three
  // things that make a pointer look mounted. The digital readout sits in the
  // sweep's bottom gap under the hub.
  private drawDial(mph: number): void {
    const canvas = this.dial;
    if (!(canvas instanceof HTMLCanvasElement)) return;
    if (!this.dialCtx) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = DIAL_W * dpr;
      canvas.height = DIAL_H * dpr;
      this.dialCtx = canvas.getContext("2d");
      this.dialCtx?.scale(dpr, dpr);
    }
    const ctx = this.dialCtx;
    if (!ctx) return;
    const cx = DIAL_CX;
    const cy = DIAL_CY;
    const r = DIAL_R;
    if (!this.dialValueGrad) {
      const face = ctx.createLinearGradient(0, cy - DIAL_FACE_R, 0, cy + DIAL_FACE_R);
      face.addColorStop(0, "#3a2a1d");
      face.addColorStop(0.55, "#20140d");
      face.addColorStop(1, "#170e0a");
      this.dialFaceGrad = face;
      const val = ctx.createLinearGradient(cx - r, cy + r * 0.35, cx + r, cy - r * 0.55);
      val.addColorStop(0, DIAL_FILL_LO);
      val.addColorStop(0.45, DIAL_FILL_MID);
      val.addColorStop(1, DIAL_FILL_HI);
      this.dialValueGrad = val;
      // Chrome hub: metalness 1.0 reads as a vertical light-to-dark ramp.
      const hub = ctx.createLinearGradient(0, cy - HUB_R, 0, cy + HUB_R);
      hub.addColorStop(0, "#fff7ec");
      hub.addColorStop(0.55, "#b29a80");
      hub.addColorStop(1, "#443426");
      this.dialHubGrad = hub;
    }
    const frac = Math.max(0, Math.min(1, mph / DIAL_MAX_MPH));
    ctx.clearRect(0, 0, DIAL_W, DIAL_H);
    // Face: top-lit warm-ink gradient, warm bevel, cream hairline rim.
    ctx.beginPath();
    ctx.arc(cx, cy, DIAL_FACE_R, 0, Math.PI * 2);
    ctx.fillStyle = this.dialFaceGrad ?? "#170e0a";
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#54402f";
    ctx.beginPath();
    ctx.arc(cx, cy, 35.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255, 226, 186, 0.35)";
    ctx.beginPath();
    ctx.arc(cx, cy, DIAL_FACE_R, 0, Math.PI * 2);
    ctx.stroke();
    // Channel groove, then the unfilled scale over it at one flat value.
    ctx.lineCap = "butt";
    ctx.lineWidth = CHAN_W;
    ctx.strokeStyle = CHAN_INK;
    ctx.beginPath();
    ctx.arc(cx, cy, r, DIAL_A0, DIAL_A0 + DIAL_SWEEP);
    ctx.stroke();
    ctx.lineWidth = CHAN_W * CHAN_FILL_FRAC;
    ctx.strokeStyle = CHAN_SCALE;
    ctx.beginPath();
    ctx.arc(cx, cy, r, DIAL_A0, DIAL_A0 + DIAL_SWEEP);
    ctx.stroke();
    // Redline segment, IN the channel.
    ctx.strokeStyle = REDLINE_INK;
    ctx.beginPath();
    ctx.arc(cx, cy, r, DIAL_A0 + DIAL_SWEEP * REDLINE_FRAC, DIAL_A0 + DIAL_SWEEP);
    ctx.stroke();
    // Value fill: the cream→gold→red ramp with a soft warm glow; past the
    // redline it re-lays hot so the needle's arc wins over the red band.
    if (frac > 0.005) {
      ctx.save();
      ctx.shadowColor = DIAL_FILL_GLOW;
      ctx.shadowBlur = DIAL_W * 0.02;
      ctx.strokeStyle = this.dialValueGrad ?? DIAL_FILL_MID;
      ctx.beginPath();
      ctx.arc(cx, cy, r, DIAL_A0, DIAL_A0 + DIAL_SWEEP * frac);
      ctx.stroke();
      if (frac > REDLINE_FRAC) {
        ctx.strokeStyle = REDLINE_OVER;
        ctx.beginPath();
        ctx.arc(cx, cy, r, DIAL_A0 + DIAL_SWEEP * REDLINE_FRAC, DIAL_A0 + DIAL_SWEEP * frac);
        ctx.stroke();
      }
      ctx.restore();
    }
    // Ticks: minors every 10 mph, majors every 20 — each drawn twice, ink
    // under then cream over (the same recipe as the text contour ring).
    for (let m = 0; m <= DIAL_MAX_MPH; m += 10) {
      const major = m % 20 === 0;
      const a = DIAL_A0 + DIAL_SWEEP * (m / DIAL_MAX_MPH);
      const ax = Math.cos(a);
      const ay = Math.sin(a);
      const rIn = major ? TICK_MAJOR_IN_R : TICK_MINOR_IN_R;
      ctx.strokeStyle = TICK_INK;
      ctx.lineWidth = major ? 2.6 : 1.8;
      ctx.beginPath();
      ctx.moveTo(cx + ax * TICK_OUT_R, cy + ay * TICK_OUT_R);
      ctx.lineTo(cx + ax * rIn, cy + ay * rIn);
      ctx.stroke();
      ctx.strokeStyle = major ? TICK_CREAM_MAJOR : TICK_CREAM_MINOR;
      ctx.lineWidth = major ? 1.4 : 0.9;
      ctx.beginPath();
      ctx.moveTo(cx + ax * TICK_OUT_R, cy + ay * TICK_OUT_R);
      ctx.lineTo(cx + ax * rIn, cy + ay * rIn);
      ctx.stroke();
    }
    // Needle: cream polygon with a counterweight tail, cast shadow, ink edge.
    const na = DIAL_A0 + DIAL_SWEEP * frac;
    const nx = Math.cos(na);
    const ny = Math.sin(na);
    const px = -ny;
    const py = nx;
    const hw = NEEDLE_HALF_W;
    const tailX = cx - nx * NEEDLE_TAIL_R;
    const tailY = cy - ny * NEEDLE_TAIL_R;
    ctx.beginPath();
    ctx.moveTo(cx + px * hw, cy + py * hw);
    ctx.lineTo(cx + nx * NEEDLE_TIP_R, cy + ny * NEEDLE_TIP_R);
    ctx.lineTo(cx - px * hw, cy - py * hw);
    ctx.lineTo(tailX - px * hw * 0.9, tailY - py * hw * 0.9);
    ctx.quadraticCurveTo(
      tailX - nx * hw * 1.6,
      tailY - ny * hw * 1.6,
      tailX + px * hw * 0.9,
      tailY + py * hw * 0.9,
    );
    ctx.closePath();
    ctx.save();
    ctx.shadowColor = "rgba(18, 10, 4, 0.68)";
    ctx.shadowBlur = DIAL_W * 0.022;
    ctx.shadowOffsetX = DIAL_W * 0.005;
    ctx.shadowOffsetY = DIAL_W * 0.01;
    ctx.fillStyle = PAPER;
    ctx.fill();
    ctx.restore();
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = DIAL_INK;
    ctx.stroke();
    // Chrome hub over the needle root.
    ctx.beginPath();
    ctx.arc(cx, cy, HUB_R, 0, Math.PI * 2);
    ctx.fillStyle = this.dialHubGrad ?? "#b29a80";
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = DIAL_INK;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, HUB_R * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(18, 10, 4, 0.78)";
    ctx.fill();
    // Digital readout under the hub: ink stroke under cream fill.
    ctx.textAlign = "center";
    ctx.font = `900 19px ${DIAL_FONT}`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(18, 10, 4, 0.86)";
    ctx.strokeText(String(Math.round(mph)), cx, 69);
    ctx.fillStyle = PAPER;
    ctx.fillText(String(Math.round(mph)), cx, 69);
    ctx.font = `700 8px ${DIAL_FONT}`;
    ctx.fillStyle = "rgba(255, 232, 202, 0.6)";
    ctx.fillText("MPH", cx, 78);
  }
  setBoost(frac: number): void {
    this.boostFill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  }

  driftTier: 0 | 1 | 2 = 0;
  driftCharge = 0;
  setDrift(tier: 0 | 1 | 2, charge: number): void {
    this.driftTier = tier;
    this.driftCharge = charge;
  }
  boostDenied(): void {
    this.boostPill.classList.remove("denied");
    // Force a reflow so re-adding restarts the shake animation.
    void this.boostPill.offsetWidth;
    this.boostPill.classList.add("denied");
  }

  setCombo(mult: number, frac: number): void {
    const show = mult > 1;
    this.comboMeter.classList.toggle("show", show);
    if (!show) return;
    if (this.comboMult) this.comboMult.textContent = `${mult}× COMBO`;
    this.comboFill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    this.comboMeter.classList.toggle("urgent", frac < 0.3);
  }

  // Carry-only fare card: destination, distance, passenger patience.
  setFareCard(title: string, distance: number, patienceFrac: number): void {
    this.fareCard.classList.add("show");
    if (this.fareWho) this.fareWho.textContent = title;
    if (this.fareDist) this.fareDist.textContent = `${Math.round(distance)} m`;
    const f = Math.max(0, Math.min(1, patienceFrac));
    this.patienceFill.style.width = `${Math.round(f * 100)}%`;
    this.patienceFill.style.background = f > 0.5 ? "#7ef0a4" : f > 0.25 ? "#ffb64d" : "#e0453f";
  }
  hideFareCard(): void {
    this.fareCard.classList.remove("show");
  }

  // Major slot: fare payoffs, combos, big moments. Gold and loud.
  showCombo(text: string): void {
    this.combo.textContent = text;
    this.combo.animate(
      [
        { opacity: 0, transform: "translate(-50%,10px) scale(0.5) rotate(-6deg)" },
        { opacity: 1, transform: "translate(-50%,0) scale(1.15) rotate(-3deg)", offset: 0.25 },
        { opacity: 1, transform: "translate(-50%,0) scale(1) rotate(-3deg)", offset: 0.7 },
        { opacity: 0, transform: "translate(-50%,-26px) scale(1) rotate(-3deg)" },
      ],
      { duration: 1200, easing: "cubic-bezier(.2,.9,.3,1)" },
    );
  }

  // Minor slot: near-misses, smashes, air time — never masks a fare payoff.
  // Operator branding: the EARNED pill carries the equipped robotaxi's name
  // and brand color — swapping cars re-skins the meter.
  setOperator(label: string, accent: string): void {
    if (this.scoreLabel) this.scoreLabel.textContent = label;
    // The plate's accent slot: rim-light gradient + label tint both key off
    // --accent, so the brand color lands in one write.
    this.scorePill.style.setProperty("--accent", accent);
  }

  announceMinor(text: string, color = "#aee3ff"): void {
    this.announceMinorEl.textContent = text;
    this.announceMinorEl.style.color = color;
    this.announceMinorEl.animate(
      [
        { opacity: 0, transform: "translate(-50%,8px) scale(0.7)" },
        { opacity: 1, transform: "translate(-50%,0) scale(1.05)", offset: 0.25 },
        { opacity: 1, transform: "translate(-50%,0) scale(1)", offset: 0.65 },
        { opacity: 0, transform: "translate(-50%,-18px) scale(1)" },
      ],
      { duration: 850, easing: "ease-out" },
    );
  }

  // Itemized dropoff receipt, lines staggered 150ms apart.
  showReceipt(lines: readonly ReceiptLine[]): void {
    this.receipt.replaceChildren();
    lines.forEach((line, i) => {
      const div = document.createElement("div");
      div.textContent = line.text;
      div.style.color = line.color;
      div.style.opacity = "0";
      this.receipt.appendChild(div);
      div.animate(
        [
          { opacity: 0, transform: "translateX(30px) scale(0.8)" },
          { opacity: 1, transform: "translateX(0) scale(1.06)", offset: 0.25 },
          { opacity: 1, transform: "translateX(0) scale(1)", offset: 0.75 },
          { opacity: 0, transform: "translateY(-14px)" },
        ],
        { duration: 1500, delay: i * 150, easing: "ease-out", fill: "forwards" },
      );
    });
  }

  showCountdown(text: string, big: boolean): void {
    this.countdown.textContent = text;
    // GO! flips the gold display ramp to green (CSS .go).
    this.countdown.classList.toggle("go", text.toUpperCase().startsWith("GO"));
    // Scale-settle: land past 1, snap back — the digit reads as slammed down.
    this.countdown.animate(
      [
        { opacity: 0, transform: `translate(-50%,-50%) scale(${big ? 1.6 : 1.35})` },
        { opacity: 1, transform: "translate(-50%,-50%) scale(1.06)", offset: 0.28 },
        { opacity: 1, transform: "translate(-50%,-50%) scale(1)", offset: 0.5 },
        { opacity: 1, transform: "translate(-50%,-50%) scale(1)", offset: 0.8 },
        { opacity: 0, transform: "translate(-50%,-50%) scale(0.92)" },
      ],
      { duration: big ? 700 : 480, easing: "ease-out" },
    );
  }

  setVignette(intensity: number): void {
    const v = this.reduceMotion ? 0 : Math.max(0, Math.min(1, intensity));
    this.vignette.style.opacity = v.toFixed(2);
  }

  /**
   * The box the off-screen arrow's CENTRE may sit in — the viewport minus the
   * furniture that would hide it. Only the top and bottom edges are pushed in
   * by the HUD: everything in ARROW_OBSTACLES is anchored to one of those two
   * bands, and insetting the sides as well would take away the left/right the
   * arrow exists to point at. On a phone the pedal, speedo and minimap own the
   * whole bottom of the screen, which is precisely where a fixed NDC clamp
   * used to park the arrow.
   *
   * Measured, not derived: the boxes move with orientation, safe-area insets
   * and the `(pointer: coarse)` rules. Re-read at ARROW_BOX_MS so a layout read
   * never lands in the per-frame path.
   */
  arrowBounds() {
    const now = performance.now();
    const cached = this.arrowBox;
    if (cached && now - this.arrowBoxAt < ARROW_BOX_MS) return cached;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const mid = h / 2;
    let top = 0;
    let bottom = h;
    for (const id of ARROW_OBSTACLES) {
      const node = document.getElementById(id);
      if (!node) continue;
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue; // hidden — claims no space
      if (r.top + r.height / 2 < mid) top = Math.max(top, r.bottom);
      else bottom = Math.min(bottom, r.top);
    }
    const pad = ARROW_HALF + ARROW_GUTTER;
    // A short landscape phone can run the two bands together; keep a strip.
    if (bottom - top < ARROW_MIN_BAND) {
      const centre = (top + bottom) / 2;
      top = centre - ARROW_MIN_BAND / 2;
      bottom = centre + ARROW_MIN_BAND / 2;
    }
    const box = {
      minX: pad,
      maxX: w - pad,
      minY: Math.max(pad, top + pad),
      maxY: Math.min(h - pad, bottom - pad),
    };
    this.arrowBox = box;
    this.arrowBoxAt = now;
    return box;
  }

  // Off-screen objective arrow. When visible it sits at (x,y) rotated to point.
  setArrow(visible: boolean, x: number, y: number, rot: number, color?: string): void {
    if (!visible) {
      this.arrow.style.opacity = "0";
      return;
    }
    this.arrow.style.opacity = "1";
    this.arrow.style.transform = `translate(${x}px, ${y}px) rotate(${rot}rad)`;
    if (color && this.arrowPoly) this.arrowPoly.setAttribute("fill", color);
  }

  showBanner(spec: BannerSpec): void {
    this.bannerTitle.textContent = spec.title;
    this.bannerSub.textContent = spec.sub;
    this.bannerStats.textContent = spec.stats ?? "";
    this.bannerCta.textContent = spec.cta;
    this.renderControls(spec.controls ?? []);
    this.banner.classList.add("show");
  }

  /** Build the keycap legend as nodes — one row per input method, led by the
   *  pause overlay's method tag. The `:empty` rule hides it when there are no
   *  hints (game-over banner), so clear it rather than leaving stale chips. */
  private renderControls(groups: readonly ControlHintGroup[]): void {
    this.bannerControls.replaceChildren(
      ...groups.map((row) => {
        const grp = document.createElement("div");
        grp.className = "grp";
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = row.tag;
        grp.append(tag);
        for (const hint of row.hints) {
          const group = document.createElement("span");
          group.className = "hint";
          for (const key of hint.keys) {
            const cap = document.createElement("kbd");
            cap.textContent = key;
            group.append(cap);
          }
          const label = document.createElement("span");
          label.className = "lbl";
          label.textContent = hint.label;
          group.append(label);
          grp.append(group);
        }
        return grp;
      }),
    );
  }
  hideBanner(): void {
    this.banner.classList.remove("show");
  }

  /** Landing screen: banner owns the screen. Hides the gameplay HUD (pills,
   *  minimap, driver count, touch pad) and reveals the sound button. */
  setLanding(on: boolean): void {
    document.body.classList.toggle("landing", on);
  }
  /** Retarget the banner's call-to-action without rebuilding the banner —
   *  used while the city finishes loading behind the landing screen. */
  setCta(text: string): void {
    this.bannerCta.textContent = text;
  }
  onCta(fn: () => void): void {
    this.bannerCta.addEventListener("click", fn);
  }
  flash(rgb: string, alpha: number): void {
    const a = this.reduceMotion ? Math.min(alpha, 0.1) : alpha;
    this.flashEl.style.background = rgb;
    this.flashEl.animate([{ opacity: a }, { opacity: 0 }], { duration: 220, easing: "ease-out" });
  }

  /** `label` names the stage under the bar. The bar never goes BACKWARDS: the
   *  inline boot creep in index.html owns 0-14% before the bundle even parses,
   *  and a stage that reports a lower fraction than it has already reached
   *  would read as a stall or a bug. */
  setLoading(frac: number, label?: string): void {
    boot()?.stop();
    this.loadFrac = Math.max(this.loadFrac, frac);
    this.barFill.style.transition = "transform 0.2s";
    this.barFill.style.transform = `scaleX(${this.loadFrac.toFixed(4)})`;
    if (label !== undefined && label !== this.loadLabel) {
      this.loadLabel = label;
      this.loadSub.textContent = label;
    }
  }

  /** Glide the bar toward `frac` over `seconds` using a CSS transition, so the
   *  motion lives on the compositor. A timer cannot cover the world decode —
   *  it blocks the main thread, `setInterval` stops firing, and the bar sat
   *  frozen for ~5s mid-load. CSS keeps moving through the block. */
  glideLoading(frac: number, seconds: number, label?: string): void {
    boot()?.stop();
    if (label !== undefined && label !== this.loadLabel) {
      this.loadLabel = label;
      this.loadSub.textContent = label;
    }
    if (frac <= this.loadFrac) return;
    this.loadFrac = frac;
    this.barFill.style.transition = `transform ${seconds}s linear`;
    this.barFill.style.transform = `scaleX(${frac.toFixed(4)})`;
  }
  hideLoading(): void {
    this.loading.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 350,
      easing: "ease",
    }).onfinish = () => {
      this.loading.style.display = "none";
    };
  }
}
