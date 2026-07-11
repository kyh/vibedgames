// Starfall's bespoke pause overlay — the ship's holographic HUD on the shared
// @repo/embed pause shell (which owns resume behavior, fade, and the
// full-screen root): the arena keeps running behind it (online you pause AS A
// SPECTATOR, see game-scene), so the backdrop reuses the #start screen's
// "dark pool + edge vignette" trick — text stays legible while the battle
// reads through the clear centre ring. Palette/type extend index.html: mono
// uppercase copy in #9fb6e6, neon #7fb2ff accents, rgba(90,160,255) glows.

import { controlGroups, createPauseShell } from "@repo/embed";
import type { ControlMethod, PauseOverlay } from "@repo/embed";
import { CONTROLS } from "./controls";

/** Section headers for the grouped control rows, in HUD voice. */
const METHOD_LABELS: Record<ControlMethod, string> = {
  keys: "keyboard",
  mouse: "mouse",
  touch: "touch",
  camera: "camera",
  controller: "gamepad",
};

const STYLE_ID = "sf-pause-style";

// Positioning/z-index/fade live on the shell's root — visuals only here.
const CSS = `
#sf-pause {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: #fff;
  font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
  text-align: center;
  /* Same two-layer treatment as #start: a dark pool behind the panel for
     legibility, a soft edge vignette, and a clear ring so the live arena
     stays visible around the panel. */
  background:
    radial-gradient(
      ellipse 58% 46% at 50% 50%,
      rgba(2, 4, 14, 0.78),
      rgba(2, 4, 14, 0.32) 55%,
      rgba(2, 4, 14, 0) 74%
    ),
    radial-gradient(ellipse at 50% 50%, rgba(2, 4, 14, 0) 34%, rgba(2, 4, 14, 0.62) 100%);
}
.sf-pause-panel {
  position: relative;
  max-width: min(88vw, 430px);
  padding: 26px 34px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 13px;
  background: rgba(3, 7, 22, 0.62);
  border: 1px solid rgba(127, 178, 255, 0.24);
  box-shadow:
    0 0 36px rgba(90, 160, 255, 0.14),
    inset 0 0 26px rgba(90, 160, 255, 0.05);
}
/* Faint holo scanlines across the panel glass. */
.sf-pause-panel::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    0deg,
    rgba(159, 182, 230, 0.045) 0 1px,
    transparent 1px 3px
  );
}
.sf-pause-corner {
  position: absolute;
  width: 11px;
  height: 11px;
  border: 0 solid rgba(127, 178, 255, 0.75);
}
.sf-pause-corner-tl { top: -1px; left: -1px; border-top-width: 2px; border-left-width: 2px; }
.sf-pause-corner-tr { top: -1px; right: -1px; border-top-width: 2px; border-right-width: 2px; }
.sf-pause-corner-bl { bottom: -1px; left: -1px; border-bottom-width: 2px; border-left-width: 2px; }
.sf-pause-corner-br { bottom: -1px; right: -1px; border-bottom-width: 2px; border-right-width: 2px; }
.sf-pause-title {
  font-size: 27px;
  font-weight: 200;
  letter-spacing: 0.52em;
  text-indent: 0.52em;
  color: #eaf2ff;
  text-shadow: 0 0 20px rgba(90, 160, 255, 0.65);
  animation: sf-pause-flicker 4.5s ease-in-out infinite;
}
@keyframes sf-pause-flicker {
  0%, 100% { text-shadow: 0 0 20px rgba(90, 160, 255, 0.65); }
  48% { text-shadow: 0 0 30px rgba(120, 180, 255, 0.85); }
  52% { text-shadow: 0 0 12px rgba(90, 160, 255, 0.4); }
}
.sf-pause-sub {
  font-size: 10px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: #9fb6e6;
  opacity: 0.85;
  text-wrap: balance; /* narrow screens: no orphaned last word */
}
.sf-pause-controls {
  margin-top: 3px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.sf-pause-method {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  font-size: 9px;
  letter-spacing: 0.32em;
  text-indent: 0.32em;
  text-transform: uppercase;
  color: #7fb2ff;
  opacity: 0.6;
}
.sf-pause-method::before,
.sf-pause-method::after {
  content: "";
  height: 1px;
  width: 24px;
  background: rgba(127, 178, 255, 0.35);
}
.sf-pause-rows {
  display: grid;
  grid-template-columns: auto auto;
  gap: 6px 12px;
  align-items: center;
  justify-content: center;
  margin-top: 6px;
}
.sf-pause-key {
  justify-self: end;
  padding: 2px 8px 1px;
  border: 1px solid rgba(127, 178, 255, 0.3);
  border-radius: 3px;
  background: rgba(127, 178, 255, 0.08);
  color: #cfe0ff;
  font-size: 11px;
  letter-spacing: 0.1em;
  white-space: nowrap;
}
.sf-pause-action {
  justify-self: start;
  text-align: left;
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #9fb6e6;
}
.sf-pause-resume {
  margin-top: 5px;
  font-size: 12px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: #7fb2ff;
  text-shadow: 0 0 14px rgba(90, 160, 255, 0.6);
  animation: sf-pause-pulse 1.6s ease-in-out infinite;
}
@keyframes sf-pause-pulse {
  50% { opacity: 0.32; }
}
/* Bigger legible rows on touch devices (same bump index.html gives the HUD). */
@media (pointer: coarse) {
  .sf-pause-key, .sf-pause-action { font-size: 13px; }
  .sf-pause-sub { font-size: 11px; }
}
@media (prefers-reduced-motion: reduce) {
  .sf-pause-title, .sf-pause-resume { animation: none; }
}
`;

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Inject the shared control-card styles (pause overlay AND start screen).
 *  Same STYLE_ID the pause shell uses, so whichever runs first wins. */
