// The one control a phone player has no other way to reach.
//
// Pause is Escape-bound (./game), so on a coarse pointer a STANDALONE session
// cannot be paused at all. Everything else a paused player might want — sound
// on/off, controls, help — lives on the pause overlay itself (./pause-shell),
// so this stays a single button that only exists while a pause would actually
// work.
//
// Embedded in the wrapper page, nothing mounts: the wrapper draws its own pause
// button over the frame, and a second one in the game's top-right corner was
// a duplicate control that also cost every game its top-right HUD corner.
//
// This is a shared affordance rather than eleven bespoke HUD buttons: it is the
// same action everywhere, it has to clear the notch and the home indicator
// everywhere, and it has to be big enough to hit everywhere. Games theme it
// through `className`/`css` and the CSS custom properties below.

import { isCoarsePointer } from "./controls";
import { isEmbedded, isPausable, pauseGame, watchPausable } from "./game";
import { PAUSE_OVERLAY_Z } from "./pause-shell";
import { sealPointerEvents } from "./pointer-seal";

export interface TouchControlsOptions {
  /** Show the pause button. Default true; pass false for a game whose pause is
   *  meaningless (a permanently live session with nothing to freeze). */
  pause?: boolean;
  /** Class on the container — the game's hook for restyling the whole cluster. */
  className?: string;
  /** Stylesheet injected once under `styleId` on first mount. */
  css?: string;
  styleId?: string;
}

export interface TouchControls {
  destroy: () => void;
}

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
  /* The cluster is a hole in the game's input surface only where the button
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
/* This display rule outranks the UA's [hidden] one; the pre-start hide relies on it. */
.vg-touch-controls button[hidden] {
  display: none;
}
.vg-touch-controls button:active {
  background: var(--vg-touch-bg-active, rgba(255, 255, 255, 0.22));
}
@media (prefers-reduced-motion: no-preference) {
  .vg-touch-controls button { transition: background 120ms ease; }
}
`;

const injectCss = (css: string, id: string): void => {
  if (document.querySelector(`#${id}`)) {
    return;
  }
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.append(style);
};

/** Nothing is mounted on a fine pointer. */
const noop = (): void => undefined;

/**
 * Publish the corner this cluster occupies so a game's own top bar can lay out
 * around it: `max-width: calc(100% - 2 * var(--vg-touch-reserve))` for centred
 * bars, or a matching padding for edge-anchored ones. It only exists while the
 * cluster is mounted, so `var(--vg-touch-reserve, 0px)` is the desktop value.
 *
 * Games that ignore it are fine on a 393px phone and collide on a narrow one —
 * starfall's boss bar overlapped the cluster by 7px at 360x640, which is an
 * iPhone SE.
 */
const RESERVE_VAR = "--vg-touch-reserve";

const reserveCorner = (root: HTMLElement): void => {
  const write = (): void => {
    const { width } = root.getBoundingClientRect();
    if (width > 0) {
      document.documentElement.style.setProperty(RESERVE_VAR, `${Math.ceil(width)}px`);
    }
  };

  write();
  // The cluster's width depends on the safe-area inset, which settles after
  // first paint and again on rotation.
  requestAnimationFrame(write);
  window.addEventListener("resize", write);
  window.addEventListener("orientationchange", write);
};

/**
 * Mount the touch-only pause button. No-op on a fine pointer, so calling it
 * unconditionally at boot is correct — a desktop player keeps Escape and sees
 * nothing. Also a no-op inside the wrapper page, whose own pause button
 * covers the same action; `--vg-touch-reserve` then stays unset (0px) and the
 * game keeps its whole top edge.
 */
export const createTouchControls = (options: TouchControlsOptions = {}): TouchControls => {
  if (typeof document === "undefined" || !isCoarsePointer()) {
    return { destroy: noop };
  }
  // Pause is the cluster's only button, so with it gone nothing else mounts.
  if (options.pause === false || isEmbedded()) {
    return { destroy: noop };
  }

  injectCss(BASE_CSS, "vg-touch-controls-css");
  if (options.css) {
    injectCss(options.css, options.styleId ?? "vg-touch-controls-game-css");
  }

  const root = document.createElement("div");
  root.className = `vg-touch-controls${options.className ? ` ${options.className}` : ""}`;
  // The DOM gamepad adapter treats the whole page as its input surface; without
  // this a tap on pause would also steer.
  root.dataset.gamepadIgnore = "";
  // The button acts on pointerup, so no child here needs a click kept.
  sealPointerEvents(root);

  const button = (label: string, glyph: string, onTap: () => void): HTMLButtonElement => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = glyph;
    el.setAttribute("aria-label", label);
    el.dataset.gamepadIgnore = "";
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

  // `pauseGame()` no-ops until the game announces it started, so a pause button
  // rendered on the start screen is a dead control — it looks tappable and does
  // nothing. Show it only while it would actually work.
  const pauseEl = button("Pause", "⏸", () => pauseGame());
  const drawPause = (): void => {
    pauseEl.hidden = !isPausable();
  };
  drawPause();
  const unwatchPausable = watchPausable(drawPause);

  document.body.append(root);
  reserveCorner(root);

  return {
    destroy: () => {
      unwatchPausable();
      root.remove();
      document.documentElement.style.removeProperty(RESERVE_VAR);
    },
  };
};
