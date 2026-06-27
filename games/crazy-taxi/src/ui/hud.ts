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

export class Hud {
  private timer = el("timer");
  private timerVal = el("timer").querySelector<HTMLElement>(".value");
  private timeBonus = el("time-bonus");
  private scoreVal = el("score").querySelector<HTMLElement>(".value");
  private faresVal = el("fares").querySelector<HTMLElement>(".value");
  private speedVal = el("speed").querySelector<HTMLElement>(".value");
  private boostFill = el("boost-fill");
  private fareCard = el("fare-card");
  private fareWho = el("fare-card").querySelector<HTMLElement>(".who");
  private fareDist = el("fare-card").querySelector<HTMLElement>(".dist");
  private fareReward = el("fare-card").querySelector<HTMLElement>(".reward");
  private combo = el("combo");
  private arrow = el("dest-arrow");
  private banner = el("banner");
  private bannerTitle = el("banner-title");
  private bannerSub = el("banner-sub");
  private bannerStats = el("banner-stats");
  private bannerCta = el("banner-cta");
  private flashEl = el("flash");
  private loading = el("loading");
  private barFill = el("bar-fill");
  private reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  setTimer(seconds: number, low: boolean): void {
    if (this.timerVal) this.timerVal.textContent = String(Math.max(0, Math.ceil(seconds)));
    this.timer.classList.toggle("low", low);
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
    if (this.scoreVal) this.scoreVal.textContent = n.toLocaleString("en-US");
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

  setFareCard(title: string, distance: number, reward: string): void {
    this.fareCard.classList.add("show");
    if (this.fareWho) this.fareWho.textContent = title;
    if (this.fareDist) this.fareDist.textContent = `${Math.round(distance)} m`;
    if (this.fareReward) this.fareReward.textContent = reward;
  }
  hideFareCard(): void {
    this.fareCard.classList.remove("show");
  }

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

  // Off-screen objective arrow. When visible it sits at (x,y) rotated to point.
  setArrow(visible: boolean, x: number, y: number, rot: number): void {
    if (!visible) {
      this.arrow.style.opacity = "0";
      return;
    }
    this.arrow.style.opacity = "1";
    this.arrow.style.transform = `translate(${x}px, ${y}px) rotate(${rot}rad)`;
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
