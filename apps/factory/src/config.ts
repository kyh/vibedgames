import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from `start` until we find the monorepo root (the dir holding
 * pnpm-workspace.yaml). The orchestrator runs the `claude` CLI with its cwd
 * set to a game workspace *inside* this repo, so Claude Code resolves the
 * dogfooded skills from `<repoRoot>/.claude/skills` and the linked `vg` CLI.
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = start;
  for (let i = 0; i < 25; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: this file lives at apps/factory/src/config.ts → ../../.. is repo root.
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** Default workspace location for a given game slug (gitignored). */
export function defaultWorkspace(repoRoot: string, slug: string): string {
  return resolve(repoRoot, "apps/factory/.workspaces", slug);
}

/** Path to the `claude` CLI. Override with CLAUDE_BIN for non-PATH installs. */
export function claudeBin(): string {
  return process.env.CLAUDE_BIN ?? "claude";
}

/**
 * Default model passed to `claude --model`. Opus 4.8 — the latest, most capable
 * model — for the highest-craft games; override with `--model sonnet` for a
 * cheaper forever-loop.
 */
export const DEFAULT_MODEL = "claude-opus-4-8";

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
