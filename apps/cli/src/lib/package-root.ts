import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { PKG_NAME } from "./package-manager.js";
import { isJsonObject, isJsonString } from "./types.js";
import type { JsonValue } from "./types.js";

/**
 * The CLI's own package, wherever it is installed: the nearest directory
 * above this module whose package.json names it. Found rather than spelled
 * as `../..`, because a source file (`src/lib/`) and the bundle's chunks
 * (`dist/`) sit at different depths below it.
 */
interface InstalledPackage {
  root: string;
  version: string;
}

const findPackage = (dir: string): InstalledPackage => {
  const manifestPath = path.join(dir, "package.json");
  if (existsSync(manifestPath)) {
    const manifest: JsonValue = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (isJsonObject(manifest) && manifest.name === PKG_NAME && isJsonString(manifest.version)) {
      return { root: dir, version: manifest.version };
    }
  }
  const parent = path.dirname(dir);
  if (parent === dir) {
    throw new Error(`No ${PKG_NAME} package.json above ${import.meta.filename}.`);
  }
  return findPackage(parent);
};

const found = findPackage(import.meta.dirname);

/** The installed package's root: `dist/`, `templates/` and package.json sit in it. */
export const PACKAGE_ROOT = found.root;

/** The installed CLI's version. */
export const PACKAGE_VERSION = found.version;
