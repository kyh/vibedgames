// Bespoke pause overlay — Bomberman's arcade attract-screen card on the
// shared @repo/embed pause shell (which owns resume behavior, fade, and the
// full-screen root): chunky NES-dialog pixel frame, ember palette from the
// start screen, a bomb with a live fuse spark. Renders control GROUPS from the
// shared CONTROLS manifest, re-filtered on every show().

import { controlGroups, createPauseShell } from "@repo/embed";
import type { ControlMethod } from "@repo/embed";

import { CONTROLS } from "./controls";

const STYLE_ID = "bm-pause-style";

// Palette lifted from index.html: #0e1020 field, #eef2ff ink, #cbd3f0 copy,
// rgba(120,140,220,…) pill borders, #ffbf6b / #ff7a2a ember accents.
// Positioning/z-index/fade live on the shell's root — visuals only here.
const CSS = `
.bm-pause {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: #eef2ff;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  text-align: center;
  background: radial-gradient(ellipse at center, rgba(8, 10, 24, 0.6) 0%, rgba(8, 10, 24, 0.84) 100%);
  backdrop-filter: blur(3px) saturate(1.08);
  -webkit-backdrop-filter: blur(3px) saturate(1.08);
}
/* Rising embers — same cheap CSS particles as the start screen's #start-embers. */
.bm-pause-embers {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}
.bm-pause-embers span {
  position: absolute;
  bottom: -14px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: radial-gradient(circle, #ffd66b 0%, #ff7a2a 55%, rgba(255, 90, 30, 0) 75%);
  animation: bm-ember-rise linear infinite;
}
@keyframes bm-ember-rise {
  0% { opacity: 0; transform: translateY(0) scale(0.5); }
  12% { opacity: 0.9; }
  100% { opacity: 0; transform: translateY(-46vh) scale(1); }
}
.bm-pause-card {
  position: relative;
  max-width: min(88vw, 380px);
  max-height: min(84vh, 560px);
  overflow-y: auto;
  padding: 26px 30px 24px;
  background: rgba(12, 14, 32, 0.94);
  /* NES-dialog frame: ink border, dark gap, faint blue halo. */
  border: 4px solid #eef2ff;
  box-shadow:
    0 0 0 4px #0e1020,
    0 0 0 6px rgba(120, 140, 220, 0.4),
    0 14px 44px rgba(0, 0, 0, 0.55);
}
.bm-pause-rivet {
  position: absolute;
  width: 8px;
  height: 8px;
  background: #ffbf6b;
  box-shadow: 0 0 8px rgba(255, 150, 60, 0.6);
}
.bm-pause-rivet.tl { top: -2px; left: -2px; }
.bm-pause-rivet.tr { top: -2px; right: -2px; }
.bm-pause-rivet.bl { bottom: -2px; left: -2px; }
.bm-pause-rivet.br { bottom: -2px; right: -2px; }
.bm-pause-bomb {
  position: relative;
  display: inline-block;
  font-size: 34px;
  line-height: 1;
  filter: drop-shadow(0 4px 0 rgba(0, 0, 0, 0.35));
}
.bm-pause-spark {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: radial-gradient(circle, #fff3b0 0%, #ffd66b 35%, #ff7a2a 65%, rgba(255, 90, 30, 0) 78%);
  animation: bm-pause-spark 0.5s steps(2) infinite;
}
@keyframes bm-pause-spark {
  50% { transform: scale(1.8); opacity: 0.5; }
}
.bm-pause-title {
  margin-top: 12px;
  font-size: 28px;
  font-weight: 800;
  letter-spacing: 0.32em;
  text-indent: 0.32em;
  /* Gold→ember gradient, same family as the BOMBERMAN logo letters. */
  background: linear-gradient(180deg, #ffe9a0 0%, #ffbf6b 45%, #ff7a2a 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 3px 0 rgba(0, 0, 0, 0.45)) drop-shadow(0 0 16px rgba(255, 140, 60, 0.3));
}
.bm-pause-hint {
  margin-top: 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 1px;
  color: #ffbf6b;
  animation: bm-pause-pulse 1.6s ease-in-out infinite;
}
@keyframes bm-pause-pulse {
  50% { opacity: 0.35; }
}
.bm-pause-rule {
  margin: 16px auto 0;
  width: 72%;
  height: 2px;
  background: repeating-linear-gradient(
    to right,
    rgba(120, 140, 220, 0.45) 0 6px,
    transparent 6px 12px
  );
}
.bm-pause-method {
  margin-top: 14px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.3em;
  text-indent: 0.3em;
  color: #8f9cd0;
}
.bm-pause-rows {
  margin-top: 8px;
  display: grid;
  grid-template-columns: auto auto;
  gap: 7px 12px;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}
.bm-pause-key {
  justify-self: end;
  padding: 3px 8px;
  font-weight: 700;
  white-space: nowrap;
  color: #eef2ff;
  background: rgba(120, 140, 220, 0.16);
  border: 1px solid rgba(120, 140, 220, 0.45);
  box-shadow: inset 0 -2px 0 rgba(10, 12, 28, 0.8);
}
.bm-pause-action {
  justify-self: start;
  text-align: left;
  color: #cbd3f0;
  opacity: 0.85;
}
@media (prefers-reduced-motion: reduce) {
  .bm-pause-hint, .bm-pause-spark { animation: none; }
  .bm-pause-embers { display: none; }
}
`;

