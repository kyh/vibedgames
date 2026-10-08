import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getConfigDir } from "./config.js";
import { isJsonObject, isJsonString } from "./types.js";
import type { JsonObject, JsonValue } from "./types.js";

/**
 * Persistent CLI preferences, written by `vg config set` to `config.json` in
 * the vg config dir. Each one can also come from an environment variable,
 * which wins over the saved value for that process.
 */

export type SettingKey = "generate.provider" | "generate.codex-bin" | "update.auto";

interface SettingSpec {
  description: string;
  default: string;
  /** The values `vg config set` accepts; omitted for a free-form string. */
  values?: readonly string[];
  env: {
    name: string;
    /** The setting value a set (non-empty) variable stands for. */
    read: (raw: string) => string;
  };
}

export const SETTINGS: Record<SettingKey, SettingSpec> = {
  "generate.codex-bin": {
    default: "codex",
    description: "The codex binary the codex provider runs.",
    env: { name: "VG_CODEX_BIN", read: (raw) => raw },
  },
  "generate.provider": {
    default: "vibedgames",
    description:
      "Where `vg generate run` sends work. codex: OpenAI image runs that Codex can serve go to your own Codex plan; everything else stays on vibedgames. `--provider` overrides it for one run.",
    env: { name: "VG_GENERATE_PROVIDER", read: (raw) => raw.trim().toLowerCase() },
    values: ["vibedgames", "codex"],
  },
  "update.auto": {
    default: "true",
    description: "Update the CLI and installed skills in the background, at most once a day.",
    env: { name: "VG_NO_AUTO_UPDATE", read: () => "false" },
    values: ["true", "false"],
  },
};

export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SETTINGS, key);

export const SETTING_KEYS: SettingKey[] = Object.keys(SETTINGS).filter((key) => isSettingKey(key));

export type SettingSource = "env" | "config" | "default";

export interface ResolvedSetting {
  key: SettingKey;
  value: string;
  source: SettingSource;
}

export const settingsPath = (): string => path.join(getConfigDir(), "config.json");

/** The saved file as an object; empty when missing or unreadable. */
const readFile = (): JsonObject => {
  const file = settingsPath();
  if (!existsSync(file)) {
    return {};
  }
  try {
    const data: JsonValue = JSON.parse(readFileSync(file, "utf-8"));
    return isJsonObject(data) ? data : {};
  } catch {
    return {};
  }
};

const writeFile = (data: JsonObject): void => {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700, recursive: true });
  }
  writeFileSync(settingsPath(), `${JSON.stringify(data, null, 2)}\n`);
};

/** A saved value, if it is one the setting accepts. */
const savedValue = (data: JsonObject, key: SettingKey): string | null => {
  const value = data[key];
  return isJsonString(value) && validate(key, value) === null ? value : null;
};

/** Null when `value` is acceptable for `key`, else why not. */
export const validate = (key: SettingKey, value: string): string | null => {
  const { values } = SETTINGS[key];
  if (values && !values.includes(value)) {
    return `${key} must be one of: ${values.join(", ")}.`;
  }
  if (value.trim() === "") {
    return `${key} can't be empty.`;
  }
  return null;
};

/** The effective value of `key`: its env var, else the saved value, else the default. */
export const resolveSetting = (
  key: SettingKey,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSetting => {
  const spec = SETTINGS[key];
  const raw = env[spec.env.name];
  if (raw !== undefined && raw !== "") {
    return { key, source: "env", value: spec.env.read(raw) };
  }
  const saved = savedValue(readFile(), key);
  if (saved !== null) {
    return { key, source: "config", value: saved };
  }
  return { key, source: "default", value: spec.default };
};

export const saveSetting = (key: SettingKey, value: string): void => {
  writeFile({ ...readFile(), [key]: value });
};

/** Remove a saved value; false when there was none. */
export const removeSetting = (key: SettingKey): boolean => {
  const data = readFile();
  if (!Object.hasOwn(data, key)) {
    return false;
  }
  writeFile(Object.fromEntries(Object.entries(data).filter(([name]) => name !== key)));
  return true;
};
