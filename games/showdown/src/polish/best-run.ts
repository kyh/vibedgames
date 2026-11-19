import { isJsonNumber, isJsonObject, parseJson } from "../json";
import type { JsonValue } from "../json";

const BEST_KEY = "showdown-best";

export interface RunResult {
  cubes: number;
  kills: number;
  rank: number;
}

const readRun = (value: JsonValue) => {
  if (!isJsonObject(value)) {
    return null;
  }

  const { cubes, kills, rank } = value;

  if (!(isJsonNumber(cubes) && isJsonNumber(kills) && isJsonNumber(rank))) {
    return null;
  }

  return { cubes, kills, rank };
};

const loadBestRun = () => {
  try {
    return readRun(parseJson(localStorage.getItem(BEST_KEY) ?? "null"));
  } catch {
    return null;
  }
};

const storeBestRun = (best: RunResult) => {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(best));

    return true;
  } catch {
    return false;
  }
};

const beats = (run: RunResult, best: RunResult | null) =>
  best === null || run.rank < best.rank || (run.rank === best.rank && run.kills > best.kills);

export interface RunVerdict {
  /** One short line for the result screen. */
  line: string;
  record: boolean;
}

/** Record the run if it is a new best and describe how it compares. */
export const recordRun = (run: RunResult) => {
  const best = loadBestRun();

  if (beats(run, best)) {
    storeBestRun(run);

    return {
      line: best === null ? "First brawl on the books" : `New best - was #${best.rank}`,
      record: true,
    };
  }

  if (best === null) {
    return { line: "", record: false };
  }

  const gap = run.rank - best.rank;

  return {
    line: gap === 0 ? `Matches your best #${best.rank}` : `Best #${best.rank} - ${gap} away`,
    record: false,
  };
};
