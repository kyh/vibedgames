import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bestEffort } from "./best-effort.ts";

const GIT_TIMEOUT_MS = 60_000;

const git = (cwd: string, args: string[]) => {
  try {
    const res = spawnSync(
      "git",
      ["-c", "user.name=factory", "-c", "user.email=factory@vibedgames.com", ...args],
      { cwd, encoding: "utf-8", timeout: GIT_TIMEOUT_MS },
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
export const insideForeignRepo = (workspace: string) => {
  if (existsSync(path.resolve(workspace, ".git"))) {
    return false;
  }

  const probe = git(workspace, ["rev-parse", "--is-inside-work-tree"]);

  return probe.ok && probe.out.trim() === "true";
};

const ensureRepo = (workspace: string) => {
  if (!existsSync(path.resolve(workspace, ".git"))) {
    // WARNING: never git init inside an enclosing repo: a nested repo shadows it.
    if (insideForeignRepo(workspace)) {
      return false;
    }

    if (!git(workspace, ["init", "-q"]).ok) {
      return false;
    }
  }

  const gitignore = path.resolve(workspace, ".gitignore");

  bestEffort(() => {
    const body = existsSync(gitignore) ? readFileSync(gitignore, "utf-8") : "";

    if (!/^\.vgfactory\/?$/mu.test(body)) {
      if (body) {
        appendFileSync(gitignore, `${body.endsWith("\n") ? "" : "\n"}.vgfactory/\n`);
      } else {
        writeFileSync(gitignore, ".vgfactory/\n");
      }
    }
  });

  return true;
};

/**
 * Commit everything in the workspace under `message`. Returns true when a
 * commit was created (false: no changes, no git, or any failure).
 */
export const commitPhase = (workspace: string, message: string) => {
  if (!ensureRepo(workspace)) {
    return false;
  }

  if (!git(workspace, ["add", "-A"]).ok) {
    return false;
  }

  if (git(workspace, ["diff", "--cached", "--quiet"]).ok) {
    return false;
  }

  return git(workspace, ["commit", "-q", "--no-verify", "-m", message]).ok;
};

/**
 * A short human-readable summary of uncommitted work in the workspace (scoped
 * to it, so an enclosing monorepo's unrelated churn doesn't leak in). Empty
 * string when clean. Journaled when a turn fails, so the next attempt — and
 * the operator — can see what the dead session actually left behind instead
 * of assuming the failure undid the work.
 */
export const diffSummary = (workspace: string) => {
  const status = git(workspace, ["status", "--porcelain", "-uall", "--", "."]);

  if (!status.ok) {
    return "";
  }

  const lines = status.out.split("\n").filter((l) => l.trim());

  if (lines.length === 0) {
    return "";
  }

  const shown = lines.slice(0, 20).map((l) => l.trim());
  const more = lines.length > shown.length ? ` (+${lines.length - shown.length} more)` : "";

  return `${shown.join(", ")}${more}`;
};

/** The workspace's current commit hash, or null (no git / no commits yet). */
export const headCommit = (workspace: string) => {
  const res = git(workspace, ["rev-parse", "HEAD"]);

  return res.ok ? res.out.trim() || null : null;
};
