// Bespoke wrapper pause overlay — this game's HUD language (the banner's
// display face, the hotkey bar's keycap chips, the legend's per-method rows,
// and a faint architectural grid echoing the well) on the shared @repo/embed
// pause shell, which owns the full-screen root and resume behavior (pointerup
// / any-keyup-except-Escape / fresh pad press), fade, and idempotent
// show/hide. This is the game's ONLY pause surface: Escape, P and pad START
// all land here via the embed pause state machine.

import { controlGroups, createPauseShell } from "@repo/embed";
import type { ControlGroup } from "@repo/embed";

import { CONTROLS, METHOD_LABEL } from "./controls";

// The game's palette (index.html): ink #d7dcf0 on #12131f, accent #8ea2ff,
// pill borders rgba(120,134,200,·).
const LINE = "rgba(120,134,200,"; // + alpha)
const INK = "rgba(215,220,240,"; // + alpha)

// Positioning/z-index/cursor/fade live on the shell's root — visuals only here.
const CSS = `
.tetris-pause {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 24px calc(16px + env(safe-area-inset-right, 0px))
    calc(24px + env(safe-area-inset-bottom, 0px)) calc(16px + env(safe-area-inset-left, 0px));
  background: rgba(14, 15, 26, 0.72);
  backdrop-filter: blur(7px);
  -webkit-backdrop-filter: blur(7px);
  color: #d7dcf0;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  text-align: center;
}
`;

/** One legend-style row: method label + keycap-chip entries, wrap-centred.
 *  Shared with the title legend (#legend) so both instruction surfaces speak
 *  the same visual language. */
export function groupRow(group: ControlGroup, coarse: boolean): HTMLElement {
  const row = document.createElement("div");
  // 12px → 11px on touch, the same step #legend takes on small screens.
  row.style.cssText =
    "display:flex;flex-wrap:wrap;justify-content:center;align-items:center;" +
    `gap:7px 14px;font-size:${coarse ? 11 : 12}px;letter-spacing:0.4px;color:${INK}0.72)`;

  const label = document.createElement("b");
  label.textContent = METHOD_LABEL[group.method];
  label.style.cssText =
    "color:#8ea2ff;font-weight:600;font-size:11px;letter-spacing:2px;" +
    "text-transform:uppercase;margin-right:2px";
  row.append(label);

  for (const entry of group.entries) {
    const item = document.createElement("span");
    item.style.cssText = "white-space:nowrap";
    const key = document.createElement("kbd");
    key.textContent = entry.input;
    // Same chip as the in-play #hotkeys bar.
    key.style.cssText =
      `font:inherit;color:#8ea2ff;background:rgba(20,22,36,0.66);border:1px solid ${LINE}0.28);` +
      "border-radius:5px;padding:1px 6px;margin-right:6px";
    item.append(key, document.createTextNode(entry.action));
    row.append(item);
  }
  return row;
}

/** Thin gradient rule — the well's line weight, used as a section divider. */
function rule(margin: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    `width:min(64vw,380px);height:1px;margin:${margin};position:relative;` +
    `background:linear-gradient(90deg,transparent,${LINE}0.6),transparent)`;
  return el;
}

/** Overlay content, rebuilt fresh every show() so the legend rows track the
 *  live context (touch vs keys, pad only while connected). */
function renderContent(overlay: HTMLElement): void {
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  // Faint square grid behind the content — the well's wireframe, flattened.
  const grid = document.createElement("div");
  grid.setAttribute("aria-hidden", "true");
  const gridMask = "radial-gradient(ellipse 62% 56% at 50% 46%,#000 30%,transparent 78%)";
  grid.style.cssText =
    "position:absolute;inset:-1px;pointer-events:none;" +
    `background-image:linear-gradient(${LINE}0.11) 1px,transparent 1px),` +
    `linear-gradient(90deg,${LINE}0.11) 1px,transparent 1px);` +
    `background-size:44px 44px;background-position:center;` +
    `mask-image:${gridMask};-webkit-mask-image:${gridMask}`;

  // Banner-title face (same font/shadow as the TETRIS title).
  const title = document.createElement("div");
  title.textContent = "PAUSED";
  title.style.cssText =
    "position:relative;font:800 clamp(34px,7vw,64px)/1.1 system-ui,sans-serif;color:#fff;" +
    "letter-spacing:0.08em;text-indent:0.08em;" +
    "text-shadow:0 4px 0 rgba(0,0,0,0.4),0 0 32px rgba(120,134,255,0.4)";

  // Banner-sub face for the resume hint (15px → 13px on touch, as #banner-sub).
  const hint = document.createElement("div");
  hint.textContent = coarse ? "tap anywhere to resume" : "click or press any key to resume";
  hint.style.cssText =
    `position:relative;margin-top:12px;font-size:${coarse ? 13 : 15}px;color:${INK}0.85);` +
    "text-shadow:0 2px 0 rgba(0,0,0,0.45)";

  // Controls, grouped per input method.
  const legend = document.createElement("div");
  legend.style.cssText =
    "position:relative;display:flex;flex-direction:column;align-items:center;" +
    "gap:13px;max-width:min(92vw,640px)";
  for (const group of controlGroups(CONTROLS)) legend.append(groupRow(group, coarse));

  overlay.append(grid, title, hint, rule("24px 0 20px"), legend);
}

/** show(): mount the overlay; hide(): fade it out. Both idempotent. */
export const { show, hide } = createPauseShell({
  className: "tetris-pause",
  css: CSS,
  styleId: "tetris-pause-style",
  fadeMs: 220,
  render: renderContent,
});
