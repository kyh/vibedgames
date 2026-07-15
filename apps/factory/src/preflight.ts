import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// runInit resolves exactly once via a `settled`-guarded settle() helper;
// oxlint's static check can't see the guard (same pattern as claude.ts).
/* oxlint-disable promise/no-multiple-resolved */

import { claudeBin, codexBin, findRepoRoot } from "./config.ts";
import type { Reporter } from "./reporter.ts";
import type { Runner } from "./runner.ts";

/** Generous cap on the one-time `vg init` (npm installs over the network). */
const INIT_TIMEOUT_MS = 5 * 60_000;

/** Can `bin` be spawned at all? (ENOENT is the only failure we care about) */
function onPath(bin: string): boolean {
  try {
    return spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 15_000 }).error === undefined;
  } catch {
    return false;
  }
}

/**
 * Is the vg CLI present AND logged in (saved login or VG_TOKEN)? Probed at
 * each ship phase: an unauthenticated deploy would just burn a shipper turn on
 * a failing `vg deploy`, so the orchestrator skips shipping instead — the
 * operator can `vg login` mid-run and the next release point deploys.
 */
export function vgAuthenticated(): boolean {
  try {
    const res = spawnSync("vg", ["whoami"], { stdio: "ignore", timeout: 30_000 });
    return res.error === undefined && res.status === 0;
  } catch {
    return false;
  }
}

/** Run `vg init` (or bootstrap it via npx when vg itself is missing) in the
 * workspace, installing the vibedgames skills there + the vg CLI globally. */
function runInit(cwd: string, viaNpx: boolean): Promise<boolean> {
  return new Promise((resolvePromise) => {
    // Install for both runners in one shot so switching --runner later works.
    const initArgs = ["init", "-a", "claude-code,codex"];
    const child = viaNpx
      ? spawn("npx", ["-y", "vibedgames", ...initArgs], { cwd, stdio: "ignore" })
      : spawn("vg", initArgs, { cwd, stdio: "ignore" });
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      settle(false);
    }, INIT_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", () => settle(false));
    child.on("close", (code) => settle(code === 0));
  });
}

/**
 * Verify the external tools the factory drives before a run, and — when
 * running installed (outside the vibedgames repo) — set the game workspace up
 * with the vibedgames skills + vg CLI via `vg init`. Hard failures are
 * reported and return false; the run must not start without them.
 */
export async function preflight(
  workspace: string,
  runner: Runner,
  reporter: Reporter,
): Promise<boolean> {
  if (runner === "claude" && !onPath(claudeBin())) {
    reporter.error(
      `\`${claudeBin()}\` not found — the factory drives headless Claude Code sessions. Install it (npm install -g @anthropic-ai/claude-code) and log in, or point CLAUDE_BIN at the binary.`,
    );
    return false;
  }
  if (runner === "codex" && !onPath(codexBin())) {
    reporter.error(
      `\`${codexBin()}\` not found — the codex runner drives headless Codex sessions. Install the Codex CLI and log in, or point CODEX_BIN at the binary.`,
    );
    return false;
  }

  const inRepo = findRepoRoot() !== null;
  if (inRepo) {
    // Dev mode: claude resolves skills from <repo>/.claude/skills via
    // --add-dir; codex reads AGENTS.md-installed skills, which the repo
    // doesn't carry — flag it rather than silently running skill-less.
    if (!onPath("vg")) {
      reporter.warn(
        "`vg` not found on PATH — run `pnpm dogfood` at the repo root so subagents can scaffold/generate/deploy.",
      );
    }
    if (runner === "codex" && !existsSync(resolve(workspace, "AGENTS.md"))) {
      reporter.warn(
        "codex runner: no AGENTS.md in the game workspace — run `vg init -a codex` there so codex subagents see the vibedgames skills.",
      );
    }
    return true;
  }

  // Installed mode: the workspace itself must hold the vibedgames skills, and
  // subagents call the globally-installed vg CLI. `vg init` provides both.
  const hasVg = onPath("vg");
  const hasSkills = existsSync(resolve(workspace, ".claude", "skills"));
  if (hasVg && hasSkills) return true;

  reporter.info(
    "Setting up the game workspace — installing the vibedgames skills and vg CLI (one-time, ~a minute)…",
  );
  if (await runInit(workspace, !hasVg)) {
    reporter.info("Workspace ready.");
    return true;
  }
  reporter.error(
    "Workspace setup failed. Run `npx -y vibedgames init` inside the game folder, then start again.",
  );
  return false;
}
