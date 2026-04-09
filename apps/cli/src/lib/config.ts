import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Config = {
  token: string;
  baseUrl: string;
};

function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ?? join(homedir(), ".config");
  return join(base, "vg");
}

function getConfigPath(): string {
  return join(getConfigDir(), "auth.json");
}

export function getConfig(): Config | null {
  const path = getConfigPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Config;
  } catch {
    return null;
  }
}

export function saveConfig(config: Config): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

export function clearConfig(): void {
  const path = getConfigPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function getBaseUrl(): string {
  return (
    process.env.VG_API_URL ??
    getConfig()?.baseUrl ??
    "https://vibedgames.com"
  );
}

export function getToken(): string | null {
  return getConfig()?.token ?? null;
}
