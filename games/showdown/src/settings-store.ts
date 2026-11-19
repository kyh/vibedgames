import { isDifficultyName, isQualityName } from "./config";
import type { QualityName } from "./config";
import { isJsonBoolean, isJsonNumber, isJsonObject, isJsonString, parseJson } from "./json";
import type { JsonValue } from "./json";

export const SETTINGS_KEY = "showdown-settings";

export interface SavedSettings {
  ao?: boolean;
  autoTime?: boolean;
  bloom?: boolean;
  difficulty?: string;
  muted?: boolean;
  quality?: string;
  time?: number;
}

const readStored: () => JsonValue = () => {
  try {
    return parseJson(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
};

export const loadSettings = () => {
  const stored = readStored();

  if (!isJsonObject(stored)) {
    return {};
  }

  return {
    ao: isJsonBoolean(stored.ao) ? stored.ao : undefined,
    autoTime: isJsonBoolean(stored.autoTime) ? stored.autoTime : undefined,
    bloom: isJsonBoolean(stored.bloom) ? stored.bloom : undefined,
    difficulty: isJsonString(stored.difficulty) ? stored.difficulty : undefined,
    muted: isJsonBoolean(stored.muted) ? stored.muted : undefined,
    quality: isJsonString(stored.quality) ? stored.quality : undefined,
    time: isJsonNumber(stored.time) ? stored.time : undefined,
  };
};

export const storeSettings = (settings: SavedSettings) => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

    return true;
  } catch {
    return false;
  }
};

export interface QualityChoice {
  name: QualityName;
  /** True when the player (or a `?q=` param) chose, so auto-tuning must stay out. */
  userPicked: boolean;
}

/** `?q=` wins over the saved choice; otherwise phones start a tier lower. */
export const resolveQuality = (
  param: string | null,
  saved: SavedSettings,
  coarsePointer: boolean,
) => {
  const requested = param || saved.quality || (coarsePointer ? "medium" : "high");

  return {
    name: isQualityName(requested) ? requested : "high",
    userPicked: Boolean(param || saved.quality),
  };
};

export const resolveDifficulty = (param: string | null, saved: SavedSettings) => {
  const requested = param || saved.difficulty || "";

  return isDifficultyName(requested) ? requested : "normal";
};
