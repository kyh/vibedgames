// The behavior half of a pause overlay, extracted so every game's bespoke
// overlay (and the stock one in ./overlay) shares ONE implementation of the
// easy-to-get-wrong parts:
//   - resume on pointerup anywhere, EXCEPT on interactive children
//     (button/a/input/... or [data-pause-keep]) so a "how to play" button
//     doesn't also resume
//   - resume on keyup, EXCEPT Escape — the core keydown toggle (./game) owns
//     Escape; acting on its keyup too would double-fire one press
//   - resume on a FRESH physical-pad button press (the game loop is usually
//     frozen while paused, so nothing else polls the pad)
//   - a `modalOpen` gate: while a child modal owns input, keys and clicks
//     belong to it and must not resume
//   - idempotent show()/hide(), fade in/out with pointer-events off during
//     fade-out, removal after the fade, prefers-reduced-motion → no fade
//
// The consumer owns everything visual: it gets a bare full-screen root
// (positioning/z-index/fade are inline invariants) and renders its own DOM
// into it via `render`, styling through its own class + injected CSS.

import { resumeGame } from "./game";

/** z-index of every pause overlay — above any game HUD. */
export const PAUSE_OVERLAY_Z = 2147483000;

/**
 * While a pause UI is visible the game loop is often frozen, so nothing polls
 * the physical pad — this rAF poller fills the gap: any FRESH button press
 * resumes (buttons already held when the overlay appeared don't count, so the
 * press that triggered a pause can't instantly undo it). Call on show(), call
 * the returned stop on hide().
 */
export function resumeOnPadPress(): () => void {
  let raf = 0;
  let prev: readonly boolean[] | null = null;
  const poll = (): void => {
    const pads =
      typeof navigator !== "undefined" && typeof navigator.getGamepads === "function"
        ? navigator.getGamepads()
        : [];
    let pad: Gamepad | null = null;
    for (const candidate of pads) {
      if (candidate?.connected) {
        pad = candidate;
        break;
      }
    }
    const cur = pad ? pad.buttons.map((b) => b.pressed) : null;
    if (cur && prev) {
      for (let i = 0; i < cur.length; i++) {
        if (cur[i] === true && prev[i] !== true) {
          resumeGame();
          return; // resumed — stop polling (hide() also cancels, harmlessly)
        }
      }
    }
    prev = cur;
    raf = requestAnimationFrame(poll);
  };
  raf = requestAnimationFrame(poll);
  return () => cancelAnimationFrame(raf);
}

export type PauseShellOptions = {
  /**
   * Build the overlay's content into the full-screen root the shell provides.
   * Called fresh on every show(), so content that depends on the moment —
   * control groups filtered by connected pad, coarse-pointer copy — always
   * renders current.
   */
  render: (root: HTMLElement) => void;
  /** Class for the root — the consumer's CSS hook for all visuals (layout,
   *  background, fonts). The shell only sets behavioral invariants inline. */
  className?: string;
  /** Stylesheet injected once under `styleId` on first show(). */
  css?: string;
  styleId?: string;
  /** Fade duration; default 240ms, forced to 0 under prefers-reduced-motion. */
  fadeMs?: number;
  /** Accessible label for the resume affordance. Default "Resume game". */
  ariaLabel?: string;
  /**
   * Return true while a child modal (help page, etc.) owns input: pointer and
   * key events then belong to the modal and never resume. The modal's own
   * interactive elements should also carry stopPropagation / [data-pause-keep].
   */
  modalOpen?: () => boolean;
  /** Sweep side state (close modals, …). Runs at the start of every hide(). */
  onHide?: () => void;
};

export type PauseShell = {
  /** Mount the overlay. Idempotent while shown. */
  show: () => void;
  /** Unmount (fade out). Idempotent while hidden. */
  hide: () => void;
};

function isInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("button, a, input, select, textarea, [data-pause-keep]") !== null
  );
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Build a pause overlay with the shared behavior contract; see module doc. */
export function createPauseShell(options: PauseShellOptions): PauseShell {
  let root: HTMLElement | null = null;
  let stopPadResume: (() => void) | null = null;

  const onResumeKeyup = (event: KeyboardEvent): void => {
    // Escape is handled on keydown by the core toggle listener; resuming here
    // too would double-fire on the keydown+keyup of one press.
    if (event.key === "Escape" || (options.modalOpen?.() ?? false)) return;
    resumeGame();
  };

  function show(): void {
    if (root) return;
    if (options.css !== undefined && options.styleId !== undefined) {
      if (!document.getElementById(options.styleId)) {
        const style = document.createElement("style");
        style.id = options.styleId;
        style.textContent = options.css;
        document.head.append(style);
      }
    }

    root = document.createElement("div");
    if (options.className !== undefined) root.className = options.className;
    root.setAttribute("role", "button");
    root.setAttribute("aria-label", options.ariaLabel ?? "Resume game");
    // Behavioral invariants only — everything visual is the consumer's CSS.
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.zIndex = String(PAUSE_OVERLAY_Z);
    root.style.cursor = "pointer";
    root.style.userSelect = "none";
    root.style.setProperty("-webkit-user-select", "none");
    const fade = reducedMotion() ? 0 : (options.fadeMs ?? 240);
    if (fade > 0) {
      root.style.opacity = "0";
      root.style.transition = `opacity ${fade}ms ease`;
    }

    options.render(root);
    document.body.append(root);
    stopPadResume = resumeOnPadPress();
    if (fade > 0) requestAnimationFrame(() => root?.style.setProperty("opacity", "1"));

    root.addEventListener("pointerup", (event) => {
      if ((options.modalOpen?.() ?? false) || isInteractive(event.target)) return;
      resumeGame();
    });
    // keyup, not keydown — a keydown dismissal leaks the paired keyup into the
    // game as a phantom release. Registered CAPTURE on window: while paused
    // the core key gate (./game) stops propagation at window, and only
    // same-node capture listeners survive that.
    window.addEventListener("keyup", onResumeKeyup, true);
  }

  function hide(): void {
    window.removeEventListener("keyup", onResumeKeyup, true);
    stopPadResume?.();
    stopPadResume = null;
    options.onHide?.();
    const el = root;
    root = null;
    if (!el) return;
    const fade = reducedMotion() ? 0 : (options.fadeMs ?? 240);
    if (fade === 0) {
      el.remove();
      return;
    }
    el.style.pointerEvents = "none";
    el.style.opacity = "0";
    window.setTimeout(() => el.remove(), fade + 40);
  }

  return { show, hide };
}
