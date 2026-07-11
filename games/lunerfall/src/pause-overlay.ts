// Lunerfall's bespoke pause overlay — built on the shared @repo/embed pause
// shell (which owns resume behavior — pointerup / keyup except Escape / fresh
// pad press — idempotent show/hide, and the full-screen fading root), reskinned
// in the hub's moonlit pixel language: a chunky steel-blue pixel panel (notched
// corners, hard offset shadow) over a night scrim, a box-shadow pixel-art
// crescent moon bobbing one moon-pixel at a time, a twinkling star field, and
// the hub palette — teal #34e5c8 headings, shard-gold #ffd15c key caps,
// blue-grey copy. Online co-op/versus keeps running behind it (main.ts only
// freezes the loop offline), so the scrim stays translucent enough to read the
// arena through. Control rows re-render from CONTROLS via controlGroups()
// fresh each show().

import { controlGroups, createPauseShell } from "@repo/embed";
import type { ControlMethod, PauseOverlay } from "@repo/embed";
import { CONTROLS } from "./controls";

/** Section headers for the grouped control rows, in hub voice. */
const METHOD_LABELS: Record<ControlMethod, string> = {
  keys: "keyboard",
  mouse: "mouse",
  touch: "touch",
  camera: "camera",
  controller: "gamepad",
};

// Pixel-art crescent (12×12 grid, 1em = one moon pixel) drawn entirely with
// box-shadow squares — no image assets, crisp at any integer scale.
const MOON_LIT =
  "3em 1em,4em 1em,2em 2em,3em 2em,1em 3em,2em 3em,1em 4em,2em 4em,1em 5em," +
  "2em 5em,1em 6em,2em 6em,1em 7em,2em 7em,3em 7em,1em 8em,2em 8em,3em 8em," +
  "4em 8em,2em 9em,3em 9em,4em 9em,5em 9em,6em 9em,3em 10em,4em 10em,5em 10em,6em 10em";
const MOON_SHADE =
  "3em 3em,3em 4em,3em 5em,3em 6em,4em 7em,5em 8em,7em 9em,8em 9em,9em 9em,7em 10em,8em 10em";

// Star field: two twinkle layers of box-shadow points scattered in viewport
// units, so they spread with the screen. Pure decoration — pointer-events off.
const STARS_A =
  "8vw 12vh #f4f7fb,22vw 28vh #8b95a1,31vw 8vh #d8dee6,44vw 20vh #8b95a1," +
  "58vw 9vh #f4f7fb,71vw 24vh #d8dee6,84vw 14vh #8b95a1,93vw 30vh #f4f7fb," +
  "12vw 78vh #8b95a1,88vw 72vh #d8dee6";
const STARS_B =
  "15vw 18vh #d8dee6,27vw 6vh #f4f7fb,39vw 30vh #8b95a1,52vw 15vh #34e5c8," +
  "66vw 6vh #d8dee6,78vw 19vh #f4f7fb,91vw 8vh #8b95a1,6vw 34vh #d8dee6," +
  "34vw 82vh #8b95a1,64vw 76vh #f4f7fb";

const STYLE_ID = "lf-pause-style";

