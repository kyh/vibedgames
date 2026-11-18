import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import ignore from "ignore";
import { create as tarCreate, extract as tarExtract } from "tar";

import { isJsonObject, isJsonString } from "./types.js";
import type { JsonValue } from "./types.js";

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
  // WARNING: secrets below must never ship in an archive.
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
  "*.tgz",
  "*.tar.gz",
];

export interface SourceArchive {
  /** absolute path to the temp .tgz */
  path: string;
  sha256: string;
  bytes: number;
  /** posix relative paths included, for display */
  files: string[];
}

const buildIgnorer: (root: string) => (rel: string) => boolean = (root) => {
  const hard = ignore().add(HARD_EXCLUDES);
  const user = ignore();

  for (const name of [".gitignore", ".vibedgamesignore"]) {
    const p = path.join(root, name);

    if (existsSync(p)) {
      user.add(readFileSync(p, "utf-8"));
    }
  }

  return (rel) => hard.ignores(rel) || user.ignores(rel);
};

const collectFiles = (root: string, ignored: (rel: string) => boolean) => {
  const out: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");

      if (!rel) {
        continue;
      }

      if (entry.isDirectory()) {
        if (ignored(`${rel}/`) || ignored(rel)) {
          continue;
        }

        walk(abs);
      } else if (entry.isFile()) {
        if (ignored(rel)) {
          continue;
        }

        out.push(rel);
      }
    }
  };

  walk(root);

  return out.toSorted();
};

const installedVersion = (root: string, name: string) => {
  let dir = root;

  while (true) {
    const p = path.join(dir, "node_modules", name, "package.json");

    if (existsSync(p)) {
      try {
        const pkg: JsonValue = JSON.parse(readFileSync(p, "utf-8"));
        const v = isJsonObject(pkg) ? pkg.version : undefined;

        if (isJsonString(v)) {
          return v;
        }
      } catch {}
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      return null;
    }

    dir = parent;
  }
};

const resolveSpec = (root: string, name: string, spec: string) => {
  if (spec.startsWith("workspace:")) {
    const range = spec.slice("workspace:".length);

    if (/\d/u.test(range)) {
      return range;
    }

    const v = installedVersion(root, name);

    if (!v) {
      return null;
    }

    if (range === "~") {
      return `~${v}`;
    }

    if (range === "*") {
      return v;
    }

    return `^${v}`;
  }

  const v = installedVersion(root, name);

  return v ? `^${v}` : null;
};

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const rewriteWorkspaceProtocols = (root: string) => {
  let pkg: JsonValue;

  try {
    pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
  } catch {
    return null;
  }

  if (!isJsonObject(pkg)) {
    return null;
  }

  let changed = false;

  for (const field of DEP_FIELDS) {
    const deps = pkg[field];

    if (!isJsonObject(deps)) {
      continue;
    }

    for (const [name, spec] of Object.entries(deps)) {
      if (!isJsonString(spec)) {
        continue;
      }

      if (!spec.startsWith("workspace:") && !spec.startsWith("catalog:")) {
        continue;
      }

      const resolved = resolveSpec(root, name, spec);

      if (resolved && resolved !== spec) {
        deps[name] = resolved;
        changed = true;
      }
    }
  }

  return changed ? `${JSON.stringify(pkg, null, 2)}\n` : null;
};

/**
 * Create a gzipped tar of `root`'s source (respecting .gitignore +
 * HARD_EXCLUDES) at a temp path. Returns the archive path, its sha256, byte
 * size, and the list of included files.
 */
export const packSource = async (root: string, tmpDir: string) => {
  const ignored = buildIgnorer(root);
  const files = collectFiles(root, ignored);

  if (files.length === 0) {
    throw new Error("No source files to archive (everything was ignored?).");
  }

  mkdirSync(tmpDir, { recursive: true });

  const rewritten = files.includes("package.json") ? rewriteWorkspaceProtocols(root) : null;
  let cwd = root;
  let stage: string | null = null;

  if (rewritten) {
    stage = mkdtempSync(path.join(tmpDir, "stage-"));

    for (const f of files) {
      const dest = path.join(stage, f);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(path.join(root, f), dest);
    }

    writeFileSync(path.join(stage, "package.json"), rewritten);
    cwd = stage;
  }

  const tarball = path.join(tmpDir, `vg-source-${process.pid}-${files.length}.tgz`);

  try {
    await tarCreate({ cwd, file: tarball, gzip: true, portable: true }, files);
  } finally {
    if (stage) {
      rmSync(stage, { force: true, recursive: true });
    }
  }

  const buf = readFileSync(tarball);

  return {
    bytes: statSync(tarball).size,
    files,
    path: tarball,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
};

/**
 * A deploy bundle: the build's files as a gzipped tar at a temp path, rooted
 * at `dir` so `index.html` sits at the top, as `deploy.upload` unpacks it.
 */
export const packBuild = async (dir: string, files: string[], tmpDir: string) => {
  mkdirSync(tmpDir, { recursive: true });
  const tarball = path.join(tmpDir, `vg-build-${process.pid}-${files.length}.tgz`);
  await tarCreate({ cwd: dir, file: tarball, gzip: true, portable: true }, files);

  return { bytes: statSync(tarball).size, path: tarball };
};

/** Extract a gzipped tar into `destDir` (created if needed). tar strips
 *  leading slashes and rejects `..` paths, so extraction stays inside dest. */
export const extractSource = async (archivePath: string, destDir: string) => {
  mkdirSync(destDir, { recursive: true });
  await tarExtract({ cwd: destDir, file: archivePath });
};
