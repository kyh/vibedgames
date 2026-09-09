import { arenaIntensity, wavePulse } from "../shared/constants";

export type BattleBeat = "quiet" | "build" | "crest" | "aftermath";
export type BattleBeatInput = Readonly<{
  now: number;
  epoch: number;
  presenting: boolean;
  bossAlive: boolean;
}>;

const SETTLE_MS = 700;
/** Beyond this gap (pause, tab hidden, reconnect) the timeline is adopted, not replayed. */
const GAP_MS = 1500;
const AFTERMATH_MS = 6000;

/** Read the existing 90s wave phase without the unbounded difficulty ramp: once
 * gameplay intensity caps, its absolute value loses the trough entirely. */
export const waveBattleBeat = (tSec: number): Exclude<BattleBeat, "aftermath"> => {
  if (!Number.isFinite(tSec)) {
    return "quiet";
  }
  const t = Math.max(0, tSec);
  const phase = t % 90;
  const phasePeak = 1.2 * (1 + phase / 180);
  const pressure = (arenaIntensity(phase) / phasePeak) * wavePulse(t);
  if (pressure < 0.35) {
    return "quiet";
  }
  return pressure >= 0.68 ? "crest" : "build";
};

/** Music/backdrop mood with hysteresis; a boss defeat resolves into an aftermath. */
export class BattleBeatDirector {
  private previous: BattleBeatInput | null = null;
  private beat: BattleBeat = "quiet";
  private candidate: { beat: BattleBeat; since: number } | null = null;
  private aftermathUntil = 0;

  reset(): void {
    this.previous = null;
    this.beat = "quiet";
    this.candidate = null;
    this.aftermathUntil = 0;
  }

  bossDefeated(now: number, epoch: number): void {
    const p = this.previous;
    if (!p?.presenting || p.epoch !== epoch || now < p.now || now - p.now > GAP_MS) {
      return;
    }
    this.aftermathUntil = now + AFTERMATH_MS;
  }

  /** True when the timeline is discontinuous and must be adopted, not replayed. */
  private isTimelineBreak(input: BattleBeatInput): boolean {
    const p = this.previous;
    return (
      p === null ||
      p.epoch !== input.epoch ||
      input.now < p.now ||
      input.now - p.now > GAP_MS ||
      p.presenting !== input.presenting
    );
  }

  private desiredBeat(input: BattleBeatInput): BattleBeat {
    if (!input.presenting) {
      return "quiet";
    }
    if (input.bossAlive) {
      return "crest";
    }
    if (input.now < this.aftermathUntil) {
      return "aftermath";
    }
    return waveBattleBeat((input.now - input.epoch) / 1000);
  }

  /** Beats that take effect at once; everything else must settle first. */
  private isImmediate(input: BattleBeatInput, adopt: boolean, desired: BattleBeat): boolean {
    return (
      adopt ||
      !input.presenting ||
      input.bossAlive ||
      desired === "aftermath" ||
      (this.beat === "aftermath" && input.now >= this.aftermathUntil)
    );
  }

  update(input: BattleBeatInput): BattleBeat {
    if (!Number.isFinite(input.now) || !Number.isFinite(input.epoch)) {
      this.reset();
      return this.beat;
    }
    const adopt = this.isTimelineBreak(input);
    this.previous = input;
    if (adopt || !input.presenting) {
      this.aftermathUntil = 0;
      this.candidate = null;
    }
    const desired = this.desiredBeat(input);
    if (this.isImmediate(input, adopt, desired)) {
      this.beat = desired;
      this.candidate = null;
    } else if (desired === this.beat) {
      this.candidate = null;
    } else if (this.candidate?.beat !== desired) {
      this.candidate = { beat: desired, since: input.now };
    } else if (input.now - this.candidate.since >= SETTLE_MS) {
      this.beat = desired;
      this.candidate = null;
    }
    return this.beat;
  }
}
