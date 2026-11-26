import { resumeGame } from "./game";
import { sealPointerEvents } from "./pointer-seal";

/** z-index of every pause overlay — above any game HUD. */
export const PAUSE_OVERLAY_Z = 2_147_483_000;

/**
 * While a pause UI is visible the game loop is often frozen, so nothing polls
 * the physical pad — this rAF poller fills the gap: any FRESH button press
 * resumes (buttons already held when the overlay appeared don't count, so the
 * press that triggered a pause can't instantly undo it). Call on show(), call
 * the returned stop on hide().
 */
export const resumeOnPadPress = () => {
  let raf = 0;
  let prev: readonly boolean[] | null = null;

  const poll = () => {
    const pads =
      typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];

    let pad: Gamepad | null = null;

    for (const candidate of pads) {
      if (candidate?.connected === true) {
        pad = candidate;
        break;
      }
    }

    const cur = pad ? pad.buttons.map((b) => b.pressed) : null;

    if (cur && prev) {
      for (let i = 0; i < cur.length; i += 1) {
        if (cur[i] === true && prev[i] !== true) {
          resumeGame();

          return;
        }
      }
    }

    prev = cur;
    raf = requestAnimationFrame(poll);
  };

  raf = requestAnimationFrame(poll);

  return () => {
    cancelAnimationFrame(raf);
  };
};

export interface MuteAccessor {
  get: () => boolean;
  set: (next: boolean) => void;
}

export interface PauseShellOptions {
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
  /**
   * Read/write the game's muted state. Appends a `.vg-pause-sound` toggle as
   * the root's last child — a column-flex root puts it under your content —
   * styled by an injected stylesheet your own CSS overrides, and binds M
   * while paused. Omit for a game with no audio.
   */
  mute?: MuteAccessor;
}

export interface PauseShell {
  /** Mount the overlay. Idempotent while shown. */
  show: () => void;
  /** Unmount (fade out). Idempotent while hidden. */
  hide: () => void;
}

const SOUND_TOGGLE_CSS = `
.vg-pause-sound {
  margin-top: 16px;
  padding: 8px 18px;
  border-radius: 999px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.28);
  color: inherit;
  font: 600 12px ui-monospace, 'SF Mono', Menlo, monospace;
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

const isInteractive = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest("button, a, input, select, textarea, [data-pause-keep]") !== null;

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Build a pause overlay with the shared behavior contract; see module doc. */
export const createPauseShell = (options: PauseShellOptions) => {
  let root: HTMLElement | null = null;
  let stopPadResume: (() => void) | null = null;
  const resumeKeys = new Set<string>();
  let soundToggle: HTMLButtonElement | null = null;

  const drawSound = () => {
    const { mute } = options;

    if (!mute || !soundToggle) {
      return;
    }

    const muted = mute.get();
    soundToggle.textContent = muted ? "sound off" : "sound on";
    soundToggle.setAttribute("aria-pressed", String(!muted));
  };

  const toggleSound = () => {
    const { mute } = options;

    if (!mute) {
      return;
    }

    mute.set(!mute.get());
    drawSound();
  };

  const onResumeKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" || event.repeat || (options.modalOpen?.() ?? false)) {
      return;
    }

    resumeKeys.add(event.code);
  };

  const onResumeKeyup = (event: KeyboardEvent) => {
    const fresh = resumeKeys.delete(event.code);

    if (!fresh || event.key === "Escape" || (options.modalOpen?.() ?? false)) {
      return;
    }

    if (event.code === "KeyM" && options.mute) {
      toggleSound();

      return;
    }

    resumeGame();
  };

  const show = () => {
    if (root) {
      return;
    }

    if (options.mute) {
      injectCss(SOUND_TOGGLE_CSS, "vg-pause-sound-css");
    }

    if (options.css !== undefined && options.styleId !== undefined) {
      injectCss(options.css, options.styleId);
    }

    root = document.createElement("div");

    if (options.className !== undefined) {
      root.className = options.className;
    }

    root.setAttribute("role", "button");
    root.setAttribute("aria-label", options.ariaLabel ?? "Resume game");
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

    if (options.mute) {
      soundToggle = document.createElement("button");
      soundToggle.type = "button";
      soundToggle.className = "vg-pause-sound";
      soundToggle.setAttribute("aria-label", "Sound");
      soundToggle.addEventListener("pointerup", (event) => {
        event.stopPropagation();
        toggleSound();
      });
      drawSound();
      root.append(soundToggle);
    }

    document.body.append(root);
    sealPointerEvents(root, { keepClick: isInteractive });
    stopPadResume = resumeOnPadPress();

    if (fade > 0) {
      requestAnimationFrame(() => root?.style.setProperty("opacity", "1"));
    }

    root.addEventListener("pointerup", (event) => {
      if ((options.modalOpen?.() ?? false) || isInteractive(event.target)) {
        return;
      }

      resumeGame();
    });
    window.addEventListener("keydown", onResumeKeydown, true);
    window.addEventListener("keyup", onResumeKeyup, true);
  };

  const hide = () => {
    window.removeEventListener("keydown", onResumeKeydown, true);
    window.removeEventListener("keyup", onResumeKeyup, true);
    resumeKeys.clear();
    stopPadResume?.();
    stopPadResume = null;
    options.onHide?.();
    soundToggle = null;
    const el = root;
    root = null;

    if (!el) {
      return;
    }

    const fade = reducedMotion() ? 0 : (options.fadeMs ?? 240);

    if (fade === 0) {
      el.remove();

      return;
    }

    el.style.pointerEvents = "none";
    el.style.opacity = "0";
    window.setTimeout(() => {
      el.remove();
    }, fade + 40);
  };

  return { hide, show };
};
