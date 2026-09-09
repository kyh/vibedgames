import { consola } from "consola";

import type { AgentState } from "./state.ts";

/** A single observable thing a subagent did, decoded from stream-json. */
export type Activity =
  | { kind: "init"; model?: string; tools?: number }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail?: string };

/** Display-ready facts about the turn that is starting. */
export interface TurnInfo {
  emoji: string;
  role: string;
  phase: string;
  /** 1-based display cycle. */
  cycle: number;
  /** 1-based display iteration, or null before the first ship. */
  iteration: number | null;
}

export interface TurnResult {
  ok: boolean;
  costUsd?: number;
  numTurns?: number;
  error?: string;
}

/** Static facts about this run, shown once (console) or persistently (TUI). */
export interface RunSetup {
  slug: string;
  idea: string;
  model: string;
  /** Which coding-agent CLI runs the subagents ("claude" | "codex"). */
  runner: string;
  workspace: string;
  /** vibedgames monorepo root in dev mode; null running installed. */
  repoRoot: string | null;
  existingProject: boolean;
  hasContext: boolean;
  contextDir: string | null;
  guarded: boolean;
  noShip: boolean;
  autoDeploy: boolean;
  maxCycles: number;
}

/** Final tallies for a run that just stopped. */
export interface RunSummary {
  slug: string;
  cycles: number;
  iterations: number;
  deployUrl: string | null;
  totalCostUsd: number;
}

/**
 * Where the orchestrator narrates a run. Two implementations: plain streamed
 * logs (non-TTY / --no-tui) and the live TUI dashboard (see tui/).
 */
export interface Reporter {
  start: (setup: RunSetup) => void;
  turnStart: (turn: TurnInfo) => void;
  activity: (activity: Activity) => void;
  turnEnd: (result: TurnResult) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  /** Refresh the header/status view. No-op for the console reporter. */
  stateChanged: (state: AgentState, approvalPending: boolean) => void;
  /** The agent flagged a good stopping point; auto-continues after waitMs. */
  checkpointStarted: (message: string, waitMs: number) => void;
  /** The checkpoint resolved (operator responded, or the countdown ran out). */
  checkpointEnded: () => void;
  /** The loop finished (stopped, budget spent, or failed to start). */
  runEnded: (summary: RunSummary) => void;
}

const costNote = (c?: number): string => (c === undefined ? "" : ` ($${c.toFixed(2)})`);

/**
 * The deploy line of the run banner: disabled, automatic, or gated on a
 * per-release approval.
 */
const deployNote = (setup: RunSetup): string => {
  if (setup.noShip) {
    return `Deploy:    disabled (--skip-ship)`;
  }
  if (setup.autoDeploy) {
    return `Deploy:    AUTOMATIC → ${setup.slug}.vibedgames.com`;
  }
  return `Deploy:    on approval only — \`pnpm approve ${setup.slug}\` → ${setup.slug}.vibedgames.com`;
};

/** The run banner, printed once at start. */
const banner = (setup: RunSetup): void => {
  consola.box(
    [
      `🎮 vibedgames factory — autonomous game agent`,
      ``,
      `Game:      ${setup.slug}`,
      `Idea:      ${setup.idea || "(from existing project / context)"}`,
      `Model:     ${setup.model} (via ${setup.runner})`,
      `Game dir:  ${setup.workspace}`,
      setup.existingProject ? `Source:    building on existing files in the game dir` : null,
      setup.hasContext
        ? `Context:   provided${setup.contextDir ? ` (+ reference dir: ${setup.contextDir})` : ""}`
        : null,
      setup.repoRoot ? `Repo:      ${setup.repoRoot}` : null,
      `Mode:      ${setup.guarded ? "guarded (will block on approvals!)" : "unattended (tools auto-approved)"}`,
      deployNote(setup),
      setup.maxCycles > 0
        ? `Stops at:  ${setup.maxCycles} cycles`
        : `Runs:      until you stop it (Ctrl-C or \`pnpm stop ${setup.slug}\`)`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
};

const checkpointBanner = (message: string, waitMs: number): void => {
  consola.box(
    [
      `⏸ CHECKPOINT — the agent thinks this is a good stopping point:`,
      ``,
      message,
      ``,
      `Auto-continuing in ${Math.round(waitMs / 1000)}s (Ctrl-C stops instead).`,
    ].join("\n"),
  );
};

const summaryBanner = (summary: RunSummary): void => {
  consola.box(
    [
      `Agent stopped for "${summary.slug}".`,
      `Cycles run: ${summary.cycles} · iterations: ${summary.iterations}`,
      summary.deployUrl ? `Live: ${summary.deployUrl}` : "Not yet shipped.",
      `Approx spend: $${summary.totalCostUsd.toFixed(2)}`,
      `Resume anytime: pnpm start ${summary.slug}`,
    ].join("\n"),
  );
};

/** Plain streamed logs — the original output, kept for non-TTY runs and --no-tui. */
export const createConsoleReporter = (): Reporter => {
  let current: TurnInfo | null = null;

  const turnStart = (turn: TurnInfo): void => {
    current = turn;
    consola.log("");
    consola.start(
      `${turn.emoji} ${turn.role} — phase "${turn.phase}" · cycle ${turn.cycle}${
        turn.iteration === null ? "" : ` · iteration ${turn.iteration}`
      }`,
    );
  };

  const activity = (event: Activity): void => {
    const tag = `  ${current?.role ?? "agent"} ·`;
    switch (event.kind) {
      case "init": {
        consola.log(
          `${tag} session started (${event.model ?? "model"}, ${event.tools ?? 0} tools)`,
        );
        return;
      }
      case "text": {
        for (const ln of event.text.split("\n")) {
          consola.log(`${tag} ${ln}`);
        }
        return;
      }
      case "tool": {
        consola.log(`${tag} ⚙ ${event.name}${event.detail ? `  (${event.detail})` : ""}`);
      }
      // no default
    }
  };

  const turnEnd = (result: TurnResult): void => {
    const role = current?.role ?? "agent";
    current = null;
    if (result.ok) {
      consola.success(`${role} done${costNote(result.costUsd)} · ${result.numTurns ?? "?"} turns`);
    } else {
      consola.error(`${role} failed: ${result.error ?? "unknown error"}`);
    }
  };

  return {
    activity,
    checkpointEnded: () => {
      consola.info("Continuing.");
    },
    checkpointStarted: checkpointBanner,
    error: (msg) => {
      consola.error(msg);
    },
    info: (msg) => {
      consola.info(msg);
    },
    runEnded: summaryBanner,
    start: banner,
    stateChanged: () => {
      /* the header lives in the TUI; streamed logs already narrate state */
    },
    turnEnd,
    turnStart,
    warn: (msg) => {
      consola.warn(msg);
    },
  };
};
