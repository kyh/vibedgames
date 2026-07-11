// Bespoke pause overlay — same design language as the start screen in
// index.html: translucent sky wash over the live world, drifting soft clouds,
// cream display type with the purple countdown shadow, the orange pulsing
// call-to-action, and navy monospace copy with a cream halo. Controls render
// grouped from the shared CONTROLS manifest (filtered per device / connected
// pad fresh on every show()), keycaps styled like the in-game HUD pills.
//
// Built on the shared @repo/embed pause shell, which owns resume behavior
// (pointerup / non-Escape keyup / fresh pad press), the full-screen root, and
// the fade — this file owns the sky-wash look.

import { controlGroups, createPauseShell } from "@repo/embed";
import type { ControlMethod, ControlsManifest } from "@repo/embed";

const METHOD_LABELS: Record<ControlMethod, string> = {
  keys: "keyboard",
  mouse: "mouse",
  touch: "touch",
  camera: "camera",
  controller: "controller",
};

const STYLE_ID = "fdp-style";
// Positioning/z-index/fade live on the shell's root — visuals only here.
const CSS = `
.fdp-root{display:flex;align-items:center;
  justify-content:center;text-align:center;overflow:hidden;
  padding:24px calc(24px + env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom))
    calc(24px + env(safe-area-inset-left));
  background:linear-gradient(180deg,rgba(150,214,240,0.44) 0%,rgba(104,186,226,0.52) 55%,
    rgba(78,158,206,0.62) 100%);
  backdrop-filter:blur(3px) saturate(1.1);-webkit-backdrop-filter:blur(3px) saturate(1.1);
  font-family:ui-monospace,'SF Mono',Menlo,monospace}
.fdp-clouds{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.fdp-cloud{position:absolute;background:#fff;border-radius:60px;filter:blur(5px);
  will-change:transform}
.fdp-cloud::before,.fdp-cloud::after{content:"";position:absolute;background:inherit;
  border-radius:50%}
.fdp-cloud::before{width:62%;height:150%;top:-60%;left:14%}
.fdp-cloud::after{width:44%;height:120%;top:-42%;right:16%}
.fdp-cloud.c1{top:12%;width:190px;height:52px;opacity:0.5;
  animation:fdp-drift 30s linear infinite}
.fdp-cloud.c2{top:48%;width:130px;height:38px;opacity:0.32;
  animation:fdp-drift 44s linear infinite 7s}
.fdp-cloud.c3{top:74%;width:240px;height:66px;opacity:0.22;
  animation:fdp-drift 54s linear infinite 15s}
@keyframes fdp-drift{from{transform:translateX(-260px)}
  to{transform:translateX(calc(100vw + 260px))}}
.fdp-card{position:relative;display:flex;flex-direction:column;align-items:center;
  gap:16px;max-width:min(92vw,640px)}
.fdp-title{font:900 clamp(44px,10vw,80px)/1 system-ui,sans-serif;color:#fff6d6;
  letter-spacing:0.08em;text-indent:0.08em;
  text-shadow:0 5px 0 rgba(91,74,138,0.55),0 9px 20px rgba(40,30,80,0.35),
    0 0 30px rgba(255,255,255,0.4)}
.fdp-hint{font:800 13px/1 ui-monospace,'SF Mono',Menlo,monospace;color:#d9642a;
  text-shadow:0 1px 0 rgba(255,251,234,0.85),0 0 14px rgba(255,251,234,0.7);
  letter-spacing:1.5px;text-transform:uppercase;
  animation:fdp-pulse 1.5s ease-in-out infinite}
@keyframes fdp-pulse{0%,100%{opacity:1;transform:scale(1)}
  50%{opacity:0.5;transform:scale(0.96)}}
.fdp-controls{display:flex;flex-wrap:wrap;justify-content:center;align-items:flex-start;
  gap:14px 36px;margin-top:6px}
.fdp-method{font:800 10px/1 ui-monospace,'SF Mono',Menlo,monospace;color:#1a2a52;
  opacity:0.72;letter-spacing:0.3em;text-indent:0.3em;text-transform:uppercase;
  margin-bottom:7px;text-shadow:0 1px 0 rgba(255,251,234,0.75)}
.fdp-rows{display:grid;grid-template-columns:auto auto;gap:7px 12px;align-items:center;
  justify-content:center}
.fdp-key{justify-self:end;padding:4px 10px;border-radius:10px;white-space:nowrap;
  background:rgba(10,12,28,0.62);border:1px solid rgba(255,255,255,0.22);color:#eef2ff;
  font:700 12px/1.3 ui-monospace,'SF Mono',Menlo,monospace;letter-spacing:1px;
  box-shadow:0 4px 14px rgba(0,0,0,0.25)}
.fdp-act{justify-self:start;text-align:left;color:#1a2a52;
  font:700 13px/1.4 ui-monospace,'SF Mono',Menlo,monospace;
  text-shadow:0 1px 0 rgba(255,251,234,0.75),0 0 12px rgba(255,251,234,0.55)}
@media (prefers-reduced-motion:reduce){
  .fdp-clouds{display:none}
  .fdp-hint{animation:none}
}`;

/** Inject the shared control-card styles (pause overlay AND start screen). */
export function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

/**
 * The grouped keycap card both instruction surfaces render — the start screen
 * and the pause overlay teach controls with the SAME UI. Null when nothing is
 * visible for the current device/pad context.
 */
export function buildControls(controls: ControlsManifest, coarse: boolean): HTMLElement | null {
  const groups = controlGroups(controls, { coarse });
  if (groups.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = "fdp-controls";
  for (const group of groups) {
    const section = document.createElement("div");
    if (groups.length > 1) {
      const label = document.createElement("div");
      label.className = "fdp-method";
      label.textContent = METHOD_LABELS[group.method];
      section.append(label);
    }
    const rows = document.createElement("div");
    rows.className = "fdp-rows";
    for (const entry of group.entries) {
      const key = document.createElement("span");
      key.className = "fdp-key";
      key.textContent = entry.input;
      const act = document.createElement("span");
      act.className = "fdp-act";
      act.textContent = entry.action;
      rows.append(key, act);
    }
    section.append(rows);
    wrap.append(section);
  }
  return wrap;
}

export type FlappyPauseOverlay = {
  /** Mount the overlay. Idempotent while shown. */
  show: () => void;
  /** Unmount (fade out). Idempotent while hidden. */
  hide: () => void;
};

export function createFlappyPauseOverlay(controls: ControlsManifest): FlappyPauseOverlay {
  return createPauseShell({
    className: "fdp-root",
    render: (overlay) => renderCard(overlay, controls),
  });
}

function renderCard(overlay: HTMLElement, controls: ControlsManifest): void {
  ensureStyle();
  // Fresh every show(): hint copy and control rows match the device / pad
  // connected the moment we pause.
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  const clouds = document.createElement("div");
  clouds.className = "fdp-clouds";
  clouds.setAttribute("aria-hidden", "true");
  for (const variant of ["c1", "c2", "c3"]) {
    const cloud = document.createElement("span");
    cloud.className = `fdp-cloud ${variant}`;
    clouds.append(cloud);
  }

  const card = document.createElement("div");
  card.className = "fdp-card";

  const title = document.createElement("div");
  title.className = "fdp-title";
  title.textContent = "PAUSED";

  const hint = document.createElement("div");
  hint.className = "fdp-hint";
  hint.textContent = coarse ? "tap anywhere to resume" : "click or press any key to resume";

  card.append(title, hint);
  const controlsEl = buildControls(controls, coarse);
  if (controlsEl) card.append(controlsEl);

  overlay.append(clouds, card);
}
