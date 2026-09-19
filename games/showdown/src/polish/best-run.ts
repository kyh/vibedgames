// The one thing that survives a lost match: your best finish. The result
// screen reads it back as a delta ("Best: #2") so a loss lands as an approach,
// not a dead end, and a new record is called out the moment it happens.

const BEST_KEY = "showdown-best";

export interface RunResult {
  cubes: number;
  kills: number;
  rank: number;
}

// What JSON.parse can hand back; scalars are told apart without `typeof`.
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  value instanceof Object && !Array.isArray(value);

const isJsonNumber = (value: JsonValue | undefined): value is number => Number.isFinite(value);

/** `JSON.parse`, typed at the boundary: its output is a JSON value by construction. */
const parseJson = (text: string): JsonValue => JSON.parse(text);

const readRun = (value: JsonValue): RunResult | null => {
  if (!isJsonObject(value)) {
    return null;
  }
  const { cubes, kills, rank } = value;
  if (!(isJsonNumber(cubes) && isJsonNumber(kills) && isJsonNumber(rank))) {
    return null;
  }
  return { cubes, kills, rank };
};

export const loadBestRun = (): RunResult | null => {
  try {
    return readRun(parseJson(localStorage.getItem(BEST_KEY) ?? "null"));
  } catch {
    return null;
  }
};

const storeBestRun = (best: RunResult): void => {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(best));
  } catch {
    // Private mode or a full quota: the record simply does not persist.
  }
};

/** A lower rank wins; kills break ties. */
const beats = (run: RunResult, best: RunResult | null): boolean =>
  best === null || run.rank < best.rank || (run.rank === best.rank && run.kills > best.kills);

export interface RunVerdict {
  /** One short line for the result screen. */
  line: string;
  record: boolean;
}

/** Record the run if it is a new best and describe how it compares. */
export const recordRun = (run: RunResult): RunVerdict => {
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
