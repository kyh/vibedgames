import {
  GAME_PAUSED_MESSAGE,
  GAME_STARTED_MESSAGE,
  WRAPPER_FRAME_NAME,
  isPauseGameMessage,
} from "./protocol";
import type { MessageData } from "./protocol";

export interface PauseHandlers {
  /**
   * The game is now paused: show your pause UI, and freeze the sim/render
   * loop if that's safe (never freeze a wall-clock driven sim or a live
   * online session — show the UI and let the world run behind it).
   */
  onPause?: () => void;
  /** Undo onPause. Runs right before the game is re-announced as started. */
  onResume?: () => void;
  /** Keep the current pause while the game cannot resume, e.g. lost graphics. */
  canResume?: () => boolean;
  /**
   * Gate the built-in Escape shortcut (default: always pause). Return false
   * while Escape currently means something in-game — an open modal, shop,
   * chat box — so that binding wins and the NEXT press pauses.
   */
  escapePauses?: () => boolean;
}

let handlers: PauseHandlers = {};
let started = false;
let paused = false;
let listening = false;

const embedded = () =>
  typeof window !== "undefined" && window.parent !== window && window.name === WRAPPER_FRAME_NAME;

/**
 * Whether the game runs inside the wrapper page (the vibedgames play view)
 * rather than standalone: at its own origin, in a native shell, or framed by a
 * game portal. The wrapper owns chrome the game must not duplicate — its own
 * pause button, for one.
 */
export const isEmbedded = () => embedded();

const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

const blockGameKeys = (event: KeyboardEvent) => {
  if (isTypingTarget(event.target)) {
    return;
  }

  event.stopPropagation();
};

const setKeyGate = (on: boolean) => {
  if (typeof window === "undefined") {
    return;
  }

  if (on) {
    window.addEventListener("keydown", blockGameKeys, true);
    window.addEventListener("keyup", blockGameKeys, true);
  } else {
    window.removeEventListener("keydown", blockGameKeys, true);
    window.removeEventListener("keyup", blockGameKeys, true);
  }
};

const pausableListeners = new Set<() => void>();

/** Observe {@link isPausable}. Returns an unsubscribe. */
export const watchPausable = (onChange: () => void) => {
  pausableListeners.add(onChange);

  return () => pausableListeners.delete(onChange);
};

const notifyPausableChanged = () => {
  for (const listener of pausableListeners) {
    listener();
  }
};

const STARTED_CLASS = "vg-started";

const announceStarted = () => {
  if (started || paused) {
    return;
  }

  started = true;
  document.body.classList.add(STARTED_CLASS);
  notifyPausableChanged();

  if (embedded()) {
    window.parent.postMessage({ type: GAME_STARTED_MESSAGE }, "*");
  }
};

/** Pause now (same path Escape and the wrapper take). No-op unless started. */
export const pauseGame = () => {
  if (paused || !started) {
    return;
  }

  paused = true;
  started = false;
  notifyPausableChanged();
  setKeyGate(true);
  handlers.onPause?.();

  if (embedded()) {
    window.parent.postMessage({ type: GAME_PAUSED_MESSAGE }, "*");
  }
};

/** Resume from a pause — the call a pause UI's "resume" affordance makes. */
export const resumeGame = () => {
  if (!paused || !(handlers.canResume?.() ?? true)) {
    return;
  }

  paused = false;
  notifyPausableChanged();
  setKeyGate(false);
  handlers.onResume?.();
  announceStarted();
};

const ensureListener = () => {
  if (listening || typeof window === "undefined") {
    return;
  }

  listening = true;
  window.addEventListener("message", (event: MessageEvent<MessageData>) => {
    if (event.source !== window.parent) {
      return;
    }

    if (isPauseGameMessage(event.data)) {
      pauseGame();
    }
  });
  window.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat || isTypingTarget(event.target)) {
        return;
      }

      if (paused) {
        resumeGame();
      } else if (started && (handlers.escapePauses?.() ?? true)) {
        pauseGame();
      }
    },
    true,
  );
};

/**
 * Tell the wrapper page that active play began, so it can clear its chrome out
 * of the way. Safe to call every round/serve/respawn — deduped until the next
 * pause. Standalone (not embedded) it still arms the Escape pause shortcut,
 * just without messaging a wrapper.
 */
export const notifyGameStarted = () => {
  ensureListener();
  announceStarted();
};

/**
 * Whether {@link pauseGame} would currently do anything. A pause affordance
 * that renders before play begins is a dead control — it looks tappable and
 * silently no-ops, which testers filed as a bug in two games.
 */
export const isPausable = () => started && !paused;

/** Wire the game's pause UI + freeze/unfreeze into the wrapper's pause request. */
export const setPauseHandlers = (next: PauseHandlers) => {
  ensureListener();
  handlers = next;
};
