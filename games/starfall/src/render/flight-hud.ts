import { LEVEL_CAP, xpToNext } from "../shared/constants";
import type { WeaponMasteryState } from "../shared/weapon-mastery";

export type FlightHudState = Readonly<{
  level: number;
  /** Progress into the current level, not lifetime or sector score. */
  xp: number;
  weaponUntil: number;
  now: number;
  active: boolean;
  mastery: WeaponMasteryState;
}>;

/** DOM view of level / XP / special-weapon time / mastery (index.html owns the nodes). */
export class FlightHud {
  private readonly progress = document.querySelector("#flight-progress");
  private readonly level = document.querySelector("#flight-level");
  private readonly xp = document.querySelector("#flight-xp");
  private readonly fill = document.querySelector("#flight-xp-fill");
  private readonly time = document.querySelector("#weapon-time");
  private readonly mastery = document.querySelector("#weapon-mastery");

  update(state: FlightHudState): void {
    if (!state.active) {
      this.reset();
      return;
    }
    const capped = state.level >= LEVEL_CAP;
    const cost = xpToNext(state.level);
    const progress = Math.max(0, Math.min(cost, state.xp));
    const seconds = Math.max(0, Math.ceil((state.weaponUntil - state.now) / 1000));
    if (this.mastery) {
      const text = seconds > 0 ? masteryText(state.mastery) : "";
      this.mastery.hidden = text === "";
      setText(this.mastery, text);
    }
    if (this.progress) {
      this.progress.hidden = false;
      setAttribute(
        this.progress,
        "aria-label",
        capped
          ? `Level ${state.level}, maximum level`
          : `Level ${state.level}, ${Math.floor(progress)} of ${cost} XP to next level`,
      );
    }
    setText(this.level, `LV ${state.level}`);
    setText(this.xp, capped ? "MAX" : `${Math.floor(progress)}/${cost} XP`);
    if (this.fill) {
      const width = capped ? "100%" : `${Math.round((progress / cost) * 100)}%`;
      if (this.fill.style.width !== width) {
        this.fill.style.width = width;
      }
    }
    if (this.time) {
      this.time.hidden = seconds === 0;
      setText(this.time, seconds > 0 ? `${seconds}s` : "");
      setAttribute(
        this.time,
        "aria-label",
        seconds > 0 ? `Special weapon: ${seconds} seconds remaining` : "",
      );
    }
  }

  reset(): void {
    if (this.progress) {
      this.progress.hidden = true;
    }
    if (this.mastery) {
      this.mastery.hidden = true;
      setText(this.mastery, "");
    }
    if (this.time) {
      this.time.hidden = true;
      setText(this.time, "");
    }
  }
}

function masteryText(mastery: WeaponMasteryState): string {
  if (mastery.phase === "idle") {
    return "";
  }
  const rail = mastery.weapon === "RAILGUN";
  if (mastery.completions > 0) {
    return `${rail ? "Aligned shots" : "Return hits"}: ${mastery.completions}`;
  }
  return rail ? "Pierce two enemies with one shot." : "Hit the same enemy out and back.";
}

function setText(node: HTMLElement | null, value: string): void {
  if (node && node.textContent !== value) {
    node.textContent = value;
  }
}

function setAttribute(node: HTMLElement, name: string, value: string): void {
  if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value);
  }
}
