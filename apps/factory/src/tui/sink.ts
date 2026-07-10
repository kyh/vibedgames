import type {
  Activity,
  Reporter,
  RunSetup,
  RunSummary,
  TurnInfo,
  TurnResult,
} from "../reporter.ts";
import type { AgentState } from "../state.ts";
import type { TuiStore } from "./store.ts";

const costNote = (c?: number): string => (typeof c === "number" ? ` ($${c.toFixed(2)})` : "");

/**
 * The dashboard reporter: a pure sink that translates orchestrator events into
 * store mutations. Owns no terminal state — the controller (main.tsx) owns the
 * renderer, keyboard, and lifecycle.
 */
export class TuiSink implements Reporter {
  #store: TuiStore;

  constructor(store: TuiStore) {
    this.#store = store;
  }

  start(setup: RunSetup): void {
    this.#store.set({ screen: "dashboard", running: true, stopping: false, setup });
  }

  turnStart(turn: TurnInfo): void {
    this.#store.turnStart(turn);
    this.#store.push(
      "marker",
      `▶ ${turn.emoji} ${turn.role} — ${turn.phase} · cycle ${turn.cycle}${
        turn.iteration !== null ? ` · iteration ${turn.iteration}` : ""
      }`,
    );
  }

  activity(activity: Activity): void {
    this.#store.bumpEvents();
    switch (activity.kind) {
      case "init":
        this.#store.push(
          "info",
          `session started (${activity.model ?? "model"}, ${activity.tools ?? 0} tools)`,
        );
        return;
      case "text":
        this.#store.push("text", activity.text);
        return;
      case "tool":
        this.#store.push(
          "tool",
          `⚙ ${activity.name}${activity.detail ? ` · ${activity.detail}` : ""}`,
        );
        return;
    }
  }

  turnEnd(result: TurnResult): void {
    if (result.ok) {
      this.#store.push(
        "success",
        `✔ done${costNote(result.costUsd)} · ${result.numTurns ?? "?"} turns`,
      );
    } else {
      this.#store.push("error", `✘ failed: ${result.error ?? "unknown error"}`);
    }
    this.#store.turnEnd();
  }

  info(msg: string): void {
    this.#store.push("info", msg);
  }

  warn(msg: string): void {
    this.#store.push("warn", msg);
  }

  error(msg: string): void {
    this.#store.push("error", msg);
  }

  stateChanged(state: AgentState, approvalPending: boolean): void {
    this.#store.stateChanged(state, approvalPending);
  }

  checkpointStarted(message: string, waitMs: number): void {
    this.#store.push("marker", `⏸ checkpoint: ${message}`);
    this.#store.set({ checkpoint: { message, deadline: Date.now() + waitMs } });
  }

  checkpointEnded(): void {
    this.#store.set({ checkpoint: null });
  }

  runEnded(summary: RunSummary): void {
    this.#store.set({ running: false, stopping: false, turn: null });
    this.#store.push(
      "marker",
      `■ agent stopped — ${summary.cycles} cycles · ${summary.iterations} iterations · ~$${summary.totalCostUsd.toFixed(2)}`,
    );
    if (summary.deployUrl) this.#store.push("info", `live at ${summary.deployUrl}`);
  }
}
