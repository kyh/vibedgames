// Farm's own pause overlay — a carved wooden sign hung over the frozen valley,
// in the same cozy pixel-farm look as the title screen (index.html / title-scene):
// warm plank browns, cream lettering with the title's chunky brown underside,
// parchment key chips, and the sprout-green "New Farm" button treatment for the
// resume hint. Wheat sprigs flank the heading; the sign sways gently on its ropes.
//
// Built on the shared @repo/embed pause shell, which owns the resume behavior
// (pointerup anywhere, keyup except Escape, fresh gamepad press) plus the
// full-screen root, fade, and idempotent show/hide. This file owns the look
// and the "how to play" parchment modal: while it is open the shell's
// `modalOpen` gate keeps keys and clicks from resuming (backdrop or "back"
// closes it), and `onHide` sweeps it when the overlay goes away.

import { controlGroups, createPauseShell } from "@repo/embed";
import type { ControlMethod } from "@repo/embed";

import { CONTROLS } from "./controls";

const METHOD_LABELS: Record<ControlMethod, string> = {
  keys: "keyboard",
  mouse: "mouse",
  touch: "touch",
  camera: "camera",
  controller: "controller",
};

/** One section of the "how to play" modal. */
type HelpSection = { readonly title: string; readonly body: string };

// The gameplay depth that used to live in the in-game How-to-Play modal —
// controls stay in CONTROLS, this is the systems knowledge.
const HELP: readonly HelpSection[] = [
  {
    title: "Farming",
    body: "Till soil with the 🪏 hoe, plant 🌱 seeds in their season, water with the 💧 can (refill at the pond — rain waters for you).",
  },
  {
    title: "Gathering",
    body: "🪓 Axe fells trees. ⛏ Pickaxe breaks rocks and works the mine. Walk over 🍄 mushrooms to forage them.",
  },
  {
    title: "Fishing",
    body: "Face water with the 🎣 rod to cast, then hold to reel while the fish sits in the zone.",
  },
  {
    title: "The mine",
    body: "Bring the ⚔ sword — skeletons haunt the cave.",
  },
  {
    title: "Animals",
    body: "🐔 Pet your animals; buy more at the coop and barn.",
  },
  {
    title: "Selling & rest",
    body: "🧺 Sell at the crate or the store. Sleep at your house to end the day.",
  },
  {
    title: "Villagers",
    body: "💬 Talk to villagers and gift what they like to earn ♥.",
  },
];

const STYLE_ID = "farm-pause-style";