// Positioning/z-index/fade live on the shell's root — visuals only here.
const CSS = `
#lf-pause {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  color: #f4f7fb;
  font-family: "Courier New", ui-monospace, Menlo, monospace;
  text-align: center;
  /* Moonlit night scrim — bluer at the top of the sky, near-black at the
     ground, translucent enough that a live co-op/versus arena reads through. */
  background: linear-gradient(
    180deg,
    rgba(13, 20, 33, 0.86),
    rgba(7, 10, 17, 0.8) 46%,
    rgba(5, 7, 11, 0.88)
  );
}
.lf-pause-stars,
.lf-pause-stars::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 2px;
  height: 2px;
  pointer-events: none;
  background: transparent;
}
.lf-pause-stars {
  box-shadow: ${STARS_A};
  animation: lf-pause-twinkle 3.2s ease-in-out infinite;
}
.lf-pause-stars::after {
  box-shadow: ${STARS_B};
  animation: lf-pause-twinkle 3.2s ease-in-out -1.6s infinite;
}
@keyframes lf-pause-twinkle {
  0%, 100% { opacity: 0.9; }
  50% { opacity: 0.25; }
}
.lf-pause-panel {
  position: relative;
  max-width: min(92vw, 460px);
  max-height: min(86vh, 640px);
  overflow-y: auto;
  padding: 20px 30px 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  background: linear-gradient(180deg, rgba(15, 21, 34, 0.96), rgba(8, 11, 18, 0.96));
  /* Chunky pixel border: steel-blue wall, night gap, faint teal rim — then a
     hard (unblurred) drop like a sprite's cast shadow. */
  border: 3px solid #33445e;
  box-shadow:
    0 0 0 3px #05070b,
    0 0 0 4px rgba(52, 229, 200, 0.28),
    6px 8px 0 rgba(0, 0, 0, 0.45);
}
/* 3px page-colour squares over each border corner — pixel-rounded corners. */
.lf-pause-notch {
  position: absolute;
  width: 3px;
  height: 3px;
  background: #05070b;
}
.lf-pause-notch-tl { top: -3px; left: -3px; }
.lf-pause-notch-tr { top: -3px; right: -3px; }
.lf-pause-notch-bl { bottom: -3px; left: -3px; }
.lf-pause-notch-br { bottom: -3px; right: -3px; }
.lf-pause-moon {
  position: relative;
  flex: none; /* zero-content flex item — without this an overflowing panel shrinks it to 0 */
  left: -4em; /* the shadow grid draws below-RIGHT of the anchor; recentre optically */
  width: 1em;
  height: 1em;
  font-size: 3px; /* 1em = one moon pixel */
  margin: 3px 0 24px; /* clears the 12em shadow grid drawn below-right */
  background: transparent;
  box-shadow: ${MOON_LIT.split(",")
    .map((p) => `${p} #e9eef6`)
    .join(",")},
    ${MOON_SHADE.split(",")
      .map((p) => `${p} #aebbd1`)
      .join(",")};
  animation: lf-pause-moonbob 2.6s steps(2, jump-none) infinite alternate;
}
@keyframes lf-pause-moonbob {
  from { transform: translateY(0); }
  to { transform: translateY(-3px); }
}
.lf-pause-title {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.42em;
  text-indent: 0.42em;
  color: #34e5c8;
}
.lf-pause-sub {
  font-size: 11px;
  letter-spacing: 0.18em;
  color: #8b95a1;
  text-wrap: balance;
}
.lf-pause-controls {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lf-pause-method {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 9px;
  letter-spacing: 0.3em;
  text-indent: 0.3em;
  text-transform: uppercase;
  color: #59636f;
}
.lf-pause-method::before,
.lf-pause-method::after {
  content: "";
  height: 2px;
  width: 22px;
  background: #1e2733;
}
.lf-pause-rows {
  display: grid;
  grid-template-columns: auto auto;
  gap: 5px 12px;
  align-items: center;
  justify-content: center;
  margin-top: 4px;
}
.lf-pause-key {
  justify-self: end;
  padding: 2px 7px;
  border: 2px solid #33445e;
  background: #141922;
  box-shadow: inset 0 -2px 0 #0a0c11; /* pixel key-cap bevel */
  color: #ffd15c;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  white-space: nowrap;
}
.lf-pause-action {
  justify-self: start;
  text-align: left;
  font-size: 11px;
  letter-spacing: 0.1em;
  color: #b8c1cc;
}
.lf-pause-resume {
  margin-top: 8px;
  font-size: 11px;
  letter-spacing: 0.2em;
  color: #34e5c8;
  animation: lf-pause-pulse 1.5s ease-in-out infinite;
}
.lf-pause-resume::before { content: "✦ "; color: #ffd15c; }
.lf-pause-resume::after { content: " ✦"; color: #ffd15c; }
@keyframes lf-pause-pulse {
  50% { opacity: 0.35; }
}
/* Bigger legible rows on touch devices. */
@media (pointer: coarse) {
  .lf-pause-key, .lf-pause-action { font-size: 13px; }
  .lf-pause-sub { font-size: 12px; }
}
/* Short viewports (landscape phones): tighten the vertical chrome so the
   whole panel — moon to resume hint — fits without scrolling. */
@media (max-height: 480px) {
  .lf-pause-panel { padding: 12px 24px 14px; gap: 7px; }
  .lf-pause-title { font-size: 18px; }
  .lf-pause-controls { margin-top: 2px; gap: 6px; }
  .lf-pause-rows { gap: 3px 10px; margin-top: 2px; }
  .lf-pause-resume { margin-top: 4px; }
}
@media (prefers-reduced-motion: reduce) {
  .lf-pause-stars, .lf-pause-stars::after, .lf-pause-moon, .lf-pause-resume {
    animation: none;
  }
}
`;

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Build Lunerfall's pause overlay. Control rows re-render from the shared
 * manifest fresh on every show(), so plugging a pad in mid-run adds its rows
 * on the next pause.
 */
export function createLunerfallPauseOverlay(): PauseOverlay {
  return createPauseShell({
    css: CSS,
    styleId: STYLE_ID,
    fadeMs: 220,
    render: renderPanel,
  });
}

function renderPanel(overlay: HTMLElement): void {
  overlay.id = "lf-pause";
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  overlay.append(el("span", "lf-pause-stars"));

  const panel = el("div", "lf-pause-panel");
  for (const corner of ["tl", "tr", "bl", "br"]) {
    panel.append(el("span", `lf-pause-notch lf-pause-notch-${corner}`));
  }

  panel.append(
    el("span", "lf-pause-moon"),
    el("div", "lf-pause-title", "PAUSED"),
    el("div", "lf-pause-sub", "the moon holds its breath"),
  );

  const groups = controlGroups(CONTROLS, { coarse });
  if (groups.length > 0) {
    const controls = el("div", "lf-pause-controls");
    for (const group of groups) {
      controls.append(el("div", "lf-pause-method", METHOD_LABELS[group.method]));
      const rows = el("div", "lf-pause-rows");
      // Merge same-action bindings within a group ("J / X — attack"), the
      // same voice as the hub blurb's controls line.
      const byAction = new Map<string, string[]>();
      for (const entry of group.entries) {
        const inputs = byAction.get(entry.action);
        if (inputs) {
          if (!inputs.includes(entry.input)) inputs.push(entry.input);
        } else {
          byAction.set(entry.action, [entry.input]);
        }
      }
      for (const [action, inputs] of byAction) {
        rows.append(
          el("span", "lf-pause-key", inputs.join(" / ")),
          el("span", "lf-pause-action", action),
        );
      }
      controls.append(rows);
    }
    panel.append(controls);
  }

  panel.append(
    el(
      "div",
      "lf-pause-resume",
      coarse ? "tap to resume the descent" : "click or any key to resume",
    ),
  );
  overlay.append(panel);
}
