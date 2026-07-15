// Stock pause overlay — an OPTIONAL component games compose into their pause
// handlers. The core state machine (./game) never renders anything; a game
// that wants the standard "PAUSED — resume" look calls createPauseOverlay()
// once and show()/hide()s it from onPause/onResume. Games with their own art
// direction build theirs on createPauseShell (./pause-shell) instead — the
// shell owns the shared resume behavior; this file is just the stock skin.

import { controlHints } from "./controls";
import type { ControlsManifest } from "./controls";
import { createPauseShell } from "./pause-shell";

/** One control hint row: input ("SPACE", "🤳 face cam") + what it does. */
export type ControlHint = readonly [input: string, action: string];

/** One section of the overlay's "how to play" modal. */
export type HelpSection = { readonly title: string; readonly body: string };

export type PauseOverlayOptions = {
  /**
   * The game's controls manifest — the same single source the start screen
   * renders from, so a returning player never has to leave the pause screen
   * to re-learn the game. Filtered to the current input context (touch vs
   * keys/mouse, controller only while connected) fresh on every show().
   */
  controls?: ControlsManifest;
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
 * Build the standard overlay on the shared pause shell: any click/key/pad
 * press while it is up resumes — except inside the help modal, which owns its
 * pointer events (backdrop or "back" returns to the pause screen), and except
 * Escape, which the core keydown listener already toggles.
 */
export function createPauseOverlay(options: PauseOverlayOptions = {}): PauseOverlay {
  let helpModal: HTMLElement | null = null;

  function closeHelp(): void {
    helpModal?.remove();
    helpModal = null;
  }

  function openHelp(host: HTMLElement, sections: readonly HelpSection[]): void {
    if (helpModal) return;

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
    host.append(helpModal);
  }

  return createPauseShell({
    modalOpen: () => helpModal !== null,
    onHide: closeHelp,
    render(root) {
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      root.style.cssText +=
        "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;" +
        "background:rgba(9,11,18,0.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
        "color:#fff;font-family:ui-monospace,'SF Mono',Menlo,monospace;text-align:center";

      const title = document.createElement("div");
      title.textContent = "PAUSED";
      title.style.cssText = "font-size:26px;font-weight:800;letter-spacing:0.3em;text-indent:0.3em";

      const hint = document.createElement("div");
      hint.textContent = coarse ? "tap to resume" : "click or press any key to resume";
      hint.style.cssText = "font-size:12px;font-weight:600;opacity:0.72";

      root.append(title, hint);

      const controls = controlHints(options.controls ?? [], { coarse });
      if (controls.length > 0) {
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
        root.append(list);
      }

      const help = options.help;
      if (help && help.length > 0) {
        const helpBtn = document.createElement("button");
        helpBtn.type = "button";
        helpBtn.textContent = "how to play";
        helpBtn.style.cssText = "margin-top:16px;" + BUTTON_CSS;
        // The shell's interactive-child check already keeps this from
        // resuming; stopPropagation is belt-and-braces.
        helpBtn.addEventListener("pointerup", (event) => {
          event.stopPropagation();
          openHelp(root, help);
        });
        root.append(helpBtn);
      }
    },
  });
}