// Palette lifted from the title screen: cream #fff6d5 lettering over
// #7a4a18/#b5762e wood, #5fae3a sprout green, parchment #f4ecd6.
// Pixel-chunky borders come from offset box-shadows (edges without corners),
// so every panel gets notched "carved" corners with zero images.
// Positioning/z-index/fade live on the shell's root — visuals only here.
const CSS = `
#farm-pause {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(30px + env(safe-area-inset-top)) calc(18px + env(safe-area-inset-right))
    calc(24px + env(safe-area-inset-bottom)) calc(18px + env(safe-area-inset-left));
  background: rgba(22, 30, 16, 0.58);
  backdrop-filter: blur(5px) saturate(1.05);
  -webkit-backdrop-filter: blur(5px) saturate(1.05);
  -webkit-tap-highlight-color: transparent;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color: #f4ecd6;
  text-align: center;
}

/* The hanging sign: ropes above, planks below, a gentle sway from the top. */
#farm-pause .fp-hang {
  max-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  transform-origin: 50% 0;
  animation: fp-sway 5.5s ease-in-out infinite alternate;
}
@keyframes fp-sway {
  from { transform: rotate(-0.5deg); }
  to { transform: rotate(0.5deg); }
}
#farm-pause .fp-ropes {
  width: min(78vw, 300px);
  height: 34px;
  flex: none;
  display: flex;
  justify-content: space-between;
  padding: 0 44px;
}
#farm-pause .fp-rope {
  position: relative;
  width: 6px;
  height: 100%;
  background: repeating-linear-gradient(160deg, #d3a95e 0 4px, #ab7c3e 4px 8px);
  box-shadow: 2px 0 0 rgba(0, 0, 0, 0.18);
}
/* Knot at the top of each rope, so it reads as tied off rather than floating. */
#farm-pause .fp-rope::before {
  content: "";
  position: absolute;
  top: 0;
  left: -4px;
  width: 14px;
  height: 8px;
  background: #ab7c3e;
  box-shadow: inset 0 2px 0 #d3a95e, inset 0 -2px 0 rgba(58, 33, 8, 0.4);
}

/* Sign board — plank fill, notched pixel border via offset shadows. */
#farm-pause .fp-sign {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  width: min(92vw, 420px);
  padding: 20px 22px 22px;
  background:
    repeating-linear-gradient(180deg, rgba(58, 33, 8, 0.16) 0 2px, rgba(255, 235, 190, 0.05) 2px 4px, transparent 4px 30px),
    linear-gradient(180deg, #a56f36 0%, #96622c 55%, #8a5826 100%);
  box-shadow:
    0 -6px 0 0 #6b3f16,
    0 6px 0 0 #6b3f16,
    -6px 0 0 0 #6b3f16,
    6px 0 0 0 #6b3f16,
    0 14px 0 0 rgba(0, 0, 0, 0.28),
    inset 0 3px 0 rgba(255, 235, 190, 0.22),
    inset 0 -4px 0 rgba(58, 33, 8, 0.28);
  position: relative;
}
#farm-pause .fp-nail {
  position: absolute;
  width: 8px;
  height: 8px;
  background: #553512;
  box-shadow: inset -2px -2px 0 rgba(0, 0, 0, 0.4), inset 2px 2px 0 rgba(255, 235, 190, 0.35);
}
#farm-pause .fp-nail.tl { top: 8px; left: 8px; }
#farm-pause .fp-nail.tr { top: 8px; right: 8px; }
#farm-pause .fp-nail.bl { bottom: 8px; left: 8px; }
#farm-pause .fp-nail.br { bottom: 8px; right: 8px; }

/* Heading — the title treatment (cream over carved brown), wheat either side. */
#farm-pause .fp-title-row {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 12px;
}
#farm-pause .fp-sprig {
  font-size: 20px;
  filter: drop-shadow(0 2px 0 rgba(58, 33, 8, 0.45));
}
#farm-pause .fp-title {
  font-size: clamp(30px, 7vw, 40px);
  font-weight: 900;
  letter-spacing: 0.14em;
  text-indent: 0.14em;
  color: #fff6d5;
  text-shadow:
    0 3px 0 #6b3f16,
    0 6px 14px rgba(0, 0, 0, 0.35);
}
#farm-pause .fp-sub {
  margin-top: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: #ffe9b0;
  opacity: 0.9;
}

/* Controls — grouped by input method under a carved groove. */
#farm-pause .fp-groups {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 2px solid rgba(58, 33, 8, 0.35);
  box-shadow: 0 -3px 0 -1px rgba(255, 235, 190, 0.14) inset;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
#farm-pause .fp-group-label {
  margin-bottom: 7px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: #eaffd0;
  opacity: 0.85;
}
#farm-pause .fp-grid {
  display: grid;
  grid-template-columns: auto auto;
  gap: 7px 12px;
  align-items: center;
  justify-content: center;
}
#farm-pause .fp-chip {
  justify-self: end;
  padding: 3px 9px;
  background: #f4ecd6;
  border: 2px solid #6b3f16;
  box-shadow: 0 3px 0 #6b3f16;
  font-size: 12px;
  font-weight: 700;
  color: #4a3010;
  white-space: nowrap;
}
#farm-pause .fp-action {
  justify-self: start;
  font-size: 12.5px;
  line-height: 1.35;
  color: #f8f0da;
  opacity: 0.92;
  text-align: left;
}

/* Resume hint — the title screen's sprout-green button, worn as a badge. */
#farm-pause .fp-hint {
  display: inline-block;
  margin-top: 16px;
  padding: 9px 18px;
  background: #5fae3a;
  border: 2px solid rgba(255, 255, 255, 0.5);
  box-shadow: 0 4px 0 #3d7a24, 0 8px 14px rgba(0, 0, 0, 0.25);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: #ffffff;
  text-shadow: 0 1px 0 rgba(45, 84, 24, 0.6);
}

/* How-to-play button — parchment plank, pressable. */
#farm-pause .fp-help-btn {
  display: inline-block;
  margin: 14px auto 2px;
  padding: 8px 16px;
  background: #f4ecd6;
  border: 2px solid #6b3f16;
  box-shadow: 0 4px 0 #6b3f16;
  cursor: pointer;
  font: 700 12px ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color: #6b3f16;
}
#farm-pause .fp-help-btn:active {
  transform: translateY(2px);
  box-shadow: 0 2px 0 #6b3f16;
}

/* How-to-play modal — a parchment almanac page over the sign. */
#farm-pause .fp-modal {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(24px + env(safe-area-inset-top)) 24px calc(24px + env(safe-area-inset-bottom));
  background: rgba(24, 18, 8, 0.6);
  cursor: default;
}
#farm-pause .fp-page {
  max-width: min(92vw, 440px);
  max-height: min(80vh, 560px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 20px 24px 22px;
  text-align: left;
  background:
    repeating-linear-gradient(180deg, rgba(122, 74, 24, 0.05) 0 2px, transparent 2px 6px),
    linear-gradient(180deg, #f8f0da 0%, #f0e4c4 100%);
  box-shadow:
    0 -6px 0 0 #c9a15c,
    0 6px 0 0 #c9a15c,
    -6px 0 0 0 #c9a15c,
    6px 0 0 0 #c9a15c,
    0 14px 0 0 rgba(0, 0, 0, 0.3);
  color: #574427;
}
#farm-pause .fp-page-title {
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.22em;
  color: #6b3f16;
}
#farm-pause .fp-section-title {
  margin-top: 14px;
  font-size: 12px;
  font-weight: 700;
  color: #3a7d2c;
}
#farm-pause .fp-section-body {
  margin-top: 4px;
  font-size: 12.5px;
  line-height: 1.55;
}
#farm-pause .fp-back-btn {
  display: inline-block;
  margin-top: 18px;
  padding: 8px 18px;
  background: #5fae3a;
  border: 2px solid rgba(255, 255, 255, 0.5);
  box-shadow: 0 4px 0 #3d7a24;
  cursor: pointer;
  font: 800 12px ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color: #ffffff;
  text-shadow: 0 1px 0 rgba(45, 84, 24, 0.6);
}
#farm-pause .fp-back-btn:active {
  transform: translateY(2px);
  box-shadow: 0 2px 0 #3d7a24;
}

@media (prefers-reduced-motion: reduce) {
  #farm-pause .fp-hang {
    animation: none;
  }
}
`;

