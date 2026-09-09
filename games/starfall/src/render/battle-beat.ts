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
export function waveBattleBeat(tSec: number): Exclude<BattleBeat, "aftermath"> {
  if (!Number.isFinite(tSec)) return "quiet";
  const t = Math.max(0, tSec);
  const phase = t % 90;
  const phasePeak = 1.2 * (1 + phase / 180);
  const pressure = (arenaIntensity(phase) / phasePeak) * wavePulse(t);
  return pressure < 0.35 ? "quiet" : pressure >= 0.68 ? "crest" : "build";
}

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
    if (!p?.presenting || p.epoch !== epoch || now < p.now || now - p.now > GAP_MS) return;
    this.aftermathUntil = now + AFTERMATH_MS;
  }

  update(input: BattleBeatInput): BattleBeat {
    if (!Number.isFinite(input.now) || !Number.isFinite(input.epoch)) {
      this.reset();
      return this.beat;
    }
    const p = this.previous;
    const adopt =
      p === null ||
      p.epoch !== input.epoch ||
      input.now < p.now ||
      input.now - p.now > GAP_MS ||
      p.presenting !== input.presenting;
    this.previous = input;
    if (adopt || !input.presenting) {
      this.aftermathUntil = 0;
      this.candidate = null;
    }
    const desired: BattleBeat = !input.presenting
      ? "quiet"
      : input.bossAlive
        ? "crest"
        : input.now < this.aftermathUntil
          ? "aftermath"
          : waveBattleBeat((input.now - input.epoch) / 1000);
    if (
      adopt ||
      !input.presenting ||
      input.bossAlive ||
      desired === "aftermath" ||
      (this.beat === "aftermath" && input.now >= this.aftermathUntil)
    ) {
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
