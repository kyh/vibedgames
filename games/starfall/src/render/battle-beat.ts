import { arenaIntensity, wavePulse } from "../shared/constants";
import type { BossEncounterCue } from "./boss-encounters";

export type BattleBeat = "quiet" | "build" | "crest" | "aftermath";
export type BattleBeatFrame = Readonly<{
  beat: BattleBeat;
  accent: "arrival" | "phase" | null;
  active: boolean;
  lockedWarning: boolean;
  /** A new timeline adopts its current mood without replaying crossed beats. */
  reset: boolean;
}>;
export type BattleBeatInput = Readonly<{
  now: number;
  epoch: number;
  presenting: boolean;
  bossAlive: boolean;
  lockedWarning: boolean;
}>;

const SETTLE_MS = 700;
const GAP_MS = 1500;
const CUE_MAX_AGE_MS = 500;
const AFTERMATH_MS = 6000;

/** Read the existing90s phase without the unbounded difficulty ramp: once
 * gameplay intensity caps, its absolute value loses the trough entirely.
 * Presentation keeps the same wave timing and contrast in later sectors. */
export function waveBattleBeat(tSec: number): Exclude<BattleBeat, "aftermath"> {
  if (!Number.isFinite(tSec)) return "quiet";
  const t = Math.max(0, tSec);
  const phase = t % 90;
  const phasePeak = 1.2 * (1 + phase / 180);
  const pressure = (arenaIntensity(phase) / phasePeak) * wavePulse(t);
  return pressure < 0.35 ? "quiet" : pressure >= 0.68 ? "crest" : "build";
}

/** One fresh encounter edge at most. Identity/phase/death authority stays in
 * BossEncounters; this owner only times the cosmetic aftermath and hysteresis. */
export class BattleBeatDirector {
  private previous: BattleBeatInput | null = null;
  private beat: BattleBeat = "quiet";
  private candidate: { beat: BattleBeat; since: number } | null = null;
  private pending: { kind: BossEncounterCue["kind"]; now: number; epoch: number } | null = null;
  private aftermathUntil = 0;

  reset(): void {
    this.previous = null;
    this.beat = "quiet";
    this.candidate = null;
    this.pending = null;
    this.aftermathUntil = 0;
  }

  observe(cue: BossEncounterCue, now: number, epoch: number): void {
    const previous = this.previous;
    if (
      !previous?.presenting ||
      previous.epoch !== epoch ||
      !Number.isFinite(now) ||
      now < previous.now ||
      now - previous.now > GAP_MS
    )
      return;
    // A defeat owns the resolving beat if several accepted cues share a frame.
    if (this.pending?.kind === "defeat" && this.pending.now === now) return;
    this.pending = { kind: cue.kind, now, epoch };
  }

  update(input: BattleBeatInput): BattleBeatFrame {
    if (!Number.isFinite(input.now) || !Number.isFinite(input.epoch)) {
      this.reset();
      return { beat: "quiet", accent: null, active: false, lockedWarning: false, reset: true };
    }
    const previous = this.previous;
    const adopt =
      previous === null ||
      previous.epoch !== input.epoch ||
      input.now < previous.now ||
      input.now - previous.now > GAP_MS ||
      previous.presenting !== input.presenting;
    this.previous = { ...input };
    let accent: BattleBeatFrame["accent"] = null;
    if (adopt || !input.presenting) {
      this.pending = null;
      this.aftermathUntil = 0;
      this.candidate = null;
    } else if (this.pending) {
      const cue = this.pending;
      this.pending = null;
      if (
        cue.epoch === input.epoch &&
        input.now >= cue.now &&
        input.now - cue.now <= CUE_MAX_AGE_MS
      ) {
        if (cue.kind === "defeat") this.aftermathUntil = cue.now + AFTERMATH_MS;
        else accent = cue.kind;
      }
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
    // A locked sight owns the view; an encounter accent cannot wait behind it.
    if (input.lockedWarning) accent = null;
    return {
      beat: this.beat,
      accent,
      active: input.presenting,
      lockedWarning: input.presenting && input.lockedWarning,
      reset: adopt,
    };
  }
}
