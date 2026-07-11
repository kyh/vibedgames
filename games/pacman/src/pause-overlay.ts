// Pacman's own pause overlay — a soft "clinic sign" in the same plush
// Baymax-ward look as the title banner (index.html): cream scrim, plush white
// card, butter heading with the banner's white bump-shadow, pellet-dotted
// divider, and a gently chomping mouth motif up top.
//
// Built on the shared @repo/embed pause shell, which owns resume behavior
// (pointerup / non-Escape keyup / fresh pad press), the full-screen root, and
// the fade; the `.shown` class here only drives the card's spring-scale pop.

import { controlGroups, createPauseShell } from "@repo/embed";
import type { ControlMethod } from "@repo/embed";

import { CONTROLS } from "./controls";

const METHOD_LABELS: Record<ControlMethod, string> = {
  keys: "keys",
  mouse: "mouse",
  touch: "touch",
  camera: "face cam",
  controller: "controller",
};

const STYLE_ID = "pacman-pause-style";

// Palette custom properties (--cream, --butter, …) come from index.html :root,
// so the overlay re-skins for free if the game's palette ever changes.
// Positioning/z-index/fade live on the shell's root — visuals only here.
const CSS = `
#pacman-pause {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(18px + env(safe-area-inset-top)) calc(18px + env(safe-area-inset-right))
    calc(18px + env(safe-area-inset-bottom)) calc(18px + env(safe-area-inset-left));
  background: rgba(253, 241, 230, 0.72);
  backdrop-filter: blur(10px) saturate(1.15);
  -webkit-backdrop-filter: blur(10px) saturate(1.15);
  -webkit-tap-highlight-color: transparent;
  font-family: var(--round-font);
  color: var(--ink);
  text-align: center;
}
#pacman-pause .pp-card {
  max-width: min(88vw, 400px);
  max-height: 100%;
  overflow-y: auto;
  padding: 22px 28px 20px;
  background: rgba(255, 255, 255, 0.86);
  border: 1.5px solid var(--card-edge);
  border-radius: 30px;
  box-shadow:
    0 10px 30px rgba(212, 150, 167, 0.4),
    inset 0 2px 0 rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transform: scale(0.92);
  transition: transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1);
}
#pacman-pause.shown .pp-card {
  transform: scale(1);
}

/* Chomper motif — two plush jaws breathing open/closed, trailing pellets. */
#pacman-pause .pp-chomp-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 10px;
}
#pacman-pause .pp-chomp {
  position: relative;
  width: 44px;
  height: 44px;
  filter: drop-shadow(0 4px 10px rgba(212, 150, 167, 0.45));
}
#pacman-pause .pp-jaw {
  position: absolute;
  left: 0;
  width: 44px;
  height: 22px;
  background: var(--butter);
}
#pacman-pause .pp-jaw-top {
  top: 0;
  border-radius: 22px 22px 0 0;
  transform-origin: 50% 100%;
  transform: rotate(-14deg);
  animation: pp-jaw-top 1.15s ease-in-out infinite alternate;
}
#pacman-pause .pp-jaw-bot {
  top: 22px;
  border-radius: 0 0 22px 22px;
  transform-origin: 50% 0;
  transform: rotate(14deg);
  animation: pp-jaw-bot 1.15s ease-in-out infinite alternate;
}
#pacman-pause .pp-eye {
  position: absolute;
  top: 6px;
  left: 27px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ink);
}
#pacman-pause .pp-cheek {
  position: absolute;
  top: 5px;
  left: 7px;
  width: 8px;
  height: 5px;
  border-radius: 50%;
  background: rgba(242, 126, 157, 0.5);
}
@keyframes pp-jaw-top {
  from { transform: rotate(-4deg); }
  to { transform: rotate(-22deg); }
}
@keyframes pp-jaw-bot {
  from { transform: rotate(4deg); }
  to { transform: rotate(22deg); }
}
#pacman-pause .pp-pellets {
  display: flex;
  gap: 9px;
}
#pacman-pause .pp-pellet {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--blush);
  opacity: 0.65;
  box-shadow: 0 2px 4px rgba(212, 150, 167, 0.4);
}
#pacman-pause .pp-pellet:nth-child(2) {
  background: var(--butter);
}

/* Heading — the banner-title treatment, sized for a card. */
#pacman-pause .pp-title {
  font: 800 clamp(30px, 6vw, 40px)/1.1 var(--round-font);
  letter-spacing: 0.04em;
  color: var(--butter);
  text-shadow:
    0 2px 0 rgba(255, 255, 255, 0.9),
    0 8px 22px rgba(212, 150, 167, 0.45);
}
#pacman-pause .pp-sub {
  margin-top: 4px;
  font: 600 13px/1.4 var(--round-font);
  color: var(--blush);
}

/* Controls — grouped by input method under a pellet-trail divider. */
#pacman-pause .pp-groups {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 2px dotted rgba(242, 126, 157, 0.35);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
#pacman-pause .pp-group-label {
  margin-bottom: 6px;
  font: 700 10px/1 var(--round-font);
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--ink-soft);
}
#pacman-pause .pp-grid {
  display: grid;
  grid-template-columns: auto auto;
  gap: 6px 12px;
  align-items: center;
  justify-content: center;
}
#pacman-pause .pp-chip {
  justify-self: end;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--cream);
  border: 1.5px solid var(--card-edge);
  font: 700 12px/1.4 var(--round-font);
  color: var(--ink);
  white-space: nowrap;
}
#pacman-pause .pp-action {
  justify-self: start;
  font: 600 12.5px/1.4 var(--round-font);
  color: var(--ink);
  opacity: 0.85;
  text-align: left;
}

/* Resume affordance — a butter pill, same shape family as the HUD pills. */
#pacman-pause .pp-hint {
  display: inline-block;
  margin-top: 14px;
  padding: 8px 18px;
  border-radius: 999px;
  background: var(--butter);
  border: 1.5px solid rgba(245, 185, 66, 0.6);
  box-shadow: 0 6px 20px rgba(212, 150, 167, 0.35);
  font: 800 12px/1.3 var(--round-font);
  letter-spacing: 0.03em;
  color: #fff;
  text-shadow: 0 1px 0 rgba(107, 94, 102, 0.25);
}

@media (prefers-reduced-motion: reduce) {
  #pacman-pause .pp-card {
    transition: none;
  }
  #pacman-pause .pp-jaw-top,
  #pacman-pause .pp-jaw-bot {
    animation: none;
  }
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  parent.append(node);
  return node;
}

function buildChompRow(parent: HTMLElement): void {
  const row = div("pp-chomp-row", parent);
  const chomp = div("pp-chomp", row);
  const jawTop = div("pp-jaw pp-jaw-top", chomp);
  div("pp-eye", jawTop);
  const jawBot = div("pp-jaw pp-jaw-bot", chomp);
  div("pp-cheek", jawBot);
  const pellets = div("pp-pellets", row);
  for (let i = 0; i < 3; i++) div("pp-pellet", pellets);
}

let root: HTMLElement | null = null;

const shell = createPauseShell({
  fadeMs: 220,
  // Dropping `.shown` at the start of hide() lets the card spring back down
  // while the shell fades the root out — same exit as the hand-rolled version.
  onHide: () => {
    root?.classList.remove("shown");
    root = null;
  },
  render(overlay) {
    ensureStyle();
    root = overlay;
    overlay.id = "pacman-pause";
    // Same boot check as input-mode.ts / @repo/embed, re-evaluated fresh so
    // the hint copy and control rows match the device the moment we pause.
    const coarse = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;

    const card = div("pp-card", overlay);
    buildChompRow(card);

    const title = div("pp-title", card);
    title.textContent = "PAUSED";
    const sub = div("pp-sub", card);
    sub.textContent = "taking a little breather ♥";

    const groups = controlGroups(CONTROLS, { coarse });
    if (groups.length > 0) {
      const list = div("pp-groups", card);
      for (const group of groups) {
        const section = document.createElement("div");
        const label = div("pp-group-label", section);
        label.textContent = METHOD_LABELS[group.method];
        const grid = div("pp-grid", section);
        for (const entry of group.entries) {
          const chip = document.createElement("span");
          chip.className = "pp-chip";
          chip.textContent = entry.input;
          const action = document.createElement("span");
          action.className = "pp-action";
          action.textContent = entry.action;
          grid.append(chip, action);
        }
        list.append(section);
      }
    }

    const hint = div("pp-hint", card);
    hint.textContent = coarse ? "tap anywhere to resume" : "click or press any key to resume";

    requestAnimationFrame(() => overlay.classList.add("shown"));
  },
});

/** Mount the overlay. Idempotent while shown. */
export const show = shell.show;

/** Unmount (fade out). Idempotent while hidden. */
export const hide = shell.hide;

/** Drop-in for the stock createPauseOverlay() return shape. */
export const pauseOverlay = shell;
