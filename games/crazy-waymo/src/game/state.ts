import { FARE } from "../shared/constants";

export type DropoffReward = {
  readonly fare: number;
  readonly tip: number;
  readonly gross: number;
  readonly timeBonus: number;
  readonly overflowCash: number; // seconds lost to the time cap, paid as $
  readonly combo: number;
};

// How long a "par" delivery of `tiles` takes — tips and passenger patience key
// off it. Tight enough that only a clean fast run earns the full tip.
export function parSeconds(tiles: number): number {
  return tiles * 0.9 + 3;
}

// Owns the run's numbers: score, clock, combo. Pure logic, no rendering.
export class GameState {
  score = 0;
  fares = 0;
  timeLeft: number = FARE.startTime;
  combo = 1;
  comboTimer = 0;
  bestDrift = 0;
  bestAir = 0;
  private driftAccum = 0;
  // Stunt cash (drift/air/smash/near-miss) only pays WITH a passenger aboard —
  // empty cruising earns nothing but still bleeds on traffic hits.
  private carrying = false;

  reset(): void {
    this.score = 0;
    this.fares = 0;
    this.timeLeft = FARE.startTime;
    this.combo = 1;
    this.comboTimer = 0;
    this.bestDrift = 0;
    this.bestAir = 0;
    this.driftAccum = 0;
    this.carrying = false;
  }

  // The combo window only burns while CARRYING a fare — the chain judges how
  // fast you deliver, not how lucky the next spawn happens to be.
  update(dt: number, carrying: boolean): void {
    this.carrying = carrying;
    // No global run clock — sessions are endless; pressure comes from each
    // passenger's own patience/delivery timer. timeLeft stays for time-bonus
    // math but never counts down to a game over.
    if (this.comboTimer > 0 && carrying) {
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

  // `payMult` scales the fare by trip tier (long hauls pay superlinearly).
  dropoff(tiles: number, rideTime: number, payMult = 1): DropoffReward {
    this.combo = this.comboTimer > 0 ? Math.min(FARE.comboMax, this.combo + 1) : 1;
    this.comboTimer = FARE.comboWindow;

    const fareBase = Math.round((FARE.baseFare + FARE.farePerTile * tiles) * payMult);
    const tipFrac = Math.max(0, Math.min(1, 1 - rideTime / parSeconds(tiles)));
    const tip = Math.round(FARE.tipFastBonus * tipFrac);
    const gross = Math.round((fareBase + tip) * this.combo);
    const rawBonus = Math.round(
      Math.max(FARE.minTimeBonus, Math.min(FARE.maxTimeBonus, FARE.timePerTile * tiles)),
    );
    // The clock never banks past the cap; overflow seconds convert to cash so
    // late-game dropoffs still pay in full.
    const room = Math.max(0, FARE.timeCap - this.timeLeft);
    const timeBonus = Math.min(rawBonus, Math.ceil(room));
    const overflowCash = (rawBonus - timeBonus) * FARE.overflowDollarPerSec;

    this.score += gross + overflowCash;
    this.fares += 1;
    this.timeLeft += timeBonus;
    return { fare: fareBase, tip, gross, timeBonus, overflowCash, combo: this.combo };
  }

  // A bailed passenger pays nothing; the chain breaks.
  bail(): void {
    this.combo = 1;
    this.comboTimer = 0;
  }

  addDrift(dt: number): void {
    this.driftAccum += dt;
    if (this.carrying) this.score += FARE.driftScorePerSec * dt;
    if (this.driftAccum > this.bestDrift) this.bestDrift = this.driftAccum;
  }
  endDrift(): void {
    this.driftAccum = 0;
  }

  // Landing a hill jump pays by hang time. Not combo-multiplied — the combo is
  // scoped to fare payouts (its timer only runs while carrying, so letting it
  // multiply stunts would make a parked 8× chain farmable risk-free).
  landAir(airTime: number): number {
    if (airTime > this.bestAir) this.bestAir = airTime;
    if (!this.carrying) return 0;
    const pts = Math.round(40 * airTime);
    this.score += pts;
    return pts;
  }

  smash(): number {
    if (!this.carrying) return 0;
    this.score += FARE.smashBonus;
    return FARE.smashBonus;
  }

  // Ramming traffic costs money (cones are toys; cars are not).
  trafficHit(impact: number): number {
    const pen = Math.min(80, Math.round(12 + impact * 1.4));
    this.score = Math.max(0, this.score - pen);
    return pen;
  }

  // Near-miss pays with the risk: up to 3× at boost speed (no combo — see landAir).
  nearMiss(speedFrac: number): number {
    if (!this.carrying) return 0;
    const pts = Math.round(FARE.nearMissBonus * (1 + 2 * Math.min(1, speedFrac)));
    this.score += pts;
    return pts;
  }
}
