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

/** Make sure the workspace is a git repo and `.agent/` stays out of history
 * (the blackboard churns every turn and belongs to the orchestrator). */
function ensureRepo(workspace: string): boolean {
  if (!existsSync(resolve(workspace, ".git"))) {
    if (!git(workspace, ["init", "-q"]).ok) return false;
  }
  const gitignore = resolve(workspace, ".gitignore");
  try {
    const body = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
    if (!/^\.agent\/?$/m.test(body)) {
      if (body) appendFileSync(gitignore, `${body.endsWith("\n") ? "" : "\n"}.agent/\n`);
      else writeFileSync(gitignore, ".agent/\n");
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
