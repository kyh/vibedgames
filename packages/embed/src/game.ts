// Game-side half of the wrapper protocol. Games call notifyGameStarted() when
// active play begins; the wrapper answers with a pause request when the player
// asks for its chrome back, and Escape toggles the same pause from inside the
// game. Pausing shows a built-in overlay so every game gets the same
// "PAUSED — resume" affordance; games that can safely freeze their sim plug
// into it via setPauseHandlers.

import { GAME_PAUSED_MESSAGE, GAME_STARTED_MESSAGE, isPauseGameMessage } from "./protocol";

export type PauseHandlers = {
  /**
   * Freeze the sim/render loop. Only wire this when freezing is safe: never
   * freeze a wall-clock (Date.now) driven sim or a live online session — the
   * overlay still shows without handlers, the game just keeps running behind it.
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
let overlay: HTMLElement | null = null;

const embedded = (): boolean => typeof window !== "undefined" && window.parent !== window;

/** Escape must not steal keystrokes from text entry (chat boxes, name fields). */
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}

function ensureListener(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent) return;
    if (isPauseGameMessage(event.data)) pause();
  });
  // Capture phase: runs before any in-game handler, so escapePauses() sees the
  // game's PRE-event state (an open modal reads as open, not already closed by
  // the game's own Escape binding firing first).
  window.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat || isTypingTarget(event.target)) return;
      if (paused) resume();
      else if (started && (handlers.escapePauses?.() ?? true)) pause();
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

/** Wire the game's own freeze/unfreeze into the wrapper's pause request. */
export function setPauseHandlers(next: PauseHandlers): void {
  ensureListener();
  handlers = next;
}

function pause(): void {
  if (paused || !started) return;
  paused = true;
  started = false;
  handlers.onPause?.();
  showOverlay();
  // Escape-initiated pauses need to tell the wrapper to bring its chrome back;
  // for wrapper-initiated ones this is a harmless no-op echo.
  if (embedded()) window.parent.postMessage({ type: GAME_PAUSED_MESSAGE }, "*");
}

function resume(): void {
  if (!paused) return;
  paused = false;
  hideOverlay();
  handlers.onResume?.();
  notifyGameStarted();
}

// ---- pause overlay ----------------------------------------------------------

const onResumeKeyup = (event: KeyboardEvent): void => {
  // Escape is handled symmetrically on keydown (the toggle listener above);
  // resuming here too would double-fire on the keydown+keyup of one press.
  if (event.key === "Escape") return;
  resume();
};

function showOverlay(): void {
  if (overlay) return;
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  overlay = document.createElement("div");
  overlay.setAttribute("role", "button");
  overlay.setAttribute("aria-label", "Resume game");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;" +
    "align-items:center;justify-content:center;gap:12px;cursor:pointer;" +
    "background:rgba(9,11,18,0.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
    "color:#fff;font-family:ui-monospace,'SF Mono',Menlo,monospace;text-align:center;" +
    "user-select:none;-webkit-user-select:none;opacity:0;transition:opacity 0.24s ease";

  const title = document.createElement("div");
  title.textContent = "PAUSED";
  title.style.cssText = "font-size:26px;font-weight:800;letter-spacing:0.3em;text-indent:0.3em";

  const hint = document.createElement("div");
  hint.textContent = coarse ? "tap to resume" : "click or press any key to resume";
  hint.style.cssText = "font-size:12px;font-weight:600;opacity:0.72";

  overlay.append(title, hint);
  document.body.append(overlay);
  requestAnimationFrame(() => overlay?.style.setProperty("opacity", "1"));

  overlay.addEventListener("pointerup", () => resume());
  // keyup, not keydown — a keydown dismissal leaks the paired keyup into the
  // game as a phantom release.
  window.addEventListener("keyup", onResumeKeyup);
}

function hideOverlay(): void {
  window.removeEventListener("keyup", onResumeKeyup);
  const el = overlay;
  overlay = null;
  if (!el) return;
  el.style.pointerEvents = "none";
  el.style.opacity = "0";
  window.setTimeout(() => el.remove(), 260);
}
