function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function sub(selector: string): HTMLElement {
  const node = document.querySelector(selector);
  if (!(node instanceof HTMLElement)) throw new Error(`missing ${selector}`);
  return node;
}

/** The pre-bundle bar creep, published by the inline script in index.html. */
type BootBar = { stop(): void; at(): number };

function boot(): BootBar | null {
  const w: unknown = (globalThis as { __bootBar?: unknown }).__bootBar;
  if (typeof w !== "object" || w === null) return null;
  const c = w as Partial<BootBar>;
  return typeof c.stop === "function" && typeof c.at === "function" ? (c as BootBar) : null;
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

  // Analogue gauge, kart-cluster style: dark face in a bevel + gold rim,
  // 240° sweep, ticks every 10 (majors at 20), needle from the hub. The
  // digital readout sits in the sweep's bottom gap under the hub.
  private drawDial(mph: number): void {
    const canvas = this.dial;
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const W = 120;
    const H = 84;
    if (!this.dialCtx) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      this.dialCtx = canvas.getContext("2d");
      this.dialCtx?.scale(dpr, dpr);
    }
    const ctx = this.dialCtx;
    if (!ctx) return;
    const DIAL_MAX = 100;
    const cx = 60;
    const cy = 42;
    const r = 29;
    // 240° sweep, symmetric about 12 o'clock, opening at the bottom.
    const a0 = Math.PI * (5 / 6);
    const sweep = Math.PI * (4 / 3);
    const frac = Math.max(0, Math.min(1, mph / DIAL_MAX));
    ctx.clearRect(0, 0, W, H);
    // Face, warm bevel ring, gold rim — matches the .pill plate recipe.
    ctx.beginPath();
    ctx.arc(cx, cy, 38, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(20, 16, 12, 0.96)";
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#352a1e";
    ctx.beginPath();
    ctx.arc(cx, cy, 35.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 209, 71, 0.9)";
    ctx.beginPath();
    ctx.arc(cx, cy, 38, 0, Math.PI * 2);
    ctx.stroke();
    // Track, then the speed arc over it (color shifts toward the redline).
    ctx.lineCap = "butt";
    ctx.lineWidth = 7;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a0 + sweep);
    ctx.stroke();
    if (frac > 0.005) {
      ctx.strokeStyle = frac > 0.8 ? "#ff8a3c" : frac > 0.55 ? "#ffd147" : "#8fd9ff";
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a0 + sweep * frac);
      ctx.stroke();
    }
    // Ticks inside the track: minors every 10 mph, longer majors every 20.
    for (let m = 0; m <= DIAL_MAX; m += 10) {
      const major = m % 20 === 0;
      const a = a0 + sweep * (m / DIAL_MAX);
      const t1 = major ? 17.5 : 21;
      ctx.strokeStyle = major ? "rgba(255, 255, 255, 0.7)" : "rgba(255, 255, 255, 0.32)";
      ctx.lineWidth = major ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * 24, cy + Math.sin(a) * 24);
      ctx.lineTo(cx + Math.cos(a) * t1, cy + Math.sin(a) * t1);
      ctx.stroke();
    }
    // Needle from the hub with a short counterweight tail; dark contour
    // underneath so it survives crossing the bright arc colors.
    const na = a0 + sweep * frac;
    const nx = Math.cos(na);
    const ny = Math.sin(na);
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(10, 7, 4, 0.7)";
    ctx.lineWidth = 5.5;
    ctx.beginPath();
    ctx.moveTo(cx - nx * 6, cy - ny * 6);
    ctx.lineTo(cx + nx * 23, cy + ny * 23);
    ctx.stroke();
    ctx.strokeStyle = "#ff5a52";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - nx * 6, cy - ny * 6);
    ctx.lineTo(cx + nx * 23, cy + ny * 23);
    ctx.stroke();
    // Hub cap.
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#241d16";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffd147";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = "#ff5a52";
    ctx.fill();
    // Digital readout under the hub.
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    ctx.font = "800 19px ui-monospace, 'SF Mono', Menlo, monospace";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
    ctx.strokeText(String(Math.round(mph)), cx, 69);
    ctx.fillStyle = "#fff";
    ctx.fillText(String(Math.round(mph)), cx, 69);
    ctx.font = "800 8px ui-monospace, 'SF Mono', Menlo, monospace";
    ctx.fillStyle = "rgba(255, 209, 71, 0.85)";
    ctx.fillText("MPH", cx, 78);
  }
  setBoost(frac: number): void {
    this.boostFill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
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
    this.patienceFill.style.background = f > 0.5 ? "#6bff8e" : f > 0.25 ? "#ffb64d" : "#ff5a52";
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
    if (this.scoreLabel) this.scoreLabel.style.color = accent;
    this.scorePill.style.borderColor = accent;
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
