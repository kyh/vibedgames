// Bespoke pause overlay — CRAZY WAYMO's own art direction on the shared
// @repo/embed pause shell (which owns resume behavior — tap/keyup/pad press,
// Escape stays with the core keydown toggle — idempotent show/hide, and the
// full-screen fading root); the look extends the landing banner: chunky
// italic gold display type, hazard-stripe bars, keycap chips.

import { controlGroups, createPauseShell } from "@repo/embed";

import { CONTROLS, METHOD_TAG } from "../controls";

export type PauseOverlay = {
  /** Mount the overlay. Idempotent while shown. */
  show: () => void;
  /** Unmount (fade out). Idempotent while hidden. */
  hide: () => void;
};

const STYLE_ID = "waymo-pause-style";

// Same palette + recipes as index.html: banner title (900 italic gold, -3deg),
// #banner-controls keycap chips (.hint/kbd/.lbl), #banner-cta gold pill.
// Positioning/z-index/fade live on the shell's root — visuals only here.
const CSS = `
#waymo-pause {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0;
  text-align: center;
  background: radial-gradient(circle at 50% 40%, rgba(20, 16, 28, 0.55), rgba(10, 8, 14, 0.86));
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  color: #fff;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
#waymo-pause .plate {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  transform: rotate(-3deg);
}
#waymo-pause .haz {
  width: min(400px, 64vw);
  height: 9px;
  border-radius: 3px;
  background: repeating-linear-gradient(-45deg, #ffd147 0 16px, #14111a 16px 32px);
  background-size: 45.25px 100%;
  box-shadow: 0 3px 0 rgba(0, 0, 0, 0.4);
  animation: waymo-haz 1.1s linear infinite;
}
@keyframes waymo-haz {
  to { background-position: 45.25px 0; }
}
#waymo-pause .pt {
  font: 900 italic clamp(42px, 9vw, 92px) / 0.95 system-ui, sans-serif;
  color: #ffd147;
  letter-spacing: -2px;
  text-shadow:
    0 6px 0 rgba(0, 0, 0, 0.45),
    0 0 40px rgba(255, 160, 40, 0.5);
}
#waymo-pause .psub {
  margin-top: 20px;
  font: 800 italic clamp(13px, 2.8vw, 17px) / 1.4 system-ui, sans-serif;
  letter-spacing: 2px;
  color: #aee3ff;
  max-width: 88vw;
  text-shadow: 0 2px 0 rgba(0, 0, 0, 0.5);
}
#waymo-pause .pcta {
  margin-top: 22px;
  font: 700 13px/1 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: 2px;
  color: #14111a;
  background: #ffd147;
  border-radius: 10px;
  padding: 11px 20px;
  box-shadow: 0 5px 0 rgba(0, 0, 0, 0.4);
  animation: waymo-pulse 1.4s ease-in-out infinite;
}
@keyframes waymo-pulse {
  50% { transform: scale(1.05); }
}
#waymo-pause .pgroups {
  margin-top: 30px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  max-width: min(680px, 92vw);
}
#waymo-pause .pgrp {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 12px 18px;
}
#waymo-pause .tag {
  font: 700 10px/1 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: 3px;
  color: rgba(255, 209, 71, 0.75);
}
#waymo-pause .hint {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
#waymo-pause kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 0 7px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-bottom-width: 2px;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font: 700 12px/1 ui-monospace, "SF Mono", Menlo, monospace;
}
#waymo-pause .lbl {
  font: 600 12px/1 system-ui, sans-serif;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.62);
}
@media (prefers-reduced-motion: reduce) {
  #waymo-pause .haz { animation: none; }
  #waymo-pause .pcta { animation: none; }
}
`;

/** One keycap chip group: "↑ / W" → [↑][W] caps + a lower-case verb label. */
function hintChip(input: string, action: string): HTMLElement {
  const group = document.createElement("span");
  group.className = "hint";
  for (const key of input.split(" / ")) {
    const cap = document.createElement("kbd");
    cap.textContent = key;
    group.append(cap);
  }
  const label = document.createElement("span");
  label.className = "lbl";
  label.textContent = action;
  group.append(label);
  return group;
}

/** Build CRAZY WAYMO's pause overlay. Same show/hide contract as the stock
 *  @repo/embed one — wire it into setPauseHandlers from main.ts. */

export function createPauseOverlay(): PauseOverlay {
  return createPauseShell({
    css: CSS,
    styleId: STYLE_ID,
    render: renderContent,
  });
}

function renderContent(overlay: HTMLElement): void {
  overlay.id = "waymo-pause";
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  // Title plate: hazard stripes framing PAUSED, all on the banner's -3° tilt.
  const plate = document.createElement("div");
  plate.className = "plate";
  const hazTop = document.createElement("div");
  hazTop.className = "haz";
  const title = document.createElement("div");
  title.className = "pt";
  title.textContent = "PAUSED";
  const hazBottom = document.createElement("div");
  hazBottom.className = "haz";
  plate.append(hazTop, title, hazBottom);

  const sub = document.createElement("div");
  sub.className = "psub";
  sub.textContent = "HAZARDS ON · FARE'S STILL WAITING";

  const cta = document.createElement("div");
  cta.className = "pcta";
  cta.textContent = coarse ? "TAP TO RESUME" : "CLICK OR PRESS ANY KEY";

  overlay.append(plate, sub, cta);

  // Controls, grouped per input method — fresh each show() so a pad plugged
  // in mid-run gets its PAD row.
  const groups = controlGroups(CONTROLS);
  if (groups.length > 0) {
    const list = document.createElement("div");
    list.className = "pgroups";
    for (const group of groups) {
      const row = document.createElement("div");
      row.className = "pgrp";
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = METHOD_TAG[group.method];
      row.append(tag);
      for (const entry of group.entries) row.append(hintChip(entry.input, entry.action));
      list.append(row);
    }
    overlay.append(list);
  }
}
