// The DOM HUD above the canvas: score, banner card, net status, match point,
// power-charge meter, rally/shot callouts and the serve countdown. Un-dithered
// crisp ink. A guest resyncs it from every 30 Hz snapshot, so each write is
// change-checked to keep the DOM idle between real changes.

import { AUTO_SERVE_S, COMBO_MIN, COMBO_PEAK_HITS, WIN_SCORE } from "../shared/constants";
import type { Phase } from "../shared/constants";
import { CHARGE_HITS, chargeHits } from "../shared/contact-shot";
import type { ContactKind, ShotCharge } from "../shared/contact-shot";

/** What the connection currently means to the player. */
export type Link = "connecting" | "reconnecting" | "solo" | "open" | "live";

export type MatchView = {
  phase: Phase;
  scoreYou: number;
  scoreAi: number;
  longestRally: number;
  link: Link;
  /** Serving with no auto-serve clock: the player has to serve. */
  awaitingServe: boolean;
  charge: ShotCharge;
};

const NET_INFO = {
  connecting: "Finding a rival…",
  reconnecting: "Reconnecting…",
  solo: "VS AI · FIRST TO 7",
  open: "VS AI · RIVAL CAN JOIN",
  live: "LIVE 1V1 · FIRST TO 7",
} satisfies Record<Link, string>;

export class Hud {
  private readonly scoreYouEl = el("score-you");
  private readonly scoreAiEl = el("score-ai");
  private readonly bannerEl = el("banner");
  private readonly bannerTitleEl = el("banner-title");
  private readonly bannerDetailEl = el("banner-detail");
  private readonly actionEl = el("match-action");
  private readonly pointEl = el("point-callout");
  private readonly comboEl = el("combo");
  private readonly serveMeterEl = el("serve-meter");
  private readonly oppLabelEl = el("opp-label");
  private readonly netInfoEl = el("netinfo");
  private readonly shotEl = el("shot-callout");
  private readonly matchPointEl = el("match-point");
  private readonly chargeEl = el("shot-charge");
  private readonly chargeFillEl = el("shot-charge-fill");
  private readonly chargeLabelEl = el("shot-charge-label");
  private serveMeterShown = false; // cached so we only touch classList on transitions

  constructor(onAction: () => void) {
    // A tap on the banner card must not double as a canvas serve.
    for (const eventName of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      this.bannerEl.addEventListener(eventName, (e) => e.stopPropagation());
    }
    this.actionEl.addEventListener("click", onAction);
  }

  sync(view: MatchView): void {
    const { phase, scoreYou, scoreAi, link } = view;
    setText(this.scoreYouEl, String(scoreYou));
    setText(this.scoreAiEl, String(scoreAi));
    const human = link === "live";
    setText(this.oppLabelEl, human ? "RIVAL" : "AI");
    const matchPoint = phase !== "won" && Math.max(scoreYou, scoreAi) === WIN_SCORE - 1;
    const matchPointText = matchPoint
      ? scoreYou === scoreAi
        ? "DECIDING POINT"
        : scoreYou > scoreAi
          ? "YOUR MATCH POINT"
          : "DEFEND MATCH POINT"
      : "";
    setText(this.matchPointEl, matchPointText);

    // The action button stays mounted across states so a snapshot never steals its focus.
    let show = true;
    if (link === "connecting" || link === "reconnecting")
      this.showBanner(link === "reconnecting" ? "RECONNECTING" : "PONG", "FIRST TO 7", "PLAY AI");
    else if (phase === "serving" && view.awaitingServe)
      this.showBanner("PONG", "FIRST TO 7", "SERVE");
    else if (phase === "won")
      this.showBanner(
        scoreYou > scoreAi ? "YOU WIN" : human ? "RIVAL WINS" : "AI WINS",
        `${scoreYou} — ${scoreAi} · LONGEST RALLY ${view.longestRally}`,
        "REMATCH",
      );
    else show = false;
    this.bannerEl.hidden = !show;
    setText(this.netInfoEl, NET_INFO[link]);
    this.syncCharge(view.charge, phase === "won");
  }

  private showBanner(title: string, detail: string, action: string): void {
    setText(this.bannerTitleEl, title);
    setText(this.bannerDetailEl, detail);
    setText(this.actionEl, action);
  }

  syncCharge(charge: ShotCharge, hidden: boolean): void {
    const hits = chargeHits(charge);
    this.chargeEl.hidden = hidden;
    const fill = `scaleX(${hits / CHARGE_HITS})`;
    if (this.chargeFillEl.style.transform !== fill) this.chargeFillEl.style.transform = fill;
    const value = String(hits);
    if (this.chargeEl.getAttribute("aria-valuenow") !== value)
      this.chargeEl.setAttribute("aria-valuenow", value);
    setText(
      this.chargeLabelEl,
      charge.kind === "armed"
        ? "POWER ARMED"
        : charge.kind === "ready"
          ? "POWER READY"
          : `POWER ${hits}/${CHARGE_HITS}`,
    );
  }

  popScore(side: "you" | "ai"): void {
    const node = side === "you" ? this.scoreYouEl : this.scoreAiEl;
    node.classList.remove("pop");
    void node.offsetWidth; // restart the CSS animation
    node.classList.add("pop");
  }

  /** "YOU SCORE" / "RIVAL SCORES" between points; "" clears it. */
  setPoint(text: string): void {
    this.pointEl.textContent = text;
  }

  /** Surface the running rally length as an escalating "×N" once past MIN. */
  showCombo(hits: number): void {
    if (hits < COMBO_MIN) return;
    const tier = Math.min(1, Math.max(0, hits / COMBO_PEAK_HITS));
    this.comboEl.textContent = `RALLY ×${hits}`;
    this.comboEl.style.setProperty("--combo-tier", tier.toFixed(3));
    this.comboEl.style.opacity = "1";
    this.comboEl.classList.remove("pop");
    void this.comboEl.offsetWidth; // restart the CSS pop
    this.comboEl.classList.add("pop");
  }

  hideCombo(): void {
    this.comboEl.style.opacity = "0";
  }

  showShot(kind: ContactKind, mine: boolean, powered: boolean): void {
    this.shotEl.textContent = `${mine ? "" : "RIVAL "}${powered ? "POWER " : ""}${kind.toUpperCase()}`;
    this.shotEl.classList.add("on");
  }

  hideShot(): void {
    this.shotEl.classList.remove("on");
  }

  /** Deplete the serve-countdown bar over the auto-serve dead air between points. */
  serveMeter(left: number | null): void {
    const active = left !== null;
    if (left !== null) {
      this.serveMeterEl.style.setProperty("--fill", `${(left / AUTO_SERVE_S) * 100}%`);
    }
    if (active !== this.serveMeterShown) {
      this.serveMeterEl.classList.toggle("on", active);
      this.serveMeterShown = active;
    }
  }
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
