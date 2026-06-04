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
import { dirname, join, relative, sep } from "node:path";

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

  // If package.json uses pnpm-only protocols (workspace:/catalog:), a forked
  // copy wouldn't `npm install` standalone. Rewrite them to concrete installed
  // versions in the ARCHIVED package.json only (disk untouched) by staging the
  // file list into a temp dir. No protocols → no staging (fast path).
  const rewritten = files.includes("package.json") ? rewriteWorkspaceProtocols(root) : null;
  let cwd = root;
  let stage: string | null = null;
  if (rewritten) {
    stage = mkdtempSync(join(tmpDir, "stage-"));
    for (const f of files) {
      const dest = join(stage, f);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(root, f), dest);
    }
    writeFileSync(join(stage, "package.json"), rewritten);
    cwd = stage;
  }

  const path = join(tmpDir, `vg-source-${process.pid}-${files.length}.tgz`);
  try {
    await tarCreate({ gzip: true, file: path, cwd, portable: true }, files);
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
  }

  const buf = readFileSync(path);
  return {
    path,
    sha256: createHash("sha256").update(buf).digest("hex"),
    bytes: statSync(path).size,
    files,
  };
}

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/**
 * Rewrite `workspace:` / `catalog:` dep specs in package.json to the concrete
 * versions currently installed in node_modules — mirroring what `pnpm publish`
 * does — so the forked project installs from npm. Returns the rewritten JSON
 * string, or null if there's nothing to change (the common standalone case).
 */
function rewriteWorkspaceProtocols(root: string): string | null {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
  let changed = false;
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec !== "string") continue;
      if (!spec.startsWith("workspace:") && !spec.startsWith("catalog:")) continue;
      const resolved = resolveSpec(root, name, spec);
      if (resolved && resolved !== spec) {
        (deps as Record<string, string>)[name] = resolved;
        changed = true;
      }
    }
  }
  return changed ? `${JSON.stringify(pkg, null, 2)}\n` : null;
}

function resolveSpec(root: string, name: string, spec: string): string | null {
  if (spec.startsWith("workspace:")) {
    const range = spec.slice("workspace:".length);
    // Explicit range (e.g. workspace:^1.2.3) — keep the literal range.
    if (/\d/.test(range)) return range;
    const v = installedVersion(root, name);
    if (!v) return null;
    if (range === "~") return `~${v}`;
    if (range === "*") return v; // exact pin
    return `^${v}`; // "" or "^"
  }
  // catalog: / catalog:<name> — resolve to the installed version, caret-pinned.
  const v = installedVersion(root, name);
  return v ? `^${v}` : null;
}

/** Version of an installed dependency, searching node_modules up the tree. */
function installedVersion(root: string, name: string): string | null {
  let dir = root;
  while (true) {
    const p = join(dir, "node_modules", name, "package.json");
    if (existsSync(p)) {
      try {
        const v = (JSON.parse(readFileSync(p, "utf8")) as { version?: unknown }).version;
        if (typeof v === "string") return v;
      } catch {
        /* fall through to parent */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Extract a gzipped tar into `destDir` (created if needed). tar strips
 *  leading slashes and rejects `..` paths, so extraction stays inside dest. */
export async function extractSource(archivePath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  await tarExtract({ file: archivePath, cwd: destDir });
}
