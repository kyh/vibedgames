// Hidden mercy: after a run of early exits the bots hit a little softer, and
// the softening lifts the moment the player places well. Never announced -
// the player should read the next win as their own.

const EARLY_EXIT_RANK = 5;
const STREAK_TO_SOFTEN = 3;
const SOFTENED_DAMAGE = 0.82;

export class Mercy {
  private streak = 0;

  /** Multiplier on bot damage against the player. */
  get damageScale(): number {
    return this.streak >= STREAK_TO_SOFTEN ? SOFTENED_DAMAGE : 1;
  }

  /** Feed every finished match; only the local player's placement counts. */
  record(rank: number): void {
    this.streak = rank >= EARLY_EXIT_RANK ? this.streak + 1 : 0;
  }
}
