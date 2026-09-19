import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isJsonObject, isJsonString } from "./types.js";
import type { JsonValue } from "./types.js";

export interface ProjectConfig {
  slug: string;
  name?: string;
}

const FILENAME = "vibedgames.json";

/**
 * The slug grammar every surface must agree on — it is the deploy target, the
 * fork target, and the label in `{slug}.vibedgames.com`. Kept here rather than
 * per-command so a validator can't drift and reject a slug that deploy accepts.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/u;

// Walk from `dir` up toward the filesystem root, stopping at the first
// vibedgames.json. Lets `vg deploy ./dist` pick up the config from the
// project root even when the build step doesn't copy it into the output.
const findConfigPath = (dir: string): string | null => {
  let current = path.resolve(dir);
  while (true) {
    const candidate = path.join(current, FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
};

/** The directory containing the nearest vibedgames.json at or above `dir`,
 *  or null if none — i.e. the project root to archive as forkable source. */
export const findProjectRoot = (dir: string): string | null => {
  const found = findConfigPath(dir);
  return found ? path.dirname(found) : null;
};

export const readProjectConfig = (dir: string): ProjectConfig | null => {
  const file = findConfigPath(dir);
  if (!file) {
    return null;
  }
  const raw = readFileSync(file, "utf-8");
  const parsed: JsonValue = JSON.parse(raw);
  if (!isJsonObject(parsed) || !isJsonString(parsed.slug)) {
    throw new Error(`${FILENAME} is malformed — missing "slug".`);
  }
  const config: ProjectConfig = { slug: parsed.slug };
  if (isJsonString(parsed.name)) {
    config.name = parsed.name;
  }
  return config;
};

export const writeProjectConfig = (dir: string, config: ProjectConfig): void => {
  const file = path.join(dir, FILENAME);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
};

export const projectConfigPath = (dir: string): string => path.join(dir, FILENAME);
