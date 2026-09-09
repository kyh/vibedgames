import { COLORS, FUSE_MS } from "../shared/constants";
import type { Bomb } from "../shared/constants";

export interface HudFighter {
  id: string;
  label: string;
  colorIdx: number;
  alive: boolean;
  isLocal: boolean;
  isBot: boolean;
}

export interface BombStock {
  available: number;
  capacity: number;
  next: { remaining: number; progress: number } | null;
}

/** Active bombs stay occupied until shared state removes them, even once
 * their nominal fuse has elapsed — the host decides when a slot frees. */
export function bombStock(
  bombs: Record<string, Bomb>,
  ownerId: string | null,
  capacity: number,
  now: number,
): BombStock {
  let active = 0;
  let earliest = Infinity;
  for (const bomb of Object.values(bombs)) {
    if (bomb.ownerId !== ownerId) {
      continue;
    }
    active++;
    earliest = Math.min(earliest, bomb.placedAt);
  }
  const remaining = Math.max(0, earliest + FUSE_MS - now);
  return {
    available: Math.max(0, capacity - active),
    capacity,
    next: active > 0 ? { progress: Math.max(0, 1 - remaining / FUSE_MS), remaining } : null,
  };
}

const PLACEMENT_TIP_MS = 3600;

/** Bomb stock, roster and the one-shot placement tip. Every write is guarded
 * by a change check because updateBombs runs every frame. */
export class RoundHud {
  private readonly stockEl = document.querySelector("#stat-bomb");
  private readonly bombEl = document.querySelector("#bomb-availability");
  private readonly refillEl = document.querySelector("#bomb-refill");
  private readonly refillFill = document.querySelector("#bomb-refill-fill");
  private readonly playersEl = document.querySelector("#players");
  private readonly tipEl = document.querySelector("#placement-tip");
  private stockText = "";
  private stockLabel = "";
  private refillPercent = -1;
  private rosterSignature = "";
  private tipUntil = 0;
  private taughtPlacement = false;

  updateBombs(bombs: Record<string, Bomb>, ownerId: string | null, capacity: number, now: number) {
    const stock = bombStock(bombs, ownerId, capacity, now);
    const text = `${stock.available}/${stock.capacity}`;
    if (text !== this.stockText) {
      this.stockText = text;
      if (this.stockEl) {
        this.stockEl.textContent = text;
      }
      this.bombEl?.classList.toggle("empty", stock.available === 0);
    }
    const fuse = stock.next
      ? stock.next.remaining > 0
        ? ` Next fuse ends in ${(Math.ceil(stock.next.remaining / 100) / 10).toFixed(1)} seconds.`
        : " Waiting for detonation."
      : "";
    const label = `${stock.available} of ${stock.capacity} bombs available.${fuse}`;
    if (label !== this.stockLabel) {
      this.stockLabel = label;
      this.bombEl?.setAttribute("aria-label", label);
      this.bombEl?.setAttribute("title", label);
    }
    if (this.refillEl) {
      this.refillEl.hidden = stock.next === null;
    }
    const percent = stock.next ? Math.round(stock.next.progress * 100) : 0;
    if (percent !== this.refillPercent) {
      this.refillPercent = percent;
      if (this.refillFill) {
        this.refillFill.style.width = `${percent}%`;
      }
    }
  }

  updateRoster(fighters: readonly HudFighter[]): void {
    if (!this.playersEl) {
      return;
    }
    const signature = JSON.stringify(fighters);
    if (signature === this.rosterSignature) {
      return;
    }
    this.rosterSignature = signature;
    const count = document.createElement("strong");
    count.className = "roster-count";
    count.textContent = `${fighters.filter((fighter) => fighter.alive).length} alive`;
    const roster = document.createElement("span");
    roster.className = "roster-fighters";
    for (const fighter of fighters) {
      const chip = document.createElement("span");
      chip.className = `roster-fighter${fighter.isLocal ? " local" : ""}${fighter.alive ? "" : " out"}`;
      chip.dataset.player = fighter.id;
      chip.setAttribute(
        "aria-label",
        `${fighter.label}${fighter.isLocal ? ", you" : fighter.isBot ? ", computer" : ""}, ${fighter.alive ? "alive" : "out"}`,
      );
      const dot = document.createElement("i");
      dot.className = "roster-dot";
      dot.setAttribute("aria-hidden", "true");
      dot.style.backgroundColor = `#${(COLORS[fighter.colorIdx] ?? 0xff_ff_ff).toString(16).padStart(6, "0")}`;
      const label = document.createElement("span");
      label.textContent = fighter.label;
      chip.append(dot, label);
      roster.append(chip);
    }
    this.playersEl.replaceChildren(count, roster);
  }

  /** Teach "walls block the blast" once, on the first accepted bomb. */
  acceptedPlacement(now: number): void {
    if (this.taughtPlacement) {
      return;
    }
    this.taughtPlacement = true;
    this.tipUntil = now + PLACEMENT_TIP_MS;
    if (this.tipEl) {
      this.tipEl.hidden = false;
    }
  }

  /** Hides the tip once it expires, or immediately when play stops (`active` false). */
  update(now: number, active: boolean): void {
    if (active && (this.tipUntil === 0 || now < this.tipUntil)) {
      return;
    }
    this.tipUntil = 0;
    if (this.tipEl) {
      this.tipEl.hidden = true;
    }
  }

  reset(): void {
    this.tipUntil = 0;
    this.taughtPlacement = false;
    this.stockText = this.stockLabel = this.rosterSignature = "";
    this.refillPercent = -1;
    if (this.tipEl) {
      this.tipEl.hidden = true;
    }
  }
}
