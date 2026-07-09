import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot, type Root } from "@opentui/react";

import type { Activity, Reporter, RunSetup, TurnInfo, TurnResult } from "../reporter.ts";
import type { AgentState } from "../state.ts";
import { App } from "./app.tsx";
import { TuiStore, type TuiHandlers } from "./store.ts";

export type { TuiHandlers } from "./store.ts";

const costNote = (c?: number): string => (typeof c === "number" ? ` ($${c.toFixed(2)})` : "");

/**
 * The live dashboard reporter. Mounts an opentui/react app on the alternate
 * screen; the orchestrator narrates through the Reporter interface and the
 * store bridges those events into the React tree. Keyboard: `a` approves one
 * deploy, `s` stops after the current step, `q`/Ctrl-C interrupts.
 */
export class TuiReporter implements Reporter {
  #handlers: TuiHandlers;
  #store: TuiStore | null = null;
  #renderer: CliRenderer | null = null;
  #root: Root | null = null;
  #closed = false;

  constructor(handlers: TuiHandlers) {
    this.#handlers = handlers;
  }

  start(setup: RunSetup): void {
    const store = new TuiStore(setup);
    this.#store = store;
    // The renderer mounts async; events that arrive first land in the store
    // and render on mount.
    void this.#mount(store);
  }

  async #mount(store: TuiStore): Promise<void> {
    try {
      // We own Ctrl-C (graceful-then-force) and signals, so the renderer must
      // not exit the process itself.
      const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        exitSignals: [],
        targetFps: 30,
      });
      if (this.#closed) {
        renderer.destroy();
        return;
      }
      this.#renderer = renderer;
      this.#root = createRoot(renderer);
      this.#root.render(<App store={store} handlers={this.#handlers} />);
    } catch (err) {
      // A failed mount leaves us with a blank screen otherwise; surface it and
      // keep the loop alive — the trace/journal still record everything.
      store.push(
        "error",
        `TUI failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  turnStart(turn: TurnInfo): void {
    this.#store?.turnStart(turn);
    this.#store?.push(
      "marker",
      `▶ ${turn.emoji} ${turn.role} — ${turn.phase} · cycle ${turn.cycle}${
        turn.iteration !== null ? ` · iteration ${turn.iteration}` : ""
      }`,
    );
  }

  activity(activity: Activity): void {
    this.#store?.bumpEvents();
    switch (activity.kind) {
      case "init":
        this.#store?.push(
          "info",
          `session started (${activity.model ?? "model"}, ${activity.tools ?? 0} tools)`,
        );
        return;
      case "text":
        this.#store?.push("text", activity.text);
        return;
      case "tool":
        this.#store?.push(
          "tool",
          `⚙ ${activity.name}${activity.detail ? ` · ${activity.detail}` : ""}`,
        );
        return;
    }
  }

  turnEnd(result: TurnResult): void {
    if (result.ok) {
      this.#store?.push(
        "success",
        `✔ done${costNote(result.costUsd)} · ${result.numTurns ?? "?"} turns`,
      );
    } else {
      this.#store?.push("error", `✘ failed: ${result.error ?? "unknown error"}`);
    }
    this.#store?.turnEnd();
  }

  info(msg: string): void {
    this.#store?.push("info", msg);
  }

  warn(msg: string): void {
    this.#store?.push("warn", msg);
  }

  error(msg: string): void {
    this.#store?.push("error", msg);
  }

  stateChanged(state: AgentState, approvalPending: boolean): void {
    this.#store?.stateChanged(state, approvalPending);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#root?.unmount();
    } catch {
      /* teardown is best-effort */
    }
    try {
      this.#renderer?.destroy();
    } catch {
      /* teardown is best-effort */
    }
    this.#root = null;
    this.#renderer = null;
  }
}
