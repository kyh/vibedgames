import { trialUrl, type TrialChoice, type TrialState } from "./weapon-trial";

/** A quiet instruction while flying; native links after the actual trial ends. */
export class TrialCard {
  private readonly root = document.getElementById("trial-card");
  private readonly title = document.getElementById("trial-title");
  private readonly detail = document.getElementById("trial-detail");
  private readonly progress = document.getElementById("trial-progress");
  private readonly actions = document.getElementById("trial-actions");

  constructor(private readonly choice: TrialChoice) {
    const retry = document.getElementById("trial-retry");
    if (retry instanceof HTMLAnchorElement) retry.href = trialUrl(choice.kind, choice.seed);
    if (this.title) this.title.textContent = `${choice.weapon} TRIAL`;
  }

  update(state: TrialState, now: number, visible: boolean): void {
    if (this.root) this.root.hidden = !visible;
    if (!visible) return;
    const result = state.phase === "result";
    if (this.actions) this.actions.hidden = !result;
    this.root?.classList.toggle("finished", result);
    const goal =
      this.choice.kind === "railgun"
        ? "Line up two enemies. Hit both with one shot."
        : "Hit the same enemy on the way out and back.";
    const title = result
      ? state.completions > 0
        ? "TRIAL COMPLETE"
        : "TRY ANOTHER APPROACH"
      : `${this.choice.weapon} · ${state.phase === "active" ? `${Math.max(0, (state.endsAt - now) / 1000).toFixed(1)}s` : "READY"}`;
    const detail = result
      ? state.reason === "death"
        ? "Ship lost. Your contacts are saved below."
        : state.reason === "loadout"
          ? "Weapon changed. This attempt has ended."
          : "Weapon window complete. Fly the same route again."
      : goal;
    const progress =
      state.phase === "waiting"
        ? "Collect the glowing weapon to begin."
        : `${state.completions} ${this.choice.kind === "railgun" ? "aligned shots" : "return hits"} · ${state.contacts} contacts`;
    if (this.title && this.title.textContent !== title) this.title.textContent = title;
    if (this.detail && this.detail.textContent !== detail) this.detail.textContent = detail;
    if (this.progress && this.progress.textContent !== progress)
      this.progress.textContent = progress;
  }
}
