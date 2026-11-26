import { TIER_COLORS, tierColor } from "../fx/tier";

const el = (id: string) => {
  const node = document.querySelector<HTMLElement>(`#${id}`);

  if (!node) {
    throw new Error(`missing #${id}`);
  }

  return node;
};

const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt));

const RAIL_STEPS = 3;
const RAIL_ON_BASE = 0.44;
const RAIL_ON_FILL = 0.16;
const RAIL_ON_TIER = 0.13;
const RAIL_RISE_LAMBDA = 22;
const RAIL_FALL_LAMBDA = 8;

const RAIL_NEXT_COLOR = {
  0: TIER_COLORS[0],
  1: TIER_COLORS[1],
  2: TIER_COLORS[2],
} satisfies Record<0 | 1 | 2, string>;

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

const ARROW_HALF = 32;
const ARROW_GUTTER = 8;
const ARROW_MIN_BAND = 140;
const ARROW_BOX_MS = 500;

const DIAL_W = 120;
const DIAL_H = 84;
const DIAL_CX = 60;
const DIAL_CY = 42;
const DIAL_R = 29;
const DIAL_FACE_R = 38;
const DIAL_A0 = Math.PI * (5 / 6);
const DIAL_SWEEP = Math.PI * (4 / 3);
const DIAL_MAX_MPH = 100;
const REDLINE_FRAC = 0.85;
const CHAN_W = 7;
const CHAN_FILL_FRAC = 0.78;
const CHAN_INK = "rgba(18, 10, 4, 0.64)";
const CHAN_SCALE = "rgba(255, 232, 202, 0.15)";
const DIAL_FILL_LO = "#fff4e2";
const DIAL_FILL_MID = "#ffcf6b";
const DIAL_FILL_HI = "#e0453f";
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

const sub = (selector: string) => {
  const node = document.querySelector(selector);

  if (!(node instanceof HTMLElement)) {
    throw new TypeError(`missing ${selector}`);
  }

  return node;
};

interface BootBar {
  stop: () => void;
  at: () => number;
}

const boot = () => {
  const { at, stop } = (globalThis as { __bootBar?: Partial<BootBar> }).__bootBar ?? {};

  if (!(at && stop)) {
    return null;
  }

  return { at, stop };
};

const patienceColor = (frac: number) => {
  if (frac > 0.5) {
    return "#7ef0a4";
  }

  return frac > 0.25 ? "#ffb64d" : "#e0453f";
};

/** One keycap group: the keys that do it, and what they do. */
export interface ControlHint {
  readonly keys: readonly string[];
  readonly label: string;
}

/** One input method's row: the pause overlay's KEYS/TOUCH/PAD tag + its chips. */
export interface ControlHintGroup {
  readonly tag: string;
  readonly hints: readonly ControlHint[];
}

export interface BannerSpec {
  readonly title: string;
  readonly sub: string;
  readonly stats?: string;
  /** Control legend. Landing screen only — never shown over live gameplay. */
  readonly controls?: readonly ControlHintGroup[];
  readonly cta: string;
}

export interface ReceiptLine {
  readonly text: string;
  readonly color: string;
}

