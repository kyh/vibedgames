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
  // Fallback: this file compiles to apps/agents/dist/config.js → ../../.. is repo root.
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** Default workspace location for a given game slug (gitignored). */
export function defaultWorkspace(repoRoot: string, slug: string): string {
  return resolve(repoRoot, "apps/agents/.workspaces", slug);
}

/** Path to the `claude` CLI. Override with CLAUDE_BIN for non-PATH installs. */
export function claudeBin(): string {
  return process.env.CLAUDE_BIN ?? "claude";
}

/**
 * Default model alias passed to `claude --model`. Sonnet keeps a forever-loop
 * affordable and within plan limits; pass `--model opus` for higher-craft runs.
 */
export const DEFAULT_MODEL = "sonnet";

/** Default per-role agentic turn ceiling. Keeps any single step bounded. */
export const DEFAULT_MAX_TURNS = 40;
