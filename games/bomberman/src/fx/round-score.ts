export type RoundScoreMode = "silent" | "playing" | "duel";
export type ScoreBeat = Readonly<{ mode: "playing" | "duel"; step: number }>;
type ScoreFrame = { kind: "rebase" } | { kind: "beat"; beat: ScoreBeat };

/** A render-driven metronome: emits at most the current beat, never a missed
 * queue. Pauses, transport gaps, mode changes and clock rewinds all rebase. */
export class RoundScore {
  private mode: RoundScoreMode = "silent";
  private origin = 0;
  private previous: number | null = null;
  private step = 0;

  reset(): void {
    this.mode = "silent";
    this.previous = null;
    this.origin = 0;
    this.step = 0;
  }

  observe(mode: RoundScoreMode, nowMs: number): ScoreFrame | null {
    if (!Number.isFinite(nowMs) || mode === "silent") {
      this.reset();
      return { kind: "rebase" };
    }
    const gap = this.previous === null ? Infinity : nowMs - this.previous;
    this.previous = nowMs;
    if (mode !== this.mode || gap < 0 || gap > 750) {
      this.mode = mode;
      this.origin = nowMs;
      this.step = 0;
      return { kind: "rebase" };
    }
    const step = Math.floor((nowMs - this.origin) / (mode === "duel" ? 300 : 400));
    if (step === this.step) {
      return null;
    }
    const skipped = step - this.step > 1;
    this.step = step;
    return skipped ? { kind: "rebase" } : { beat: { mode, step: step % 16 }, kind: "beat" };
  }
}

/** Deliberate rests keep the courtyard open; the duel adds responses, not
 * volume. Two-note downbeats are the only simultaneous background phrase. */
export const scoreNotes = (beat: ScoreBeat): readonly number[] => {
  switch (beat.step) {
    case 0: {
      return [146.83, 293.66];
    }
    case 3: {
      return [440];
    }
    case 7: {
      return [329.63];
    }
    case 8: {
      return [164.81, 392];
    }
    case 11: {
      return [293.66];
    }
    case 2:
    case 10: {
      return beat.mode === "duel" ? [220] : [];
    }
    case 4:
    case 12: {
      return beat.mode === "duel" ? [329.63] : [];
    }
    case 15: {
      return beat.mode === "duel" ? [246.94] : [];
    }
    default: {
      return [];
    }
  }
};
