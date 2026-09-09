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
export const scoreLeadIn = (beat: BattleBeat): number => {
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
    default: {
      return 1.1;
    }
  }
};

/** One finite phrase or deliberate rest. Reuse the original two timbres;
 * density and register provide contrast without increasing the music gain.
 * No random draws, clocks or graph ownership live in this score table. */
export const battlePhrase = (mode: MusicScore, beat: BattleBeat, step: number): Phrase => {
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
      // Every fourth bar breathes even at the crest. Peak note gain matches
      // the original bed; its shorter spacing supplies the extra energy.
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
    default: {
      // Aftermath: one descending fifth resolves into a sustained tonic, then
      // silence. Advancing through rests prevents pause/mode changes from
      // replaying it.
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
  }
};
