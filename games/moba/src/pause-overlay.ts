// Bespoke pause overlay — an ornate war-table plaque in the game's own art
// direction (carved wood, gold-on-dark fantasy type, HUD-style keycap chips)
// on the shared @repo/embed pause shell, which owns resume behavior exactly
// like the stock overlay this replaced: pointerup / keyup (except Escape) /
// fresh pad press all resume; show()/hide() are idempotent; Escape itself is
// handled on keydown by the @repo/embed core toggle.

import { controlGroups, createPauseShell } from "@repo/embed";
import type { ControlMethod } from "@repo/embed";

import { CONTROLS } from "./controls";

const GROUP_LABEL: Record<ControlMethod, string> = {
  keys: "Keyboard",
  mouse: "Mouse",
  touch: "Touch",
  camera: "Camera",
  controller: "Gamepad",
};

const STYLE_ID = "moba-pause-style";
// Positioning/z-index/root fade live on the shell's root — visuals only here.
// The panel keeps its own slide-up entrance, driven by the .mp-in class.
const CSS = `
.mp-root{display:flex;align-items:center;justify-content:center;
  padding:18px;text-align:center;
  font-family:"Lilita One","Trebuchet MS",sans-serif;color:#e8d9b8;
  background:radial-gradient(circle at 50% 40%,rgba(22,30,46,0.78),rgba(8,11,18,0.88) 75%);
  backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)}
.mp-panel{position:relative;width:min(92vw,540px);max-height:min(86vh,660px);overflow-y:auto;
  padding:24px 26px 20px;border-radius:14px;border:2px solid #8a7350;
  background:linear-gradient(180deg,#2c2115,#1b130b);
  box-shadow:inset 0 0 0 1px rgba(255,225,150,0.18),inset 0 0 64px rgba(0,0,0,0.45),0 20px 50px rgba(0,0,0,0.6);
  transform:translateY(8px);transition:transform 0.24s ease}
.mp-root.mp-in .mp-panel{transform:none}
.mp-corner{position:absolute;width:9px;height:9px;transform:rotate(45deg);
  background:linear-gradient(135deg,#ffe6a3,#b07f2e);box-shadow:0 0 6px rgba(255,214,122,0.35)}
.mp-eyebrow{font-size:11px;letter-spacing:0.32em;text-indent:0.32em;color:#b89868;text-transform:uppercase}
.mp-title{margin-top:4px;font-size:38px;line-height:1.1;letter-spacing:0.16em;text-indent:0.16em;
  background:linear-gradient(180deg,#ffe6a3,#d59b3a);-webkit-background-clip:text;background-clip:text;
  color:transparent;filter:drop-shadow(0 2px 0 rgba(20,12,4,0.6))}
.mp-flavor{margin-top:6px;font-size:13px;line-height:1.5;color:#cdbb97}
.mp-rule{height:2px;margin:16px 4px 2px;border-radius:2px;
  background:linear-gradient(90deg,transparent,#8a7350 18%,#d5ae5f 50%,#8a7350 82%,transparent)}
.mp-gh{display:flex;align-items:center;gap:10px;margin:14px 0 8px}
.mp-gh::before,.mp-gh::after{content:"";flex:1;height:1px;
  background:linear-gradient(90deg,rgba(111,90,60,0),#6f5a3c)}
.mp-gh::after{background:linear-gradient(90deg,#6f5a3c,rgba(111,90,60,0))}
.mp-gh span{font-size:11px;letter-spacing:0.26em;text-indent:0.26em;color:#d5ae5f;text-transform:uppercase}
.mp-grid{display:grid;grid-template-columns:minmax(0,auto) minmax(0,auto);gap:7px 12px;
  justify-content:center;align-items:center;text-align:left}
.mp-keys{justify-self:end;display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.mp-chip{display:inline-block;padding:3px 8px;min-width:27px;border-radius:7px;font-size:13px;
  color:#ffe8b0;text-shadow:0 1px 0 #1c1410;white-space:nowrap;
  background:linear-gradient(180deg,#3d2e1d,#241a10);border:1px solid #8a7350;
  box-shadow:inset 0 1px 0 rgba(255,232,176,0.22),0 1px 0 rgba(0,0,0,0.4)}
.mp-action{font-size:13px;color:#d8cbb2}
.mp-hint{margin-top:18px;font-size:13px;letter-spacing:0.14em;color:#ffd27a;
  text-shadow:0 1px 0 rgba(20,12,4,0.6);animation:mp-pulse 2.2s ease-in-out infinite}
@keyframes mp-pulse{0%,100%{opacity:1}50%{opacity:0.55}}
@media (prefers-reduced-motion: reduce){
  .mp-panel{transition:none}
  .mp-hint{animation:none}
}
`;

/** "Q W E R" / "X Y B RB" render as individual HUD-style keycaps; anything
 *  else ("←→↑↓", "L-STICK / D-PAD", "2ND FINGER") stays one chip. Shared with
 *  the menu's controls plaque so both surfaces split keycaps identically. */
export function chipTexts(input: string): readonly string[] {
  return /^[A-Z0-9]{1,2}( [A-Z0-9]{1,2})+$/.test(input) ? input.split(" ") : [input];
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Kept across show/hide so onHide can back out the panel's .mp-in slide.
let root: HTMLElement | null = null;

function renderPanel(overlay: HTMLElement): void {
  root = overlay;
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  const panel = el("div", "mp-panel");
  const cornerInsets: readonly string[] = [
    "7px 7px auto auto",
    "7px auto auto 7px",
    "auto 7px 7px auto",
    "auto auto 7px 7px",
  ];
  for (const inset of cornerInsets) {
    const corner = el("span", "mp-corner");
    corner.style.inset = inset;
    panel.append(corner);
  }

  panel.append(
    el("div", "mp-eyebrow", "Ancients of Eldermoor"),
    el("div", "mp-title", "PAUSED"),
    el(
      "div",
      "mp-flavor",
      "The war horn rests — but the battle for Eldermoor rages on without you.",
    ),
    el("div", "mp-rule"),
  );

  // Fresh each show(): touch vs keys/mouse, controller only while connected.
  for (const group of controlGroups(CONTROLS, { coarse })) {
    const header = el("div", "mp-gh");
    header.append(el("span", "", GROUP_LABEL[group.method]));
    const grid = el("div", "mp-grid");
    for (const entry of group.entries) {
      const keys = el("span", "mp-keys");
      for (const text of chipTexts(entry.input)) keys.append(el("span", "mp-chip", text));
      grid.append(keys, el("span", "mp-action", entry.action));
    }
    panel.append(header, grid);
  }

  panel.append(
    el(
      "div",
      "mp-hint",
      coarse ? "TAP TO REJOIN THE FIGHT" : "CLICK OR PRESS ANY KEY TO REJOIN THE FIGHT",
    ),
  );
  overlay.append(panel);

  // Panel slide-up rides the same first frame as the shell's root fade.
  requestAnimationFrame(() => overlay.classList.add("mp-in"));
}

const shell = createPauseShell({
  className: "mp-root",
  css: CSS,
  styleId: STYLE_ID,
  render: renderPanel,
  onHide: () => {
    // Slide the panel back down through the shell's fade-out.
    root?.classList.remove("mp-in");
    root = null;
  },
});

/** Mount the overlay. Idempotent while shown. */
export const show = shell.show;

/** Unmount (fade out). Idempotent while hidden. */
export const hide = shell.hide;