export class Hud {
  private readonly timer = el("timer");
  private readonly timerVal = el("timer").querySelector<HTMLElement>(".value");
  private readonly timeBonus = el("time-bonus");
  private readonly district = el("district");
  private readonly area = el("area");
  private readonly scoreVal = el("score").querySelector<HTMLElement>(".value");
  private readonly scorePill = el("score");
  private readonly scoreLabel = el("score").querySelector<HTMLElement>(".label");
  private readonly boostPill = el("speed");
  private readonly boostFill = el("boost-fill");
  private readonly dial = el("dash-dial");
  private dialCtx: CanvasRenderingContext2D | null = null;
  private dialFaceGrad: CanvasGradient | null = null;
  private dialValueGrad: CanvasGradient | null = null;
  private dialHubGrad: CanvasGradient | null = null;
  private readonly railL = el("rail-l");
  private readonly railR = el("rail-r");
  private readonly railBarL = sub("#rail-l > i");
  private readonly railBarR = sub("#rail-r > i");
  private railOn = 0;
  private railOnShown = -1;
  private railFillShown = -1;
  private railTierShown = -1;
  private readonly fareCard = el("fare-card");
  private readonly fareWho = el("fare-card").querySelector<HTMLElement>(".who");
  private readonly fareDist = el("fare-card").querySelector<HTMLElement>(".dist");
  private readonly patienceFill = el("patience-fill");
  private readonly combo = el("combo");
  private readonly announceMinorEl = el("announce-minor");
  private readonly receipt = el("receipt");
  private readonly comboMeter = el("combo-meter");
  private readonly comboMult = el("combo-meter").querySelector<HTMLElement>(".mult");
  private readonly comboFill = el("combo-fill");
  private readonly countdown = el("countdown");
  private readonly vignette = el("vignette");
  private readonly arrow = el("dest-arrow");
  private readonly arrowPoly = el("dest-arrow").querySelector<SVGPolygonElement>("polygon");
  private arrowBox: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
  private arrowBoxAt = 0;
  private readonly banner = el("banner");
  private readonly bannerTitle = el("banner-title");
  private readonly bannerSub = el("banner-sub");
  private readonly bannerStats = el("banner-stats");
  private readonly bannerControls = el("banner-controls");
  private readonly bannerCta = el("banner-cta");
  private readonly flashEl = el("flash");
  private readonly loading = el("loading");
  private readonly barFill = el("bar-fill");
  private readonly loadSub = sub("#loading .ls");
  private loadFrac = 0;
  private loadLabel = "";
  private readonly reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private scoreShown = 0;
  private scoreTarget = 0;
  private lastScorePop = 0;
  private lastMphDrawn = -1;
  private mphTarget = 0;
  private mphShown = 0;
  private mphVel = 0;
  private dialLive = false;

  private readonly coarseUi: boolean;

  constructor(coarseUi = false) {
    this.coarseUi = coarseUi;
  }

  update(dt: number) {
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
      const h = Math.min(dt, 0.05) / 2;

      for (let i = 0; i < 2; i += 1) {
        this.mphVel += (190 * (this.mphTarget - this.mphShown) - 16 * this.mphVel) * h;
        this.mphShown += this.mphVel * h;
      }

      const settled =
        Math.abs(this.mphVel) < 0.05 && Math.abs(this.mphTarget - this.mphShown) < 0.05;

      const rounded = Math.round(Math.max(0, this.mphShown));

      if (rounded !== this.lastMphDrawn || (!this.coarseUi && !settled)) {
        this.lastMphDrawn = rounded;
        this.drawDial(Math.max(0, this.mphShown));
      }
    }

