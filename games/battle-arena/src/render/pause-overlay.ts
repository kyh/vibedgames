// Battle Arena's bespoke pause screen — a stone war-tablet in the dungeon's
// own look (dark stone, gold/ember, the menu's italic display face, the
// champion-select keycap chips) on the shared @repo/embed pause shell, which
// owns resume behavior exactly like the stock overlay this replaced:
// pointerup or any keyup EXCEPT Escape resumes (Escape is the embed core's
// keydown toggle — resuming on its keyup too would double-fire one press),
// and a fresh gamepad press resumes while the match loop may be frozen.
import { controlGroups, createPauseShell } from "@repo/embed";
import type { ControlMethod } from "@repo/embed";
import { CONTROLS } from "../controls";

export type PauseOverlay = {
  /** Mount the overlay. Idempotent while shown. */
  show: () => void;
  /** Unmount (fade out). Idempotent while hidden. */
  hide: () => void;
};

export type PauseOverlayOpts = {
  /**
   * Whether the world keeps running behind the overlay (a live online match —
   * main.ts never freezes those). Read fresh on every show() so one overlay
   * serves both offline (frozen) and online (live) matches.
   */
  isLive?: () => boolean;
};

const METHOD_LABEL: Record<ControlMethod, string> = {
  keys: "KEYBOARD",
  mouse: "MOUSE",
  touch: "TOUCH",
  camera: "CAMERA",
  controller: "CONTROLLER",
};

// Positioning/z-index/fade live on the shell's root — visuals only here.
const CSS = `
.ba-pause{display:flex;align-items:center;justify-content:center;
  padding:20px;
  background:radial-gradient(ellipse at 50% 42%,rgba(12,14,22,.58),rgba(5,6,10,.85));
  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  color:#e8e2d4;font-family:ui-monospace,'SF Mono',Menlo,monospace;text-align:center}
.ba-p-panel{position:relative;width:min(92vw,600px);max-height:min(86vh,640px);overflow-y:auto;
  padding:26px 28px 20px;border-radius:6px;
  background:radial-gradient(ellipse 70% 38% at 50% 0%,rgba(255,160,40,.09),transparent),
    linear-gradient(172deg,rgba(31,33,46,.97),rgba(16,17,26,.97));
  border:1px solid rgba(255,210,74,.38);
  box-shadow:0 0 0 1px rgba(0,0,0,.85),0 0 0 4px rgba(21,23,33,.92),0 0 0 5px rgba(255,210,74,.14),
    0 26px 70px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.07)}
.ba-p-panel::before{content:"";position:absolute;inset:7px;border:1px solid rgba(255,255,255,.06);
  border-radius:3px;pointer-events:none}
.ba-p-title{font:900 italic clamp(36px,7vw,54px)/1 system-ui,sans-serif;letter-spacing:-2px;
  color:#ffd24a;text-shadow:0 2px 0 rgba(0,0,0,.6),0 0 44px rgba(255,160,40,.35)}
.ba-p-rule{display:flex;align-items:center;gap:10px;margin:13px auto 9px;max-width:340px;
  color:#ffd24a;font-size:9px;line-height:1}
.ba-p-rule::before{content:"";flex:1;height:1px;
  background:linear-gradient(90deg,transparent,rgba(255,210,74,.55))}
.ba-p-rule::after{content:"";flex:1;height:1px;
  background:linear-gradient(90deg,rgba(255,210,74,.55),transparent)}
.ba-p-sub{font:600 11px ui-monospace,monospace;letter-spacing:.2em;text-transform:uppercase;
  color:#d8a052}
.ba-p-groups{display:flex;flex-wrap:wrap;gap:16px 30px;justify-content:center;align-items:center;
  margin:20px 4px 4px;text-align:left}
.ba-p-g{min-width:206px;flex:0 1 auto}
.ba-p-gt{font:800 10px ui-monospace,monospace;letter-spacing:.26em;text-align:center;
  color:rgba(255,210,74,.62);border-bottom:1px solid rgba(255,210,74,.18);
  padding-bottom:5px;margin-bottom:9px}
.ba-p-rows{display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center}
.ba-p-k{justify-self:end;font:800 10px ui-monospace,monospace;color:#ffd24a;
  background:rgba(10,14,24,.92);border:1px solid rgba(255,255,255,.3);border-radius:4px;
  padding:2px 6px;white-space:nowrap}
.ba-p-a{font:600 11px ui-monospace,monospace;opacity:.78}
.ba-p-hint{margin-top:16px;font:700 10px ui-monospace,monospace;letter-spacing:.16em;
  text-transform:uppercase;opacity:.5}
@media (max-width:520px){
  .ba-p-panel{padding:20px 16px 16px}
  .ba-p-g{min-width:0;width:100%}
  .ba-p-groups{gap:12px}
}`;

/**
 * Build Battle Arena's pause overlay. Any pointerup or non-Escape keyup while
 * it is up resumes; content (control groups, live/frozen sub-line, coarse/fine
 * resume hint) re-renders fresh on every show().
 */

export function createPauseOverlay(opts: PauseOverlayOpts = {}): PauseOverlay {
  const shell = createPauseShell({
    className: "ba-pause",
    css: CSS,
    styleId: "ba-pause-style",
    fadeMs: 220,
    render: (root) => renderPanel(root, opts),
  });
  return {
    show: () => {
      // A wrapper-initiated pause can land while the FPS pointer lock is held —
      // release it so the cursor is visible over the overlay (the next canvas
      // click after resume relocks, the familiar FPS pattern).
      if (document.pointerLockElement) document.exitPointerLock();
      shell.show();
    },
    hide: shell.hide,
  };
}

function renderPanel(overlay: HTMLElement, opts: PauseOverlayOpts): void {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const live = opts.isLive?.() ?? false;

  const panel = document.createElement("div");
  panel.className = "ba-p-panel";

  const title = document.createElement("div");
  title.className = "ba-p-title";
  title.textContent = "PAUSED";

  const rule = document.createElement("div");
  rule.className = "ba-p-rule";
  rule.textContent = "◆";

  const sub = document.createElement("div");
  sub.className = "ba-p-sub";
  sub.textContent = live ? "the arena fights on without you" : "the arena holds its breath";

  panel.append(title, rule, sub);

  const groups = controlGroups(CONTROLS, { coarse });
  if (groups.length > 0) {
    const wrap = document.createElement("div");
    wrap.className = "ba-p-groups";
    for (const group of groups) {
      const g = document.createElement("div");
      g.className = "ba-p-g";
      const gt = document.createElement("div");
      gt.className = "ba-p-gt";
      gt.textContent = METHOD_LABEL[group.method];
      const rows = document.createElement("div");
      rows.className = "ba-p-rows";
      for (const entry of group.entries) {
        const key = document.createElement("span");
        key.className = "ba-p-k";
        key.textContent = entry.input;
        const action = document.createElement("span");
        action.className = "ba-p-a";
        action.textContent = entry.action;
        rows.append(key, action);
      }
      g.append(gt, rows);
      wrap.append(g);
    }
    panel.append(wrap);
  }

  const hint = document.createElement("div");
  hint.className = "ba-p-hint";
  hint.textContent = coarse ? "tap to re-enter the fray" : "any key · click — re-enter the fray";
  panel.append(hint);

  overlay.append(panel);
}
