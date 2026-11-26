import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { claudeBin, codexBin, findRepoRoot } from "./config.ts";
import type { Reporter } from "./reporter.ts";
import type { Runner } from "./runner.ts";
import { bestEffort } from "./best-effort.ts";

const INIT_TIMEOUT_MS = 5 * 60_000;

const onPath = (bin: string) => {
  try {
    return spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 15_000 }).error === undefined;
  } catch {
    return false;
  }
};

/**
 * Is the vg CLI present AND logged in (saved login or VG_TOKEN)? Probed at
 * each ship phase: an unauthenticated deploy would just burn a shipper turn on
 * a failing `vg deploy`, so the orchestrator skips shipping instead — the
 * operator can `vg login` mid-run and the next release point deploys.
 */
export const vgAuthenticated = () => {
  try {
    const res = spawnSync("vg", ["whoami"], { stdio: "ignore", timeout: 30_000 });

    return res.error === undefined && res.status === 0;
  } catch {
    return false;
  }
};

interface TimeoutCell {
  handle?: ReturnType<typeof setTimeout>;
}

const runInit: (cwd: string, viaNpx: boolean) => Promise<boolean> = async (cwd, viaNpx) => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const initArgs = ["init", "-a", "claude-code,codex"];

  const child = viaNpx
    ? spawn("npx", ["-y", "vibedgames", ...initArgs], { cwd, stdio: "ignore" })
    : spawn("vg", initArgs, { cwd, stdio: "ignore" });

  let settled = false;
  const timeout: TimeoutCell = {};

  const settle = (ok: boolean) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timeout.handle);
    resolve(ok);
  };

  timeout.handle = setTimeout(() => {
    bestEffort(() => {
      child.kill("SIGKILL");
    });
    settle(false);
  }, INIT_TIMEOUT_MS);
  timeout.handle.unref?.();
  child.on("error", () => {
    settle(false);
  });
  child.on("close", (code) => {
    settle(code === 0);
  });

  return await promise;
};

/**
 * Verify the external tools the factory drives before a run, and — when
 * running installed (outside the vibedgames repo) — set the game workspace up
 * with the vibedgames skills + vg CLI via `vg init`. Hard failures are
 * reported and return false; the run must not start without them.
 */
export const preflight = async (workspace: string, runner: Runner, reporter: Reporter) => {
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
    if (!onPath("vg")) {
      reporter.warn(
        "`vg` not found on PATH — run `pnpm dogfood` at the repo root so subagents can scaffold/generate/deploy.",
      );
    }

    if (runner === "codex" && !existsSync(path.resolve(workspace, "AGENTS.md"))) {
      reporter.warn(
        "codex runner: no AGENTS.md in the game workspace — run `vg init -a codex` there so codex subagents see the vibedgames skills.",
      );
    }

    return true;
  }

  const hasVg = onPath("vg");
  const hasSkills = existsSync(path.resolve(workspace, ".claude", "skills"));

  if (hasVg && hasSkills) {
    return true;
  }

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
};
