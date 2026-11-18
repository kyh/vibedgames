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

const TOUCH_CONTROLS_Z = PAUSE_OVERLAY_Z - 10;

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

const injectCss = (css: string, id: string) => {
  if (document.querySelector(`#${id}`)) {
    return;
  }

  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.append(style);
};

const noop = () => {};

const RESERVE_VAR = "--vg-touch-reserve";

const reserveCorner = (root: HTMLElement) => {
  const write = () => {
    const { width } = root.getBoundingClientRect();

    if (width > 0) {
      document.documentElement.style.setProperty(RESERVE_VAR, `${Math.ceil(width)}px`);
    }
  };

  write();
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
export const createTouchControls = (options: TouchControlsOptions = {}) => {
  if (typeof document === "undefined" || !isCoarsePointer()) {
    return { destroy: noop };
  }

  if (options.pause === false || isEmbedded()) {
    return { destroy: noop };
  }

  injectCss(BASE_CSS, "vg-touch-controls-css");

  if (options.css) {
    injectCss(options.css, options.styleId ?? "vg-touch-controls-game-css");
  }

  const root = document.createElement("div");
  root.className = `vg-touch-controls${options.className ? ` ${options.className}` : ""}`;
  root.dataset.gamepadIgnore = "";
  sealPointerEvents(root);

  const button = (label: string, glyph: string, onTap: () => void) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = glyph;
    el.setAttribute("aria-label", label);
    el.dataset.gamepadIgnore = "";
    el.addEventListener("pointerup", (event) => {
      event.stopPropagation();
      event.preventDefault();
      onTap();
    });
    root.append(el);

    return el;
  };

  const pauseEl = button("Pause", "⏸", () => pauseGame());

  const drawPause = () => {
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
