import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The git ratchet: every successful phase becomes a commit, so a phase that
 * makes the game worse is a `git revert`, not a hope that a later agent
 * notices. All best-effort — a machine without git (or a weird workspace)
 * degrades to the old no-history behavior, never a stalled loop.
 */

const GIT_TIMEOUT_MS = 60_000;

const git = (cwd: string, args: string[]): { ok: boolean; out: string } => {
  try {
    const res = spawnSync(
      "git",
      // A stable identity so commits work on machines with no git config.
      ["-c", "user.name=factory", "-c", "user.email=factory@vibedgames.com", ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, encoding: "utf8" },
    );
    return { ok: res.status === 0 && res.error === undefined, out: `${res.stdout}${res.stderr}` };
  } catch {
    return { ok: false, out: "" };
  }
};

/**
 * Is the workspace inside somebody else's git repository — no repo of its own,
 * but an enclosing work tree above it (e.g. a game dir inside a monorepo)?
 * The factory must never `git init` there: a nested repo shadows the enclosing
 * one — the outer repo's tooling sees stale/dirty state that isn't real, and
 * factory commits land in a history nobody knows exists. In that case the
 * phase ratchet stands down and history belongs to the enclosing repo.
 */
export function insideForeignRepo(workspace: string): boolean {
  if (existsSync(resolve(workspace, ".git"))) return false;
  const probe = git(workspace, ["rev-parse", "--is-inside-work-tree"]);
  return probe.ok && probe.out.trim() === "true";
}

/** Make sure the workspace is a git repo and `.vgfactory/` stays out of history
 * (the blackboard churns every turn and belongs to the orchestrator). */
function ensureRepo(workspace: string): boolean {
  if (!existsSync(resolve(workspace, ".git"))) {
    // Inside somebody else's repo: never nest, and don't write a per-workspace
    // .gitignore either — ignoring `.vgfactory/` is the enclosing repo's call
    // (e.g. the vibedgames monorepo ignores it at the root).
    if (insideForeignRepo(workspace)) return false;
    if (!git(workspace, ["init", "-q"]).ok) return false;
  }
  const gitignore = resolve(workspace, ".gitignore");
  try {
    const body = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
    if (!/^\.vgfactory\/?$/m.test(body)) {
      if (body) appendFileSync(gitignore, `${body.endsWith("\n") ? "" : "\n"}.vgfactory/\n`);
      else writeFileSync(gitignore, ".vgfactory/\n");
    }
  } catch {
    /* a missing ignore line just means noisier commits */
  }
  return true;
}

/**
 * Commit everything in the workspace under `message`. Returns true when a
 * commit was created (false: no changes, no git, or any failure).
 */
export function commitPhase(workspace: string, message: string): boolean {
  if (!ensureRepo(workspace)) return false;
  if (!git(workspace, ["add", "-A"]).ok) return false;
  // Nothing staged → nothing to ratchet.
  if (git(workspace, ["diff", "--cached", "--quiet"]).ok) return false;
  return git(workspace, ["commit", "-q", "--no-verify", "-m", message]).ok;
}

/**
 * A short human-readable summary of uncommitted work in the workspace (scoped
 * to it, so an enclosing monorepo's unrelated churn doesn't leak in). Empty
 * string when clean. Journaled when a turn fails, so the next attempt — and
 * the operator — can see what the dead session actually left behind instead
 * of assuming the failure undid the work.
 */
export function diffSummary(workspace: string): string {
  // -uall lists files inside untracked directories (porcelain collapses them
  // to "dir/" otherwise, hiding what the turn actually created).
  const status = git(workspace, ["status", "--porcelain", "-uall", "--", "."]);
  if (!status.ok) return "";
  const lines = status.out.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return "";
  const shown = lines.slice(0, 20).map((l) => l.trim());
  const more = lines.length > shown.length ? ` (+${lines.length - shown.length} more)` : "";
  return `${shown.join(", ")}${more}`;
}

/** The workspace's current commit hash, or null (no git / no commits yet). */
export function headCommit(workspace: string): string | null {
  const res = git(workspace, ["rev-parse", "HEAD"]);
  return res.ok ? res.out.trim() || null : null;
}
