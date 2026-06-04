import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type ProjectConfig = {
  slug: string;
  name?: string;
};

const FILENAME = "vibedgames.json";

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
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("slug" in parsed) ||
    typeof (parsed as { slug: unknown }).slug !== "string"
  ) {
    throw new Error(`${FILENAME} is malformed — missing "slug".`);
  }
  return parsed as ProjectConfig;
}

export function writeProjectConfig(dir: string, config: ProjectConfig): void {
  const path = join(dir, FILENAME);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

export function projectConfigPath(dir: string): string {
  return join(dir, FILENAME);
}
