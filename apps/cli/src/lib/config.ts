import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isJsonNumber, isJsonObject, isJsonString } from "./types.js";
import type { JsonValue } from "./types.js";

/**
 * A saved login. `vg login` saves an OAuth access token with its refresh
 * token and expiry (ms since epoch); logins from before it saved a session
 * token alone, which keeps working until its session ends.
 */
export interface Config {
  baseUrl: string;
  expiresAt?: number;
  refreshToken?: string;
  token: string;
}

export const getConfigDir = (): string => {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ?? path.join(homedir(), ".config");
  return path.join(base, "vg");
};

const getConfigPath = (): string => path.join(getConfigDir(), "auth.json");

export const getConfig = (): Config | null => {
  const file = getConfigPath();
  if (!existsSync(file)) {
    return null;
  }
  let raw: JsonValue;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  // auth.json is only ever written by saveConfig, so both fields are present
  // in practice; a hand-corrupted file reads as "not logged in".
  if (!isJsonObject(raw)) {
    return null;
  }
  const { baseUrl, expiresAt, refreshToken, token } = raw;
  if (!isJsonString(token) || !isJsonString(baseUrl)) {
    return null;
  }
  return {
    baseUrl,
    expiresAt: isJsonNumber(expiresAt) ? expiresAt : undefined,
    refreshToken: isJsonString(refreshToken) ? refreshToken : undefined,
    token,
  };
};

export const saveConfig = (config: Config): void => {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700, recursive: true });
  }
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
};

export const clearConfig = (): void => {
  const file = getConfigPath();
  if (existsSync(file)) {
    unlinkSync(file);
  }
};

export const getBaseUrl = (): string =>
  process.env.VG_API_URL ?? getConfig()?.baseUrl ?? "https://vibedgames.com";

export const getToken = (): string | null =>
  // VG_TOKEN lets local/CI runs authenticate without touching the saved
  // login (e.g. a seeded dev session), so headless testing never clobbers
  // the user's real `vg login` credentials.
  process.env.VG_TOKEN ?? getConfig()?.token ?? null;
