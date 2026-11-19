import { FARE } from "../shared/constants";

export interface DropoffReward {
  readonly fare: number;
  readonly tip: number;
  readonly gross: number;
  readonly timeBonus: number;
  readonly overflowCash: number;
  readonly combo: number;
}

export const parSeconds = (tiles: number) => tiles * 0.9 + 3;

export class GameState {
  score = 0;
  fares = 0;
  timeLeft: number = FARE.startTime;
  combo = 1;
  comboTimer = 0;
  bestDrift = 0;
  bestAir = 0;
  private lost = 0;
  private driftAccum = 0;
  private carrying = false;

  reset() {
    this.score = 0;
    this.fares = 0;
    this.timeLeft = FARE.startTime;
    this.combo = 1;
    this.comboTimer = 0;
    this.bestDrift = 0;
    this.bestAir = 0;
    this.lost = 0;
    this.driftAccum = 0;
    this.carrying = false;
  }

  update(dt: number, carrying: boolean) {
    this.carrying = carrying;

    if (this.comboTimer > 0 && carrying) {
      this.comboTimer -= dt;

      if (this.comboTimer <= 0) {
        this.combo = 1;
      }
    }
  }

  get timedOut() {
    return this.timeLeft <= 0;
  }
  /** Everything earned this run, penalties ignored — never decreases. */
  get earned() {
    return Math.floor(this.score + this.lost);
  }
  get displayScore() {
    return Math.floor(this.score);
  }

  dropoff(tiles: number, rideTime: number, payMult = 1) {
    this.combo = this.comboTimer > 0 ? Math.min(FARE.comboMax, this.combo + 1) : 1;
    this.comboTimer = FARE.comboWindow;

    const fareBase = Math.round((FARE.baseFare + FARE.farePerTile * tiles) * payMult);
    const tipFrac = Math.max(0, Math.min(1, 1 - rideTime / parSeconds(tiles)));
    const tip = Math.round(FARE.tipFastBonus * tipFrac);
    const gross = Math.round((fareBase + tip) * this.combo);

    const rawBonus = Math.round(
      Math.max(FARE.minTimeBonus, Math.min(FARE.maxTimeBonus, FARE.timePerTile * tiles)),
    );

    const room = Math.max(0, FARE.timeCap - this.timeLeft);
    const timeBonus = Math.min(rawBonus, Math.ceil(room));
    const overflowCash = (rawBonus - timeBonus) * FARE.overflowDollarPerSec;

    this.score += gross + overflowCash;
    this.fares += 1;
    this.timeLeft += timeBonus;

    return { combo: this.combo, fare: fareBase, gross, overflowCash, timeBonus, tip };
  }

  bail() {
    this.combo = 1;
    this.comboTimer = 0;
  }

  addDrift(dt: number) {
    this.driftAccum += dt;

    if (this.carrying) {
      this.score += FARE.driftScorePerSec * dt;
    }

    if (this.driftAccum > this.bestDrift) {
      this.bestDrift = this.driftAccum;
    }
  }
  endDrift() {
    this.driftAccum = 0;
  }

  landAir(airTime: number) {
    if (airTime > this.bestAir) {
      this.bestAir = airTime;
    }

    if (!this.carrying) {
      return 0;
    }

    const pts = Math.round(40 * airTime);
    this.score += pts;

    return pts;
  }

  smash() {
    if (!this.carrying) {
      return 0;
    }

    this.score += FARE.smashBonus;

    return FARE.smashBonus;
  }

  trafficHit(impact: number) {
    const pen = Math.min(80, Math.round(12 + impact * 1.4));
    this.lost += Math.min(pen, this.score);
    this.score = Math.max(0, this.score - pen);

    return pen;
  }

  nearMiss(speedFrac: number) {
    if (!this.carrying) {
      return 0;
    }

    const pts = Math.round(FARE.nearMissBonus * (1 + 2 * Math.min(1, speedFrac)));
    this.score += pts;

    return pts;
  }
}
