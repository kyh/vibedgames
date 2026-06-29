import { FARE } from "../shared/constants";

export type DropoffReward = {
  readonly fare: number;
  readonly tip: number;
  readonly gross: number;
  readonly timeBonus: number;
  readonly combo: number;
};

// Owns the run's numbers: score, clock, combo. Pure logic, no rendering.
export class GameState {
  score = 0;
  fares = 0;
  timeLeft = FARE.startTime;
  combo = 1;
  comboTimer = 0;
  bestDrift = 0;
  private driftAccum = 0;

  reset(): void {
    this.score = 0;
    this.fares = 0;
    this.timeLeft = FARE.startTime;
    this.combo = 1;
    this.comboTimer = 0;
    this.bestDrift = 0;
    this.driftAccum = 0;
  }

  update(dt: number): void {
    this.timeLeft -= dt;
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 1;
    }
  }

  get timedOut(): boolean {
    return this.timeLeft <= 0;
  }
  get displayScore(): number {
    return Math.floor(this.score);
  }

  dropoff(tiles: number, rideTime: number): DropoffReward {
    this.combo = this.comboTimer > 0 ? Math.min(FARE.comboMax, this.combo + 1) : 1;
    this.comboTimer = FARE.comboWindow;

    const fareBase = FARE.baseFare + FARE.farePerTile * tiles;
    const par = tiles * 2.0 + 5;
    const tipFrac = Math.max(0, Math.min(1, 1 - rideTime / par));
    const tip = Math.round(FARE.tipFastBonus * tipFrac);
    const gross = Math.round((fareBase + tip) * this.combo);
    const timeBonus = Math.round(
      Math.max(FARE.minTimeBonus, Math.min(FARE.maxTimeBonus, FARE.timePerTile * tiles)),
    );

    this.score += gross;
    this.fares += 1;
    this.timeLeft += timeBonus;
    return { fare: fareBase, tip, gross, timeBonus, combo: this.combo };
  }

  addDrift(dt: number): void {
    this.driftAccum += dt;
    this.score += FARE.driftScorePerSec * dt;
    if (this.driftAccum > this.bestDrift) this.bestDrift = this.driftAccum;
  }
  endDrift(): void {
    this.driftAccum = 0;
  }

  nearMiss(): number {
    const pts = FARE.nearMissBonus * this.combo;
    this.score += pts;
    return pts;
  }
}
