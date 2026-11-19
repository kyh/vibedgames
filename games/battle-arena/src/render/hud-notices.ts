import { attackIcon, champSigil } from "../data/icons";
import type { Unit, World } from "../sim/types";
import type { Fx } from "./fx";

export type ToastKind = "leader" | "delivery" | "streak" | "sudden" | "matchend" | "notice";

const TOAST_STYLE = {
  delivery: { life: 2400, priority: 1 },
  leader: { life: 3600, priority: 2 },
  matchend: { life: 2400, priority: 3 },
  notice: { life: 2400, priority: 0 },
  streak: { life: 2400, priority: 0 },
  sudden: { life: 3600, priority: 3 },
} satisfies Record<ToastKind, { priority: number; life: number }>;

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
const TOAST_MAX_AGE = 6000;
const FEED_ROW_LIFE = 5000;

interface Toast {
  text: string;
  kind: ToastKind;
  receivedAt: number;
}

interface VisibleToast {
  notice: Toast;
  el: HTMLElement;
  until: number;
}

interface FeedRow {
  el: HTMLElement;
  until: number;
}

interface ConfettiStage {
  at: number;
  x: number;
  y: number;
  color: number;
}

const toastKind: (kind: string) => ToastKind = (kind) => {
  switch (kind) {
    case "leader":
    case "delivery":
    case "streak":
    case "sudden":
    case "matchend": {
      return kind;
    }

    default: {
      return "notice";
    }
  }
};

const feedCap = () => (window.innerWidth < 720 ? 3 : 5);

const feedSigil = (u: Unit | undefined) => {
  if (!u || u.kind !== "hero" || !u.champId) {
    return null;
  }

  const img = document.createElement("img");
  img.className = "ba-ks";
  img.src = champSigil(u.champId);
  img.alt = "";

  return img;
};

const feedName = (tag: "b" | "span", name: string) => {
  const el = document.createElement(tag);
  el.textContent = name;

  return el;
};

export class HudNotices {
  private now = 0;
  private paused = false;
  private hidden = document.hidden;
  private feedRows: FeedRow[] = [];
  private visibleToasts: VisibleToast[] = [];
  private pendingToasts: Toast[] = [];
  private confetti: ConfettiStage[] = [];

  private fx: Fx;
  private feedEl: HTMLElement;
  private toastEl: HTMLElement;

  constructor(fx: Fx, feedEl: HTMLElement, toastEl: HTMLElement) {
    this.fx = fx;
    this.feedEl = feedEl;
    this.toastEl = toastEl;
  }

  get blocked() {
    return this.paused || this.hidden;
  }

