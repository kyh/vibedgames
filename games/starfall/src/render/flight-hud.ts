import { LEVEL_CAP, xpToNext } from "../shared/constants";

export type FlightHudState = Readonly<{
  level: number;
  /** Progress into the current level, not lifetime or sector score. */
  xp: number;
  weaponUntil: number;
  now: number;
  active: boolean;
}>;

/** A passive view of the pilot's existing state. It owns no clocks, inputs or
 * gameplay values; stacked pickups retain their complete deadline in the text. */
export class FlightHud {
  private readonly progress = document.getElementById("flight-progress");
  private readonly level = document.getElementById("flight-level");
  private readonly xp = document.getElementById("flight-xp");
  private readonly fill = document.getElementById("flight-xp-fill");
  private readonly time = document.getElementById("weapon-time");
  private disposed = false;

  update(state: FlightHudState): void {
    if (this.disposed) return;
    if (!state.active) {
      this.reset();
      return;
    }
    const capped = state.level >= LEVEL_CAP;
    const cost = xpToNext(state.level);
    const progress = Math.max(0, Math.min(cost, state.xp));
    const seconds = Math.max(0, Math.ceil((state.weaponUntil - state.now) / 1000));
    if (this.progress) {
      this.progress.hidden = false;
      const label = capped
        ? `Level ${state.level}, maximum level`
        : `Level ${state.level}, ${Math.floor(progress)} of ${cost} XP to next level`;
      if (this.progress.getAttribute("aria-label") !== label)
        this.progress.setAttribute("aria-label", label);
    }
    setText(this.level, `LV ${state.level}`);
    setText(this.xp, capped ? "MAX" : `${Math.floor(progress)}/${cost} XP`);
    if (this.fill) {
      const width = capped ? "100%" : `${Math.round((progress / cost) * 100)}%`;
      if (this.fill.style.width !== width) this.fill.style.width = width;
    }
    if (this.time) {
      this.time.hidden = seconds === 0;
      setText(this.time, seconds > 0 ? `${seconds}s` : "");
      const label = seconds > 0 ? `Special weapon: ${seconds} seconds remaining` : "";
      if (this.time.getAttribute("aria-label") !== label)
        this.time.setAttribute("aria-label", label);
    }
  }

  reset(): void {
    if (this.disposed) return;
    if (this.progress) this.progress.hidden = true;
    if (this.time) {
      this.time.hidden = true;
      setText(this.time, "");
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
  }
}

function setText(node: HTMLElement | null, value: string): void {
  if (node && node.textContent !== value) node.textContent = value;
}