const METHOD_LABELS: Record<ControlMethod, string> = {
  keys: "KEYBOARD",
  mouse: "MOUSE",
  touch: "TOUCH",
  camera: "CAMERA",
  controller: "GAMEPAD",
};

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

function el(className: string, text?: string): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export type BombermanPauseOverlay = {
  /** Mount the overlay. Idempotent while shown. */
  show: () => void;
  /** Unmount (fade out). Idempotent while hidden. */
  hide: () => void;
};

/**
 * Build Bomberman's pause overlay on the shared @repo/embed pause shell — the
 * shell owns resume behavior (pointerup / non-Escape keyup / fresh pad press),
 * this file owns the arcade attract-card look.
 */
export function createBombermanPauseOverlay(): BombermanPauseOverlay {
  return createPauseShell({
    className: "bm-pause",
    render: renderCard,
  });
}

function renderCard(overlay: HTMLElement): void {
  ensureStyle();
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  // Same rising embers the start screen drifts up behind its copy.
  const embers = el("bm-pause-embers");
  embers.setAttribute("aria-hidden", "true");
  for (const [left, duration, delay] of [
    [14, 3.4, 0],
    [33, 4.2, 1.3],
    [51, 3.1, 0.6],
    [68, 4.6, 2],
    [86, 3.6, 1],
  ]) {
    const ember = document.createElement("span");
    ember.style.left = `${left}%`;
    ember.style.animationDuration = `${duration}s`;
    ember.style.animationDelay = `${delay}s`;
    embers.append(ember);
  }
  overlay.append(embers);

  const card = el("bm-pause-card");
  card.append(
    el("bm-pause-rivet tl"),
    el("bm-pause-rivet tr"),
    el("bm-pause-rivet bl"),
    el("bm-pause-rivet br"),
  );

  const bomb = document.createElement("div");
  bomb.className = "bm-pause-bomb";
  bomb.textContent = "💣";
  bomb.setAttribute("aria-hidden", "true");
  bomb.append(el("bm-pause-spark"));
  card.append(bomb);

  card.append(el("bm-pause-title", "PAUSED"));
  card.append(el("bm-pause-hint", coarse ? "TAP TO RESUME" : "CLICK OR PRESS ANY KEY TO RESUME"));

  // Fresh groups every show(): touch rows on coarse pointers, keyboard rows
  // on fine ones, gamepad rows only while a pad is actually connected.
  const groups = controlGroups(CONTROLS, { coarse });
  if (groups.length > 0) card.append(el("bm-pause-rule"));
  for (const group of groups) {
    card.append(el("bm-pause-method", METHOD_LABELS[group.method]));
    const rows = el("bm-pause-rows");
    for (const entry of group.entries) {
      const key = document.createElement("span");
      key.className = "bm-pause-key";
      key.textContent = entry.input;
      const action = document.createElement("span");
      action.className = "bm-pause-action";
      action.textContent = entry.action;
      rows.append(key, action);
    }
    card.append(rows);
  }

  overlay.append(card);
}
