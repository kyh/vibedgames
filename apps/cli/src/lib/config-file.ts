import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ProjectConfig = {
  slug: string;
  name?: string;
};

const FILENAME = "vibedgames.json";

export function readProjectConfig(dir: string): ProjectConfig | null {
  const path = join(dir, FILENAME);
  if (!existsSync(path)) return null;
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
