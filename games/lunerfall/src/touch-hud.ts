// Pause + mute for a phone. Both are keyboard-only in the run (Escape via
// @repo/embed, M in game-scene), so without this a touch player can neither
// pause a descent nor ever hear the synth. Reskinned in the hub's pixel
// language — steel-blue border, night fill, teal press — over @repo/embed's
// shared cluster, which owns the safe-area anchoring and the 44px hit targets.

import { createTouchControls } from "@repo/embed";
import type { TouchControls } from "@repo/embed";

import { sfx } from "./audio/sfx";

const CSS = `
.lf-touch {
  --vg-touch-gap: 10px;
  --vg-touch-bg: rgba(11, 14, 20, 0.78);
  --vg-touch-bg-active: rgba(52, 229, 200, 0.3);
  --vg-touch-border: 2px solid #33445e;
  --vg-touch-fg: #d8dee6;
  --vg-touch-radius: 3px;
  --vg-touch-glyph-size: 19px;
}
/* Portrait is the rotate gate's screen — nothing else floats over it. */
@media (orientation: portrait) and (pointer: coarse) {
  .lf-touch { display: none; }
}
`;

const MUTE = {
  get: () => sfx.muted,
  set: (next: boolean): void => {
    if (next !== sfx.muted) sfx.toggleMute();
    // Unmuting is itself the user gesture that lets WebAudio start, and the
    // synth builds no context at all while muted — so the bed only ever begins
    // here (or on a canvas gesture), never on load.
    if (!next) sfx.unlock();
  },
};

let controls: TouchControls | null = null;
let hasPause = false;

/**
 * Mount (or re-mount) the cluster. `pause` only during a run: the hub has
 * nothing to freeze, and `pauseGame()` is a no-op before a run announces
 * itself, so a pause button there would be a dead control.
 */
export function mountTouchHud(pause: boolean): void {
  if (controls && pause === hasPause) return;
  controls?.destroy();
  hasPause = pause;
  controls = createTouchControls({
    pause,
    mute: MUTE,
    className: "lf-touch",
    css: CSS,
    styleId: "lf-touch-css",
  });
}

/** Redraw the mute glyph after something else toggled sound (the M key). */
export function syncTouchHud(): void {
  controls?.sync();
}
