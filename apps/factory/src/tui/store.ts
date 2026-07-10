import type { RunSetup, TurnInfo } from "../reporter.ts";
import type { AgentState } from "../state.ts";
import type { BacklogItem } from "./backlog.ts";

/** How a feed line is toned when rendered. */
export type Tone = "marker" | "text" | "tool" | "info" | "warn" | "error" | "success";

export type FeedLine = { id: number; tone: Tone; text: string };

export type CurrentTurn = TurnInfo & { startedAt: number; events: number };

export type Screen = "setup" | "dashboard";

/** Immutable view of everything the TUI renders. Replaced on every mutation. */
export type Snapshot = {
  screen: Screen;
  /** True while the agent loop is executing (between start and runEnded). */
  running: boolean;
  /** True once a graceful stop has been requested for the current run. */
  stopping: boolean;
  setup: RunSetup | null;
  state: AgentState | null;
  approvalPending: boolean;
  turn: CurrentTurn | null;
  feed: readonly FeedLine[];
  backlog: readonly BacklogItem[];
  /** Validation error shown on the setup screen. */
  setupError: string | null;
  /** True while the loop is held between steps. */
  paused: boolean;
  /** The standing operator directive, when set. */
  directive: string | null;
  /** Active agent checkpoint: what it wants feedback on + auto-continue time. */
  checkpoint: { message: string; deadline: number } | null;
};

const FEED_CAP = 400;

/**
 * External store bridging the (non-React) orchestrator/controller to the React
 * tree via useSyncExternalStore. The sink and controller mutate it; the App
 * renders snapshots.
 */
export class TuiStore {
  #snapshot: Snapshot = {
    screen: "setup",
    running: false,
    stopping: false,
    setup: null,
    state: null,
    approvalPending: false,
    turn: null,
    feed: [],
    backlog: [],
    setupError: null,
    paused: false,
    directive: null,
    checkpoint: null,
  };
  #listeners = new Set<() => void>();
  #nextId = 1;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): Snapshot => this.#snapshot;

  set(patch: Partial<Snapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }

  push(tone: Tone, text: string): void {
    const lines = text.split("\n").map((t): FeedLine => ({ id: this.#nextId++, tone, text: t }));
    this.set({ feed: [...this.#snapshot.feed, ...lines].slice(-FEED_CAP) });
  }

  turnStart(turn: TurnInfo): void {
    this.set({ turn: { ...turn, startedAt: Date.now(), events: 0 } });
  }

  bumpEvents(): void {
    const turn = this.#snapshot.turn;
    if (turn) this.set({ turn: { ...turn, events: turn.events + 1 } });
  }

  turnEnd(): void {
    this.set({ turn: null });
  }

  stateChanged(state: AgentState, approvalPending: boolean): void {
    this.set({ state, approvalPending });
  }
}
