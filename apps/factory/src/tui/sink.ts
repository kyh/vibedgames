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

const costNote = (c?: number) => (c === undefined ? "" : ` ($${c.toFixed(2)})`);

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

  start(setup: RunSetup) {
    this.#store.set({ running: true, screen: "dashboard", setup, stopping: false });
  }

  turnStart(turn: TurnInfo) {
    this.#store.turnStart(turn);
    this.#store.push(
      "marker",
      `▶ ${turn.emoji} ${turn.role} — ${turn.phase} · cycle ${turn.cycle}${
        turn.iteration === null ? "" : ` · iteration ${turn.iteration}`
      }`,
    );
  }

  activity(activity: Activity) {
    this.#store.bumpEvents();

    switch (activity.kind) {
      case "init": {
        this.#store.push(
          "info",
          `session started (${activity.model ?? "model"}, ${activity.tools ?? 0} tools)`,
        );

        return;
      }

      case "text": {
        this.#store.push("text", activity.text);

        return;
      }

      case "tool": {
        this.#store.push(
          "tool",
          `⚙ ${activity.name}${activity.detail ? ` · ${activity.detail}` : ""}`,
        );
        break;
      }

      default: {
        break;
      }
    }
  }

  turnEnd(result: TurnResult) {
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

  info(msg: string) {
    this.#store.push("info", msg);
  }

  warn(msg: string) {
    this.#store.push("warn", msg);
  }

  error(msg: string) {
    this.#store.push("error", msg);
  }

  stateChanged(state: AgentState, approvalPending: boolean) {
    this.#store.stateChanged(state, approvalPending);
  }

  checkpointStarted(message: string, waitMs: number) {
    this.#store.push("marker", `⏸ checkpoint: ${message}`);
    this.#store.set({ checkpoint: { deadline: Date.now() + waitMs, message } });
  }

  checkpointEnded() {
    this.#store.set({ checkpoint: null });
  }

  runEnded(summary: RunSummary) {
    this.#store.set({ running: false, stopping: false, turn: null });
    this.#store.push(
      "marker",
      `■ agent stopped — ${summary.cycles} cycles · ${summary.iterations} iterations · ~$${summary.totalCostUsd.toFixed(2)}`,
    );

    if (summary.deployUrl) {
      this.#store.push("info", `live at ${summary.deployUrl}`);
    }
  }
}
