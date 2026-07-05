function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

export type BannerSpec = {
  readonly title: string;
  readonly sub: string;
  readonly stats?: string;
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
  private faresVal = el("fares").querySelector<HTMLElement>(".value");
  private speedVal = el("speed").querySelector<HTMLElement>(".value");
  private boostPill = el("boost");
  private boostFill = el("boost-fill");
  private fareCard = el("fare-card");
  private fareWho = el("fare-card").querySelector<HTMLElement>(".who");
  private fareDist = el("fare-card").querySelector<HTMLElement>(".dist");
  private fareReward = el("fare-card").querySelector<HTMLElement>(".reward");
  private patienceFill = el("patience-fill");
  private combo = el("combo");
  private announceMinorEl = el("announce-minor");
  private receipt = el("receipt");
  private comboMeter = el("combo-meter");
  private comboMult = el("combo-meter").querySelector<HTMLElement>(".mult");
  private comboFill = el("combo-fill");
  private countdown = el("countdown");
  private vignette = el("vignette");
  private muteBtn = el("mute");
  private pausedEl = el("paused");
  private arrow = el("dest-arrow");
  private arrowPoly = el("dest-arrow").querySelector<SVGPolygonElement>("polygon");
  private banner = el("banner");
  private bannerTitle = el("banner-title");
  private bannerSub = el("banner-sub");
  private bannerStats = el("banner-stats");
  private bannerCta = el("banner-cta");
  private flashEl = el("flash");
  private loading = el("loading");
  private barFill = el("bar-fill");
  private reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Score rolls up toward the real value — dollars should count, not teleport.
  private scoreShown = 0;
  private scoreTarget = 0;
  private lastScorePop = 0;

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
  setFares(n: number): void {
    if (this.faresVal) this.faresVal.textContent = String(n);
  }
  setSpeed(mph: number): void {
    if (this.speedVal) this.speedVal.textContent = String(Math.round(mph));
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

  setFareCard(title: string, distance: number, reward: string, accent?: string): void {
    this.fareCard.classList.add("show");
    if (this.fareWho) {
      this.fareWho.textContent = title;
      this.fareWho.style.color = accent ?? "#aee3ff";
    }
    if (this.fareDist) this.fareDist.textContent = `${Math.round(distance)} m`;
    if (this.fareReward) this.fareReward.textContent = reward;
    this.fareCard.style.borderColor = accent ? `${accent}99` : "rgba(120, 200, 255, 0.55)";
  }
  setPatience(frac: number | null): void {
    this.fareCard.classList.toggle("carrying", frac !== null);
    if (frac === null) return;
    const f = Math.max(0, Math.min(1, frac));
    this.patienceFill.style.width = `${Math.round(f * 100)}%`;
    this.patienceFill.style.background = f > 0.5 ? "#6bff8e" : f > 0.25 ? "#ffb64d" : "#ff5a52";
  }
  hideFareCard(): void {
    this.fareCard.classList.remove("show");
    this.fareCard.classList.remove("carrying");
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
    this.countdown.animate(
      [
        { opacity: 0, transform: `translate(-50%,-50%) scale(${big ? 1.6 : 1.35})` },
        { opacity: 1, transform: "translate(-50%,-50%) scale(1)", offset: 0.3 },
        { opacity: 1, transform: "translate(-50%,-50%) scale(0.95)", offset: 0.8 },
        { opacity: 0, transform: "translate(-50%,-50%) scale(0.9)" },
      ],
      { duration: big ? 700 : 480, easing: "ease-out" },
    );
  }

  setVignette(intensity: number): void {
    const v = this.reduceMotion ? 0 : Math.max(0, Math.min(1, intensity));
    this.vignette.style.opacity = v.toFixed(2);
  }

  setMuted(muted: boolean): void {
    this.muteBtn.textContent = muted ? "🔇" : "🔊";
  }
  onMute(fn: () => void): void {
    this.muteBtn.addEventListener("click", fn);
  }
  setPaused(paused: boolean): void {
    this.pausedEl.classList.toggle("show", paused);
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
    this.banner.classList.add("show");
  }
  hideBanner(): void {
    this.banner.classList.remove("show");
  }
  onCta(fn: () => void): void {
    this.bannerCta.addEventListener("click", fn);
  }

  flash(rgb: string, alpha: number): void {
    const a = this.reduceMotion ? Math.min(alpha, 0.1) : alpha;
    this.flashEl.style.background = rgb;
    this.flashEl.animate([{ opacity: a }, { opacity: 0 }], { duration: 220, easing: "ease-out" });
  }

  setLoading(frac: number): void {
    this.barFill.style.width = `${Math.round(frac * 100)}%`;
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
