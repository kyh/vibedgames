// Game-side half of the wrapper protocol — a pure pause state machine, no DOM.
// Games call notifyGameStarted() when active play begins; the wrapper answers
// with a pause request when the player asks for its chrome back, and Escape
// toggles the same pause from inside the game. What a pause LOOKS like is the
// game's business: wire onPause/onResume via setPauseHandlers and render your
// own UI there (or compose the stock overlay from ./overlay).

import { GAME_PAUSED_MESSAGE, GAME_STARTED_MESSAGE, isPauseGameMessage } from "./protocol";

export type PauseHandlers = {
  /**
   * The game is now paused: show your pause UI, and freeze the sim/render
   * loop if that's safe (never freeze a wall-clock driven sim or a live
   * online session — show the UI and let the world run behind it).
   */
  onPause?: () => void;
  /** Undo onPause. Runs right before the game is re-announced as started. */
  onResume?: () => void;
  /**
   * Gate the built-in Escape shortcut (default: always pause). Return false
   * while Escape currently means something in-game — an open modal, shop,
   * chat box — so that binding wins and the NEXT press pauses.
   */
  escapePauses?: () => boolean;
};

let handlers: PauseHandlers = {};
let started = false;
let paused = false;
let listening = false;

const embedded = (): boolean => typeof window !== "undefined" && window.parent !== window;

/** Escape must not steal keystrokes from text entry (chat boxes, name fields). */
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}

/**
 * While paused, key events must not reach the game's own listeners — games
 * keep theirs live (Phaser's keyboard manager, raw window handlers), so a key
 * pressed on the pause UI would otherwise act on the frozen world (rotate a
 * piece, drop a bomb) the instant it resumes, or worse, act on a live online
 * arena behind the overlay. stopPropagation() at window CAPTURE kills the
 * event before any element/document/window-bubble listener sees it, while
 * listeners registered on window WITH capture (this module's Escape toggle,
 * the pause shell's keyup-resume) still run — same-node listeners are immune
 * to stopPropagation. Installed on pause, removed on resume.
 */
const blockGameKeys = (event: KeyboardEvent): void => {
  if (isTypingTarget(event.target)) return; // a pause UI's own text inputs keep working
  event.stopPropagation();
};

function setKeyGate(on: boolean): void {
  if (typeof window === "undefined") return;
  if (on) {
    window.addEventListener("keydown", blockGameKeys, true);
    window.addEventListener("keyup", blockGameKeys, true);
  } else {
    window.removeEventListener("keydown", blockGameKeys, true);
    window.removeEventListener("keyup", blockGameKeys, true);
  }
}

function ensureListener(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent) return;
    if (isPauseGameMessage(event.data)) pauseGame();
  });
  // Capture phase: runs before any in-game handler, so escapePauses() sees the
  // game's PRE-event state (an open modal reads as open, not already closed by
  // the game's own Escape binding firing first).
  window.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat || isTypingTarget(event.target)) return;
      if (paused) resumeGame();
      else if (started && (handlers.escapePauses?.() ?? true)) pauseGame();
    },
    true,
  );
}

/**
 * Tell the wrapper page that active play began, so it can clear its chrome out
 * of the way. Safe to call every round/serve/respawn — deduped until the next
 * pause. Standalone (not embedded) it still arms the Escape pause shortcut,
 * just without messaging a wrapper.
 */
export function notifyGameStarted(): void {
  ensureListener();
  if (started || paused) return;
  started = true;
  if (embedded()) window.parent.postMessage({ type: GAME_STARTED_MESSAGE }, "*");
}

/** Wire the game's pause UI + freeze/unfreeze into the wrapper's pause request. */
export function setPauseHandlers(next: PauseHandlers): void {
  ensureListener();
  handlers = next;
}

/** Pause now (same path Escape and the wrapper take). No-op unless started. */
export function pauseGame(): void {
  if (paused || !started) return;
  paused = true;
  started = false;
  setKeyGate(true);
  handlers.onPause?.();
  // Escape-initiated pauses need to tell the wrapper to bring its chrome back;
  // for wrapper-initiated ones this is a harmless no-op echo.
  if (embedded()) window.parent.postMessage({ type: GAME_PAUSED_MESSAGE }, "*");
}

/** Resume from a pause — the call a pause UI's "resume" affordance makes. */
export function resumeGame(): void {
  if (!paused) return;
  paused = false;
  // Removing the gate here means the resuming key's own keyup was already
  // swallowed (it fired while the gate was up) — the game never sees a
  // phantom release for a press it never saw.
  setKeyGate(false);
  handlers.onResume?.();
  notifyGameStarted();
}