    this.updateRails(dt);
  }

  private updateRails(dt: number) {
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
      this.railTierShown = tier;
      const banked = tierColor(tier);
      const next = RAIL_NEXT_COLOR[tier];

      for (const rail of [this.railL, this.railR]) {
        rail.classList.remove("t0", "t1", "t2");
        rail.classList.add(`t${tier}`);
        rail.style.setProperty("--cc", banked);
        rail.style.setProperty("--cn", next);
      }
    }
  }

  setTimer(_seconds: number, _low: boolean) {
    this.timer.style.display = "none";
  }
  flashTimeBonus(amount: number) {
    this.timeBonus.textContent = `+${amount}s`;
    this.timeBonus.animate(
      [
        { opacity: 0, transform: "translateX(-50%) translateY(8px) scale(0.8)" },
        { offset: 0.3, opacity: 1, transform: "translateX(-50%) translateY(0) scale(1.1)" },
        { opacity: 0, transform: "translateX(-50%) translateY(-18px) scale(1)" },
      ],
      { duration: 1100, easing: "ease-out" },
    );
  }
  setScore(n: number) {
    if (this.scoreTarget === n) {
      return;
    }

    this.scoreTarget = n;
    const now = performance.now();

    if (now - this.lastScorePop < 300) {
      return;
    }

    this.lastScorePop = now;
    this.scorePill.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.1)" }, { transform: "scale(1)" }],
      { duration: 180, easing: "ease-out" },
    );
  }
  resetScore(n: number) {
    this.scoreTarget = n;
    this.scoreShown = n;

    if (this.scoreVal) {
      this.scoreVal.textContent = `$${n.toLocaleString("en-US")}`;
    }
  }
  setArea(name: string) {
    if (name === "") {
      this.area.classList.remove("show");

      return;
    }

    this.area.classList.add("show");
    this.area.textContent = name.toUpperCase();
  }

  showDistrict(name: string) {
    this.district.textContent = `◢ ${name.toUpperCase()}`;
    this.district.animate(
      [
        { opacity: 0, transform: "translateX(-50%) translateY(-8px)" },
        { offset: 0.18, opacity: 1, transform: "translateX(-50%) translateY(0)" },
        { offset: 0.78, opacity: 1, transform: "translateX(-50%) translateY(0)" },
        { opacity: 0, transform: "translateX(-50%) translateY(0)" },
      ],
      { duration: 2600, easing: "ease-out" },
    );
  }
  setSpeed(mph: number) {
    this.mphTarget = Math.max(0, mph);

    if (!this.dialLive) {
      this.dialLive = true;
      this.mphShown = this.mphTarget;
      this.lastMphDrawn = Math.round(this.mphShown);
      this.drawDial(this.mphShown);
    }
  }

  private drawDial(mph: number) {
    const canvas = this.dial;

    if (!(canvas instanceof HTMLCanvasElement)) {
      return;
    }

    if (!this.dialCtx) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = DIAL_W * dpr;
      canvas.height = DIAL_H * dpr;
      this.dialCtx = canvas.getContext("2d");
      this.dialCtx?.scale(dpr, dpr);
    }

    const ctx = this.dialCtx;

    if (!ctx) {
      return;
    }

    const cx = DIAL_CX;
    const cy = DIAL_CY;
    const r = DIAL_R;

    if (!this.dialValueGrad) {
      const face = ctx.createLinearGradient(0, cy - DIAL_FACE_R, 0, cy + DIAL_FACE_R);
      face.addColorStop(0, "#3b2d57");
      face.addColorStop(0.55, "#251b3a");
      face.addColorStop(1, "#1b1428");
      this.dialFaceGrad = face;
      const val = ctx.createLinearGradient(cx - r, cy + r * 0.35, cx + r, cy - r * 0.55);
      val.addColorStop(0, DIAL_FILL_LO);
      val.addColorStop(0.45, DIAL_FILL_MID);
      val.addColorStop(1, DIAL_FILL_HI);
      this.dialValueGrad = val;
      const hub = ctx.createLinearGradient(0, cy - HUB_R, 0, cy + HUB_R);
      hub.addColorStop(0, "#fff7ec");
      hub.addColorStop(0.55, "#b4a6d0");
      hub.addColorStop(1, "#3b2d57");
      this.dialHubGrad = hub;
    }

    const frac = Math.max(0, Math.min(1, mph / DIAL_MAX_MPH));
    ctx.clearRect(0, 0, DIAL_W, DIAL_H);
    ctx.beginPath();
    ctx.arc(cx, cy, DIAL_FACE_R, 0, Math.PI * 2);
    ctx.fillStyle = this.dialFaceGrad ?? "#1b1428";
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#5a4a7a";
    ctx.beginPath();
    ctx.arc(cx, cy, 35.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255, 226, 186, 0.35)";
    ctx.beginPath();
    ctx.arc(cx, cy, DIAL_FACE_R, 0, Math.PI * 2);
    ctx.stroke();
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
    ctx.strokeStyle = REDLINE_INK;
    ctx.beginPath();
    ctx.arc(cx, cy, r, DIAL_A0 + DIAL_SWEEP * REDLINE_FRAC, DIAL_A0 + DIAL_SWEEP);
    ctx.stroke();

    if (frac > 0.005) {
      ctx.save();
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
    ctx.fillStyle = PAPER;
    ctx.fill();
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = DIAL_INK;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, HUB_R, 0, Math.PI * 2);
    ctx.fillStyle = this.dialHubGrad ?? "#b4a6d0";
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = DIAL_INK;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, HUB_R * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(18, 10, 4, 0.78)";
    ctx.fill();
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
  setBoost(frac: number) {
    this.boostFill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  }

  driftTier: 0 | 1 | 2 = 0;
  driftCharge = 0;
  setDrift(tier: 0 | 1 | 2, charge: number) {
    this.driftTier = tier;
    this.driftCharge = charge;
  }
  boostDenied() {
    this.boostPill.classList.remove("denied");
    void this.boostPill.offsetWidth;
    this.boostPill.classList.add("denied");
  }

  setCombo(mult: number, frac: number) {
    const show = mult > 1;
    this.comboMeter.classList.toggle("show", show);

    if (!show) {
      return;
    }

    if (this.comboMult) {
      this.comboMult.textContent = `${mult}× COMBO`;
    }

    this.comboFill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    this.comboMeter.classList.toggle("urgent", frac < 0.3);
  }

  setFareCard(title: string, distance: number, patienceFrac: number) {
    this.fareCard.classList.add("show");

    if (this.fareWho) {
      this.fareWho.textContent = title;
    }

    if (this.fareDist) {
      this.fareDist.textContent = `${Math.round(distance)} m`;
    }

    const f = Math.max(0, Math.min(1, patienceFrac));
    this.patienceFill.style.width = `${Math.round(f * 100)}%`;
    this.patienceFill.style.background = patienceColor(f);
  }
  hideFareCard() {
    this.fareCard.classList.remove("show");
  }

  showCombo(text: string) {
    this.combo.textContent = text;
    this.combo.animate(
      [
        { opacity: 0, transform: "translate(-50%,10px) scale(0.5) rotate(-6deg)" },
        { offset: 0.25, opacity: 1, transform: "translate(-50%,0) scale(1.15) rotate(-3deg)" },
        { offset: 0.7, opacity: 1, transform: "translate(-50%,0) scale(1) rotate(-3deg)" },
        { opacity: 0, transform: "translate(-50%,-26px) scale(1) rotate(-3deg)" },
      ],
      { duration: 1200, easing: "cubic-bezier(.2,.9,.3,1)" },
    );
  }

  setOperator(label: string, accent: string) {
    if (this.scoreLabel) {
      this.scoreLabel.textContent = label;
    }

    this.scorePill.style.setProperty("--accent", accent);
  }

  announceMinor(text: string, color = "#aee3ff") {
    this.announceMinorEl.textContent = text;
    this.announceMinorEl.style.color = color;
    this.announceMinorEl.animate(
      [
        { opacity: 0, transform: "translate(-50%,8px) scale(0.7)" },
        { offset: 0.25, opacity: 1, transform: "translate(-50%,0) scale(1.05)" },
        { offset: 0.65, opacity: 1, transform: "translate(-50%,0) scale(1)" },
        { opacity: 0, transform: "translate(-50%,-18px) scale(1)" },
      ],
      { duration: 850, easing: "ease-out" },
    );
  }

  showReceipt(lines: readonly ReceiptLine[]) {
    this.receipt.replaceChildren();

    for (const [i, line] of lines.entries()) {
      const div = document.createElement("div");
      div.textContent = line.text;
      div.style.color = line.color;
      div.style.opacity = "0";
      this.receipt.append(div);
      div.animate(
        [
          { opacity: 0, transform: "translateX(30px) scale(0.8)" },
          { offset: 0.25, opacity: 1, transform: "translateX(0) scale(1.06)" },
          { offset: 0.75, opacity: 1, transform: "translateX(0) scale(1)" },
          { opacity: 0, transform: "translateY(-14px)" },
        ],
        { delay: i * 150, duration: 1500, easing: "ease-out", fill: "forwards" },
      );
    }
  }

  showCountdown(text: string, big: boolean) {
    this.countdown.textContent = text;
    this.countdown.classList.toggle("go", text.toUpperCase().startsWith("GO"));
    this.countdown.animate(
      [
        { opacity: 0, transform: `translate(-50%,-50%) scale(${big ? 1.6 : 1.35})` },
        { offset: 0.28, opacity: 1, transform: "translate(-50%,-50%) scale(1.06)" },
        { offset: 0.5, opacity: 1, transform: "translate(-50%,-50%) scale(1)" },
        { offset: 0.8, opacity: 1, transform: "translate(-50%,-50%) scale(1)" },
        { opacity: 0, transform: "translate(-50%,-50%) scale(0.92)" },
      ],
      { duration: big ? 700 : 480, easing: "ease-out" },
    );
  }

  setVignette(intensity: number) {
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

    if (cached && now - this.arrowBoxAt < ARROW_BOX_MS) {
      return cached;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    const mid = h / 2;
    let top = 0;
    let bottom = h;

    for (const id of ARROW_OBSTACLES) {
      const node = document.querySelector<HTMLElement>(`#${id}`);

      if (!node) {
        continue;
      }

      const r = node.getBoundingClientRect();

      if (r.width <= 0 || r.height <= 0) {
        continue;
      }

      if (r.top + r.height / 2 < mid) {
        top = Math.max(top, r.bottom);
      } else {
        bottom = Math.min(bottom, r.top);
      }
    }

    const pad = ARROW_HALF + ARROW_GUTTER;

    if (bottom - top < ARROW_MIN_BAND) {
      const centre = (top + bottom) / 2;
      top = centre - ARROW_MIN_BAND / 2;
      bottom = centre + ARROW_MIN_BAND / 2;
    }

    const box = {
      maxX: w - pad,
      maxY: Math.min(h - pad, bottom - pad),
      minX: pad,
      minY: Math.max(pad, top + pad),
    };

    this.arrowBox = box;
    this.arrowBoxAt = now;

    return box;
  }

  setArrow(visible: boolean, x: number, y: number, rot: number, color?: string) {
    if (!visible) {
      this.arrow.style.opacity = "0";

      return;
    }

    this.arrow.style.opacity = "1";
    this.arrow.style.transform = `translate(${x}px, ${y}px) rotate(${rot}rad)`;

    if (color !== undefined && color !== "" && this.arrowPoly) {
      this.arrowPoly.setAttribute("fill", color);
    }
  }

  showBanner(spec: BannerSpec) {
    this.bannerTitle.textContent = spec.title;
    this.bannerSub.textContent = spec.sub;
    this.bannerStats.textContent = spec.stats ?? "";
    this.bannerCta.textContent = spec.cta;
    this.renderControls(spec.controls ?? []);
    this.banner.inert = false;
    this.banner.classList.add("show");
  }

  private renderControls(groups: readonly ControlHintGroup[]) {
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
  hideBanner() {
    this.banner.inert = true;
    this.banner.classList.remove("show");
  }

  /** Landing screen: banner owns the screen. Hides the gameplay HUD (pills,
   *  minimap, driver count, touch pad) and reveals the sound button. */
  // oxlint-disable-next-line class-methods-use-this -- part of the Hud facade; callers hold the instance, not the class
  setLanding(on: boolean) {
    document.body.classList.toggle("landing", on);
  }
  /** Retarget the banner's call-to-action without rebuilding the banner —
   *  used while the city finishes loading behind the landing screen. */
  setCta(text: string) {
    this.bannerCta.textContent = text;
  }
  onCta(fn: () => void) {
    let touch: { id: number; x: number; y: number } | null = null;
    let touchClickPending = false;

    const cancel = (event: PointerEvent) => {
      if (touch?.id === event.pointerId) {
        touch = null;
      }
    };

    this.bannerCta.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch") {
        touchClickPending = false;

        return;
      }

      if (!event.isPrimary || this.banner.inert) {
        return;
      }

      touch = { id: event.pointerId, x: event.clientX, y: event.clientY };
      touchClickPending = true;
    });
    this.bannerCta.addEventListener("pointermove", (event) => {
      if (touch?.id !== event.pointerId) {
        return;
      }

      if (Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 12) {
        touch = null;
      }
    });
    this.bannerCta.addEventListener("pointercancel", cancel);
    this.bannerCta.addEventListener("lostpointercapture", cancel);
    this.bannerCta.addEventListener("pointerup", (event) => {
      const started = touch;
      cancel(event);

      if (!started || started.id !== event.pointerId || this.banner.inert) {
        return;
      }

      const rect = this.bannerCta.getBoundingClientRect();

      if (
        Math.hypot(event.clientX - started.x, event.clientY - started.y) > 12 ||
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        return;
      }

      fn();
    });
    this.bannerCta.addEventListener("click", (event) => {
      if (event.detail > 0 && touchClickPending) {
        touchClickPending = false;
        event.preventDefault();

        return;
      }

      if (!this.banner.inert) {
        fn();
      }
    });
  }
  flash(rgb: string, alpha: number) {
    const a = this.reduceMotion ? Math.min(alpha, 0.1) : alpha;
    this.flashEl.style.background = rgb;
    this.flashEl.animate([{ opacity: a }, { opacity: 0 }], { duration: 220, easing: "ease-out" });
  }

  /** `label` names the stage under the bar. The bar never goes BACKWARDS: the
   *  inline boot creep in index.html owns 0-14% before the bundle even parses,
   *  and a stage that reports a lower fraction than it has already reached
   *  would read as a stall or a bug. */
  setLoading(frac: number, label?: string) {
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
  glideLoading(frac: number, seconds: number, label?: string) {
    boot()?.stop();

    if (label !== undefined && label !== this.loadLabel) {
      this.loadLabel = label;
      this.loadSub.textContent = label;
    }

    if (frac <= this.loadFrac) {
      return;
    }

    this.loadFrac = frac;
    this.barFill.style.transition = `transform ${seconds}s linear`;
    this.barFill.style.transform = `scaleX(${frac.toFixed(4)})`;
  }
  hideLoading() {
    this.loading.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 350,
      easing: "ease",
    }).onfinish = () => {
      this.loading.style.display = "none";
    };
  }
}
