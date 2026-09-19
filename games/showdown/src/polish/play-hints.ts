// The in-play control strip is a start-screen device that overstays: it
// teaches during the countdown and the first seconds of the brawl, then
// leaves once the player has proven they can shoot (or after a short grace).

const GRACE_S = 14;
const ACTED_LINGER_S = 1.5;

export class PlayHints {
  private readonly panel: HTMLElement;
  private shownFor = 0;
  private actedAt: number | null = null;
  private visible = true;

  constructor(panel: HTMLElement) {
    this.panel = panel;
  }

  /** Every match starts with the strip back on screen. */
  reset(): void {
    this.shownFor = 0;
    this.actedAt = null;
    this.setVisible(true);
  }

  /** The player fired or used a super - the strip has done its job. */
  markActed(): void {
    this.actedAt ??= this.shownFor;
  }

  update(dt: number): void {
    if (!this.visible) {
      return;
    }
    this.shownFor += dt;
    const acted = this.actedAt !== null && this.shownFor - this.actedAt > ACTED_LINGER_S;
    if (acted || this.shownFor > GRACE_S) {
      this.setVisible(false);
    }
  }

  private setVisible(on: boolean): void {
    this.visible = on;
    this.panel.classList.toggle("faded", !on);
  }
}
