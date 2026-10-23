import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { contentTypeForPath } from "@repo/contract/deploy/content-types";

export interface ManifestFile {
  /** forward-slash relative path, e.g. "assets/sprite.png" */
  path: string;
  /** absolute filesystem path */
  absolutePath: string;
  size: number;
  sha256: string;
  contentType: string;
}

const IGNORED_TOP_LEVEL = new Set([
  "node_modules",
  ".git",
  ".turbo",
  ".cache",
  ".DS_Store",
  "vibedgames.json",
]);

const shouldIgnore = (relPath: string): boolean => {
  const top = relPath.split(path.sep)[0] ?? "";
  if (IGNORED_TOP_LEVEL.has(top)) {
    return true;
  }
  // skip hidden files anywhere in the tree
  if (relPath.split(path.sep).some((seg) => seg.startsWith("."))) {
    return true;
  }
  return false;
};

export const buildManifest = (rootDir: string): ManifestFile[] => {
  const files: ManifestFile[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootDir, abs);
      if (shouldIgnore(rel)) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const stat = statSync(abs);
      const buf = readFileSync(abs);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const posixPath = rel.split(path.sep).join("/");

      files.push({
        absolutePath: abs,
        contentType: contentTypeForPath(posixPath),
        path: posixPath,
        sha256,
        size: stat.size,
      });
    }
  };

  walk(rootDir);
  return files;
};
