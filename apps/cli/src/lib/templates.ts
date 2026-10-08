import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The engine templates `vg new` scaffolds from. They ship inside the CLI
 * package (`apps/cli/templates/<id>`), so scaffolding needs no network.
 *
 * Two levels up from this module is the package root both from source
 * (`src/lib`) and from the build (`dist/lib`).
 */
export const TEMPLATES_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));

/** Replaced with the game's slug in every text file a template carries. */
export const SLUG_TOKEN = "__VG_SLUG__";

const TEXT_EXTENSIONS = new Set([".css", ".html", ".json", ".md", ".ts", ".tsx"]);

// What a local install or build of a template leaves behind; never part of it.
const SKIPPED_ENTRIES = new Set([".turbo", "dist", "node_modules"]);

// npm never publishes a file named `.gitignore`, so a template carries this
// name and the copy restores the dot.
const GITIGNORE_STAND_IN = "_gitignore";

/**
 * Copy the bundled template `template` into `target`, substituting the slug.
 * A file that already exists in `target` is kept unless `force`; the kept
 * paths (relative to `target`) are returned so the caller can say so.
 */
export const copyTemplate = (
  template: string,
  target: string,
  slug: string,
  force: boolean,
  templatesDir: string = TEMPLATES_DIR,
): string[] => {
  const root = path.join(templatesDir, template);
  if (!existsSync(root)) {
    throw new Error(`No bundled template named "${template}" in ${templatesDir}.`);
  }
  const kept: string[] = [];
  const walk = (from: string, relative: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (SKIPPED_ENTRIES.has(entry.name)) {
        continue;
      }
      const source = path.join(from, entry.name);
      const name = entry.name === GITIGNORE_STAND_IN ? ".gitignore" : entry.name;
      const relativePath = path.join(relative, name);
      if (entry.isDirectory()) {
        walk(source, relativePath);
        continue;
      }
      const destination = path.join(target, relativePath);
      if (existsSync(destination) && !force) {
        kept.push(relativePath);
        continue;
      }
      mkdirSync(path.dirname(destination), { recursive: true });
      if (TEXT_EXTENSIONS.has(path.extname(name))) {
        writeFileSync(destination, readFileSync(source, "utf-8").replaceAll(SLUG_TOKEN, slug));
      } else {
        copyFileSync(source, destination);
      }
    }
  };
  walk(root, "");
  return kept;
};
