import { controlGroups, createPauseShell } from "@repo/embed";
import type { ControlMethod, MuteAccessor } from "@repo/embed";

import { visibleControls } from "./controls";

export interface PongPauseOverlay {
  /** Mount the overlay. Idempotent while shown. */
  show: () => void;
  /** Unmount (fade out). Idempotent while hidden. */
  hide: () => void;
}

const PAPER = "#d4d4d4";
const INK = "#000";
const FONT = "ui-monospace,'SF Mono',Menlo,monospace";

const SCRIM =
  `radial-gradient(circle, ${INK} 0 1.3px, transparent 1.3px) 0 0 / 6px 6px,` +
  `radial-gradient(circle, ${INK} 0 1.3px, transparent 1.3px) 3px 3px / 6px 6px`;

const GROUP_LABELS = {
  camera: "HAND CAM",
  controller: "PAD",
  keys: "KEYS",
  mouse: "MOUSE",
  touch: "TOUCH",
} satisfies Readonly<Record<ControlMethod, string>>;

const inkChip = (text: string) => {
  const chip = document.createElement("span");
  chip.textContent = text;
  chip.style.cssText =
    `display:inline-block;padding:2px 8px;border:1.5px solid ${INK};` +
    `box-shadow:2px 2px 0 ${INK};background:${PAPER};` +
    "font-size:11px;font-weight:700;letter-spacing:1px;white-space:nowrap";

  return chip;
};

const inkBlock = (width: number, height: number) => {
  const block = document.createElement("span");
  block.style.cssText = `width:${width}px;height:${height}px;background:${INK};flex:none`;

  return block;
};

const dashes = () => {
  const line = document.createElement("span");
  line.style.cssText = `flex:1;height:0;border-top:2px dashed ${INK}`;

  return line;
};

const renderCard = (overlay: HTMLElement, matchContinues: boolean) => {
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  overlay.style.cssText +=
    "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "gap:18px;padding:24px;" +
    `background:${SCRIM};` +
    `color:${INK};font-family:${FONT};text-align:center`;

  const card = document.createElement("div");
  card.style.cssText =
    `background:${PAPER};border:2px solid ${INK};box-shadow:6px 6px 0 ${INK};` +
    "max-width:min(88vw,380px);max-height:min(84vh,560px);overflow-y:auto";

  const title = document.createElement("div");
  title.textContent = matchContinues ? "CONTROLS" : "PAUSED";
  title.style.cssText =
    `background:${INK};color:${PAPER};padding:10px 20px;` +
    "font-size:20px;font-weight:800;letter-spacing:8px;text-indent:8px";

  const court = document.createElement("div");
  court.setAttribute("aria-hidden", "true");
  court.style.cssText = "display:flex;align-items:center;gap:8px;padding:16px 20px 4px";
  court.append(inkBlock(4, 18), dashes(), inkBlock(7, 7), dashes(), inkBlock(4, 18));

  const body = document.createElement("div");
  body.style.cssText = "padding:4px 22px 0;text-align:left";

  const note = document.createElement("p");
  note.textContent = matchContinues
    ? "Live match continues while these controls are open."
    : "Your match is frozen. Take your time.";
  note.style.cssText = "font-size:12px;line-height:1.6;text-align:center;margin:10px 0 4px";
  const shots = document.createElement("p");
  shots.textContent =
    "Every return adds charge. After four, trigger a power shot on your next hit. " +
    "Hit with your paddle’s left third to slice, center for a flat return, or right third for faster, lower topspin.";
  shots.style.cssText = "font-size:12px;line-height:1.6;margin:12px 0 4px";
  body.append(note, shots);

  for (const group of controlGroups(visibleControls(), { coarse })) {
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
      const key = inkChip(entry.input);
      key.style.justifySelf = "start";
      const action = document.createElement("span");
      action.textContent = entry.action;
      action.style.cssText = "font-size:12px;letter-spacing:1px;opacity:0.78";
      grid.append(key, action);
    }

    body.append(grid);
  }

  const hint = document.createElement("div");
  const action = matchContinues ? "RETURN" : "RESUME";
  hint.textContent = coarse ? `TAP TO ${action}` : `CLICK OR ANY KEY TO ${action}`;
  hint.style.cssText =
    `margin-top:16px;border-top:2px dashed ${INK};padding:12px 22px 14px;` +
    "font-size:11px;font-weight:700;letter-spacing:3px;text-align:center;opacity:0.8";

  card.append(title, court, body, hint);
  overlay.append(card);
};

const SOUND_TOGGLE_CSS = `
.pong-pause .vg-pause-sound {
  margin: 0;
  padding: 0 14px;
  min-height: 44px;
  border-radius: 0;
  background: ${PAPER};
  border: 2px solid ${INK};
  box-shadow: 4px 4px 0 ${INK};
  color: ${INK};
  font: 800 11px ${FONT};
  letter-spacing: 3px;
  text-transform: uppercase;
}
`;

export const createPongPauseOverlay = (
  matchContinues: () => boolean,
  mute: MuteAccessor | undefined,
) =>
  createPauseShell({
    className: "pong-pause",
    css: SOUND_TOGGLE_CSS,
    fadeMs: 220,
    mute,
    render: (overlay) => renderCard(overlay, matchContinues()),
    styleId: "pong-pause-css",
  });
