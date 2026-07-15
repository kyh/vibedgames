import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateLegacyLayout } from "./state.ts";

/** Is `dir` the vibedgames monorepo root? (not just any pnpm workspace) */
const isVibedgamesRepo = (dir: string): boolean =>
  existsSync(resolve(dir, "pnpm-workspace.yaml")) && existsSync(resolve(dir, "apps/factory"));

/**
 * Find the vibedgames monorepo root, or null when running installed (from
 * npm) / outside a checkout. In the repo the orchestrator runs `claude` with
 * the dogfooded skills from `<repoRoot>/.claude/skills`; installed, the game
 * workspace gets its own skills via `vg init` (see preflight.ts) and callers
 * must not assume a repo exists.
 */
export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = start;
  for (let i = 0; i < 25; i++) {
    if (isVibedgamesRepo(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Running the checkout's sources from an unrelated cwd: this file lives at
  // apps/factory/src/config.ts in the repo. An npm install fails this probe.
  const fromSource = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return isVibedgamesRepo(fromSource) ? fromSource : null;
}

/**
 * Where games live when no folder is given: gitignored .workspaces inside the
 * repo during development; a visible ~/vibedgames/<slug> for installed users —
 * stable regardless of cwd, so start/stop/status/approve always agree.
 */
export function defaultWorkspace(slug: string): string {
  const repoRoot = findRepoRoot();
  return repoRoot
    ? resolve(repoRoot, "apps/factory/.workspaces", slug)
    : resolve(homedir(), "vibedgames", slug);
}

/** Human label for where a new game would land ("~/vibedgames/<slug>"). */
export function defaultWorkspaceLabel(): string {
  const repoRoot = findRepoRoot();
  return repoRoot ? "apps/factory/.workspaces/<slug>" : "~/vibedgames/<slug>";
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * Validate + normalize a slug before it's ever used to build a filesystem
 * path. Rejecting anything outside [a-z0-9-] keeps `..`/path segments from
 * resolving `.vgfactory` outside the workspaces dir. Returns null when invalid.
 */
export function normalizeSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase();
  return SLUG_RE.test(slug) ? slug : null;
}

/**
 * Loosely coerce arbitrary text (a folder name, the first words of an idea)
 * into a valid slug, or null when nothing usable survives. Long results are
 * clipped at a word boundary so derived subdomains stay readable.
 */
export function slugify(raw: string): string | null {
  let s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 28) {
    s = s.slice(0, 28);
    const cut = s.lastIndexOf("-");
    if (cut > 8) s = s.slice(0, cut);
    s = s.replace(/-+$/, "");
  }
  return normalizeSlug(s);
}

/**
 * The slug is only the game's deploy identity ({slug}.vibedgames.com and the
 * default workspace name) — it doesn't need to be asked for upfront. Derive
 * it: an explicit slug wins (validated, not coerced), then the folder's name,
 * then the first words of the instructions. Null when nothing is usable.
 */
const SLUG_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "with",
  "of",
  "and",
  "or",
  "for",
  "to",
  "in",
  "on",
  "that",
  "where",
  "every",
  "your",
  "you",
  "my",
  "is",
  "it",
  "its",
  "as",
  "by",
  "like",
]);

export function deriveSlug(input: { slug?: string; dir?: string; idea?: string }): string | null {
  const explicit = input.slug?.trim();
  if (explicit) return normalizeSlug(explicit);
  if (input.dir?.trim()) {
    const fromDir = slugify(basename(resolve(input.dir)));
    if (fromDir) return fromDir;
  }
  const idea = input.idea?.trim();
  if (idea) {
    // Keep the idea's meaningful words ("a tower defense with singing frogs"
    // → tower-defense-singing), falling back to the raw words if filtering
    // eats everything.
    const words = idea.toLowerCase().split(/\s+/);
    const meaningful = words.filter((w) => !SLUG_STOPWORDS.has(w.replace(/[^a-z0-9]/g, "")));
    return slugify((meaningful.length > 0 ? meaningful : words).slice(0, 3).join(" "));
  }
  return null;
}

/**
 * For idea-derived names only: two different games seeded with similar ideas
 * must not silently share (and resume) one workspace — suffix until free. An
 * explicit slug or folder expresses resume/adopt intent, so this never applies
 * there.
 */
export function availableSlug(base: string): string {
  // Probe legacy blackboard names too: a pre-rename workspace is still taken
  // (it gets migrated to .vgfactory/ the moment it's resumed).
  const taken = (s: string): boolean =>
    [".vgfactory", ".agent", ".studio"].some((dir) =>
      existsSync(resolve(defaultWorkspace(s), dir, "state.json")),
    );
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) {
    if (!taken(`${base}-${i}`)) return `${base}-${i}`;
  }
  return base; // 99 same-named games: let it resume rather than error
}

/**
 * Resolve a game's project directory from its slug and an optional --dir /
 * folder override, migrating any pre-rename `.studio/` layout before anything
 * inspects the blackboard.
 */
export function resolveWorkspace(slug: string, override?: string): string {
  const workspace = override ? resolve(process.cwd(), override) : defaultWorkspace(slug);
  migrateLegacyLayout(workspace);
  return workspace;
}

/** Path to the `claude` CLI. Override with CLAUDE_BIN for non-PATH installs. */
export function claudeBin(): string {
  return process.env.CLAUDE_BIN ?? "claude";
}

/** Path to the `codex` CLI. Override with CODEX_BIN for non-PATH installs. */
export function codexBin(): string {
  return process.env.CODEX_BIN ?? "codex";
}

/** Which coding-agent CLI runs the subagents by default. */
export const DEFAULT_RUNNER = "claude";

/**
 * Default model per runner — the latest, most capable tier of each family for
 * the highest-craft games. Override with --model for a cheaper forever-loop
 * (e.g. --model sonnet).
 */
export function defaultModelFor(runner: "claude" | "codex"): string {
  return runner === "codex" ? "gpt-5.6-sol" : "claude-fable-5";
}

/** Default per-role agentic turn ceiling. Keeps any single step bounded. */
export const DEFAULT_MAX_TURNS = 40;

/**
 * Default idle watchdog: kill a specialist that emits no output for this long.
 * Generous on purpose — a single `vg generate` poll can stay silent for ~30
 * min — so it only ever catches a genuinely wedged session.
 */
export const DEFAULT_IDLE_MINUTES = 45;

/**
 * Default absolute ceiling on a single specialist session. A backstop for a
 * session that streams forever without finishing; generous enough not to cut
 * off legitimate long art/build work.
 */
export const DEFAULT_SESSION_MINUTES = 120;