let helpModal: HTMLDivElement | null = null;

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  parent.append(node);
  return node;
}

function closeHelp(): void {
  helpModal?.remove();
  helpModal = null;
}

function openHelp(host: HTMLElement): void {
  if (helpModal) return;

  helpModal = document.createElement("div");
  helpModal.className = "fp-modal";
  helpModal.setAttribute("role", "dialog");
  helpModal.setAttribute("aria-label", "How to play");
  // Clicks anywhere in the modal stay in the modal: backdrop closes it, the
  // page does nothing — neither may fall through to the overlay's resume.
  helpModal.addEventListener("pointerup", (event) => {
    event.stopPropagation();
    if (event.target === helpModal) closeHelp();
  });

  const page = div("fp-page", helpModal);
  const heading = div("fp-page-title", page);
  heading.textContent = "HOW TO PLAY";

  for (const section of HELP) {
    const title = div("fp-section-title", page);
    title.textContent = section.title;
    const body = div("fp-section-body", page);
    body.textContent = section.body;
  }

  const back = document.createElement("button");
  back.type = "button";
  back.className = "fp-back-btn";
  back.textContent = "back";
  back.addEventListener("pointerup", (event) => {
    event.stopPropagation();
    closeHelp();
  });
  page.append(back);

  host.append(helpModal);
}

function renderSign(root: HTMLElement): void {
  root.id = "farm-pause"; // the CSS hook (kept from the pre-shell overlay)
  // Same boot check as @repo/embed, re-evaluated fresh so the hint copy and
  // control rows match the device the moment we pause.
  const coarse = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;

  const hang = div("fp-hang", root);
  const ropes = div("fp-ropes", hang);
  div("fp-rope", ropes);
  div("fp-rope", ropes);

  const sign = div("fp-sign", hang);
  div("fp-nail tl", sign);
  div("fp-nail tr", sign);
  div("fp-nail bl", sign);
  div("fp-nail br", sign);

  const titleRow = div("fp-title-row", sign);
  const sprigL = div("fp-sprig", titleRow);
  sprigL.textContent = "🌾";
  const title = div("fp-title", titleRow);
  title.textContent = "PAUSED";
  const sprigR = div("fp-sprig", titleRow);
  sprigR.textContent = "🌾";

  const sub = div("fp-sub", sign);
  sub.textContent = "the farm waits for you ☀️";

  const groups = controlGroups(CONTROLS, { coarse });
  if (groups.length > 0) {
    const list = div("fp-groups", sign);
    for (const group of groups) {
      const section = document.createElement("div");
      const label = div("fp-group-label", section);
      label.textContent = METHOD_LABELS[group.method];
      const grid = div("fp-grid", section);
      for (const entry of group.entries) {
        const chip = document.createElement("span");
        chip.className = "fp-chip";
        chip.textContent = entry.input;
        const action = document.createElement("span");
        action.className = "fp-action";
        action.textContent = entry.action;
        grid.append(chip, action);
      }
      list.append(section);
    }
  }

  const hint = div("fp-hint", sign);
  hint.textContent = coarse
    ? "tap anywhere to keep farming"
    : "click or press any key to keep farming";

  const helpBtn = document.createElement("button");
  helpBtn.type = "button";
  helpBtn.className = "fp-help-btn";
  helpBtn.textContent = "📖 how to play";
  // The shell's interactive-child check already keeps this from resuming;
  // stopPropagation is belt-and-braces.
  helpBtn.addEventListener("pointerup", (event) => {
    event.stopPropagation();
    openHelp(root);
  });
  sign.append(helpBtn);
}

/** Drop-in for the stock createPauseOverlay() return shape. */
export const pauseOverlay = createPauseShell({
  css: CSS,
  styleId: STYLE_ID,
  fadeMs: 220,
  modalOpen: () => helpModal !== null,
  onHide: closeHelp,
  render: renderSign,
});

/** Mount the overlay. Idempotent while shown. */
export const show = pauseOverlay.show;

/** Unmount (fade out). Idempotent while hidden. */
export const hide = pauseOverlay.hide;
