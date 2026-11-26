import type { BattleBeat } from "../render/battle-beat";

export type MusicMode = "silent" | "flight" | "boss";

export type MusicScore = Exclude<MusicMode, "silent">;

interface Note {
  rate: number;
  gain: number;
  delay: number;
}

interface Phrase {
  waitSeconds: number;
  notes: readonly [] | readonly [Note] | readonly [Note, Note];
}

const FLIGHT_BUILD = [1, 1.125, 1.25, 1.5];
const BOSS_BUILD = [1, 1.125, 1.2, 1.5];
const CREST_ROOTS = [1.5, 1.25, 1.125, 1];
const QUIET_ROOTS = [1, 0.75, 1.125];

/** Leave space for existing arrival/phase/defeat cues before the new bed. */
export const scoreLeadIn = (beat: BattleBeat) => {
  switch (beat) {
    case "quiet": {
      return 1.5;
    }

    case "build": {
      return 0.5;
    }

    case "crest": {
      return 0.65;
    }

    case "aftermath": {
      return 1.1;
    }

    default: {
      const unhandled: never = beat;
      throw new Error("unhandled case", { cause: unhandled });
    }
  }
};

/** One finite phrase or deliberate rest. Reuse the original two timbres;
 * density and register provide contrast without increasing the music gain.
 * No random draws, clocks or graph ownership live in this score table. */
export const battlePhrase: (mode: MusicScore, beat: BattleBeat, step: number) => Phrase = (
  mode,
  beat,
  step,
) => {
  switch (beat) {
    case "quiet": {
      if (step % 4 === 3) {
        return { notes: [], waitSeconds: 12 };
      }

      const root = QUIET_ROOTS[step % QUIET_ROOTS.length] ?? 1;

      return { notes: [{ delay: 0, gain: 0.5, rate: root }], waitSeconds: 12 };
    }

    case "build": {
      const roots = mode === "flight" ? FLIGHT_BUILD : BOSS_BUILD;
      const root = roots[step % roots.length] ?? 1;

      return {
        notes: [
          { delay: 0, gain: 0.72, rate: root },
          { delay: 0.32, gain: 0.4, rate: root * 1.5 },
        ],
        waitSeconds: mode === "flight" ? 6.4 : 5.2,
      };
    }

    case "crest": {
      if (step % 4 === 3) {
        return { notes: [], waitSeconds: 3.6 };
      }

      const root = CREST_ROOTS[step % CREST_ROOTS.length] ?? 1;

      return {
        notes: [
          { delay: 0, gain: 1, rate: root },
          { delay: 0.22, gain: 0.55, rate: root * (mode === "flight" ? 1.25 : 1.2) },
        ],
        waitSeconds: mode === "flight" ? 3.6 : 3,
      };
    }

    case "aftermath": {
      return step === 0
        ? {
            notes: [
              { delay: 0, gain: 0.64, rate: 1.5 },
              { delay: 0.52, gain: 0.38, rate: 1 },
            ],
            waitSeconds: 12,
          }
        : { notes: [], waitSeconds: 12 };
    }

    default: {
      const unhandled: never = beat;
      throw new Error("unhandled case", { cause: unhandled });
    }
  }
};