  /** Local presentation pause is independent of the host's live world clock. */
  setPaused(paused: boolean) {
    if (paused === this.paused) {
      return;
    }

    this.paused = paused;

    if (paused) {
      this.hold();
    }
  }

  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.hold();
  }

  /** Only an accepted new match rewinds the presentation clock. */
  reset() {
    this.hold();
    this.now = 0;
  }

  /** Drop everything visible and everything queued. */
  hold() {
    this.clear();
    this.dropIncoming();
  }

  clear() {
    for (const row of this.feedRows) {
      row.el.remove();
    }

    for (const toast of this.visibleToasts) {
      toast.el.remove();
    }

    this.feedRows = [];
    this.visibleToasts = [];
    this.pendingToasts = [];
    this.confetti = [];
  }

  dropIncoming() {
    this.fx.feed.length = 0;
    this.fx.toasts.length = 0;
  }

  /** Two visible notices + three plain pending records. Priority displaces
   * lower-priority decoration; equal priority stays FIFO and expires promptly. */
  queue(text: string, kind: ToastKind) {
    if (this.blocked) {
      return;
    }

    const notice: Toast = { kind, receivedAt: this.now, text };

    if (this.visibleToasts.length < 2) {
      this.present(notice);

      return;
    }

    const { priority } = TOAST_STYLE[notice.kind];
    const lowest = Math.min(...this.visibleToasts.map((t) => TOAST_STYLE[t.notice.kind].priority));

    if (priority > lowest) {
      const index = this.visibleToasts.findIndex(
        (t) => TOAST_STYLE[t.notice.kind].priority === lowest,
      );

      const [displaced] = this.visibleToasts.splice(index, 1);
      displaced?.el.remove();
      this.present(notice);

      return;
    }

    if (this.pendingToasts.some((p) => p.kind === notice.kind && p.text === notice.text)) {
      return;
    }

    if (this.pendingToasts.length >= 3) {
      const lowestPending = Math.min(
        ...this.pendingToasts.map((p) => TOAST_STYLE[p.kind].priority),
      );

      if (priority < lowestPending) {
        return;
      }

      const index = this.pendingToasts.findIndex(
        (p) => TOAST_STYLE[p.kind].priority === lowestPending,
      );

      this.pendingToasts.splice(index, 1);
    }

    this.pendingToasts.push(notice);
  }

  private present(notice: Toast) {
    const el = document.createElement("div");
    el.className = `ba-toast ${notice.kind}`;
    el.textContent = notice.text;
    this.toastEl.append(el);
    this.visibleToasts.push({
      el,
      notice,
      until: this.now + TOAST_STYLE[notice.kind].life,
    });
  }

  /** Three staggered fountains on the winner; nothing under reduced motion. */
  celebrate(x: number, y: number) {
    if (this.blocked || REDUCED_MOTION.matches) {
      return;
    }

    this.confetti = [0xff_d2_4a, 0x6b_ff_8e, 0x9f_d0_ff].map((color, i) => ({
      at: this.now + i * 200,
      color,
      x,
      y,
    }));
  }

  update(frameDt: number) {
    if (this.blocked) {
      this.dropIncoming();

      return;
    }

    if (Number.isFinite(frameDt)) {
      this.now += Math.max(0, frameDt) * 1000;
    }

    const { now } = this;
    const cap = feedCap();
    this.feedRows = this.feedRows.filter((row, i) => {
      if (row.until > now && i >= this.feedRows.length - cap) {
        return true;
      }

      row.el.remove();

      return false;
    });
    this.visibleToasts = this.visibleToasts.filter((toast) => {
      if (toast.until > now && now - toast.notice.receivedAt < TOAST_MAX_AGE) {
        return true;
      }

      toast.el.remove();

      return false;
    });
    this.pendingToasts = this.pendingToasts.filter((p) => now - p.receivedAt < TOAST_MAX_AGE);

    while (this.visibleToasts.length < 2 && this.pendingToasts.length > 0) {
      const highest = Math.max(...this.pendingToasts.map((p) => TOAST_STYLE[p.kind].priority));
      const index = this.pendingToasts.findIndex((p) => TOAST_STYLE[p.kind].priority === highest);
      const [next] = this.pendingToasts.splice(index, 1);

      if (next) {
        this.present(next);
      }
    }

    if (REDUCED_MOTION.matches) {
      this.confetti = [];
    }

    this.confetti = this.confetti.filter((stage) => {
      if (stage.at > now) {
        return true;
      }

      if (now - stage.at < 200) {
        this.fx.fountain(stage.x, stage.y, 16, stage.color);
      }

      return false;
    });
  }

  /** Move this frame's Fx kill/toast events into the DOM. */
  drain(w: World) {
    if (this.blocked) {
      this.dropIncoming();

      return;
    }

    const cap = feedCap();
    const incoming = this.fx.feed.splice(Math.max(0, this.fx.feed.length - cap));
    this.fx.feed.length = 0;

    for (const k of incoming) {
      const row = document.createElement("div");
      row.className = `ba-kill${k.leader ? " leader" : ""}`;
      const ku = w.units.get(k.killer);
      const weapon = document.createElement("img");
      weapon.className = "ba-kw";
      weapon.src = attackIcon(ku?.attackKind ?? "melee");
      weapon.alt = "";

      for (const part of [
        feedSigil(ku),
        feedName("b", k.killerName),
        weapon,
        feedSigil(w.units.get(k.victim)),
        feedName("span", k.victimName),
      ]) {
        if (part) {
          row.append(part);
        }
      }

      this.feedEl.append(row);
      this.feedRows.push({ el: row, until: this.now + FEED_ROW_LIFE });

      while (this.feedRows.length > cap) {
        this.feedRows.shift()?.el.remove();
      }
    }

    for (const notice of this.fx.toasts) {
      this.queue(notice.text, toastKind(notice.kind));
    }

    this.fx.toasts.length = 0;
  }
}
