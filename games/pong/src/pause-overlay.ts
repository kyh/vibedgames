// Bespoke pause overlay — pong's ink-on-paper skin on the shared @repo/embed
// pause shell (which owns resume behavior, the full-screen root, and the
// fade; Escape stays with the core keydown toggle).
//
// Art direction: the game renders through a 2-tone Bayer dither — cream paper
// + dark ink, like a printed page. The overlay keeps that world: a checkered
// ink scrim at the dither's own pixel scale (2px cells, a 50% Bayer field),
// and a paper card with the camera panel's hard ink border + offset shadow.
// Nothing lighter than the paper tone, no greys the dither couldn't print.

import { controlGroups, createPauseShell } from "@repo/embed";
import type { ControlMethod } from "@repo/embed";

import { CONTROLS } from "./controls";

export type PongPauseOverlay = {
  /** Mount the overlay. Idempotent while shown. */
  show: () => void;
  /** Unmount (fade out). Idempotent while hidden. */
  hide: () => void;
};

const PAPER = "#d4d4d4";
const INK = "#000";
const FONT = "ui-monospace,'SF Mono',Menlo,monospace";

// Halftone dot screen over the live paper scene — two offset ink-dot grids
// (a printer's rosette) darken the paper toward a mid-grey the way the
// game's own vignette dots do. A tighter 2px checker moirés against the
// Bayer field; this coarser dot pitch sits calmly on top of it.
const SCRIM =
  `radial-gradient(circle, ${INK} 0 1.3px, transparent 1.3px) 0 0 / 6px 6px,` +
  `radial-gradient(circle, ${INK} 0 1.3px, transparent 1.3px) 3px 3px / 6px 6px`;

const GROUP_LABELS: Readonly<Record<ControlMethod, string>> = {
  keys: "KEYS",
  mouse: "MOUSE",
  touch: "TOUCH",
  camera: "HAND CAM",
  controller: "PAD",
};

/** A solid ink block (paddle / ball) for the court divider glyph. */
function inkBlock(width: number, height: number): HTMLElement {
  const block = document.createElement("span");
  block.style.cssText = `width:${width}px;height:${height}px;background:${INK};flex:none`;
  return block;
}

/** Dashed court line segment — the net, printed. */
function dashes(): HTMLElement {
  const line = document.createElement("span");
  line.style.cssText = `flex:1;height:0;border-top:2px dashed ${INK}`;
  return line;
}

export function createPongPauseOverlay(): PongPauseOverlay {
  return createPauseShell({ fadeMs: 220, render: renderCard });
}

function renderCard(overlay: HTMLElement): void {
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  // Visuals only — positioning/z-index/fade already live on the shell's root.
  overlay.style.cssText +=
    "display:flex;align-items:center;justify-content:center;padding:24px;" +
    `background:${SCRIM};` +
    `color:${INK};font-family:${FONT};text-align:center`;

  // Paper card — camera panel's framing: hard ink border + offset shadow.
  const card = document.createElement("div");
  card.style.cssText =
    `background:${PAPER};border:2px solid ${INK};box-shadow:6px 6px 0 ${INK};` +
    "max-width:min(88vw,380px);max-height:min(84vh,560px);overflow-y:auto";

  // Inverted title bar, like the HAND CONTROL label writ large.
  const title = document.createElement("div");
  title.textContent = "PAUSED";
  title.style.cssText =
    `background:${INK};color:${PAPER};padding:10px 20px;` +
    "font-size:20px;font-weight:800;letter-spacing:8px;text-indent:8px";

  // Court glyph: paddle — net — ball — net — paddle.
  const court = document.createElement("div");
  court.setAttribute("aria-hidden", "true");
  court.style.cssText = "display:flex;align-items:center;gap:8px;padding:16px 20px 4px";
  court.append(inkBlock(4, 18), dashes(), inkBlock(7, 7), dashes(), inkBlock(4, 18));

  const body = document.createElement("div");
  body.style.cssText = "padding:4px 22px 0;text-align:left";

  // Controls, grouped by method — filtered fresh each show() so a pad
  // plugged in mid-game earns its PAD section on the next pause.
  for (const group of controlGroups(CONTROLS, { coarse })) {
    const label = document.createElement("div");
    label.textContent = GROUP_LABELS[group.method];
    label.style.cssText =
      `display:inline-block;margin:12px 0 7px;background:${INK};color:${PAPER};` +
      "padding:2px 7px;font-size:9px;font-weight:700;letter-spacing:2px";
    body.append(label);

    const grid = document.createElement("div");
    grid.style.cssText =
      "display:grid;grid-template-columns:auto 1fr;gap:6px 12px;align-items:center";
    for (const entry of group.entries) {
      const key = document.createElement("span");
      key.textContent = entry.input;
      key.style.cssText =
        `justify-self:start;padding:2px 8px;border:1.5px solid ${INK};` +
        `box-shadow:2px 2px 0 ${INK};background:${PAPER};` +
        "font-size:11px;font-weight:700;letter-spacing:1px;white-space:nowrap";
      const action = document.createElement("span");
      action.textContent = entry.action;
      action.style.cssText = "font-size:12px;letter-spacing:1px;opacity:0.78";
      grid.append(key, action);
    }
    body.append(grid);
  }

  // Resume hint — footer under a dashed rule, printed small caps.
  const hint = document.createElement("div");
  hint.textContent = coarse ? "TAP TO RESUME" : "CLICK OR ANY KEY TO RESUME";
  hint.style.cssText =
    `margin-top:16px;border-top:2px dashed ${INK};padding:12px 22px 14px;` +
    "font-size:11px;font-weight:700;letter-spacing:3px;text-align:center;opacity:0.8";

  card.append(title, court, body, hint);
  overlay.append(card);
}
