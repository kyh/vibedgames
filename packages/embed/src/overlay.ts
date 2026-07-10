// Stock pause overlay — an OPTIONAL component games compose into their pause
// handlers. The core state machine (./game) never renders anything; a game
// that wants the standard "PAUSED — resume" look calls createPauseOverlay()
// once and show()/hide()s it from onPause/onResume. Games with their own art
// direction skip this entirely and render whatever fits.

import { resumeGame } from "./game";

/** One control hint row: input ("SPACE", "🤳 face cam") + what it does. */
export type ControlHint = readonly [input: string, action: string];

/** One section of the overlay's "how to play" modal. */
export type HelpSection = { readonly title: string; readonly body: string };

export type PauseOverlayOptions = {
  /**
   * Control hints rendered on the overlay — the same controls the start
   * screen teaches, so a returning player never has to leave the pause screen
   * to re-learn the game. Keep it to the start-screen set (≤7 rows).
   */
  controls?: readonly ControlHint[];
  /**
   * Gameplay depth (mechanics, systems, tips — NOT controls) behind a
   * "how to play" button. Controls go in `controls`; this is the long-form
   * content that must not clutter gameplay.
   */
  help?: readonly HelpSection[];
};

export type PauseOverlay = {
  /** Mount the overlay. Idempotent while shown. */
  show: () => void;
  /** Unmount (fade out). Idempotent while hidden. */
  hide: () => void;
};

const BUTTON_CSS =
  "padding:8px 18px;border-radius:999px;cursor:pointer;" +
  "background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.28);" +
  "color:#fff;font:600 12px ui-monospace,'SF Mono',Menlo,monospace";

/**
 * Build the standard overlay. Any click/key while it is up resumes via
 * resumeGame() — except inside the help modal, which owns its pointer events
 * (backdrop or "back" returns to the pause screen). Escape resumes from
 * anywhere: the core keydown listener wins it, and hide() sweeps the modal.
 */
export function createPauseOverlay(options: PauseOverlayOptions = {}): PauseOverlay {
  let overlay: HTMLElement | null = null;
  let helpModal: HTMLElement | null = null;

  const onResumeKeyup = (event: KeyboardEvent): void => {
    // Escape is handled on keydown by the core toggle listener; resuming here
    // too would double-fire on the keydown+keyup of one press. While the help
    // modal is up, keys belong to it (scrolling, Escape-to-close).
    if (event.key === "Escape" || helpModal) return;
    resumeGame();
  };

  function closeHelp(): void {
    helpModal?.remove();
    helpModal = null;
  }

  function openHelp(sections: readonly HelpSection[]): void {
    if (helpModal || !overlay) return;

    helpModal = document.createElement("div");
    helpModal.setAttribute("role", "dialog");
    helpModal.setAttribute("aria-label", "How to play");
    helpModal.style.cssText =
      "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;" +
      "padding:24px;background:rgba(9,11,18,0.55);cursor:default";
    // Clicks anywhere in the modal stay in the modal: backdrop closes it, the
    // panel does nothing — neither may fall through to the overlay's resume.
    helpModal.addEventListener("pointerup", (event) => {
      event.stopPropagation();
      if (event.target === helpModal) closeHelp();
    });

    const panel = document.createElement("div");
    panel.style.cssText =
      "max-width:min(92vw,440px);max-height:min(80vh,560px);overflow-y:auto;" +
      "padding:22px 24px;border-radius:14px;text-align:left;" +
      "background:rgba(17,20,30,0.96);border:1px solid rgba(255,255,255,0.16)";

    const heading = document.createElement("div");
    heading.textContent = "HOW TO PLAY";
    heading.style.cssText =
      "font-size:14px;font-weight:800;letter-spacing:0.22em;margin-bottom:4px;opacity:0.92";
    panel.append(heading);

    for (const section of sections) {
      const title = document.createElement("div");
      title.textContent = section.title;
      title.style.cssText = "margin-top:14px;font-size:12px;font-weight:700;color:#ffd479";
      const body = document.createElement("div");
      body.textContent = section.body;
      body.style.cssText = "margin-top:4px;font-size:12px;line-height:1.55;opacity:0.82";
      panel.append(title, body);
    }

    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "back";
    back.style.cssText = "margin-top:18px;" + BUTTON_CSS;
    back.addEventListener("pointerup", (event) => {
      event.stopPropagation();
      closeHelp();
    });
    panel.append(back);

    helpModal.append(panel);
    overlay.append(helpModal);
  }

  function show(): void {
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

    const controls = options.controls;
    if (controls && controls.length > 0) {
      const list = document.createElement("div");
      list.style.cssText =
        "margin-top:14px;display:grid;grid-template-columns:auto auto;gap:7px 14px;" +
        "align-items:center;font-size:12px;max-width:min(86vw,360px)";
      for (const [input, action] of controls) {
        const key = document.createElement("span");
        key.textContent = input;
        key.style.cssText =
          "justify-self:end;padding:3px 8px;border-radius:6px;font-weight:700;" +
          "background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.22);white-space:nowrap";
        const label = document.createElement("span");
        label.textContent = action;
        label.style.cssText = "justify-self:start;opacity:0.8;text-align:left";
        list.append(key, label);
      }
      overlay.append(list);
    }

    const help = options.help;
    if (help && help.length > 0) {
      const helpBtn = document.createElement("button");
      helpBtn.type = "button";
      helpBtn.textContent = "how to play";
      helpBtn.style.cssText = "margin-top:16px;" + BUTTON_CSS;
      // pointerup would bubble to the overlay's resume handler — this button
      // is the one thing on the overlay that must NOT resume.
      helpBtn.addEventListener("pointerup", (event) => {
        event.stopPropagation();
        openHelp(help);
      });
      overlay.append(helpBtn);
    }

    document.body.append(overlay);
    requestAnimationFrame(() => overlay?.style.setProperty("opacity", "1"));

    overlay.addEventListener("pointerup", () => {
      if (!helpModal) resumeGame();
    });
    // keyup, not keydown — a keydown dismissal leaks the paired keyup into the
    // game as a phantom release.
    window.addEventListener("keyup", onResumeKeyup);
  }

  function hide(): void {
    window.removeEventListener("keyup", onResumeKeyup);
    closeHelp();
    const el = overlay;
    overlay = null;
    if (!el) return;
    el.style.pointerEvents = "none";
    el.style.opacity = "0";
    window.setTimeout(() => el.remove(), 260);
  }

  return { show, hide };
}
