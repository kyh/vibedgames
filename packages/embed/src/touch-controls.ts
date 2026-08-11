// The two controls a phone player has no other way to reach.
//
// Pause is Escape-bound (./game) and mute is M-bound in every game, so on a
// coarse pointer both are unreachable: a phone session cannot be paused, and
// since games boot muted by default it stays silent forever. The controls
// manifest is right to hide those rows on touch — the player genuinely cannot
// press them — which leaves the player with no idea the game has sound at all.
//
// This is a shared affordance rather than eleven bespoke HUD buttons: it is the
// same two actions everywhere, it has to clear the notch and the home indicator
// everywhere, and it has to be big enough to hit everywhere. Games theme it
// through `className`/`css` and the CSS custom properties below.

import { isCoarsePointer } from "./controls";
import { isPausable, pauseGame, watchPausable } from "./game";
import { PAUSE_OVERLAY_Z } from "./pause-shell";
import { sealPointerEvents } from "./pointer-seal";

export type MuteAccessor = {
  get: () => boolean;
  set: (next: boolean) => void;
};

export type TouchControlsOptions = {
  /**
   * Read/write the game's muted state. Omit for a game with no audio — the
   * button is then not rendered at all rather than rendered inert.
   */
  mute?: MuteAccessor;
  /** Show the pause button. Default true; pass false for a game whose pause is
   *  meaningless (a permanently live session with nothing to freeze). */
  pause?: boolean;
  /** Class on the container — the game's hook for restyling the whole cluster. */
  className?: string;
  /** Stylesheet injected once under `styleId` on first mount. */
  css?: string;
  styleId?: string;
};

export type TouchControls = {
  /** Re-read the mute accessor and redraw (call after changing audio elsewhere,
   *  e.g. the M key on a device that has both a keyboard and a touchscreen). */
  sync: () => void;
  destroy: () => void;
};

/** Sits under the pause overlay: pausing must cover these buttons, not fight them. */
const TOUCH_CONTROLS_Z = PAUSE_OVERLAY_Z - 10;

/** 44 CSS px is the documented minimum comfortable touch target; several of
 *  these games shipped 27–43px controls that testers repeatedly missed. */
const HIT_SIZE = 44;

const BASE_CSS = `
.vg-touch-controls {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + var(--vg-touch-gap, 10px));
  right: calc(env(safe-area-inset-right, 0px) + var(--vg-touch-gap, 10px));
  z-index: ${TOUCH_CONTROLS_Z};
  display: flex;
  gap: var(--vg-touch-gap, 10px);
  /* The cluster is a hole in the game's input surface only where a button
     actually is — everywhere else touches belong to the game. */
  pointer-events: none;
}
.vg-touch-controls button {
  pointer-events: auto;
  width: ${HIT_SIZE}px;
  height: ${HIT_SIZE}px;
  display: grid;
  place-items: center;
  padding: 0;
  font-size: var(--vg-touch-glyph-size, 18px);
  line-height: 1;
  cursor: pointer;
  color: var(--vg-touch-fg, #fff);
  background: var(--vg-touch-bg, rgba(0, 0, 0, 0.45));
  border: var(--vg-touch-border, 1px solid rgba(255, 255, 255, 0.28));
  border-radius: var(--vg-touch-radius, 12px);
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  user-select: none;
}
.vg-touch-controls button:active {
  background: var(--vg-touch-bg-active, rgba(255, 255, 255, 0.22));
}
@media (prefers-reduced-motion: no-preference) {
  .vg-touch-controls button { transition: background 120ms ease; }
}
`;

function injectCss(css: string, id: string): void {
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.append(style);
}

/**
 * Mount the touch-only pause/mute cluster. No-op on a fine pointer, so calling
 * it unconditionally at boot is correct — a desktop player keeps Escape and M
 * and sees nothing.
 */
export function createTouchControls(options: TouchControlsOptions = {}): TouchControls {
  if (typeof document === "undefined" || !isCoarsePointer()) {
    return { sync: () => undefined, destroy: () => undefined };
  }

  injectCss(BASE_CSS, "vg-touch-controls-css");
  if (options.css) injectCss(options.css, options.styleId ?? "vg-touch-controls-game-css");

  const root = document.createElement("div");
  root.className = `vg-touch-controls${options.className ? ` ${options.className}` : ""}`;
  // The DOM gamepad adapter treats the whole page as its input surface; without
  // this a tap on mute would also steer.
  root.setAttribute("data-gamepad-ignore", "");
  // Both buttons act on pointerup, so no child here needs a click kept.
  sealPointerEvents(root);

  const button = (label: string, glyph: string, onTap: () => void): HTMLButtonElement => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = glyph;
    el.setAttribute("aria-label", label);
    el.setAttribute("data-gamepad-ignore", "");
    // pointerup, not click: a synthesised click after touchend can land on
    // whatever is underneath once this element hides or the overlay swaps.
    // preventDefault() here does not stop that click being synthesised at all
    // (measured) — ./pointer-seal on the container does.
    el.addEventListener("pointerup", (event) => {
      event.stopPropagation();
      event.preventDefault();
      onTap();
    });
    root.append(el);
    return el;
  };

  const mute = options.mute;
  let muteEl: HTMLButtonElement | null = null;
  const drawMute = (): void => {
    if (!mute || !muteEl) return;
    const muted = mute.get();
    muteEl.textContent = muted ? "🔇" : "🔊";
    muteEl.setAttribute("aria-label", muted ? "Turn sound on" : "Turn sound off");
    muteEl.setAttribute("aria-pressed", String(muted));
  };

  if (mute) {
    muteEl = button("Turn sound on", "🔇", () => {
      mute.set(!mute.get());
      drawMute();
    });
    drawMute();
  }
  // `pauseGame()` no-ops until the game announces it started, so a pause button
  // rendered on the start screen is a dead control — it looks tappable and does
  // nothing. Show it only while it would actually work.
  let unwatchPausable: (() => void) | null = null;
  if (options.pause !== false) {
    const pauseEl = button("Pause", "⏸", () => pauseGame());
    const drawPause = (): void => {
      pauseEl.hidden = !isPausable();
    };
    drawPause();
    unwatchPausable = watchPausable(drawPause);
  }

  document.body.append(root);
  reserveCorner(root);

  return {
    sync: drawMute,
    destroy: () => {
      unwatchPausable?.();
      root.remove();
      document.documentElement.style.removeProperty(RESERVE_VAR);
    },
  };
}

/**
 * Publish the corner this cluster occupies so a game's own top bar can lay out
 * around it: `max-width: calc(100% - 2 * var(--vg-touch-reserve))` for centred
 * bars, or a matching padding for edge-anchored ones. It only exists while the
 * cluster is mounted, so `var(--vg-touch-reserve, 0px)` is the desktop value.
 *
 * Games that ignore it are fine on a 393px phone and collide on a narrow one —
 * starfall's boss bar overlapped the mute button by 7px at 360x640, which is an
 * iPhone SE.
 */
const RESERVE_VAR = "--vg-touch-reserve";

function reserveCorner(root: HTMLElement): void {
  const write = (): void => {
    const width = root.getBoundingClientRect().width;
    if (width > 0) document.documentElement.style.setProperty(RESERVE_VAR, `${Math.ceil(width)}px`);
  };
  write();
  // The cluster's width changes with the button count and the safe-area inset,
  // both of which settle after first paint and again on rotation.
  requestAnimationFrame(write);
  window.addEventListener("resize", write);
  window.addEventListener("orientationchange", write);
}