export function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

/**
 * The grouped keycap rows both instruction surfaces render — the start screen
 * and the pause overlay teach controls with the SAME UI. Null when nothing is
 * visible for the current device/pad context.
 */
export function buildControls(coarse: boolean): HTMLElement | null {
  const groups = controlGroups(CONTROLS, { coarse });
  if (groups.length === 0) return null;
  const controls = el("div", "sf-pause-controls");
  for (const group of groups) {
    controls.append(el("div", "sf-pause-method", METHOD_LABELS[group.method]));
    const rows = el("div", "sf-pause-rows");
    for (const entry of group.entries) {
      rows.append(
        el("span", "sf-pause-key", entry.input),
        el("span", "sf-pause-action", entry.action),
      );
    }
    controls.append(rows);
  }
  return controls;
}

/**
 * Build Starfall's pause overlay on the shared @repo/embed pause shell — the
 * shell owns resume behavior (pointerup / non-Escape keyup / fresh pad press),
 * this file owns the holographic HUD look. Control rows re-render from the
 * shared manifest fresh on every show(), so plugging a pad in mid-run adds
 * its rows on the next pause.
 */
export function createStarfallPauseOverlay(): PauseOverlay {
  return createPauseShell({
    css: CSS,
    styleId: STYLE_ID,
    render: renderPanel,
  });
}

function renderPanel(root: HTMLElement): void {
  root.id = "sf-pause"; // the CSS hook (kept from the pre-shell overlay)
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  const panel = el("div", "sf-pause-panel");
  for (const corner of ["tl", "tr", "bl", "br"]) {
    panel.append(el("span", `sf-pause-corner sf-pause-corner-${corner}`));
  }

  panel.append(
    el("div", "sf-pause-title", "PAUSED"),
    el("div", "sf-pause-sub", "signal held — the battle rages on"),
  );

  const controls = buildControls(coarse);
  if (controls) panel.append(controls);

  panel.append(
    el("div", "sf-pause-resume", coarse ? "tap to resume" : "click or any key to resume"),
  );
  root.append(panel);
}
