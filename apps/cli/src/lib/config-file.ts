import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { isJsonObject, isJsonString, type JsonValue } from "./types.js";

export type ProjectConfig = {
  slug: string;
  name?: string;
};

const FILENAME = "vibedgames.json";

/**
 * The slug grammar every surface must agree on — it is the deploy target, the
 * fork target, and the label in `{slug}.vibedgames.com`. Kept here rather than
 * per-command so a validator can't drift and reject a slug that deploy accepts.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

// Walk from `dir` up toward the filesystem root, stopping at the first
// vibedgames.json. Lets `vg deploy ./dist` pick up the config from the
// project root even when the build step doesn't copy it into the output.
function findConfigPath(dir: string): string | null {
  let current = resolve(dir);
  while (true) {
    const candidate = join(current, FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The directory containing the nearest vibedgames.json at or above `dir`,
 *  or null if none — i.e. the project root to archive as forkable source. */
export function findProjectRoot(dir: string): string | null {
  const path = findConfigPath(dir);
  return path ? dirname(path) : null;
}

export function readProjectConfig(dir: string): ProjectConfig | null {
  const path = findConfigPath(dir);
  if (!path) return null;
  const raw = readFileSync(path, "utf-8");
  const parsed: JsonValue = JSON.parse(raw);
  if (!isJsonObject(parsed) || !isJsonString(parsed.slug)) {
    throw new Error(`${FILENAME} is malformed — missing "slug".`);
  }
  const config: ProjectConfig = { slug: parsed.slug };
  if (isJsonString(parsed.name)) config.name = parsed.name;
  return config;
}

export function writeProjectConfig(dir: string, config: ProjectConfig): void {
  const path = join(dir, FILENAME);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

export function projectConfigPath(dir: string): string {
  return join(dir, FILENAME);
}
