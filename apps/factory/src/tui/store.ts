import type { RunSetup, TurnInfo } from "../reporter.ts";
import type { AgentState } from "../state.ts";

/** How a feed line is toned when rendered. */
export type Tone = "marker" | "text" | "tool" | "info" | "warn" | "error" | "success";

export type FeedLine = { id: number; tone: Tone; text: string };

export type CurrentTurn = TurnInfo & { startedAt: number; events: number };

/** Immutable view of everything the TUI renders. Replaced on every mutation. */
export type Snapshot = {
  setup: RunSetup;
  state: AgentState | null;
  approvalPending: boolean;
  turn: CurrentTurn | null;
  feed: readonly FeedLine[];
};

/** Keys the dashboard listens for; the orchestrator supplies the behavior. */
export type TuiHandlers = {
  /** Grant a one-shot deploy approval (`a`). */
  approve: () => void;
  /** Graceful stop after the current step (`s`). Idempotent. */
  requestStop: () => void;
  /** Ctrl-C / `q`: graceful stop first, force quit on the second press. */
  interrupt: () => void;
};

const FEED_CAP = 400;

/**
 * External store bridging the (non-React) orchestrator to the React tree via
 * useSyncExternalStore. The reporter mutates it; the App renders snapshots.
 */
export class TuiStore {
  #snapshot: Snapshot;
  #listeners = new Set<() => void>();
  #nextId = 1;

  constructor(setup: RunSetup) {
    this.#snapshot = { setup, state: null, approvalPending: false, turn: null, feed: [] };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): Snapshot => this.#snapshot;

  #set(patch: Partial<Snapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }

  push(tone: Tone, text: string): void {
    const lines = text.split("\n").map((t): FeedLine => ({ id: this.#nextId++, tone, text: t }));
    this.#set({ feed: [...this.#snapshot.feed, ...lines].slice(-FEED_CAP) });
  }

  turnStart(turn: TurnInfo): void {
    this.#set({ turn: { ...turn, startedAt: Date.now(), events: 0 } });
  }

  bumpEvents(): void {
    const turn = this.#snapshot.turn;
    if (turn) this.#set({ turn: { ...turn, events: turn.events + 1 } });
  }

  turnEnd(): void {
    this.#set({ turn: null });
  }

  stateChanged(state: AgentState, approvalPending: boolean): void {
    this.#set({ state, approvalPending });
  }
}
