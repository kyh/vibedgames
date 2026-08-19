import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { getConfigDir } from "./config.js";
import { isJsonNumber, isJsonObject, isJsonString, type JsonValue } from "./types.js";
import { join } from "node:path";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function getCachePath(): string {
  return join(getConfigDir(), "update-check.json");
}

function getLastCheckedAt(): number {
  const path = getCachePath();
  if (!existsSync(path)) return 0;
  try {
    const data: JsonValue = JSON.parse(readFileSync(path, "utf-8"));
    if (isJsonObject(data)) {
      const ts = data.lastCheckedAt;
      if (isJsonNumber(ts)) return ts;
    }
  } catch {
    // corrupt cache — treat as never checked
  }
  return 0;
}

export function markUpdateChecked(): void {
  const dir = getConfigDir();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(getCachePath(), JSON.stringify({ lastCheckedAt: Date.now() }, null, 2));
  } catch {
    // best-effort; worst case we check again next run
  }
}

export function isNewerVersion(latest: string, current: string): boolean {
  if (!VERSION_RE.test(latest) || !VERSION_RE.test(current)) return false;
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

export async function fetchLatestVersion(): Promise<string | null> {
  const registry = process.env.VG_REGISTRY_URL ?? "https://registry.npmjs.org";
  try {
    const res = await fetch(`${registry}/vibedgames/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    // SAFETY: res.json() is JSON.parse of the response body, which is
    // structurally JsonValue.
    const data = (await res.json()) as JsonValue;
    if (isJsonObject(data)) {
      const version = data.version;
      if (isJsonString(version)) return version;
    }
  } catch {
    // offline or registry down — skip this round
  }
  return null;
}

/**
 * Fire-and-forget background update: at most once per day (and never in CI
 * or with VG_NO_AUTO_UPDATE set), re-invoke this CLI as a detached
 * `vg update --auto`, which only applies anything when npm has a newer
 * version. The foreground command pays no latency and prints nothing.
 */
export function maybeScheduleAutoUpdate(): void {
  if (process.env.VG_NO_AUTO_UPDATE || process.env.CI) return;
  const script = process.argv[1];
  if (!script) return;
  if (Date.now() - getLastCheckedAt() < CHECK_INTERVAL_MS) return;
  markUpdateChecked();
  try {
    const child = spawn(process.execPath, [script, "update", "--auto"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // best-effort; worst case we try again next run
  }
}
