import consola from "consola";

import type { AgentState } from "./state.ts";

/** A single observable thing a subagent did, decoded from stream-json. */
export type Activity =
  | { kind: "init"; model?: string; tools?: number }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail?: string };

/** Display-ready facts about the turn that is starting. */
export type TurnInfo = {
  emoji: string;
  role: string;
  phase: string;
  /** 1-based display cycle. */
  cycle: number;
  /** 1-based display iteration, or null before the first ship. */
  iteration: number | null;
};

export type TurnResult = {
  ok: boolean;
  costUsd?: number;
  numTurns?: number;
  error?: string;
};

/** Static facts about this run, shown once (console) or persistently (TUI). */
export type RunSetup = {
  slug: string;
  idea: string;
  model: string;
  workspace: string;
  repoRoot: string;
  existingProject: boolean;
  hasContext: boolean;
  contextDir: string | null;
  guarded: boolean;
  noShip: boolean;
  autoDeploy: boolean;
  maxCycles: number;
};

/**
 * Where the orchestrator narrates a run. Two implementations: plain streamed
 * logs (non-TTY / --no-tui) and the live TUI dashboard (see tui.ts).
 */
export type Reporter = {
  start(setup: RunSetup): void;
  turnStart(turn: TurnInfo): void;
  activity(activity: Activity): void;
  turnEnd(result: TurnResult): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** Refresh the header/status view. No-op for the console reporter. */
  stateChanged(state: AgentState, approvalPending: boolean): void;
  /** Tear down (restores the terminal in TUI mode). Safe to call twice. */
  close(): void;
};

const costNote = (c?: number): string => (typeof c === "number" ? ` ($${c.toFixed(2)})` : "");

/** Plain streamed logs — the original output, kept for non-TTY runs and --no-tui. */
export class ConsoleReporter implements Reporter {
  #turn: TurnInfo | null = null;

  start(setup: RunSetup): void {
    consola.box(
      [
        `🎮 vibedgames factory — autonomous game agent`,
        ``,
        `Game:      ${setup.slug}`,
        `Idea:      ${setup.idea || "(from existing project / context)"}`,
        `Model:     ${setup.model}`,
        `Game dir:  ${setup.workspace}`,
        setup.existingProject ? `Source:    building on existing files in the game dir` : null,
        setup.hasContext
          ? `Context:   provided${setup.contextDir ? ` (+ reference dir: ${setup.contextDir})` : ""}`
          : null,
        `Repo:      ${setup.repoRoot}`,
        `Mode:      ${setup.guarded ? "guarded (will block on approvals!)" : "unattended (tools auto-approved)"}`,
        setup.noShip
          ? `Deploy:    disabled (--skip-ship)`
          : setup.autoDeploy
            ? `Deploy:    AUTOMATIC → ${setup.slug}.vibedgames.com`
            : `Deploy:    on approval only — \`pnpm approve ${setup.slug}\` → ${setup.slug}.vibedgames.com`,
        setup.maxCycles > 0
          ? `Stops at:  ${setup.maxCycles} cycles`
          : `Runs:      until you stop it (Ctrl-C or \`pnpm stop ${setup.slug}\`)`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  turnStart(turn: TurnInfo): void {
    this.#turn = turn;
    consola.log("");
    consola.start(
      `${turn.emoji} ${turn.role} — phase "${turn.phase}" · cycle ${turn.cycle}${
        turn.iteration !== null ? ` · iteration ${turn.iteration}` : ""
      }`,
    );
  }

  activity(activity: Activity): void {
    const tag = `  ${this.#turn?.role ?? "agent"} ·`;
    switch (activity.kind) {
      case "init":
        consola.log(
          `${tag} session started (${activity.model ?? "model"}, ${activity.tools ?? 0} tools)`,
        );
        return;
      case "text":
        for (const ln of activity.text.split("\n")) consola.log(`${tag} ${ln}`);
        return;
      case "tool":
        consola.log(`${tag} ⚙ ${activity.name}${activity.detail ? `  (${activity.detail})` : ""}`);
        return;
    }
  }

  turnEnd(result: TurnResult): void {
    const role = this.#turn?.role ?? "agent";
    this.#turn = null;
    if (result.ok) {
      consola.success(`${role} done${costNote(result.costUsd)} · ${result.numTurns ?? "?"} turns`);
    } else {
      consola.error(`${role} failed: ${result.error ?? "unknown error"}`);
    }
  }

  info(msg: string): void {
    consola.info(msg);
  }

  warn(msg: string): void {
    consola.warn(msg);
  }

  error(msg: string): void {
    consola.error(msg);
  }

  stateChanged(): void {
    /* the header lives in the TUI; streamed logs already narrate state */
  }

  close(): void {
    /* nothing to restore */
  }
}
