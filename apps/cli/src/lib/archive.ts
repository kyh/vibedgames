import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ignore from "ignore";
import { create as tarCreate, extract as tarExtract } from "tar";

/**
 * Patterns ALWAYS excluded from a source archive, regardless of .gitignore —
 * build output, VCS internals, and (critically) secrets. Source upload is a
 * publish: anything left in the folder becomes forkable by anyone.
 */
const HARD_EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".vercel",
  ".wrangler",
  "coverage",
  ".DS_Store",
  "*.log",
  // secrets — never ship these
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".npmrc",
  ".git-credentials",
  // archives (avoid bundling our own output)
  "*.tgz",
  "*.tar.gz",
];

export type SourceArchive = {
  /** absolute path to the temp .tgz */
  path: string;
  sha256: string;
  bytes: number;
  /** posix relative paths included, for display */
  files: string[];
};

/**
 * Build the exclusion predicate. HARD_EXCLUDES live in their OWN matcher,
 * checked independently of the user's .gitignore/.vibedgamesignore — so a
 * negation like `!.env` in a user ignore file can NOT un-exclude a secret.
 * A path is excluded if EITHER matcher says so.
 */
function buildIgnorer(root: string): (rel: string) => boolean {
  const hard = ignore().add(HARD_EXCLUDES);
  const user = ignore();
  for (const name of [".gitignore", ".vibedgamesignore"]) {
    const p = join(root, name);
    if (existsSync(p)) user.add(readFileSync(p, "utf8"));
  }
  return (rel) => hard.ignores(rel) || user.ignores(rel);
}

/** Walk `root`, returning posix relative paths of files not ignored. Ignored
 *  directories are pruned (not descended into) for speed. */
function collectFiles(root: string, ignored: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (!rel) continue;
      // `ignore` matches dirs via a trailing slash; test both forms.
      if (entry.isDirectory()) {
        if (ignored(`${rel}/`) || ignored(rel)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        if (ignored(rel)) continue;
        out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Create a gzipped tar of `root`'s source (respecting .gitignore +
 * HARD_EXCLUDES) at a temp path. Returns the archive path, its sha256, byte
 * size, and the list of included files.
 */
export async function packSource(root: string, tmpDir: string): Promise<SourceArchive> {
  const ignored = buildIgnorer(root);
  const files = collectFiles(root, ignored);
  if (files.length === 0) {
    throw new Error("No source files to archive (everything was ignored?).");
  }
  mkdirSync(tmpDir, { recursive: true });
  const path = join(tmpDir, `vg-source-${process.pid}-${files.length}.tgz`);
  await tarCreate({ gzip: true, file: path, cwd: root, portable: true }, files);

  const buf = readFileSync(path);
  return {
    path,
    sha256: createHash("sha256").update(buf).digest("hex"),
    bytes: statSync(path).size,
    files,
  };
}

/** Extract a gzipped tar into `destDir` (created if needed). tar strips
 *  leading slashes and rejects `..` paths, so extraction stays inside dest. */
export async function extractSource(archivePath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  await tarExtract({ file: archivePath, cwd: destDir });
}
